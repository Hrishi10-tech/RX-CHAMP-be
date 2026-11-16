namespace RXVision.Agent.Core.Util;

/// <summary>Exponential backoff with full jitter, so a fleet of agents never retries in step.</summary>
public sealed class Backoff
{
    private readonly TimeSpan _min;
    private readonly TimeSpan _max;
    private readonly Random _random;
    private int _attempt;

    public Backoff(TimeSpan min, TimeSpan max, Random? random = null)
    {
        _min = min;
        _max = max;
        _random = random ?? Random.Shared;
    }

    public int Attempt => _attempt;

    /// <summary>The next delay: between min and min * 2^attempt (capped at max), randomised.</summary>
    public TimeSpan Next()
    {
        var ceiling = Math.Min(_max.TotalMilliseconds, _min.TotalMilliseconds * Math.Pow(2, Math.Min(_attempt, 16)));
        _attempt++;
        var ms = _min.TotalMilliseconds + _random.NextDouble() * Math.Max(0, ceiling - _min.TotalMilliseconds);
        return TimeSpan.FromMilliseconds(ms);
    }

    public void Reset() => _attempt = 0;
}
