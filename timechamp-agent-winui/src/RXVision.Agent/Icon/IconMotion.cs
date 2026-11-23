using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;

namespace RXVision.Agent.Icon;

/// <summary>
/// A frame timer that runs only while something moves. Each tick marshals to the UI thread and
/// asks whether to keep going. Every value it drives is computed from the clock, never by adding
/// ticks, so a late frame shows the right moment rather than a late one.
/// </summary>
public sealed class FramePump : IDisposable
{
    /// <summary>About 60 frames a second.</summary>
    public static readonly TimeSpan Interval = TimeSpan.FromMilliseconds(16);

    private readonly IClock _clock;
    private readonly IUiDispatcher _ui;
    private readonly Func<bool> _frame;
    private IDisposable? _timer;
    private int _queued;

    /// <param name="frame">Draws one frame; true while there is more to come.</param>
    public FramePump(IClock clock, IUiDispatcher ui, Func<bool> frame)
    {
        _clock = clock;
        _ui = ui;
        _frame = frame;
    }

    public bool IsRunning => _timer is not null;

    public void Wake() => _timer ??= _clock.StartTimer(Queue, Interval, Interval);

    public void Dispose()
    {
        _timer?.Dispose();
        _timer = null;
    }

    private void Queue()
    {
        if (Interlocked.Exchange(ref _queued, 1) == 1) return;
        _ui.Post(() =>
        {
            Volatile.Write(ref _queued, 0);
            if (_timer is not null && !_frame()) Dispose();
        });
    }
}

/// <summary>A value moving from one number to another over a set time.</summary>
public readonly record struct Tween(double From, double To, TimeSpan Start, TimeSpan Length, Func<double, double> Ease)
{
    public static Tween Still(double value) => new(value, value, TimeSpan.Zero, TimeSpan.Zero, Easing.Linear);

    public bool IsDone(TimeSpan now) => now - Start >= Length;

    public double At(TimeSpan now)
    {
        if (IsDone(now)) return To;
        var t = Math.Max(0, (now - Start) / Length);
        return From + (To - From) * Ease(t);
    }
}

public static class Easing
{
    public static double Linear(double t) => t;
    public static double Out(double t) => 1 - (1 - t) * (1 - t) * (1 - t);
    public static double InOut(double t) => t < 0.5 ? 4 * t * t * t : 1 - Math.Pow(-2 * t + 2, 3) / 2;

    /// <summary>The badge's pop: 0 to 1.15 to 1, easing out.</summary>
    public static double Pop(double t)
    {
        const double peakAt = 0.6;
        const double peak = 1.15;
        return t < peakAt ? peak * Out(t / peakAt) : peak + (1 - peak) * Out((t - peakAt) / (1 - peakAt));
    }
}

/// <summary>
/// The alert's shake (AGENT.md section 3): x(t) = A sin(2 pi 4 t) for 1 s, then 3 s still,
/// repeating from one start on the monotonic clock, and still for good at 60 s.
/// </summary>
public sealed class BadgeMotion
{
    /// <summary>In device-independent pixels: 2 px of travel in all, at any scale.</summary>
    public const double Amplitude = 1;
    public static readonly TimeSpan MovesFor = TimeSpan.FromSeconds(1);
    public static readonly TimeSpan Cycle = TimeSpan.FromSeconds(4);
    public static readonly TimeSpan StopsAfter = TimeSpan.FromSeconds(60);

    private TimeSpan? _start;
    private TimeSpan? _pausedAfter;

    /// <summary>Started and not yet past its 60 s.</summary>
    public bool IsRunning(TimeSpan now) => _start is { } start && now - start < StopsAfter;

    /// <summary>A new 60 s, unless one is running: a new alert during motion keeps the rhythm.</summary>
    public void Start(TimeSpan now)
    {
        _pausedAfter = null;
        if (!IsRunning(now)) _start = now;
    }

    public void Stop()
    {
        _start = null;
        _pausedAfter = null;
    }

    /// <summary>The icon is hidden by a full-screen app: the 60 s waits.</summary>
    public void Pause(TimeSpan now)
    {
        if (!IsRunning(now)) return;
        _pausedAfter = now - _start!.Value;
        _start = null;
    }

    /// <summary>The icon shows again: the 60 s goes on from where it stopped.</summary>
    public void Resume(TimeSpan now)
    {
        if (_pausedAfter is not { } done) return;
        _start = now - done;
        _pausedAfter = null;
    }

    /// <summary>An alert arrived while the icon is hidden: its 60 s starts when the icon shows.</summary>
    public void Wait()
    {
        _start = null;
        _pausedAfter ??= TimeSpan.Zero;
    }

    /// <summary>The shift of the drawing now.</summary>
    public double Offset(TimeSpan now)
    {
        if (!IsRunning(now)) return 0;
        var phase = Phase(now);
        return phase < MovesFor ? Amplitude * Math.Sin(2 * Math.PI * 4 * phase.TotalSeconds) : 0;
    }

    /// <summary>In the 1 s of movement: frames are needed.</summary>
    public bool IsMoving(TimeSpan now) => IsRunning(now) && Phase(now) < MovesFor;

    /// <summary>How long until the next 1 s of movement; null when no more is coming.</summary>
    public TimeSpan? NextMoveIn(TimeSpan now)
    {
        if (!IsRunning(now) || IsMoving(now)) return null;
        var next = now + (Cycle - Phase(now));
        return next - _start!.Value < StopsAfter ? next - now : null;
    }

    private TimeSpan Phase(TimeSpan now)
    {
        var since = now - _start!.Value;
        return TimeSpan.FromTicks(since.Ticks % Cycle.Ticks);
    }
}
