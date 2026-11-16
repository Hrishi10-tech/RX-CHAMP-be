using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Platform.Windows.Native;

namespace RXVision.Agent.Platform.Windows.Probes;

/// <summary>Reads the two clocks <see cref="SleepMath"/> compares. Swapped out in tests.</summary>
internal interface ISleepSource
{
    /// <summary>Milliseconds since boot, including time spent suspended (Environment.TickCount64).</summary>
    long WallMs();
    /// <summary>Unbiased interrupt time in 100 ns units, excluding suspend. False when unavailable.</summary>
    bool TryUnbiased(out ulong ticks);
}

[SupportedOSPlatform("windows")]
internal sealed class WindowsSleepSource : ISleepSource
{
    public long WallMs() => Environment.TickCount64;
    public bool TryUnbiased(out ulong ticks) => NativeMethods.QueryUnbiasedInterruptTime(out ticks);
}

/// <summary>
/// Detects time the machine spent asleep, independent of wall-clock changes. Sleep
/// is the gap between a clock that runs while suspended and one that does not (see
/// <see cref="SleepMath"/>). Gaps under a minute are not reported. Call
/// <see cref="SleptSinceLastCall"/> once per sampling tick and nowhere else, because
/// it re-marks both clocks each time.
/// </summary>
internal sealed class WindowsSleepClock : ISleepClock
{
    private readonly ISleepSource _source;
    private readonly object _gate = new();
    private long _wallMs;
    private ulong _unbiased;
    private bool _primed;

    public WindowsSleepClock(ISleepSource source) => _source = source;

    public void Prime()
    {
        lock (_gate)
        {
            if (!_source.TryUnbiased(out var unbiased)) { _primed = false; return; }
            _wallMs = _source.WallMs();
            _unbiased = unbiased;
            _primed = true;
        }
    }

    public TimeSpan? SleptSinceLastCall()
    {
        lock (_gate)
        {
            if (!_source.TryUnbiased(out var nowUnbiased)) return null;
            var nowWall = _source.WallMs();

            if (!_primed)
            {
                _wallMs = nowWall;
                _unbiased = nowUnbiased;
                _primed = true;
                return null;
            }

            var slept = SleepMath.Slept(_wallMs, _unbiased, nowWall, nowUnbiased);
            _wallMs = nowWall;
            _unbiased = nowUnbiased;
            return slept;
        }
    }
}
