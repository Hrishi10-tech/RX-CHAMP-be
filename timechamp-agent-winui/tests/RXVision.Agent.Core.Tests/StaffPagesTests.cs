using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Workday;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>The late start's note (3.2) as the 4.0 agent judges it before recording Start Day.</summary>
public class LateStartRuleTests
{
    private static readonly TimeSpan Ist = TimeSpan.FromHours(5.5);
    private static DateTimeOffset At(string hm) => new(2026, 10, 13, int.Parse(hm[..2]), int.Parse(hm[3..]), 0, Ist);

    private static WorkdayToday Day(string shiftStart = "09:30", int grace = 10, bool required = true) => new()
    {
        Date = "2026-10-13",
        State = WorkdayStates.NotStarted,
        Shift = new ShiftRef { Id = "s-1", Name = "General", Start = shiftStart, End = "18:30" },
        IsWorkingDay = true,
        Settings = new WorkdaySettings { ReasonMinChars = 10, LateStartGraceMin = grace, RequireLateStartReason = required },
    };

    private static StartDayOutcome.NeedsLateReason? Check(WorkdayToday day, string now, string role = "USER") =>
        LateStartRule.Check(day, role, At(now), "2026-10-13", Ist, new[] { "Traffic" }, t => t.ToOffset(Ist).ToString("h:mm tt", System.Globalization.CultureInfo.InvariantCulture));

    [Fact]
    public void Past_the_grace_it_asks_with_the_minutes_the_mark_and_the_quick_answers()
    {
        var needs = Check(Day(), "10:02");
        Assert.NotNull(needs);
        Assert.Equal(32, needs!.MinutesLate);
        Assert.Equal(At("09:30"), needs.ShiftStart);
        Assert.Equal(10, needs.MinChars);
        Assert.Equal(new[] { "Traffic" }, needs.Presets);
        Assert.Equal("You're starting 32 minutes after your shift start (9:30 AM). Say why (at least 10 characters).", needs.Message);
    }

    [Fact]
    public void Within_the_grace_or_when_nobody_asks_it_does_not()
    {
        Assert.Null(Check(Day(), "09:40"));                       // 10 min: within the grace
        Assert.Null(Check(Day(required: false), "11:00"));        // the organisation does not ask
        Assert.Null(Check(Day(), "11:00", role: "ADMIN"));        // nobody approves an admin's day
        Assert.Null(Check(Day(), "11:00", role: "SUPER_MANAGER"));
    }

    [Fact]
    public void A_day_off_leave_a_biometric_day_or_a_day_already_started_never_asks()
    {
        var off = Day(); off.IsWorkingDay = false;
        Assert.Null(Check(off, "11:00"));
        var leave = Day(); leave.Leave = new LeaveTodayView { Full = true, Days = 1 };
        Assert.Null(Check(leave, "11:00"));
        var biometric = Day(); biometric.Attendance = new AttendanceView { Source = AttendanceSources.Biometric };
        Assert.Null(Check(biometric, "11:00"));
        var started = Day(); started.Sessions.Add(new WorkSessionView());
        Assert.Null(Check(started, "11:00"));
        // Yesterday's day says nothing about today's shift.
        var old = Day(); old.Date = "2026-10-12";
        Assert.Null(Check(old, "11:00"));
    }

    [Fact]
    public void Leave_at_the_start_of_the_day_moves_the_mark()
    {
        var day = Day();
        day.WorkingFrom = At("14:00");
        Assert.Null(Check(day, "14:05"));
        Assert.Equal(20, Check(day, "14:20")!.MinutesLate);
    }

    [Fact]
    public void The_servers_422_becomes_the_same_question()
    {
        var details = JsonDocument.Parse("""{"minutesLate":32,"shiftStart":"2026-10-13T04:00:00.000Z","minChars":12,"maxChars":500,"presets":["Traffic","Doctor"]}""").RootElement;
        var result = new ApiResult<JsonElement> { Outcome = ApiOutcome.Rejected, Status = 422, Code = "LATE_REASON_REQUIRED", Message = "Say why.", Details = details };
        var needs = LateStartRule.FromRefusal(result)!;
        Assert.Equal((32, 12, "Say why."), (needs.MinutesLate, needs.MinChars, needs.Message));
        Assert.Equal(new[] { "Traffic", "Doctor" }, needs.Presets);
        Assert.Equal(At("09:30"), needs.ShiftStart);
        Assert.Null(LateStartRule.FromRefusal(new ApiResult<JsonElement> { Outcome = ApiOutcome.Rejected, Code = "FORBIDDEN" }));
    }
}

/// <summary>My calendar from the 4.0 person year.</summary>
public class CalendarYearTests
{
    [Fact]
    public void Days_off_set_on_the_calendar_are_holidays_the_rest_weekly_offs()
    {
        var year = new PersonYear
        {
            UserId = "u-1", Year = 2026, Source = "DEPARTMENT", SourceLabel = "Their department's calendar",
            Days =
            {
                new PersonYearDay { Date = "2026-01-02", Working = true, Source = "DEPARTMENT" },
                new PersonYearDay { Date = "2026-01-01", Working = false, Label = "New Year", Source = "OVERRIDE" },
                new PersonYearDay { Date = "2026-01-04", Working = false, Source = "DEPARTMENT" },
                new PersonYearDay { Date = "2026-01-26", Working = false, Source = "OVERRIDE" },
                new PersonYearDay { Date = "2026-01-10", Working = true, Label = "Worked Saturday", Source = "OVERRIDE" },
            },
        };
        var view = CalendarYear.From(year, "2026-01-02");
        Assert.Equal("Your department's calendar", view.Summary);
        Assert.Equal("2026-01-01", view.Days[0].Date);
        Assert.Equal(new[] { CalendarKinds.Holiday, CalendarKinds.Working, CalendarKinds.WeeklyOff, CalendarKinds.Working, CalendarKinds.Holiday }, view.Days.Select(d => d.Kind));
        Assert.Equal((2, 1, 2), (view.Totals.Working, view.Totals.WeeklyOff, view.Totals.Holidays));
        Assert.Equal(new[] { "New Year", "Holiday" }, view.Holidays.Select(h => h.Label));
        Assert.Equal("Your own calendar", CalendarYear.From(new PersonYear { Source = "PERSON" }, "").Summary);
    }
}

/// <summary>The staff pages and the late note through the agent core, against a scripted 4.0 server.</summary>
public class StaffPagesHostTests
{
    private static object LateDay() => new
    {
        date = HostHarness.Today,
        serverNow = DateTimeOffset.UtcNow.ToString("o"),
        timezone = "Asia/Kolkata",
        state = "NOT_STARTED",
        focus = new { focusSec = 0, running = false },
        expectedSec = 28_800,
        skipsNeedingComment = Array.Empty<object>(),
        // A shift that started at midnight with no grace: any start now is late.
        shift = new { id = "s-1", name = "General", start = "00:00", end = "23:59" },
        isWorkingDay = true,
        settings = new { approvalSlaHours = 48, reasonMinChars = 10, lateStartGraceMin = 0, requireLateStartReason = true },
    };

    [Fact]
    public async Task A_late_start_asks_for_its_note_before_anything_is_recorded_then_sends_it()
    {
        using var h = new HostHarness(LateDay());
        h.Breaks = () => new { date = HostHarness.Today, mode = "FREE", workday = true, reasonPresets = new Dictionary<string, string[]> { ["LATE_DAY_START"] = new[] { "Traffic" } } };
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Host.Presets(PresetKinds.LateDayStart).Count > 0);

        var asked = Assert.IsType<StartDayOutcome.NeedsLateReason>(await h.Host.StartDayAsync());
        Assert.Equal(new[] { "Traffic" }, asked.Presets);
        Assert.Equal(AgentState.NotStarted, h.Host.State);
        Assert.Equal(0, h.Host.PendingActions);
        Assert.Equal(0, h.Server.Count("POST activity/start-day"));

        Assert.IsType<StartDayOutcome.Started>(await h.Host.StartDayAsync("Traffic"));
        Assert.Equal(AgentState.Running, h.Host.State);
        await HostHarness.WaitFor(() => h.Server.Count("POST activity/start-day") > 0);
        var sent = h.Server.Sent.First(x => x.Key == "POST activity/start-day");
        using var body = JsonDocument.Parse(sent.Body!);
        Assert.Equal("Traffic", body.RootElement.GetProperty("lateReason").GetString());
    }

    [Fact]
    public async Task The_servers_LATE_REASON_REQUIRED_comes_back_as_the_question_and_leaves_the_day_not_started()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        await h.SignInAsync();
        h.Server.Route("POST activity/start-day", (_, body) => body!.Contains("lateReason")
            ? Accept()
            : FakeServer.Error(422, "LATE_REASON_REQUIRED", "You're starting 40 minutes after your shift start (9:30 AM). Say why.",
                new { minutesLate = 40, minChars = 10, maxChars = 500, presets = new[] { "Traffic" } }));

        var asked = Assert.IsType<StartDayOutcome.NeedsLateReason>(await h.Host.StartDayAsync());
        Assert.Equal(40, asked.MinutesLate);
        Assert.Equal(new[] { "Traffic" }, asked.Presets);
        await HostHarness.WaitFor(() => h.Host.State == AgentState.NotStarted && h.Host.PendingActions == 0);

        Assert.IsType<StartDayOutcome.Started>(await h.Host.StartDayAsync("Traffic jam on the ring road"));
        await HostHarness.WaitFor(() => h.Host.State == AgentState.Running && h.Host.PendingActions == 0);
        using var sent = JsonDocument.Parse(h.Server.Sent.Last(x => x.Key == "POST activity/start-day").Body!);
        Assert.Equal("Traffic jam on the ring road", sent.RootElement.GetProperty("lateReason").GetString());

        HttpResponseMessage Accept()
        {
            h.Workday = () => FakeServer.Ok(HostHarness.Day("OPEN"));
            return FakeServer.Ok(new { ok = true, date = HostHarness.Today, workday = HostHarness.Day("OPEN") });
        }
    }

    [Fact]
    public async Task A_biometric_refusal_hides_the_day_buttons_for_the_session()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        await h.SignInAsync();
        Assert.False(h.Host.IsBiometric);
        h.Server.Route("POST activity/start-day", (_, _) => FakeServer.Error(409, "ATTENDANCE_BY_BIOMETRIC", "Your attendance is recorded by the biometric device."));
        var refused = Assert.IsType<StartDayOutcome.Refused>(await h.Host.StartDayAsync());
        Assert.Equal("ATTENDANCE_BY_BIOMETRIC", refused.Code);
        Assert.True(h.Host.IsBiometric);
    }

    [Fact]
    public async Task The_guide_is_read_and_kept_for_offline()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        h.Server.Route("GET workday/guide", (_, _) => FakeServer.Ok(new { items = new[] { new { n = 1, title = "Start your day", body = "Press Start Day." } }, numbers = new { } }));
        await h.SignInAsync();
        var (guide, fresh) = await h.Host.GetGuideAsync();
        Assert.True(fresh);
        Assert.Equal("Start your day", Assert.Single(guide!.Items).Title);

        h.Server.Route("GET workday/guide", (_, _) => FakeServer.Html(503));
        (guide, fresh) = await h.Host.GetGuideAsync();
        Assert.False(fresh);
        Assert.Equal("Press Start Day.", Assert.Single(guide!.Items).Body);
    }

    [Fact]
    public async Task My_calendar_reads_the_persons_own_year()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        string? query = null;
        h.Server.Route("GET calendar/people/u-1/year", (req, _) =>
        {
            query = req.RequestUri!.Query;
            return FakeServer.Ok(new
            {
                userId = "u-1", year = 2027, source = "ORGANISATION", sourceLabel = "The organisation's week", workingDays = 1,
                days = new object[]
                {
                    new { date = "2027-01-01", working = false, label = "New Year", source = "OVERRIDE" },
                    new { date = "2027-01-04", working = true, label = (string?)null, source = "ORGANISATION" },
                },
            });
        });
        await h.SignInAsync();
        var result = await h.Host.GetCalendarAsync(2027);
        Assert.True(result.Ok);
        Assert.Equal("?year=2027", query);
        Assert.Equal("Your organisation's week", result.Data!.Summary);
        Assert.Equal(1, result.Data.Totals.Holidays);
        Assert.Equal("New Year", Assert.Single(result.Data.Holidays).Label);
    }

    [Fact]
    public async Task Leave_is_read_previewed_requested_and_cancelled_on_the_4_0_routes()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        h.Server.Route("GET leave/me", (_, _) => FakeServer.Ok(new
        {
            today = HostHarness.Today, year = 2026, waitingFor = "Maya Reddy",
            policy = new { enabled = true, elplNoticeDays = 5, categories = new[] { new { category = "CLSL", label = "CL/SL", rule = "Any day." } }, kinds = new[] { new { kind = "FULL_DAY", label = "Full day", parts = Array.Empty<object>() } } },
            balances = new[] { new { category = "CLSL", label = "CL/SL", grantedDays = 12, availableDays = 10.5 } },
            upcoming = Array.Empty<object>(), requests = Array.Empty<object>(),
            compOff = new { enabled = true, availableDays = 1.5, pendingDays = 0, takenDays = 0, nextExpiry = (object?)null },
        }));
        h.Server.Route("POST leave/preview", (_, _) => FakeServer.Ok(new { ok = true, daysLabel = "1 day", dates = Array.Empty<object>(), approvedAtOnce = false }));
        h.Server.Route("POST leave/requests", (_, _) => FakeServer.Ok(new { id = "lr-1", span = "Mon 9 Nov", status = "PENDING", waitingFor = "Maya Reddy" }));
        h.Server.Route("POST leave/requests/lr-1/cancel", (_, _) => FakeServer.Ok(new { id = "lr-1", status = "CANCELLED" }));
        await h.SignInAsync();
        var changes = 0;
        h.Host.LeaveChanged += () => Interlocked.Increment(ref changes);

        var mine = await h.Host.GetMyLeaveAsync();
        Assert.Equal(10.5, Assert.Single(mine.Data!.Balances).AvailableDays);
        Assert.Equal(1.5, mine.Data.CompOff!.AvailableDays);
        var body = new LeaveRequestBody { Category = "CLSL", Kind = "FULL_DAY", StartDate = "2026-11-09", Reason = "Family function" };
        Assert.True((await h.Host.PreviewLeaveAsync(body)).Data!.Ok);
        Assert.Equal("lr-1", (await h.Host.RequestLeaveAsync(body)).Data!.Id);
        Assert.Equal("CANCELLED", (await h.Host.CancelLeaveAsync("lr-1")).Data!.Status);
        Assert.Equal(2, changes);
        using var sent = JsonDocument.Parse(h.Server.Sent.Last(x => x.Key == "POST leave/requests").Body!);
        Assert.Equal("Family function", sent.RootElement.GetProperty("reason").GetString());
    }

    [Fact]
    public async Task A_late_note_is_added_on_its_own_route()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        h.Server.Route("POST workday/me/late-reason", (_, _) => FakeServer.Ok(new { ok = true }));
        await h.SignInAsync();
        Assert.True((await h.Host.AddLateReasonAsync("  Traffic   jam ")).Ok);
        using var sent = JsonDocument.Parse(h.Server.Sent.Last(x => x.Key == "POST workday/me/late-reason").Body!);
        Assert.Equal("Traffic jam", sent.RootElement.GetProperty("reason").GetString());
    }
}
