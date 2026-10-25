using System.Windows;
using System.Windows.Threading;

namespace KrakenHub.Client;

public partial class App : Application
{
    private Mutex? _single;
    private HealthReporter? _reporter;
    private bool _armed; // this instance owns the run marker and should clear it on exit

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

        // Health reporting: note whether the last run ended uncleanly (power loss / hard crash),
        // then report PC health to the counter in the background.
        var uncleanLastRun = RunMarker.CheckAndArm();
        _armed = true;
        _reporter = new HealthReporter(config);
        if (uncleanLastRun)
        {
            Log.Write("Previous run did not exit cleanly");
            _reporter.QueueEvent("unclean_shutdown");
        }
        _reporter.Start();

        new MainWindow(config, _reporter).Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        // A clean exit: clear the marker so next launch isn't flagged, and stop reporting.
        // Only the instance that armed the marker clears it (a rejected second instance must not).
        if (_armed) RunMarker.Clear();
        _reporter?.Dispose();
        base.OnExit(e);
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
