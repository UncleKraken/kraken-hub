using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace KrakenHub.Client;

/// <summary>Finds the Kraken Hub host on the local network by broadcast.</summary>
internal static class Discovery
{
    public static async Task<string?> FindHostAsync(TimeSpan timeout)
    {
        try
        {
            using var udp = new UdpClient(0) { EnableBroadcast = true };
            var request = Encoding.UTF8.GetBytes("KRAKEN_HUB_DISCOVER");
            await udp.SendAsync(request, request.Length, new IPEndPoint(IPAddress.Broadcast, 7301));
            using var cts = new CancellationTokenSource(timeout);
            while (!cts.IsCancellationRequested)
            {
                var res = await udp.ReceiveAsync(cts.Token);
                using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(res.Buffer));
                var root = doc.RootElement;
                if (root.TryGetProperty("app", out var app) && app.GetString() == "kraken-hub" && root.TryGetProperty("port", out var port))
                    return $"http://{res.RemoteEndPoint.Address}:{port.GetInt32()}";
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            Log.Write($"Discovery failed: {ex.Message}");
        }
        return null;
    }
}

/// <summary>Restart, shut down or log off, on request from the counter.</summary>
internal static class SystemActions
{
    public static void Run(string action)
    {
        var args = action switch
        {
            "restart" => "/r /t 3 /f",
            "shutdown" => "/s /t 3 /f",
            "logoff" => "/l /f",
            _ => null,
        };
        if (args is null) return;
        Log.Write($"System action from counter: {action}");
        try
        {
            Process.Start(new ProcessStartInfo("shutdown.exe", args) { CreateNoWindow = true, UseShellExecute = false });
        }
        catch (Exception ex)
        {
            Log.Write($"System action {action} failed: {ex.Message}");
        }
    }
}

/// <summary>
/// While the lock screen is up, swallows the keys people use to escape a full-screen app:
/// Windows key, Alt+Tab, Alt+Esc, Ctrl+Esc, Alt+F4. Ctrl+Alt+Del can't be blocked by an
/// app; the lockdown policies applied at install take care of Task Manager.
/// Ctrl+Alt+Shift+F12 always raises <see cref="AdminHotkey"/> for staff.
/// </summary>
internal sealed class KeyboardBlocker : IDisposable
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WM_KEYDOWN = 0x0100;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int LLKHF_ALTDOWN = 0x20;
    private const int VK_TAB = 0x09, VK_ESCAPE = 0x1B, VK_LWIN = 0x5B, VK_RWIN = 0x5C, VK_APPS = 0x5D, VK_F4 = 0x73, VK_F12 = 0x7B;
    private const int VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12;

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    private readonly LowLevelKeyboardProc _proc; // kept alive so the GC doesn't collect the callback
    private IntPtr _hook;

    public bool Enabled { get; set; }
    public event Action? AdminHotkey;

    public KeyboardBlocker()
    {
        _proc = OnKey;
        _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
        if (_hook == IntPtr.Zero) Log.Write($"Keyboard hook failed: {Marshal.GetLastWin32Error()}");
    }

    private static bool Down(int vk) => (GetAsyncKeyState(vk) & 0x8000) != 0;

    private IntPtr OnKey(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var kb = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            var vk = (int)kb.vkCode;
            var isDown = wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN;
            var alt = (kb.flags & LLKHF_ALTDOWN) != 0 || Down(VK_MENU);
            var ctrl = Down(VK_CONTROL);

            if (isDown && vk == VK_F12 && ctrl && alt && Down(VK_SHIFT))
            {
                AdminHotkey?.Invoke();
                return 1;
            }

            if (Enabled)
            {
                var block = vk is VK_LWIN or VK_RWIN or VK_APPS
                    || (alt && (vk == VK_TAB || vk == VK_ESCAPE || vk == VK_F4))
                    || (ctrl && vk == VK_ESCAPE);
                if (block) return 1;
            }
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    public void Dispose()
    {
        if (_hook != IntPtr.Zero) UnhookWindowsHookEx(_hook);
        _hook = IntPtr.Zero;
    }
}
