using RXVision.Agent.Platform.Mac;
using Xunit;

namespace RXVision.Agent.Platform.Mac.Tests;

public class MachSleepMathTests
{
    [Theory]
    [InlineData(1000UL, 1u, 1u, 1000UL)]      // Intel: ticks already nanoseconds
    [InlineData(3UL, 125u, 3u, 125UL)]        // Apple Silicon style ratio
    [InlineData(1000UL, 0u, 0u, 1000UL)]      // defensive: zero denom treated as 1:1
    public void ToNanoseconds_applies_the_timebase(ulong ticks, uint numer, uint denom, ulong expected)
        => Assert.Equal(expected, MachSleepMath.ToNanoseconds(ticks, numer, denom));

    [Fact]
    public void ToNanoseconds_does_not_overflow_with_a_large_numerator()
    {
        // 10^12 ticks * 125 would overflow UInt64 if not widened first.
        var ns = MachSleepMath.ToNanoseconds(1_000_000_000_000UL, 125u, 3u);
        Assert.Equal((ulong)((System.UInt128)1_000_000_000_000UL * 125 / 3), ns);
    }

    [Fact]
    public void Slept_is_continuous_minus_absolute_on_an_intel_timebase()
    {
        // 1 s of awake ticks, 121 s of continuous ticks => 120 s asleep (ns == ticks).
        var slept = MachSleepMath.Slept(
            absoluteDeltaTicks: 1_000_000_000UL,
            continuousDeltaTicks: 121_000_000_000UL,
            numer: 1, denom: 1);
        Assert.Equal(TimeSpan.FromSeconds(120), slept);
    }

    [Fact]
    public void Slept_converts_ticks_on_an_apple_silicon_timebase()
    {
        // numer/denom = 125/3. Pick deltas whose difference is 3 s worth of ns.
        // diff_ns = (contTicks - absTicks) * 125 / 3 ; want diff_ns = 3e9 => diff ticks = 72_000_000
        var slept = MachSleepMath.Slept(
            absoluteDeltaTicks: 0UL,
            continuousDeltaTicks: 72_000_000UL,
            numer: 125, denom: 3);
        Assert.Equal(TimeSpan.FromSeconds(3), slept);
    }

    [Fact]
    public void Slept_clamps_jitter_to_zero()
    {
        // absolute ran slightly ahead of continuous (measurement jitter): no sleep.
        var slept = MachSleepMath.Slept(
            absoluteDeltaTicks: 1_000_050UL,
            continuousDeltaTicks: 1_000_000UL,
            numer: 1, denom: 1);
        Assert.Equal(TimeSpan.Zero, slept);
    }
}
