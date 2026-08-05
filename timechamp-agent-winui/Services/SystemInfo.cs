using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace TimeChampAgent.Services;

/// <summary>Reports how long the machine has been idle (no keyboard/mouse input).</summary>
public static class IdleWatcher
{
    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [DllImport("kernel32.dll")]
    private static extern uint GetTickCount();

    /// <summary>Seconds since the last user input, or 0 if it can't be read.</summary>
    public static double IdleSeconds()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) return 0;
        return (GetTickCount() - info.dwTime) / 1000.0;
    }
}

/// <summary>Reads the current foreground window: its title and the friendly name
/// of the app that owns it. Used to record "what is being used right now".</summary>
public static class ForegroundWatcher
{
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public readonly record struct Foreground(string? App, string? Title, string? Process, IntPtr Handle);

    /// <summary>Foreground app friendly name, window title and owning process name.</summary>
    public static Foreground Current()
    {
        try
        {
            var hWnd = GetForegroundWindow();
            if (hWnd == IntPtr.Zero) return default;

            var len = GetWindowTextLength(hWnd);
            string? title = null;
            if (len > 0)
            {
                var sb = new System.Text.StringBuilder(len + 1);
                GetWindowText(hWnd, sb, sb.Capacity);
                title = sb.ToString();
            }

            GetWindowThreadProcessId(hWnd, out var pid);
            string? app = null, process = null;
            if (pid != 0)
            {
                try
                {
                    using var p = System.Diagnostics.Process.GetProcessById((int)pid);
                    process = p.ProcessName;
                    app = SafeDescription(p) ?? Prettify(p.ProcessName);
                }
                catch { /* process may have exited */ }
            }

            return new Foreground(app, string.IsNullOrWhiteSpace(title) ? null : title, process, hWnd);
        }
        catch
        {
            return default;
        }
    }

    private static string? SafeDescription(System.Diagnostics.Process p)
    {
        try
        {
            var desc = p.MainModule?.FileVersionInfo.FileDescription;
            return string.IsNullOrWhiteSpace(desc) ? null : desc;
        }
        catch { return null; }
    }

    private static string Prettify(string proc) =>
        string.IsNullOrEmpty(proc) ? proc : char.ToUpperInvariant(proc[0]) + proc[1..];
}

/// <summary>Grabs the whole desktop (all monitors) as a PNG. Runs off the UI thread.
/// Uses Win32 <c>GetSystemMetrics</c> for the virtual-screen bounds (WinUI has no
/// <c>System.Windows.Forms.SystemInformation</c>).</summary>
public static class ScreenCapture
{
    private const int SM_XVIRTUALSCREEN = 76;
    private const int SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78;
    private const int SM_CYVIRTUALSCREEN = 79;

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    public static byte[] CapturePng()
    {
        var left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        var top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        var width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        var height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if (width <= 0 || height <= 0) return Array.Empty<byte>();

        using var bmp = new System.Drawing.Bitmap(
            width, height, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var g = System.Drawing.Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(left, top, 0, 0, new System.Drawing.Size(width, height),
                System.Drawing.CopyPixelOperation.SourceCopy);
        }
        using var ms = new MemoryStream();
        bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
        return ms.ToArray();
    }
}

/// <summary>Registers/unregisters the agent to launch at Windows sign-in (per-user, no admin).</summary>
public static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "TimeChampAgent";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
        return key?.GetValue(ValueName) is not null;
    }

    public static void Enable()
    {
        try
        {
            var exe = Environment.ProcessPath;
            if (string.IsNullOrEmpty(exe)) return;
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true)
                            ?? Registry.CurrentUser.CreateSubKey(RunKey);
            key?.SetValue(ValueName, $"\"{exe}\" --minimized");
        }
        catch { }
    }

    public static void Disable()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
            key?.DeleteValue(ValueName, throwOnMissingValue: false);
        }
        catch { }
    }
}
