using System.Windows;
using System.Windows.Threading;

namespace KrakenHub.Client;

public partial class App : Application
{
    private Mutex? _single;

    protected override void OnStartup(StartupEventArgs e)
    {
        // One client per Windows session.
        _single = new Mutex(true, @"Local\KrakenHubClient", out var first);
        if (!first)
        {
            Shutdown();
            return;
        }

        base.OnStartup(e);
        DispatcherUnhandledException += OnUnhandled;
        AppDomain.CurrentDomain.UnhandledException += (_, a) => Log.Write($"Fatal: {a.ExceptionObject}");

        var config = Config.Load();
        var hostArg = ArgValue(e.Args, "--host");
        if (!string.IsNullOrWhiteSpace(hostArg))
        {
            config.HostUrl = Config.NormalizeHost(hostArg);
            config.Save();
        }

        Autostart.Ensure();
        Log.Write($"Starting client {Config.Version} on {Environment.MachineName}");
        new MainWindow(config).Show();
    }

    private static void OnUnhandled(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        // Never crash to the desktop: an unlocked desktop is worse than a glitch.
        Log.Write($"Unhandled: {e.Exception}");
        e.Handled = true;
    }

    private static string? ArgValue(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
        return null;
    }
}
