namespace RXVision.Agent.Platform.Mac;

/// <summary>
/// Pure sleep-time math, unit-tested with injected values. The machine's asleep
/// time is the continuous clock's advance minus the (sleep-pausing) absolute
/// clock's advance over the same interval, both converted from mach ticks to
/// nanoseconds with the timebase ratio numer/denom.
/// </summary>
internal static class MachSleepMath
{
    internal static ulong ToNanoseconds(ulong ticks, uint numer, uint denom)
    {
        if (denom == 0) return ticks; // defensive: treat as 1:1 (Intel timebase)
        if (numer == denom) return ticks;
        // numer can be large (e.g. 125) so widen before multiplying to avoid overflow.
        return (ulong)((UInt128)ticks * numer / denom);
    }

    /// <summary>
    /// Asleep time over an interval given the two clocks' tick deltas. Never
    /// negative: tiny measurement jitter where absolute ran slightly ahead reads
    /// as zero sleep.
    /// </summary>
    internal static TimeSpan Slept(ulong absoluteDeltaTicks, ulong continuousDeltaTicks, uint numer, uint denom)
    {
        var absNs = ToNanoseconds(absoluteDeltaTicks, numer, denom);
        var contNs = ToNanoseconds(continuousDeltaTicks, numer, denom);
        if (contNs <= absNs) return TimeSpan.Zero;
        var sleptNs = contNs - absNs;
        // 100 ns per tick; clamp into long range (sleep is minutes/hours, never near the limit).
        var hundredNs = sleptNs / 100UL;
        if (hundredNs > long.MaxValue) hundredNs = long.MaxValue;
        return TimeSpan.FromTicks((long)hundredNs);
    }
}
