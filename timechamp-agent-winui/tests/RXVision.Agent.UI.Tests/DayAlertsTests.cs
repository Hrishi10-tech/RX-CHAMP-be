using Avalonia.Headless.XUnit;
using Avalonia.Input;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>Each alert in AGENT.md section 3: when it fires, its card, its actions, when it goes.</summary>
public class DayAlertsTests
{
    private static IconRig Rig(string now, Action<FakeAgent>? setup = null)
    {
        var agent = new FakeAgent(now);
        setup?.Invoke(agent);
        var rig = new IconRig(agent);
        rig.DayAlerts.Sync();
        rig.Vm.Update();
        return rig;
    }

    private static void At(IconRig rig, string hm)
    {
        rig.Agent.SetNow(hm);
        rig.DayAlerts.Sync();
        rig.Vm.Update();
    }

    [Fact]
    public void Break_due_fires_at_the_rings_start_with_its_words_and_actions()
    {
        using var rig = Rig("10:58:59");
        Assert.Empty(rig.Alerts.Cards);
        At(rig, "10:59:00");
        var card = Assert.Single(rig.Alerts.Cards);
        Assert.Equal("!", rig.Vm.BadgeGlyph);
        Assert.Equal("Time for your morning break", card.Title);
        Assert.Equal("15 min, from 11:00 AM.", card.Body);
        Assert.Equal("Take a break", card.PrimaryText);
        Assert.Equal("Skip this break", card.SecondaryText);
    }

    [Fact]
    public async Task Break_due_takes_with_no_question_inside_the_ring()
    {
        using var rig = Rig("10:59:30");
        await rig.Alerts.Cards[0].PrimaryCommand.ExecuteAsync(null);
        Assert.Equal(("MORNING", (string?)null), Assert.Single(rig.Agent.TakeCalls));
    }

    [Fact]
    public void A_slot_that_cannot_be_skipped_has_no_skip()
    {
        using var rig = Rig("12:59:30", a => a.Day = Days.General());
        var card = Assert.Single(rig.Alerts.Cards);
        Assert.Equal("Time for your lunch break", card.Title);
        Assert.False(card.HasSecondary);
    }

    [Fact]
    public void A_break_End_Day_already_skipped_is_not_asked_about_again()
    {
        using var rig = Rig("10:59:50", a => a.Day!.Breaks[0].Record = Days.Skip("MORNING", "10:59:40", auto: true));
        Assert.True(rig.Agent.BreakPanel.Slots[0].CanStart);
        Assert.Empty(rig.Alerts.Cards);
    }

    [Fact]
    public void Break_due_stays_past_the_ring_and_goes_when_the_window_closes()
    {
        using var rig = Rig("10:59:30");
        At(rig, "11:30");
        Assert.Single(rig.Alerts.Cards);
        At(rig, "12:00:01");
        Assert.Empty(rig.Alerts.Cards);
        Assert.False(rig.Vm.HasBadge);
    }

    [Fact]
    public void Break_due_goes_when_taken_or_skipped()
    {
        using var taken = Rig("10:59:30");
        taken.Agent.Day = Days.General().WithActive(Days.Running("MORNING", "11:00"));
        At(taken, "11:00:30");
        Assert.DoesNotContain(taken.Alerts.Cards, c => c.Key == DayAlerts.BreakDueKey);

        using var skipped = Rig("10:59:30");
        skipped.Agent.Day = Days.General().WithRecord(Days.Skip("MORNING", "10:59:40", auto: false, reason: "Client call"));
        At(skipped, "11:00:30");
        Assert.DoesNotContain(skipped.Alerts.Cards, c => c.Key == DayAlerts.BreakDueKey);
    }

    [Fact]
    public void Break_due_comes_in_a_meeting_too_and_never_before_the_day_starts()
    {
        using var meeting = Rig("10:59:30", a => a.Presence = new CurrentPresence { Status = PresenceStatus.Meeting });
        Assert.Single(meeting.Alerts.Cards);

        using var early = Rig("10:59:30", a => a.State = AgentState.NotStarted);
        Assert.Empty(early.Alerts.Cards);
        using var ended = Rig("10:59:30", a => a.State = AgentState.DayEnded);
        Assert.Empty(ended.Alerts.Cards);
    }

    [Fact]
    public void Break_ends_in_2_min_at_120_s_left_is_information_and_goes_when_the_break_runs_out()
    {
        using var rig = Rig("11:12:59", a => a.Day = Days.General().WithActive(Days.Running("MORNING", "11:00")));
        Assert.Empty(rig.Alerts.Cards);
        At(rig, "11:13:00");
        var card = Assert.Single(rig.Alerts.Cards);
        Assert.Equal("i", rig.Vm.BadgeGlyph);
        Assert.Equal("Break ends in 2 min", card.Title);
        Assert.Equal("Your ring starts again when you resume.", card.Body);
        Assert.Equal("Resume now", card.PrimaryText);

        At(rig, "11:15:01");
        Assert.Equal(DayAlerts.BreakExtendedKey, Assert.Single(rig.Alerts.Cards).Key);
    }

    [Fact]
    public void A_break_of_2_min_or_less_has_no_such_card()
    {
        using var rig = Rig("11:00:30", a => a.Day = Days.General().WithActive(Days.Running("MORNING", "11:00", duration: 2)));
        Assert.Empty(rig.Alerts.Cards);
    }

    [Fact]
    public void Break_extended_is_an_action_with_its_words_and_goes_on_resume()
    {
        using var rig = Rig("13:45:30", a => a.Day = Days.General().WithActive(Days.Running("LUNCH", "13:00", duration: 45)));
        var card = Assert.Single(rig.Alerts.Cards);
        Assert.Equal("!", rig.Vm.BadgeGlyph);
        Assert.Equal("Break extended", card.Title);
        Assert.Equal("Your lunch break ended at 1:45 PM.", card.Body);
        Assert.Equal("Resume work", card.PrimaryText);

        rig.Agent.Day = Days.General();
        At(rig, "13:50");
        Assert.DoesNotContain(rig.Alerts.Cards, c => c.Key == DayAlerts.BreakExtendedKey);
    }

    [Fact]
    public void A_break_with_no_length_has_no_end_card_and_no_extended_card()
    {
        using var rig = Rig("13:45", a =>
        {
            a.Day = Days.Free();
            a.Presence = new CurrentPresence { Status = PresenceStatus.Break, Since = Ist.At("11:00") };
        });
        Assert.Empty(rig.Alerts.Cards);
    }

    [Fact]
    public async Task Resume_goes_back_to_work()
    {
        using var rig = Rig("11:14", a => a.Day = Days.General().WithActive(Days.Running("MORNING", "11:00")));
        // 4.0 confirms every End break (SPEC 2.3): the card's Resume now goes through that question.
        rig.Dialogs.Answer(_ => true);
        await rig.Alerts.Cards[0].PrimaryCommand.ExecuteAsync(null);
        Assert.Equal(1, rig.Agent.BackToWorkCalls);
    }

    [Fact]
    public async Task Skipped_for_you_asks_for_a_comment_until_it_is_sent()
    {
        var record = Days.Skip("MORNING", "12:00", auto: true);
        using var rig = Rig("12:01", a =>
        {
            a.Day = Days.General().WithRecord(record);
            a.Workday!.SkipsNeedingComment.Add(Days.NeedsComment("MORNING", "12:00"));
        });
        rig.DayAlerts.OnAutoSkipped(record);
        var card = Assert.Single(rig.Alerts.Cards);
        Assert.Equal("!", rig.Vm.BadgeGlyph);
        Assert.Equal("Morning break skipped for you.", card.Title);
        Assert.Equal("Add a comment before you end your day.", card.Body);
        Assert.Equal("Add comment", card.PrimaryText);
        await card.PrimaryCommand.ExecuteAsync(null);

        rig.Vm.SetPanelOpen(true);
        rig.DayAlerts.Sync();
        Assert.Single(rig.Alerts.Cards); // Being seen is not being answered.

        record.NeedsComment = false;
        rig.DayAlerts.Sync();
        Assert.Empty(rig.Alerts.Cards);
    }

    [Fact]
    public void Start_your_day_comes_from_the_nudge_and_goes_when_the_day_starts()
    {
        using var rig = Rig("08:55", a => a.State = AgentState.NotStarted);
        rig.DayAlerts.OnNudge(new AgentNudge(NudgeKind.Greeting, "2026-10-13"));
        var card = Assert.Single(rig.Alerts.Cards);
        Assert.Equal("i", rig.Vm.BadgeGlyph);
        Assert.Equal("Good morning, Asha.", card.Title);
        Assert.Equal("Tap Start day when you begin work.", card.Body);
        Assert.Equal("Start day", card.PrimaryText);

        rig.DayAlerts.OnNudge(new AgentNudge(NudgeKind.AtDesk, "2026-10-13"));
        card = Assert.Single(rig.Alerts.Cards); // One card at a time.
        Assert.Equal("You're at your desk. Start your day?", card.Title);
        Assert.Equal("Nothing is recorded until you do.", card.Body);

        rig.Agent.SetNow("14:05");
        rig.DayAlerts.OnNudge(new AgentNudge(NudgeKind.Greeting, null));
        Assert.Equal("Good afternoon, Asha.", Assert.Single(rig.Alerts.Cards).Title);

        rig.Agent.State = AgentState.Running;
        rig.DayAlerts.Sync();
        Assert.Empty(rig.Alerts.Cards);
    }

    [Fact]
    public void A_nudge_once_the_day_runs_says_nothing()
    {
        using var rig = Rig("10:20");
        rig.DayAlerts.OnNudge(new AgentNudge(NudgeKind.AtDesk, null));
        Assert.Empty(rig.Alerts.Cards);
    }

    [Fact]
    public void A_notice_from_the_server_shows_as_sent_and_goes_once_read()
    {
        using var rig = Rig("10:20");
        rig.DayAlerts.OnNotification(new NotificationItem { Id = "n1", Type = "FOCUS_ADJUSTED", Title = "Your focus time changed", Body = "Plus 15 min, by Maya" });
        var card = Assert.Single(rig.Alerts.Cards);
        Assert.Equal("i", rig.Vm.BadgeGlyph);
        Assert.Equal("Your focus time changed", card.Title);
        Assert.Equal("Plus 15 min, by Maya", card.Body);
        Assert.False(card.HasPrimary);

        rig.Vm.SetPanelOpen(true);
        Assert.Single(rig.Alerts.Cards);
        Assert.False(rig.Vm.HasBadge);
        rig.Vm.SetPanelOpen(false);
        Assert.Empty(rig.Alerts.Cards);
    }

    [Fact]
    public async Task An_approval_notice_opens_the_portal()
    {
        using var rig = Rig("10:20");
        rig.DayAlerts.OnNotification(new NotificationItem { Id = "n2", Type = "SKIP_REQUESTED", Title = "Asha skipped a break" });
        var card = Assert.Single(rig.Alerts.Cards);
        Assert.Equal("Open approvals", card.PrimaryText);
        await card.PrimaryCommand.ExecuteAsync(null);
        Assert.Contains("https://app.rxvision.shop", Assert.Single(rig.OpenedUrls));
    }

    [Fact]
    public void Cards_read_the_action_before_the_information_then_newest_first()
    {
        var center = new AlertCenter();
        center.Raise(new AlertCard("i1", AlertLevel.Info, "first"));
        center.Raise(new AlertCard("a1", AlertLevel.Action, "second"));
        center.Raise(new AlertCard("i2", AlertLevel.Info, "third"));
        center.Raise(new AlertCard("a2", AlertLevel.Action, "fourth"));
        Assert.Equal(new[] { "a2", "a1", "i2", "i1" }, center.Cards.Select(c => c.Key));
    }

    [Fact]
    public void Signing_out_clears_every_alert()
    {
        using var rig = Rig("10:59:30");
        Assert.NotEmpty(rig.Alerts.Cards);
        rig.DayAlerts.Reset();
        Assert.Empty(rig.Alerts.Cards);
        Assert.False(rig.Vm.HasBadge);
    }

    // ---- On the panel ----------------------------------------------------------------------------

    [AvaloniaFact]
    public void The_panel_opens_with_the_notification_on_top_and_keyboard_focus_on_its_action()
    {
        var agent = new FakeAgent("10:59:30");
        var ui = new DashboardHarness(agent);
        ui.Alerts().Sync();
        ui.Alerts().OnNotification(new NotificationItem { Id = "n3", Type = "FOCUS_ADJUSTED", Title = "Your focus time changed" });
        DashboardHarness.Settle();
        Assert.True(ui.Shows("Time for your morning break"));
        Assert.True(ui.Shows("15 min, from 11:00 AM."));
        Assert.True(ui.Shows("Your focus time changed"));
        var take = ui.Button("Take a break");
        Assert.True(ui.Window.AlertCardsForTests.FocusTopAction());
        DashboardHarness.Settle();
        Assert.Same(take, ui.Window.FocusManager!.GetFocusedElement());

        // Enter on the focused action does it.
        ui.Press(Key.Enter);
        DashboardHarness.Settle();
        Assert.Equal(("MORNING", (string?)null), Assert.Single(agent.TakeCalls));
        ui.Close();
    }

    [AvaloniaFact]
    public void The_panel_shows_the_same_value_as_the_ring()
    {
        var agent = new FakeAgent("10:20")
        {
            DayProgress = new Core.Workday.DayProgress { Status = "WORKING", Date = "2026-10-13", WorkedSec = 3 * 3600 + 30 * 60, TargetSec = 8 * 3600 },
        };
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("3h 30m of 8h"));
        Assert.True(ui.Shows("4h 30m to go"));
        ui.Close();
    }

    [AvaloniaFact]
    public void Shots_of_the_cards_on_the_panel()
    {
        var agent = new FakeAgent("13:50");
        agent.Day = Days.General().WithActive(Days.Running("MORNING", "13:30"));
        var ui = new DashboardHarness(agent);
        ui.Alerts().Sync();
        ui.Refresh();
        Assert.True(new FileInfo(Shots.Save(ui.Window, "panel-alert-extended")).Length > 10_000);
        ui.Close();
    }
}
