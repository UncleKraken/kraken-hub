using System.Collections.Concurrent;
using System.IO;
using System.Management;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.InteropServices;

namespace KrakenHub.Client;

/// <summary>
/// The health snapshot a customer PC sends the counter: disk, memory, uptime and, where the
/// hardware exposes them, CPU/GPU temperatures. Every field is optional — a PC reports what it
/// can read. Units: megabytes for disk/memory, whole percent for CPU, degrees Celsius for temps.
/// </summary>
public sealed class Metrics
{
    public long? uptimeMs { get; set; }
    public int? cpuPct { get; set; }
    public long? memUsedMb { get; set; }
    public long? memTotalMb { get; set; }
    public long? diskFreeMb { get; set; }
    public long? diskTotalMb { get; set; }
    public long? diskGameFreeMb { get; set; }
    public long? diskGameTotalMb { get; set; }
    public int? cpuTempC { get; set; }
    public int? gpuTempC { get; set; }
}

internal sealed class TelemetryEvent
{
    public string kind { get; set; } = "";
    public object detail { get; set; } = new { };
}

internal sealed class TelemetryBody
{
    public string machineId { get; set; } = "";
    public string secret { get; set; } = "";
    public string version { get; set; } = "";
    public Metrics metrics { get; set; } = new();
    public List<TelemetryEvent> events { get; set; } = new();
}

/// <summary>Reads what this PC can tell us about its own health without extra privileges.</summary>
internal static class Telemetry
{
    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    private const long MB = 1024 * 1024;

    public static Metrics Collect(CpuSampler cpu)
    {
        var m = new Metrics { uptimeMs = Environment.TickCount64, cpuPct = cpu.Sample() };
        ReadMemory(m);
        ReadDisks(m);
        ReadTemperatures(m);
        return m;
    }

    private static void ReadMemory(Metrics m)
    {
        try
        {
            var s = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
            if (GlobalMemoryStatusEx(ref s) && s.ullTotalPhys > 0)
            {
                m.memTotalMb = (long)(s.ullTotalPhys / MB);
                m.memUsedMb = (long)((s.ullTotalPhys - s.ullAvailPhys) / MB);
            }
        }
        catch (Exception ex)
        {
            Log.Write($"Memory read failed: {ex.Message}");
        }
    }

    private static void ReadDisks(Metrics m)
    {
        try
        {
            var systemRoot = Path.GetPathRoot(Environment.SystemDirectory);
            var fixedDrives = DriveInfo.GetDrives()
                .Where(d => d.DriveType == DriveType.Fixed && d.IsReady)
                .ToList();

            var system = fixedDrives.FirstOrDefault(d => string.Equals(d.RootDirectory.FullName, systemRoot, StringComparison.OrdinalIgnoreCase));
            if (system is not null)
            {
                m.diskTotalMb = system.TotalSize / MB;
                m.diskFreeMb = system.TotalFreeSpace / MB;
            }

            // The biggest other fixed drive (usually where games live) is reported too, if present.
            var game = fixedDrives
                .Where(d => system is null || !string.Equals(d.RootDirectory.FullName, system.RootDirectory.FullName, StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(d => d.TotalSize)
                .FirstOrDefault();
            if (game is not null)
            {
                m.diskGameTotalMb = game.TotalSize / MB;
                m.diskGameFreeMb = game.TotalFreeSpace / MB;
            }
        }
        catch (Exception ex)
        {
            Log.Write($"Disk read failed: {ex.Message}");
        }
    }

    private static void ReadTemperatures(Metrics m)
    {
        // ACPI thermal zone — the one temperature a normal-privilege process can usually read.
        // Many desktops don't expose it; that's fine, temps are optional. Reported in tenths of K.
        try
        {
            using var searcher = new ManagementObjectSearcher(@"root\WMI", "SELECT CurrentTemperature FROM MSAcpi_ThermalZoneTemperature");
            foreach (var obj in searcher.Get())
            {
                var raw = obj["CurrentTemperature"];
                if (raw is null) continue;
                var celsius = (int)Math.Round(Convert.ToDouble(raw) / 10.0 - 273.15);
                if (celsius is > 0 and < 150)
                {
                    m.cpuTempC = m.cpuTempC is null ? celsius : Math.Max(m.cpuTempC.Value, celsius);
                }
            }
        }
        catch (Exception ex)
        {
            Log.Write($"Temperature unavailable: {ex.Message}");
        }
    }
}

/// <summary>System-wide CPU usage from the delta between two GetSystemTimes reads.</summary>
internal sealed class CpuSampler
{
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetSystemTimes(out long idle, out long kernel, out long user);

    private long _idle, _kernel, _user;
    private bool _primed;

    public int? Sample()
    {
        try
        {
            if (!GetSystemTimes(out var idle, out var kernel, out var user)) return null;
            if (!_primed)
            {
                (_idle, _kernel, _user, _primed) = (idle, kernel, user, true);
                return null; // the first read has nothing to compare against
            }
            var idleDelta = idle - _idle;
            var busyDelta = kernel - _kernel + (user - _user); // kernel time already includes idle
            (_idle, _kernel, _user) = (idle, kernel, user);
            if (busyDelta <= 0) return null;
            var usage = 100.0 * (1.0 - (double)idleDelta / busyDelta);
            return Math.Clamp((int)Math.Round(usage), 0, 100);
        }
        catch
        {
            return null;
        }
    }
}

/// <summary>
/// Reports this PC's health to the counter every half-minute. Runs quietly: a failed report is
/// logged and retried next cycle, never surfaced to the customer. Discrete events (an unclean
/// shutdown found at startup, a WebView crash) are queued and drained on the next report.
/// </summary>
internal sealed class HealthReporter : IDisposable
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);
    private readonly Config _config;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(10) };
    private readonly CpuSampler _cpu = new();
    private readonly ConcurrentQueue<TelemetryEvent> _pending = new();
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;

    public HealthReporter(Config config) => _config = config;

    /// <summary>Queue a one-off event (e.g. "client_crash") to send with the next report.</summary>
    public void QueueEvent(string kind, object? detail = null) => _pending.Enqueue(new TelemetryEvent { kind = kind, detail = detail ?? new { } });

    public void Start()
    {
        _loop ??= Task.Run(() => LoopAsync(_cts.Token));
    }

    private async Task LoopAsync(CancellationToken ct)
    {
        // Prime the CPU sampler and let the first report settle a moment after launch.
        _cpu.Sample();
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(Interval, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            await ReportOnceAsync(ct);
        }
    }

    private async Task ReportOnceAsync(CancellationToken ct)
    {
        var host = _config.HostUrl;
        if (string.IsNullOrEmpty(host)) return; // not connected to a counter yet
        var events = new List<TelemetryEvent>();
        while (_pending.TryDequeue(out var e)) events.Add(e);
        var body = new TelemetryBody
        {
            machineId = Config.MachineId(),
            secret = _config.Secret,
            version = Config.Version,
            metrics = Telemetry.Collect(_cpu),
            events = events,
        };
        try
        {
            using var res = await _http.PostAsJsonAsync($"{host.TrimEnd('/')}/api/agent/telemetry", body, ct);
            if (!res.IsSuccessStatusCode) Log.Write($"Telemetry rejected: {(int)res.StatusCode}");
        }
        catch (Exception ex)
        {
            // Put the events back so they aren't lost when the counter is briefly unreachable.
            foreach (var e in events) _pending.Enqueue(e);
            Log.Write($"Telemetry send failed: {ex.Message}");
        }
    }

    public void Dispose()
    {
        try
        {
            _cts.Cancel();
            _loop?.Wait(TimeSpan.FromSeconds(2));
        }
        catch
        {
            // Shutting down; nothing to do.
        }
        _cts.Dispose();
        _http.Dispose();
    }
}

/// <summary>
/// A marker file that lets the client tell a clean exit from a power loss or hard crash. It's
/// written at startup and removed on a clean shutdown; finding it still there next launch means
/// the last run ended uncleanly. Kept in ProgramData so it survives a per-user profile wipe.
/// </summary>
internal static class RunMarker
{
    private static string Path1 =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "KrakenHub", "running.flag");

    /// <summary>Returns true if the previous run didn't exit cleanly, then (re)arms the marker.</summary>
    public static bool CheckAndArm()
    {
        var unclean = false;
        try
        {
            unclean = File.Exists(Path1);
            Directory.CreateDirectory(Path.GetDirectoryName(Path1)!);
            File.WriteAllText(Path1, DateTime.UtcNow.ToString("o"));
        }
        catch (Exception ex)
        {
            Log.Write($"Run marker arm failed: {ex.Message}");
        }
        return unclean;
    }

    public static void Clear()
    {
        try
        {
            if (File.Exists(Path1)) File.Delete(Path1);
        }
        catch (Exception ex)
        {
            Log.Write($"Run marker clear failed: {ex.Message}");
        }
    }
}
