using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using Xunit;

namespace RXVision.Agent.UI.Tests;

// Ported from the vendor's 3.6 Agent35Tests: what 3.2 to 3.5 added that staff see (the day's
// notes, biometric staff, the late note, Leave, My calendar, the organisation's guide), on 4.0.

/// <summary>The day's notes, biometric staff and the late start's note.</summary>
public class DayNotesTests
{
    private static (DashboardViewModel Vm, FakeAgent Agent, FakeDialogs Dialogs) Dashboard(string now = "10:20")
    {
        var agent = new FakeAgent(now);
        var dialogs = new FakeDialogs();
        var vm = new DashboardViewModel(agent, new BreakActions(agent, dialogs, NullLog.Instance), NullLog.Instance);
        vm.Refresh();
        return (vm, agent, dialogs);
    }

    [Fact]
    public void A_day_off_and_a_holiday_say_so()
    {
        var (vm, agent, _) = Dashboard();
        Assert.Null(vm.DayOffText);
        agent.Workday!.DayOff = new DayOffView { Kind = "HOLIDAY", Name = " Diwali " };
        vm.Refresh();
        Assert.Equal("Today is Diwali", vm.DayOffText);
        agent.Workday.DayOff = new DayOffView { Kind = "WEEKLY_OFF" };
        vm.Refresh();
        Assert.Equal("Today is a day off", vm.DayOffText);
    }

    [Fact]
    public void Leave_and_work_from_home_show_from_the_day()
    {
        var (vm, agent, _) = Dashboard();
        Assert.Null(vm.LeaveText);
        Assert.Null(vm.WfhText);
        agent.Workday!.Leave = new LeaveTodayView { Days = 0.5, Label = "Half day (first half)", Categories = "CL/SL" };
        agent.Workday.Wfh = new WfhTodayView { Label = "Full day" };
        vm.Refresh();
        Assert.Equal("On leave today · Half day (first half) · CL/SL", vm.LeaveText);
        Assert.Equal("Work from home (full day)", vm.WfhText);
    }

    [Fact]
    public void A_hand_adjustment_of_focus_time_shows_with_its_sign()
    {
        var (vm, agent, _) = Dashboard();
        Assert.False(vm.Today.HasAdjusted);
        agent.Workday!.Focus.AdjustedSec = -30 * 60;
        vm.Refresh();
        Assert.True(vm.Today.HasAdjusted);
        Assert.Contains("−30", vm.Today.AdjustedText);
        agent.Workday.Focus.AdjustedSec = 45 * 60;
        vm.Refresh();
        Assert.Contains("+45", vm.Today.AdjustedText);
    }

    [Fact]
    public void A_late_start_with_no_note_offers_to_add_it_with_the_quick_answers()
    {
        var (vm, agent, dialogs) = Dashboard();
        Assert.Null(vm.LateReasonText);
        agent.Workday!.LateStart = new LateStartView { Minutes = 35, NeedsReason = true };
        agent.PresetLists[PresetKinds.LateDayStart] = new() { "Traffic", "Doctor appointment" };
        vm.Refresh();
        Assert.Equal("Your day started 35 min after your shift start. Add a short note for your manager.", vm.LateReasonText);

        dialogs.Answer(d =>
        {
            var note = Assert.IsType<ReasonDialogViewModel>(d);
            Assert.Equal(new[] { "Traffic", "Doctor appointment" }, note.Chips.Select(c => c.Label));
            // A quick answer passes whatever its length (the server takes a preset as it is).
            note.Chips[0].PickCommand.Execute(null);
            Assert.True(note.SubmitCommand.CanExecute(null));
            return true;
        });
        vm.AddLateReasonCommand.Execute(null);
        Assert.Equal(new[] { "Traffic" }, agent.LateReasons);
        vm.Refresh();
        Assert.Null(vm.LateReasonText);
    }

    [Fact]
    public void The_agents_own_chips_still_need_the_minimum()
    {
        var dialog = new ReasonDialogViewModel("Skip", "Why?", 10, new[] { "Deadline" });
        dialog.Chips[0].PickCommand.Execute(null);
        Assert.False(dialog.SubmitCommand.CanExecute(null));
    }

    [Fact]
    public void Biometric_staff_have_no_day_or_break_buttons_and_read_why()
    {
        var (vm, agent, _) = Dashboard();
        Assert.True(vm.ShowDayButtons && vm.ShowBreakTiles && vm.ShowBreakList && vm.ShowTiles);
        Assert.Null(vm.BiometricText);
        agent.IsBiometric = true;
        vm.Refresh();
        Assert.True(vm.IsBiometric);
        Assert.False(vm.ShowDayButtons || vm.ShowBreakTiles || vm.ShowBreakList || vm.ShowTiles);
        Assert.False(vm.EndDayCommand.CanExecute(null));
        Assert.Equal("Your attendance is recorded by the biometric device: your day starts with your first punch there.", vm.BiometricText);
        Assert.False(vm.MeetingTile.CanClick);
        Assert.Equal("Your day is on the biometric device", vm.MeetingTile.Caption);
    }

    [Fact]
    public void The_tray_menu_offers_no_day_or_break_items_to_biometric_staff()
    {
        var running = MenuState.For(AgentState.Running, PresenceStatus.Working, false, biometric: true);
        Assert.False(running.CanEndDay || running.CanQuickBreak || running.CanNextBreak);
        Assert.False(MenuState.For(AgentState.NotStarted, PresenceStatus.NotStarted, false, biometric: true).CanStartDay);
        Assert.True(MenuState.For(AgentState.NotStarted, PresenceStatus.NotStarted, false).CanStartDay);
    }

    [Fact]
    public async Task A_refusal_for_biometric_staff_shows_the_servers_words_as_written()
    {
        var agent = new FakeAgent("09:02") { State = AgentState.NotStarted };
        var dialogs = new FakeDialogs();
        var actions = new BreakActions(agent, dialogs, NullLog.Instance);
        const string words = "Your attendance is recorded by the biometric device: your day starts with your first punch there.";
        agent.StartDayOutcomes.Enqueue(new StartDayOutcome.Refused("ATTENDANCE_BY_BIOMETRIC", words));
        dialogs.Answer(_ => true);
        await actions.StartDayAsync();
        var alert = Assert.IsType<MessageDialogViewModel>(Assert.Single(dialogs.Shown));
        Assert.Equal("Your attendance", alert.Title);
        Assert.Equal(words, alert.Message);
    }

    [Fact]
    public async Task Starting_a_full_day_of_leave_asks_first()
    {
        var agent = new FakeAgent("09:02") { State = AgentState.NotStarted };
        agent.Workday = Days.NotStarted("09:02");
        agent.Workday.Leave = new LeaveTodayView { Days = 1, Full = true, Label = "Full day", Categories = "CL/SL" };
        var dialogs = new FakeDialogs();
        var actions = new BreakActions(agent, dialogs, NullLog.Instance);
        dialogs.Answer(d =>
        {
            Assert.Equal("You are on leave today (CL/SL). Start Day anyway? It will count as an extra day.", ((MessageDialogViewModel)d).Message);
            return false;
        });
        await actions.StartDayAsync();
        Assert.Equal(0, agent.StartDayCalls);
    }

    [Fact]
    public async Task A_late_Start_Day_asks_with_the_servers_words_and_sends_the_note()
    {
        var agent = new FakeAgent("10:02") { State = AgentState.NotStarted };
        var dialogs = new FakeDialogs();
        var actions = new BreakActions(agent, dialogs, NullLog.Instance);
        agent.StartDayOutcomes.Enqueue(new StartDayOutcome.NeedsLateReason(32, Ist.At("09:30"), 10, 500, new[] { "Traffic", "Doctor appointment" }, "Add a short note."));
        dialogs.Answer(d =>
        {
            var note = Assert.IsType<ReasonDialogViewModel>(d);
            Assert.Equal("Add a short note.", note.Message);
            Assert.Equal("9:30 AM", note.TagDetail);
            note.Chips[0].PickCommand.Execute(null);
            Assert.True(note.SubmitCommand.CanExecute(null));
            return true;
        });
        await actions.StartDayAsync();
        Assert.Equal(new string?[] { null, "Traffic" }, agent.StartDayReasons);
        Assert.Equal(AgentState.Running, agent.State);
    }

    [Fact]
    public async Task Cancelling_the_late_note_leaves_the_day_not_started()
    {
        var agent = new FakeAgent("10:02") { State = AgentState.NotStarted };
        var dialogs = new FakeDialogs();
        var actions = new BreakActions(agent, dialogs, NullLog.Instance);
        agent.StartDayOutcomes.Enqueue(new StartDayOutcome.NeedsLateReason(32, Ist.At("09:30"), 10, 500, Array.Empty<string>(), "Add a short note."));
        await actions.StartDayAsync();
        // 4.0 asks before anything is recorded: nothing to forget, the day simply stays not started.
        Assert.Equal(1, agent.StartDayCalls);
        Assert.Equal(AgentState.NotStarted, agent.State);
    }
}

public class LeavePageTests
{
    internal static MyLeave Leave() => new()
    {
        Today = "2026-10-13",
        Year = 2026,
        Policy = new LeavePolicy
        {
            Enabled = true,
            ElplNoticeDays = 5,
            Categories =
            {
                new LeaveCategoryInfo { Category = "CLSL", Label = "CL/SL", Rule = "Any day, today included." },
                new LeaveCategoryInfo { Category = "ELPL", Label = "EL/PL", Rule = "Apply at least 5 days ahead." },
                new LeaveCategoryInfo { Category = "COMPOFF", Label = "Comp off", Rule = "Earned by working a day off." },
            },
            Kinds =
            {
                new LeaveKindInfo { Kind = "FULL_DAY", Label = "Full day" },
                new LeaveKindInfo { Kind = "HALF_DAY", Label = "Half day", Parts = { new LeavePartInfo { Part = "FIRST_HALF", Label = "first half" }, new LeavePartInfo { Part = "SECOND_HALF", Label = "second half" } } },
            },
        },
        Balances =
        {
            new LeaveBalance { Category = "CLSL", Label = "CL/SL", GrantedDays = 12, AvailableDays = 10.5 },
            new LeaveBalance { Category = "ELPL", Label = "EL/PL", GrantedDays = 12, CarriedDays = 1, AvailableDays = 8, PendingDays = 5 },
        },
        CompOff = new CompOffBalance { Enabled = true, AvailableDays = 1.5, PendingDays = 0.5, NextExpiry = new CompOffExpiry { Date = "2026-11-13", Label = "Fri 13 Nov", Days = 1 } },
        Upcoming = { new LeaveRequest { Id = "l-1", Span = "Fri 13 Nov", Kind = "HALF_DAY", KindLabel = "Half day (second half)", DaysLabel = "0.5 day", CategoryLabel = "CL/SL", Status = LeaveStatuses.Approved, StatusLabel = "Approved", DecidedByName = "Maya Reddy", Can = new LeaveRequestCan { Cancel = true } } },
        Requests =
        {
            new LeaveRequest { Id = "l-1", Span = "Fri 13 Nov", Kind = "HALF_DAY", KindLabel = "Half day (second half)", DaysLabel = "0.5 day", CategoryLabel = "CL/SL", Status = LeaveStatuses.Approved, Can = new LeaveRequestCan { Cancel = true } },
            new LeaveRequest { Id = "l-2", Span = "Mon 14 to Fri 18 Dec", Kind = "FULL_DAY", DaysLabel = "5 days", CategoryLabel = "EL/PL", Status = LeaveStatuses.Pending, WaitingFor = "Maya Reddy", Can = new LeaveRequestCan { Cancel = true } },
            new LeaveRequest { Id = "l-3", Span = "Mon 5 Oct", Kind = "FULL_DAY", DaysLabel = "1 day", CategoryLabel = "CL/SL", Status = LeaveStatuses.Rejected, DecidedByName = "Maya Reddy", DecisionNote = "Release week" },
        },
    };

    private static (LeaveViewModel Vm, FakeAgent Agent, FakeDialogs Dialogs) Page()
    {
        var agent = new FakeAgent("10:20") { LeaveResult = ApiResult<MyLeave>.Success(Leave()) };
        var dialogs = new FakeDialogs();
        return (new LeaveViewModel(agent, dialogs, NullLog.Instance, NoWait), agent, dialogs);
    }

    /// <summary>The preview's wait, over at once (cancelled when a newer change asks).</summary>
    internal static Task NoWait(TimeSpan wait, CancellationToken ct) => ct.IsCancellationRequested ? Task.FromCanceled(ct) : Task.CompletedTask;

    [Fact]
    public async Task Shows_what_is_left_the_next_leave_and_every_request_once()
    {
        var (vm, _, _) = Page();
        await vm.LoadAsync();
        Assert.Equal(new[] { "CL/SL 10.5 left of 12", "EL/PL 8 left of 13", "Comp off 1.5 left" }, vm.Balances.Select(b => $"{b.Label} {b.Left}"));
        Assert.Equal("5 days waiting", vm.Balances[1].Waiting);
        Assert.False(vm.Balances[0].HasWaiting);
        Assert.Equal("Comp off: 1 day expires Fri 13 Nov", vm.CompOffExpiryText);
        Assert.Equal("Fri 13 Nov, half day (second half) · Approved", vm.NextLeaveText);
        Assert.Equal(new[] { "Fri 13 Nov", "Mon 14 to Fri 18 Dec", "Mon 5 Oct" }, vm.Requests.Select(r => r.Span));
        Assert.Equal("Half day (second half)", vm.Requests[0].Amount);
        Assert.Equal("5 days", vm.Requests[1].Amount);
        Assert.Equal("Approved by Maya Reddy", vm.Requests[0].Status);
        Assert.Equal("Waiting for Maya Reddy", vm.Requests[1].Status);
        Assert.Equal("Not approved by Maya Reddy: Release week", vm.Requests[2].Status);
        Assert.Equal(("Cancel leave", "Cancel request"), (vm.Requests[0].CancelText, vm.Requests[1].CancelText));
        Assert.False(vm.Requests[2].CanCancel);
        Assert.False(vm.ShowNoRequests);
        Assert.True(vm.ApplyCommand.CanExecute(null));
    }

    [Fact]
    public async Task With_no_connection_the_last_answer_stays_and_says_why()
    {
        var (vm, agent, _) = Page();
        await vm.LoadAsync();
        agent.LeaveResult = new ApiResult<MyLeave> { Outcome = ApiOutcome.Transient, Message = "offline" };
        await vm.LoadAsync();
        Assert.Equal("Can't reach RX Vision to read your leave. Try again in a moment.", vm.Problem);
        Assert.Equal(3, vm.Balances.Count);
    }

    [Fact]
    public async Task Leave_switched_off_cannot_be_applied_for()
    {
        var (vm, agent, _) = Page();
        var off = Leave();
        off.Policy.Enabled = false;
        agent.LeaveResult = ApiResult<MyLeave>.Success(off);
        await vm.LoadAsync();
        Assert.False(vm.ApplyCommand.CanExecute(null));
    }

    [Fact]
    public async Task Apply_asks_then_says_where_it_went_and_reads_again()
    {
        var (vm, agent, dialogs) = Page();
        await vm.LoadAsync();
        agent.PresetLists[PresetKinds.LeaveReason] = new() { "Unwell", "Family function" };
        dialogs.Answer(d =>
        {
            var form = Assert.IsType<LeaveDialogViewModel>(d);
            Assert.Equal(new[] { "CL/SL", "EL/PL", "Comp off" }, form.Categories.Select(c => c.Label));
            Assert.Equal("Any day, today included.", form.RuleText);
            Assert.Equal(new DateTime(2026, 10, 13), form.FirstDay);
            Assert.False(form.SubmitCommand.CanExecute(null)); // no reason yet
            form.Chips[0].PickCommand.Execute(null);
            Assert.True(form.SubmitCommand.CanExecute(null));
            return true;
        });
        dialogs.Answer(d =>
        {
            Assert.Equal("Leave requested", d.Title);
            Assert.Equal("Leave requested: Mon 9 Nov. Waiting for Maya Reddy.", ((MessageDialogViewModel)d).Message);
            return true;
        });
        await vm.ApplyCommand.ExecuteAsync(null);
        var body = Assert.Single(agent.LeaveRequests);
        Assert.Equal(("CLSL", "FULL_DAY", "2026-10-13", "Unwell"), (body.Category, body.Kind, body.StartDate, body.Reason));
    }

    [Fact]
    public async Task A_refused_request_comes_back_to_the_form_with_what_was_typed()
    {
        var (vm, agent, dialogs) = Page();
        await vm.LoadAsync();
        agent.LeaveResults.Enqueue(new ApiResult<LeaveRequest> { Outcome = ApiOutcome.Rejected, Status = 409, Code = "LEAVE_OVERLAP", Message = "You already have leave on that day." });
        dialogs.Answer(d => { ((LeaveDialogViewModel)d).Reason = "Family function"; return true; });
        dialogs.Answer(d =>
        {
            var again = Assert.IsType<LeaveDialogViewModel>(d);
            Assert.Equal("You already have leave on that day.", again.Error);
            Assert.Equal("Family function", again.Reason);
            return false;
        });
        await vm.ApplyCommand.ExecuteAsync(null);
        Assert.Single(agent.LeaveRequests);
    }

    [Fact]
    public async Task Cancel_asks_first_and_cancels_by_id()
    {
        var (vm, agent, dialogs) = Page();
        await vm.LoadAsync();
        dialogs.Answer(d => { Assert.Equal("Cancel this request?", d.Title); return false; });
        await vm.Requests[1].CancelCommand.ExecuteAsync(null);
        Assert.Empty(agent.LeaveCancels);
        dialogs.Answer(_ => true);
        await vm.Requests[1].CancelCommand.ExecuteAsync(null);
        Assert.Equal(new[] { "l-2" }, agent.LeaveCancels);
    }

    [Fact]
    public async Task The_form_previews_after_its_wait_and_shows_what_it_charges_or_what_stops_it()
    {
        LeaveRequestBody? asked = null;
        var waits = 0;
        ApiResult<LeavePreview> answer = ApiResult<LeavePreview>.Success(new LeavePreview
        {
            Ok = true, DaysLabel = "0.5 day", PartTimes = "9:30 AM to 2:00 PM", WaitingFor = "Maya Reddy",
            Balance = new LeavePreviewBalance { Label = "CL/SL", BeforeDays = 12, AfterDays = 11.5 },
            Dates = { new LeavePreviewDate { Label = "Sat 17 Oct", Charged = false, Why = "weekly off" } },
        });
        var context = new LeaveDialogContext(Leave().Policy, new DateTime(2026, 10, 13), new[] { "Unwell" }, new HashSet<DateTime>(),
            body => { asked = body; return Task.FromResult(answer); },
            (wait, ct) => { Assert.Equal(TimeSpan.FromMilliseconds(300), wait); waits++; return NoWait(wait, ct); });
        var form = new LeaveDialogViewModel(context) { Kind = new LeaveChoice("HALF_DAY", "Half day") };
        await WaitUntil(() => asked is not null && form.PreviewLines.Count > 0);
        Assert.True(waits > 0);
        Assert.Equal("Preview", asked!.Reason); // a placeholder until three characters are typed
        Assert.Equal("FIRST_HALF", asked.Part);
        Assert.Equal(new[]
        {
            "Charges 0.5 day of CL/SL", "Left after: 11.5 (now 12)", "Not charged: Sat 17 Oct (weekly off)", "Away 9:30 AM to 2:00 PM", "Goes to Maya Reddy for approval",
        }, form.PreviewLines);

        asked = null;
        answer = ApiResult<LeavePreview>.Success(new LeavePreview { Ok = false, Problem = new LeaveProblem { Message = "EL/PL needs 5 days' notice." } });
        form.Reason = "Family function";
        await WaitUntil(() => form.HasPreviewProblem);
        Assert.Equal("Family function", asked!.Reason);
        Assert.Equal("EL/PL needs 5 days' notice.", form.PreviewProblem);
        Assert.False(form.SubmitCommand.CanExecute(null));
    }

    [Fact]
    public void EL_PL_defaults_to_the_first_working_day_after_the_notice()
    {
        var off = new HashSet<DateTime> { new(2026, 10, 18) };
        var context = new LeaveDialogContext(Leave().Policy, new DateTime(2026, 10, 13), Array.Empty<string>(), off,
            _ => Task.FromResult(ApiResult<LeavePreview>.Success(new LeavePreview { Ok = true })), NoWait);
        var form = new LeaveDialogViewModel(context);
        Assert.Equal(new DateTime(2026, 10, 13), form.FirstDay);
        form.Category = form.Categories.Single(c => c.Value == "ELPL");
        Assert.Equal(new DateTime(2026, 10, 19), form.FirstDay);
    }

    private static async Task WaitUntil(Func<bool> condition)
    {
        var until = DateTime.UtcNow.AddSeconds(5);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < until, "timed out");
            await Task.Delay(10);
        }
    }
}

public class CalendarPageTests
{
    private static CalendarYear Year(int year) => new()
    {
        Year = year,
        Today = $"{year}-01-02",
        Summary = "Your department's calendar",
        Totals = new CalendarTotals { Working = 1, WeeklyOff = 1, Holidays = 1 },
        Holidays = { new CalendarHoliday { Date = $"{year}-01-01", Label = "New Year" } },
        Days =
        {
            new CalendarDay { Date = $"{year}-01-01", Kind = CalendarKinds.Holiday, HolidayName = "New Year" },
            new CalendarDay { Date = $"{year}-01-02", Kind = CalendarKinds.Working },
            new CalendarDay { Date = $"{year}-01-04", Kind = CalendarKinds.WeeklyOff },
        },
    };

    [Fact]
    public async Task Shows_the_year_with_its_days_and_the_arrows_move_it()
    {
        var agent = new FakeAgent("10:20") { CalendarFor = y => ApiResult<CalendarYear>.Success(Year(y)) };
        var vm = new CalendarViewModel(agent, NullLog.Instance);
        await vm.OpenAsync();
        Assert.Equal(2026, vm.Year);
        Assert.Equal("Your department's calendar", vm.Summary);
        Assert.Equal("1 working days · 1 weekly off · 1 holiday", vm.TotalsText);
        var january = Assert.Single(vm.Months);
        Assert.Equal("January", january.Name);
        // 1 January 2026 is a Thursday: three blanks before it (Monday first).
        Assert.Equal(new[] { true, true, true, false, false, false }, january.Cells.Select(c => c.IsBlank));
        Assert.True(january.Cells[3].IsHoliday);
        Assert.Equal("New Year", january.Cells[3].ToolTip);
        Assert.True(january.Cells[4].IsToday && january.Cells[4].IsWorking);
        Assert.True(january.Cells[5].IsWeeklyOff);
        Assert.Equal("New Year", Assert.Single(vm.Holidays).Label);

        await vm.PreviousYearCommand.ExecuteAsync(null);
        Assert.Equal(2025, vm.Year);
        await vm.NextYearCommand.ExecuteAsync(null);
        await vm.NextYearCommand.ExecuteAsync(null);
        Assert.Equal(2027, vm.Year);
    }

    [Fact]
    public async Task With_no_connection_it_says_so()
    {
        var vm = new CalendarViewModel(new FakeAgent("10:20"), NullLog.Instance);
        await vm.OpenAsync();
        Assert.Equal("Can't reach RX Vision to read your calendar. Try again in a moment.", vm.Problem);
    }
}

public class InstructionsPageTests
{
    [Fact]
    public async Task Shows_the_servers_guide_in_order()
    {
        var agent = new FakeAgent("10:20")
        {
            GuideResult = (new StaffGuide { Items = { new GuideItem { N = 2, Title = "Take your breaks", Body = "On time." }, new GuideItem { N = 1, Title = "Start your day", Body = "Tap Start Day." } } }, true),
        };
        var vm = new InstructionsViewModel(agent, NullLog.Instance);
        await vm.LoadAsync();
        Assert.Equal(new[] { "1. Start your day", "2. Take your breaks" }, vm.Items.Select(i => i.Heading));
        Assert.False(vm.HasNote);
    }

    [Fact]
    public async Task Offline_it_shows_the_last_copy_and_says_so()
    {
        var agent = new FakeAgent("10:20") { GuideResult = (new StaffGuide { Items = { new GuideItem { N = 1, Title = "Start your day", Body = "Tap Start Day." } } }, false) };
        var vm = new InstructionsViewModel(agent, NullLog.Instance);
        await vm.LoadAsync();
        Assert.Single(vm.Items);
        Assert.Equal("You're offline, so this is the last copy.", vm.Note);
        agent.GuideResult = (null, false);
        vm.Reset();
        await vm.LoadAsync();
        Assert.Empty(vm.Items);
        Assert.Equal("Can't reach RX Vision to read the instructions. Try again in a moment.", vm.Note);
    }
}

/// <summary>What My calendar and the organisation's guide are drawn with in the screenshots.</summary>
internal static class PagesData
{
    public static CalendarYear Calendar(int year)
    {
        var days = new List<CalendarDay>();
        for (var d = new DateTime(year, 1, 1); d.Year == year; d = d.AddDays(1))
        {
            var key = d.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
            var holiday = d is { Month: 1, Day: 26 };
            days.Add(new CalendarDay
            {
                Date = key,
                Kind = d.DayOfWeek == DayOfWeek.Sunday ? CalendarKinds.WeeklyOff : holiday ? CalendarKinds.Holiday : CalendarKinds.Working,
                HolidayName = holiday ? "Republic Day" : null,
            });
        }
        return new CalendarYear
        {
            Year = year,
            Today = $"{year}-10-13",
            Summary = "Your department's calendar",
            Totals = new CalendarTotals { Working = days.Count(d => d.Kind == CalendarKinds.Working), WeeklyOff = days.Count(d => d.Kind == CalendarKinds.WeeklyOff), Holidays = 1 },
            Holidays = { new CalendarHoliday { Date = $"{year}-01-26", Label = "Republic Day" } },
            Days = days,
        };
    }

    public static StaffGuide Guide() => new()
    {
        Items =
        {
            new GuideItem { N = 1, Title = "Start your day", Body = "Press Start Day when you begin work. Starting more than 10 minutes after your shift starts asks you to say why." },
            new GuideItem { N = 2, Title = "Breaks and the ring", Body = "RX Vision rings 1 minute before each break and keeps ringing for 5 minutes." },
            new GuideItem { N = 3, Title = "Paid time", Body = "Your scheduled breaks plus a small buffer of 10 minutes are paid. Break time beyond that is not." },
        },
    };
}

public class PagesInTheMenuTests
{
    [Fact]
    public async Task The_menu_opens_each_page_and_closes()
    {
        var agent = new FakeAgent("10:20");
        var dialogs = new FakeDialogs();
        var vm = new DashboardViewModel(agent, new BreakActions(agent, dialogs, NullLog.Instance), NullLog.Instance);
        vm.ShowProfileCommand.Execute(null);
        Assert.True(vm.ShowProfileList);
        await vm.ShowLeaveCommand.ExecuteAsync(null);
        Assert.True(vm.IsLeavePage && !vm.ShowProfileList);
        await vm.ShowCalendarCommand.ExecuteAsync(null);
        Assert.True(vm.IsCalendarPage);
        await vm.ShowHistoryCommand.ExecuteAsync(null);
        Assert.True(vm.IsHistoryPage);
        await vm.ShowInstructionsCommand.ExecuteAsync(null);
        Assert.True(vm.IsInstructionsPage);
        vm.ShowDashboardCommand.Execute(null);
        Assert.True(vm.IsDashboardPage);
    }

    [Fact]
    public async Task A_leave_change_reads_the_open_page_again_only()
    {
        var agent = new FakeAgent("10:20");
        agent.LeaveResult = new ApiResult<MyLeave> { Outcome = ApiOutcome.Transient };
        var dialogs = new FakeDialogs();
        var vm = new DashboardViewModel(agent, new BreakActions(agent, dialogs, NullLog.Instance), NullLog.Instance);
        vm.OnLeaveChanged();
        Assert.Null(vm.Leave.Problem);
        await vm.ShowLeaveCommand.ExecuteAsync(null);
        Assert.NotNull(vm.Leave.Problem);
        agent.LeaveResult = ApiResult<MyLeave>.Success(new MyLeave());
        vm.OnLeaveChanged();
        Assert.Null(vm.Leave.Problem);
    }
}
