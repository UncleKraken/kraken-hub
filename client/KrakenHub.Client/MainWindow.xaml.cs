using System.ComponentModel;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;

namespace KrakenHub.Client;

/// <summary>
/// The only window. Shows the counter's /client page in WebView2 and follows what it asks for:
/// "lock" covers every monitor and blocks escape keys; "widget" and "mini" shrink to a corner
/// during a session. If the counter can't be reached the PC stays locked (fails closed).
/// </summary>
public partial class MainWindow : Window
{
    private readonly Config _config;
    private readonly HealthReporter? _reporter;
    private readonly KeyboardBlocker _keys = new();
    private readonly DispatcherTimer _keepOnTop;
    private readonly DispatcherTimer _retry;
    private string _mode = "lock";
    private bool _webReady;
    private bool _allowClose;

    public MainWindow(Config config, HealthReporter? reporter = null)
    {
        InitializeComponent();
        _config = config;
        _reporter = reporter;
        Web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(0x10, 0x1B, 0x24); // no white flash while loading
        _keys.AdminHotkey += () => Dispatcher.BeginInvoke(OnAdminHotkey);

        // Something else (a game installer, a popup) may grab focus; take it back while locked.
        _keepOnTop = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _keepOnTop.Tick += (_, _) =>
        {
            if (_mode != "lock") return;
            Topmost = false;
            Topmost = true;
            Activate();
        };
        _keepOnTop.Start();

        _retry = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _retry.Tick += (_, _) =>
        {
            _retry.Stop();
            Navigate();
        };

        ApplyMode("lock");
        Loaded += async (_, _) => await StartAsync();
        Closing += OnClosing;
        SystemEventsDisplayChanged();
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (!_allowClose) e.Cancel = true;
    }

    private async Task StartAsync()
    {
        if (string.IsNullOrEmpty(_config.HostUrl))
        {
            Status.Text = "Looking for the counter…";
            var found = await Discovery.FindHostAsync(TimeSpan.FromSeconds(4));
            if (found is not null)
            {
                _config.HostUrl = found;
                _config.Save();
                Log.Write($"Found host at {found}");
            }
        }

        if (string.IsNullOrEmpty(_config.HostUrl))
        {
            Status.Text = "Couldn't find the counter automatically. Staff can enter its address.";
            Manual.Visibility = Visibility.Visible;
            return;
        }

        await EnsureWebAsync();
        Navigate();
    }

    private async Task EnsureWebAsync()
    {
        if (_webReady) return;
        var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KrakenHub", "WebView2");
        var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
        await Web.EnsureCoreWebView2Async(env);
        var core = Web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsPinchZoomEnabled = false;
        core.WebMessageReceived += OnWebMessage;
        core.NavigationCompleted += OnNavigationCompleted;
        core.NewWindowRequested += (_, e) => e.Handled = true; // no popups or new windows
        core.ProcessFailed += (_, e) =>
        {
            Log.Write($"WebView process failed: {e.ProcessFailedKind}");
            _reporter?.QueueEvent("client_crash", new { kind = e.ProcessFailedKind.ToString() });
            ShowOverlay("Reconnecting…");
            _retry.Start();
        };
        _webReady = true;
    }

    private void Navigate()
    {
        if (!_webReady || string.IsNullOrEmpty(_config.HostUrl)) return;
        var q = new Dictionary<string, string>
        {
            ["machineId"] = Config.MachineId(),
            ["hostname"] = Environment.MachineName,
            ["mac"] = Config.MacAddress(),
            ["secret"] = _config.Secret,
            ["version"] = Config.Version,
        };
        // The identity travels in the URL fragment, which the browser never sends to the server.
        var fragment = string.Join("&", q.Select(kv => $"{kv.Key}={Uri.EscapeDataString(kv.Value)}"));
        Web.CoreWebView2.Navigate($"{_config.HostUrl!.TrimEnd('/')}/client#{fragment}");
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
        {
            Overlay.Visibility = Visibility.Collapsed;
            Web.Visibility = Visibility.Visible;
            return;
        }
        Log.Write($"Could not load {_config.HostUrl}: {e.WebErrorStatus}");
        ShowOverlay($"Can't reach the counter at {_config.HostUrl}. Trying again…");
        _retry.Start();
    }

    private void ShowOverlay(string text)
    {
        ApplyMode("lock");
        Status.Text = text;
        Overlay.Visibility = Visibility.Visible;
        Web.Visibility = Visibility.Collapsed;
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            var type = root.GetProperty("type").GetString();
            if (type == "mode") ApplyMode(root.GetProperty("mode").GetString() ?? "lock");
            else if (type == "system") SystemActions.Run(root.GetProperty("action").GetString() ?? "");
        }
        catch (Exception ex)
        {
            Log.Write($"Bad message from page: {ex.Message}");
        }
    }

    private void ApplyMode(string mode)
    {
        if (mode is not ("lock" or "widget" or "mini")) mode = "lock";
        _mode = mode;
        _keys.Enabled = mode == "lock";
        WindowState = WindowState.Normal;
        Topmost = true;
        if (mode == "lock")
        {
            // Cover every monitor.
            Left = SystemParameters.VirtualScreenLeft;
            Top = SystemParameters.VirtualScreenTop;
            Width = SystemParameters.VirtualScreenWidth;
            Height = SystemParameters.VirtualScreenHeight;
            Activate();
        }
        else
        {
            var area = SystemParameters.WorkArea;
            var width = 360.0;
            var height = mode == "mini" ? 64.0 : Math.Min(620.0, area.Height - 32);
            Width = width;
            Height = height;
            Left = area.Right - width - 16;
            Top = area.Bottom - height - 16;
        }
    }

    private void SystemEventsDisplayChanged()
    {
        // Re-apply the layout when monitors or resolution change.
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged += (_, _) => Dispatcher.BeginInvoke(() => ApplyMode(_mode));
    }

    private async void Connect_Click(object sender, RoutedEventArgs e)
    {
        if (CodeBox.Password != _config.AdminCode)
        {
            ManualError.Text = "Wrong admin code.";
            return;
        }
        try
        {
            _config.HostUrl = Config.NormalizeHost(HostBox.Text);
            _config.Save();
            Manual.Visibility = Visibility.Collapsed;
            Status.Text = "Connecting…";
            await EnsureWebAsync();
            Navigate();
        }
        catch (Exception ex)
        {
            ManualError.Text = $"That address doesn't look right: {ex.Message}";
        }
    }

    /// <summary>Ctrl+Alt+Shift+F12 → admin code → staff options (change counter address, close the client).</summary>
    private void OnAdminHotkey()
    {
        var dialog = new AdminDialog(_config.AdminCode) { Owner = this };
        _keys.Enabled = false;
        dialog.ShowDialog();
        _keys.Enabled = _mode == "lock";
        switch (dialog.Choice)
        {
            case AdminChoice.Exit:
                Log.Write("Closed by staff");
                _allowClose = true;
                _keys.Dispose();
                Application.Current.Shutdown();
                break;
            case AdminChoice.ChangeHost:
                _config.HostUrl = null;
                _config.Save();
                ShowOverlay("Enter the counter's address.");
                Manual.Visibility = Visibility.Visible;
                break;
        }
    }
}

internal enum AdminChoice
{
    None,
    ChangeHost,
    Exit,
}

/// <summary>A small code-protected menu for staff, built in code to keep the project tiny.</summary>
internal sealed class AdminDialog : Window
{
    public AdminChoice Choice { get; private set; } = AdminChoice.None;

    public AdminDialog(string expectedCode)
    {
        Title = "Kraken Hub — staff";
        Width = 380;
        SizeToContent = SizeToContent.Height;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        Topmost = true;

        var code = new PasswordBox { Margin = new Thickness(16, 6, 16, 0), FontSize = 18 };
        var error = new TextBlock { Margin = new Thickness(16, 6, 16, 0), Foreground = System.Windows.Media.Brushes.IndianRed };
        Button Make(string text, AdminChoice choice)
        {
            var b = new Button { Content = text, Margin = new Thickness(16, 10, 16, 0), Padding = new Thickness(10, 6, 10, 6) };
            b.Click += (_, _) =>
            {
                if (code.Password != expectedCode)
                {
                    error.Text = "Wrong admin code.";
                    return;
                }
                Choice = choice;
                Close();
            };
            return b;
        }

        var cancel = new Button { Content = "Cancel", Margin = new Thickness(16, 10, 16, 16), Padding = new Thickness(10, 6, 10, 6), IsCancel = true };
        cancel.Click += (_, _) => Close();

        var panel = new StackPanel();
        panel.Children.Add(new TextBlock { Text = "Admin code", Margin = new Thickness(16, 16, 16, 0) });
        panel.Children.Add(code);
        panel.Children.Add(error);
        panel.Children.Add(Make("Change counter address", AdminChoice.ChangeHost));
        panel.Children.Add(Make("Close Kraken Hub client", AdminChoice.Exit));
        panel.Children.Add(cancel);
        Content = panel;
        Loaded += (_, _) => code.Focus();
    }
}
