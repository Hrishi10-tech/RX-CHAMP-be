using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels.Dialogs;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// Start meeting, End meeting and Still in it (3.6) through the break actions, ported from the
/// vendor's 3.6 tests. 4.0 keeps its meeting dialog (agenda, people, minutes, offline) beside it.
/// </summary>
public class MeetingStatusActionTests
{
    private static (BreakActions Actions, FakeAgent Agent, FakeDialogs Dialogs) Setup(string now)
    {
        var agent = new FakeAgent(now);
        var dialogs = new FakeDialogs();
        return (new BreakActions(agent, dialogs, NullLog.Instance), agent, dialogs);
    }

    [Fact]
    public async Task Start_meeting_goes_at_once_with_no_form()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        await actions.StartMeetingAsync();
        Assert.Equal(new[] { MeetingSources.Button }, agent.MeetingStartSources);
        Assert.Empty(dialogs.Shown);
        Assert.Empty(agent.MeetingCalls); // not the 4.0 dialog's journaled meeting
        Assert.Equal(PresenceStatus.Meeting, agent.Presence.Status);
    }

    [Fact]
    public async Task A_suggestion_tapped_says_where_it_came_from()
    {
        var (actions, agent, _) = Setup("10:20");
        await actions.StartMeetingAsync(MeetingSources.Suggestion);
        Assert.Equal(new[] { MeetingSources.Suggestion }, agent.MeetingStartSources);
    }

    [Fact]
    public async Task No_connection_starts_nothing_and_asks_to_try_again()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        agent.MeetingStatusOutcomes.Enqueue(new MeetingStatusOutcome.Offline("Try again in a moment. Nothing was saved yet."));
        dialogs.Answer(d =>
        {
            Assert.Equal("The meeting isn't started yet", d.Title);
            Assert.Equal("Try again in a moment. Nothing was saved yet.", ((MessageDialogViewModel)d).Message);
            return false;
        });
        await actions.StartMeetingAsync();
        Assert.Single(agent.MeetingStartSources);
        Assert.Equal(PresenceStatus.Working, agent.Presence.Status);

        // And Try again sends it again.
        agent.MeetingStatusOutcomes.Enqueue(new MeetingStatusOutcome.Offline("offline"));
        dialogs.Answer(_ => true);
        await actions.StartMeetingAsync();
        Assert.Equal(3, agent.MeetingStartSources.Count);
        Assert.Equal(PresenceStatus.Meeting, agent.Presence.Status);
    }

    [Fact]
    public async Task End_meeting_and_Still_in_it_with_no_connection_say_it_still_runs()
    {
        var (actions, agent, dialogs) = Setup("10:40");
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting };
        agent.DayProgress = agent.Progress(DayProgressStatus.Meeting);
        agent.EndOutcomes.Enqueue(new EndOutcome.Offline("Try again in a moment. Your meeting is still running."));
        dialogs.Answer(d => { Assert.Equal("Your meeting is still running", d.Title); return false; });
        await actions.EndMeetingAsync();
        Assert.Equal(1, agent.EndMeetingCalls);
        Assert.Equal(PresenceStatus.Meeting, agent.Presence.Status);

        agent.MeetingStatusOutcomes.Enqueue(new MeetingStatusOutcome.Offline("Try again in a moment. Your meeting is still running."));
        dialogs.Answer(d => { Assert.Equal("Try again in a moment. Your meeting is still running.", ((MessageDialogViewModel)d).Message); return false; });
        await actions.ConfirmMeetingAsync();
        Assert.Equal(1, agent.ConfirmCalls);
    }

    [Fact]
    public async Task A_refusal_from_the_status_route_says_why()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        agent.MeetingStatusOutcomes.Enqueue(new MeetingStatusOutcome.Refused("MEETING_IN_PROGRESS", "You're already in a meeting."));
        dialogs.Answer(_ => true);
        await actions.StartMeetingAsync();
        var alert = Assert.IsType<MessageDialogViewModel>(Assert.Single(dialogs.Shown));
        Assert.Equal("Couldn't start the meeting", alert.Title);
        Assert.Equal("You're already in a meeting. Tap End meeting first.", alert.Message);
    }

    [Fact]
    public async Task The_meeting_dialog_stays_for_a_meeting_with_its_details()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        dialogs.Answer(d =>
        {
            var meeting = Assert.IsType<MeetingDialogViewModel>(d);
            Assert.Equal("Start a meeting", meeting.Title);
            return false;
        });
        await actions.RecordMeetingAsync();
        Assert.Empty(agent.MeetingStartSources);
        Assert.Empty(agent.MeetingCalls);
    }

    /// <summary>Core review C-R04: with data handling on (GET /features), the notice starts with the section 9 sentence.</summary>
    [Fact]
    public void With_data_handling_on_the_notice_starts_with_the_section_9_sentence()
    {
        var off = new RXVision.Agent.ViewModels.NoticeViewModel(new FakeAgent(), NullLog.Instance);
        Assert.Null(off.DataHandlingSentence);
        var agent = new FakeAgent();
        agent.FlagsOn.Add("dataHandling");
        var on = new RXVision.Agent.ViewModels.NoticeViewModel(agent, NullLog.Instance);
        Assert.Equal("RxVision records activity, periodic captures and file-transfer events on this work device for attendance, payroll and data security.", on.DataHandlingSentence);
    }

    [Fact]
    public async Task In_a_status_meeting_the_dialog_asks_for_End_meeting_first()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        agent.DayProgress = agent.Progress(DayProgressStatus.Meeting);
        dialogs.Answer(_ => true);
        await actions.RecordMeetingAsync();
        Assert.Equal("You're in a meeting", Assert.Single(dialogs.Shown).Title);
    }
}
