using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Icon;
using RXVision.Agent.ViewModels;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>Quiet until it is needed (AGENT.md section 2), all on the moved clock.</summary>
public class IconBehaviourTests
{
    private static IconRig Rig(string now = "10:20", Action<FakeAgent>? setup = null)
    {
        var agent = new FakeAgent(now);
        setup?.Invoke(agent);
        var rig = new IconRig(agent);
        rig.Vm.Update();
        return rig;
    }

    private static void IsFull(IconRig rig)
    {
        Assert.Equal(1, rig.Vm.Opacity, 3);
        Assert.Equal(1, rig.Vm.Saturation, 3);
    }

    private static void IsFaded(IconRig rig)
    {
        Assert.Equal(0.40, rig.Vm.Opacity, 3);
        Assert.Equal(0.60, rig.Vm.Saturation, 3);
    }

    private static IconRig FadedRig()
    {
        var rig = Rig();
        rig.Run(30.5);
        IsFaded(rig);
        return rig;
    }

    [Fact]
    public void Opacity_drops_30_s_after_the_day_starts_over_400_ms_with_saturation()
    {
        using var rig = Rig();
        rig.Run(29.9);
        IsFull(rig);
        rig.Run(0.3);
        Assert.InRange(rig.Vm.Opacity, 0.401, 0.99);
        Assert.InRange(rig.Vm.Saturation, 0.601, 0.99);
        rig.Run(0.25);
        IsFaded(rig);
        Assert.True(rig.Vm.RestsFaded);
        Assert.False(rig.Vm.IsFrameTimerRunning);
    }

    [Fact]
    public void The_fade_eases_out_and_opacity_and_saturation_move_together()
    {
        using var rig = Rig();
        rig.Run(30);
        for (var i = 0; i < 25; i++)
        {
            rig.Run(0.016);
            var share = (1 - rig.Vm.Opacity) / 0.6;
            Assert.Equal(1 - 0.4 * share, rig.Vm.Saturation, 3);
        }
    }

    [Fact]
    public void In_a_meeting_it_fades_too()
    {
        using var rig = Rig(setup: a => a.Presence = new CurrentPresence { Status = PresenceStatus.Meeting });
        rig.Run(30.5);
        IsFaded(rig);
    }

    [Theory]
    [InlineData(AgentState.NotStarted)]
    [InlineData(AgentState.DayEnded)]
    public void Outside_working_time_it_stays_in_full_colour(AgentState state)
    {
        using var rig = Rig(setup: a => a.State = state);
        rig.Run(40);
        IsFull(rig);
    }

    [Fact]
    public void On_a_break_and_extended_it_stays_in_full_colour()
    {
        using var rig = FadedRig();
        rig.Agent.Day = Days.General().WithActive(Days.Running("MORNING", "10:20"));
        rig.Vm.Update();
        rig.Run(0.2);
        IsFull(rig);
        rig.Run(40);
        IsFull(rig);
        rig.Agent.SetNow("10:40");
        rig.Vm.Update();
        Assert.Equal(IconStatus.BreakExtended, rig.Vm.Status);
        rig.Run(40);
        IsFull(rig);

        // Back at work: 30 s from the moment the reason went.
        rig.Agent.Day = Days.General();
        rig.DayAlerts.Sync();
        rig.Vm.Update();
        rig.Run(29.5);
        IsFull(rig);
        rig.Run(1);
        IsFaded(rig);
    }

    [Fact]
    public void An_interaction_starts_the_30_s_again_and_a_hover_does_not()
    {
        using var rig = Rig();
        rig.Run(20);
        rig.Vm.Interaction();
        rig.Run(20);
        IsFull(rig);
        rig.Vm.PointerOn();
        rig.Run(0.6);
        rig.Vm.PointerOff();
        rig.Run(9.0);
        IsFull(rig);
        rig.Run(1);
        IsFaded(rig);
    }

    [Fact]
    public void An_interaction_while_faded_brings_it_back()
    {
        using var rig = FadedRig();
        rig.Vm.Interaction();
        rig.Run(0.2);
        IsFull(rig);
        rig.Run(30.5);
        IsFaded(rig);
    }

    [Fact]
    public void A_half_second_hover_brings_it_back_in_about_150_ms_and_shows_the_time()
    {
        using var rig = FadedRig();
        rig.Vm.PointerOn();
        rig.Run(0.49);
        IsFaded(rig);
        Assert.False(rig.Vm.IsLabelVisible);

        rig.Run(0.02);
        Assert.True(rig.Vm.IsLabelVisible);
        Assert.Equal("Working · 1h 00m of 8h", rig.Vm.Label);
        Assert.True(rig.Vm.Opacity < 0.7, "it has only started");
        rig.Run(0.075);
        Assert.InRange(rig.Vm.Opacity, 0.5, 0.999);
        rig.Run(0.08);
        IsFull(rig);
    }

    [Fact]
    public void Leaving_sooner_than_the_half_second_does_nothing()
    {
        using var rig = FadedRig();
        rig.Vm.PointerOn();
        rig.Run(0.4);
        rig.Vm.PointerOff();
        rig.Run(1);
        IsFaded(rig);
        Assert.False(rig.Vm.IsLabelVisible);
    }

    [Fact]
    public void Hover_out_returns_to_40_percent_at_once_with_no_click()
    {
        using var rig = FadedRig();
        rig.Vm.PointerOn();
        rig.Run(0.8);
        IsFull(rig);
        Assert.True(rig.Vm.IsLabelVisible);

        rig.Vm.PointerOff();
        // At once: not one frame later, and no timer.
        IsFaded(rig);
        Assert.False(rig.Vm.IsLabelVisible);
        Assert.False(rig.Vm.IsFrameTimerRunning);
    }

    [Fact]
    public void Hover_out_before_the_30_s_stays_full_and_the_30_s_keeps_running()
    {
        using var rig = Rig();
        rig.Run(10);
        rig.Vm.PointerOn();
        rig.Run(0.6);
        Assert.True(rig.Vm.IsLabelVisible);
        rig.Vm.PointerOff();
        IsFull(rig);
        Assert.False(rig.Vm.IsLabelVisible);
        rig.Run(19);
        IsFull(rig);
        rig.Run(1);
        IsFaded(rig);
    }

    [Fact]
    public void The_30_s_running_out_under_a_hover_waits_for_the_pointer_to_leave()
    {
        using var rig = Rig();
        rig.Run(29);
        rig.Vm.PointerOn();
        rig.Run(5);
        IsFull(rig);
        Assert.True(rig.Vm.RestsFaded);
        rig.Vm.PointerOff();
        IsFaded(rig);
    }

    [Fact]
    public void An_alert_forces_full_colour_in_150_ms_and_holds_it()
    {
        using var rig = FadedRig();
        rig.Alerts.Raise(new AlertCard("x", AlertLevel.Info, "Break ends in 2 min"));
        rig.Run(0.075);
        Assert.InRange(rig.Vm.Opacity, 0.5, 0.999);
        rig.Run(0.08);
        IsFull(rig);
        rig.Run(120);
        IsFull(rig);
        Assert.True(rig.Vm.HasBadge);
    }

    [Fact]
    public void A_message_count_holds_full_colour_too()
    {
        using var rig = FadedRig();
        rig.Vm.MessageCount = 3;
        rig.Run(0.2);
        IsFull(rig);
        rig.Run(60);
        IsFull(rig);
        Assert.Equal("3", rig.Vm.BadgeGlyph);
    }

    [Fact]
    public void An_open_panel_holds_full_colour_and_closing_it_starts_the_30_s()
    {
        using var rig = FadedRig();
        rig.Vm.SetPanelOpen(true);
        rig.Run(0.2);
        IsFull(rig);
        rig.Run(120);
        IsFull(rig);

        rig.Vm.SetPanelOpen(false);
        rig.Run(29.5);
        IsFull(rig);
        rig.Run(1);
        IsFaded(rig);
    }

    [Fact]
    public void Opening_clears_the_badge_and_closing_lets_it_fade()
    {
        using var rig = Rig();
        rig.Alerts.Raise(new AlertCard("x", AlertLevel.Action, "Time for your morning break"));
        rig.Run(40);
        IsFull(rig);
        rig.Vm.SetPanelOpen(true);
        Assert.False(rig.Vm.HasBadge);
        rig.Vm.SetPanelOpen(false);
        rig.Run(30.5);
        IsFaded(rig);
        Assert.False(rig.Vm.HasBadge);
    }

    [Fact]
    public void At_rest_only_the_minute_tick_is_waiting()
    {
        using var rig = FadedRig();
        rig.Run(5);
        Assert.False(rig.Vm.IsFrameTimerRunning);
        Assert.Equal(1, rig.Clock.Pending);
    }

    [Fact]
    public void At_rest_a_full_minute_with_no_change_of_number_draws_nothing_new()
    {
        using var rig = Rig(setup: a => a.State = AgentState.DayEnded);
        rig.Run(5);
        var frames = 0;
        rig.Vm.PropertyChanged += (_, e) => { if (e.PropertyName == nameof(BubbleViewModel.Frame)) frames++; };
        rig.Run(180);
        Assert.Equal(0, frames);
    }
}
