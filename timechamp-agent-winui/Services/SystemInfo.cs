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

/// <summary>
/// Notices that the machine was asleep — the one thing no other signal here can see.
///
/// A sleeping PC cannot report, so a break taken by closing the lid arrives at the
/// server as a hole in the samples rather than as idle time, and those minutes are
/// dropped from both columns. Where the user pressed Win+L first the lock screen
/// proves nobody was working, but a lid closed without locking leaves no evidence at
/// all — one user lost 1h48m that way in a single day.
///
/// Two clocks tell them apart: the wall clock keeps running while the machine is
/// suspended, and <c>QueryUnbiasedInterruptTime</c> does not. If the wall clock has
/// moved further than the unbiased one, the difference is exactly how long the
/// machine slept. It also distinguishes sleep from the agent being killed — a dead
/// process advances neither.
/// </summary>
public static class SleepWatcher
{
    /// <summary>Interrupt time excluding any time the system spent suspended, in
    /// 100-nanosecond units — the same unit as <see cref="TimeSpan.Ticks"/>.</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryUnbiasedInterruptTime(out ulong unbiasedTime);

    /// <summary>
    /// Shortest sleep worth reporting, matching the longest span the server lets a
    /// single sample stand for. Below this the sample either side already covers the
    /// time, so reporting it would double-count rather than recover anything.
    /// </summary>
    public static readonly TimeSpan MinReportable = TimeSpan.FromSeconds(150);

    private static DateTime _wall;
    private static ulong _unbiased;
    private static bool _primed;

    /// <summary>Starts watching from now, so the first comparison has something to
    /// measure against and the agent's own startup is never read as a sleep.</summary>
    public static void Prime()
    {
        if (!QueryUnbiasedInterruptTime(out var unbiased)) return;
        _wall = DateTime.UtcNow;
        _unbiased = unbiased;
        _primed = true;
    }

    /// <summary>
    /// How long the machine slept since the last call, or null for "it didn't, or not
    /// long enough to matter". Re-marks both clocks on every call, so this is meant to
    /// be called once per sampling tick and nowhere else.
    /// </summary>
    public static TimeSpan? SleepSinceLastCall()
    {
        if (!QueryUnbiasedInterruptTime(out var unbiasedNow)) return null;
        var wallNow = DateTime.UtcNow;

        if (!_primed)
        {
            _wall = wallNow;
            _unbiased = unbiasedNow;
            _primed = true;
            return null;
        }

        var wallDelta = wallNow - _wall;
        var awakeDelta = TimeSpan.FromTicks((long)(unbiasedNow - _unbiased));
        _wall = wallNow;
        _unbiased = unbiasedNow;

        // A wall clock that went backwards means it was adjusted, not that time was
        // lost; there is nothing to recover and guessing would invent idle time.
        if (wallDelta < TimeSpan.Zero) return null;

        var slept = wallDelta - awakeDelta;
        return slept >= MinReportable ? slept : null;
    }
}

/// <summary>
/// When the user signed into Windows this session. Uses the shell (explorer.exe)
/// start time, which is created at interactive logon — so it reflects the real PC
/// login even if the agent itself is restarted later in the day. Falls back to the
/// agent's own start time if the shell can't be read.
/// </summary>
public static class SessionInfo
{
    public static DateTime? LoginTimeUtc()
    {
        try
        {
            DateTime? earliest = null;
            foreach (var p in System.Diagnostics.Process.GetProcessesByName("explorer"))
            {
                try
                {
                    var started = p.StartTime.ToUniversalTime();
                    if (earliest is null || started < earliest) earliest = started;
                }
                catch { /* access denied / exited */ }
                finally { p.Dispose(); }
            }
            return earliest
                ?? System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime();
        }
        catch
        {
            return null;
        }
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

    /// <summary>Per-monitor v2 — the context in which Windows reports real pixels.</summary>
    private static readonly IntPtr PerMonitorAwareV2 = new(-4);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    public static byte[] CapturePng()
    {
        // Windows shrinks the desktop it describes to a process that has not said it
        // understands display scaling: a 1920x1080 laptop at 150% is reported as
        // 1280x720, and the capture comes back that size — half a screenshot, on
        // every scaled machine. Saying so for this thread alone is enough. The
        // capture already runs off the UI thread, so the floating button and the
        // dashboard keep the scaling Windows does for them and nothing about how
        // they draw changes.
        var previous = TrySetPerMonitorAware();
        try
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
        finally
        {
            if (previous != IntPtr.Zero) TryRestore(previous);
        }
    }

    /// <summary>The thread's previous context, or zero when it could not be changed —
    /// a screenshot at the old size beats no screenshot at all.</summary>
    private static IntPtr TrySetPerMonitorAware()
    {
        try
        {
            return SetThreadDpiAwarenessContext(PerMonitorAwareV2);
        }
        catch
        {
            return IntPtr.Zero;
        }
    }

    private static void TryRestore(IntPtr context)
    {
        try
        {
            SetThreadDpiAwarenessContext(context);
        }
        catch
        {
            // Nothing to do: this thread is the pool's, and the next capture sets it again.
        }
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
