using System.Globalization;
using Avalonia.Headless.XUnit;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>A month as GET /workday/me/history answers it (SPEC 5.6), for 13 Oct 2026.</summary>
public static class Months
{
    /// <param name="offline">
    /// 12 Oct was lived offline and replayed, and the agent's activity data for 2 h 10 m of it has
    /// not reached the server: that time is "Offline, no activity data" (not focus, not paid).
    /// </param>
    public static HistoryMonth October(bool behind = false, bool offline = false)
    {
        var days = new List<HistoryDay>();
        for (var d = 1; d <= 31; d++)
        {
            var date = new DateTime(2026, 10, d);
            var iso = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var sunday = date.DayOfWeek == DayOfWeek.Sunday;
            var holiday = d == 2;
            var working = !sunday && !holiday;
            var day = new HistoryDay
            {
                Date = iso,
                Weekday = date.DayOfWeek.ToString()[..3],
                IsWorkingDay = working,
                Label = holiday ? "Gandhi Jayanti" : null,
                TargetSec = working ? 7 * 3600 + 30 * 60 : 0,
            };
            if (d > 13) day.Status = working ? DayStatuses.Upcoming : DayStatuses.Off;
            else if (d == 13)
            {
                day.Status = DayStatuses.InProgress;
                day.StartedAt = Ist.At("09:24").ToUniversalTime();
                day.FocusSec = 3600;
            }
            else if (!working) day.Status = DayStatuses.Off;
            else
            {
                var focus = d == 7 ? 3 * 3600 + 50 * 60 : behind ? 6 * 3600 : 8 * 3600;
                day.Status = d == 7 ? DayStatuses.Half : focus >= 7 * 3600 ? DayStatuses.Full : DayStatuses.Half;
                day.FocusSec = focus;
                day.StartedAt = new DateTimeOffset(2026, 10, d, 9, 20, 0, Ist.Offset).ToUniversalTime();
                day.EndedAt = new DateTimeOffset(2026, 10, d, 18, 35, 0, Ist.Offset).ToUniversalTime();
                day.BreakSec = 75 * 60;
                day.PaidBreakSec = 70 * 60;
                day.UnpaidBreakSec = 5 * 60;
                day.Meetings = d % 3 == 0 ? 2 : 0;
                day.MeetingsSec = d % 3 == 0 ? 50 * 60 : 0;
                day.PendingSec = d == 12 ? 20 * 60 : 0;
                day.ApprovedAwaySec = d == 9 ? 15 * 60 : 0;
                if (offline && d == 12)
                {
                    day.UnverifiedSec = 2 * 3600 + 10 * 60;
                    day.FocusSec -= day.UnverifiedSec;
                    day.Status = DayStatuses.Half;
                }
            }
            day.PaidSec = day.FocusSec + day.PaidBreakSec;
            days.Add(day);
        }
        var past = days.Where(x => string.CompareOrdinal(x.Date, "2026-10-13") <= 0).ToList();
        return new HistoryMonth
        {
            Month = "2026-10",
            IsCurrent = true,
            WorkingDays = days.Count(x => x.IsWorkingDay),
            TargetSec = days.Sum(x => x.TargetSec),
            FocusSec = past.Sum(x => x.FocusSec),
            PaidSec = past.Sum(x => x.Paid),
            UnverifiedSec = past.Sum(x => x.UnverifiedSec),
            PaidBreakSec = past.Sum(x => x.PaidBreakSec),
            UnpaidBreakSec = past.Sum(x => x.UnpaidBreakSec),
            MeetingsSec = past.Sum(x => x.MeetingsSec),
            PendingSec = 20 * 60,
            ProjectedSec = 186 * 3600,
            Days = days,
            Meetings = new List<HistoryMeeting>
            {
                new()
                {
                    Date = "2026-10-12", StartedAt = new DateTimeOffset(2026, 10, 12, 15, 0, 0, Ist.Offset), DurationSec = 45 * 60,
                    Agenda = "Quarterly numbers with the Pune team", Status = "APPROVED", MomSender = "Priya Nair",
                    Participants = new List<MeetingParticipant> { new("m-1", "Maya Reddy"), new(null, "Vikram (Pune)") },
                },
                new()
                {
                    Date = "2026-10-09", StartedAt = new DateTimeOffset(2026, 10, 9, 11, 30, 0, Ist.Offset), DurationSec = 20 * 60,
                    Agenda = "Short sync on the release (away)", Status = "PENDING", MomSender = "Asha Kumar",
                    Participants = new List<MeetingParticipant> { new(null, "Ravi") },
                },
            },
            Away = new List<HistoryAway>
            {
                new() { Date = "2026-10-12", StartedAt = new DateTimeOffset(2026, 10, 12, 14, 5, 0, Ist.Offset), Seconds = 20 * 60, Reason = "Thinking", Comment = "Planning the invoice release", Status = "PENDING" },
                new() { Date = "2026-10-09", StartedAt = new DateTimeOffset(2026, 10, 9, 16, 10, 0, Ist.Offset), Seconds = 15 * 60, Reason = "Working on hardware", Comment = "Replaced the scanner cable", Status = "APPROVED" },
                new() { Date = "2026-10-06", StartedAt = new DateTimeOffset(2026, 10, 6, 12, 40, 0, Ist.Offset), Seconds = 9 * 60, Status = "UNEXPLAINED" },
            },
        };
    }
}

/// <summary>History (SPEC 8.2): the month, the ring, the days, live reloads, the saved copy offline.</summary>
public class HistoryViewModelTests
{
    private static (HistoryViewModel Vm, FakeAgent Agent) Open(Func<string, (HistoryMonth?, bool)>? history = null)
    {
        var agent = new FakeAgent("10:45") { HistoryFor = history ?? (m => m == "2026-10" ? (Months.October(), true) : (null, false)) };
        var vm = new HistoryViewModel(agent, NullLog.Instance);
        vm.OpenAsync().GetAwaiter().GetResult();
        return (vm, agent);
    }

    [Fact]
    public void Shows_the_month_against_its_target()
    {
        var (vm, agent) = Open();
        Assert.Equal(new[] { "2026-10" }, agent.HistoryCalls);
        Assert.Equal("October 2026", vm.MonthTitle);
        Assert.True(vm.HasData);
        Assert.Null(vm.Problem);
        Assert.False(vm.IsStale);
        var month = Months.October();
        Assert.Equal(Fmt.Focus(month.FocusSec), vm.FocusText);
        Assert.Equal($"of {Fmt.Hours(month.TargetSec)}", vm.TargetText);
        Assert.Equal(360 * month.FocusSec / (double)month.TargetSec, vm.RingSweep, 3);
        Assert.Equal("On track", vm.TrackText);
        Assert.False(vm.IsBehind);
        Assert.Equal("At this pace about 186h by the month's end", vm.ProjectedText);
        Assert.Equal(new[] { "Working days", "Worked", "Paid time", "Paid breaks", "Unpaid breaks", "Meetings", "Pending approval" }, vm.Chips.Select(c => c.Label));
        Assert.Equal("+20 min", vm.Chips[^1].Value);
    }

    [Fact]
    public void Days_newest_first_up_to_today_with_status_and_details()
    {
        var (vm, _) = Open();
        Assert.Equal("2026-10-13", vm.Days[0].Date);
        Assert.Equal("2026-10-01", vm.Days[^1].Date);
        Assert.Equal(13, vm.Days.Count); // no upcoming days
        var today = vm.Days[0];
        Assert.True(today.IsToday);
        Assert.Equal("Today", today.StatusText);
        Assert.Equal("From 9:24 AM", today.Times);

        var twelfth = vm.Days.Single(d => d.Date == "2026-10-12");
        Assert.Equal("Mon 12 Oct", twelfth.DateText);
        Assert.Equal("Full day", twelfth.StatusText);
        Assert.Equal(Tone.Good, twelfth.StatusTone);
        Assert.Equal("8h 00m", twelfth.FocusText);
        Assert.Equal("of 7h 30m", twelfth.TargetText);
        Assert.Equal(1, twelfth.Progress);
        Assert.Equal("9:20 AM - 6:35 PM", twelfth.Times);
        Assert.Equal("Breaks 1h 15m (5m unpaid)", twelfth.BreaksText);
        Assert.Equal("2 meetings · 50m", twelfth.MeetingsText);
        Assert.Equal("+20 min if approved", twelfth.PendingText);

        var holiday = vm.Days.Single(d => d.Date == "2026-10-02");
        Assert.Equal("Gandhi Jayanti", holiday.StatusText);
        Assert.Null(holiday.Label);
        Assert.True(holiday.IsMuted);

        var half = vm.Days.Single(d => d.Date == "2026-10-07");
        Assert.Equal("Half day", half.StatusText);
        Assert.True(half.IsShort);
        Assert.Equal("+15 min away approved", vm.Days.Single(d => d.Date == "2026-10-09").ApprovedAwayText);
    }

    [Fact]
    public void Meetings_with_who_mails_the_minutes_and_away_with_status()
    {
        var (vm, _) = Open();
        var meeting = vm.Meetings[0];
        Assert.Equal("Quarterly numbers with the Pune team", meeting.Agenda);
        Assert.Equal("Mon 12 Oct · 3:00 PM · 45 min", meeting.When);
        Assert.Equal("With Maya Reddy, Vikram (Pune)", meeting.People);
        Assert.Equal("Minutes: Priya Nair", meeting.Mom);
        Assert.Equal("Approved", meeting.StatusText);

        Assert.Equal(new[] { "Pending", "Approved", "Not explained" }, vm.Away.Select(a => a.StatusText));
        Assert.Equal("Thinking", vm.Away[0].Reason);
        Assert.Equal("“Planning the invoice release”", vm.Away[0].Comment);
        Assert.Equal("No reason given", vm.Away[2].Reason);
    }

    [Fact]
    public void Behind_says_by_how_much()
    {
        var month = Months.October(behind: true);
        var (text, behind) = HistoryViewModel.Track(month, "2026-10-13", current: true);
        Assert.True(behind);
        // 10 working days before today at 7 h 30 m, worked 6 h each (plus a half day): behind.
        Assert.StartsWith("Behind by ", text);

        var done = new HistoryMonth { TargetSec = 100 * 3600, FocusSec = 101 * 3600 };
        Assert.Equal(("Target met", false), HistoryViewModel.Track(done, "2026-11-02", current: false));
        var shortMonth = new HistoryMonth { TargetSec = 100 * 3600, FocusSec = 95 * 3600 + 30 * 60 };
        Assert.Equal(("Short by 4 h 30 m", true), HistoryViewModel.Track(shortMonth, "2026-11-02", current: false));
    }

    [Fact]
    public void Offline_shows_the_saved_copy_and_says_so()
    {
        var (vm, _) = Open(_ => (Months.October(), false));
        Assert.True(vm.HasData);
        Assert.True(vm.IsStale);
        Assert.Equal("Offline · showing the copy saved earlier", vm.StaleText);
    }

    [Fact]
    public void Nothing_saved_and_offline_says_so()
    {
        var (vm, _) = Open(_ => (null, false));
        Assert.False(vm.HasData);
        Assert.True(vm.HasProblem);
        Assert.Equal("Can't load this month right now. History needs RX Vision once; it opens offline after that.", vm.Problem);
    }

    [Fact]
    public async Task Month_switcher_goes_back_but_not_past_this_month()
    {
        var (vm, agent) = Open();
        Assert.False(vm.NextMonthCommand.CanExecute(null));
        await vm.PreviousMonthCommand.ExecuteAsync(null);
        Assert.Equal("2026-09", vm.Month);
        Assert.Equal("September 2026", vm.MonthTitle);
        Assert.Equal("2026-09", agent.HistoryCalls[^1]);
        Assert.True(vm.NextMonthCommand.CanExecute(null));
        await vm.NextMonthCommand.ExecuteAsync(null);
        Assert.Equal("2026-10", vm.Month);
        Assert.Equal("2026-01", HistoryViewModel.Shift("2025-12", 1));
    }

    [Fact]
    public void Reloads_every_minute_while_open()
    {
        var (vm, agent) = Open();
        vm.Tick(DateTimeOffset.UtcNow.AddSeconds(20));
        Assert.Single(agent.HistoryCalls);
        vm.Tick(DateTimeOffset.UtcNow.AddSeconds(61));
        Assert.Equal(2, agent.HistoryCalls.Count);
    }

    [Fact]
    public async Task A_decision_or_calendar_change_reloads_the_open_page_only()
    {
        var agent = new FakeAgent("10:45") { HistoryFor = _ => (Months.October(), true) };
        var vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), NullLog.Instance);
        vm.OnHistoryChanged();
        Assert.Empty(agent.HistoryCalls);
        await vm.ShowHistoryCommand.ExecuteAsync(null);
        Assert.True(vm.IsHistoryPage);
        Assert.Single(agent.HistoryCalls);
        vm.OnHistoryChanged();
        Assert.Equal(2, agent.HistoryCalls.Count);
    }
}

/// <summary>The away pop-up (SPEC 2.5, 8.4): reasons, fields, Took a break, End break.</summary>
public class AwayViewModelTests
{
    private static (AwayViewModel Vm, FakeAgent Agent) Away(string now = "14:28", string since = "14:05", IdleConfig? config = null)
    {
        var agent = new FakeAgent(now) { AwaySince = Ist.At(since), IdleConfig = config };
        return (new AwayViewModel(agent, NullLog.Instance), agent);
    }

    [Fact]
    public void Counts_up_from_when_the_person_went_away()
    {
        var (vm, agent) = Away();
        Assert.Equal("Away since 2:05 PM · 23 min", vm.Heading);
        agent.SetNow("15:10");
        vm.Refresh();
        Assert.Equal("Away since 2:05 PM · 1 h 5 min", vm.Heading);
        Assert.True(vm.IsAsking);
    }

    [Fact]
    public void Reasons_come_from_the_settings_with_the_built_ins_as_a_fallback()
    {
        var (defaults, _) = Away();
        Assert.Equal(new[] { "Took a break", "Thinking", "Short meeting", "Other work" }, defaults.Reasons.Select(r => r.Label));

        var config = new IdleConfig
        {
            Enabled = true, Minutes = 5,
            Reasons = new List<AwayReason>
            {
                new() { Key = "BREAK", Label = "Took a break", Kind = AwayKinds.Break },
                new() { Key = "HARDWARE", Label = "Working on hardware", Kind = AwayKinds.Hardware },
                new() { Key = "c-1", Label = "Site visit", Kind = AwayKinds.Custom },
            },
        };
        var (vm, _) = Away(config: config);
        Assert.Equal(new[] { "Took a break", "Working on hardware", "Site visit" }, vm.Reasons.Select(r => r.Label));
        vm.Reasons[2].PickCommand.Execute(null);
        Assert.True(vm.AsksComment);
        Assert.Equal("What did you work on?", vm.CommentLabel);
        Assert.True(vm.Reasons[2].IsOn);
        Assert.False(vm.Reasons[0].IsOn);
    }

    [Fact]
    public async Task Thinking_needs_a_line_then_goes_for_approval()
    {
        var (vm, agent) = Away();
        Assert.False(vm.SubmitCommand.CanExecute(null)); // pick a reason first
        vm.Reasons.Single(r => r.Label == "Thinking").PickCommand.Execute(null);
        Assert.Equal("What were you thinking about?", vm.CommentLabel);
        Assert.Equal("Sent to your manager for approval. If approved, it counts as focus time.", vm.SelectedNote);
        await vm.SubmitCommand.ExecuteAsync(null);
        Assert.Equal("Add what you were thinking about (3 to 200 characters).", vm.Error);
        Assert.Empty(agent.AwayCalls);

        vm.Comment = "Planning the release checklist";
        await vm.SubmitCommand.ExecuteAsync(null);
        var answer = Assert.Single(agent.AwayCalls);
        Assert.Equal("THINKING", answer.ReasonKey);
        Assert.Equal("Planning the release checklist", answer.Comment);
        Assert.True(vm.IsDone);
    }

    [Fact]
    public async Task A_short_meeting_asks_who_what_and_who_mails_the_minutes()
    {
        var (vm, agent) = Away();
        vm.Reasons.Single(r => r.Label == "Short meeting").PickCommand.Execute(null);
        Assert.True(vm.AsksMeeting);
        Assert.False(vm.AsksComment);
        vm.ParticipantsText = "Maya Reddy, Ravi;  maya reddy , ";
        vm.Summary = "Stand-up with the QA team";
        await vm.SubmitCommand.ExecuteAsync(null);
        Assert.Equal("Add who will mail the minutes.", vm.Error);
        vm.MomIsMeCommand.Execute(null);
        Assert.Equal("Asha Kumar", vm.MomSender);
        await vm.SubmitCommand.ExecuteAsync(null);
        var answer = Assert.Single(agent.AwayCalls);
        Assert.Equal("MEETING", answer.ReasonKey);
        Assert.Equal(new[] { "Maya Reddy", "Ravi" }, answer.Participants!.Select(p => p.Name));
        Assert.Equal("Stand-up with the QA team", answer.Comment);
        Assert.Equal("Asha Kumar", answer.MomSender);
        Assert.True(vm.IsDone);
    }

    [Fact]
    public async Task Took_a_break_becomes_a_break_and_ending_it_asks_first()
    {
        var (vm, agent) = Away();
        agent.AwayOutcomes.Enqueue(new AwayOutcome.OnBreak());
        vm.Reasons.Single(r => r.Label == "Took a break").PickCommand.Execute(null);
        Assert.Equal("Yes, I'm on a break", vm.SubmitText);
        await vm.SubmitCommand.ExecuteAsync(null);
        Assert.True(vm.IsOnBreak);
        Assert.False(vm.IsDone);

        // The agent's day now has the quick break from the away start.
        var day = Days.General();
        day.ActiveBreak = new BreakRecord
        {
            Id = "local:q", Kind = BreakKinds.Quick, Label = "Away break", PresenceType = "BREAK",
            StartedAt = Ist.At("14:05").ToUniversalTime(), InProgress = true, Timing = "UNSCHEDULED", ApprovalStatus = "NOT_REQUIRED",
        };
        day.Quick.Add(new QuickBreakView { Id = "local:q", StartedAt = Ist.At("14:05").ToUniversalTime() });
        agent.Day = day;
        vm.Refresh();
        Assert.Equal("23:00", vm.BreakTimer);
        Assert.Equal("On a break since 2:05 PM", vm.BreakSince);

        vm.EndBreakCommand.Execute(null);
        Assert.True(vm.IsConfirmingEnd);
        Assert.Equal("End your break now?", vm.EndQuestion);
        vm.StayOnBreakCommand.Execute(null);
        Assert.True(vm.IsOnBreak);
        Assert.Equal(0, agent.BackToWorkCalls);

        vm.EndBreakCommand.Execute(null);
        await vm.ConfirmEndCommand.ExecuteAsync(null);
        Assert.Equal(1, agent.BackToWorkCalls);
        Assert.True(vm.IsDone);
    }

    [Fact]
    public void Closes_when_answered_elsewhere_or_the_day_ends()
    {
        var (vm, agent) = Away();
        agent.AwaySince = null; // End Day recorded it as unexplained
        vm.Refresh();
        Assert.True(vm.IsDone);

        var (other, otherAgent) = Away();
        otherAgent.State = AgentState.DayEnded;
        other.Refresh();
        Assert.True(other.IsDone);
    }

    [Fact]
    public async Task The_servers_answer_is_shown()
    {
        var (vm, agent) = Away();
        agent.AwayOutcomes.Enqueue(new AwayOutcome.Invalid("Some details are missing.", new[] { "comment" }));
        vm.Reasons.Single(r => r.Label == "Other work").PickCommand.Execute(null);
        vm.Comment = "Filing";
        await vm.SubmitCommand.ExecuteAsync(null);
        Assert.Equal("Some details are missing.", vm.Error);
        Assert.False(vm.IsDone);
    }

    [Fact]
    public void Names_are_split_cleaned_and_capped()
    {
        var many = string.Join(",", Enumerable.Range(1, 40).Select(i => $"Person {i}"));
        Assert.Equal(40, AwayViewModel.ParsePeople(many).Count); // the rule (at most 30) is checked on Submit
        Assert.Empty(AwayViewModel.ParsePeople(" , ;"));
    }
}

/// <summary>The 4.0 dashboard: quick break, the allowance line, the menu and pages, away.</summary>
public class Dashboard40Tests
{
    private static (DashboardViewModel Vm, FakeAgent Agent) Dashboard(string now, Action<FakeAgent>? setup = null)
    {
        var agent = new FakeAgent(now);
        setup?.Invoke(agent);
        var vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), NullLog.Instance);
        vm.Refresh();
        return (vm, agent);
    }

    [Fact]
    public void Quick_break_tile_and_rows()
    {
        var (vm, agent) = Dashboard("10:47");
        Assert.Equal("0m today", vm.QuickTile.Value);
        Assert.Equal("Any time · 5, 10 or 15 min", vm.QuickTile.Caption);
        Assert.True(vm.QuickTile.Command!.CanExecute(null));

        agent.Day!.Quick.Add(new QuickBreakView
        {
            Id = "q-1", StartedAt = Ist.At("10:05").ToUniversalTime(), EndedAt = Ist.At("10:16").ToUniversalTime(), PlannedMin = 10, TakenSec = 11 * 60,
        });
        vm.Refresh();
        Assert.Equal("11m today", vm.QuickTile.Value);
        var row = vm.Rows.Single(r => r.Kind == "Q:q-1");
        Assert.Equal("Quick break", row.Name);
        Assert.True(row.IsQuick);
        Assert.Equal("Quick", row.PillText);
        Assert.Equal("10:05 AM - 10:16 AM · 11 min of 10 min", row.Detail);
        Assert.True(row.DetailIsAlert);
    }

    [Fact]
    public void A_running_quick_break_counts_down_with_no_pause()
    {
        var (vm, agent) = Dashboard("10:47", a =>
        {
            var day = Days.General();
            day.ActiveBreak = new BreakRecord
            {
                Id = "q-2", Kind = BreakKinds.Quick, Label = "Quick break", PresenceType = "BREAK", PlannedMin = 10,
                StartedAt = Ist.At("10:40").ToUniversalTime(), InProgress = true, Timing = "UNSCHEDULED", ApprovalStatus = "NOT_REQUIRED",
            };
            day.Quick.Add(new QuickBreakView { Id = "q-2", StartedAt = Ist.At("10:40").ToUniversalTime(), PlannedMin = 10 });
            a.Day = day;
        });
        Assert.True(vm.IsOnBreak);
        Assert.Equal("QUICK BREAK", vm.ActiveBreak.Eyebrow);
        Assert.Equal("03:00", vm.ActiveBreak.Countdown);
        Assert.False(vm.ActiveBreak.CanPause);
        Assert.False(vm.PauseBreakCommand.CanExecute(null));
        Assert.Equal("Back by 10:50 AM. Your focus time is paused.", vm.ActiveBreak.Note);

        agent.SetNow("10:53");
        vm.Refresh();
        Assert.True(vm.ActiveBreak.IsOverrun);
        Assert.Equal("Past the 10 min you planned. Minutes over come out of your paid buffer first.", vm.ActiveBreak.Note);
    }

    [Fact]
    public void The_allowance_line_under_today()
    {
        var (vm, agent) = Dashboard("15:00", a =>
        {
            a.Day = Days.General()
                .WithRecord(Days.Taken("MORNING", "11:00", "11:14"))
                .WithRecord(Days.Taken("LUNCH", "13:00", "13:35", duration: 30));
        });
        // 15 + 30 + 15 scheduled, 10 buffer; 14 + 30 paid, 5 over from the buffer.
        Assert.Equal("Paid breaks 49 m of 1 h 10 m · unpaid 0 m", vm.Today.AllowanceText);
        Assert.False(vm.Today.HasUnpaid);

        agent.Day!.Quick.Add(new QuickBreakView
        {
            Id = "q-1", StartedAt = Ist.At("14:00").ToUniversalTime(), EndedAt = Ist.At("14:15").ToUniversalTime(), PlannedMin = 15, TakenSec = 15 * 60,
        });
        vm.Refresh();
        Assert.Equal("Paid breaks 54 m of 1 h 10 m · unpaid 10 m", vm.Today.AllowanceText);
        Assert.True(vm.Today.HasUnpaid);
    }

    [Fact]
    public void Target_is_todays_from_the_server()
    {
        var (vm, agent) = Dashboard("10:47", a => a.Workday!.TargetSec = 7 * 3600 + 30 * 60);
        Assert.Equal("Target 7h 30m", vm.Today.ExpectedText);
        agent.Workday!.TargetSec = null;
        vm.Refresh();
        Assert.Equal("Target 8h", vm.Today.ExpectedText); // the 3.1 expected day
    }

    [Fact]
    public async Task The_menu_opens_pages_and_closes()
    {
        var (vm, agent) = Dashboard("10:47", a => a.HistoryFor = _ => (Months.October(), true));
        Assert.True(vm.IsDashboardPage);
        vm.ToggleMenuCommand.Execute(null);
        Assert.True(vm.IsMenuOpen);
        await vm.ShowHistoryCommand.ExecuteAsync(null);
        Assert.False(vm.IsMenuOpen);
        Assert.True(vm.IsHistoryPage);
        Assert.True(vm.History.HasData);

        vm.ToggleMenuCommand.Execute(null);
        vm.ShowInstructionsCommand.Execute(null);
        Assert.True(vm.IsInstructionsPage);
        vm.ShowDashboardCommand.Execute(null);
        Assert.True(vm.IsDashboardPage);

        vm.ToggleMenuCommand.Execute(null);
        vm.CloseMenuCommand.Execute(null);
        Assert.False(vm.IsMenuOpen);
    }

    [Theory]
    [InlineData("USER", false)]
    [InlineData("MANAGER", false)]
    [InlineData("ADMIN", true)]
    [InlineData("SUPER_ADMIN", true)]
    public async Task Sign_out_for_all_quit_for_admins(string role, bool quit)
    {
        var signOuts = 0;
        var quits = 0;
        var (vm, _) = Dashboard("10:47", a => a.User!.Role = role);
        vm.SignOutRequested = () => { signOuts++; return Task.CompletedTask; };
        vm.QuitRequested = () => { quits++; return Task.CompletedTask; };
        vm.Refresh();
        Assert.Equal(quit, vm.CanQuit);
        await vm.SignOutCommand.ExecuteAsync(null);
        Assert.Equal(1, signOuts);
        if (quit)
        {
            await vm.QuitCommand.ExecuteAsync(null);
            Assert.Equal(1, quits);
        }
    }

    [Fact]
    public void Away_pauses_focus_and_says_since_when()
    {
        var (vm, agent) = Dashboard("14:28", a => a.AwaySince = Ist.At("14:05"));
        Assert.Equal("Away", vm.StatusText);
        Assert.Equal("Paused · away since 2:05 PM", vm.Today.FocusStatus);
        Assert.Equal("Paused while you're away", vm.FocusTile.Caption);
        agent.AwaySince = null;
        vm.Refresh();
        Assert.Equal("Working", vm.StatusText);
    }

    [Fact]
    public void A_live_meeting_shows_who_mails_the_minutes()
    {
        var (vm, _) = Dashboard("10:20", a =>
        {
            a.Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = Ist.At("10:08") };
            a.LiveMeeting = new MeetingRecord { Id = "m", Agenda = "Standup", StartedAt = Ist.At("10:08"), InProgress = true, MomSender = "Priya" };
        });
        Assert.Equal("Minutes: Priya", vm.MeetingMomText);
    }

    [Fact]
    public void Toasts_for_a_refused_action_and_a_long_quick_break()
    {
        var agent = new FakeAgent("10:53");
        var refused = Toasts.ActionRefused(agent, "That break's window had closed when it reached RX Vision.", () => { });
        Assert.Equal("Something you did couldn't be saved", refused.Title);
        Assert.Equal("That break's window had closed when it reached RX Vision.", refused.Body);

        var active = new ActiveBreakView(BreakKinds.Quick, "Quick break", "BREAK", 10, Ist.At("10:40"), TimeSpan.FromMinutes(13),
            TimeSpan.FromMinutes(-3), true, "−03:00", false, "NOT_REQUIRED", "UNSCHEDULED", Id: "q", IsQuick: true);
        var over = Toasts.QuickOver(agent, active, () => { }, () => { });
        Assert.Equal("Your 10 min quick break is up.", over.Title);
        Assert.Equal("End break", over.PrimaryText);
    }

    [Fact]
    public void Quick_break_dialog_picks_a_length()
    {
        var dialog = new QuickBreakDialogViewModel(new[] { 5, 10, 15 }, 10);
        Assert.Equal(new[] { 5, 10, 15 }, dialog.Choices.Select(c => c.Minutes));
        dialog.Choices[0].PickCommand.Execute(null);
        Assert.Equal(5, dialog.SelectedMinutes);
        Assert.Equal("Start 5 min break", dialog.PrimaryText);
        Assert.True(dialog.SubmitCommand.CanExecute(null));
    }

    [Fact]
    public void Key_dialog_cleans_what_was_typed()
    {
        var dialog = new KeyDialogViewModel("Enter the sign-out key", "m", "Sign out") { Key = "  AMBER orbit\tcedar  river lamp 42 " };
        Assert.Equal("amber orbit cedar river lamp 42", dialog.CleanKey);
    }
}

/// <summary>Headless screenshots of every 4.0 screen (saved for a person to check; see <see cref="Shots.Dir"/>).</summary>
public class Agent40Screenshots
{
    private static async Task Shoot(string name, FakeAgent agent, Func<DashboardViewModel, Task>? before = null, double width = 1080, double height = 700)
    {
        var vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), NullLog.Instance);
        vm.Refresh();
        await vm.Chat.ActivateAsync();
        var window = new DashboardWindow { DataContext = vm, Width = width, Height = height };
        window.Show();
        vm.Refresh();
        if (before is not null) await before(vm);
        DashboardHarness.Settle();
        var path = Shots.Save(window, name);
        Assert.True(new FileInfo(path).Length > 10_000, $"{name} looks empty");
        window.AllowClose = true;
        window.Close();
    }

    private static FakeAgent Agent(string now, Action<FakeAgent>? setup = null)
    {
        var agent = new FakeAgent(now);
        agent.Workday!.TargetSec = 7 * 3600 + 30 * 60;
        setup?.Invoke(agent);
        return agent;
    }

    private static BreakDay WithQuick(BreakDay day, string from, int planned, string? to = null)
    {
        var start = Ist.At(from).ToUniversalTime();
        if (to is null)
        {
            day.ActiveBreak = new BreakRecord
            {
                Id = "q-run", Kind = BreakKinds.Quick, Label = "Quick break", PresenceType = "BREAK", PlannedMin = planned,
                StartedAt = start, InProgress = true, Timing = "UNSCHEDULED", ApprovalStatus = "NOT_REQUIRED",
            };
            day.Quick.Add(new QuickBreakView { Id = "q-run", StartedAt = start, PlannedMin = planned });
        }
        else
        {
            var end = Ist.At(to).ToUniversalTime();
            day.Quick.Add(new QuickBreakView { Id = "q-" + from, StartedAt = start, EndedAt = end, PlannedMin = planned, TakenSec = (int)(end - start).TotalSeconds });
        }
        return day;
    }

    [AvaloniaFact]
    public Task Tiles_with_a_quick_break_taken() => Shoot("40-dashboard-tiles", Agent("12:41", a =>
    {
        a.Day = WithQuick(Days.General().WithRecord(Days.Taken("MORNING", "11:00", "11:16")), "10:05", 10, "10:14");
        a.Totals = new PresenceTotals { BreakSec = 25 * 60, MeetingSec = 30 * 60 };
    }));

    [AvaloniaFact]
    public Task Quick_break_running() => Shoot("40-dashboard-quick-running", Agent("10:44:20", a =>
        a.Day = WithQuick(Days.General(), "10:40", 10)));

    [AvaloniaFact]
    public Task Quick_break_over() => Shoot("40-dashboard-quick-over", Agent("10:52:40", a =>
        a.Day = WithQuick(Days.General(), "10:40", 10)));

    [AvaloniaFact]
    public Task Scheduled_break_with_pause() => Shoot("40-dashboard-on-break-pause", Agent("13:12:20", a =>
    {
        a.Day = Days.General().WithRecord(Days.Taken("MORNING", "11:00", "11:14")).WithActive(Days.Running("LUNCH", "13:01", 30));
        a.Presence = new CurrentPresence { Status = PresenceStatus.Lunch, Since = Ist.At("13:01") };
    }));

    [AvaloniaFact]
    public Task Paused_break() => Shoot("40-dashboard-paused", Agent("13:25", a =>
    {
        var paused = Days.Running("LUNCH", "13:01", 30);
        paused.InProgress = false;
        paused.State = BreakStates.Paused;
        paused.Segments.Add(new BreakSegment { StartedAt = Ist.At("13:01").ToUniversalTime(), EndedAt = Ist.At("13:13").ToUniversalTime() });
        a.Day = Days.General().WithRecord(Days.Taken("MORNING", "11:00", "11:14")).WithRecord(paused);
    }));

    [AvaloniaFact]
    public Task Offline_with_actions_waiting() => Shoot("40-dashboard-offline", Agent("10:47", a =>
    {
        a.PendingActions = 3;
        a.Online = false;
    }));

    [AvaloniaFact]
    public Task Menu_open_admin() => Shoot("40-dashboard-menu-admin", Agent("10:47", a => a.User!.Role = "ADMIN"),
        vm => { vm.Refresh(); vm.IsMenuOpen = true; return Task.CompletedTask; });

    [AvaloniaFact]
    public Task Menu_open_staff() => Shoot("40-dashboard-menu-staff", Agent("10:47"),
        vm => { vm.IsMenuOpen = true; return Task.CompletedTask; });

    [AvaloniaFact]
    public Task Away_status_on_the_dashboard() => Shoot("40-dashboard-away", Agent("14:28", a => a.AwaySince = Ist.At("14:05")));

    [AvaloniaFact]
    public Task History() => Shoot("40-history", Agent("10:47", a => a.HistoryFor = _ => (Months.October(), true)),
        vm => vm.ShowHistoryCommand.ExecuteAsync(null), height: 760);

    [AvaloniaFact]
    public Task History_behind_offline() => Shoot("40-history-behind-offline", Agent("10:47", a => a.HistoryFor = _ => (Months.October(behind: true), false)),
        vm => vm.ShowHistoryCommand.ExecuteAsync(null), height: 760);

    [AvaloniaFact]
    public Task History_unavailable() => Shoot("40-history-unavailable", Agent("10:47", a => a.HistoryFor = _ => (null, false)),
        vm => vm.ShowHistoryCommand.ExecuteAsync(null));

    [AvaloniaFact]
    public Task Instructions() => Shoot("40-instructions", Agent("10:47"),
        vm => { vm.ShowInstructionsCommand.Execute(null); return Task.CompletedTask; }, height: 1460);

    [AvaloniaFact]
    public Task Instructions_default_size() => Shoot("40-instructions-1080x700", Agent("10:47"),
        vm => { vm.ShowInstructionsCommand.Execute(null); return Task.CompletedTask; });

    // ---- Dialogs ------------------------------------------------------------------------------

    private static Func<DashboardViewModel, Task> Overlay(DialogViewModel dialog) => vm => { vm.Overlay = dialog; return Task.CompletedTask; };

    [AvaloniaFact]
    public Task Quick_break_dialog()
    {
        var dialog = new BreakActions(new FakeAgent("10:47"), new FakeDialogs(), NullLog.Instance).QuickDialog();
        dialog.Choices[1].PickCommand.Execute(null);
        return Shoot("40-dialog-quick-break", Agent("10:47"), Overlay(dialog));
    }

    [AvaloniaFact]
    public Task End_break_dialog()
    {
        var agent = Agent("13:18", a => a.Day = Days.General().WithActive(Days.Running("LUNCH", "13:00", 30)));
        var dialog = new BreakActions(agent, new FakeDialogs(), NullLog.Instance).ConfirmEnd(agent.BreakPanel.Active!);
        return Shoot("40-dialog-end-break", agent, Overlay(dialog));
    }

    [AvaloniaFact]
    public Task End_paused_break_dialog()
    {
        var agent = Agent("13:25");
        var paused = Days.Running("LUNCH", "13:01", 30);
        paused.InProgress = false;
        paused.State = BreakStates.Paused;
        paused.Segments.Add(new BreakSegment { StartedAt = Ist.At("13:01").ToUniversalTime(), EndedAt = Ist.At("13:13").ToUniversalTime() });
        agent.Day = Days.General().WithRecord(paused);
        var dialog = new BreakActions(agent, new FakeDialogs(), NullLog.Instance).ConfirmEnd(null, agent.BreakPanel.Paused);
        return Shoot("40-dialog-end-paused", agent, Overlay(dialog));
    }

    [AvaloniaFact]
    public Task Sign_out_syncing() => Shoot("40-dialog-sign-out-syncing", Agent("18:40"),
        Overlay(new ProgressDialogViewModel("Syncing 3 actions…", "Sending what you did to RX Vision before you sign out.")));

    [AvaloniaFact]
    public Task Sign_out_key() => Shoot("40-dialog-sign-out-key", Agent("18:40"),
        Overlay(new KeyDialogViewModel("Enter the sign-out key", "Your admin creates sign-out keys in the RX Vision portal. A key works for 24 hours.", "Sign out")
        {
            IsDanger = true, Key = "amber orbit cedar river lamp 24", Error = "That key isn't valid for you. Check it with your admin.",
        }));

    [AvaloniaFact]
    public Task Sign_out_confirm() => Shoot("40-dialog-sign-out-confirm", Agent("18:40"),
        Overlay(new MessageDialogViewModel("Sign out of RX Vision?",
            "Signing out needs a key from your admin and an internet connection: everything you did is sent to RX Vision first. Tracking stops until you sign in again.")
        { PrimaryText = "Continue", CancelText = "Cancel" }));

    [AvaloniaFact]
    public Task Meeting_dialog_with_minutes()
    {
        var agent = Agent("10:20");
        var actions = new BreakActions(agent, new FakeDialogs(), NullLog.Instance);
        var dialog = new MeetingDialogViewModel(actions.MeetingContext()) { Agenda = "Sprint planning for the invoice release" };
        dialog.LoadSuggestionsAsync().GetAwaiter().GetResult();
        dialog.Suggestions.First(s => s.Label == "+ Maya Reddy").AddCommand.Execute(null);
        dialog.MomIsMeCommand.Execute(null);
        return Shoot("40-dialog-meeting-minutes", agent, Overlay(dialog), height: 760);
    }

    // ---- The away pop-up ------------------------------------------------------------------------

    private static void ShootAway(AwayViewModel vm, string name)
    {
        var window = new AwayWindow { DataContext = vm };
        window.Show();
        DashboardHarness.Settle();
        var path = Shots.Save(window, name);
        Assert.True(new FileInfo(path).Length > 5_000, $"{name} looks empty");
        window.AllowClose = true;
        window.Close();
    }

    private static (AwayViewModel Vm, FakeAgent Agent) Away()
    {
        var agent = new FakeAgent("14:28") { AwaySince = Ist.At("14:05") };
        return (new AwayViewModel(agent, NullLog.Instance), agent);
    }

    [AvaloniaFact]
    public void Away_asking()
    {
        var (vm, _) = Away();
        ShootAway(vm, "40-away-ask");
    }

    [AvaloniaFact]
    public void Away_thinking()
    {
        var (vm, _) = Away();
        vm.Reasons.Single(r => r.Label == "Thinking").PickCommand.Execute(null);
        vm.Comment = "Planning the release checklist";
        ShootAway(vm, "40-away-thinking");
    }

    [AvaloniaFact]
    public void Away_meeting()
    {
        var (vm, _) = Away();
        vm.Reasons.Single(r => r.Label == "Short meeting").PickCommand.Execute(null);
        vm.ParticipantsText = "Maya Reddy, Ravi";
        vm.Summary = "Stand-up with the QA team";
        vm.Error = "Add who will mail the minutes.";
        ShootAway(vm, "40-away-meeting");
    }

    [AvaloniaFact]
    public async Task Away_on_a_break_and_confirm_end()
    {
        var (vm, agent) = Away();
        agent.AwayOutcomes.Enqueue(new AwayOutcome.OnBreak());
        vm.Reasons.Single(r => r.Label == "Took a break").PickCommand.Execute(null);
        await vm.SubmitCommand.ExecuteAsync(null);
        var day = Days.General();
        day.ActiveBreak = new BreakRecord
        {
            Id = "local:q", Kind = BreakKinds.Quick, Label = "Away break", PresenceType = "BREAK",
            StartedAt = Ist.At("14:05").ToUniversalTime(), InProgress = true, Timing = "UNSCHEDULED", ApprovalStatus = "NOT_REQUIRED",
        };
        day.Quick.Add(new QuickBreakView { Id = "local:q", StartedAt = Ist.At("14:05").ToUniversalTime() });
        agent.Day = day;
        vm.Refresh();
        ShootAway(vm, "40-away-on-break");
        vm.EndBreakCommand.Execute(null);
        ShootAway(vm, "40-away-confirm-end");
    }

    // ---- Toasts ---------------------------------------------------------------------------------

    private static void ShootToast(ToastViewModel toast, string name)
    {
        var window = new ToastWindow { DataContext = toast, Animate = false };
        window.ShowBeside(new Avalonia.PixelRect(1690, 470, 88, 88), new Avalonia.PixelPoint(1734, 514));
        var path = Shots.Save(window, name);
        Assert.True(new FileInfo(path).Length > 3_000, $"{name} looks empty");
        window.Close();
    }

    [AvaloniaFact]
    public void Toast_action_refused() => ShootToast(
        Toasts.ActionRefused(new FakeAgent("10:53"), "Your lunch break couldn't start: its window had closed when it reached RX Vision.", () => { }),
        "40-toast-action-refused");

    [AvaloniaFact]
    public void Toast_quick_over()
    {
        var active = new ActiveBreakView(BreakKinds.Quick, "Quick break", "BREAK", 10, Ist.At("10:40"), TimeSpan.FromMinutes(11),
            TimeSpan.FromMinutes(-1), true, "−01:00", false, "NOT_REQUIRED", "UNSCHEDULED", Id: "q", IsQuick: true);
        ShootToast(Toasts.QuickOver(new FakeAgent("10:51"), active, () => { }, () => { }), "40-toast-quick-over");
    }
}
