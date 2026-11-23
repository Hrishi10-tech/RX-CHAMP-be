using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>Tiles and Today's breaks rows for every slot state, as the person reads them.</summary>
public class BreakViewModelTests
{
    private static (DashboardViewModel Vm, FakeAgent Agent) Dashboard(BreakDay? day, string now, AgentState state = AgentState.Running)
    {
        var agent = new FakeAgent(now) { Day = day, State = state };
        var vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), NullLog.Instance);
        vm.Refresh();
        return (vm, agent);
    }

    private static BreakRowViewModel Row(DashboardViewModel vm, string kind) => vm.Rows.Single(r => r.Kind == kind);

    [Fact]
    public void Upcoming_disables_the_tile_and_says_when_it_opens()
    {
        var (vm, _) = Dashboard(Days.General(), "10:20");
        Assert.Equal("Morning break", vm.NextTile.Value);
        Assert.Equal("At 11:00 AM · opens 10:30 AM", vm.NextTile.Caption);
        Assert.Equal("Morning break at 11:00 AM, opens 10:30 AM", vm.NextTile.ToolTip);
        Assert.Equal(TileLook.Disabled, vm.NextTile.Look);
        Assert.False(vm.NextTile.CanClick);
        Assert.False(vm.NextTile.Command!.CanExecute(null));

        var row = Row(vm, "MORNING");
        Assert.Equal(SlotState.Upcoming, row.State);
        Assert.Equal("Upcoming", row.PillText);
        Assert.Equal(Tone.Neutral, row.PillTone);
        Assert.Equal("Opens 10:30 AM · due 11:00 AM, 15 min", row.Detail);
    }

    [Fact]
    public void Open_early_can_start_and_warns_about_the_reason()
    {
        var (vm, _) = Dashboard(Days.General(), "10:47");
        Assert.Equal("Morning break", vm.NextTile.Value);
        Assert.Equal("Open now · 13 min early, reason needed", vm.NextTile.Caption);
        Assert.Equal(TileLook.Open, vm.NextTile.Look);
        Assert.Equal("Open", vm.NextTile.Chip);
        Assert.True(vm.NextTile.Command!.CanExecute(null));

        var row = Row(vm, "MORNING");
        Assert.Equal("Open", row.PillText);
        Assert.Equal(Tone.Open, row.PillTone);
        Assert.Equal("Take it now · 13 min early, reason needed", row.Detail);
    }

    [Fact]
    public void Due_is_highlighted_and_on_time()
    {
        var (vm, agent) = Dashboard(Days.General(), "10:59:30");
        Assert.Equal("Morning break", vm.NextTile.Value);
        Assert.Equal("Due now · on time, tap to start", vm.NextTile.Caption);
        Assert.Equal(TileLook.Due, vm.NextTile.Look);
        Assert.Equal("Due now", vm.NextTile.Chip);
        Assert.NotNull(agent.Ring);

        var row = Row(vm, "MORNING");
        Assert.True(row.IsCurrent);
        Assert.Equal("Due now", row.PillText);
        Assert.Equal(Tone.Due, row.PillTone);
        Assert.Equal("Take it now · on time until 11:04 AM", row.Detail);
    }

    [Fact]
    public void Open_late_can_start_with_a_reason()
    {
        var (vm, _) = Dashboard(Days.General(), "11:08");
        Assert.Equal("Morning break", vm.NextTile.Value);
        Assert.Equal("Open now · 8 min after its time, reason needed", vm.NextTile.Caption);
        Assert.Equal(TileLook.Open, vm.NextTile.Look);
        Assert.Equal("Take it now · a short note is needed", Row(vm, "MORNING").Detail);
    }

    [Fact]
    public void Late_without_a_reason_rule_says_so()
    {
        var (vm, _) = Dashboard(Days.General(new ShiftRules { ReasonOnLate = false }), "11:08");
        Assert.Equal("Open now · 8 min after its time", vm.NextTile.Caption);
        Assert.Equal("Take it now · 8 min after its time", Row(vm, "MORNING").Detail);
    }

    [Fact]
    public void In_progress_shows_the_countdown_panel_instead_of_tiles()
    {
        var (vm, _) = Dashboard(Days.General().WithActive(Days.Running("MORNING", "11:01")), "11:08:20");
        Assert.True(vm.IsOnBreak);
        Assert.Equal("MORNING BREAK", vm.ActiveBreak.Eyebrow);
        Assert.Equal("Started 11:01 AM", vm.ActiveBreak.Started);
        Assert.Equal("07:40", vm.ActiveBreak.Countdown);
        Assert.Equal("left", vm.ActiveBreak.Unit);
        Assert.Equal("Back by 11:16 AM. Your focus time is paused. Pause it if you need to step back in.", vm.ActiveBreak.Note);
        Assert.True(vm.ActiveBreak.CanPause);
        Assert.True(vm.PauseBreakCommand.CanExecute(null));
        Assert.Equal("On break", vm.ActiveBreak.StatusText);
        Assert.Equal("07:40", vm.ActiveBreak.Timer);
        Assert.Equal("left of your 15 min morning break", vm.ActiveBreak.TimerLine);
        Assert.Equal("Ends at 11:16 AM", vm.ActiveBreak.EndLine);
        Assert.False(vm.ShowTiles);

        var row = Row(vm, "MORNING");
        Assert.Equal("In progress", row.PillText);
        Assert.Equal(Tone.Active, row.PillTone);
        Assert.Equal("Started 11:01 AM · back by 11:16 AM", row.Detail);
        Assert.False(row.DetailIsAlert);
    }

    [Fact]
    public void Taken_shows_timing_approval_and_the_managers_note()
    {
        var day = Days.General().WithRecord(Days.Taken("MORNING", "11:42", "12:01", "LATE", "APPROVED", note: "OK this time", by: "Maya Reddy"));
        var (vm, _) = Dashboard(day, "12:10");
        var row = Row(vm, "MORNING");
        Assert.Equal(SlotState.Taken, row.State);
        Assert.Equal("After its time", row.PillText);
        Assert.Equal(Tone.Warn, row.PillTone);
        Assert.Equal("Approved", row.ApprovalText);
        Assert.Equal(Tone.Good, row.ApprovalTone);
        Assert.Equal("11:42 AM · Taken", row.RightText);
        Assert.Equal("11:42 AM to 12:01 PM · 19 min, 4 min extended", row.Detail);
        Assert.True(row.DetailIsAlert);
        Assert.Equal("Maya Reddy: OK this time", row.Note);

        // The tile moves on to lunch.
        Assert.Equal("Lunch break", vm.NextTile.Value);
        Assert.Equal("At 1:00 PM · opens 12:30 PM", vm.NextTile.Caption);
    }

    [Theory]
    [InlineData("ON_TIME", "NOT_REQUIRED", "On time", null)]
    [InlineData("EARLY", "PENDING", "Before its time", "Pending")]
    [InlineData("LATE", "REJECTED", "After its time", "Not approved")]
    public void Taken_chips(string timing, string approval, string pill, string? chip)
    {
        var day = Days.General().WithRecord(Days.Taken("MORNING", "11:00", "11:14", timing, approval));
        var (vm, _) = Dashboard(day, "12:10");
        var row = Row(vm, "MORNING");
        Assert.Equal(pill, row.PillText);
        Assert.Equal(chip, row.ApprovalText);
        Assert.Equal("11:00 AM to 11:14 AM · 14 min", row.Detail);
    }

    [Fact]
    public void A_window_that_closed_with_no_record_says_closed()
    {
        var (vm, _) = Dashboard(Days.General(), "12:10");
        var row = Row(vm, "MORNING");
        Assert.Equal(SlotState.Closed, row.State);
        Assert.Equal("Closed", row.PillText);
        Assert.Equal("Window closed at 12:00 PM", row.Detail);
        Assert.False(row.CanComment);
    }

    [Fact]
    public void Skipped_shows_the_reason_and_the_decision()
    {
        var day = Days.General().WithRecord(Days.Skip("MORNING", "11:02", auto: false, reason: "Client call until noon"));
        var (vm, _) = Dashboard(day, "12:10");
        var row = Row(vm, "MORNING");
        Assert.Equal(SlotState.Skipped, row.State);
        Assert.Equal("Skipped", row.PillText);
        Assert.Equal(Tone.Skip, row.PillTone);
        Assert.Equal("Pending", row.ApprovalText);
        Assert.Equal("Skipped at 11:02 AM · focus time kept counting", row.Detail);
        Assert.Equal("“Client call until noon”", row.Note);
        Assert.False(row.CanComment);
        Assert.Equal("morning-skip", row.RecordId);
    }

    [Fact]
    public void Auto_skipped_offers_a_comment_until_it_has_one()
    {
        var day = Days.General().WithRecord(Days.Skip("MORNING", "12:00", auto: true));
        var (vm, agent) = Dashboard(day, "12:10");
        var row = Row(vm, "MORNING");
        Assert.Equal(SlotState.AutoSkipped, row.State);
        Assert.Equal("Skipped for you", row.PillText);
        Assert.Equal(Tone.Warn, row.PillTone);
        Assert.Equal("Add a comment · skipped for you at 12:00 PM", row.Detail);
        Assert.True(row.CanComment);
        Assert.True(row.CommentCommand!.CanExecute(null));

        // Commented, then decided: the comment and the decision show instead.
        var commented = Days.Skip("MORNING", "12:00", auto: true, reason: "Demo ran long", approval: "APPROVED");
        commented.NeedsComment = false;
        commented.DecisionNote = "Fine";
        commented.DecidedByName = "Maya Reddy";
        agent.Day = Days.General().WithRecord(commented);
        vm.Refresh();
        Assert.False(row.CanComment);
        Assert.Equal("Skipped for you at 12:00 PM", row.Detail);
        Assert.Equal("Approved", row.ApprovalText);
        Assert.Equal("“Demo ran long” · Maya Reddy: Fine", row.Note);
    }

    [Fact]
    public void A_skip_does_not_close_the_breaks_before_it()
    {
        // The evening break was skipped early in its window; lunch is still owed and open.
        var day = Days.General().WithRecord(Days.Skip("EVENING", "15:40", auto: false, reason: "Leaving early today"));
        day.Breaks[1].WindowClose = Ist.At("16:30").ToUniversalTime();
        var (vm, _) = Dashboard(day, "15:45");
        Assert.Equal(SlotState.OpenLate, Row(vm, "LUNCH").State);
    }

    [Fact]
    public void Unavailable_after_lunch()
    {
        var day = Days.General().WithRecord(Days.Taken("LUNCH", "13:00", "13:30", duration: 30));
        day.Breaks[0].WindowClose = Ist.At("15:00").ToUniversalTime();
        var (vm, _) = Dashboard(day, "13:40");
        var row = Row(vm, "MORNING");
        Assert.Equal(SlotState.Unavailable, row.State);
        Assert.Equal("Unavailable", row.PillText);
        Assert.Equal("Not available after lunch", row.Detail);
    }

    [Fact]
    public void Nothing_left_today()
    {
        var (vm, _) = Dashboard(Days.General(), "17:30");
        Assert.Equal("None left today", vm.NextTile.Value);
        Assert.Equal("No more breaks · quick breaks still work", vm.NextTile.Caption);
        Assert.Equal(TileLook.Disabled, vm.NextTile.Look);
        Assert.False(vm.NextTile.CanClick);
        Assert.True(vm.QuickTile.CanClick);
    }

    [Fact]
    public void A_shift_without_lunch_goes_from_morning_to_evening()
    {
        var day = Days.General();
        day.Breaks.RemoveAt(1);
        var (vm, _) = Dashboard(day, "12:10");
        Assert.Equal("Evening break", vm.NextTile.Value);
        Assert.Equal("At 4:00 PM · opens 3:30 PM", vm.NextTile.Caption);
    }

    [Fact]
    public void Day_ended_dims_everything()
    {
        var day = Days.General();
        day.DayEnded = true;
        var (vm, _) = Dashboard(day, "10:47", AgentState.DayEnded);
        Assert.True(vm.IsDayEnded);
        Assert.Equal(0.45, vm.TilesOpacity);
        foreach (var tile in new[] { vm.QuickTile, vm.NextTile, vm.FocusTile, vm.MeetingTile })
        {
            Assert.False(tile.CanClick);
            Assert.Equal("Your day has ended", tile.Caption);
        }
        Assert.False(vm.EndDayCommand.CanExecute(null));
        Assert.True(vm.StartDayCommand.CanExecute(null));
        Assert.Equal("Day ended · nothing recorded", vm.SyncText);
        Assert.False(vm.IsRunning);
    }

    [Fact]
    public void Day_ended_shows_the_days_focus_and_how_it_ended()
    {
        var agent = new FakeAgent("18:40") { State = AgentState.DayEnded };
        var ended = Days.Open(startedAt: "09:24", serverNow: "18:31", focusSec: 7 * 3600 + 41 * 60, running: false);
        ended.State = WorkdayStates.Ended;
        ended.EndedAt = Ist.At("18:31").ToUniversalTime();
        agent.Workday = ended;
        var vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), NullLog.Instance);
        vm.Refresh();
        Assert.Equal("Your day ended at 6:31 PM.", vm.EndedTitle);
        Assert.Equal("Focus time today: 7h 41m. Nothing is recorded now. Still working? Tap Start day.", vm.EndedDetail);
        Assert.Equal("7h 41m", vm.Today.FocusText);
        Assert.Equal("Day ended at 6:31 PM", vm.Today.FocusStatus);
        Assert.Equal("Day started 9:24 AM", vm.DayStartedText);

        // Closed by the server (no End Day): it says so.
        ended.AutoClosed = true;
        vm.Refresh();
        Assert.Equal("Your day was closed at 6:31 PM.", vm.EndedTitle);
        Assert.Equal("Closed for you at 6:31 PM", vm.Today.FocusStatus);
    }

    [Fact]
    public void Free_mode_offers_a_break_or_lunch_any_time()
    {
        var (vm, agent) = Dashboard(Days.Free(), "10:47");
        Assert.False(vm.IsScheduled);
        Assert.Empty(vm.Rows);
        Assert.True(vm.ShowFreeText);
        Assert.Equal("Break or lunch", vm.NextTile.Value);
        Assert.Equal("Any time · tap to start", vm.NextTile.Caption);
        Assert.True(vm.NextTile.CanClick);
        Assert.Equal("No break schedule today. Take a break or lunch whenever you need one.", vm.FreeText);

        agent.Totals = new PresenceTotals { BreakSec = 12 * 60, LunchSec = 75 * 60 };
        vm.Refresh();
        Assert.Equal("12m", vm.Today.BreakTotal);
        Assert.Equal("1h 15m", vm.Today.LunchTotal);
    }

    [Fact]
    public void Focus_and_meeting_tiles()
    {
        var (vm, _) = Dashboard(Days.General(), "10:20");
        Assert.Equal(TileLook.Active, vm.FocusTile.Look);
        Assert.False(vm.FocusTile.CanClick);
        Assert.Equal("Working now", vm.FocusTile.Caption);
        Assert.Equal("1h 00m today", vm.FocusTile.Value); // the day's focus time, not activity
        Assert.True(vm.MeetingTile.CanClick);
        Assert.Equal("30m today", vm.MeetingTile.Value);
        Assert.Equal("Tap to start one", vm.MeetingTile.Caption);
        Assert.True(vm.ShowTiles);
        Assert.False(vm.IsInMeeting);
    }

    [Fact]
    public void In_a_meeting_the_panel_shows_its_timer_agenda_and_people()
    {
        var (vm, agent) = Dashboard(Days.General(), "10:20");
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = Ist.At("10:08"), Note = "Sprint review" };
        agent.LiveMeeting = new MeetingRecord
        {
            Id = "meet-1", Agenda = "Sprint review with the design team", StartedAt = Ist.At("10:08"), InProgress = true,
            Participants = { new MeetingParticipant("m-1", "Maya Reddy"), new MeetingParticipant(null, "Vikram (Pune)") },
        };
        vm.Refresh();
        Assert.True(vm.IsInMeeting);
        Assert.False(vm.ShowTiles);
        Assert.Equal("12:00", vm.MeetingTimer);
        Assert.Equal("Started 10:08 AM", vm.MeetingStarted);
        Assert.Equal("Sprint review with the design team", vm.MeetingAgenda);
        Assert.Equal(new[] { "MR", "VP" }, vm.MeetingPeople.Select(p => p.Initials));
        Assert.Equal("Maya Reddy, Vikram (Pune)", vm.MeetingPeopleText);
        Assert.Equal("In a meeting", vm.StatusText);
        Assert.Equal("Counting · in a meeting", vm.Today.FocusStatus);
        Assert.True(vm.EndMeetingCommand.CanExecute(null));

        // An older server (no meeting record): the presence note is the agenda.
        agent.LiveMeeting = null;
        vm.Refresh();
        Assert.Equal("Sprint review", vm.MeetingAgenda);
        Assert.Empty(vm.MeetingPeople);
        Assert.Equal("", vm.MeetingPeopleText);
    }

    [Fact]
    public void Header_and_sync()
    {
        var (vm, agent) = Dashboard(Days.General(), "10:47");
        Assert.Equal("Asha Kumar", vm.DisplayName);
        Assert.Equal("AK", vm.Initials);
        Assert.Equal("Working", vm.StatusText);
        Assert.Equal("Day started 9:24 AM", vm.DayStartedText);
        Assert.Equal(SyncTone.Ok, vm.SyncTone);
        Assert.Equal("Online · synced 10:44 AM", vm.SyncText);

        // SPEC 6: actions waiting, and whether RX Vision can be reached.
        agent.PendingActions = 3;
        agent.Online = false;
        vm.Refresh();
        Assert.Equal("Offline · 3 actions waiting", vm.SyncText);
        Assert.Equal(SyncTone.Pending, vm.SyncTone);

        agent.Online = true;
        vm.Refresh();
        Assert.Equal("Syncing · 3 actions waiting", vm.SyncText);

        agent.PendingActions = 1;
        agent.Online = false;
        vm.Refresh();
        Assert.Equal("Offline · 1 action waiting", vm.SyncText);

        agent.PendingActions = 0;
        vm.Refresh();
        Assert.Equal("Offline · synced 10:44 AM", vm.SyncText);

        agent.Online = true;
        agent.LastSyncAt = Ist.At("10:46");
        vm.Refresh();
        Assert.Equal("Online · synced 10:46 AM", vm.SyncText);
        Assert.Equal(SyncTone.Ok, vm.SyncTone);
    }

    [Fact]
    public void Update_banner_when_it_cannot_install_itself()
    {
        var (vm, agent) = Dashboard(Days.General(), "10:47");
        Assert.False(vm.HasUpdate);
        agent.PendingUpdate = new Core.Update.UpdateOffer("3.1.0", 1000, CanInstall: false);
        vm.Refresh();
        Assert.True(vm.HasUpdate);
        Assert.Contains("3.1.0", vm.UpdateText);
        Assert.Equal("Download", vm.DownloadLabel);

        // The agent saves the verified build itself (a browser link would need its sign-in).
        vm.DownloadUpdateCommand.Execute(null);
        Assert.Equal(1, agent.DownloadCalls);
        Assert.Empty(agent.Dev.OpenedUrls);
        Assert.Equal("/home/asha/Downloads/RXVision-3.1.0.exe", Assert.Single(agent.Dev.RevealedFiles));
        Assert.Contains("Downloads folder", vm.UpdateText);
        Assert.Equal("Show file", vm.DownloadLabel);

        vm.DismissUpdateCommand.Execute(null);
        vm.Refresh();
        Assert.False(vm.HasUpdate);
    }

    [Fact]
    public void Update_download_failure_says_why_and_offers_a_retry()
    {
        var (vm, agent) = Dashboard(Days.General(), "10:47");
        agent.PendingUpdate = new Core.Update.UpdateOffer("3.1.0", 1000, CanInstall: false);
        agent.DownloadResult = new Core.Update.ManualDownload(null, "Try again in a moment.");
        vm.Refresh();
        vm.DownloadUpdateCommand.Execute(null);
        Assert.Equal("Try again in a moment.", vm.UpdateText);
        Assert.Equal("Try again", vm.DownloadLabel);
        Assert.Empty(agent.Dev.RevealedFiles);
        Assert.True(vm.DownloadUpdateCommand.CanExecute(null));
    }

    [Fact]
    public void Business_times_ignore_this_machines_zone()
    {
        // The facade learns the offset from the day itself; the fake mirrors IST.
        var agent = new FakeAgent("11:08");
        Assert.Equal("11:16 AM", agent.BusinessTime(Ist.At("11:16")));
    }
}

/// <summary>Screens B, C and F: the countdown, then the timer counting up from zero in amber, and a break with no length.</summary>
public class ActiveBreakTests
{
    private static ActiveBreakViewModel At(string now, BreakDay day, int workedSec = 0, string? approver = "a manager")
    {
        var view = BreakSchedule.Compute(day, Ist.At(now)).Active!;
        var vm = new ActiveBreakViewModel();
        vm.Update(view, t => Core.Util.Clock12.Format(t.ToOffset(Ist.Offset)), approver, workedSec, 8 * 3600, Ist.At(now));
        return vm;
    }

    [Fact]
    public void Counts_down_from_the_break_length()
    {
        var day = Days.General().WithActive(Days.Running("MORNING", "11:00"));
        var start = At("11:00", day);
        Assert.Equal("15:00", start.Timer);
        Assert.Equal("left of your 15 min morning break", start.TimerLine);
        Assert.Equal(0, start.Progress, 3);
        Assert.False(start.IsOverrun);

        var mid = At("11:05", day);
        Assert.Equal("10:00", mid.Timer);
        Assert.Equal(1 / 3.0, mid.Progress, 3);
        Assert.Equal("Ends at 11:15 AM", mid.EndLine);
        Assert.Null(mid.ExtraMinutes);
    }

    [Fact]
    public void Past_its_length_it_counts_up_from_zero_and_says_when_it_ended()
    {
        var day = Days.General().WithActive(Days.Running("MORNING", "11:00"));
        Assert.Equal("00:00", At("11:15", day).Timer);
        var over = At("11:17:10", day);
        Assert.True(over.IsOverrun);
        Assert.Equal("Break extended", over.StatusText);
        Assert.Equal("02:10", over.Timer); // up from zero: no minus sign, no red
        Assert.Equal("Break extended · 02:10", over.OneLine);
        Assert.Equal("Your morning break ended at 11:15 AM.", over.TimerLine);
        Assert.Equal("Resume work to start your ring again.", over.EndLine);
        Assert.Equal(1, over.Progress);
        // 4.0: no "ask your manager to count them"; the buffer takes the minutes over.
        Assert.Equal("Minutes over come out of your paid buffer first, then count as unpaid break.", over.Note);
    }

    [Fact]
    public void A_start_after_its_time_is_labelled_and_pending()
    {
        var day = Days.General().WithActive(Days.Running("MORNING", "11:42", timing: "LATE", approval: "PENDING"));
        var vm = At("11:45", day);
        Assert.Equal("Morning break · after its time", vm.TimingLine);
        Assert.Equal("Sent to a manager for approval", vm.Approval);
    }

    [Fact]
    public void An_early_start_says_so_and_on_time_says_nothing()
    {
        Assert.Equal("Morning break · early", At("10:50", Days.General().WithActive(Days.Running("MORNING", "10:45", timing: "EARLY"))).TimingLine);
        Assert.Null(At("11:05", Days.General().WithActive(Days.Running("MORNING", "11:00"))).TimingLine);
    }

    [Fact]
    public void Lunch_names_itself_and_counts_down_the_same_way()
    {
        var day = Days.General().WithActive(Days.Running("LUNCH", "13:00", duration: 45));
        var vm = At("13:12:42", day, 3 * 3600 + 30 * 60);
        Assert.Equal("32:18", vm.Timer);
        Assert.Equal("left of your 45 min lunch break", vm.TimerLine);
        Assert.Equal("Ends at 1:45 PM", vm.EndLine);
        Assert.Equal("Ring paused at 3h 30m", vm.RingPaused);
        Assert.Equal("It starts again when you resume.", vm.RingLine);
    }

    [Fact]
    public void A_break_with_no_length_has_no_countdown_end_or_extension()
    {
        var day = Days.Free();
        day.ActiveBreak = new BreakRecord { Id = "x", Label = "Break", PresenceType = "BREAK", StartedAt = Ist.At("10:00").ToUniversalTime(), InProgress = true, Timing = "UNSCHEDULED" };
        var vm = At("10:34:10", day, 3600);
        Assert.False(vm.HasLength);
        Assert.False(vm.IsOverrun);
        Assert.False(vm.EndsSoon);
        Assert.Equal("34 min so far", vm.SoFar);
        Assert.Equal("On break", vm.StatusText);
        Assert.Equal("Ring paused at 1h 00m", vm.RingPaused);
        Assert.Equal("1h 05m so far", At("11:05:40", day).SoFar);
    }
}

public class FmtTests
{
    [Theory]
    [InlineData(0, "0m")]
    [InlineData(29, "0m")]
    [InlineData(36, "1m")]
    [InlineData(175, "3m")]
    [InlineData(59 * 60 + 40, "1h 00m")]
    [InlineData(65 * 60, "1h 05m")]
    [InlineData(-30, "0m")]
    public void Durations_read_to_the_nearest_minute(int seconds, string expected) =>
        Assert.Equal(expected, Fmt.Duration(seconds));

    [Theory]
    [InlineData(0, "0 min")]
    [InlineData(26, "under 1 min")]
    [InlineData(108, "1 min")]
    [InlineData(228, "3 min")]
    [InlineData(65 * 60, "1 h 5 min")]
    [InlineData(120 * 60, "2 h")]
    public void Finished_breaks_count_like_a_timer_as_the_portal_does(int seconds, string expected) =>
        Assert.Equal(expected, Fmt.Timer(seconds));

    [Fact]
    public void Running_time_and_initials()
    {
        Assert.Equal("4m 05s", Fmt.Running(TimeSpan.FromSeconds(245)));
        Assert.Equal("1h 02m", Fmt.Running(TimeSpan.FromMinutes(62)));
        Assert.Equal("MR", Fmt.Initials("Maya Reddy"));
        Assert.Equal("VP", Fmt.Initials("Vikram (Pune)"));
        Assert.Equal("K", Fmt.Initials("kavya"));
        Assert.Equal("?", Fmt.Initials("  "));
        Assert.Equal("?", Fmt.Initials("( )"));
    }

    [Theory]
    [InlineData(0, "0m")]
    [InlineData(59, "0m")]
    [InlineData(45 * 60 + 59, "45m")]
    [InlineData(4 * 3600 + 5 * 60 + 40, "4h 05m")]
    [InlineData(-20, "0m")]
    public void Focus_time_never_shows_a_minute_not_yet_worked(int seconds, string expected) =>
        Assert.Equal(expected, Fmt.Focus(seconds));

    [Fact]
    public void Effects_greetings_and_names()
    {
        Assert.Equal("+15 min", Fmt.PlusMinutes(15));
        Assert.Equal("−15 min", Fmt.MinusMinutes(15));
        Assert.Equal(0, Fmt.EffectMinutes(0));
        Assert.Equal(1, Fmt.EffectMinutes(20));
        Assert.Equal(15, Fmt.EffectMinutes(15 * 60));
        Assert.Equal("8h", Fmt.Hours(8 * 3600));
        Assert.Equal("7h 30m", Fmt.Hours(7 * 3600 + 30 * 60));
        Assert.Equal("Good morning", Fmt.Greeting(Ist.At("08:55")));
        Assert.Equal("Good afternoon", Fmt.Greeting(Ist.At("12:00")));
        Assert.Equal("Good evening", Fmt.Greeting(Ist.At("17:30")));
        Assert.Equal("Good morning", Fmt.Greeting(0));
        Assert.Equal("Good morning", Fmt.Greeting(11));
        Assert.Equal("Good afternoon", Fmt.Greeting(16));
        Assert.Equal("Good evening", Fmt.Greeting(23));
        Assert.Equal("Asha", Fmt.FirstName("asha Kumar"));
        Assert.Equal("Asha", Fmt.FirstName("asha@timechamp.test"));
        Assert.Equal("", Fmt.FirstName(null));
        Assert.Equal("1 approval", Fmt.Count(1, "approval", "approvals"));
        Assert.Equal("3 approvals", Fmt.Count(3, "approval", "approvals"));
    }
}
