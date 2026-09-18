using System.Runtime.InteropServices;
using System.Timers;

namespace TimeChampAgent.Services;

/// <summary>
/// Tracks whether the workstation is locked (Win+L, Ctrl-Alt-Del, the lock screen,
/// or a disconnected remote session).
///
/// Idle detection alone can't see this: <see cref="IdleWatcher"/> only reports time
/// since the last input, so locking looks identical to sitting still and takes the
/// full idle threshold to register. A lock is unambiguous — nobody is working — so
/// it counts as idle from the moment it happens.
///
/// Asks Windows directly, once a second, rather than waiting to be told.
/// <c>SystemEvents.SessionSwitch</c> was here first and never fired once in this
/// app — it needs the WinForms message pump, which a WinUI process does not run.
/// Nobody noticed because the server infers a lock from the lock screen being in
/// the foreground, which the next sample carries anyway. That inference costs up to
/// a full sampling interval, and a machine that sleeps inside that window is never
/// recorded as locked at all: the break is simply lost. Measured at 28 minutes for
/// one user who locked and closed the lid in the same movement.
///
/// A second of granularity is enough — the gap that mattered was a minute wide —
/// and polling keeps this to two calls with no window class, no message loop, and
/// no callback for Windows to invoke after we are gone.
/// </summary>
public static class LockWatcher
{
    /// <summary>Right to switch desktops — asked for only to see whether it is refused.</summary>
    private const uint DesktopSwitchdesktop = 0x0100;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    private static volatile bool _locked;
    private static System.Timers.Timer? _poll;

    /// <summary>Raised on lock and on unlock, so a sample can be sent immediately
    /// instead of waiting up to a whole sampling interval for the boundary.</summary>
    public static event Action<bool>? Changed;

    /// <summary>True while the workstation is locked or the session is disconnected.</summary>
    public static bool IsLocked => _locked;

    /// <summary>Begins watching. Safe to call more than once.</summary>
    public static void Start()
    {
        if (_poll is not null) return;

        // Seed before the first tick, so an agent started on a locked machine does not
        // announce a lock that happened before it was watching.
        _locked = QueryLocked();

        _poll = new System.Timers.Timer(1000) { AutoReset = true };
        _poll.Elapsed += OnTick;
        _poll.Start();
    }

    public static void Stop()
    {
        if (_poll is null) return;
        _poll.Elapsed -= OnTick;
        _poll.Stop();
        _poll.Dispose();
        _poll = null;
    }

    private static void OnTick(object? sender, ElapsedEventArgs e)
    {
        var locked = QueryLocked();
        if (locked == _locked) return;
        _locked = locked;
        Changed?.Invoke(locked);
    }

    /// <summary>
    /// True when the input desktop cannot be opened. While the machine is locked the
    /// secure desktop (Winlogon) owns the input, and it refuses every other process —
    /// which is exactly the signal, and the only one that does not depend on a
    /// particular lock screen app being in the foreground.
    /// </summary>
    private static bool QueryLocked()
    {
        var desktop = OpenInputDesktop(0, false, DesktopSwitchdesktop);
        if (desktop == IntPtr.Zero) return true;

        CloseDesktop(desktop);
        return false;
    }
}
