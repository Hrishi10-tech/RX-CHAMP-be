using Avalonia.Headless.XUnit;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// An End Day done offline that the server refused for comments (4.0): the person adds a comment
/// for each break the server listed, keyed by exactly the ids it gave (auto-skips End Day will make
/// included), and the day ends at the time they ended it.
/// </summary>
public class HeldEndDayTests
{
    /// <summary>The lunch auto-skip End Day will make, with the id the server says it will get.</summary>
    public const string PlannedId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    public static HeldEndDay Held() => new(Ist.At("18:30").ToUniversalTime(), new[]
    {
        new SkipNeedingComment
        {
            Id = PlannedId, Date = "2026-10-13", Kind = "LUNCH", Label = "Lunch break", Outcome = BreakOutcomes.AutoSkipped,
            SkippedAt = Ist.At("14:00").ToUniversalTime(), ScheduledStart = Ist.At("13:00").ToUniversalTime(), DurationMin = 30, MinChars = 10,
        },
    }, "Add a comment to your skipped break before you end the day.");

    private static (BreakActions Actions, FakeAgent Agent, FakeDialogs Dialogs) Setup(string now)
    {
        var agent = new FakeAgent(now);
        var dialogs = new FakeDialogs();
        return (new BreakActions(agent, dialogs, NullLog.Instance), agent, dialogs);
    }

    [Fact]
    public async Task Asks_for_the_listed_breaks_and_ends_the_day_when_the_person_ended_it()
    {
        var (actions, agent, dialogs) = Setup("21:05");
        agent.HeldEndDay = Held();
        dialogs.Answer(d =>
        {
            var end = Assert.IsType<EndDayDialogViewModel>(d);
            Assert.Equal("You ended your day at 6:30 PM while offline. RX Vision needs a comment for a skipped break before it can save that. " +
                         "With it, your day ends at 6:30 PM.", end.Message);
            Assert.Equal(new[] { PlannedId }, end.Items.Select(i => i.Id));
            Assert.Equal("Lunch break", end.Items[0].Name);
            end.Items[0].Text = "Client call ran through lunch";
            return true;
        });
        await actions.EndDayAsync();

        Assert.Equal(Held().At, agent.EndDayTimes.Single());
        var comment = Assert.Single(agent.EndDayCalls.Single()!);
        Assert.Equal((PlannedId, "Client call ran through lunch"), (comment.BreakId, comment.Comment));
        Assert.Null(agent.HeldEndDay);
        Assert.Equal(AgentState.DayEnded, agent.State);
    }

    [Fact]
    public async Task The_servers_newer_list_is_answered_as_it_is_and_the_time_kept()
    {
        var (actions, agent, dialogs) = Setup("21:05");
        agent.HeldEndDay = Held();
        var evening = Days.NeedsComment("EVENING", "17:00");
        agent.EndDayOutcomes.Enqueue(new EndDayOutcome.CommentsRequired(new[] { Held().Breaks[0], evening }, "Add a comment to each of your 2 skipped breaks."));
        dialogs.Answer(d => { ((EndDayDialogViewModel)d).Items[0].Text = "Client call ran through lunch"; return true; });
        dialogs.Answer(d =>
        {
            var end = Assert.IsType<EndDayDialogViewModel>(d);
            Assert.Equal(new[] { PlannedId, evening.Id }, end.Items.Select(i => i.Id));
            Assert.Equal("Client call ran through lunch", end.Items[0].Text);   // what was typed stays
            end.Items[1].Text = "Stayed on the release call";
            return true;
        });
        await actions.EndDayAsync();

        Assert.Equal(new DateTimeOffset?[] { Held().At, Held().At }, agent.EndDayTimes);
        Assert.Equal(new[] { PlannedId, evening.Id }, agent.EndDayCalls[1]!.Select(c => c.BreakId));
    }

    [Fact]
    public async Task Without_a_held_End_Day_the_day_ends_now()
    {
        var (actions, agent, dialogs) = Setup("18:40");
        dialogs.Answer(d => Assert.IsType<MessageDialogViewModel>(d).Title == "End your day?");
        await actions.EndDayAsync();
        Assert.Null(agent.EndDayTimes.Single());
    }

    [Fact]
    public void The_dashboard_says_an_End_Day_waits_for_comments()
    {
        var agent = new FakeAgent("21:05") { HeldEndDay = Held() };
        var vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), NullLog.Instance);
        vm.Refresh();
        Assert.True(vm.HasHeldEndDay);
        Assert.Equal("Your End Day at 6:30 PM needs a comment on a skipped break. Until then your day stays open.", vm.HeldEndDayText);
        Assert.True(vm.EndDayCommand.CanExecute(null));

        agent.HeldEndDay = null;
        vm.Refresh();
        Assert.False(vm.HasHeldEndDay);
    }

    [Fact]
    public void The_card_offers_to_add_the_comments_until_it_is_resolved()
    {
        // 3.6: an "!" card on the panel and the icon (it was a toast).
        var agent = new FakeAgent("21:05");
        agent.HeldEndDay = Held();
        var center = new AlertCenter();
        var alerts = new DayAlerts(agent, center, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), _ => { });
        alerts.OnEndDayHeld(agent.HeldEndDay);
        var card = Assert.Single(center.Cards);
        Assert.Equal("Your End Day at 6:30 PM needs a comment", card.Title);
        Assert.Equal("A skipped break needs a comment before your day can end then. Until you add it, your day stays open.", card.Body);
        Assert.Equal("Add comments", card.PrimaryText);
        Assert.True(card.IsAction);

        agent.HeldEndDay = null;
        alerts.Sync();
        Assert.Empty(center.Cards);
    }
}

/// <summary>Screenshots of the held End Day: the banner and the dialog (see <see cref="Shots.Dir"/>).</summary>
public class HeldEndDayScreenshots
{
    private static async Task Shoot(string name, FakeAgent agent, Func<DashboardViewModel, Task>? before = null)
    {
        var vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), NullLog.Instance);
        vm.Refresh();
        await vm.Chat.ActivateAsync();
        var window = new DashboardWindow { DataContext = vm, Width = 1080, Height = 700 };
        window.Show();
        vm.Refresh();
        if (before is not null) await before(vm);
        DashboardHarness.Settle();
        var path = Shots.Save(window, name);
        Assert.True(new FileInfo(path).Length > 10_000, $"{name} looks empty");
        window.AllowClose = true;
        window.Close();
    }

    [AvaloniaFact]
    public Task Banner() => Shoot("41-dashboard-end-day-held", new FakeAgent("21:05") { HeldEndDay = HeldEndDayTests.Held() });

    [AvaloniaFact]
    public Task Dialog()
    {
        var agent = new FakeAgent("21:05") { HeldEndDay = HeldEndDayTests.Held() };
        var actions = new BreakActions(agent, new FakeDialogs(), NullLog.Instance);
        var held = agent.HeldEndDay!;
        var item = new SkipCommentItemViewModel(held.Breaks[0].Id, "Lunch break", "Auto-skipped at 2:00 PM", 10, BreakActions.SkipChips, kind: "LUNCH");
        var dialog = new EndDayDialogViewModel(new[] { item }, actions.Approver, actions.ApproverCapital, actions.HeldIntro(held));
        return Shoot("41-dialog-end-day-held", agent, vm => { vm.Overlay = dialog; return Task.CompletedTask; });
    }
}
