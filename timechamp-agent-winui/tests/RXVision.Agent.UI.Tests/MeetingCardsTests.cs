using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.VisualTree;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>The meeting cards on top of the panel, their exact words and actions, and the badge on the icon.</summary>
public class MeetingCardsTests
{
    private static (MeetingCardsViewModel Vm, FakeAgent Agent, FakeDialogs Dialogs) Setup(string now, params MeetingAlert[] alerts)
    {
        var agent = new FakeAgent(now);
        agent.Alerts.AddRange(alerts);
        var dialogs = new FakeDialogs();
        return (new MeetingCardsViewModel(agent, new BreakActions(agent, dialogs, NullLog.Instance)), agent, dialogs);
    }

    [Theory]
    [InlineData("Teams", "You look to be on a Teams call.")]
    [InlineData("Zoom", "You look to be on a Zoom call.")]
    [InlineData("Google Meet", "You look to be on a Google Meet call.")]
    public void Start_meeting_card_has_the_decks_words(string app, string body)
    {
        var (vm, _, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.StartMeeting, app));
        vm.Update(panelOpen: true);
        var card = Assert.Single(vm.Cards);
        Assert.Equal(("Start meeting?", body, "Start meeting", "Not now", "i"), (card.Title, card.Body, card.PrimaryText, card.SecondaryText, card.Badge));
        Assert.True(card.ShowQuietSecondary);
        Assert.False(card.ShowOutlinedSecondary);
    }

    [Fact]
    public void A_Slack_huddle_says_huddle()
    {
        var (vm, _, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.StartMeeting, "Slack", IsHuddle: true));
        vm.Update(panelOpen: true);
        Assert.Equal("You look to be in a Slack huddle.", vm.Cards[0].Body);

        var (end, _, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.EndMeeting, "Slack", IsHuddle: true));
        end.Update(panelOpen: true);
        Assert.Equal("Your Slack huddle looks finished.", end.Cards[0].Body);
    }

    [Fact]
    public void End_meeting_card_has_the_decks_words()
    {
        var (vm, _, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.EndMeeting, "Zoom"));
        vm.Update(panelOpen: true);
        var card = Assert.Single(vm.Cards);
        Assert.Equal(("End meeting?", "Your Zoom call looks finished.", "End meeting", "Not now", "i"), (card.Title, card.Body, card.PrimaryText, card.SecondaryText, card.Badge));
        Assert.True(card.ShowQuietSecondary);
    }

    [Fact]
    public void Still_in_a_meeting_card_has_the_decks_words_and_counts_on()
    {
        var (vm, agent, _) = Setup("13:30", new MeetingAlert(MeetingAlertKind.StillInMeeting, At: Ist.At("11:30")));
        vm.Update(panelOpen: true);
        var card = Assert.Single(vm.Cards);
        Assert.Equal(("Still in a meeting?", "You've been in this meeting for 2h 00m.", "Still in it", "End meeting", "!"), (card.Title, card.Body, card.PrimaryText, card.SecondaryText, card.Badge));
        Assert.True(card.ShowOutlinedSecondary);
        Assert.False(card.ShowQuietSecondary);
        agent.SetNow("13:37");
        vm.Update(panelOpen: true);
        Assert.Equal("You've been in this meeting for 2h 07m.", vm.Cards[0].Body);
    }

    [Fact]
    public void Back_to_Working_card_has_the_decks_words_on_the_12_hour_clock()
    {
        var (vm, _, _) = Setup("16:12", new MeetingAlert(MeetingAlertKind.BackToWorking, At: Ist.At("16:10")));
        vm.Update(panelOpen: true);
        var card = Assert.Single(vm.Cards);
        Assert.Equal(("You're back to Working", "Tap Start meeting if you're still in one. Your status moved to Working at 4:10 PM.", "Start meeting", "i"), (card.Title, card.Body, card.PrimaryText, card.Badge));
        Assert.Null(card.SecondaryCommand);
    }

    [Fact]
    public async Task Tapping_acts_only_through_the_status_routes_and_says_where_it_came_from()
    {
        var (vm, agent, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom"));
        vm.Update(panelOpen: true);
        Assert.Empty(agent.MeetingStartSources);
        await vm.Cards[0].PrimaryCommand.ExecuteAsync(null);
        Assert.Equal(new[] { MeetingSources.Suggestion }, agent.MeetingStartSources);

        agent.Alerts.Clear();
        agent.Alerts.Add(new MeetingAlert(MeetingAlertKind.EndMeeting, "Zoom"));
        vm.Update(panelOpen: true);
        await vm.Cards[0].PrimaryCommand.ExecuteAsync(null);
        Assert.Equal(1, agent.EndMeetingCalls);

        agent.Alerts.Clear();
        agent.Alerts.Add(new MeetingAlert(MeetingAlertKind.StillInMeeting, At: Ist.At("08:30")));
        vm.Update(panelOpen: true);
        await vm.Cards[0].PrimaryCommand.ExecuteAsync(null);
        Assert.Equal(1, agent.ConfirmCalls);
        Assert.IsAssignableFrom<CommunityToolkit.Mvvm.Input.IAsyncRelayCommand>(vm.Cards[0].SecondaryCommand);
        await ((CommunityToolkit.Mvvm.Input.IAsyncRelayCommand)vm.Cards[0].SecondaryCommand!).ExecuteAsync(null);
        Assert.Equal(2, agent.EndMeetingCalls);

        agent.Alerts.Clear();
        agent.Alerts.Add(new MeetingAlert(MeetingAlertKind.BackToWorking, At: Ist.At("10:30")));
        agent.DayProgress = agent.Progress(DayProgressStatus.Working);
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Working };
        vm.Update(panelOpen: true);
        await vm.Cards[0].PrimaryCommand.ExecuteAsync(null);
        Assert.Equal(MeetingSources.Button, agent.MeetingStartSources[^1]);
    }

    [Fact]
    public void Not_now_only_dismisses_and_nothing_changes_by_itself()
    {
        var (vm, agent, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom"));
        vm.Update(panelOpen: true);
        vm.Cards[0].SecondaryCommand!.Execute(null);
        Assert.Equal(new[] { MeetingAlertKind.StartMeeting }, agent.DismissedAlerts);
        Assert.Empty(agent.MeetingStartSources);
        vm.Update(panelOpen: true);
        Assert.Empty(vm.Cards);
        Assert.False(vm.HasCards);
    }

    [Fact]
    public void The_badge_stays_until_the_panel_opens_and_the_card_stays_after()
    {
        var alert = new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom");
        var (vm, agent, _) = Setup("10:30", alert);
        vm.Update(panelOpen: false);
        Assert.Equal("i", vm.Badge);
        vm.Update(panelOpen: false);
        Assert.Equal("i", vm.Badge);
        vm.Update(panelOpen: true);
        Assert.Null(vm.Badge);
        vm.Update(panelOpen: false);
        Assert.Null(vm.Badge); // seen: it does not come back
        Assert.Single(vm.Cards); // and the card stays until it is acted on or stops being true

        // A new alert, the panel shut: a new badge. "!" over "i".
        agent.Alerts.Insert(0, new MeetingAlert(MeetingAlertKind.StillInMeeting, At: Ist.At("08:30")));
        vm.Update(panelOpen: false);
        Assert.Equal("!", vm.Badge);
        Assert.Equal(new[] { "Still in a meeting?", "Start meeting?" }, vm.Cards.Select(c => c.Title));

        // With the panel open a new alert puts a card on top with no badge.
        var (open, openAgent, _) = Setup("10:30");
        open.Update(panelOpen: true);
        openAgent.Alerts.Add(alert);
        open.Update(panelOpen: true);
        Assert.Single(open.Cards);
        Assert.Null(open.Badge);
    }

    [Fact]
    public void A_card_that_stops_being_true_goes_with_its_badge()
    {
        var (vm, agent, _) = Setup("10:30", new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom"));
        vm.Update(panelOpen: false);
        Assert.Equal("i", vm.Badge);
        agent.Alerts.Clear();
        vm.Update(panelOpen: false);
        Assert.Null(vm.Badge);
        Assert.Empty(vm.Cards);
    }

    [AvaloniaFact]
    public void The_panel_draws_the_cards_on_top_with_their_actions_ready()
    {
        var agent = new FakeAgent("10:30");
        agent.Alerts.Add(new MeetingAlert(MeetingAlertKind.StartMeeting, "Zoom"));
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("Start meeting?"));
        Assert.True(ui.Shows("You look to be on a Zoom call."));
        Assert.True(ui.HasButton("Not now"));
        var card = ui.Window.GetVisualDescendants().OfType<MeetingCardsView>().Single();
        var tile = ui.Window.GetVisualDescendants().OfType<Button>().First(b => b.Classes.Contains("tile"));
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

/// <summary>The icon follows the one reading of the status.</summary>
public class MeetingBubbleTests
{
    [Fact]
    public void The_icon_reads_the_day_progress_and_follows_the_fallback()
    {
        var agent = new FakeAgent("10:30");
        var bubble = new BubbleViewModel();
        agent.DayProgress = agent.Progress(DayProgressStatus.Working);
        bubble.Update(agent);
        Assert.True(bubble.IsWorking);

        agent.DayProgress = agent.Progress(DayProgressStatus.Meeting);
        bubble.Update(agent);
        Assert.True(bubble.IsMeeting);
        Assert.Contains("In a meeting", bubble.ToolTip);

        // The fallback: in 4.0 the host's presence follows the day progress, and the icon follows both.
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Working };
        agent.DayProgress = agent.Progress(DayProgressStatus.Working);
        bubble.Update(agent);
        Assert.True(bubble.IsWorking);

        // On a break a meeting's status never shows.
        agent.Day = Days.General().WithActive(Days.Running("MORNING", "10:25"));
        agent.DayProgress = agent.Progress(DayProgressStatus.Meeting);
        bubble.Update(agent);
        Assert.True(bubble.IsAway);
    }

    [Theory]
    [InlineData(DayStatus.Working, false, BubbleStatus.Working)]
    [InlineData(DayStatus.InMeeting, false, BubbleStatus.Meeting)]
    [InlineData(DayStatus.OnBreak, false, BubbleStatus.Away)]
    [InlineData(DayStatus.OnBreak, true, BubbleStatus.Overrun)]
    [InlineData(DayStatus.NotStarted, false, BubbleStatus.Idle)]
    [InlineData(DayStatus.DayEnded, false, BubbleStatus.Idle)]
    public void One_status_one_look(DayStatus status, bool overrun, BubbleStatus look) => Assert.Equal(look, BubbleViewModel.StatusFor(status, overrun));

    [Fact]
    public void A_meeting_card_badge_goes_over_the_count()
    {
        var bubble = new BubbleViewModel();
        var agent = new FakeAgent("10:30") { ChatUnread = 3 };
        bubble.Update(agent);
        Assert.True(bubble.ShowUnread);
        bubble.AlertBadge = "i";
        Assert.True(bubble.HasAlertBadge);
        Assert.False(bubble.ShowUnread);
        bubble.AlertBadge = null;
        Assert.True(bubble.ShowUnread);
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
        var vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), NullLog.Instance);
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

    [AvaloniaFact]
    public void Icon_states()
    {
        foreach (var (name, setup, badge) in new (string, Action<FakeAgent>, string?)[]
                 {
                     ("working", a => a.DayProgress = a.Progress(DayProgressStatus.Working), null),
                     ("in-a-meeting", a => InMeeting(a, "11:30"), null),
                     ("in-a-meeting-still", a => InMeeting(a, "11:30"), "!"),
                     ("working-suggestion", a => a.DayProgress = a.Progress(DayProgressStatus.Working), "i"),
                 })
        {
            var agent = Agent("13:30", setup);
            var vm = new BubbleViewModel { AlertBadge = badge };
            vm.Update(agent);
            var window = new BubbleWindow { DataContext = vm };
            window.Show();
            var path = Shots.Save(window, "meeting-icon-" + name);
            Assert.True(new FileInfo(path).Length > 500);
            window.Close();
        }
    }
}
