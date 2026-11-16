using RXVision.Agent.Platform.Windows.Probes;
using Xunit;

namespace RXVision.Agent.Platform.Windows.Tests;

public class IdleMathTests
{
    [Fact]
    public void Plain_difference_is_the_gap()
    {
        Assert.Equal(TimeSpan.FromSeconds(5), IdleMath.Idle(1_000u, 6_000u));
    }

    [Fact]
    public void Zero_when_no_time_has_passed()
    {
        Assert.Equal(TimeSpan.Zero, IdleMath.Idle(123_456u, 123_456u));
    }

    [Fact]
    public void Wraps_correctly_across_the_32bit_rollover()
    {
        // Last input 16 ms before the counter wrapped past 2^32; now 16 ms after.
        const uint lastInput = 0xFFFFFFF0u; // 4294967280
        const uint now = 0x00000010u;       // 16
        Assert.Equal(TimeSpan.FromMilliseconds(32), IdleMath.Idle(lastInput, now));
    }

    [Fact]
    public void An_input_stamp_ahead_of_now_reads_as_input_just_now_not_49_days_idle()
    {
        // LASTINPUTINFO.dwTime is not guaranteed to be incremental (SendInput may supply
        // its own stamp): 10 ms in the future must not wrap to ~49.7 days of idle.
        Assert.Equal(TimeSpan.Zero, IdleMath.Idle(1_010u, 1_000u));
        Assert.Equal(TimeSpan.Zero, IdleMath.Idle(0x00000005u, 0xFFFFFFF0u)); // ahead, across the wrap
    }

    [Fact]
    public void A_long_real_idle_is_kept()
    {
        Assert.Equal(TimeSpan.FromHours(20), IdleMath.Idle(0u, 72_000_000u));
    }
}

public class UpdateAttemptTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 13, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void The_same_version_handed_over_within_a_day_is_held_back()
    {
        var record = UpdateAttempt.Record("3.0.1", Now.AddHours(-1));
        Assert.True(UpdateAttempt.RecentlyTried(record, "3.0.1", Now));
    }

    [Fact]
    public void A_different_version_is_not_held_back()
    {
        var record = UpdateAttempt.Record("3.0.1", Now.AddMinutes(-5));
        Assert.False(UpdateAttempt.RecentlyTried(record, "3.0.2", Now));
    }

    [Fact]
    public void After_a_day_the_same_version_is_tried_again()
    {
        var record = UpdateAttempt.Record("3.0.1", Now.AddHours(-25));
        Assert.False(UpdateAttempt.RecentlyTried(record, "3.0.1", Now));
    }

    [Fact]
    public void A_record_from_the_future_does_not_block()
    {
        // The clock was moved back since the attempt: do not hold the version for longer than a day.
        var record = UpdateAttempt.Record("3.0.1", Now.AddDays(3));
        Assert.False(UpdateAttempt.RecentlyTried(record, "3.0.1", Now));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("3.0.1")]
    [InlineData("3.0.1\nnot a time\n")]
    public void Missing_or_damaged_records_do_not_block(string? record)
    {
        Assert.False(UpdateAttempt.RecentlyTried(record, "3.0.1", Now));
    }

    [Fact]
    public void Tolerates_windows_line_endings_and_whitespace()
    {
        var record = $" 3.0.1 \r\n{Now.AddMinutes(-1).UtcDateTime:O}\r\n";
        Assert.True(UpdateAttempt.RecentlyTried(record, "3.0.1", Now));
    }
}

public class SecretFileTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("rxv-secret-").FullName;

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { }
    }

    [Fact]
    public void Writes_and_replaces_the_file_and_leaves_no_temp_file()
    {
        var path = Path.Combine(_dir, "secret-session.bin");
        SecretFile.Write(path, new byte[] { 1, 2, 3 });
        SecretFile.Write(path, new byte[] { 4, 5 });

        Assert.Equal(new byte[] { 4, 5 }, File.ReadAllBytes(path));
        Assert.Equal(path, Assert.Single(Directory.GetFiles(_dir)));
    }

    [Fact]
    public void A_move_that_keeps_failing_is_retried_then_cleans_up_its_temp_file()
    {
        // A directory where the file should go: the move fails every time, as it would
        // while something holds the target open on Windows.
        var path = Path.Combine(_dir, "secret-session.bin");
        Directory.CreateDirectory(path);
        var sleeps = 0;

        var error = Record.Exception(() => SecretFile.Write(path, new byte[] { 1 }, attempts: 3, sleep: _ => sleeps++));

        Assert.True(error is IOException or UnauthorizedAccessException, $"unexpected: {error}");
        Assert.Equal(2, sleeps);                     // retried between the three attempts
        Assert.Empty(Directory.GetFiles(_dir));      // no stray temp copy of the secret
    }
}

public class SleepMathTests
{
    private const ulong MsIn100ns = 10_000; // 1 ms = 10,000 ticks of 100 ns

    [Fact]
    public void No_sleep_when_both_clocks_advance_together()
    {
        // 60 s of wall time, 60 s awake.
        Assert.Null(SleepMath.Slept(1_000, 0, 61_000, 60_000 * MsIn100ns));
    }

    [Fact]
    public void Reports_a_long_sleep_as_wall_minus_awake()
    {
        // 1 h of wall time, 2 min of it awake => 58 min slept.
        var slept = SleepMath.Slept(0, 0, 3_600_000, 120_000 * MsIn100ns);
        Assert.NotNull(slept);
        Assert.Equal(TimeSpan.FromMinutes(58), slept);
    }

    [Fact]
    public void Ignores_a_gap_under_a_minute()
    {
        // 100 s wall, 50 s awake => 50 s slept, below the one-minute floor.
        Assert.Null(SleepMath.Slept(0, 0, 100_000, 50_000 * MsIn100ns));
    }

    [Fact]
    public void Immune_to_clock_change_because_both_sources_are_monotonic_counters()
    {
        // A wall-clock (NTP) change does not move TickCount64 or the unbiased clock,
        // so a tick where nothing slept reads as no sleep regardless of the calendar.
        Assert.Null(SleepMath.Slept(500_000, 300_000 * MsIn100ns, 560_000, 360_000 * MsIn100ns));
    }

    [Fact]
    public void Backwards_reading_is_discarded()
    {
        Assert.Null(SleepMath.Slept(5_000, 0, 1_000, 0));                 // wall went back
        Assert.Null(SleepMath.Slept(0, 1_000_000, 60_000, 0));            // unbiased went back
    }
}

public class HostNormalizerTests
{
    [Theory]
    [InlineData("https://github.com/user/repo?tab=readme", "github.com")]
    [InlineData("www.example.com", "example.com")]
    [InlineData("github.com", "github.com")]
    [InlineData("https://sub.domain.co.uk/path", "sub.domain.co.uk")]
    [InlineData("http://localhost:4000/api", "localhost")]
    public void Extracts_the_host_only(string raw, string expected)
    {
        Assert.Equal(expected, HostNormalizer.Normalize(raw));
    }

    [Theory]
    [InlineData("how do i fix this")] // a search query (spaces, no dot)
    [InlineData("   ")]
    [InlineData("")]
    [InlineData(null)]
    public void Rejects_non_urls(string? raw)
    {
        Assert.Null(HostNormalizer.Normalize(raw));
    }
}

public class AppNameTests
{
    [Theory]
    [InlineData("chrome", "Chrome")]
    [InlineData("code", "Code")]
    public void Prettifies_a_process_name(string process, string expected)
    {
        Assert.Equal(expected, AppName.Prettify(process));
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    public void Null_for_nothing(string? process)
    {
        Assert.Null(AppName.Prettify(process));
    }
}

public class LockDecisionTests
{
    // sessionFlags: 0 == LOCK, 1 == UNLOCK, -1 == UNKNOWN. connectState 4 == disconnected.
    private const int Active = 0, Disconnected = 4, Lock = 0, Unlock = 1, Unknown = -1;

    [Fact]
    public void Active_and_unlocked_is_not_locked()
    {
        Assert.False(LockDecision.IsLocked(desktopOpenable: true, wtsKnown: true, Active, Unlock));
    }

    [Fact]
    public void Locked_session_is_locked_even_if_the_desktop_opens()
    {
        Assert.True(LockDecision.IsLocked(desktopOpenable: true, wtsKnown: true, Active, Lock));
    }

    [Fact]
    public void Uac_prompt_while_unlocked_is_not_a_lock()
    {
        // Secure desktop closes the input desktop, but the session flag says unlocked.
        Assert.False(LockDecision.IsLocked(desktopOpenable: false, wtsKnown: true, Active, Unlock));
    }

    [Fact]
    public void Disconnected_remote_session_is_locked()
    {
        Assert.True(LockDecision.IsLocked(desktopOpenable: true, wtsKnown: true, Disconnected, Unlock));
    }

    [Fact]
    public void Unknown_flag_falls_back_to_the_desktop_signal()
    {
        Assert.True(LockDecision.IsLocked(desktopOpenable: false, wtsKnown: true, Active, Unknown));
        Assert.False(LockDecision.IsLocked(desktopOpenable: true, wtsKnown: true, Active, Unknown));
    }

    [Fact]
    public void Without_wts_the_desktop_signal_decides()
    {
        Assert.True(LockDecision.IsLocked(desktopOpenable: false, wtsKnown: false, 0, 0));
        Assert.False(LockDecision.IsLocked(desktopOpenable: true, wtsKnown: false, 0, 0));
    }
}

public class SleepClockTests
{
    private sealed class FakeSource : ISleepSource
    {
        public long Wall;
        public ulong Unbiased;
        public bool Available = true;
        public long WallMs() => Wall;
        public bool TryUnbiased(out ulong ticks) { ticks = Unbiased; return Available; }
    }

    private const ulong MsIn100ns = 10_000;

    [Fact]
    public void No_sleep_right_after_priming()
    {
        var src = new FakeSource { Wall = 10_000, Unbiased = 5_000 * MsIn100ns };
        var clock = new WindowsSleepClock(src);
        clock.Prime();
        src.Wall += 60_000;
        src.Unbiased += 60_000 * MsIn100ns;
        Assert.Null(clock.SleptSinceLastCall());
    }

    [Fact]
    public void Detects_sleep_between_ticks()
    {
        var src = new FakeSource { Wall = 0, Unbiased = 0 };
        var clock = new WindowsSleepClock(src);
        clock.Prime();
        src.Wall = 3_600_000;                      // an hour of wall time
        src.Unbiased = 120_000 * MsIn100ns;        // two minutes awake
        var slept = clock.SleptSinceLastCall();
        Assert.Equal(TimeSpan.FromMinutes(58), slept);
    }

    [Fact]
    public void First_call_without_priming_just_primes()
    {
        var src = new FakeSource { Wall = 1_000, Unbiased = 500 };
        var clock = new WindowsSleepClock(src);
        Assert.Null(clock.SleptSinceLastCall());
    }
}
