using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.VisualTree;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Icon;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>The meeting cards on top of the panel, their exact words and actions, and the badge on the icon.</summary>
public class MeetingCardsTests
{
    private static (MeetingAlerts Vm, AlertCenter Center, FakeAgent Agent, FakeDialogs Dialogs) Setup(string now, params MeetingAlert[] alerts)
    {
        var agent = new FakeAgent(now);
        agent.Alerts.AddRange(alerts);
        var dialogs = new FakeDialogs();
        var center = new AlertCenter();
        return (new MeetingAlerts(agent, center, new BreakActions(agent, dialogs, NullLog.Instance)), center, agent, dialogs);
    }

    [Theory]
    [InlineData("Teams", "You look to be on a Teams call.")]
    [InlineData("Zoom", "You look to be on a Zoom call.")]
    [InlineData("Google Meet", "You look to be on a Google Meet call.")]
    public void Start_meeting_card_has_the_decks_words(string app, string body)
    {
        var (vm, center, _, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.StartMeeting, app));
        vm.Sync();
        var card = Assert.Single(center.Cards);
        Assert.Equal(("Start meeting?", body, "Start meeting", "Not now", AlertLevel.Info), (card.Title, card.Body, card.PrimaryText, card.SecondaryText, card.Level));
        Assert.True(card.HasQuietSecondary);
        Assert.False(card.HasOutlinedSecondary);
    }

    [Fact]
    public void A_Slack_huddle_says_huddle()
    {
        var (vm, center, _, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.StartMeeting, "Slack", IsHuddle: true));
        vm.Sync();
        Assert.Equal("You look to be in a Slack huddle.", center.Cards[0].Body);

        var (end, endCenter, _, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.EndMeeting, "Slack", IsHuddle: true));
        end.Sync();
        Assert.Equal("Your Slack huddle looks finished.", endCenter.Cards[0].Body);
    }

    [Fact]
    public void End_meeting_card_has_the_decks_words()
    {
        var (vm, center, _, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.EndMeeting, "Zoom"));
        vm.Sync();
        var card = Assert.Single(center.Cards);
        Assert.Equal(("End meeting?", "Your Zoom call looks finished.", "End meeting", "Not now", AlertLevel.Info), (card.Title, card.Body, card.PrimaryText, card.SecondaryText, card.Level));
        Assert.True(card.HasQuietSecondary);
    }

    [Fact]
    public void Still_in_a_meeting_card_has_the_decks_words_and_counts_on()
    {
        var (vm, center, agent, _) = Setup("13:30", new MeetingAlert(MeetingAlertKind.StillInMeeting, At: Ist.At("11:30")));
        vm.Sync();
        var card = Assert.Single(center.Cards);
        Assert.Equal(("Still in a meeting?", "You've been in this meeting for 2h 00m.", "Still in it", "End meeting", AlertLevel.Action), (card.Title, card.Body, card.PrimaryText, card.SecondaryText, card.Level));
        Assert.True(card.HasOutlinedSecondary);
        Assert.False(card.HasQuietSecondary);
        agent.SetNow("13:37");
        vm.Sync();
        Assert.Equal("You've been in this meeting for 2h 07m.", center.Cards[0].Body);
    }

    [Fact]
    public void Back_to_Working_card_has_the_decks_words_on_the_12_hour_clock_and_goes_once_read()
    {
        var (vm, center, _, _) = Setup("16:12", new MeetingAlert(MeetingAlertKind.BackToWorking, At: Ist.At("16:10")));
        vm.Sync();
        var card = Assert.Single(center.Cards);
        Assert.Equal(("You're back to Working", "Tap Start meeting if you're still in one. Your status moved to Working at 4:10 PM.", "Start meeting", AlertLevel.Info), (card.Title, card.Body, card.PrimaryText, card.Level));
        Assert.False(card.HasSecondary);
        Assert.True(card.GoneWhenRead);
    }

    [Fact]
    public async Task Tapping_acts_only_through_the_status_routes_and_says_where_it_came_from()
    {
        var (vm, center, agent, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom"));
        vm.Sync();
        Assert.Empty(agent.MeetingStartSources);
        await center.Cards[0].PrimaryCommand.ExecuteAsync(null);
        Assert.Equal(new[] { MeetingSources.Suggestion }, agent.MeetingStartSources);

        agent.Alerts.Clear();
        agent.Alerts.Add(new MeetingAlert(MeetingAlertKind.EndMeeting, "Zoom"));
        vm.Sync();
        await center.Cards[0].PrimaryCommand.ExecuteAsync(null);
        Assert.Equal(1, agent.EndMeetingCalls);

        agent.Alerts.Clear();
        agent.Alerts.Add(new MeetingAlert(MeetingAlertKind.StillInMeeting, At: Ist.At("08:30")));
        vm.Sync();
        await center.Cards[0].PrimaryCommand.ExecuteAsync(null);
        Assert.Equal(1, agent.ConfirmCalls);
        await center.Cards[0].SecondaryCommand.ExecuteAsync(null);
        Assert.Equal(2, agent.EndMeetingCalls);

        agent.Alerts.Clear();
        agent.Alerts.Add(new MeetingAlert(MeetingAlertKind.BackToWorking, At: Ist.At("10:30")));
        agent.DayProgress = agent.Progress(DayProgressStatus.Working);
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Working };
        vm.Sync();
        await center.Cards[0].PrimaryCommand.ExecuteAsync(null);
        Assert.Equal(MeetingSources.Button, agent.MeetingStartSources[^1]);
    }

    [Fact]
    public async Task Not_now_only_dismisses_and_nothing_changes_by_itself()
    {
        var (vm, center, agent, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom"));
        vm.Sync();
        await center.Cards[0].SecondaryCommand.ExecuteAsync(null);
        Assert.Equal(new[] { MeetingAlertKind.StartMeeting }, agent.DismissedAlerts);
        Assert.Empty(agent.MeetingStartSources);
        Assert.Empty(center.Cards);
    }

    [Fact]
    public void The_badge_stays_until_the_panel_opens_and_the_card_stays_after()
    {
        var alert = new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom");
        var (vm, center, agent, _) = Setup("10:30", alert);
        vm.Sync();
        Assert.Equal(AlertLevel.Info, center.Badge);
        vm.Sync();
        Assert.Equal(AlertLevel.Info, center.Badge);
        center.Opened();
        Assert.Null(center.Badge);
        center.Closed();
        vm.Sync();
        Assert.Null(center.Badge); // seen: it does not come back
        Assert.Single(center.Cards); // and the card stays until it is acted on or stops being true

        // A new alert, the panel shut: a new badge. "!" over "i", and on top.
        agent.Alerts.Insert(0, new MeetingAlert(MeetingAlertKind.StillInMeeting, At: Ist.At("08:30")));
        vm.Sync();
        Assert.Equal(AlertLevel.Action, center.Badge);
        Assert.Equal(new[] { "Still in a meeting?", "Start meeting?" }, center.Cards.Select(c => c.Title));
    }

    [Fact]
    public void With_the_panel_open_a_new_card_goes_on_top_with_no_badge()
    {
        var (vm, center, agent, _) = Setup("10:30");
        center.Opened();
        agent.Alerts.Add(new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom"));
        vm.Sync();
        Assert.Single(center.Cards);
        Assert.Null(center.Badge);
    }

    [Fact]
    public void A_card_that_stops_being_true_goes_with_its_badge()
    {
        var (vm, center, agent, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom"));
        vm.Sync();
        Assert.Equal(AlertLevel.Info, center.Badge);
        agent.Alerts.Clear();
        vm.Sync();
        Assert.Null(center.Badge);
        Assert.Empty(center.Cards);
    }

    [Fact]
    public void A_card_read_and_closed_does_not_come_back_while_the_agent_has_dropped_it()
    {
        var (vm, center, agent, _) = Setup("16:12", new MeetingAlert(MeetingAlertKind.BackToWorking, At: Ist.At("16:10")));
        vm.Sync();
        center.Opened();
        center.Closed();
        agent.MeetingPanelClosed();
        vm.Sync();
        Assert.Empty(center.Cards);
    }

    [AvaloniaFact]
    public void The_panel_draws_the_cards_on_top_with_their_actions_ready()
    {
        var agent = new FakeAgent("10:30");
        agent.Alerts.Add(new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom"));
        var ui = new DashboardHarness(agent);
        new MeetingAlerts(agent, ui.Vm.Alerts, ui.Actions).Sync();
        ui.Refresh();
        Assert.True(ui.Shows("Start meeting?"));
        Assert.True(ui.Shows("You look to be on a Zoom call."));
        Assert.True(ui.HasButton("Not now"));
        var card = ui.Window.GetVisualDescendants().OfType<AlertCardsView>().Single();
        var tile = ui.Window.GetVisualDescendants().OfType<Button>().First(b => b.Name == "NextBreakAction");
        Assert.True(card.TranslatePoint(new Point(0, 0), ui.Window)!.Value.Y < tile.TranslatePoint(new Point(0, 0), ui.Window)!.Value.Y);

        ui.Click("Not now");
        ui.Refresh();
        Assert.False(ui.Shows("Start meeting?"));
        ui.Close();
    }

    [AvaloniaFact]
    public void In_a_meeting_the_panel_offers_End_meeting_and_a_break_waits_for_it()
    {
        // 4.0 keeps its rule: a break starts after End meeting (3.6 let the server end the meeting).
        var agent = new FakeAgent("10:50");
        agent.DayProgress = agent.Progress(DayProgressStatus.Meeting, meetingFrom: Ist.At("10:00"));
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = Ist.At("10:00") };
        var ui = new DashboardHarness(agent);
        Assert.True(ui.HasButton("End meeting"));
        Assert.False(ui.HasButton("Quick break"));
        Assert.Empty(agent.TakeCalls);
        ui.Close();
    }
}

// 3.6's MeetingAwayTests (the local "You've been away" card) is not ported: 4.0 keeps its own
// away pop-up, which asks the person what the time was (SPEC 2.5), so DayAlerts raises no away card.

/// <summary>The icon follows the one reading of the status, with its purple dot and ring, and the motion for "!".</summary>
public class MeetingIconTests
{
    [Fact]
    public void The_status_is_the_day_progress_and_follows_the_fallback()
    {
        var agent = new FakeAgent("10:30");
        agent.DayProgress = agent.Progress(DayProgressStatus.Working);
        Assert.Equal(IconStatus.Working, DayMeter.StatusOf(agent));

        agent.DayProgress = agent.Progress(DayProgressStatus.Meeting);
        Assert.Equal(IconStatus.Meeting, DayMeter.StatusOf(agent));

        // The fallback: in 4.0 the host's presence follows the day progress, and the icon follows both.
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Working };
        agent.DayProgress = agent.Progress(DayProgressStatus.Working);
        Assert.Equal(IconStatus.Working, DayMeter.StatusOf(agent));

        // On a break a meeting's status never shows.
        agent.Day = Days.General().WithActive(Days.Running("MORNING", "10:25"));
        agent.DayProgress = agent.Progress(DayProgressStatus.Meeting);
        Assert.Equal(IconStatus.OnBreak, DayMeter.StatusOf(agent));
    }

    [Theory]
    [InlineData(DayStatus.Working, false, BubbleStatus.Working)]
    [InlineData(DayStatus.InMeeting, false, BubbleStatus.Meeting)]
    [InlineData(DayStatus.OnBreak, false, BubbleStatus.Away)]
    [InlineData(DayStatus.OnBreak, true, BubbleStatus.Overrun)]
    [InlineData(DayStatus.NotStarted, false, BubbleStatus.Idle)]
    [InlineData(DayStatus.DayEnded, false, BubbleStatus.Idle)]
    public void One_status_one_look_in_the_panels_header(DayStatus status, bool overrun, BubbleStatus look) => Assert.Equal(look, BubbleStatuses.For(status, overrun));

    [Fact]
    public void In_a_meeting_the_look_is_purple_and_the_ring_keeps_filling_then_back_to_teal()
    {
        var agent = new FakeAgent("10:30");
        agent.DayProgress = agent.Progress(DayProgressStatus.Meeting, workedSec: 2 * 3600);
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = Ist.At("10:00") };
        using var rig = new IconRig(agent);
        rig.Vm.Update();
        rig.Settle();
        Assert.Equal(IconStatus.Meeting, rig.Meter.Reading.Status);
        var purple = IconLook.For(rig.Meter.Reading.Status, rig.Meter.Reading.Reached);
        Assert.Equal((IconColors.Meeting, 1.0, IconColors.Meeting, 0.90), (purple.DotColor, purple.DotFill, purple.RingColor, purple.RingOpacity));
        Assert.Equal(Avalonia.Media.Color.Parse("#A78BFA"), IconColors.Meeting);

        // It keeps filling, on the minute, with no read.
        var sweep = rig.Meter.Reading.SweepDegrees;
        rig.Run(TimeSpan.FromMinutes(10), TimeSpan.FromSeconds(1));
        Assert.True(rig.Meter.Reading.SweepDegrees > sweep);
        Assert.StartsWith("In a meeting · ", rig.Meter.Reading.Label);

        agent.DayProgress = agent.Progress(DayProgressStatus.Working, workedSec: 2 * 3600 + 600);
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Working };
        rig.Vm.Update();
        rig.Settle();
        Assert.Equal(IconStatus.Working, rig.Meter.Reading.Status);
        Assert.Equal(Avalonia.Media.Color.Parse("#6FC9B6"), IconLook.For(rig.Meter.Reading.Status, rig.Meter.Reading.Reached).RingColor);
    }

    [Fact]
    public void Still_in_a_meeting_brings_the_action_badge_and_its_motion_a_suggestion_only_its_quiet_badge()
    {
        var agent = new FakeAgent("10:30");
        agent.DayProgress = agent.Progress(DayProgressStatus.Working);
        using var rig = new IconRig(agent);
        rig.Vm.Update();
        agent.Alerts.Add(new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom"));
        rig.Run(1.5);
        Assert.Equal(AlertLevel.Info, rig.Alerts.Badge);

        agent.Alerts.Clear();
        agent.DayProgress = agent.Progress(DayProgressStatus.Meeting, meetingFrom: Ist.At("08:30"));
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting };
        agent.Alerts.Add(new MeetingAlert(MeetingAlertKind.StillInMeeting, At: Ist.At("08:30")));
        rig.Run(1.5);
        Assert.Equal(AlertLevel.Action, rig.Alerts.Badge);
        Assert.Equal("Still in a meeting?", rig.Alerts.Cards[0].Title);
    }
}

/// <summary>The meeting screens rendered headless, for reading against design pages 3 and 4.</summary>
public class MeetingScreenshotTests
{
    private static FakeAgent Agent(string now, Action<FakeAgent>? setup = null)
    {
        var agent = new FakeAgent(now);
        setup?.Invoke(agent);
        return agent;
    }

    private static async Task Shoot(string name, FakeAgent agent, double width = 1080, double height = 760)
    {
        var actions = new BreakActions(agent, new FakeDialogs(), NullLog.Instance);
        var center = new AlertCenter();
        var vm = new DashboardViewModel(agent, actions, NullLog.Instance, center);
        new MeetingAlerts(agent, center, actions).Sync();
        vm.Refresh();
        await vm.Chat.ActivateAsync();
        var window = new DashboardWindow { DataContext = vm, Width = width, Height = height };
        window.Show();
        vm.Refresh();
        var path = Shots.Save(window, name);
        Assert.True(new FileInfo(path).Length > 10_000, $"{name} looks empty");
        window.AllowClose = true;
        window.Close();
    }

    private static void InMeeting(FakeAgent a, string from)
    {
        a.DayProgress = a.Progress(DayProgressStatus.Meeting, meetingFrom: Ist.At(from));
        a.Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = Ist.At(from) };
        a.LiveMeeting = new MeetingRecord { Id = "s-1", Kind = MeetingKinds.Status, Agenda = "In a meeting", StartedAt = Ist.At(from), InProgress = true };
    }

    [AvaloniaFact]
    public Task Working_with_Start_meeting() => Shoot("meeting-working", Agent("10:30", a => a.DayProgress = a.Progress(DayProgressStatus.Working)));

    [AvaloniaFact]
    public Task In_a_meeting() => Shoot("meeting-in-a-meeting", Agent("13:10", a => InMeeting(a, "11:30")));

    [AvaloniaFact]
    public Task Suggestion_start() => Shoot("meeting-start-suggestion", Agent("10:30", a =>
    {
        a.DayProgress = a.Progress(DayProgressStatus.Working);
        a.Alerts.Add(new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom"));
    }));

    [AvaloniaFact]
    public Task Suggestion_huddle() => Shoot("meeting-start-suggestion-huddle", Agent("10:30", a =>
    {
        a.DayProgress = a.Progress(DayProgressStatus.Working);
        a.Alerts.Add(new MeetingAlert(MeetingAlertKind.StartMeeting, "Slack", IsHuddle: true));
    }));

    [AvaloniaFact]
    public Task Suggestion_end() => Shoot("meeting-end-suggestion", Agent("12:00", a =>
    {
        InMeeting(a, "11:30");
        a.Alerts.Add(new MeetingAlert(MeetingAlertKind.EndMeeting, "Teams"));
    }));

    [AvaloniaFact]
    public Task Still_in_a_meeting() => Shoot("meeting-still-in-a-meeting", Agent("13:30", a =>
    {
        InMeeting(a, "11:30");
        a.Alerts.Add(new MeetingAlert(MeetingAlertKind.StillInMeeting, At: Ist.At("11:30")));
    }));

    [AvaloniaFact]
    public Task Back_to_Working() => Shoot("meeting-back-to-working", Agent("13:42", a =>
    {
        a.DayProgress = a.Progress(DayProgressStatus.Working);
        a.Alerts.Add(new MeetingAlert(MeetingAlertKind.BackToWorking, At: Ist.At("13:40")));
    }));

    /// <summary>The icon itself at 56 px on a dark and a light wallpaper, read against design pages 3 and 4.</summary>
    [AvaloniaFact]
    public void Icon_states()
    {
        foreach (var (name, setup, alert) in new (string, Action<FakeAgent>, MeetingAlert?)[]
                 {
                     ("working", a => { a.DayProgress = a.Progress(DayProgressStatus.Working, workedSec: 2 * 3600); }, null),
                     ("in-a-meeting", a => { InMeeting(a, "11:30"); a.DayProgress = a.Progress(DayProgressStatus.Meeting, workedSec: 2 * 3600, meetingFrom: Ist.At("11:30")); }, null),
                     ("in-a-meeting-still", a => { InMeeting(a, "11:30"); a.DayProgress = a.Progress(DayProgressStatus.Meeting, workedSec: 2 * 3600, meetingFrom: Ist.At("11:30")); }, new MeetingAlert(MeetingAlertKind.StillInMeeting, At: Ist.At("11:30"))),
                     ("working-suggestion", a => { a.DayProgress = a.Progress(DayProgressStatus.Working, workedSec: 2 * 3600); }, new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom")),
                     ("past-target-in-a-meeting", a => { InMeeting(a, "11:30"); a.DayProgress = a.Progress(DayProgressStatus.Meeting, workedSec: 9 * 3600, meetingFrom: Ist.At("11:30")); }, null),
                     ("after-the-meeting", a => { a.DayProgress = a.Progress(DayProgressStatus.Working, workedSec: 5 * 3600 + 45 * 60); }, null),
                 })
        {
            var agent = Agent("13:30", setup);
            if (alert is not null) agent.Alerts.Add(alert);
            using var rig = new IconRig(agent);
            rig.Vm.Update();
            rig.DayAlerts.Sync();
            rig.Settle();
            var window = rig.Window();
            window.Show();
            IconRig.Pump();
            var path = Shots.Save(window, "meeting-icon-" + name);
            Assert.True(new FileInfo(path).Length > 500);
            window.Close();
        }
    }
}
