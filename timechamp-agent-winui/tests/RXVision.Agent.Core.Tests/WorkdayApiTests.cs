using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Approvals;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>Every 3.1 call the agent makes (SPEC 3), its request and its answers as typed outcomes.</summary>
public class WorkdayApiTests
{
    private const string Base = "https://api.example.com/api/v1";

    private static async Task<(ApiClient Api, FakeServer Server, ServerClock Clock)> SignedIn()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var server = new FakeServer();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        var clock = new ServerClock();
        var api = new ApiClient(Base, new AgentIdentity("3.1.0", "dev", "dev-1"), new SessionStore(platform.Secrets), clock, NullLog.Instance, server);
        await api.LoginAsync("a@x.test", "pw");
        return (api, server, clock);
    }

    private static JsonElement Body(FakeServer server, string methodAndPath) =>
        JsonDocument.Parse(server.Calls.Last(c => $"{c.Method} {c.Path}" == methodAndPath).Body ?? "{}").RootElement;

    private static object Skip(string id, string kind, string label) => new
    {
        id, date = "2026-10-13", kind, label, outcome = "AUTO_SKIPPED",
        skippedAt = "2026-10-13T06:30:00.000Z", scheduledStart = "2026-10-13T05:30:00.000Z", durationMin = 15, minChars = 12,
    };

    private static object Workday(string state = "OPEN") => new
    {
        date = "2026-10-13",
        serverNow = DateTimeOffset.UtcNow.ToString("o"),
        timezone = "Asia/Kolkata",
        state,
        startedAt = "2026-10-13T03:54:00.000Z",
        endedAt = (string?)null,
        autoClosed = false,
        sessions = new[] { new { startedAt = "2026-10-13T03:54:00.000Z", endedAt = (string?)null, endReason = (string?)null } },
        focus = new { focusSec = 14_700, running = true, spanSec = 16_000, breakSec = 1_300, meetingSec = 900, approvedPlusSec = 0, pendingPlusSec = 300, rejectedMinusSec = 0, pendingMinusSec = 900 },
        lateStart = new { minutes = 12 },
        shift = new { id = "s1", name = "General", start = "09:30", end = "18:30" },
        expectedSec = 28_800,
        skipsNeedingComment = new[] { Skip("b-1", "MORNING", "Morning break") },
        overdueApprovals = 2,
        endDayBlockedByOverdue = true,
        settings = new { approvalSlaHours = 48, reasonMinChars = 12 },
        portalUrl = "https://app.rxvision.shop",
    };

    // ---- History (4.0) -----------------------------------------------------------------------

    /// <summary>
    /// The month as the 4.0 server sends it (seen end to end): a day's weekday is a number,
    /// and History failed to load at all ("The server's answer was not understood").
    /// </summary>
    [Fact]
    public async Task Reads_the_month_as_the_4_0_server_sends_it()
    {
        var (api, server, _) = await SignedIn();
        server.Route("GET workday/me/history", (_, _) => FakeServer.Ok(new
        {
            month = "2026-10", isCurrent = true, workingDays = 11, elapsedWorkingDays = 1, targetSec = 217_800, targetToDateSec = 19_800,
            focusSec = 3_600, paidBreakSec = 300, unpaidBreakSec = 0, meetingsSec = 600, pendingSec = 120, projectedSec = 40_000,
            days = new object[]
            {
                new { date = "2026-10-19", weekday = 1, isWorkingDay = true, label = (string?)null, status = "OFF", startedAt = (string?)null, endedAt = (string?)null,
                    focusSec = 0, targetSec = 0, breakSec = 0, paidBreakSec = 0, unpaidBreakSec = 0, meetings = 0, meetingsSec = 0, pendingSec = 0, approvedAwaySec = 0 },
                new { date = "2026-10-20", weekday = 2, isWorkingDay = true, label = "Diwali (half day)", status = "IN_PROGRESS", startedAt = "2026-10-19T22:06:10.513Z", endedAt = (string?)null,
                    focusSec = 3_600, targetSec = 19_800, breakSec = 300, paidBreakSec = 300, unpaidBreakSec = 0, meetings = 1, meetingsSec = 600, pendingSec = 120, approvedAwaySec = 60 },
            },
            meetings = new[] { new { date = "2026-10-20", startedAt = "2026-10-19T22:30:00.000Z", durationSec = 600, agenda = "Sync", participants = new[] { new { name = "Asha" } }, momSender = "Asha", status = "PENDING" } },
            away = new[] { new { date = "2026-10-20", startedAt = "2026-10-19T22:40:00.000Z", seconds = 120, reason = "Thinking", comment = "Planning", status = "APPROVED" } },
        }));

        var result = await api.GetHistoryAsync("2026-10");
        Assert.True(result.Ok, result.ToString());
        var h = result.Data!;
        Assert.Equal(217_800, h.TargetSec);
        Assert.Equal(2, h.Days.Count);
        Assert.Equal("2", h.Days[1].Weekday);
        Assert.Equal(DayStatuses.InProgress, h.Days[1].Status);
        Assert.Equal("Diwali (half day)", h.Days[1].Label);
        Assert.Equal("Asha", Assert.Single(h.Meetings).MomSender);
        Assert.Equal("APPROVED", Assert.Single(h.Away).Status);
    }

    [Theory]
    [InlineData("""{"weekday":4}""", "4")]
    [InlineData("""{"weekday":"Thu"}""", "Thu")]
    [InlineData("""{"weekday":null}""", null)]
    [InlineData("""{"weekday":{"n":4}}""", null)]
    public void A_weekday_reads_as_text_whatever_its_type(string json, string? expected) =>
        Assert.Equal(expected, JsonSerializer.Deserialize<HistoryDay>(json, Json.Options)!.Weekday);

    // ---- Work day --------------------------------------------------------------------------

    [Fact]
    public async Task Reads_todays_work_day_and_learns_the_server_clock()
    {
        var (api, server, clock) = await SignedIn();
        server.Route("GET workday/me/today", (_, _) => FakeServer.Ok(Workday()));
        var result = await api.GetWorkdayTodayAsync();

        Assert.True(result.Ok);
        var day = result.Data!;
        Assert.True(day.IsOpen);
        Assert.Equal(14_700, day.Focus.FocusSec);
        Assert.True(day.Focus.Running);
        Assert.Equal(300, day.Focus.PendingPlusSec);
        Assert.Equal(900, day.Focus.PendingMinusSec);
        Assert.Equal(12, day.LateStart!.Minutes);
        Assert.Equal("General", day.Shift!.Name);
        var skip = Assert.Single(day.SkipsNeedingComment);
        Assert.Equal(("b-1", "AUTO_SKIPPED", 12), (skip.Id, skip.Outcome, skip.MinChars));
        Assert.Equal(2, day.OverdueApprovals);
        Assert.True(day.EndDayBlockedByOverdue);
        Assert.Equal(12, day.Settings.ReasonMinChars);
        Assert.Equal("https://app.rxvision.shop", day.PortalUrl);
        Assert.True(clock.Known);
    }

    [Fact]
    public async Task Start_Day_sends_no_time_at_first_and_the_press_time_on_a_retry()
    {
        var (api, server, _) = await SignedIn();
        server.Route("POST activity/start-day", (_, _) => FakeServer.Ok(new { ok = true, date = "2026-10-13", resumed = true, workday = Workday() }));

        var first = await api.StartDayAsync();
        Assert.Equal("{}", server.Calls.Last().Body);
        Assert.True(first.Data!.Resumed);
        Assert.True(first.Data.Workday!.IsOpen);

        var pressed = new DateTimeOffset(2026, 10, 13, 3, 32, 5, 123, TimeSpan.Zero);
        await api.StartDayAsync(pressed);
        Assert.Equal("2026-10-13T03:32:05.123Z", Body(server, "POST activity/start-day").GetProperty("startedAt").GetString());
    }

    [Fact]
    public async Task Start_Day_outcomes()
    {
        var (api, server, _) = await SignedIn();
        var workday = new WorkdayService(api, NullLog.Instance);
        var pressed = DateTimeOffset.UtcNow;

        server.Route("POST activity/start-day", (_, _) => FakeServer.Html(503));
        var pending = Assert.IsType<StartDayOutcome.Pending>(await workday.StartAsync(null, pressed));
        Assert.Equal(pressed, pending.PressedAt);

        server.Route("POST activity/start-day", (_, _) => FakeServer.Error(403, "FORBIDDEN", "Your account is disabled."));
        var refused = Assert.IsType<StartDayOutcome.Refused>(await workday.StartAsync(pressed.AddMinutes(-1), pressed));
        Assert.Equal("Your account is disabled.", refused.Message);
    }

    [Fact]
    public async Task End_Day_sends_one_comment_per_skipped_break()
    {
        var (api, server, _) = await SignedIn();
        server.Route("POST activity/end-day", (_, _) => FakeServer.Ok(new { ok = true, date = "2026-10-13", endedAt = "2026-10-13T13:01:00.000Z", workday = Workday("ENDED") }));
        var workday = new WorkdayService(api, NullLog.Instance);

        var outcome = await workday.EndAsync(new[]
        {
            new SkipComment("b-1", "  Customer escalation call ran until 12:20  "),
            new SkipComment("b-2", "Client demo ran long"),
        });

        var ended = Assert.IsType<EndDayOutcome.Ended>(outcome);
        Assert.Equal(new DateTimeOffset(2026, 10, 13, 13, 1, 0, TimeSpan.Zero), ended.EndedAt);
        var comments = Body(server, "POST activity/end-day").GetProperty("comments").EnumerateArray().ToList();
        Assert.Equal(2, comments.Count);
        Assert.Equal("b-1", comments[0].GetProperty("breakId").GetString());
        Assert.Equal("Customer escalation call ran until 12:20", comments[0].GetProperty("comment").GetString());

        await workday.EndAsync(null);
        Assert.Equal("{}", server.Calls.Last().Body);
    }

    [Fact]
    public async Task End_Day_gates_come_back_typed()
    {
        var (api, server, _) = await SignedIn();
        var workday = new WorkdayService(api, NullLog.Instance);

        server.Route("POST activity/end-day", (_, _) => FakeServer.Error(409, "SKIP_COMMENTS_REQUIRED", "Add a comment to each skipped break first.",
            new { breaks = new[] { Skip("b-1", "MORNING", "Morning break"), Skip("b-2", "LUNCH", "Lunch break"), Skip("b-3", "EVENING", "Evening break") } }));
        var comments = Assert.IsType<EndDayOutcome.CommentsRequired>(await workday.EndAsync(null));
        Assert.Equal(new[] { "b-1", "b-2", "b-3" }, comments.Breaks.Select(b => b.Id));
        Assert.Equal("Lunch break", comments.Breaks[1].Label);
        Assert.Equal(12, comments.Breaks[2].MinChars);

        server.Route("POST activity/end-day", (_, _) => FakeServer.Error(409, "APPROVALS_OVERDUE", "3 approvals are overdue.",
            new { count = 3, oldestDueAt = "2026-10-11T04:00:00.000Z" }));
        var overdue = Assert.IsType<EndDayOutcome.ApprovalsOverdue>(await workday.EndAsync(null));
        Assert.Equal(3, overdue.Count);
        Assert.Equal(new DateTimeOffset(2026, 10, 11, 4, 0, 0, TimeSpan.Zero), overdue.OldestDueAt);

        server.Route("POST activity/end-day", (_, _) => FakeServer.Error(422, "COMMENT_INVALID", "That comment is too short.", new { breakId = "b-2", problem = "TOO_SHORT", minChars = 15 }));
        var invalid = Assert.IsType<EndDayOutcome.CommentInvalid>(await workday.EndAsync(new[] { new SkipComment("b-2", "short") }));
        Assert.Equal(("b-2", (int?)15, "TOO_SHORT", true), (invalid.BreakId, invalid.MinChars, invalid.Problem, invalid.FixableByEditing));

        foreach (var problem in new[] { CommentProblems.NotFound, CommentProblems.NotYours, CommentProblems.NotASkip, CommentProblems.Duplicate })
        {
            server.Route("POST activity/end-day", (_, _) => FakeServer.Error(422, "COMMENT_INVALID", "One of the comments is for a break that cannot take it.", new { breakId = "b-9", problem }));
            var gone = Assert.IsType<EndDayOutcome.CommentInvalid>(await workday.EndAsync(new[] { new SkipComment("b-9", "A long enough comment") }));
            Assert.Equal(("b-9", (int?)null, problem, false), (gone.BreakId, gone.MinChars, gone.Problem, gone.FixableByEditing));
        }
        // An older server's answer without a problem: treated as fixable in the box.
        server.Route("POST activity/end-day", (_, _) => FakeServer.Error(422, "COMMENT_INVALID", "Too short.", new { breakId = "b-2" }));
        Assert.True(Assert.IsType<EndDayOutcome.CommentInvalid>(await workday.EndAsync(null)).FixableByEditing);

        server.Route("POST activity/end-day", (_, _) => FakeServer.Error(409, "DAY_NOT_STARTED", "There is no working day to end."));
        Assert.IsType<EndDayOutcome.NotStarted>(await workday.EndAsync(null));

        server.Route("POST activity/end-day", (_, _) => FakeServer.Html(502));
        Assert.IsType<EndDayOutcome.Offline>(await workday.EndAsync(null));
        server.FailWith = _ => new HttpRequestException("wifi");
        Assert.IsType<EndDayOutcome.Offline>(await workday.EndAsync(null));
    }

    [Fact]
    public async Task A_malformed_gate_list_still_says_comments_are_needed()
    {
        var (api, server, _) = await SignedIn();
        server.Route("POST activity/end-day", (_, _) => FakeServer.Error(409, "SKIP_COMMENTS_REQUIRED", "Comments needed.", new { breaks = "nope" }));
        var outcome = Assert.IsType<EndDayOutcome.CommentsRequired>(await new WorkdayService(api, NullLog.Instance).EndAsync(null));
        Assert.Empty(outcome.Breaks);
    }

    [Fact]
    public async Task A_refresh_that_lands_after_a_newer_answer_is_not_kept()
    {
        var (api, server, _) = await SignedIn();
        var gate = new TaskCompletionSource();
        server.Route("GET workday/me/today", (_, _) =>
        {
            gate.Task.Wait(TimeSpan.FromSeconds(10));
            return FakeServer.Ok(Workday("ENDED"));
        });
        var workday = new WorkdayService(api, NullLog.Instance);
        // On a pool thread: the scripted server blocks until the gate opens.
        var slow = Task.Run(() => workday.RefreshAsync());
        await WaitUntil(() => server.Count("GET workday/me/today") == 1);
        workday.Set(new WorkdayToday { Date = "2026-10-13", State = WorkdayStates.Open });   // Start Day's answer
        gate.SetResult();
        await slow;
        Assert.True(workday.Today!.IsOpen);
    }

    [Fact]
    public async Task Answers_that_land_after_sign_out_are_not_kept()
    {
        var (api, server, clock) = await SignedIn();
        var gate = new TaskCompletionSource();
        void Slow(string route, object data) =>
            server.Route(route, (_, _) => { gate.Task.Wait(TimeSpan.FromSeconds(10)); return FakeServer.Ok(data); });
        Slow("GET workday/me/today", Workday());
        Slow("GET approvals/me", new { items = new[] { new { type = "BREAK", id = "b-1", title = "Morning break skipped", status = "PENDING" } } });
        Slow("GET meetings/me/today", new { items = new[] { new { id = "m-1", mode = "LIVE", agenda = "Sync", inProgress = true } } });
        Slow("GET breaks/me/today", new { date = "2026-10-13", mode = "FREE", workday = true });
        var workday = new WorkdayService(api, NullLog.Instance);
        var approvals = new ApprovalService(api, NullLog.Instance);
        var meetings = new MeetingService(api, NullLog.Instance);
        var breaks = new BreakService(api, clock, NullLog.Instance);

        var asked = new Task[]
        {
            Task.Run(() => workday.RefreshAsync()), Task.Run(() => approvals.RefreshAsync()),
            Task.Run(() => meetings.RefreshAsync()), Task.Run(() => breaks.RefreshAsync()),
        };
        await WaitUntil(() => server.Calls.Count(c => c.Method == "GET") == 4);
        // Signed out while the answers were on their way: the next person must never see them.
        workday.Reset();
        approvals.Reset();
        meetings.Reset();
        breaks.Reset();
        gate.SetResult();
        await Task.WhenAll(asked);

        Assert.Null(workday.Today);
        Assert.Empty(approvals.Mine);
        Assert.Null(meetings.Live);
        Assert.Empty(meetings.Today);
        Assert.Null(breaks.Day);
    }

    [Fact]
    public async Task A_break_day_answer_overtaken_by_a_newer_one_is_not_kept()
    {
        var (api, server, clock) = await SignedIn();
        var gate = new TaskCompletionSource();
        var calls = 0;
        server.Route("GET breaks/me/today", (_, _) =>
        {
            if (Interlocked.Increment(ref calls) == 1)
            {
                gate.Task.Wait(TimeSpan.FromSeconds(10));
                return FakeServer.Ok(new { date = "2026-10-13", mode = "FREE", workday = true, dayEnded = false });
            }
            return FakeServer.Ok(new { date = "2026-10-13", mode = "FREE", workday = true, dayEnded = true });
        });
        var breaks = new BreakService(api, clock, NullLog.Instance);

        var older = Task.Run(() => breaks.RefreshAsync());
        await WaitUntil(() => server.Count("GET breaks/me/today") == 1);
        Assert.True(await breaks.RefreshAsync());   // asked later, answered first
        Assert.True(breaks.Day!.DayEnded);
        gate.SetResult();

        Assert.False(await older);
        Assert.True(breaks.Day!.DayEnded);
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        var until = DateTime.UtcNow.AddSeconds(5);
        while (!condition())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException("condition not met");
            await Task.Delay(10);
        }
    }

    // ---- Breaks ------------------------------------------------------------------------------

    [Fact]
    public async Task Skip_sends_the_kind_and_reason_and_reads_the_record()
    {
        var (api, server, _) = await SignedIn();
        server.Route("POST breaks/skip", (_, _) => FakeServer.Ok(new
        {
            record = new { id = "r-1", kind = "MORNING", label = "Morning break", outcome = "SKIPPED", reason = "Client call", approvalStatus = "PENDING", overrunSec = (int?)null, startedAt = "2026-10-13T05:29:50.000Z" },
        }));
        server.Route("GET breaks/me/today", (_, _) => FakeServer.Ok(new { date = "2026-10-13", mode = "FREE" }));
        var breaks = new BreakService(api, new ServerClock(), NullLog.Instance);

        var skipped = Assert.IsType<SkipOutcome.Skipped>(await breaks.SkipAsync("MORNING", "  Client call  "));
        Assert.Equal(("SKIPPED", 0, "Client call"), (skipped.Record!.Outcome, skipped.Record.OverrunSec, skipped.Record.Reason));
        var body = Body(server, "POST breaks/skip");
        Assert.Equal("MORNING", body.GetProperty("kind").GetString());
        Assert.Equal("Client call", body.GetProperty("reason").GetString());

        // A Super Admin skips with no reason at all.
        await breaks.SkipAsync("EVENING", null);
        Assert.False(Body(server, "POST breaks/skip").TryGetProperty("reason", out _));
    }

    [Theory]
    [InlineData("  Too   short ", "Too short")]
    [InlineData("Line one\r\n\tline two", "Line one line two")]
    [InlineData("a\u00a0\u2003b\ufeff", "a b")]
    [InlineData("   ", "")]
    [InlineData(null, "")]
    public void Reasons_and_comments_are_cleaned_as_the_server_cleans_them(string? raw, string clean) =>
        Assert.Equal(clean, ReasonText.Clean(raw));

    [Fact]
    public async Task Reasons_and_comments_go_out_as_the_server_keeps_them()
    {
        var (api, server, _) = await SignedIn();
        server.Route("POST breaks/skip", (_, _) => FakeServer.Ok(new { record = new { id = "r-1", outcome = "SKIPPED" } }));
        server.Route("POST breaks/b-1/comment", (_, _) => FakeServer.Ok(new { record = new { id = "b-1" } }));
        server.Route("POST activity/end-day", (_, _) => FakeServer.Ok(new { ok = true, date = "2026-10-13" }));
        server.Route("POST breaks/end", (_, _) => FakeServer.Ok(new { ended = true }));

        await api.SkipBreakAsync("MORNING", " Client \n  call ");
        Assert.Equal("Client call", Body(server, "POST breaks/skip").GetProperty("reason").GetString());
        await api.CommentBreakAsync("b-1", "Release   call ran\tlate");
        Assert.Equal("Release call ran late", Body(server, "POST breaks/b-1/comment").GetProperty("comment").GetString());
        await api.EndDayAsync(new[] { new SkipComment("b-1", "  Release   call ran late ") });
        Assert.Equal("Release call ran late", Body(server, "POST activity/end-day").GetProperty("comments")[0].GetProperty("comment").GetString());
        await api.EndBreakAsync("   ", askToCount: false);
        Assert.False(Body(server, "POST breaks/end").TryGetProperty("overrunReason", out _));
    }

    [Fact]
    public async Task Skip_outcomes()
    {
        var (api, server, _) = await SignedIn();
        server.Route("GET breaks/me/today", (_, _) => FakeServer.Ok(new { date = "2026-10-13", mode = "FREE" }));
        var breaks = new BreakService(api, new ServerClock(), NullLog.Instance);

        server.Route("POST breaks/skip", (_, _) => FakeServer.Error(422, "REASON_REQUIRED", "Add a reason of at least 15 characters.", new { minChars = 15 }));
        var needs = Assert.IsType<SkipOutcome.NeedsReason>(await breaks.SkipAsync("MORNING", "short"));
        Assert.Equal(15, needs.MinChars);

        foreach (var code in new[] { "SKIP_NOT_ALLOWED", "BREAK_WINDOW_CLOSED", "BREAK_ALREADY_TAKEN", "DAY_NOT_STARTED", "ALREADY_ON_BREAK" })
        {
            server.Route("POST breaks/skip", (_, _) => FakeServer.Error(409, code, $"refused: {code}"));
            var refused = Assert.IsType<SkipOutcome.Refused>(await breaks.SkipAsync("LUNCH", "Not needed today"));
            Assert.Equal(code, refused.Code);
        }

        server.Route("POST breaks/skip", (_, _) => FakeServer.Html(503));
        Assert.IsType<SkipOutcome.Offline>(await breaks.SkipAsync("MORNING", "Client call"));
    }

    [Fact]
    public async Task Comment_goes_to_the_break_and_its_answers_are_typed()
    {
        var (api, server, _) = await SignedIn();
        server.Route("GET breaks/me/today", (_, _) => FakeServer.Ok(new { date = "2026-10-13", mode = "FREE" }));
        var breaks = new BreakService(api, new ServerClock(), NullLog.Instance);

        server.Route("POST breaks/b%2F1/comment", (_, _) => FakeServer.Ok(new { record = new { id = "b/1", outcome = "AUTO_SKIPPED", reason = "Client demo ran long", needsComment = false } }));
        var saved = Assert.IsType<CommentOutcome.Saved>(await breaks.CommentAsync("b/1", " Client demo ran long "));
        Assert.False(saved.Record!.NeedsComment);
        Assert.Equal("Client demo ran long", Body(server, "POST breaks/b%2F1/comment").GetProperty("comment").GetString());

        server.Route("POST breaks/b-2/comment", (_, _) => FakeServer.Error(422, "REASON_REQUIRED", "Too short.", new { minChars = 10 }));
        Assert.Equal(10, Assert.IsType<CommentOutcome.NeedsReason>(await breaks.CommentAsync("b-2", "short")).MinChars);

        server.Route("POST breaks/b-2/comment", (_, _) => FakeServer.Error(409, "COMMENT_NOT_NEEDED", "It already has a reason."));
        Assert.IsType<CommentOutcome.NotNeeded>(await breaks.CommentAsync("b-2", "A long enough comment"));

        server.Route("POST breaks/b-2/comment", (_, _) => FakeServer.Error(403, "FORBIDDEN", "Not yours."));
        Assert.Equal("FORBIDDEN", Assert.IsType<CommentOutcome.Refused>(await breaks.CommentAsync("b-2", "A long enough comment")).Code);

        server.Route("POST breaks/b-2/comment", (_, _) => FakeServer.Error(404, "NOT_FOUND", "No such break."));
        Assert.IsType<CommentOutcome.Refused>(await breaks.CommentAsync("b-2", "A long enough comment"));

        server.FailWith = _ => new TaskCanceledException("timeout");
        Assert.IsType<CommentOutcome.Offline>(await breaks.CommentAsync("b-2", "A long enough comment"));
    }

    [Theory]
    [InlineData(true, "Queue at the canteen", true)]
    [InlineData(false, null, false)]
    public async Task Back_to_work_says_whether_to_count_the_minutes_over(bool ask, string? reason, bool expected)
    {
        var (api, server, _) = await SignedIn();
        server.Route("POST breaks/end", (_, _) => FakeServer.Ok(new { ended = true, record = new { id = "r", overrunSec = 360, overrunAsked = ask } }));
        server.Route("GET breaks/me/today", (_, _) => FakeServer.Ok(new { date = "2026-10-13", mode = "FREE" }));
        var breaks = new BreakService(api, new ServerClock(), NullLog.Instance);

        var ended = Assert.IsType<EndOutcome.Ended>(await breaks.EndAsync(reason, ask));
        Assert.Equal(expected, ended.Record!.OverrunAsked);
        var body = Body(server, "POST breaks/end");
        Assert.Equal(expected, body.GetProperty("askToCount").GetBoolean());
        Assert.Equal(reason is not null, body.TryGetProperty("overrunReason", out _));
    }

    [Fact]
    public async Task Asking_without_enough_of_a_reason_comes_back_typed()
    {
        var (api, server, _) = await SignedIn();
        server.Route("POST breaks/end", (_, _) => FakeServer.Error(422, "REASON_REQUIRED", "Add a reason.", new { minChars = 10 }));
        var breaks = new BreakService(api, new ServerClock(), NullLog.Instance);
        Assert.Equal(10, Assert.IsType<EndOutcome.NeedsReason>(await breaks.EndAsync("late", true)).MinChars);
        // Nothing asked (as before 3.1): no askToCount at all.
        await breaks.EndAsync(null);
        Assert.False(Body(server, "POST breaks/end").TryGetProperty("askToCount", out _));
    }

    [Fact]
    public async Task The_day_view_reads_skips_and_tolerates_nulls()
    {
        var (api, server, _) = await SignedIn();
        var now = DateTimeOffset.UtcNow;
        string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        server.Route("GET breaks/me/today", (_, _) => FakeServer.Ok(new
        {
            date = "2026-10-13", serverNow = Iso(now), mode = "SCHEDULED", workday = true, reasonMinChars = "12",
            shift = new { id = "s1", name = "General", start = "09:30", end = "18:30", rules = new { reasonMinChars = 12 } },
            breaks = new object[]
            {
                new
                {
                    kind = "MORNING", label = "Morning break", presenceType = "BREAK", durationMin = 15, allowSkip = true,
                    scheduledStart = Iso(now.AddHours(-2)), scheduledEnd = Iso(now.AddHours(-2).AddMinutes(15)),
                    windowOpen = Iso(now.AddHours(-2.5)), windowClose = Iso(now.AddHours(-1)),
                    ringStart = Iso(now.AddHours(-2).AddMinutes(-1)), ringEnd = Iso(now.AddHours(-2).AddMinutes(4)),
                    local = new { start = "11:00", end = "11:15", windowOpen = "10:30", windowClose = "12:00" },
                    record = new
                    {
                        id = "auto-1", kind = "MORNING", label = "Morning break", outcome = "AUTO_SKIPPED", startedAt = Iso(now.AddHours(-1)),
                        overrunSec = (int?)null, tookSec = (int?)null, reason = (string?)null, approvalStatus = "PENDING", needsComment = true,
                        dueAt = Iso(now.AddHours(47)),
                    },
                },
                new
                {
                    kind = "LUNCH", label = "Lunch break", presenceType = "LUNCH", durationMin = 30,
                    scheduledStart = Iso(now.AddHours(1)), scheduledEnd = Iso(now.AddHours(1.5)),
                    windowOpen = Iso(now.AddHours(0.5)), windowClose = Iso(now.AddHours(2)),
                    ringStart = Iso(now.AddHours(1).AddMinutes(-1)), ringEnd = Iso(now.AddHours(1).AddMinutes(4)),
                    local = new { start = "13:00" },
                },
            },
            skipsNeedingComment = new[] { Skip("auto-1", "MORNING", "Morning break") },
        }));
        var breaks = new BreakService(api, new ServerClock(), NullLog.Instance);
        var announced = new List<BreakRecord>();
        breaks.AutoSkipped += r => announced.Add(r);

        Assert.True(await breaks.RefreshAsync());
        var panel = breaks.Panel();
        Assert.Equal(12, panel.MinChars);
        Assert.Equal(SlotState.AutoSkipped, panel.Slots[0].State);
        Assert.True(panel.Slots[0].Record!.NeedsComment);
        Assert.Equal(0, panel.Slots[0].Record!.OverrunSec);
        Assert.True(panel.Slots[0].AllowSkip);
        Assert.False(panel.Slots[1].AllowSkip);
        Assert.Single(breaks.Day!.SkipsNeedingComment);
        Assert.Equal("auto-1", Assert.Single(announced).Id);

        // Announced once, however often the day is read again.
        Assert.True(await breaks.RefreshAsync());
        Assert.Single(announced);
    }

    [Fact]
    public void Skips_can_happen_only_while_the_window_is_open_and_allowed()
    {
        static DateTimeOffset Ist(string hm) => DateTimeOffset.Parse($"2026-10-13T{hm}:00+05:30");
        BreakSlot Slot(string kind, string start, bool allow) => new()
        {
            Kind = kind, Label = kind, PresenceType = kind == "LUNCH" ? "LUNCH" : "BREAK", DurationMin = 15, AllowSkip = allow,
            ScheduledStart = Ist(start), WindowOpen = Ist(start).AddMinutes(-30), WindowClose = Ist(start).AddMinutes(60),
            RingStart = Ist(start).AddMinutes(-1), RingEnd = Ist(start).AddMinutes(4),
        };
        var day = new BreakDay { Date = "2026-10-13", Mode = "SCHEDULED", Workday = true, Shift = new ShiftInfo { Rules = new ShiftRules() },
            Breaks = { Slot("MORNING", "11:00", true), Slot("LUNCH", "13:00", false), Slot("EVENING", "16:00", true) } };

        Assert.False(BreakSchedule.Compute(day, Ist("10:20")).Slots[0].CanSkip);     // not open yet
        Assert.True(BreakSchedule.Compute(day, Ist("10:59")).Slots[0].CanSkip);      // due
        Assert.True(BreakSchedule.Compute(day, Ist("11:30")).Slots[0].CanSkip);      // late
        Assert.False(BreakSchedule.Compute(day, Ist("13:00")).Slots[1].CanSkip);     // lunch: not allowed
        Assert.False(BreakSchedule.Compute(day, Ist("12:10")).Slots[0].CanSkip);     // closed

        // A skip is a record, but it does not close the earlier breaks the way a taken one does.
        day.Breaks[2].Record = new BreakRecord { Id = "e", Kind = "EVENING", Outcome = BreakOutcomes.Skipped };
        day.Breaks[0].WindowClose = Ist("17:00");
        var panel = BreakSchedule.Compute(day, Ist("16:10"));
        Assert.Equal(SlotState.Skipped, panel.Slots[2].State);
        Assert.Equal(SlotState.OpenLate, panel.Slots[0].State);
        Assert.Null(panel.Ring);

        day.DayEnded = true;
        Assert.False(BreakSchedule.Compute(day, Ist("16:10")).Slots[0].CanSkip);
    }

    // ---- Meetings ------------------------------------------------------------------------------

    [Fact]
    public async Task Start_meeting_sends_the_agenda_and_clean_participants()
    {
        var (api, server, _) = await SignedIn();
        server.Route("POST meetings/start", (_, _) => FakeServer.Ok(new
        {
            meeting = new { id = "m-1", mode = "LIVE", agenda = "Sprint review", participants = new object[] { new { id = "u-2", name = "Maya Reddy" }, new { name = "Vikram, Pune" } }, startedAt = "2026-10-13T06:00:00.000Z", inProgress = true, durationSec = 5, approvalStatus = "PENDING" },
            presence = new { status = "MEETING" },
        }));
        var meetings = new MeetingService(api, NullLog.Instance);
        var people = new List<MeetingParticipant> { new("u-2", " Maya Reddy "), new(null, "Vikram, Pune"), new(null, "   "), new("", new string('x', 90)) };
        people.AddRange(Enumerable.Range(0, 40).Select(i => new MeetingParticipant(null, $"Guest {i}")));

        var started = Assert.IsType<MeetingOutcome.Started>(await meetings.StartAsync("  Sprint review ", people));
        Assert.Equal("m-1", started.Meeting!.Id);
        Assert.Equal("m-1", meetings.Live!.Id);

        var body = Body(server, "POST meetings/start");
        Assert.Equal("Sprint review", body.GetProperty("agenda").GetString());
        var sent = body.GetProperty("participants").EnumerateArray().ToList();
        Assert.Equal(30, sent.Count);
        Assert.Equal("u-2", sent[0].GetProperty("id").GetString());
        Assert.Equal("Maya Reddy", sent[0].GetProperty("name").GetString());
        Assert.False(sent[1].TryGetProperty("id", out _));
        Assert.Equal(80, sent[2].GetProperty("name").GetString()!.Length);
    }

    [Fact]
    public async Task Start_meeting_refusals_and_validation_are_typed()
    {
        var (api, server, _) = await SignedIn();
        var meetings = new MeetingService(api, NullLog.Instance);

        server.Route("POST meetings/start", (_, _) => FakeServer.Error(409, "ON_BREAK", "You're on a break."));
        Assert.Equal("ON_BREAK", Assert.IsType<MeetingOutcome.Refused>(await meetings.StartAsync("Sync", Array.Empty<MeetingParticipant>())).Code);

        server.Route("POST meetings/start", (_, _) => FakeServer.Error(409, "MEETING_IN_PROGRESS", "Already in a meeting."));
        Assert.Equal("MEETING_IN_PROGRESS", Assert.IsType<MeetingOutcome.Refused>(await meetings.StartAsync("Sync", Array.Empty<MeetingParticipant>())).Code);

        server.Route("POST meetings/start", (_, _) => FakeServer.Error(400, "VALIDATION_ERROR", "agenda must be shorter than or equal to 300 characters"));
        Assert.Equal("VALIDATION_ERROR", Assert.IsType<MeetingOutcome.Invalid>(await meetings.StartAsync(new string('a', 301), Array.Empty<MeetingParticipant>())).Code);

        server.Route("POST meetings/start", (_, _) => FakeServer.Html(504));
        Assert.IsType<MeetingOutcome.Offline>(await meetings.StartAsync("Sync", Array.Empty<MeetingParticipant>()));
    }

    [Fact]
    public async Task A_past_meeting_carries_its_time_and_an_overlap_comes_back_with_what_it_hits()
    {
        var (api, server, _) = await SignedIn();
        server.Route("GET meetings/me/today", (_, _) => FakeServer.Ok(new { items = Array.Empty<object>() }));
        server.Route("POST meetings/past", (_, _) => FakeServer.Error(422, "MEETING_OVERLAPS_BREAK", "That overlaps your lunch.",
            new { with = new { kind = "LUNCH", startedAt = "2026-10-13T07:30:00.000Z", endedAt = "2026-10-13T08:00:00.000Z" } }));
        var meetings = new MeetingService(api, NullLog.Instance);
        var at = new DateTimeOffset(2026, 10, 13, 7, 15, 0, TimeSpan.Zero);

        var invalid = Assert.IsType<MeetingOutcome.Invalid>(await meetings.LogPastAsync(at, 30, "Daily stand-up", new[] { new MeetingParticipant(null, "Kavya R") }));
        Assert.Equal("MEETING_OVERLAPS_BREAK", invalid.Code);
        Assert.Equal("LUNCH", invalid.With!.Kind);
        Assert.Equal(new DateTimeOffset(2026, 10, 13, 8, 0, 0, TimeSpan.Zero), invalid.With.EndedAt);
        var body = Body(server, "POST meetings/past");
        Assert.Equal("2026-10-13T07:15:00.000Z", body.GetProperty("startedAt").GetString());
        Assert.Equal(30, body.GetProperty("durationMin").GetInt32());

        foreach (var code in new[] { "MEETING_OUTSIDE_DAY", "MEETING_IN_FUTURE", "MEETING_OVERLAPS_MEETING" })
        {
            server.Route("POST meetings/past", (_, _) => FakeServer.Error(422, code, code));
            Assert.Equal(code, Assert.IsType<MeetingOutcome.Invalid>(await meetings.LogPastAsync(at, 15, "x", Array.Empty<MeetingParticipant>())).Code);
        }
        server.Route("POST meetings/past", (_, _) => FakeServer.Error(409, "DAY_NOT_STARTED", "Start your day first."));
        Assert.IsType<MeetingOutcome.Refused>(await meetings.LogPastAsync(at, 15, "x", Array.Empty<MeetingParticipant>()));

        server.Route("POST meetings/past", (_, _) => FakeServer.Ok(new { meeting = new { id = "p-1", mode = "PAST", durationSec = 900 } }));
        Assert.Equal("p-1", Assert.IsType<MeetingOutcome.Logged>(await meetings.LogPastAsync(at, 15, "x", Array.Empty<MeetingParticipant>())).Meeting!.Id);
    }

    [Fact]
    public async Task Meeting_ended_ends_the_live_record_and_says_when_it_was_too_short()
    {
        var (api, server, _) = await SignedIn();
        var live = true;
        server.Route("GET meetings/me/today", (_, _) => FakeServer.Ok(new
        {
            items = live
                ? new object[] { new { id = "m-9", mode = "LIVE", agenda = "Pune sync", inProgress = true, startedAt = "2026-10-13T06:00:00.000Z" } }
                : Array.Empty<object>(),
        }));
        server.Route("POST meetings/m-9/end", (_, _) => { live = false; return FakeServer.Ok(new { meeting = (object?)null, discarded = true }); });
        var meetings = new MeetingService(api, NullLog.Instance);

        Assert.True(await meetings.RefreshAsync());
        Assert.Equal("Pune sync", meetings.Live!.Agenda);
        var ended = Assert.IsType<EndOutcome.MeetingEnded>(await meetings.EndAsync());
        Assert.True(ended.Discarded);
        Assert.Null(meetings.Live);

        // A meeting with no record (an older agent started it): the plain way.
        server.Route("POST presence/end", (_, _) => FakeServer.Ok(new { status = "WORKING" }));
        Assert.IsType<EndOutcome.MeetingEnded>(await meetings.EndAsync());
        Assert.Equal(1, server.Count("POST presence/end"));
    }

    [Fact]
    public async Task Participants_are_searched_by_name()
    {
        var (api, server, _) = await SignedIn();
        server.Route("GET meetings/participants", (req, _) => FakeServer.Ok(new
        {
            items = new[] { new { id = "u-2", name = "Maya Reddy", department = (string?)"Ops" }, new { id = "u-3", name = "", department = (string?)null } },
        }));
        var meetings = new MeetingService(api, NullLog.Instance);
        var found = await meetings.SearchAsync("may a&b");
        Assert.Equal("Maya Reddy", Assert.Single(found!).Name);

        server.FailWith = _ => new HttpRequestException("offline");
        Assert.Null(await meetings.SearchAsync("x"));
    }

    // ---- Approvals --------------------------------------------------------------------------------

    [Fact]
    public async Task The_waiting_list_reads_my_items_with_their_effect()
    {
        var (api, server, _) = await SignedIn();
        server.Route("GET approvals/me", (_, _) => FakeServer.Ok(new
        {
            items = new object[]
            {
                new { type = "BREAK", id = "b-1", category = "BREAK_SKIP", title = "Morning break skipped", status = "PENDING",
                      effect = new { mode = "MINUS", minutes = 15, text = "−15 min if rejected" }, dueAt = "2026-10-15T05:00:00.000Z" },
                new { type = "MEETING", id = "m-1", category = "MEETING_PAST", title = "Meeting: Daily stand-up", status = "APPROVED",
                      effect = new { mode = "NONE", minutes = 0, text = "Counted as focus time" }, decidedAt = "2026-10-13T08:00:00.000Z", decidedByName = "Maya Reddy" },
            },
        }));
        var approvals = new ApprovalService(api, NullLog.Instance);
        Assert.True(await approvals.RefreshAsync());
        Assert.Equal(2, approvals.Mine.Count);
        Assert.True(approvals.Mine[0].IsPending);
        Assert.Equal("−15 min if rejected", approvals.Mine[0].Effect.Text);
        Assert.Equal("Maya Reddy", approvals.Mine[1].DecidedByName);
        Assert.Contains(server.Calls, c => c.Path == "approvals/me");
    }

    [Fact]
    public async Task The_waiting_list_asks_for_seven_days()
    {
        var (api, server, _) = await SignedIn();
        string? query = null;
        server.Route("GET approvals/me", (req, _) => { query = req.RequestUri!.Query; return FakeServer.Ok(new { items = Array.Empty<object>() }); });
        await api.GetMyApprovalsAsync();
        Assert.Equal("?days=7", query);
        await api.GetMyApprovalsAsync(90);
        Assert.Equal("?days=31", query);
    }

    // ---- Focus time and the desk nudge -----------------------------------------------------------

    [Fact]
    public void Focus_ticks_while_running_and_stops_at_a_break()
    {
        var serverNow = new DateTimeOffset(2026, 10, 13, 5, 0, 0, TimeSpan.Zero);
        var day = new WorkdayToday { ServerNow = serverNow, Focus = new FocusView { FocusSec = 3600, Running = true } };
        Assert.Equal(3600, FocusClock.At(day, serverNow));
        Assert.Equal(3600 + 90, FocusClock.At(day, serverNow.AddSeconds(90)));
        // A break that began 60 s after the answer freezes it there.
        Assert.Equal(3600 + 60, FocusClock.At(day, serverNow.AddMinutes(10), pausedSince: serverNow.AddSeconds(60)));
        // Paused before the answer: the server's number already knew.
        Assert.Equal(3600, FocusClock.At(day, serverNow.AddMinutes(10), pausedSince: serverNow.AddMinutes(-1)));
        // Not running (on a break, ended, not started): it stands still.
        day.Focus.Running = false;
        Assert.Equal(3600, FocusClock.At(day, serverNow.AddHours(1)));
        Assert.Equal(0, FocusClock.At(null, serverNow));
        // A clock behind the server's answer never counts backwards.
        day.Focus.Running = true;
        Assert.Equal(3600, FocusClock.At(day, serverNow.AddMinutes(-3)));
    }

    [Fact]
    public void At_the_desk_for_five_minutes_nudges_at_most_hourly()
    {
        var nudge = new DeskNudge();
        var t = new DateTimeOffset(2026, 10, 13, 3, 0, 0, TimeSpan.Zero);
        var fired = new List<DateTimeOffset>();
        void Sample(TimeSpan idle, bool locked = false)
        {
            if (nudge.Observe(t, idle, locked)) fired.Add(t);
            t = t.AddSeconds(30);
        }

        for (var i = 0; i < 9; i++) Sample(TimeSpan.FromSeconds(5));   // 4.5 minutes of input
        Assert.Empty(fired);
        Sample(TimeSpan.FromSeconds(5));                                  // 5 minutes
        Sample(TimeSpan.FromSeconds(5));
        Assert.Single(fired);

        for (var i = 0; i < 40; i++) Sample(TimeSpan.FromSeconds(5));     // 20 more minutes at the desk: once an hour
        Assert.Single(fired);

        t = fired[0].AddMinutes(61);
        for (var i = 0; i < 12; i++) Sample(TimeSpan.FromSeconds(5));
        Assert.Equal(2, fired.Count);
    }

    [Fact]
    public void A_pause_or_a_locked_screen_starts_the_count_over()
    {
        var nudge = new DeskNudge();
        var t = new DateTimeOffset(2026, 10, 13, 3, 0, 0, TimeSpan.Zero);
        for (var i = 0; i < 8; i++) { Assert.False(nudge.Observe(t, TimeSpan.FromSeconds(3), false)); t = t.AddSeconds(30); }
        Assert.False(nudge.Observe(t, TimeSpan.FromSeconds(90), false));   // a minute and a half away
        t = t.AddSeconds(30);
        for (var i = 0; i < 8; i++) { Assert.False(nudge.Observe(t, TimeSpan.FromSeconds(3), false)); t = t.AddSeconds(30); }
        Assert.False(nudge.Observe(t, TimeSpan.Zero, locked: true));
        // The greeting counts toward the hour.
        nudge.Shown(t);
        for (var i = 0; i < 20; i++) { Assert.False(nudge.Observe(t, TimeSpan.FromSeconds(3), false)); t = t.AddSeconds(30); }
    }
}
