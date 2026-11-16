namespace RXVision.Agent.Core.Util;

/// <summary>The time source. Tests swap it; production uses the system clock.</summary>
public interface IClock
{
    DateTimeOffset UtcNow { get; }
}

public sealed class SystemClock : IClock
{
    public static readonly SystemClock Instance = new();
    public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
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

    public DateTimeOffset UtcNow => _local.UtcNow + Offset;

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
