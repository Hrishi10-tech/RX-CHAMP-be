using System.Globalization;
using System.Text.Json;
using RXVision.Agent.Core.Activity;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Offline;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Util;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>
/// Offline evidence (SPEC 2.4, 6): a day replayed from the journal counts as focus only where
/// the agent's activity samples cover it, so the samples follow the journal at once, and the
/// day is read again when the backlog is with the server. Paid time and unverified time are
/// read from the 4.0 answers.
/// </summary>
public class OfflineEvidenceTests
{
    private static string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    [Fact]
    public void The_day_and_the_month_carry_paid_time_and_unverified_time()
    {
        var day = JsonSerializer.Deserialize<WorkdayToday>(
            """{"state":"OPEN","focus":{"focusSec":3600,"paidBreakSec":900,"unpaidBreakSec":60,"unverifiedSec":1200,"paidSec":4500}}""", Json.Options)!;
        Assert.Equal((900, 60, 1200, (int?)4500), (day.Focus.PaidBreakSec, day.Focus.UnpaidBreakSec, day.Focus.UnverifiedSec, day.Focus.PaidSec));

        // A 3.1 server sends none of them.
        var old = JsonSerializer.Deserialize<WorkdayToday>("""{"state":"OPEN","focus":{"focusSec":3600}}""", Json.Options)!;
        Assert.Equal((0, (int?)null), (old.Focus.UnverifiedSec, old.Focus.PaidSec));

        var month = JsonSerializer.Deserialize<HistoryMonth>(
            """
            {"month":"2026-10","focusSec":7200,"paidBreakSec":900,"unverifiedSec":300,"paidSec":8100,
             "days":[{"date":"2026-10-12","focusSec":3600,"paidBreakSec":600,"unverifiedSec":300,"paidSec":4200},
                     {"date":"2026-10-13","focusSec":3600,"paidBreakSec":300}]}
            """, Json.Options)!;
        Assert.Equal((8100, 300), (month.Paid, month.UnverifiedSec));
        Assert.Equal((4200, 300), (month.Days[0].Paid, month.Days[0].UnverifiedSec));
        Assert.Equal((3900, 0), (month.Days[1].Paid, month.Days[1].UnverifiedSec));   // worked out: focus + paid breaks

        // The copy History saves for offline keeps them (and not the worked-out figure).
        var saved = JsonSerializer.Serialize(month, Json.Options);
        Assert.Contains("\"unverifiedSec\":300", saved);
        Assert.DoesNotContain("\"paid\":", saved);
        Assert.Equal(8100, JsonSerializer.Deserialize<HistoryMonth>(saved, Json.Options)!.Paid);
    }

    [Fact]
    public void Break_time_is_counted_in_whole_seconds_as_the_server_counts_it()
    {
        // Each instant is floored to its second first (SPEC 2.4).
        var t = new DateTimeOffset(2026, 10, 13, 5, 0, 10, TimeSpan.Zero).AddMilliseconds(900);
        Assert.Equal(1, DayProjection.WholeSeconds(t, t.AddMilliseconds(300)));   // 10.9 s to 11.2 s
        Assert.Equal(0, DayProjection.WholeSeconds(t, t.AddMilliseconds(50)));    // 10.9 s to 10.95 s
        Assert.Equal(0, DayProjection.WholeSeconds(t, t.AddSeconds(-5)));
        Assert.Equal(90, DayProjection.WholeSeconds(t, t.AddSeconds(90)));

        // Three quick breaks under a second each, each across a second boundary: 3 s of buffer
        // here as on the server (not 0 here and 3 there).
        var day = new BreakDay();
        for (var i = 0; i < 3; i++)
            day.Quick.Add(new QuickBreakView { Id = $"q-{i}", StartedAt = t.AddMinutes(i), EndedAt = t.AddMinutes(i).AddMilliseconds(300), PlannedMin = 5 });
        var allowance = DayProjection.Allowance(null, day, t.AddMinutes(10));
        Assert.Equal(3, allowance.BreakSec);
        Assert.Equal(3, allowance.BufferUsedSec);
        Assert.Equal(3, DayProjection.Totals(day, Array.Empty<MeetingRecord>(), t.AddMinutes(10)).QuickSec);
    }

    [Fact]
    public void A_sample_is_backlog_when_it_is_sent_more_than_three_minutes_after_it_was_taken()
    {
        var now = DateTimeOffset.UtcNow;
        Assert.False(ActivityTracker.IsBacklog(Iso(now), now));
        Assert.False(ActivityTracker.IsBacklog(Iso(now.AddMinutes(-2)), now));   // a slow tick is still live
        Assert.True(ActivityTracker.IsBacklog(Iso(now.AddMinutes(-4)), now));
        Assert.True(ActivityTracker.IsBacklog(Iso(now.AddDays(-6)), now));
        Assert.False(ActivityTracker.IsBacklog("", now));
        Assert.False(ActivityTracker.IsBacklog(null, now));
    }

    private static (ActivityTracker Tracker, ActivityQueue Queue, FakeServer Server) Tracker(Func<HttpResponseMessage>? answer = null)
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var server = new FakeServer();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        server.Route("POST activity/report", (_, _) => answer?.Invoke() ?? FakeServer.Ok(new { activeSec = 60, shouldCapture = true, screenshotsEnabled = true }));
        var api = new ApiClient("https://api.example.com/api/v1", new AgentIdentity("4.0.0", "dev", "d"), new SessionStore(platform.Secrets), new ServerClock(), NullLog.Instance, server);
        api.LoginAsync("a@x.test", "pw").GetAwaiter().GetResult();
        var queue = new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance);
        return (new ActivityTracker(api, platform, new AgentOptions().Normalised(), queue, NullLog.Instance), queue, server);
    }

    [Fact]
    public async Task Sending_the_offline_backlog_says_so_once_the_queue_is_empty()
    {
        var (tracker, queue, server) = Tracker();
        var told = 0;
        tracker.BacklogSent += () => Interlocked.Increment(ref told);
        var paced = DateTimeOffset.UtcNow;
        queue.Pacer.Clock = () => paced;
        var start = DateTimeOffset.UtcNow.AddMinutes(-150);
        for (var i = 0; i < 145; i++) queue.Enqueue(new ActivityReport { At = Iso(start.AddMinutes(i)), App = "Code" });

        // A minute's worth at a time: not yet (samples are still waiting), then once, when the last one is sent.
        Assert.False(await tracker.DrainAsync(ActivityTracker.DrainPerTick, CancellationToken.None));
        Assert.Equal(0, told);
        paced += TimeSpan.FromMinutes(1);
        Assert.True(await tracker.DrainAsync(ActivityTracker.DrainPerTick, CancellationToken.None));
        Assert.Equal(1, told);
        Assert.Equal(145, server.Count("POST activity/report"));

        // Live samples are not backlog: nothing to read again.
        paced += TimeSpan.FromMinutes(1);
        queue.Enqueue(new ActivityReport { At = Iso(DateTimeOffset.UtcNow), App = "Code" });
        Assert.True(await tracker.DrainAsync(ActivityTracker.DrainPerTick, CancellationToken.None));
        Assert.Equal(1, told);
    }

    [Fact]
    public async Task A_backlog_the_network_interrupts_says_nothing_until_it_is_all_sent()
    {
        var online = false;
        var (tracker, queue, _) = Tracker(() => online ? FakeServer.Ok(new { activeSec = 60, shouldCapture = true }) : FakeServer.Html(503));
        var told = 0;
        tracker.BacklogSent += () => Interlocked.Increment(ref told);
        for (var i = 0; i < 3; i++) queue.Enqueue(new ActivityReport { At = Iso(DateTimeOffset.UtcNow.AddMinutes(-30 + i)) });

        Assert.False(await tracker.DrainAsync(ActivityTracker.DrainPerTick, CancellationToken.None));
        Assert.Equal(0, told);
        online = true;
        Assert.True(await tracker.DrainAsync(ActivityTracker.DrainPerTick, CancellationToken.None));
        Assert.Equal(1, told);
    }

    [Fact]
    public async Task The_samples_follow_the_journal_at_once_before_the_day_is_read_again()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        h.Server.Route("POST breaks/quick/start", (_, _) => FakeServer.Ok(new
        {
            record = new { id = "q-1", kind = "QUICK", label = "Quick break", presenceType = "BREAK", plannedMin = 5, startedAt = DateTimeOffset.UtcNow.ToString("o"), inProgress = true, state = "ACTIVE" },
        }));
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Reports > 0);

        // An action waits for the network; the samples taken meanwhile wait behind it.
        h.Server.FailWith = req => req.RequestUri!.AbsolutePath.EndsWith("breaks/quick/start") ? new HttpRequestException("no network") : null;
        h.Host.ImmediateWait = TimeSpan.Zero;
        await h.Host.QuickBreakAsync(5);
        var reports = h.Reports;
        // A sample taken now (a tick already running skips this one: ask again until one is queued).
        for (var i = 0; i < 40 && h.Host.PendingSamples == 0; i++)
        {
            await h.Host.SampleNowAsync();
            if (h.Host.PendingSamples == 0) await Task.Delay(50);
        }
        Assert.Equal(reports, h.Reports);
        Assert.True(h.Host.PendingSamples >= 1);

        // Back: the action goes, then the samples straight away (not at the next minute's
        // tick), and only then is the day read again.
        var before = h.Server.Calls.Count;
        h.Server.FailWith = _ => null;
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(20)));
        await HostHarness.WaitFor(() => h.Host.PendingSamples == 0);
        await HostHarness.WaitFor(() => h.Server.Calls.Skip(before).Any(c => c is { Method: "GET", Path: "workday/me/today" }));
        var after = h.Server.Calls.Skip(before).Select(c => $"{c.Method} {c.Path}").ToList();
        var replayed = after.IndexOf("POST breaks/quick/start");
        var firstSample = after.IndexOf("POST activity/report");
        var dayRead = after.IndexOf("GET workday/me/today");
        Assert.True(replayed >= 0 && replayed < firstSample, string.Join(", ", after));
        Assert.True(firstSample < dayRead, string.Join(", ", after));
    }
}

/// <summary>How the sender takes the replay answers that are not a plain yes (SPEC 6).</summary>
public class ReplayRefusalTests
{
    [Fact]
    public async Task Event_in_progress_is_asked_again_and_a_closed_month_is_final()
    {
        var running = await ResultReader.ReadAsync<JsonElement>(
            FakeServer.Error(409, "EVENT_IN_PROGRESS", "This action is still being processed. Try again in a moment."), CancellationToken.None);
        Assert.Equal(ApiOutcome.Transient, running.Outcome);
        var locked = await ResultReader.ReadAsync<JsonElement>(FakeServer.Error(409, "MONTH_LOCKED", "October 2026 is locked for payroll."), CancellationToken.None);
        Assert.Equal(ApiOutcome.Rejected, locked.Outcome);
        var onBreak = await ResultReader.ReadAsync<JsonElement>(FakeServer.Error(409, "ON_BREAK", "You're already on a break."), CancellationToken.None);
        Assert.Equal(ApiOutcome.Rejected, onBreak.Outcome);
    }

    [Fact]
    public async Task An_action_whose_first_copy_is_still_running_is_sent_again_and_kept()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        var tries = 0;
        h.Server.Route("POST meetings/past", (_, _) => Interlocked.Increment(ref tries) == 1
            ? FakeServer.Error(409, "EVENT_IN_PROGRESS", "This action is still being processed. Try again in a moment.")
            : FakeServer.Ok(new { meeting = new { id = "p-1", mode = "PAST" } }));
        var told = new List<string>();
        h.Host.ActionRefused += m => { lock (told) told.Add(m); };
        await h.SignInAsync();

        h.Server.FailWith = _ => new HttpRequestException("no network");
        h.Host.ImmediateWait = TimeSpan.Zero;
        Assert.IsType<MeetingOutcome.Logged>(await h.Host.LogPastMeetingAsync(DateTimeOffset.UtcNow.AddMinutes(-30), 10, "Stand-up",
            Array.Empty<MeetingParticipant>(), "Ravi"));
        h.Server.FailWith = _ => null;
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(20)));

        // Asked twice (the offline tries never reached it), both times as the same action.
        Assert.Equal(2, tries);
        var sent = h.Server.Sent.Where(x => x.Key == "POST meetings/past" && x.EventId is not null).ToList();
        Assert.Single(sent.Select(x => x.EventId).Distinct());
        await Task.Delay(200);
        lock (told) Assert.Empty(told);
    }

    [Fact]
    public async Task A_month_closed_for_payroll_is_said_once_for_all_its_actions()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        HttpResponseMessage Locked() => FakeServer.Error(409, AgentHost.MonthLocked, "That month is locked for payroll.");
        h.Server.Route("POST breaks/quick/start", (_, _) => Locked());
        h.Server.Route("POST meetings/past", (_, _) => Locked());
        h.Server.Route("POST breaks/end", (_, _) => FakeServer.Ok(new { ended = true }));
        var told = new List<string>();
        h.Host.ActionRefused += m => { lock (told) told.Add(m); };
        await h.SignInAsync();

        h.Server.FailWith = _ => new HttpRequestException("no network");
        h.Host.ImmediateWait = TimeSpan.Zero;
        await h.Host.QuickBreakAsync(5);
        await h.Host.BackToWorkAsync();   // acts on the quick break the closed month refuses
        Assert.IsType<MeetingOutcome.Logged>(await h.Host.LogPastMeetingAsync(DateTimeOffset.UtcNow.AddMinutes(-30), 10, "Stand-up",
            Array.Empty<MeetingParticipant>(), "Ravi"));
        Assert.Equal(3, h.Host.PendingActions);

        h.Server.FailWith = _ => null;
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(20)));
        Assert.Equal(1, h.Server.Count("POST meetings/past"));   // refused for good: never asked again
        Assert.Equal(0, h.Server.Count("POST breaks/end"));
        await HostHarness.WaitFor(() => { lock (told) return told.Count >= 1; });
        await Task.Delay(300);
        lock (told)
        {
            var notice = Assert.Single(told);
            Assert.StartsWith("Starting your quick break on ", notice);
            Assert.EndsWith(" couldn't be saved. That day's month is closed for payroll; ask your Admin.", notice);
        }
    }
}
