namespace RXVision.Agent.Core.Util;

/// <summary>
/// The time source. Tests swap it; production uses the system clock. <see cref="UtcNow"/> is the
/// wall clock (what a person reads and the server compares); <see cref="Monotonic"/> only ever
/// moves forward, so rhythm (the icon's animation, an alert's timing) is computed from it and
/// never by adding timer ticks (3.6). The timer members default to the real ones, so a clock
/// that only moves the wall time (4.0's core tests) keeps working.
/// </summary>
public interface IClock
{
    DateTimeOffset UtcNow { get; }

    /// <summary>Time since some fixed moment. Never jumps when the wall clock is changed.</summary>
    TimeSpan Monotonic => SystemClock.Instance.Monotonic;

    /// <summary>
    /// Runs <paramref name="tick"/> after <paramref name="due"/>, then every
    /// <paramref name="period"/> (<see cref="Timeout.InfiniteTimeSpan"/>: once). Dispose to stop.
    /// The callback runs on a background thread and must not throw.
    /// </summary>
    IDisposable StartTimer(Action tick, TimeSpan due, TimeSpan period) => SystemClock.Instance.StartTimer(tick, due, period);

    /// <summary>Completes after <paramref name="delay"/>, or cancels with <paramref name="ct"/>.</summary>
    Task Delay(TimeSpan delay, CancellationToken ct = default) => Task.Delay(delay, ct);
}

public sealed class SystemClock : IClock
{
    public static readonly SystemClock Instance = new();
    private static readonly long Start = System.Diagnostics.Stopwatch.GetTimestamp();

    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
    public TimeSpan Monotonic => System.Diagnostics.Stopwatch.GetElapsedTime(Start);

    public IDisposable StartTimer(Action tick, TimeSpan due, TimeSpan period) =>
        new Timer(_ => tick(), null, due, period);

    public Task Delay(TimeSpan delay, CancellationToken ct = default) => Task.Delay(delay, ct);
}

/// <summary>
/// The server's idea of now, learned from responses that carry it. Break windows
/// are minutes wide and the ring is one minute early, so a PC clock that is a few
/// minutes off would ring at the wrong time or call a punctual start "late".
/// Everything about breaks is judged on this clock, never the raw PC clock.
/// </summary>
public sealed class ServerClock : IClock
{
    private readonly IClock _local;
    private long _offsetTicks;
    private bool _known;

    public ServerClock(IClock? local = null) => _local = local ?? SystemClock.Instance;

    /// <summary>The computer's own clock this one is built on.</summary>
    public IClock Local => _local;

    public DateTimeOffset UtcNow => _local.UtcNow + Offset;
    public TimeSpan Monotonic => _local.Monotonic;
    public IDisposable StartTimer(Action tick, TimeSpan due, TimeSpan period) => _local.StartTimer(tick, due, period);
    public Task Delay(TimeSpan delay, CancellationToken ct = default) => _local.Delay(delay, ct);

    /// <summary>Server minus local. Zero until the first observation.</summary>
    public TimeSpan Offset => TimeSpan.FromTicks(Interlocked.Read(ref _offsetTicks));

    public bool Known => _known;

    /// <summary>
    /// The offset an earlier run learned (4.0: kept with the offline day), so a restart
    /// without the server still judges break times on the server's clock. An answer
    /// from the server replaces it.
    /// </summary>
    public void Seed(TimeSpan offset)
    {
        if (_known) return;
        Interlocked.Exchange(ref _offsetTicks, offset.Ticks);
        _known = true;
    }

    /// <summary>
    /// Records an observation of the server clock taken when a response arrived.
    /// Half the round trip is subtracted; small jitter is smoothed so the ring
    /// does not wobble, but a real jump (the PC clock was changed) is taken at once.
    /// </summary>
    public void Observe(DateTimeOffset serverNow, DateTimeOffset localSent, DateTimeOffset localReceived)
    {
        var rtt = localReceived - localSent;
        if (rtt < TimeSpan.Zero || rtt > TimeSpan.FromSeconds(30)) return;
        var localMid = localSent + TimeSpan.FromTicks(rtt.Ticks / 2);
        var sample = serverNow - localMid;
        var current = Offset;
        var next = !_known || (sample - current).Duration() > TimeSpan.FromSeconds(30)
            ? sample
            : TimeSpan.FromTicks((current.Ticks * 3 + sample.Ticks) / 4);
        Interlocked.Exchange(ref _offsetTicks, next.Ticks);
        _known = true;
    }
}

/// <summary>
/// A clock moved by hand: the time-shifted tests' clock, for Core and for the UI builders.
/// <see cref="Advance"/> walks the time forward, stopping at each timer and delay that falls
/// due, in time order, and runs it on the caller's thread.
/// </summary>
public sealed class ManualClock : IClock
{
    private readonly object _gate = new();
    private readonly List<Entry> _entries = new();
    private DateTimeOffset _now;
    private TimeSpan _monotonic;
    private long _seq;

    public ManualClock(DateTimeOffset start) => _now = start;

    public DateTimeOffset UtcNow { get { lock (_gate) return _now; } }
    public TimeSpan Monotonic { get { lock (_gate) return _monotonic; } }

    /// <summary>How many timers and delays are waiting (tests).</summary>
    public int Pending { get { lock (_gate) return _entries.Count; } }

    public IDisposable StartTimer(Action tick, TimeSpan due, TimeSpan period)
    {
        var entry = new Entry(this, tick, period);
        Add(entry, due);
        return entry;
    }

    public Task Delay(TimeSpan delay, CancellationToken ct = default)
    {
        if (ct.IsCancellationRequested) return Task.FromCanceled(ct);
        if (delay <= TimeSpan.Zero) return Task.CompletedTask;
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entry = new Entry(this, () => done.TrySetResult(), Timeout.InfiniteTimeSpan);
        Add(entry, delay);
        if (ct.CanBeCanceled)
        {
            ct.Register(() =>
            {
                entry.Dispose();
                done.TrySetCanceled(ct);
            });
        }
        return done.Task;
    }

    /// <summary>Moves the time forward, running everything that falls due on the way.</summary>
    public void Advance(TimeSpan by)
    {
        if (by < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(by), "Time only moves forward.");
        DateTimeOffset end;
        lock (_gate) end = _now + by;
        while (true)
        {
            Entry? next;
            lock (_gate)
            {
                next = _entries.Where(e => e.DueAt <= end).OrderBy(e => e.DueAt).ThenBy(e => e.Seq).FirstOrDefault();
                if (next is null) break;
                if (next.DueAt > _now)
                {
                    _monotonic += next.DueAt - _now;
                    _now = next.DueAt;
                }
                _entries.Remove(next);
                if (next.Period > TimeSpan.Zero)
                {
                    next.DueAt = _now + next.Period;
                    next.Seq = ++_seq;
                    _entries.Add(next);
                }
            }
            next.Tick();
        }
        lock (_gate)
        {
            if (end > _now)
            {
                _monotonic += end - _now;
                _now = end;
            }
        }
    }

    /// <summary>The wall clock jumps (someone changed it); the monotonic time does not move.</summary>
    public void SetWallClock(DateTimeOffset now)
    {
        lock (_gate) _now = now;
    }

    private void Add(Entry entry, TimeSpan due)
    {
        lock (_gate)
        {
            entry.DueAt = _now + (due < TimeSpan.Zero ? TimeSpan.Zero : due);
            entry.Seq = ++_seq;
            _entries.Add(entry);
        }
    }

    private void Remove(Entry entry)
    {
        lock (_gate) _entries.Remove(entry);
    }

    private sealed class Entry : IDisposable
    {
        private readonly ManualClock _owner;

        public Entry(ManualClock owner, Action tick, TimeSpan period)
        {
            _owner = owner;
            Tick = tick;
            Period = period;
        }

        public Action Tick { get; }
        public TimeSpan Period { get; }
        public DateTimeOffset DueAt { get; set; }
        public long Seq { get; set; }

        public void Dispose() => _owner.Remove(this);
    }
}
