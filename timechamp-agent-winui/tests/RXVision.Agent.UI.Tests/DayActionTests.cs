using Avalonia.Headless.XUnit;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>Start Day, End Day (with its two gates) and meetings, as flows over scripted dialogs.</summary>
public class DayActionTests
{
    private static (BreakActions Actions, FakeAgent Agent, FakeDialogs Dialogs) Setup(string now, string role = "USER")
    {
        var agent = new FakeAgent(now);
        agent.User!.Role = role;
        var dialogs = new FakeDialogs();
        return (new BreakActions(agent, dialogs, NullLog.Instance), agent, dialogs);
    }

    // ---- Start Day ------------------------------------------------------------------------

    [Fact]
    public async Task Start_Day_starts_with_no_dialog()
    {
        var (actions, agent, dialogs) = Setup("09:20");
        agent.State = AgentState.NotStarted;
        await actions.StartDayAsync();
        Assert.Equal(1, agent.StartDayCalls);
        Assert.Equal(AgentState.Running, agent.State);
        Assert.Empty(dialogs.Shown);
    }

    [Fact]
    public async Task Start_Day_offline_starts_at_once_with_no_dialog()
    {
        // SPEC 6: the press is kept on this computer and the day runs from it; it is sent later.
        var (actions, agent, dialogs) = Setup("09:20");
        agent.State = AgentState.NotStarted;
        agent.Online = false;
        await actions.StartDayAsync();
        Assert.Equal(1, agent.StartDayCalls);
        Assert.Equal(AgentState.Running, agent.State);
        Assert.Empty(dialogs.Shown);
    }

    [Fact]
    public async Task Start_Day_refused_says_why()
    {
        var (actions, agent, dialogs) = Setup("09:20");
        agent.State = AgentState.DayEnded;
        agent.StartDayOutcomes.Enqueue(new StartDayOutcome.Refused("FORBIDDEN", "Your account can't start a day."));
        dialogs.Answer(_ => true);
        await actions.StartDayAsync();
        var alert = Assert.IsType<MessageDialogViewModel>(Assert.Single(dialogs.Shown));
        Assert.Equal("Couldn't start your day", alert.Title);
        Assert.Equal("Your account can't start a day.", alert.Message);
    }

    [Fact]
    public async Task Start_Day_does_nothing_while_the_day_runs()
    {
        var (actions, agent, dialogs) = Setup("09:20");
        await actions.StartDayAsync();
        Assert.Equal(0, agent.StartDayCalls);
        Assert.Empty(dialogs.Shown);
    }

    // ---- End Day ----------------------------------------------------------------------------

    [Fact]
    public async Task End_Day_with_nothing_to_comment_confirms()
    {
        var (actions, agent, dialogs) = Setup("18:32");
        dialogs.Answer(d =>
        {
            var confirm = Assert.IsType<MessageDialogViewModel>(d);
            Assert.Equal("End your working day?", confirm.Title);
            Assert.Equal("Your focus time stops now and today's day is saved as it is. If you need to, you can start your day again from here.", confirm.Message);
            Assert.Equal("End Day", confirm.PrimaryText);
            Assert.Equal("Keep working", confirm.CancelText);
            Assert.True(confirm.IsDanger);
            return false;
        });
        await actions.EndDayAsync();
        Assert.Empty(agent.EndDayCalls);

        dialogs.Answer(_ => true);
        await actions.EndDayAsync();
        Assert.Null(Assert.Single(agent.EndDayCalls));
        Assert.Equal(AgentState.DayEnded, agent.State);
    }

    [Fact]
    public async Task End_Day_offline_ends_the_day_with_no_retry_dialog()
    {
        var (actions, agent, dialogs) = Setup("18:32");
        agent.Online = false;
        dialogs.Answer(_ => true);
        await actions.EndDayAsync();
        Assert.Single(agent.EndDayCalls);
        Assert.Equal(AgentState.DayEnded, agent.State);
        Assert.Equal("End your working day?", Assert.Single(dialogs.Shown).Title);
    }

    [Fact]
    public async Task End_Day_with_the_away_pop_up_open_says_that_time_stays_out()
    {
        var (actions, agent, dialogs) = Setup("18:32");
        agent.AwaySince = Ist.At("18:20");
        dialogs.Answer(_ => true);
        await actions.EndDayAsync();
        var confirm = Assert.IsType<MessageDialogViewModel>(Assert.Single(dialogs.Shown));
        Assert.Contains("away time you haven't explained stays out of your focus time", confirm.Message);
    }

    [Fact]
    public async Task End_Day_lists_every_skipped_break_with_its_own_box()
    {
        var (actions, agent, dialogs) = Setup("18:32");
        agent.Workday!.SkipsNeedingComment.AddRange(new[]
        {
            Days.NeedsComment("EVENING", "17:00"),
            Days.NeedsComment("MORNING", "12:00"),
            Days.NeedsComment("LUNCH", "14:00", date: "2026-10-12"),
        });
        dialogs.Answer(d =>
        {
            var end = Assert.IsType<EndDayDialogViewModel>(d);
            Assert.Equal("Before you end the day", end.Title);
            Assert.Equal("3 skipped breaks need a comment. Each goes to your manager with your comment.", end.Message);
            Assert.Equal("End Day", end.PrimaryText);
            Assert.Equal("Not now", end.CancelText);
            Assert.Equal(new[] { "Evening break", "Morning break", "Lunch break" }, end.Items.Select(i => i.Name));
            Assert.Equal(new[] { "Auto-skipped at 5:00 PM", "Auto-skipped at 12:00 PM", "Auto-skipped at 2:00 PM on 12 Oct" }, end.Items.Select(i => i.When));
            // Three show whole (no scrolling); lunch has the lunch icon.
            Assert.Equal(double.PositiveInfinity, end.ListMaxHeight);
            Assert.Equal(new[] { false, false, true }, end.Items.Select(i => i.IsLunch));

            // End Day waits for every box.
            Assert.False(end.SubmitCommand.CanExecute(null));
            end.Items[0].Text = "Stayed on the release call";
            end.Items[1].Chips.First(c => c.Label == "Client call").PickCommand.Execute(null);
            Assert.False(end.SubmitCommand.CanExecute(null));
            end.Items[2].Text = "short";
            Assert.False(end.Items[2].CountOk);
            Assert.Equal("Required. 10 characters or more.", end.Items[2].Help);
            Assert.False(end.SubmitCommand.CanExecute(null));
            end.Items[2].Text = "Lunch with the client";
            Assert.Equal("Looks good", end.Items[2].Help);
            Assert.True(end.SubmitCommand.CanExecute(null));
            return true;
        });
        await actions.EndDayAsync();
        var sent = Assert.Single(agent.EndDayCalls)!;
        Assert.Equal(new[]
        {
            ("evening-auto", "Stayed on the release call"),
            ("morning-auto", "Client call"),
            ("lunch-auto", "Lunch with the client"),
        }, sent.Select(c => (c.BreakId, c.Comment)));
    }

    [Fact]
    public async Task End_Day_not_now_keeps_the_day_running()
    {
        var (actions, agent, dialogs) = Setup("18:32");
        agent.Workday!.SkipsNeedingComment.Add(Days.NeedsComment("MORNING", "12:00"));
        dialogs.Answer(_ => false);
        await actions.EndDayAsync();
        Assert.Empty(agent.EndDayCalls);
        Assert.Equal(AgentState.Running, agent.State);
    }

    [Fact]
    public async Task End_Day_asked_for_comments_by_the_server_lists_them_and_keeps_what_was_typed()
    {
        var (actions, agent, dialogs) = Setup("18:32");
        agent.EndDayOutcomes.Enqueue(new EndDayOutcome.CommentsRequired(new[] { Days.NeedsComment("EVENING", "17:00") }, "x"));
        agent.EndDayOutcomes.Enqueue(new EndDayOutcome.CommentInvalid("evening-auto", 25, "Add a little more. 25 characters or more."));
        dialogs
            .Answer(_ => true) // the plain confirmation: nothing was known to need a comment
            .Answer(d =>
            {
                var end = Assert.IsType<EndDayDialogViewModel>(d);
                Assert.Equal("1 skipped break needs a comment. It goes to your manager with your comment.", end.Message);
                end.Items[0].Text = "Release call ran late";
                return true;
            })
            .Answer(d =>
            {
                var end = Assert.IsType<EndDayDialogViewModel>(d);
                var item = Assert.Single(end.Items);
                Assert.Equal("Release call ran late", item.Text);
                Assert.Equal("Add a little more. 25 characters or more.", item.Error);
                Assert.Equal(25, item.MinChars);
                Assert.False(end.SubmitCommand.CanExecute(null));
                item.Text = "Release call with Pune ran late";
                Assert.Null(item.Error); // typing clears the server's note
                return true;
            });
        await actions.EndDayAsync();
        Assert.Equal(3, agent.EndDayCalls.Count);
        Assert.Null(agent.EndDayCalls[0]);
        Assert.Equal("Release call ran late", Assert.Single(agent.EndDayCalls[1]!).Comment);
        Assert.Equal("Release call with Pune ran late", Assert.Single(agent.EndDayCalls[2]!).Comment);
        Assert.Equal(AgentState.DayEnded, agent.State);
    }

    [Theory]
    [InlineData("NOT_FOUND")]
    [InlineData("NOT_A_SKIP")]
    [InlineData("NOT_YOURS")]
    public async Task End_Day_sends_the_others_again_when_a_break_no_longer_takes_a_comment(string problem)
    {
        var (actions, agent, dialogs) = Setup("18:32");
        agent.Workday!.SkipsNeedingComment.AddRange(new[] { Days.NeedsComment("EVENING", "17:00"), Days.NeedsComment("MORNING", "12:00") });
        // The server says the morning's break cannot take a comment (the list was stale): typing cannot fix that.
        agent.EndDayOutcomes.Enqueue(new EndDayOutcome.CommentInvalid("morning-auto", null, "One of the comments is for a break that cannot take it.", problem));
        dialogs.Answer(d =>
        {
            var end = Assert.IsType<EndDayDialogViewModel>(d);
            end.Items[0].Text = "Release call ran late";
            end.Items[1].Text = "Client call ran long";
            return true;
        });
        await actions.EndDayAsync();
        Assert.Equal(2, agent.EndDayCalls.Count);
        Assert.Equal(new[] { "evening-auto", "morning-auto" }, agent.EndDayCalls[0]!.Select(c => c.BreakId));
        Assert.Equal(new[] { ("evening-auto", "Release call ran late") }, agent.EndDayCalls[1]!.Select(c => (c.BreakId, c.Comment)));
        Assert.Single(dialogs.Shown);   // no second dialog with a box nobody could satisfy
        Assert.Equal(AgentState.DayEnded, agent.State);
    }

    [Fact]
    public void Reasons_and_comments_count_as_the_server_does_with_a_run_of_spaces_as_one()
    {
        // The server collapses runs of whitespace before it counts ("Too    short" is 9),
        // so the boxes count the same way and never let a too-short text through.
        var item = new SkipCommentItemViewModel("evening-auto", "Evening break", "Auto-skipped at 17:00", 10, new[] { "Client call" });
        item.Text = "  Too    short  ";
        Assert.Equal(("Too short", false), (item.Comment, item.CountOk));
        Assert.Equal("Required. 10 characters or more.", item.Help);
        item.Text = "Too    short\n\tfor them";
        Assert.Equal(("Too short for them", true), (item.Comment, item.CountOk));
        item.Text = " Client   call ";
        Assert.True(item.Chips[0].IsOn);

        var reason = new ReasonDialogViewModel("Skip the morning break", "Why?", 10) { Text = "a        b" };
        Assert.Equal((3, false), (reason.Length, reason.CountOk));
        Assert.Equal("7 more characters", reason.CountText);
        reason.Text = "Client     call ";
        Assert.Equal(("Client call", 11, true), (reason.Reason, reason.Length, reason.CountOk));
    }

    [Fact]
    public async Task End_Day_blocked_by_overdue_approvals_opens_the_portal()
    {
        var (actions, agent, dialogs) = Setup("18:32", role: "MANAGER");
        agent.EndDayOutcomes.Enqueue(new EndDayOutcome.ApprovalsOverdue(3, Ist.At("09:00").AddDays(-3), "x"));
        dialogs
            .Answer(_ => true)
            .Answer(d =>
            {
                var overdue = Assert.IsType<MessageDialogViewModel>(d);
                Assert.Equal("Approvals are past 48 hours", overdue.Title);
                Assert.Equal("3 approvals are past 48 hours. Decide them in the portal to end your day.", overdue.Message);
                Assert.Equal("Open approvals", overdue.PrimaryText);
                Assert.Equal("Close", overdue.CancelText);
                return true;
            });
        await actions.EndDayAsync();
        Assert.Equal("https://app.rxvision.shop/dashboard/approvals", Assert.Single(agent.Dev.OpenedUrls));
        Assert.Equal(AgentState.Running, agent.State);
        Assert.Single(agent.EndDayCalls);
    }

    [Fact]
    public async Task End_Day_blocked_with_no_portal_says_where_to_go()
    {
        var (actions, agent, dialogs) = Setup("18:32", role: "MANAGER");
        agent.Workday!.PortalUrl = null;
        agent.Workday.Settings.ApprovalSlaHours = 24;
        agent.EndDayOutcomes.Enqueue(new EndDayOutcome.ApprovalsOverdue(1, null, "x"));
        dialogs.Answer(_ => true).Answer(_ => true);
        await actions.EndDayAsync();
        var alert = Assert.IsType<MessageDialogViewModel>(dialogs.Shown[^1]);
        Assert.Equal("Approvals are past 24 hours", alert.Title);
        Assert.Equal("1 approval is past 24 hours. Open the RX Vision portal and decide them to end your day.", alert.Message);
        Assert.False(alert.HasCancel);
        Assert.Empty(agent.Dev.OpenedUrls);
    }

    [Theory]
    [InlineData("https://app.rxvision.shop", "https://app.rxvision.shop/dashboard/approvals")]
    [InlineData("https://app.rxvision.shop/", "https://app.rxvision.shop/dashboard/approvals")]
    [InlineData(" https://portal.example.com/rxv/ ", "https://portal.example.com/rxv/dashboard/approvals")]
    [InlineData("http://localhost:3000", "http://localhost:3000/dashboard/approvals")]
    [InlineData("javascript:alert(1)", null)]
    [InlineData("file:///etc/passwd", null)]
    [InlineData("not a url", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void The_approvals_address(string? portal, string? expected) =>
        Assert.Equal(expected, BreakActions.ApprovalsUrl(portal));

    [Fact]
    public async Task End_Day_waits_for_a_break_or_a_meeting_to_finish()
    {
        var (actions, agent, dialogs) = Setup("11:05");
        agent.Day = Days.General().WithActive(Days.Running("MORNING", "11:00"));
        dialogs.Answer(_ => true);
        await actions.EndDayAsync();
        Assert.Equal(("Finish this first", "End your break, then end your day."),
            (dialogs.Shown[0].Title, ((MessageDialogViewModel)dialogs.Shown[0]).Message));

        agent.Day = Days.General();
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting };
        dialogs.Answer(_ => true);
        await actions.EndDayAsync();
        Assert.Equal("Tap End meeting, then end your day.", ((MessageDialogViewModel)dialogs.Shown[1]).Message);
        Assert.Empty(agent.EndDayCalls);
    }

    // ---- Meetings -----------------------------------------------------------------------------

    [Fact]
    public async Task Meeting_cancel_starts_nothing()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        dialogs.Answer(d =>
        {
            var meeting = Assert.IsType<MeetingDialogViewModel>(d);
            Assert.Equal("Start a meeting", meeting.Title);
            Assert.False(meeting.SubmitCommand.CanExecute(null)); // the agenda is required
            Assert.Equal("Add what the meeting is about.", meeting.Problem);
            return false;
        });
        await actions.RecordMeetingAsync();
        Assert.Empty(agent.MeetingCalls);
        Assert.Empty(agent.PastMeetingCalls);
    }

    /// <remarks>On the UI thread: typing a name starts a search a moment later.</remarks>
    [AvaloniaFact]
    public async Task Meeting_now_sends_the_agenda_and_the_people()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        dialogs.Answer(d =>
        {
            var meeting = (MeetingDialogViewModel)d;
            // The directory loaded as the dialog opened: everyone but me.
            Assert.Equal(new[] { "+ Maya Reddy", "+ Praveen Kumar", "+ Kavya R" }, meeting.Suggestions.Select(s => s.Label));
            meeting.Agenda = "  Sprint planning for the invoice release  ";
            meeting.Suggestions[0].AddCommand.Execute(null);
            meeting.PersonQuery = "Vikram (Pune)";
            Assert.Equal("+ Add “Vikram (Pune)”", meeting.Suggestions.Last().Label);
            meeting.AddTypedCommand.Execute(null);
            Assert.Equal("", meeting.PersonQuery);
            Assert.Equal(new[] { "Maya Reddy", "Vikram (Pune)" }, meeting.Chosen.Select(c => c.Name));
            // 4.0: who will mail the minutes is required (SPEC 2.9).
            Assert.False(meeting.SubmitCommand.CanExecute(null));
            Assert.Equal("Add who will mail the minutes.", meeting.Problem);
            Assert.Equal("Me (Asha)", meeting.SelfChip);
            meeting.MomIsMeCommand.Execute(null);
            Assert.Equal("Asha Kumar", meeting.MomSender);
            Assert.True(meeting.SubmitCommand.CanExecute(null));
            Assert.Equal("Start meeting", meeting.PrimaryText);
            return true;
        });
        await actions.RecordMeetingAsync();
        var (agenda, people, mom) = Assert.Single(agent.MeetingCalls);
        Assert.Equal("Asha Kumar", mom);
        Assert.Equal("Sprint planning for the invoice release", agenda);
        Assert.Equal(new[] { ("m-1", "Maya Reddy"), ((string?)null, "Vikram (Pune)") }, people.Select(p => (p.Id, p.Name)));
        Assert.Equal(PresenceStatus.Meeting, agent.Presence.Status);
    }

    [Fact]
    public async Task Meeting_past_sends_when_and_how_long()
    {
        var (actions, agent, dialogs) = Setup("12:20");
        dialogs.Answer(d =>
        {
            var meeting = (MeetingDialogViewModel)d;
            meeting.ShowPastCommand.Execute(null);
            Assert.Equal("Log an earlier meeting", meeting.Title);
            Assert.Equal("Log meeting", meeting.PrimaryText);
            Assert.Equal("Who was in it?", meeting.PeopleLabel);
            // Every 5 minutes from Start Day (09:24, so 09:25) to 5 minutes ago.
            Assert.Equal("9:25 AM", meeting.StartOptions[0].Label);
            Assert.Equal("12:15 PM", meeting.StartOptions[^1].Label);
            Assert.Equal("11:50 AM", meeting.StartAt!.Label); // about half an hour ago
            meeting.StartAt = meeting.StartOptions.First(o => o.Label == "10:30 AM");
            meeting.Durations.First(c => c.Minutes == 45).PickCommand.Execute(null);
            Assert.Equal("10:30 AM to 11:15 AM · 45 min", meeting.RangeText);
            meeting.Agenda = "Client call with Acme";
            meeting.MomSender = "  Priya  ";
            Assert.True(meeting.SubmitCommand.CanExecute(null));
            return true;
        });
        await actions.RecordMeetingAsync();
        var call = Assert.Single(agent.PastMeetingCalls);
        Assert.Equal("Priya", call.MomSender);
        Assert.Equal(Ist.At("10:30"), call.StartedAt);
        Assert.Equal(45, call.Minutes);
        Assert.Equal("Client call with Acme", call.Agenda);
        Assert.Empty(call.People);
        Assert.Empty(agent.MeetingCalls);
    }

    /// <remarks>On the UI thread: typing a name starts a search a moment later.</remarks>
    [AvaloniaFact]
    public async Task Meeting_the_server_refuses_reopens_with_its_reason_and_the_draft()
    {
        var (actions, agent, dialogs) = Setup("14:20");
        agent.MeetingOutcomes.Enqueue(new MeetingOutcome.Invalid("MEETING_OVERLAPS_BREAK", "Overlaps a break.", new MeetingClash
        {
            Kind = "LUNCH", StartedAt = Ist.At("13:00").ToUniversalTime(), EndedAt = Ist.At("13:30").ToUniversalTime(),
        }));
        dialogs
            .Answer(d =>
            {
                var meeting = (MeetingDialogViewModel)d;
                meeting.IsPast = true;
                meeting.StartAt = meeting.StartOptions.First(o => o.Label == "1:00 PM");
                meeting.MinutesText = "40";
                meeting.Agenda = "Vendor review";
                meeting.PersonQuery = "Kavya";
                meeting.Suggestions.First(s => s.Label == "+ Kavya R").AddCommand.Execute(null);
                return true;
            })
            .Answer(d =>
            {
                var again = (MeetingDialogViewModel)d;
                Assert.Equal("That overlaps your lunch from 1:00 PM to 1:30 PM. Pick another time.", again.Error);
                Assert.True(again.IsPast);
                Assert.Equal("1:00 PM", again.StartAt!.Label);
                Assert.Equal("40", again.MinutesText);
                Assert.Equal("Vendor review", again.Agenda);
                Assert.Equal("Kavya R", Assert.Single(again.Chosen).Name);
                again.StartAt = again.StartOptions.First(o => o.Label == "1:30 PM");
                return true;
            });
        await actions.RecordMeetingAsync();
        Assert.Equal(2, agent.PastMeetingCalls.Count);
        Assert.Equal(Ist.At("13:30"), agent.PastMeetingCalls[1].StartedAt);
    }

    [Theory]
    [InlineData("MEETING_OUTSIDE_DAY", "That time is outside your working day. Pick a time between Start Day and now.")]
    [InlineData("MEETING_IN_FUTURE", "That runs past now. Pick an earlier start or fewer minutes.")]
    [InlineData("MEETING_OVERLAPS_MEETING", "That overlaps another meeting from 10:00 AM to 10:30 AM. Pick another time.")]
    [InlineData("DAY_NOT_STARTED", "Start your day first.")]
    [InlineData("SOMETHING_NEW", "The server's own words.")]
    public void Meeting_codes_in_plain_words(string code, string expected)
    {
        var (actions, _, _) = Setup("12:00");
        var with = new MeetingClash { Kind = "MEETING", StartedAt = Ist.At("10:00").ToUniversalTime(), EndedAt = Ist.At("10:30").ToUniversalTime() };
        Assert.Equal(expected, actions.MeetingMessage(code, "The server's own words.", with));
    }

    [Fact]
    public async Task Meeting_refused_says_why()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        agent.MeetingOutcomes.Enqueue(new MeetingOutcome.Refused("ON_BREAK", "On a break."));
        dialogs.Answer(d => { ((MeetingDialogViewModel)d).Agenda = "Standup"; return true; }).Answer(_ => true);
        await actions.RecordMeetingAsync();
        var alert = Assert.IsType<MessageDialogViewModel>(dialogs.Shown[^1]);
        Assert.Equal("Couldn't start the meeting", alert.Title);
        Assert.Equal("End your break first.", alert.Message);
    }

    [Fact]
    public async Task Meeting_offline_starts_at_once_with_no_retry()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        agent.Online = false;
        dialogs.Answer(d =>
        {
            var meeting = (MeetingDialogViewModel)d;
            meeting.Agenda = "Standup";
            meeting.MomSender = "Ravi";
            return true;
        });
        await actions.RecordMeetingAsync();
        Assert.Single(agent.MeetingCalls);
        Assert.Single(dialogs.Shown);
        Assert.Equal(PresenceStatus.Meeting, agent.Presence.Status);
    }

    [Fact]
    public void Mom_sender_required_in_plain_words()
    {
        var (actions, _, _) = Setup("12:00");
        Assert.Equal("Add who will mail the minutes.", actions.MeetingMessage("MOM_SENDER_REQUIRED", "momSender is required", null));
    }

    [Fact]
    public async Task Meeting_ended_and_back_to_work_end_the_meeting()
    {
        var (actions, agent, dialogs) = Setup("10:40");
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = Ist.At("10:02") };
        agent.LiveMeeting = new MeetingRecord { Id = "meet-1", Agenda = "Standup", StartedAt = Ist.At("10:02"), InProgress = true };
        await actions.EndMeetingAsync();
        Assert.Equal(1, agent.EndMeetingCalls);
        Assert.Null(agent.LiveMeeting);

        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = Ist.At("10:42") };
        await actions.BackToWorkAsync(); // the Focus Work tile and the menus end a meeting too
        Assert.Equal(2, agent.EndMeetingCalls);
        Assert.Equal(0, agent.BackToWorkCalls);
        Assert.Empty(dialogs.Shown);
    }

    [Fact]
    public async Task Meeting_ended_offline_ends_it_at_once()
    {
        var (actions, agent, dialogs) = Setup("10:40");
        agent.Online = false;
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = Ist.At("10:02") };
        await actions.EndMeetingAsync();
        Assert.Equal(1, agent.EndMeetingCalls);
        Assert.Equal(PresenceStatus.Working, agent.Presence.Status);
        Assert.Empty(dialogs.Shown);
    }

    [Fact]
    public async Task No_meeting_while_on_a_break_or_already_in_one()
    {
        var (actions, agent, dialogs) = Setup("11:05");
        agent.Day = Days.General().WithActive(Days.Running("MORNING", "11:00"));
        dialogs.Answer(_ => true).Answer(_ => true);
        await actions.StartMeetingAsync();
        agent.Day = Days.General();
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting };
        await actions.StartMeetingAsync();
        Assert.Equal(new[] { "You're on a break", "You're in a meeting" }, dialogs.Shown.Select(d => d.Title));
        Assert.Empty(agent.MeetingCalls);
    }
}

/// <summary>The meeting dialog on its own: tabs, people, times and checks.</summary>
public class MeetingDialogTests
{
    private static MeetingDialogViewModel Dialog(string now = "12:20", string? dayStarted = "09:24", Func<string?, Task<IReadOnlyList<ParticipantOption>?>>? search = null)
    {
        var agent = new FakeAgent(now);
        var context = new MeetingDialogContext(
            search ?? agent.SearchParticipantsAsync,
            Ist.At(now),
            dayStarted is null ? null : Ist.At(dayStarted),
            agent.BusinessTime,
            "u-1",
            "your manager");
        return new MeetingDialogViewModel(context);
    }

    /// <remarks>On the UI thread: typing a name starts a search a moment later.</remarks>
    [AvaloniaFact]
    public async Task Up_to_30_people_and_no_one_twice()
    {
        var dialog = Dialog();
        await dialog.LoadSuggestionsAsync();
        dialog.Suggestions[0].AddCommand.Execute(null);
        dialog.PersonQuery = "maya reddy";
        dialog.AddTypedCommand.Execute(null); // the same person, typed: not added again
        Assert.Single(dialog.Chosen);
        Assert.Equal("m-1", dialog.Chosen[0].Person.Id);
        for (var i = 0; i < 40; i++)
        {
            dialog.PersonQuery = $"Guest {i}";
            dialog.AddTypedCommand.Execute(null);
        }
        Assert.Equal(30, dialog.Chosen.Count);
        Assert.False(dialog.CanAddPeople);
        Assert.Equal("Up to 30 people.", dialog.PeopleHint);
        Assert.Empty(dialog.Suggestions);

        dialog.Chosen[0].RemoveCommand.Execute(null);
        Assert.Equal(29, dialog.Chosen.Count);
        Assert.True(dialog.CanAddPeople);
        Assert.Contains(dialog.Suggestions, s => s.Label == "+ Maya Reddy");
    }

    /// <remarks>On the UI thread: typing a name starts a search a moment later.</remarks>
    [AvaloniaFact]
    public void Long_free_names_are_cut_to_80_characters()
    {
        var dialog = Dialog();
        dialog.PersonQuery = new string('a', 120);
        dialog.AddTypedCommand.Execute(null);
        Assert.Equal(80, Assert.Single(dialog.Chosen).Name.Length);
    }

    /// <remarks>On the UI thread: typing a name starts a search a moment later.</remarks>
    [AvaloniaFact]
    public async Task Search_trouble_still_lets_names_be_typed()
    {
        var dialog = Dialog(search: _ => Task.FromResult<IReadOnlyList<ParticipantOption>?>(null));
        await dialog.LoadSuggestionsAsync();
        Assert.Equal("Can't search the directory right now. You can still type names.", dialog.SearchProblem);
        dialog.PersonQuery = "Ravi";
        Assert.Equal("+ Add “Ravi”", Assert.Single(dialog.Suggestions).Label);
        dialog.AddTypedCommand.Execute(null);
        Assert.Null(Assert.Single(dialog.Chosen).Person.Id);

        var throwing = Dialog(search: _ => throw new HttpRequestException("down"));
        await throwing.SearchNowAsync("x");
        Assert.NotNull(throwing.SearchProblem);
    }

    /// <remarks>On the UI thread: typing a name starts a search a moment later.</remarks>
    [AvaloniaFact]
    public async Task Typing_waits_then_searches_once()
    {
        var calls = new List<string?>();
        var dialog = Dialog(search: q =>
        {
            calls.Add(q);
            return Task.FromResult<IReadOnlyList<ParticipantOption>?>(new List<ParticipantOption> { new() { Id = "p-2", Name = "Praveen Kumar" } });
        });
        dialog.PersonQuery = "P";
        dialog.PersonQuery = "Pr";
        dialog.PersonQuery = "Pra";
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (calls.Count == 0 && DateTime.UtcNow < deadline) await Task.Delay(20);
        await Task.Delay(400);
        Assert.Equal(new string?[] { "Pra" }, calls);
    }

    [Fact]
    public void Earlier_meeting_checks()
    {
        var dialog = Dialog("12:20");
        dialog.IsPast = true;
        dialog.Agenda = "Review";
        Assert.Equal("Add who will mail the minutes.", dialog.Problem);
        dialog.MomSender = "Priya";
        Assert.Null(dialog.Problem);

        dialog.MinutesText = "abc";
        Assert.Equal("Enter how long it ran, in minutes.", dialog.Problem);
        dialog.MinutesText = "3";
        Assert.Equal("How long must be 5 to 480 minutes.", dialog.Problem);
        dialog.MinutesText = "481";
        Assert.Equal("How long must be 5 to 480 minutes.", dialog.Problem);

        // 11:50 + 45 min runs past 12:20: the chip is off and the check says why.
        dialog.MinutesText = "45";
        Assert.Equal("That runs past now. Pick an earlier start or fewer minutes.", dialog.Problem);
        Assert.False(dialog.Durations.First(c => c.Minutes == 45).IsEnabled);
        Assert.True(dialog.Durations.First(c => c.Minutes == 30).IsEnabled);
        Assert.False(dialog.SubmitCommand.CanExecute(null));

        dialog.Agenda = new string('x', 301);
        Assert.Equal("Keep it to 300 characters.", dialog.Problem);

        // Back to Starting now: only the agenda matters.
        dialog.Agenda = "Review";
        dialog.ShowNowCommand.Execute(null);
        Assert.Null(dialog.Problem);
        var draft = dialog.ToDraft();
        Assert.False(draft.IsPast);
        Assert.Null(draft.StartedAt);
    }

    [Fact]
    public void Before_the_day_has_run_5_minutes_nothing_can_be_logged()
    {
        var dialog = Dialog("09:26", dayStarted: "09:24");
        dialog.IsPast = true;
        dialog.Agenda = "Standup";
        dialog.MomSender = "Priya";
        Assert.False(dialog.HasStartOptions);
        Assert.Equal("Your day started at 9:24 AM. A meeting can be logged once it has run for 5 minutes.", dialog.Problem);
        Assert.False(dialog.SubmitCommand.CanExecute(null));
    }

    [Fact]
    public void Notes_say_what_happens_to_focus_time()
    {
        var dialog = Dialog();
        Assert.Equal("Your focus time keeps counting while you are in it. Tap End meeting when you are back. Your manager approves or rejects it after.", dialog.Note);
        dialog.IsPast = true;
        Assert.Equal("This time is already in your focus time. Your manager approves or rejects it; a rejection takes these minutes off.", dialog.Note);
    }
}

/// <summary>The cards beside the button, built by <see cref="Toasts"/>.</summary>
public class ToastBuilderTests
{
    [Fact]
    public void The_ring_offers_Skip_break_only_when_the_shift_allows_it()
    {
        var agent = new FakeAgent("10:59:30");
        var took = 0;
        var skipped = 0;
        var opened = 0;
        var ring = Toasts.Ring(agent, agent.Ring!, () => took++, () => skipped++, () => opened++);
        Assert.Equal("Morning break is due now", ring.Heading);
        Assert.Equal("Rings till 11:04 AM. Start it now and no reason is needed.", ring.Body);
        Assert.Equal("Take it", ring.PrimaryText);
        Assert.Equal("Skip break", ring.SecondaryText);
        Assert.True(ring.Sticky);
        ring.SecondaryCommand.Execute(null);
        ring.PrimaryCommand.Execute(null);
        Assert.Equal((1, 1, 0), (took, skipped, opened));

        agent.Day = Days.General();
        agent.Day.Breaks[0].AllowSkip = false;
        var plain = Toasts.Ring(agent, agent.Ring!, () => took++, () => skipped++, () => opened++);
        Assert.Equal("Open RX Vision", plain.SecondaryText);
        plain.SecondaryCommand.Execute(null);
        Assert.Equal((1, 1, 1), (took, skipped, opened));
    }

    [Fact]
    public void The_ring_offers_no_skip_for_a_break_End_Day_already_skipped()
    {
        var agent = new FakeAgent("10:59:50");
        // End Day (stopped by a gate) auto-skipped it a moment ago, inside its window.
        agent.Day!.Breaks[0].Record = Days.Skip("MORNING", "10:59:40", auto: true);
        Assert.Null(agent.Ring);   // asked about at End Day: it does not ring again
        Assert.True(agent.BreakPanel.Slots[0].CanStart);
        var toast = Toasts.Ring(agent, new RingView("MORNING", "Morning break", Ist.At("11:04"), true), () => { }, () => { }, () => { });
        Assert.Equal("Open RX Vision", toast.SecondaryText);
    }

    [Fact]
    public void Auto_skipped_asks_for_a_comment()
    {
        var agent = new FakeAgent("12:01");
        var commented = 0;
        var toast = Toasts.AutoSkipped(agent, Days.Skip("MORNING", "12:00", auto: true), () => commented++, () => { });
        Assert.Equal("Morning break auto-skipped.", toast.Title);
        Assert.Equal("Add a comment before End Day.", toast.Body);
        Assert.Equal("Add comment", toast.PrimaryText);
        Assert.Equal("autoskip:morning-auto", toast.Key);
        Assert.Equal("12:00 PM", toast.Stamp);
        toast.PrimaryCommand.Execute(null);
        Assert.Equal(1, commented);
    }

    [Fact]
    public void Good_morning_and_at_your_desk()
    {
        var agent = new FakeAgent("08:55") { State = AgentState.NotStarted };
        var starts = 0;
        var greeting = Toasts.Nudge(agent, new AgentNudge(NudgeKind.Greeting, "2026-10-13"), () => starts++, () => { });
        Assert.Equal("Good morning, Asha.", greeting.Title);
        Assert.Equal("Start Day when you begin work.", greeting.Body);
        Assert.Equal("Start Day", greeting.PrimaryText);
        Assert.True(greeting.HasStrongPrimary);
        greeting.PrimaryCommand.Execute(null);
        Assert.Equal(1, starts);

        agent.SetNow("14:05");
        Assert.Equal("Good afternoon, Asha.", Toasts.Nudge(agent, new AgentNudge(NudgeKind.Greeting, null), () => { }, () => { }).Title);

        var desk = Toasts.Nudge(agent, new AgentNudge(NudgeKind.AtDesk, "2026-10-13"), () => { }, () => { });
        Assert.Equal("You're at your desk. Start Day?", desk.Title);
        Assert.Equal("Nothing is recorded until you do.", desk.Body);
        Assert.Equal(greeting.Key, desk.Key); // one Start Day card at a time
    }

    [Fact]
    public void A_cue_is_one_quiet_line_for_5_seconds()
    {
        var cue = Toasts.Cue("Back early. Nice rhythm.");
        Assert.True(cue.IsCue);
        Assert.False(cue.IsCard);
        Assert.Equal("Back early. Nice rhythm.", cue.Title);
        Assert.Equal(TimeSpan.FromSeconds(5), cue.Lifetime);
        Assert.Null(cue.SecondaryText);
    }

    [Fact]
    public void A_cue_that_could_not_show_in_time_is_dropped()
    {
        var now = DateTimeOffset.UtcNow;
        var shown = new List<string>();
        var toasts = new ToastService(new ListPresenter(shown), () => now);
        toasts.SetSuppressed(true); // a full-screen app is in front
        toasts.Show(Toasts.Cue("Skipped and noted. Keep it steady."));
        now += TimeSpan.FromSeconds(12);
        toasts.Tick();
        toasts.SetSuppressed(false);
        Assert.Null(toasts.Current);
        Assert.Empty(shown);

        toasts.Show(Toasts.Cue("Back early. Good pace."));
        Assert.Equal("cue", toasts.Current!.Key);
        now += TimeSpan.FromSeconds(6);
        toasts.Tick();
        Assert.Null(toasts.Current);
    }

    private sealed class ListPresenter : IToastPresenter
    {
        private readonly List<string> _shown;
        public ListPresenter(List<string> shown) => _shown = shown;
        public void Show(ToastViewModel toast) => _shown.Add(toast.Key);
        public void Hide() { }
    }
}

/// <summary>The dashboard before Start Day, and the focus panel while the day runs.</summary>
public class DayStateTests
{
    [Fact]
    public void Hours_after_a_night_shift_not_started_shows_how_that_day_ended()
    {
        var agent = new FakeAgent("03:10") { State = AgentState.NotStarted };
        agent.Workday = new WorkdayToday
        {
            Date = "2026-10-13", ServerNow = Ist.At("03:10").ToUniversalTime(), State = WorkdayStates.NotStarted, ExpectedSec = 8 * 3600,
            LastEnded = new LastEndedView { Date = "2026-10-12", EndedAt = Ist.At("02:05").ToUniversalTime(), FocusSec = 7 * 3600 + 50 * 60 },
        };
        var vm = Dashboard(agent);
        Assert.Equal("Your day of Mon 12 Oct ended at 2:05 AM with 7h 50m of focus time. Start Day when your next one begins.", vm.LastEndedText);
        Assert.Equal("7h 50m", vm.Today.FocusText);
        Assert.Equal("Last day · ended 2:05 AM", vm.Today.FocusStatus);

        // A new day with no day ended in the last hours: nothing about it.
        agent.Workday.LastEnded = null;
        vm.Refresh();
        Assert.Null(vm.LastEndedText);
        Assert.Equal("0m", vm.Today.FocusText);
        Assert.Equal("Starts when you press Start Day", vm.Today.FocusStatus);
    }

    [Fact]
    public void End_Day_after_midnight_names_the_day_that_ended()
    {
        var agent = new FakeAgent("01:40") { State = AgentState.DayEnded };
        var ended = Days.Open(startedAt: "09:24", serverNow: "01:35", focusSec: 7 * 3600, running: false);
        ended.Date = "2026-10-12";   // End Day's answer: the day that just ended
        ended.State = WorkdayStates.Ended;
        ended.EndedAt = Ist.At("01:35").ToUniversalTime();
        agent.Workday = ended;
        var vm = Dashboard(agent);
        Assert.Equal("Your day ended at 1:35 AM.", vm.EndedTitle);
        Assert.Equal("Focus time on Mon 12 Oct: 7h 00m. Nothing is recorded now. Still working? Start Day again.", vm.EndedDetail);
        Assert.Equal("7h 00m", vm.Today.FocusText);
    }

    [Fact]
    public void Decided_today_is_the_business_date_now_not_the_shifts_start_date()
    {
        var agent = new FakeAgent("01:30");
        var night = Days.Open(startedAt: "09:24", serverNow: "01:30");
        night.Date = "2026-10-12";   // a night shift keeps its start date past midnight
        agent.Workday = night;
        agent.Approvals.Add(new ApprovalItem { Type = "BREAK", Id = "d1", Title = "Lunch break started late", Status = "APPROVED",
            DecidedAt = Ist.At("00:30").ToUniversalTime(), Effect = new ApprovalEffect { Mode = "NONE" } });
        agent.Approvals.Add(new ApprovalItem { Type = "BREAK", Id = "d2", Title = "Evening break skipped", Status = "APPROVED",
            DecidedAt = Ist.At("00:30").AddDays(-1).ToUniversalTime(), Effect = new ApprovalEffect { Mode = "NONE" } });
        var vm = Dashboard(agent);
        Assert.Equal(new[] { "Lunch break started late" }, vm.Today.Waiting.Select(w => w.Title));
    }

    private static DashboardViewModel Dashboard(FakeAgent agent)
    {
        var vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), NullLog.Instance);
        vm.Refresh();
        return vm;
    }

    private static FakeAgent NotStarted(string now)
    {
        var agent = new FakeAgent(now)
        {
            State = AgentState.NotStarted,
            Workday = Days.NotStarted(now),
            Presence = new CurrentPresence { Status = PresenceStatus.NotStarted },
        };
        return agent;
    }

    [Fact]
    public void Not_started_shows_the_greeting_the_shift_and_Start_Day()
    {
        var vm = Dashboard(NotStarted("08:55"));
        Assert.True(vm.IsNotStarted);
        Assert.False(vm.ShowTiles);
        Assert.False(vm.IsRunning);
        Assert.Equal("Good morning, Asha.", vm.GreetingText);
        Assert.Equal("General shift · 9:30 AM to 6:30 PM", vm.ShiftLine);
        Assert.True(vm.StartDayCommand.CanExecute(null));
        Assert.False(vm.EndDayCommand.CanExecute(null));
        Assert.Null(vm.DayStartedText);
        Assert.Equal("Day not started", vm.StatusText);
        Assert.Equal("Not started · nothing recorded", vm.SyncText);
        Assert.Equal(SyncTone.Off, vm.SyncTone);
        Assert.Equal("0m", vm.Today.FocusText);
        Assert.Equal("Starts when you press Start Day", vm.Today.FocusStatus);
        Assert.Null(vm.DayCheckText);
        // The shift's breaks are still listed, as the plan for the day.
        Assert.Equal(3, vm.Rows.Count);
    }

    [Fact]
    public void An_unknown_day_says_so_and_Start_Day_still_works()
    {
        var agent = NotStarted("09:02");
        var vm = Dashboard(agent);
        Assert.Null(vm.DayCheckText);

        agent.DayKnown = false;
        agent.Workday = null;
        vm.Refresh();
        Assert.Equal("Can't reach RX Vision to check your day. You can still start it: it is sent as soon as the connection is back.", vm.DayCheckText);
        Assert.True(vm.StartDayCommand.CanExecute(null));
        Assert.Equal("General shift · 9:30 AM to 6:30 PM", vm.ShiftLine); // from the break day instead
    }

    [Fact]
    public void Focus_ticks_from_the_servers_number_while_the_day_runs()
    {
        var agent = new FakeAgent("10:45");
        agent.Workday = Days.Open(serverNow: "10:24", focusSec: 3600);
        var vm = Dashboard(agent);
        Assert.Equal("1h 21m", vm.Today.FocusText);
        Assert.Equal("Counting", vm.Today.FocusStatus);
        Assert.Equal("Day started 9:24 AM", vm.Today.DayStartedText);
        Assert.Equal("Target 8h", vm.Today.ExpectedText);
        Assert.Equal(81 / 480.0, vm.Today.Progress, 3);

        agent.SetNow("10:46:30");
        vm.Refresh();
        Assert.Equal("1h 22m", vm.Today.FocusText);
    }

    [Fact]
    public void Focus_pauses_on_a_break_and_lunch()
    {
        var agent = new FakeAgent("11:05");
        agent.Workday = Days.Open(serverNow: "10:24", focusSec: 3600); // the last answer, from before the break
        agent.Day = Days.General().WithActive(Days.Running("MORNING", "11:00"));
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Break, Since = Ist.At("11:00") };
        var vm = Dashboard(agent);
        Assert.Equal("1h 36m", vm.Today.FocusText); // stopped at 11:00
        Assert.Equal("Paused · on a break", vm.Today.FocusStatus);

        agent.SetNow("11:12");
        vm.Refresh();
        Assert.Equal("1h 36m", vm.Today.FocusText);

        // The server's own answer during the break: not running, not ticking.
        agent.Workday = Days.Open(serverNow: "11:10", focusSec: 96 * 60, running: false);
        vm.Refresh();
        Assert.Equal("1h 36m", vm.Today.FocusText);

        agent.Day = Days.General().WithRecord(Days.Taken("MORNING", "11:00", "11:14")).WithActive(Days.Running("LUNCH", "13:00", 30));
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Lunch, Since = Ist.At("13:00") };
        agent.SetNow("13:10");
        vm.Refresh();
        Assert.Equal("Paused · at lunch", vm.Today.FocusStatus);
    }

    [Fact]
    public void Pending_approvals_show_what_they_would_do_to_focus_time()
    {
        var agent = new FakeAgent("12:20");
        agent.Workday = Days.Open(serverNow: "12:20", focusSec: 2 * 3600);
        agent.Workday.Focus.PendingPlusSec = 30 * 60;
        agent.Workday.Focus.PendingMinusSec = 15 * 60;
        var vm = Dashboard(agent);
        Assert.Equal("+30 min if approved", vm.Today.PlusText);
        Assert.Equal("−15 min if rejected", vm.Today.MinusText);
        Assert.True(vm.Today.HasPlus);
        Assert.True(vm.Today.HasMinus);

        agent.Workday.Focus.PendingPlusSec = 0;
        agent.Workday.Focus.PendingMinusSec = 0;
        vm.Refresh();
        Assert.False(vm.Today.HasPlus);
        Assert.False(vm.Today.HasMinus);
    }

    [Fact]
    public void Waiting_for_your_manager_lists_pending_items_then_todays_decisions()
    {
        var agent = new FakeAgent("12:20");
        agent.Approvals.AddRange(new[]
        {
            new ApprovalItem
            {
                Type = "MEETING", Id = "m1", Category = "MEETING_PAST", Title = "Meeting: Client call with Acme", Detail = "10:30 to 11:00",
                Effect = new ApprovalEffect { Mode = "PLUS", Minutes = 30, Text = "+30 min if approved" },
            },
            new ApprovalItem
            {
                Type = "BREAK", Id = "b1", Category = "BREAK_SKIP", Title = "Morning break skipped", Detail = "Skipped at 11:02",
                Effect = new ApprovalEffect { Mode = "MINUS", Minutes = 15, Text = "-15 min if rejected" }, // a hyphen on the wire
            },
            new ApprovalItem
            {
                Type = "BREAK", Id = "b2", Category = "BREAK_OVERRUN", Title = "Back 6 min late from lunch", Detail = "13:00 to 13:36",
                Status = "REJECTED", DecidedAt = Ist.At("09:40").ToUniversalTime(), DecidedByName = "Maya Reddy", DecisionNote = "Plan calls around lunch",
                Effect = new ApprovalEffect { Mode = "PLUS", Minutes = 6, Text = "No change to focus time" },
            },
            new ApprovalItem
            {
                Type = "BREAK", Id = "b3", Category = "BREAK_LATE", Title = "Lunch break started late", Status = "APPROVED",
                DecidedAt = Ist.At("09:40").AddDays(-1).ToUniversalTime(), // decided yesterday: not shown
            },
            new ApprovalItem
            {
                Type = "BREAK", Id = "b4", Category = "BREAK_AUTO_SKIP", Title = "Evening break auto-skipped", Detail = "Auto-skipped at 17:00",
                Effect = new ApprovalEffect { Mode = "MINUS", Minutes = 15 }, // no text: worked out here
            },
        });
        var vm = Dashboard(agent);
        var today = vm.Today;
        Assert.True(today.HasWaiting);
        Assert.Equal("Waiting for your manager", today.WaitingTitle);
        Assert.Equal(4, today.WaitingCount);
        Assert.Equal(new[]
        {
            ("Meeting: Client call with Acme", "+30 min if approved", WaitingKind.Meeting),
            ("Morning break skipped", "−15 min if rejected", WaitingKind.Break),
            ("Evening break auto-skipped", "−15 min if rejected", WaitingKind.Break),
            ("Back 6 min late from lunch", "Rejected · No change to focus time", WaitingKind.Overrun),
        }, today.Waiting.Select(w => (w.Title, w.Chip, w.Kind)));
        Assert.Equal("Maya Reddy: Plan calls around lunch", today.Waiting[3].ToolTip);
        Assert.Null(today.WaitingMore);

        // 4.0 (SPEC 1.3): a manager's own items wait for the org's admin.
        agent.User!.Role = "MANAGER";
        vm.Refresh();
        Assert.Equal("Waiting for your admin", today.WaitingTitle);

        // More than four: the rest are in the portal.
        for (var i = 0; i < 3; i++)
            agent.Approvals.Add(new ApprovalItem { Type = "BREAK", Id = "x" + i, Title = "Break " + i, Effect = new ApprovalEffect { Mode = "NONE" } });
        vm.Refresh();
        Assert.Equal(4, today.Waiting.Count);
        Assert.Equal("and 3 more in the portal", today.WaitingMore);
    }
}
