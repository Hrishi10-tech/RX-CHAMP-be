using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Platform.Windows.Native;

namespace RXVision.Agent.Platform.Windows.Probes;

/// <summary>Decides the lock state from the raw signals. Pure, so it is unit tested on any OS.</summary>
internal static class LockDecision
{
    // WTSINFOEX_LEVEL1.SessionFlags
    private const int Lock = 0;      // WTS_SESSIONSTATE_LOCK
    private const int Unlock = 1;    // WTS_SESSIONSTATE_UNLOCK
    private const int Disconnected = 4; // WTS_CONNECTSTATE_CLASS.WTSDisconnected

    /// <summary>
    /// True when nobody is at the machine: it is locked, logged off at the lock
    /// screen, or the session is a disconnected remote one. A UAC prompt also closes
    /// the input desktop, so a closed desktop alone is not reported as a lock: the WTS
    /// session flags tell a real lock (flag Lock) from a secure-desktop prompt while
    /// still unlocked (flag Unlock).
    /// </summary>
    public static bool IsLocked(bool desktopOpenable, bool wtsKnown, int connectState, int sessionFlags)
    {
        var desktopLocked = !desktopOpenable;
        if (!wtsKnown) return desktopLocked;

        var disconnected = connectState == Disconnected;
        if (sessionFlags == Lock) return true;             // authoritative: the session is locked
        if (sessionFlags == Unlock) return disconnected;   // unlocked: a closed desktop is just a UAC prompt
        return disconnected || desktopLocked;              // unknown flag: trust the desktop signal
    }
}

/// <summary>
/// Watches whether the workstation is locked, logged off at the lock screen, or a
/// disconnected remote session. Polls once a second on a background thread (WTS
/// session notifications would need a window and a message pump, which the platform
/// layer has not got). Start and Stop are idempotent.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsLockProbe : ILockProbe
{
    private readonly Action<string>? _log;
    private readonly object _gate = new();
    private readonly ManualResetEventSlim _stop = new(false);
    private Thread? _thread;
    private volatile bool _locked;

    public WindowsLockProbe(Action<string>? log) => _log = log;

    public bool IsLocked => _locked;
    public event Action<bool>? Changed;

    public void Start()
    {
        lock (_gate)
        {
            if (_thread is not null) return;
            // Seed before the first tick so an agent started on a locked machine does
            // not announce a lock that happened before it was watching.
            try { _locked = QueryLocked(); }
            catch (Exception ex) { _log?.Invoke($"lock: first poll failed: {ex.Message}"); }
            _stop.Reset();
            _thread = new Thread(Loop) { IsBackground = true, Name = "rxvision-lock" };
            _thread.Start();
        }
    }

    public void Stop()
    {
        Thread? thread;
        lock (_gate)
        {
            if (_thread is null) return;
            thread = _thread;
            _thread = null;
            _stop.Set();
        }
        try { thread.Join(TimeSpan.FromSeconds(3)); } catch { }
    }

    private void Loop()
    {
        while (!_stop.Wait(1000))
        {
            try
            {
                var locked = QueryLocked();
                if (locked == _locked) continue;
                _locked = locked;
                try { Changed?.Invoke(locked); } catch (Exception ex) { _log?.Invoke($"lock: handler threw: {ex.Message}"); }
            }
            catch (Exception ex)
            {
                _log?.Invoke($"lock: poll failed: {ex.Message}");
            }
        }
    }

    private static bool QueryLocked()
    {
        var openable = CanOpenInputDesktop();
        var wtsKnown = TryWtsState(out var connectState, out var sessionFlags);
        return LockDecision.IsLocked(openable, wtsKnown, connectState, sessionFlags);
    }

    private static bool CanOpenInputDesktop()
    {
        var desktop = NativeMethods.OpenInputDesktop(0, false, NativeMethods.DESKTOP_SWITCHDESKTOP);
        if (desktop == IntPtr.Zero) return false;
        NativeMethods.CloseDesktop(desktop);
        return true;
    }

    /// <summary>Reads the current session's connect state and lock flags from WTSINFOEX.
    /// The struct is x64: Level at 0, then 4 bytes of padding, SessionId at 8,
    /// SessionState at 12, SessionFlags at 16.</summary>
    private static bool TryWtsState(out int connectState, out int sessionFlags)
    {
        connectState = 0;
        sessionFlags = NativeMethods.WTS_SESSIONSTATE_UNKNOWN;
        if (!NativeMethods.WTSQuerySessionInformationW(
                NativeMethods.WTS_CURRENT_SERVER_HANDLE, NativeMethods.WTS_CURRENT_SESSION,
                NativeMethods.WTSSessionInfoEx, out var buffer, out var bytes))
        {
            return false;
        }
        try
        {
            if (buffer == IntPtr.Zero || bytes < 20) return false;
            var level = Marshal.ReadInt32(buffer, 0);
            if (level != 1) return false;
            connectState = Marshal.ReadInt32(buffer, 12);
            sessionFlags = Marshal.ReadInt32(buffer, 16);
            return true;
        }
        finally
        {
            NativeMethods.WTSFreeMemory(buffer);
        }
    }
}
