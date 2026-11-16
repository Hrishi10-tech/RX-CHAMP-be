using System.Diagnostics;
using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>
/// The whole agent core against a scripted server: the 3.1 working day (no
/// auto-start, Start Day, End Day and its gates, a new day after midnight, an
/// offline Start Day kept and retried).
/// </summary>
internal sealed class HostHarness : IDisposable
{
    // .invalid never resolves: the sockets fail fast in the background and touch nothing.
    public const string Base = "https://api.rxv.invalid/api/v1";

    public FakeServer Server { get; } = new();
    public DevPlatform Platform { get; }
    public MemoryLog Log { get; } = new();
    public AgentHost Host { get; }
    public List<AgentNudge> Nudges { get; } = new();
    public List<BreakRecord> AutoSkips { get; } = new();

    /// <summary>What GET /workday/me/today answers.</summary>
    public Func<HttpResponseMessage> Workday { get; set; }
    /// <summary>What GET /breaks/me/today answers.</summary>
    public Func<object> Breaks { get; set; } = () => new { date = Today, mode = "FREE", workday = true };
    /// <summary>Activity answers say a session is open.</summary>
    public bool Capture { get; set; } = true;
    public string PresenceStatus { get; set; } = "WORKING";

    public static string Today => DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(5.5)).ToString("yyyy-MM-dd");
    public static string Yesterday => DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(5.5)).AddDays(-1).ToString("yyyy-MM-dd");
    public static string Tomorrow => DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(5.5)).AddDays(1).ToString("yyyy-MM-dd");

    public HostHarness(object workday, string role = "USER", DevPlatform? platform = null, TimeSpan? secretStoreLimit = null)
    {
        Platform = platform ?? new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        // The monitoring notice was read on an earlier day.
        File.WriteAllText(Path.Combine(Platform.DataDir, "notice-u1.txt"), "ok");
        Workday = () => FakeServer.Ok(workday);

        Server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User("u-1", role), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        Server.Route("GET workday/me/today", (_, _) => Workday());
        Server.Route("GET breaks/me/today", (_, _) => FakeServer.Ok(Breaks()));
        Server.Route("GET presence/me/current", (_, _) => FakeServer.Ok(new { status = PresenceStatus }));
        Server.Route("GET presence/me/today", (_, _) => FakeServer.Ok(new { date = Today, totals = new { breakSec = 0 } }));
        Server.Route("POST presence/heartbeat", (_, _) => FakeServer.Ok(new { ok = true }));
        Server.Route("POST activity/report", (_, _) => FakeServer.Ok(new { activeSec = 60, shouldCapture = Capture, screenshotsEnabled = true }));
        Server.Route("GET chat/contacts", (_, _) => FakeServer.Ok(Array.Empty<object>()));
        Server.Route("GET chat/unread", (_, _) => FakeServer.Ok(new { count = 0 }));
        Server.Route("GET meetings/me/today", (_, _) => FakeServer.Ok(new { items = Array.Empty<object>() }));
        Server.Route("GET approvals/me", (_, _) => FakeServer.Ok(new { items = Array.Empty<object>() }));
        Server.Route("POST activity/start-day", (_, _) =>
        {
            Workday = () => FakeServer.Ok(Day("OPEN"));
            return FakeServer.Ok(new { ok = true, date = Today, resumed = false, workday = Day("OPEN") });
        });

        Server.Route("POST auth/refresh", (_, _) => FakeServer.Ok(new { refreshed = true }, FakeServer.AccessCookie(), FakeServer.RefreshCookie("rt-2")));

        Host = new AgentHost(Platform, new AgentOptions { ApiBaseUrl = Base }.Normalised(), Log, Server, secretStoreLimit: secretStoreLimit);
        Host.Nudge += n => { lock (Nudges) Nudges.Add(n); };
        Host.BreakAutoSkipped += r => { lock (AutoSkips) AutoSkips.Add(r); };
    }

    public static object Day(string state, string? date = null, bool autoClosed = false, object? skips = null,
        object? lastEnded = null, DateTimeOffset? endedAt = null, int focusSec = 5400, object? config = null) => new
    {
        date = date ?? Today,
        serverNow = DateTimeOffset.UtcNow.ToString("o"),
        timezone = "Asia/Kolkata",
        state,
        startedAt = state == "NOT_STARTED" ? null : DateTimeOffset.UtcNow.AddHours(-2).ToString("o"),
        endedAt = state == "ENDED" ? (endedAt ?? DateTimeOffset.UtcNow.AddMinutes(-5)).ToString("o") : null,
        autoClosed,
        lastEnded,
        focus = new { focusSec, running = state == "OPEN" },
        expectedSec = 28_800,
        skipsNeedingComment = skips ?? Array.Empty<object>(),
        settings = new { approvalSlaHours = 48, reasonMinChars = 10 },
        portalUrl = "https://app.rxvision.shop",
        config,
    };

    public async Task SignInAsync()
    {
        await Host.StartAsync();
        Assert.Equal(AgentState.SignIn, Host.State);
        Assert.Null(await Host.SignInAsync("asha@x.test", "pw"));
    }

    public int Reports => Server.Count("POST activity/report");

    public static async Task WaitFor(Func<bool> condition, int seconds = 8)
    {
        var until = DateTime.UtcNow.AddSeconds(seconds);
        while (!condition())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException("condition not met");
            await Task.Delay(50);
        }
    }

    public void Dispose() => Host.Dispose();
}

public class AgentHostTests
{
    private static object Skip(string id, string kind) => new
    {
        id, date = HostHarness.Today, kind, label = kind == "LUNCH" ? "Lunch break" : kind == "MORNING" ? "Morning break" : "Evening break",
        outcome = "AUTO_SKIPPED", skippedAt = DateTimeOffset.UtcNow.AddHours(-1).ToString("o"), minChars = 10,
    };

    [Fact]
    public async Task A_new_day_at_sign_in_is_NotStarted_greets_and_records_nothing()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        await h.SignInAsync();

        Assert.Equal(AgentState.NotStarted, h.Host.State);
        Assert.True(h.Host.DayKnown);
        Assert.Equal(PresenceStatus.NotStarted, h.Host.Presence.Status);
        var greeting = Assert.Single(h.Nudges);
        Assert.Equal(NudgeKind.Greeting, greeting.Kind);

        // No activity, no heartbeats, no screenshots before Start Day.
        await Task.Delay(2600);
        Assert.Equal(0, h.Reports);
        Assert.Equal(0, h.Server.Count("POST presence/heartbeat"));
        Assert.False(h.Host.OnManagerCaptureRequest());
        Assert.Equal(0, h.Server.Count("POST activity/start-day"));
        Assert.Equal(0, h.Platform.Captures);
    }

    [Fact]
    public async Task Start_Day_opens_the_day_and_tracking_starts()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        await h.SignInAsync();

        var outcome = await h.Host.StartDayAsync();

        var started = Assert.IsType<StartDayOutcome.Started>(outcome);
        Assert.True(started.Workday!.IsOpen);
        Assert.False(started.Resumed);
        Assert.Equal(AgentState.Running, h.Host.State);
        // Sent with the press's time and the replay headers (SPEC 6), so a repeat is harmless.
        var sent = h.Server.Sent.Single(x => x.Key == "POST activity/start-day");
        Assert.True(Guid.TryParse(sent.EventId, out _));
        using (var body = JsonDocument.Parse(sent.Body!))
            Assert.Equal(DateTimeOffset.Parse(sent.EventAt!), DateTimeOffset.Parse(body.RootElement.GetProperty("startedAt").GetString()!));
        await HostHarness.WaitFor(() => h.Reports > 0);
        Assert.True(h.Host.OnManagerCaptureRequest());
    }

    [Theory]
    [InlineData("OPEN", AgentState.Running)]
    [InlineData("ENDED", AgentState.DayEnded)]
    public async Task The_servers_day_decides_the_state_at_sign_in(string state, AgentState expected)
    {
        using var h = new HostHarness(HostHarness.Day(state));
        await h.SignInAsync();
        Assert.Equal(expected, h.Host.State);
        Assert.Empty(h.Nudges);
    }

    [Fact]
    public async Task Offline_Start_Day_runs_at_once_and_replays_with_its_time()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        await h.SignInAsync();
        h.Host.ImmediateWait = TimeSpan.FromMilliseconds(300);
        var online = false;
        h.Server.Route("POST activity/start-day", (_, _) =>
        {
            if (!online) return FakeServer.Html(503);
            h.Workday = () => FakeServer.Ok(HostHarness.Day("OPEN"));
            return FakeServer.Ok(new { ok = true, date = HostHarness.Today, workday = HostHarness.Day("OPEN") });
        });

        var before = h.Host.Clock.UtcNow;
        Assert.IsType<StartDayOutcome.Started>(await h.Host.StartDayAsync());
        // SPEC 6: the day runs from the press, on this computer, at once; nothing says "try again".
        Assert.Equal(AgentState.Running, h.Host.State);
        Assert.Equal(1, h.Host.PendingActions);

        online = true;
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(15)));
        Assert.Equal(AgentState.Running, h.Host.State);
        var sends = h.Server.Sent.Where(x => x.Key == "POST activity/start-day").ToList();
        Assert.True(sends.Count >= 2, "the failed try and the one that went through");
        Assert.All(sends, x => Assert.Equal(sends[0].EventId, x.EventId)); // one event, the same id every time
        Assert.True(Guid.TryParse(sends[0].EventId, out _));
        var at = DateTimeOffset.Parse(sends[^1].EventAt!);
        Assert.InRange(at, before.AddSeconds(-1), before.AddSeconds(5));
        using var body = JsonDocument.Parse(sends[^1].Body!);
        Assert.Equal(at, DateTimeOffset.Parse(body.RootElement.GetProperty("startedAt").GetString()!));
        // Signed in throughout: a transient error never signs anyone out.
        Assert.NotNull(h.Host.User);
    }

    [Fact]
    public async Task A_start_refused_later_is_said_once_and_the_servers_day_is_followed()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        await h.SignInAsync();
        h.Host.ImmediateWait = TimeSpan.FromMilliseconds(200);
        var refused = new List<string>();
        h.Host.ActionRefused += m => { lock (refused) refused.Add(m); };
        h.Server.Route("POST activity/start-day", (_, _) => FakeServer.Html(503));
        Assert.IsType<StartDayOutcome.Started>(await h.Host.StartDayAsync());
        Assert.Equal(AgentState.Running, h.Host.State);

        h.Server.Route("POST activity/start-day", (_, _) => FakeServer.Error(403, "FORBIDDEN", "Your account is disabled."));
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(15)));
        await HostHarness.WaitFor(() => h.Host.State == AgentState.NotStarted);
        string message;
        lock (refused) message = Assert.Single(refused);
        Assert.Contains("Your account is disabled.", message);
        Assert.Equal(0, h.Host.PendingActions);
    }

    [Fact]
    public async Task A_start_the_server_refuses_straight_away_comes_back_refused()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        await h.SignInAsync();
        h.Server.Route("POST activity/start-day", (_, _) => FakeServer.Error(403, "FORBIDDEN", "Your account is disabled."));
        var result = await h.Host.StartDayAsync();
        Assert.True(result is StartDayOutcome.Refused, string.Join("\n", h.Log.Lines) + "\n" + string.Join("\n", h.Server.Sent.Select(x => x.Key)));
        var outcome = (StartDayOutcome.Refused)result;
        Assert.Equal("Your account is disabled.", outcome.Message);
        await HostHarness.WaitFor(() => h.Host.State == AgentState.NotStarted);
        Assert.Equal(0, h.Host.PendingActions);
    }

    [Fact]
    public async Task Offline_at_sign_in_is_NotStarted_until_the_server_says()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        h.Workday = () => FakeServer.Html(502);
        await h.SignInAsync();

        Assert.Equal(AgentState.NotStarted, h.Host.State);
        Assert.False(h.Host.DayKnown);
        Assert.NotNull(h.Host.User);
        Assert.Empty(h.Nudges);   // not greeted on a guess

        h.Workday = () => FakeServer.Ok(HostHarness.Day("OPEN"));
        await h.Host.RetryPendingNowAsync();
        Assert.Equal(AgentState.Running, h.Host.State);
        Assert.True(h.Host.DayKnown);
    }

    [Fact]
    public async Task End_Day_waits_for_a_comment_on_each_skipped_break()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN", skips: new[] { Skip("b-1", "MORNING"), Skip("b-2", "LUNCH"), Skip("b-3", "EVENING") }));
        h.Server.Route("POST activity/end-day", (_, body) =>
        {
            using var doc = JsonDocument.Parse(body ?? "{}");
            var count = doc.RootElement.TryGetProperty("comments", out var c) ? c.GetArrayLength() : 0;
            return count < 3
                ? FakeServer.Error(409, "SKIP_COMMENTS_REQUIRED", "Add a comment to each skipped break first.",
                    new { breaks = new[] { Skip("b-1", "MORNING"), Skip("b-2", "LUNCH"), Skip("b-3", "EVENING") } })
                : Ended();
        });
        HttpResponseMessage Ended()
        {
            h.Workday = () => FakeServer.Ok(HostHarness.Day("ENDED"));
            return FakeServer.Ok(new { ok = true, date = HostHarness.Today, endedAt = DateTimeOffset.UtcNow.ToString("o"), workday = HostHarness.Day("ENDED") });
        }
        await h.SignInAsync();
        Assert.Equal(AgentState.Running, h.Host.State);
        Assert.Equal(3, h.Host.Workday!.SkipsNeedingComment.Count);

        var blocked = Assert.IsType<EndDayOutcome.CommentsRequired>(await h.Host.EndDayAsync());
        Assert.Equal(new[] { "b-1", "b-2", "b-3" }, blocked.Breaks.Select(b => b.Id));
        Assert.Equal(AgentState.Running, h.Host.State);   // the day keeps running

        var comments = blocked.Breaks.Select(b => new SkipComment(b.Id, $"Client call during the {b.Label}")).ToList();
        Assert.IsType<EndDayOutcome.Ended>(await h.Host.EndDayAsync(comments));
        Assert.Equal(AgentState.DayEnded, h.Host.State);
        Assert.Equal(PresenceStatus.DayEnded, h.Host.Presence.Status);
        var reports = h.Reports;
        await Task.Delay(2300);
        Assert.Equal(reports, h.Reports);   // nothing recorded after End Day
    }

    [Fact]
    public async Task End_Day_with_approvals_overdue_keeps_the_day_running()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"), role: "MANAGER");
        h.Server.Route("POST activity/end-day", (_, _) => FakeServer.Error(409, "APPROVALS_OVERDUE", "3 approvals are overdue.",
            new { count = 3, oldestDueAt = DateTimeOffset.UtcNow.AddHours(-60).ToString("o") }));
        await h.SignInAsync();

        var overdue = Assert.IsType<EndDayOutcome.ApprovalsOverdue>(await h.Host.EndDayAsync());
        Assert.Equal(3, overdue.Count);
        Assert.NotNull(overdue.OldestDueAt);
        Assert.Equal(AgentState.Running, h.Host.State);
    }

    [Fact]
    public async Task Offline_End_Day_ends_at_once_and_replays()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        var online = false;
        h.Server.Route("POST activity/end-day", (_, _) =>
        {
            if (!online) return FakeServer.Html(503);
            h.Workday = () => FakeServer.Ok(HostHarness.Day("ENDED"));
            return FakeServer.Ok(new { ok = true, date = HostHarness.Today, endedAt = DateTimeOffset.UtcNow.ToString("o") });
        });
        await h.SignInAsync();
        h.Host.ImmediateWait = TimeSpan.FromMilliseconds(300);
        Assert.IsType<EndDayOutcome.Ended>(await h.Host.EndDayAsync());
        Assert.Equal(AgentState.DayEnded, h.Host.State);
        Assert.Equal(1, h.Host.PendingActions);
        Assert.NotNull(h.Host.User);

        online = true;
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(15)));
        Assert.Equal(AgentState.DayEnded, h.Host.State);
    }

    [Fact]
    public async Task At_midnight_DayEnded_moves_to_NotStarted_never_to_Running()
    {
        // The day ended in the evening, hours before midnight.
        using var h = new HostHarness(HostHarness.Day("ENDED", date: HostHarness.Today, endedAt: DateTimeOffset.UtcNow.AddHours(-5)));
        await h.SignInAsync();
        Assert.Equal(AgentState.DayEnded, h.Host.State);

        // The 5-minute check after midnight: a new date, not started.
        h.Workday = () => FakeServer.Ok(HostHarness.Day("NOT_STARTED", date: HostHarness.Tomorrow));
        await h.Host.DayCheckNowAsync();

        Assert.Equal(AgentState.NotStarted, h.Host.State);
        await Task.Delay(2300);
        Assert.Equal(0, h.Reports);
        Assert.Equal(0, h.Server.Count("POST activity/start-day"));

        // The first unlock of the new day greets.
        h.Platform.SetLocked(true);
        h.Platform.SetLocked(false);
        await HostHarness.WaitFor(() => h.Nudges.Any(n => n.Date == HostHarness.Tomorrow));
        Assert.Equal(NudgeKind.Greeting, h.Nudges.Last().Kind);
    }

    [Fact]
    public async Task A_day_started_elsewhere_is_followed_and_Start_Day_resumes_after_End_Day()
    {
        using var h = new HostHarness(HostHarness.Day("ENDED"));
        await h.SignInAsync();
        Assert.Equal(AgentState.DayEnded, h.Host.State);

        var resumed = Assert.IsType<StartDayOutcome.Started>(await h.Host.StartDayAsync());
        Assert.True(resumed.Resumed, "Start Day after End Day resumes the day");
        Assert.Equal(AgentState.Running, h.Host.State);
    }

    [Fact]
    public async Task A_running_day_follows_the_server_when_its_session_was_closed()
    {
        // The server answers OPEN while any session is open (past midnight too: the session
        // keeps its date). So NOT_STARTED while Running means the session was closed (for
        // a missed End Day, overnight): recording stops at once and the state follows.
        using var h = new HostHarness(HostHarness.Day("OPEN", date: HostHarness.Today));
        await h.SignInAsync();
        Assert.Equal(AgentState.Running, h.Host.State);
        await HostHarness.WaitFor(() => h.Reports > 0);

        h.Workday = () => FakeServer.Ok(HostHarness.Day("NOT_STARTED", date: HostHarness.Tomorrow));
        await h.Host.DayCheckNowAsync();
        Assert.Equal(AgentState.NotStarted, h.Host.State);
        Assert.False(h.Host.OnManagerCaptureRequest());
        var reports = h.Reports;
        await h.Host.SampleNowAsync();
        await Task.Delay(1200);
        Assert.Equal(reports, h.Reports);

        // Started again; then ended elsewhere (another device, or closed for a missed End Day).
        Assert.IsType<StartDayOutcome.Started>(await h.Host.StartDayAsync());
        Assert.Equal(AgentState.Running, h.Host.State);
        h.Workday = () => FakeServer.Ok(HostHarness.Day("ENDED", date: HostHarness.Tomorrow, autoClosed: true));
        await h.Host.DayCheckNowAsync();
        Assert.Equal(AgentState.DayEnded, h.Host.State);
    }

    [Fact]
    public async Task After_a_sleep_nothing_is_recorded_until_the_day_is_checked_and_an_open_session_carries_on()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Reports > 0);
        var gate = new TaskCompletionSource();
        h.Server.Route("GET workday/me/today", (_, _) => { gate.Task.Wait(TimeSpan.FromSeconds(10)); return h.Workday(); });
        var checks = h.Server.Count("GET workday/me/today");

        // The agent's own one-second clock stood still for ten minutes: the machine slept.
        h.Host.SetAliveForTests(DateTimeOffset.UtcNow.AddMinutes(-10));
        Assert.True(h.Host.CheckForResumeNow());
        Assert.False(h.Host.OnManagerCaptureRequest());
        var reports = h.Reports;
        await h.Host.SampleNowAsync();   // taken, held back
        await HostHarness.WaitFor(() => h.Server.Count("GET workday/me/today") > checks);
        Assert.Equal(reports, h.Reports);
        Assert.Equal(0, h.Platform.Captures);

        // The session is still open: recording carries on, and what was held goes out.
        gate.SetResult();
        await HostHarness.WaitFor(() => !h.Host.CheckForResumeNow());
        Assert.Equal(AgentState.Running, h.Host.State);
        Assert.True(h.Host.OnManagerCaptureRequest());
        await h.Host.SampleNowAsync();
        await HostHarness.WaitFor(() => h.Reports > reports);
    }

    [Fact]
    public async Task A_session_closed_while_asleep_stops_recording_and_nothing_taken_after_waking_is_sent()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Reports > 0);
        // Overnight the server closed the session (no End Day); the machine wakes.
        h.Workday = () => FakeServer.Ok(HostHarness.Day("ENDED", autoClosed: true));
        var gate = new TaskCompletionSource();
        h.Server.Route("GET workday/me/today", (_, _) => { gate.Task.Wait(TimeSpan.FromSeconds(10)); return h.Workday(); });
        h.Host.SetAliveForTests(DateTimeOffset.UtcNow.AddHours(-9));
        Assert.True(h.Host.CheckForResumeNow());
        var reports = h.Reports;
        await h.Host.SampleNowAsync();
        Assert.True(h.Host.PendingSamples > 0, "the sample after waking is held");

        gate.SetResult();
        await HostHarness.WaitFor(() => h.Host.State == AgentState.DayEnded);
        await HostHarness.WaitFor(() => h.Host.PendingSamples == 0);
        await Task.Delay(1200);
        Assert.Equal(reports, h.Reports);
        Assert.False(h.Host.OnManagerCaptureRequest());
        Assert.False(h.Host.CheckForResumeNow());
    }

    [Fact]
    public async Task No_automatic_screenshot_during_a_scheduled_break_even_before_presence_says_so()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        var start = DateTimeOffset.UtcNow.AddMinutes(-2);
        string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        h.Breaks = () => new
        {
            date = HostHarness.Today, serverNow = Iso(DateTimeOffset.UtcNow), mode = "SCHEDULED", workday = true,
            activeBreak = new { id = "r-1", kind = "MORNING", label = "Morning break", startedAt = Iso(start), inProgress = true, durationMin = 15 },
            breaks = Array.Empty<object>(),
        };
        await h.SignInAsync();
        Assert.Equal(AgentState.Running, h.Host.State);
        // 4.0: presence is worked out from the day itself, so the break shows at once.
        Assert.Equal(PresenceStatus.Break, h.Host.Presence.Status);
        Assert.NotNull(h.Host.BreakPanel.Active);
        Assert.False(h.Host.OnManagerCaptureRequest());
    }

    [Fact]
    public async Task End_Day_after_midnight_shows_the_ended_days_focus_and_holds_the_greeting_and_desk_nudge()
    {
        // A night shift: the day began yesterday and ends after midnight.
        using var h = new HostHarness(HostHarness.Day("OPEN", date: HostHarness.Yesterday));
        var ended = DateTimeOffset.UtcNow.AddSeconds(-2);
        h.Server.Route("POST activity/end-day", (_, _) =>
        {
            h.Workday = () => FakeServer.Ok(HostHarness.Day("ENDED", date: HostHarness.Yesterday, endedAt: ended, focusSec: 28_000));
            return FakeServer.Ok(new
            {
                ok = true, date = HostHarness.Yesterday, endedAt = ended.ToString("o"),
                // The day that just ended (not the new date's empty day).
                workday = HostHarness.Day("ENDED", date: HostHarness.Yesterday, endedAt: ended, focusSec: 28_000),
            });
        });
        await h.SignInAsync();

        Assert.IsType<EndDayOutcome.Ended>(await h.Host.EndDayAsync());
        Assert.Equal(AgentState.DayEnded, h.Host.State);
        Assert.Equal(HostHarness.Yesterday, h.Host.Workday!.Date);
        await HostHarness.WaitFor(() => h.Host.Workday!.Focus.FocusSec == 28_000);
        Assert.Equal(AgentState.DayEnded, h.Host.State);   // ended today: it still reads as the day that ended

        // The next check: a new date, NOT_STARTED, with the day that ended a moment ago.
        h.Workday = () => FakeServer.Ok(HostHarness.Day("NOT_STARTED", date: HostHarness.Today,
            lastEnded: new { date = HostHarness.Yesterday, endedAt = ended.ToString("o"), focusSec = 28_000 }));
        await h.Host.DayCheckNowAsync(greet: true);
        Assert.Equal(AgentState.NotStarted, h.Host.State);
        Assert.Equal(28_000, h.Host.Workday!.LastEnded!.FocusSec);
        // An unlock does not greet within hours of a day ending...
        h.Platform.SetLocked(true);
        h.Platform.SetLocked(false);
        await Task.Delay(600);
        Assert.Empty(h.Nudges);
        // ...and sitting at the desk does not nudge either (for four hours).
        Assert.True(h.Host.NudgesHeld);
    }

    [Fact]
    public async Task A_day_that_ended_hours_ago_does_not_hold_the_greeting()
    {
        var ended = DateTimeOffset.UtcNow.AddHours(-5);
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED",
            lastEnded: new { date = HostHarness.Yesterday, endedAt = ended.ToString("o"), focusSec = 20_000 }));
        await h.SignInAsync();
        Assert.Equal(NudgeKind.Greeting, Assert.Single(h.Nudges).Kind);
        Assert.False(h.Host.NudgesHeld);
    }

    [Fact]
    public async Task The_server_refusing_activity_stops_recording_and_follows_its_day()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Reports > 0);

        h.Workday = () => FakeServer.Ok(HostHarness.Day("ENDED", autoClosed: true));
        h.Capture = false;
        // Sample now rather than at the minute (a sample already under way is let finish).
        var reports = h.Reports;
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (h.Host.State != AgentState.DayEnded && DateTime.UtcNow < deadline)
        {
            await h.Host.SampleNowAsync();
            await Task.Delay(50);
        }
        Assert.Equal(AgentState.DayEnded, h.Host.State);
        Assert.True(h.Reports > reports, "the refusal came with a sample");
        Assert.True(h.Host.Workday!.AutoClosed);
    }

    [Fact]
    public async Task Breaks_skips_and_meetings_wait_for_Start_Day()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        await h.SignInAsync();

        Assert.Equal("DAY_NOT_STARTED", Assert.IsType<StartOutcome.Refused>(await h.Host.TakeBreakAsync("MORNING", null)).Code);
        Assert.Equal("DAY_NOT_STARTED", Assert.IsType<SkipOutcome.Refused>(await h.Host.SkipBreakAsync("MORNING", "Client call")).Code);
        Assert.Equal("DAY_NOT_STARTED", Assert.IsType<MeetingOutcome.Refused>(await h.Host.StartMeetingAsync("Sync", Array.Empty<MeetingParticipant>())).Code);
        Assert.Equal(0, h.Server.Count("POST breaks/skip") + h.Server.Count("POST meetings/start") + h.Server.Count("POST breaks/start"));
    }

    /// <summary>Today's break day with the morning break open now (rung a few minutes ago), skippable, and lunch later.</summary>
    private static object MorningOpen(DateTimeOffset start, object? record = null, object? activeBreak = null, object[]? quick = null)
    {
        string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        var lunch = start.AddHours(2);
        return new
        {
            date = HostHarness.Today, serverNow = Iso(DateTimeOffset.UtcNow), mode = "SCHEDULED", workday = true, reasonMinChars = 10,
            shift = new { id = "s1", name = "General", start = "09:30", end = "18:30", rules = new { reasonOnEarly = false, reasonOnLate = false } },
            activeBreak,
            quick = quick ?? Array.Empty<object>(),
            breaks = new object[]
            {
                new
                {
                    kind = "MORNING", label = "Morning break", presenceType = "BREAK", durationMin = 15, allowSkip = true,
                    scheduledStart = Iso(start), scheduledEnd = Iso(start.AddMinutes(15)),
                    windowOpen = Iso(start.AddMinutes(-30)), windowClose = Iso(start.AddMinutes(60)),
                    ringStart = Iso(start.AddMinutes(-1)), ringEnd = Iso(start.AddMinutes(4)),
                    local = new { start = "11:00", end = "11:15", windowOpen = "10:30", windowClose = "12:00" },
                    record,
                },
                new
                {
                    kind = "LUNCH", label = "Lunch break", presenceType = "LUNCH", durationMin = 30, allowSkip = false,
                    scheduledStart = Iso(lunch), scheduledEnd = Iso(lunch.AddMinutes(30)),
                    windowOpen = Iso(lunch.AddMinutes(-30)), windowClose = Iso(lunch.AddMinutes(60)),
                    ringStart = Iso(lunch.AddMinutes(-1)), ringEnd = Iso(lunch.AddMinutes(4)),
                    local = new { start = "13:00", end = "13:30", windowOpen = "12:30", windowClose = "14:00" },
                    record = (object?)null,
                },
            },
        };
    }

    [Fact]
    public async Task Skip_comment_breaks_and_meetings_go_through_while_running()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN", skips: new[] { Skip("s-9", "EVENING") }));
        h.Breaks = () => MorningOpen(DateTimeOffset.UtcNow.AddMinutes(-3));
        h.Server.Route("POST breaks/skip", (_, _) => FakeServer.Ok(new { record = new { id = "s-1", outcome = "SKIPPED", reason = "Client call" } }));
        h.Server.Route("POST breaks/s-9/comment", (_, _) => FakeServer.Ok(new { record = new { id = "s-9", outcome = "AUTO_SKIPPED", reason = "Deadline today" } }));
        object[] meetings = Array.Empty<object>();
        h.Server.Route("GET meetings/me/today", (_, _) => FakeServer.Ok(new { items = meetings }));
        var meetingStart = DateTimeOffset.UtcNow;
        h.Server.Route("POST meetings/start", (_, _) =>
        {
            var live = new { id = "m-1", mode = "LIVE", agenda = "Pune sync", inProgress = true, startedAt = meetingStart.ToString("o"), momSender = "Asha" };
            meetings = new object[] { live };
            return FakeServer.Ok(new { meeting = live });
        });
        h.Server.Route("POST meetings/m-1/end", (_, _) =>
        {
            var ended = new { id = "m-1", mode = "LIVE", agenda = "Pune sync", inProgress = false, startedAt = meetingStart.ToString("o"),
                endedAt = DateTimeOffset.UtcNow.ToString("o"), durationSec = 1800, momSender = "Asha" };
            meetings = new object[] { ended };
            return FakeServer.Ok(new { meeting = ended, discarded = false });
        });
        h.Server.Route("POST meetings/past", (_, _) => FakeServer.Ok(new { meeting = new { id = "p-1", mode = "PAST" } }));
        await h.SignInAsync();

        Assert.IsType<SkipOutcome.Skipped>(await h.Host.SkipBreakAsync("MORNING", "Client call until noon"));
        using (var skip = JsonDocument.Parse(h.Server.Sent.Last(x => x.Key == "POST breaks/skip").Body!))
            Assert.Equal("MORNING", skip.RootElement.GetProperty("kind").GetString());
        Assert.IsType<CommentOutcome.Saved>(await h.Host.CommentBreakAsync("s-9", "Deadline today, sorry"));

        // 4.0: who mails the minutes is required.
        Assert.Equal("MOM_SENDER_REQUIRED", Assert.IsType<MeetingOutcome.Invalid>(
            await h.Host.StartMeetingAsync("Pune sync", new[] { new MeetingParticipant("u-2", "Maya Reddy") })).Code);
        Assert.IsType<MeetingOutcome.Started>(await h.Host.StartMeetingAsync("Pune sync", new[] { new MeetingParticipant("u-2", "Maya Reddy") }, "Asha"));
        Assert.Equal(PresenceStatus.Meeting, h.Host.Presence.Status);
        using (var start = JsonDocument.Parse(h.Server.Sent.Last(x => x.Key == "POST meetings/start").Body!))
            Assert.Equal("Asha", start.RootElement.GetProperty("momSender").GetString());
        await HostHarness.WaitFor(() => h.Host.LiveMeeting?.Id == "m-1");
        // While in a meeting, a manager's capture request still follows the rules.
        Assert.True(h.Host.OnManagerCaptureRequest());
        Assert.IsType<EndOutcome.MeetingEnded>(await h.Host.EndMeetingAsync());
        Assert.Equal(PresenceStatus.Working, h.Host.Presence.Status);

        Assert.IsType<MeetingOutcome.Logged>(await h.Host.LogPastMeetingAsync(DateTimeOffset.UtcNow.AddMinutes(-45), 15, "Stand-up",
            Array.Empty<MeetingParticipant>(), "Ravi"));
        Assert.Equal(0, h.Host.PendingActions);
    }

    [Fact]
    public async Task A_scheduled_break_pauses_resumes_and_ends_with_no_overrun_question()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        var due = DateTimeOffset.UtcNow.AddMinutes(-3);
        h.Breaks = () => MorningOpen(due);
        // The server's day follows each step, as the real one does.
        var started = DateTimeOffset.UtcNow;
        object Record(string state, bool running, DateTimeOffset? ended, params object[] segments) => new
        {
            id = "r-1", kind = "MORNING", label = "Morning break", presenceType = "BREAK", startedAt = started.ToString("o"),
            endedAt = ended?.ToString("o"), inProgress = running, durationMin = 15, state, timing = "ON_TIME", approvalStatus = "NOT_REQUIRED", segments,
        };
        object Segment(DateTimeOffset from, DateTimeOffset? to) => new { startedAt = from.ToString("o"), endedAt = to?.ToString("o") };
        h.Server.Route("POST breaks/start", (_, _) =>
        {
            var r = Record("ACTIVE", true, null, Segment(started, null));
            h.Breaks = () => MorningOpen(due, r, r);
            return FakeServer.Ok(new { record = r });
        });
        var pausedAt = DateTimeOffset.UtcNow;
        h.Server.Route("POST breaks/r-1/pause", (_, _) =>
        {
            pausedAt = DateTimeOffset.UtcNow;
            var r = Record("PAUSED", false, null, Segment(started, pausedAt));
            h.Breaks = () => MorningOpen(due, r);
            return FakeServer.Ok(r);
        });
        h.Server.Route("POST breaks/r-1/resume", (_, _) =>
        {
            var r = Record("ACTIVE", true, null, Segment(started, pausedAt), Segment(DateTimeOffset.UtcNow, null));
            h.Breaks = () => MorningOpen(due, r, r);
            return FakeServer.Ok(r);
        });
        h.Server.Route("POST breaks/end", (_, _) =>
        {
            var now = DateTimeOffset.UtcNow;
            var r = Record("ENDED", false, now, Segment(started, pausedAt), Segment(pausedAt, now));
            h.Breaks = () => MorningOpen(due, r);
            return FakeServer.Ok(new { ended = true, record = r });
        });
        await h.SignInAsync();

        Assert.IsType<StartOutcome.Started>(await h.Host.TakeBreakAsync("MORNING", null));
        Assert.True(h.Host.BreakPanel.Active!.CanPause);
        Assert.Equal(PresenceStatus.Break, h.Host.Presence.Status);

        Assert.IsType<ActionOutcome.Done>(await h.Host.PauseBreakAsync());
        Assert.Null(h.Host.BreakPanel.Active);
        Assert.Equal(SlotState.Paused, h.Host.BreakPanel.Paused!.State);
        Assert.Equal(PresenceStatus.Working, h.Host.Presence.Status);
        // Paused: another break can't start, a quick one included; it can be resumed.
        Assert.Equal("BREAK_PAUSED", Assert.IsType<StartOutcome.Refused>(await h.Host.TakeBreakAsync("LUNCH", null)).Code);

        Assert.IsType<ActionOutcome.Done>(await h.Host.ResumeBreakAsync());
        Assert.NotNull(h.Host.BreakPanel.Active);
        Assert.IsType<EndOutcome.Ended>(await h.Host.BackToWorkAsync());
        Assert.Null(h.Host.BreakPanel.Active);
        Assert.Null(h.Host.BreakPanel.Paused);

        var sent = h.Server.Sent.Where(x => x.EventId is not null).Select(x => x.Key).ToList();
        Assert.Equal(new[] { "POST breaks/start", "POST breaks/r-1/pause", "POST breaks/r-1/resume", "POST breaks/end" }, sent);
        using var end = JsonDocument.Parse(h.Server.Sent.Last(x => x.Key == "POST breaks/end").Body ?? "{}");
        Assert.False(end.RootElement.TryGetProperty("askToCount", out _)); // a 4.0 agent never asks to count the minutes over
    }

    /// <summary>
    /// Seen end to end: a break left paused until its window closed shows as taken, and
    /// Resume (a dialog or a menu still showing it) says the window closed and when, as the
    /// server would (409 RESUME_WINDOW_CLOSED), not "No break is paused".
    /// </summary>
    [Fact]
    public async Task Resuming_after_the_window_closed_says_when_it_closed()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        var start = DateTimeOffset.UtcNow.AddMinutes(-61);   // its window closed a minute ago
        var paused = new
        {
            id = "r-1", kind = "MORNING", label = "Morning break", presenceType = "BREAK", startedAt = start.ToString("o"),
            endedAt = start.AddMinutes(5).ToString("o"), inProgress = false, durationMin = 15, state = "PAUSED", timing = "ON_TIME",
            approvalStatus = "NOT_REQUIRED", segments = new[] { new { startedAt = start.ToString("o"), endedAt = start.AddMinutes(5).ToString("o") } },
        };
        h.Breaks = () => MorningOpen(start, paused);
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Host.BreakDay is not null && h.Host.State == AgentState.Running);

        Assert.Null(h.Host.BreakPanel.Paused);
        Assert.Equal(SlotState.Taken, h.Host.BreakPanel.Slots.Single(s => s.Kind == "MORNING").State);
        var refused = Assert.IsType<ActionOutcome.Refused>(await h.Host.ResumeBreakAsync());
        Assert.Equal("RESUME_WINDOW_CLOSED", refused.Code);
        Assert.Equal("Its window closed at 12:00 PM, so it can't be resumed.", refused.Message);
        Assert.DoesNotContain(h.Server.Sent, x => x.Key.EndsWith("/resume", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_quick_break_cannot_pause_and_runs_past_its_length_until_ended()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        var due = DateTimeOffset.UtcNow.AddMinutes(-3);
        h.Breaks = () => MorningOpen(due);
        var started = DateTimeOffset.UtcNow;
        h.Server.Route("POST breaks/quick/start", (_, _) =>
        {
            var r = new { id = "q-1", kind = "QUICK", label = "Quick break", presenceType = "BREAK", startedAt = started.ToString("o"), inProgress = true, plannedMin = 5, state = "ACTIVE" };
            h.Breaks = () => MorningOpen(due, activeBreak: r, quick: new object[] { new { id = "q-1", startedAt = started.ToString("o"), plannedMin = 5 } });
            return FakeServer.Ok(new { record = r });
        });
        h.Server.Route("POST breaks/end", (_, _) =>
        {
            var now = DateTimeOffset.UtcNow;
            h.Breaks = () => MorningOpen(due, quick: new object[] { new { id = "q-1", startedAt = started.ToString("o"), endedAt = now.ToString("o"), plannedMin = 5, takenSec = (int)(now - started).TotalSeconds } });
            return FakeServer.Ok(new { ended = true, record = new { id = "q-1" } });
        });
        await h.SignInAsync();

        Assert.IsType<ActionOutcome.Done>(await h.Host.QuickBreakAsync(5));
        using (var body = JsonDocument.Parse(h.Server.Sent.Last(x => x.Key == "POST breaks/quick/start").Body!))
            Assert.Equal(5, body.RootElement.GetProperty("plannedMin").GetInt32());
        var active = h.Host.BreakPanel.Active!;
        Assert.True(active.IsQuick);
        Assert.False(active.CanPause);
        Assert.Equal("NOT_PAUSABLE", Assert.IsType<ActionOutcome.Refused>(await h.Host.PauseBreakAsync()).Code);
        Assert.Equal("ON_BREAK", Assert.IsType<ActionOutcome.Refused>(await h.Host.QuickBreakAsync(10)).Code);
        Assert.IsType<EndOutcome.Ended>(await h.Host.BackToWorkAsync());
        Assert.Null(h.Host.BreakPanel.Active);
    }

    [Fact]
    public async Task Manager_screenshot_requests_are_ignored_on_a_break()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        h.PresenceStatus = "BREAK";
        await h.SignInAsync();
        Assert.Equal(AgentState.Running, h.Host.State);
        Assert.False(h.Host.OnManagerCaptureRequest());
        h.PresenceStatus = "LUNCH";
        await h.Host.RefreshPresenceAsync();
        Assert.False(h.Host.OnManagerCaptureRequest());
    }

    [Fact]
    public async Task A_window_that_closes_untaken_is_announced_once_as_auto_skipped()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        var close = DateTimeOffset.UtcNow.AddSeconds(-4);
        var materialised = false;
        string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        h.Breaks = () =>
        {
            var slot = new
            {
                kind = "MORNING", label = "Morning break", presenceType = "BREAK", durationMin = 15, allowSkip = true,
                scheduledStart = Iso(close.AddMinutes(-60)), scheduledEnd = Iso(close.AddMinutes(-45)),
                windowOpen = Iso(close.AddMinutes(-90)), windowClose = Iso(close),
                ringStart = Iso(close.AddMinutes(-61)), ringEnd = Iso(close.AddMinutes(-56)),
                local = new { start = "11:00", end = "11:15", windowOpen = "10:30", windowClose = "12:00" },
                record = materialised
                    ? new { id = "auto-1", kind = "MORNING", label = "Morning break", outcome = "AUTO_SKIPPED", startedAt = Iso(close), approvalStatus = "PENDING", needsComment = true }
                    : null,
            };
            // The server marks it the first time it is asked after the window closed.
            materialised = true;
            return new { date = HostHarness.Today, serverNow = Iso(DateTimeOffset.UtcNow), mode = "SCHEDULED", workday = true, breaks = new[] { slot } };
        };
        await h.SignInAsync();
        Assert.Equal(AgentState.Running, h.Host.State);

        // The one-second check sees the closed window and asks again.
        await HostHarness.WaitFor(() => h.AutoSkips.Count > 0);
        Assert.Equal("auto-1", Assert.Single(h.AutoSkips).Id);
        Assert.Equal(SlotState.AutoSkipped, h.Host.BreakPanel.Slots[0].State);
        await Task.Delay(1500);
        Assert.Single(h.AutoSkips);
    }

    [Fact]
    public async Task End_Day_inside_an_open_window_keeps_the_break_startable_and_stops_its_ring()
    {
        // As the real server does: End Day auto-skips an owed break whose window is still
        // open (SPEC 1.4), then the comments gate refuses. The panel must follow at once
        // (no ringing for it), without a second "auto-skipped" toast.
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        var start = DateTimeOffset.UtcNow.AddMinutes(-1);
        var skipped = false;
        string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        h.Breaks = () => new
        {
            date = HostHarness.Today, serverNow = Iso(DateTimeOffset.UtcNow), mode = "SCHEDULED", workday = true,
            breaks = new[]
            {
                new
                {
                    kind = "LUNCH", label = "Lunch break", presenceType = "LUNCH", durationMin = 30, allowSkip = false,
                    scheduledStart = Iso(start), scheduledEnd = Iso(start.AddMinutes(30)),
                    windowOpen = Iso(start.AddMinutes(-5)), windowClose = Iso(start.AddMinutes(20)),
                    ringStart = Iso(start.AddMinutes(-1)), ringEnd = Iso(start.AddMinutes(4)),
                    local = new { start = "13:00", end = "13:30", windowOpen = "12:55", windowClose = "13:20" },
                    record = skipped
                        ? new { id = "lunch-auto", kind = "LUNCH", label = "Lunch break", outcome = "AUTO_SKIPPED", startedAt = Iso(DateTimeOffset.UtcNow), approvalStatus = "PENDING", needsComment = true }
                        : null,
                },
            },
        };
        h.Server.Route("POST activity/end-day", (_, _) =>
        {
            skipped = true;
            return FakeServer.Error(409, "SKIP_COMMENTS_REQUIRED", "Add a comment to your skipped break before you end the day.",
                new { breaks = new[] { Skip("lunch-auto", "LUNCH") } });
        });
        await h.SignInAsync();
        Assert.Equal(AgentState.Running, h.Host.State);
        await HostHarness.WaitFor(() => h.Host.Ring?.Kind == "LUNCH");
        Assert.Equal(SlotState.Due, h.Host.BreakPanel.Slots[0].State);

        var blocked = Assert.IsType<EndDayOutcome.CommentsRequired>(await h.Host.EndDayAsync());
        Assert.Equal("lunch-auto", Assert.Single(blocked.Breaks).Id);
        // Read again before the answer comes back: the dialog opens over a current panel.
        // The window is still open, so the break can still be taken (the server replaces the
        // auto-skip); it is not offered as a skip and no longer rings.
        var lunch = h.Host.BreakPanel.Slots[0];
        Assert.Equal(SlotState.Due, lunch.State);
        Assert.True(lunch.CanStart);
        Assert.False(lunch.CanSkip);
        Assert.Equal("lunch-auto", lunch.PendingAutoSkip!.Id);
        Assert.Null(lunch.Record);
        Assert.Null(h.Host.BreakPanel.Ring);
        await HostHarness.WaitFor(() => h.Host.Ring is null);
        await Task.Delay(1200);
        Assert.Empty(h.AutoSkips);   // the End Day dialog asks for it; no separate toast
        Assert.Equal(AgentState.Running, h.Host.State);
    }

    // ---- A Start Day press kept across a restart ---------------------------------------------

    [Fact]
    public async Task An_offline_day_survives_a_restart_with_no_server_and_replays_with_its_time()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        DateTimeOffset pressedAt;
        using (var first = new HostHarness(HostHarness.Day("NOT_STARTED"), platform: platform))
        {
            await first.SignInAsync();
            first.Host.ImmediateWait = TimeSpan.Zero;
            first.Server.FailWith = _ => new HttpRequestException("offline");
            pressedAt = first.Host.Clock.UtcNow;
            await first.Host.StartDayAsync();
            Assert.Equal(AgentState.Running, first.Host.State);
            Assert.Equal(1, first.Host.PendingActions);
        }

        // The machine restarts with no network at all: the saved session and the day come back as they were.
        using var again = new HostHarness(HostHarness.Day("NOT_STARTED"), platform: platform);
        again.Server.FailWith = _ => new HttpRequestException("offline");
        await again.Host.StartAsync();
        await HostHarness.WaitFor(() => again.Host.State == AgentState.Running);
        Assert.Equal(1, again.Host.PendingActions);
        Assert.False(again.Host.Online);
        Assert.NotNull(again.Host.User);

        again.Server.FailWith = _ => null;
        Assert.Equal(0, await again.Host.SyncNowAsync(TimeSpan.FromSeconds(15)));
        var start = again.Server.Sent.Last(x => x.Key == "POST activity/start-day");
        Assert.InRange((DateTimeOffset.Parse(start.EventAt!) - pressedAt).Duration().TotalSeconds, 0, 2);
        Assert.Equal(AgentState.Running, again.Host.State);
        Assert.Empty(again.Nudges);   // the press stood for the greeting
    }

    // ---- Who the person is ----------------------------------------------------------------------

    [Fact]
    public async Task The_role_comes_from_the_server_when_the_saved_session_has_none()
    {
        // A 2.9.1 session (and so its sign-in) carries no role.
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        h.Server.Route("POST auth/login", (_, _) => FakeServer.Ok(
            new { user = new { id = "u-1", email = "u-1@x.test", firstName = "Asha", screenshotsEnabled = true } },
            FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        h.Server.Route("GET users/u-1", (_, _) => FakeServer.Ok(
            new { id = "u-1", email = "u-1@x.test", firstName = "Asha", lastName = "K", role = "MANAGER", screenshotsEnabled = true }));
        await h.SignInAsync();

        await HostHarness.WaitFor(() => h.Host.User?.Role == "MANAGER");
        Assert.True(h.Host.User!.IsManager);
        // Kept with the session, so the next start knows it before the server answers.
        Assert.Equal("MANAGER", new Session.SessionStore(h.Platform).Load()!.Role);
    }

    // ---- The 2.x enrollment ---------------------------------------------------------------------

    private static DevPlatform PlatformWithAppDir()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        platform.AppDir = Directory.CreateTempSubdirectory().FullName;
        return platform;
    }

    private static void CarryLegacy(DevPlatform platform, string userId) =>
        File.WriteAllText(Path.Combine(platform.AppDir, Enrollment.LegacySidecarName),
            JsonSerializer.Serialize(new { ApiBaseUrl = HostHarness.Base, EnrollmentToken = FakeServer.Jwt(userId) }));

    private static string? EnrolledAs(HostHarness h)
    {
        var body = h.Server.Calls.LastOrDefault(c => c.Path == "auth/enroll").Body;
        if (body is null) return null;
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.GetProperty("token").GetString();
    }

    [Fact]
    public async Task The_2x_enrollment_is_used_once_and_never_signs_anyone_back_in_after_sign_out()
    {
        var platform = PlatformWithAppDir();
        CarryLegacy(platform, "u-1");
        using (var h = new HostHarness(HostHarness.Day("NOT_STARTED"), platform: platform))
        {
            h.Server.Route("POST auth/enroll", (_, _) => FakeServer.Ok(FakeServer.User("u-1"), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
            h.Server.Route("POST auth/logout", (_, _) => FakeServer.Ok(new { ok = true }));
            await h.Host.StartAsync();
            Assert.Equal(AgentState.NotStarted, h.Host.State);
            Assert.Equal(FakeServer.Jwt("u-1"), EnrolledAs(h));
            Assert.False(File.Exists(Path.Combine(platform.AppDir, Enrollment.LegacySidecarName)));
            await h.Host.SignOutAsync();
        }

        // An older installer carries it across again: it is not read again.
        CarryLegacy(platform, "u-1");
        using var again = new HostHarness(HostHarness.Day("NOT_STARTED"), platform: platform);
        again.Server.Route("POST auth/enroll", (_, _) => FakeServer.Ok(FakeServer.User("u-1"), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        await again.Host.StartAsync();
        Assert.Equal(AgentState.SignIn, again.Host.State);
        Assert.False(again.Host.HasEnrollment);
        Assert.Equal(0, again.Server.Count("POST auth/enroll"));
    }

    [Fact]
    public async Task A_newer_enrollment_is_never_overridden_by_the_2x_one()
    {
        var platform = PlatformWithAppDir();
        // A setup code (or a per-user download) enrolled this machine as u-7 earlier.
        new Session.SessionStore(platform).SaveEnrollment(new EnrollmentConfig(HostHarness.Base, FakeServer.Jwt("u-7")));
        CarryLegacy(platform, "u-1");
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"), platform: platform);
        h.Server.Route("POST auth/enroll", (_, _) => FakeServer.Ok(FakeServer.User("u-1"), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        File.WriteAllText(Path.Combine(platform.DataDir, "notice-u7.txt"), "ok");

        await h.Host.StartAsync();

        Assert.Equal(FakeServer.Jwt("u-7"), EnrolledAs(h));
        Assert.False(File.Exists(Path.Combine(platform.AppDir, Enrollment.LegacySidecarName)));
        Assert.True(File.Exists(Path.Combine(platform.DataDir, "legacy-enrollment.done")));
    }

    // ---- Start-up never waits on the Keychain ----------------------------------------------------

    private sealed class HangingSecrets : ISecretStore
    {
        public readonly ManualResetEventSlim Release = new(false);
        public byte[]? Load(string key) { Release.Wait(TimeSpan.FromSeconds(30)); return null; }
        public void Save(string key, byte[] data) => Release.Wait(TimeSpan.FromSeconds(30));
        public void Delete(string key) => Release.Wait(TimeSpan.FromSeconds(30));
    }

    /// <summary>A Keychain whose every call waits for a prompt the person answers after <paramref name="delay"/>.</summary>
    private sealed class SlowSecrets : ISecretStore
    {
        private readonly ISecretStore _inner;
        private readonly TimeSpan _delay;
        public int Calls;
        public SlowSecrets(ISecretStore inner, TimeSpan delay) { _inner = inner; _delay = delay; }
        public byte[]? Load(string key) { Interlocked.Increment(ref Calls); Thread.Sleep(_delay); return _inner.Load(key); }
        public void Save(string key, byte[] data) { Interlocked.Increment(ref Calls); Thread.Sleep(_delay); _inner.Save(key, data); }
        public void Delete(string key) { Interlocked.Increment(ref Calls); Thread.Sleep(_delay); _inner.Delete(key); }
    }

    [Fact]
    public async Task A_Keychain_answered_after_the_limit_signs_in_silently_instead_of_asking_for_a_password()
    {
        // Signed in on an earlier run: the session is in the store.
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        using (var first = new HostHarness(HostHarness.Day("OPEN"), platform: platform))
        {
            await first.SignInAsync();
            Assert.Equal(AgentState.Running, first.Host.State);
        }

        // After an update the Keychain prompts on every read, and the person answers in 1.5 s.
        var slow = new SlowSecrets(platform, TimeSpan.FromMilliseconds(1500));
        platform.SecretsOverride = slow;
        using var h = new HostHarness(HostHarness.Day("OPEN"), platform: platform, secretStoreLimit: TimeSpan.FromMilliseconds(300));
        var states = new List<AgentState>();
        h.Host.StateChanged += st => { lock (states) states.Add(st); };

        var start = Stopwatch.StartNew();
        await h.Host.StartAsync();
        Assert.InRange(start.Elapsed.TotalSeconds, 0, 1.5);   // never sits at Starting
        Assert.Equal(AgentState.Connecting, h.Host.State);

        await HostHarness.WaitFor(() => h.Host.State == AgentState.Running, seconds: 20);
        Assert.Equal(0, h.Server.Count("POST auth/login"));
        Assert.DoesNotContain(AgentState.SignIn, states);
        Assert.Equal("u-1", h.Host.User!.Id);
    }

    [Fact]
    public async Task A_store_that_answered_empty_still_shows_sign_in()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName) { SecretsOverride = null };
        platform.SecretsOverride = new SlowSecrets(new DevPlatform(Directory.CreateTempSubdirectory().FullName), TimeSpan.FromMilliseconds(600));
        using var h = new HostHarness(HostHarness.Day("OPEN"), platform: platform, secretStoreLimit: TimeSpan.FromMilliseconds(200));
        await h.Host.StartAsync();
        Assert.Equal(AgentState.Connecting, h.Host.State);
        await HostHarness.WaitFor(() => h.Host.State == AgentState.SignIn, seconds: 20);
    }

    [Fact]
    public async Task A_store_that_never_answers_waits_at_Connecting_and_a_manual_sign_in_still_works()
    {
        var hanging = new HangingSecrets();
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"),
            platform: new DevPlatform(Directory.CreateTempSubdirectory().FullName) { SecretsOverride = hanging },
            secretStoreLimit: TimeSpan.FromMilliseconds(300));
        var start = h.Host.StartAsync();
        Assert.Same(start, await Task.WhenAny(start, Task.Delay(TimeSpan.FromSeconds(10))));
        Assert.Equal(AgentState.Connecting, h.Host.State);

        // Someone who knows their password need not wait for the Keychain.
        var watch = Stopwatch.StartNew();
        Assert.Null(await h.Host.SignInAsync("asha@x.test", "pw"));
        Assert.Equal(AgentState.NotStarted, h.Host.State);
        Assert.InRange(watch.Elapsed.TotalSeconds, 0, 5);
        hanging.Release.Set();
    }

    [Fact]
    public async Task Sign_out_forgets_the_day_and_a_late_answer_changes_nothing()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        await h.SignInAsync();
        var gate = new TaskCompletionSource();
        h.Server.Route("POST activity/start-day", (_, _) =>
        {
            gate.Task.Wait(TimeSpan.FromSeconds(10));
            return FakeServer.Ok(new { ok = true, date = HostHarness.Today, workday = HostHarness.Day("OPEN") });
        });
        h.Server.Route("POST auth/logout", (_, _) => FakeServer.Ok(new { ok = true }));

        // On a pool thread: the scripted server blocks until the gate opens.
        var start = Task.Run(h.Host.StartDayAsync);
        await HostHarness.WaitFor(() => h.Server.Count("POST activity/start-day") > 0);
        await h.Host.SignOutAsync();
        gate.SetResult();
        await start;

        Assert.Equal(AgentState.SignIn, h.Host.State);
        Assert.Null(h.Host.Workday);
        await Task.Delay(2300);
        Assert.Equal(0, h.Reports);
    }
}
