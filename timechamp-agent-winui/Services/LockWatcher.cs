using Microsoft.Win32;

namespace TimeChampAgent.Services;

/// <summary>
/// Tracks whether the workstation is locked (Win+L, Ctrl-Alt-Del, the lock screen,
/// or a disconnected remote session).
///
/// Idle detection alone can't see this: <see cref="IdleWatcher"/> only reports time
/// since the last input, so locking looks identical to sitting still and takes the
/// full idle threshold to register. A lock is unambiguous — nobody is working — so
/// it counts as idle from the moment it happens.
/// </summary>
public static class LockWatcher
{
    private static volatile bool _locked;
    private static bool _hooked;

    /// <summary>Raised on lock and on unlock, so a sample can be sent immediately
    /// instead of waiting up to a full sampling interval for the boundary.</summary>
    public static event Action<bool>? Changed;

    /// <summary>True while the workstation is locked or the session is disconnected.</summary>
    public static bool IsLocked => _locked;

    /// <summary>Begins listening. Safe to call more than once.</summary>
    public static void Start()
    {
        if (_hooked) return;
        _hooked = true;
        SystemEvents.SessionSwitch += OnSessionSwitch;
    }

    public static void Stop()
    {
        if (!_hooked) return;
        _hooked = false;
        SystemEvents.SessionSwitch -= OnSessionSwitch;
    }

    private static void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        bool? locked = e.Reason switch
        {
            SessionSwitchReason.SessionLock => true,
            SessionSwitchReason.SessionLogoff => true,
            // The user disconnected an RDP session — the desktop is no longer theirs.
            SessionSwitchReason.ConsoleDisconnect => true,
            SessionSwitchReason.RemoteDisconnect => true,
            SessionSwitchReason.SessionUnlock => false,
            SessionSwitchReason.SessionLogon => false,
            SessionSwitchReason.ConsoleConnect => false,
            SessionSwitchReason.RemoteConnect => false,
            // Anything else (e.g. SessionRemoteControl) leaves the state alone.
            _ => null,
        };

        if (locked is null || locked.Value == _locked) return;
        _locked = locked.Value;
        Changed?.Invoke(_locked);
    }
}
