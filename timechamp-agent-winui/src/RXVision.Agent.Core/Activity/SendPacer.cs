namespace RXVision.Agent.Core.Activity;

/// <summary>
/// Keeps one person's sample reports under the server's limit on POST /activity/report
/// (120 a minute per person, 4.0): at most <see cref="PerMinute"/> in any 60 seconds, with
/// room left for the minute's live sample, and nothing at all while the server has asked to
/// wait (429 with Retry-After, or a minute when it does not say). The endpoint takes one
/// sample per request, so a week's backlog (about 10,000 samples at one a minute) goes in
/// under two hours, and nothing is dropped for waiting. Shared by every tracker that sends
/// the person's queue (one per <see cref="ActivityQueue"/>).
/// </summary>
public sealed class SendPacer
{
    /// <summary>Requests a minute: under the server's 120, with headroom for the live sample and retries.</summary>
    public const int PerMinute = 100;
    public static readonly TimeSpan Window = TimeSpan.FromMinutes(1);
    /// <summary>The wait after a 429 that names none.</summary>
    public static readonly TimeSpan DefaultPause = TimeSpan.FromMinutes(1);

    private readonly object _gate = new();
    private readonly Queue<DateTimeOffset> _sent = new();
    private DateTimeOffset _pausedUntil = DateTimeOffset.MinValue;

    /// <summary>The clock (tests set one).</summary>
    public Func<DateTimeOffset> Clock { get; set; } = () => DateTimeOffset.UtcNow;

    /// <summary>When the next request may go: now, or later (the minute's budget used, or the server asked to wait).</summary>
    public DateTimeOffset NextAllowed
    {
        get
        {
            lock (_gate)
            {
                var now = Clock();
                Trim(now);
                var next = _sent.Count >= PerMinute ? _sent.Peek() + Window : now;
                return next > _pausedUntil ? next : _pausedUntil;
            }
        }
    }

    /// <summary>Takes a slot for one request now; false when it must wait (see <see cref="NextAllowed"/>).</summary>
    public bool TryTake()
    {
        lock (_gate)
        {
            var now = Clock();
            if (now < _pausedUntil) return false;
            Trim(now);
            if (_sent.Count >= PerMinute) return false;
            _sent.Enqueue(now);
            return true;
        }
    }

    /// <summary>The server said too many (429): nothing more until <paramref name="retryAfter"/> (or a minute) has passed.</summary>
    public void Pause(TimeSpan? retryAfter)
    {
        lock (_gate)
        {
            var until = Clock() + (retryAfter is { } wait && wait > TimeSpan.Zero ? wait : DefaultPause);
            if (until > _pausedUntil) _pausedUntil = until;
        }
    }

    /// <summary>Requests counted in the last minute (tests, logs).</summary>
    public int InLastMinute
    {
        get
        {
            lock (_gate)
            {
                Trim(Clock());
                return _sent.Count;
            }
        }
    }

    private void Trim(DateTimeOffset now)
    {
        while (_sent.Count > 0 && now - _sent.Peek() >= Window) _sent.Dequeue();
    }
}
