using System.IO;
using System.Net.NetworkInformation;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32;

namespace KrakenHub.Client;

/// <summary>
/// Settings for this PC, kept in %ProgramData%\KrakenHub\client.json (shared by every
/// Windows user on the PC, so the pairing survives profile wipes). Falls back to
/// %LocalAppData% if ProgramData isn't writable.
/// </summary>
public sealed class Config
{
    public string? HostUrl { get; set; }
    public string Secret { get; set; } = "";
    /// <summary>Code that lets staff close the client with Ctrl+Alt+Shift+F12.</summary>
    public string AdminCode { get; set; } = "1234";

    /// <summary>
    /// True once this PC has successfully reached a counter at least once. Until then the client
    /// runs in setup mode — minimizable, so whoever installs it can reach the desktop to configure
    /// the PC instead of being locked behind the connect screen. After the first connection it
    /// locks down normally (and fails closed) on every boot.
    /// </summary>
    public bool Configured { get; set; }

    public static string Version =>
        Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    private static string SharedPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "KrakenHub", "client.json");

    private static string UserPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KrakenHub", "client.json");

    public static Config Load()
    {
        foreach (var path in new[] { SharedPath, UserPath })
        {
            try
            {
                if (!File.Exists(path)) continue;
                var cfg = JsonSerializer.Deserialize<Config>(File.ReadAllText(path));
                if (cfg is null) continue;
                if (string.IsNullOrEmpty(cfg.Secret))
                {
                    cfg.Secret = NewSecret();
                    cfg.Save();
                }
                return cfg;
            }
            catch (Exception ex)
            {
                Log.Write($"Could not read {path}: {ex.Message}");
            }
        }

        var fresh = new Config { Secret = NewSecret() };
        fresh.Save();
        return fresh;
    }

    public void Save()
    {
        foreach (var path in new[] { SharedPath, UserPath })
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, JsonSerializer.Serialize(this, Json));
                return;
            }
            catch (Exception ex)
            {
                Log.Write($"Could not write {path}: {ex.Message}");
            }
        }
    }

    private static string NewSecret() => RandomNumberGenerator.GetHexString(64, lowercase: true);

    /// <summary>"192.168.1.10" → "http://192.168.1.10:7300".</summary>
    public static string NormalizeHost(string input)
    {
        var s = input.Trim().TrimEnd('/');
        if (!s.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !s.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            s = "http://" + s;
        var uri = new Uri(s);
        return uri.IsDefaultPort && !input.Contains(':') ? $"{uri.Scheme}://{uri.Host}:7300" : $"{uri.Scheme}://{uri.Authority}";
    }

    /// <summary>Windows' own id for this installation, stable across reboots and user profiles.</summary>
    public static string MachineId()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
            if (key?.GetValue("MachineGuid") is string guid && guid.Length >= 8) return guid;
        }
        catch (Exception ex)
        {
            Log.Write($"MachineGuid unavailable: {ex.Message}");
        }
        return ("PC-" + Environment.MachineName).PadRight(8, '0');
    }

    public static string MacAddress()
    {
        try
        {
            var nic = NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == OperationalStatus.Up)
                .Where(n => n.NetworkInterfaceType is NetworkInterfaceType.Ethernet or NetworkInterfaceType.Wireless80211 or NetworkInterfaceType.GigabitEthernet)
                .OrderByDescending(n => n.Speed)
                .FirstOrDefault();
            var bytes = nic?.GetPhysicalAddress().GetAddressBytes();
            return bytes is { Length: > 0 } ? string.Join(":", bytes.Select(b => b.ToString("X2"))) : "";
        }
        catch
        {
            return "";
        }
    }
}

internal static class Log
{
    private static readonly object Gate = new();

    public static void Write(string message)
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KrakenHub");
            Directory.CreateDirectory(dir);
            var file = Path.Combine(dir, "client.log");
            lock (Gate)
            {
                if (File.Exists(file) && new FileInfo(file).Length > 2_000_000) File.Delete(file);
                File.AppendAllText(file, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {message}{Environment.NewLine}");
            }
        }
        catch
        {
            // Logging must never take the client down.
        }
    }
}

internal static class Autostart
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    /// <summary>Starts the client at every Windows sign-in: for all users if allowed, else this user.</summary>
    public static void Ensure()
    {
        var exe = Environment.ProcessPath;
        if (string.IsNullOrEmpty(exe)) return;
        var value = $"\"{exe}\"";
        foreach (var hive in new[] { Registry.LocalMachine, Registry.CurrentUser })
        {
            try
            {
                using var key = hive.CreateSubKey(RunKey, writable: true);
                if (key.GetValue("KrakenHubClient") as string != value) key.SetValue("KrakenHubClient", value);
                return;
            }
            catch
            {
                // Not an admin: try the current user's key.
            }
        }
    }
}
