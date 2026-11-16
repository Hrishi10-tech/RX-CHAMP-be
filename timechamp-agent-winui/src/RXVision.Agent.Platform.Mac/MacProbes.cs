using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Platform.Mac.Native;

namespace RXVision.Agent.Platform.Mac;

/// <summary>Idle time from the window server's input clock. No permission needed.</summary>
[SupportedOSPlatform("macos")]
internal sealed class MacIdleProbe : IIdleProbe
{
    public TimeSpan IdleTime()
    {
        try
        {
            var seconds = CoreGraphics.CGEventSourceSecondsSinceLastEventType(
                CoreGraphics.EventSourceStateCombinedSession, CoreGraphics.AnyInputEventType);
            if (double.IsNaN(seconds) || seconds < 0) return TimeSpan.Zero;
            return TimeSpan.FromSeconds(seconds);
        }
        catch
        {
            return TimeSpan.Zero;
        }
    }
}

/// <summary>
/// Lock/unlock by polling the login-session dictionary every ~1.5 s. Locked when
/// CGSSessionScreenIsLocked is present and true, OR when this session is not on
/// the console (fast user switch / login window). Raises Changed on transitions.
/// </summary>
[SupportedOSPlatform("macos")]
internal sealed class MacLockProbe : ILockProbe
{
    private static readonly TimeSpan Interval = TimeSpan.FromMilliseconds(1500);
    private readonly ILog _log;
    private readonly object _gate = new();
    private Timer? _timer;
    private bool _locked;
    private bool _started;

    public MacLockProbe(ILog log) => _log = log;

    public bool IsLocked
    {
        get { try { return ReadLocked(); } catch { return false; } }
    }

    public event Action<bool>? Changed;

    public void Start()
    {
        lock (_gate)
        {
            if (_started) return;
            _started = true;
            try { _locked = ReadLocked(); } catch { _locked = false; }
            _timer = new Timer(_ => Poll(), null, Interval, Interval);
        }
    }

    public void Stop()
    {
        lock (_gate)
        {
            _started = false;
            _timer?.Dispose();
            _timer = null;
        }
    }

    private void Poll()
    {
        bool now;
        try { now = ReadLocked(); } catch { return; }
        bool changed;
        lock (_gate)
        {
            changed = now != _locked;
            _locked = now;
        }
        if (changed)
        {
            try { Changed?.Invoke(now); } catch (Exception ex) { _log.Warn("lock", "lock handler threw", ex); }
        }
    }

    private static bool ReadLocked()
    {
        var dict = CoreGraphics.CGSessionCopyCurrentDictionary();
        if (dict == IntPtr.Zero) return false; // no window-server session (e.g. ssh): treat as unlocked
        var lockedKey = IntPtr.Zero;
        var consoleKey = IntPtr.Zero;
        try
        {
            lockedKey = CoreFoundation.CreateString("CGSSessionScreenIsLocked");
            consoleKey = CoreFoundation.CreateString("kCGSSessionOnConsoleKey");

            // Value is borrowed (Get rule): do not release it.
            var screenLocked = CoreFoundation.BooleanToManaged(CoreFoundation.CFDictionaryGetValue(dict, lockedKey)) == true;

            var onConsoleValue = CoreFoundation.CFDictionaryGetValue(dict, consoleKey);
            var onConsole = CoreFoundation.BooleanToManaged(onConsoleValue);
            var switchedAway = onConsole == false; // present and false => another session owns the console

            return screenLocked || switchedAway;
        }
        finally
        {
            if (lockedKey != IntPtr.Zero) CoreFoundation.CFRelease(lockedKey);
            if (consoleKey != IntPtr.Zero) CoreFoundation.CFRelease(consoleKey);
            CoreFoundation.CFRelease(dict); // we own the copied dictionary
        }
    }
}

/// <summary>Sleep detector: continuous-clock advance minus absolute-clock advance.</summary>
[SupportedOSPlatform("macos")]
internal sealed class MacSleepClock : ISleepClock
{
    private readonly object _gate = new();
    private ulong _absBase;
    private ulong _contBase;
    private uint _numer = 1;
    private uint _denom = 1;
    private bool _primed;

    public void Prime()
    {
        lock (_gate)
        {
            try
            {
                if (LibSystem.mach_timebase_info(out var tb) == 0 && tb.Denom != 0)
                {
                    _numer = tb.Numer;
                    _denom = tb.Denom;
                }
                _absBase = LibSystem.mach_absolute_time();
                _contBase = LibSystem.mach_continuous_time();
                _primed = true;
            }
            catch
            {
                _primed = false;
            }
        }
    }

    public TimeSpan? SleptSinceLastCall()
    {
        lock (_gate)
        {
            if (!_primed) { Prime(); return null; }
            try
            {
                var absNow = LibSystem.mach_absolute_time();
                var contNow = LibSystem.mach_continuous_time();
                var absDelta = absNow >= _absBase ? absNow - _absBase : 0UL;
                var contDelta = contNow >= _contBase ? contNow - _contBase : 0UL;
                _absBase = absNow;
                _contBase = contNow;

                var slept = MachSleepMath.Slept(absDelta, contDelta, _numer, _denom);
                return slept >= TimeSpan.FromMinutes(1) ? slept : null;
            }
            catch
            {
                return null;
            }
        }
    }
}

/// <summary>macOS has no reliable "foreground app is full-screen" signal we need
/// (full-screen apps live in their own Space); report false, as specified.</summary>
internal sealed class MacScreenInfo : IScreenInfo
{
    public bool IsFullScreenAppInFront() => false;
}
