using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>
/// Core review C-R09: past the fallback moment the agent asks the server a few times quickly,
/// then once a minute, however long the answer still says In a meeting.
/// </summary>
public class MeetingFallbackPaceTests
{
    [Fact]
    public void Asks_six_times_quickly_then_once_a_minute()
    {
        var local = new ManualClock(new DateTimeOffset(2026, 11, 18, 10, 0, 0, TimeSpan.Zero));
        var clock = new ServerClock(local);
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var monitor = new MeetingMonitor(platform, clock, NullLog.Instance);
        var asks = 0;
        monitor.FallbackDue = _ => asks++;
        var meeting = new DayProgress
        {
            Status = DayProgressStatus.Meeting,
            MeetingFallbackAt = local.UtcNow.AddSeconds(-1),
        };
        monitor.OnProgress(null, meeting);

        // Two minutes of one tick a second, the server answering In a meeting throughout.
        for (var s = 0; s < 120; s++)
        {
            monitor.Tick();
            local.Advance(TimeSpan.FromSeconds(1));
        }
        // Six quick asks over the first 30 seconds, then one a minute: 6 + 1 or 2, never 24.
        Assert.InRange(asks, 7, 8);
    }
}

/// <summary>Core review C-R12: a window read that hangs is never joined by another one.</summary>
public class HungCallProbeTests
{
    [Fact]
    public async Task A_hung_window_read_blocks_no_second_one_until_it_returns()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        using var gate = new ManualResetEventSlim(false);
        platform.WindowGate = gate;
        var clock = new ServerClock(new ManualClock(DateTimeOffset.UtcNow));
        var monitor = new MeetingMonitor(platform, clock, NullLog.Instance)
        {
            Status = () => MeetingCallStatus.Working,
        };

        await monitor.CallTickAsync();   // times out after the probe limit; the read is still blocked
        await monitor.CallTickAsync();   // must not start a second read
        await monitor.CallTickAsync();
        lock (platform.WindowReads) Assert.Single(platform.WindowReads);

        gate.Set();
        await Task.Delay(200);
        await monitor.CallTickAsync();   // the first read came back: a new one may start
        lock (platform.WindowReads) Assert.Equal(2, platform.WindowReads.Count);
    }
}

/// <summary>Core review C-R08: a restart during the 2 hour fallback still shows Back to Working, once.</summary>
public class FallbackRestoreTests
{
    private static (MeetingMonitor Monitor, DateTimeOffset EndedAt, List<MeetingRecord> Today) Make()
    {
        var local = new ManualClock(new DateTimeOffset(2026, 11, 18, 10, 30, 0, TimeSpan.Zero));
        var clock = new ServerClock(local);
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var monitor = new MeetingMonitor(platform, clock, NullLog.Instance);
        var ended = local.UtcNow.AddMinutes(-4);
        var today = new List<MeetingRecord>
        {
            new() { Id = "m1", Kind = MeetingKinds.Status, StartedAt = ended.AddHours(-2), EndedAt = ended, EndReason = "NO_ANSWER" },
        };
        return (monitor, ended, today);
    }

    private static DayProgress Working() => new() { Status = DayProgressStatus.Working };

    [Fact]
    public void The_card_comes_back_after_a_restart_and_idle_restarts_at_the_fallback()
    {
        var (monitor, ended, today) = Make();
        DateTimeOffset? restartedAt = null;
        monitor.FellBack += at => restartedAt = at;
        monitor.RestoreFallback(today, alreadyRead: null);   // before the first day progress: waits
        Assert.Empty(monitor.Alerts);
        monitor.OnProgress(null, Working());
        Assert.Contains(monitor.Alerts, a => a.Kind == MeetingAlertKind.BackToWorking);
        Assert.Equal(ended, restartedAt);

        DateTimeOffset? read = null;
        monitor.FallbackCardRead += at => read = at;
        monitor.PanelClosed();
        Assert.Equal(ended, read);
    }

    [Fact]
    public void A_card_already_read_before_the_restart_stays_gone()
    {
        var (monitor, ended, today) = Make();
        monitor.OnProgress(null, Working());
        monitor.RestoreFallback(today, alreadyRead: ended);
        Assert.Empty(monitor.Alerts);
    }
}
