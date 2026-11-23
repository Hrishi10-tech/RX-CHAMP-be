using RXVision.Agent.Icon;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>The badge and its shake (AGENT.md section 3), read from the moved clock.</summary>
public class AlertMotionTests
{
    private static AlertCard Action(string key = "due") => new(key, AlertLevel.Action, "Time for your morning break");
    private static AlertCard Info(string key = "ending") => new(key, AlertLevel.Info, "Break ends in 2 min");

    /// <summary>Each stretch of movement, from its first frame off centre to its last, in ms from <paramref name="start"/>.</summary>
    private static List<(double From, double To)> Moves(IconRig rig, TimeSpan start, double seconds, TimeSpan frame)
    {
        var moves = new List<(double From, double To)>();
        double? from = null;
        var last = 0.0;
        var end = rig.Clock.Monotonic + TimeSpan.FromSeconds(seconds);
        while (rig.Clock.Monotonic < end)
        {
            rig.Run(frame, frame);
            var at = (rig.Clock.Monotonic - start).TotalMilliseconds;
            Assert.InRange(rig.Vm.ShakeX, -1.0, 1.0);
            if (Math.Abs(rig.Vm.ShakeX) > 0.0001)
            {
                from ??= at;
                last = at;
            }
            else if (from is not null && at - last > 200)
            {
                moves.Add((from.Value, last));
                from = null;
            }
        }
        if (from is not null) moves.Add((from.Value, last));
        return moves;
    }

    [Fact]
    public void The_shake_is_x_equals_A_sin_8_pi_t()
    {
        var motion = new BadgeMotion();
        motion.Start(TimeSpan.Zero);
        Assert.Equal(0, motion.Offset(TimeSpan.Zero), 6);
        Assert.Equal(1, motion.Offset(TimeSpan.FromMilliseconds(62.5)), 6);
        Assert.Equal(0, motion.Offset(TimeSpan.FromMilliseconds(125)), 6);
        Assert.Equal(-1, motion.Offset(TimeSpan.FromMilliseconds(187.5)), 6);
        Assert.Equal(0, motion.Offset(TimeSpan.FromMilliseconds(1000)), 6);
        Assert.Equal(0, motion.Offset(TimeSpan.FromMilliseconds(2500)), 6);
        Assert.Equal(1, motion.Offset(TimeSpan.FromMilliseconds(4062.5)), 6);
    }

    [Theory]
    [InlineData(16)]
    [InlineData(33)]
    public void One_second_on_three_still_within_50_ms_for_15_cycles_then_it_stops(int frameMs)
    {
        using var rig = new IconRig(new FakeAgent());
        var start = rig.Clock.Monotonic;
        rig.Alerts.Raise(Action());
        var moves = Moves(rig, start, 70, TimeSpan.FromMilliseconds(frameMs));

        Assert.Equal(15, moves.Count);
        for (var i = 0; i < moves.Count; i++)
        {
            Assert.InRange(moves[i].From - 4000 * i, -50, 50);
            Assert.InRange(moves[i].To - (4000 * i + 1000), -50, 50);
        }
        // Motion stops at 60 s; the last cycle is the one starting at 56 s.
        Assert.True(moves[^1].To <= 60_000);
        Assert.False(rig.Vm.IsFrameTimerRunning);
        Assert.Equal(0, rig.Vm.ShakeX);
    }

    /// <summary>A busy UI thread: what is posted runs when it gets round to it.</summary>
    private sealed class BusyUi : IUiDispatcher
    {
        private readonly Queue<Action> _queue = new();
        public void Post(Action action) => _queue.Enqueue(action);
        public void Drain()
        {
            while (_queue.TryDequeue(out var action)) action();
        }
    }

    [Fact]
    public void The_rhythm_comes_from_the_monotonic_clock_late_frames_and_a_wall_clock_jump_change_nothing()
    {
        var ui = new BusyUi();
        var agent = new FakeAgent();
        var alerts = new AlertCenter();
        using var vm = new BubbleViewModel(agent, new DayMeter(agent), alerts, ui);
        var clock = agent.ManualClock;
        var start = clock.Monotonic;
        alerts.Raise(Action());

        // When each frame off centre reached the screen.
        var drawn = new List<double>();
        vm.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName == nameof(BubbleViewModel.ShakeX) && Math.Abs(vm.ShakeX) > 0.0001) drawn.Add((clock.Monotonic - start).TotalMilliseconds);
        };
        var random = new Random(7);
        var jumped = false;
        while ((clock.Monotonic - start).TotalSeconds < 62)
        {
            // The UI thread gets to its work up to 30 ms late, unevenly.
            clock.Advance(TimeSpan.FromMilliseconds(random.Next(5, 31)));
            ui.Drain();
            if (jumped || (clock.Monotonic - start).TotalSeconds < 22) continue;
            jumped = true;
            clock.SetWallClock(clock.UtcNow.AddHours(3));
        }

        var moves = new List<(double From, double To)>();
        foreach (var at in drawn)
        {
            if (moves.Count == 0 || at - moves[^1].To > 200) moves.Add((at, at));
            else moves[^1] = (moves[^1].From, at);
        }
        Assert.Equal(15, moves.Count);
        for (var i = 0; i < moves.Count; i++)
        {
            Assert.InRange(moves[i].From - 4000 * i, -50, 50);
            Assert.InRange(moves[i].To - (4000 * i + 1000), -50, 50);
        }
    }

    [Fact]
    public void Frames_run_only_during_the_second_of_movement()
    {
        using var rig = new IconRig(new FakeAgent());
        rig.Alerts.Raise(Action());
        rig.Run(0.5);
        Assert.True(rig.Vm.IsFrameTimerRunning);
        rig.Run(1);
        Assert.False(rig.Vm.IsFrameTimerRunning);
        Assert.Equal(0, rig.Vm.ShakeX);
        rig.Run(1);
        Assert.False(rig.Vm.IsFrameTimerRunning);
        rig.Run(1.6);
        Assert.True(rig.Vm.IsFrameTimerRunning);
        // Past the 60 s: only the minute tick is waiting.
        rig.Run(60);
        Assert.False(rig.Vm.IsFrameTimerRunning);
        Assert.Equal(1, rig.Clock.Pending);
    }

    [Fact]
    public void The_badge_pops_0_to_1_15_to_1_over_240_ms()
    {
        using var rig = new IconRig(new FakeAgent());
        rig.Alerts.Raise(Action());
        Assert.Equal(0, rig.Vm.Frame.BadgeScale, 3);
        var peak = 0.0;
        for (var i = 0; i < 15; i++)
        {
            rig.Run(0.016);
            peak = Math.Max(peak, rig.Vm.Frame.BadgeScale);
        }
        Assert.InRange(peak, 1.12, 1.15);
        rig.Run(0.016);
        Assert.Equal(1, rig.Vm.Frame.BadgeScale, 3);
        Assert.Equal("!", rig.Vm.BadgeGlyph);
    }

    [Fact]
    public void The_badge_stays_after_the_motion_until_the_agent_is_opened()
    {
        using var rig = new IconRig(new FakeAgent());
        rig.Alerts.Raise(Action());
        rig.Run(600);
        Assert.Equal("!", rig.Vm.BadgeGlyph);
        Assert.Equal(1, rig.Vm.Frame.BadgeScale, 3);
        Assert.Equal(1, rig.Vm.Opacity, 3);

        rig.Vm.SetPanelOpen(true);
        Assert.False(rig.Vm.HasBadge);
        Assert.Null(rig.Vm.Frame.Glyph);
        Assert.Single(rig.Alerts.Cards); // The card stays until it is acted on.
    }

    [Fact]
    public void Opening_mid_shake_stops_it_at_once()
    {
        using var rig = new IconRig(new FakeAgent());
        rig.Alerts.Raise(Action());
        rig.Run(0.0625);
        Assert.NotEqual(0, rig.Vm.ShakeX);
        rig.Vm.SetPanelOpen(true);
        Assert.Equal(0, rig.Vm.ShakeX);
        rig.Run(5);
        Assert.Equal(0, rig.Vm.ShakeX);
    }

    [Fact]
    public void One_pattern_two_badges_i_moves_exactly_as_the_other_does()
    {
        using var action = new IconRig(new FakeAgent());
        using var info = new IconRig(new FakeAgent());
        action.Alerts.Raise(Action());
        info.Alerts.Raise(Info());
        for (var i = 0; i < 300; i++)
        {
            action.Run(0.016);
            info.Run(0.016);
            Assert.Equal(action.Vm.ShakeX, info.Vm.ShakeX);
        }
        Assert.Equal("i", info.Vm.BadgeGlyph);
    }

    [Fact]
    public void A_new_alert_during_motion_swaps_the_glyph_and_keeps_the_rhythm()
    {
        using var rig = new IconRig(new FakeAgent());
        var start = rig.Clock.Monotonic;
        rig.Alerts.Raise(Info());
        rig.Run(10);
        Assert.Equal("i", rig.Vm.BadgeGlyph);
        rig.Alerts.Raise(Action());
        Assert.Equal("!", rig.Vm.BadgeGlyph);
        // No second pop.
        Assert.Equal(1, rig.Vm.Frame.BadgeScale, 3);
        var moves = Moves(rig, start, 55, TimeSpan.FromMilliseconds(16));
        // Rhythm from the first alert: moves at 12 s, 16 s and on, and over by 60 s.
        Assert.InRange(moves[0].From, 12_000 - 50, 12_000 + 50);
        Assert.True(moves[^1].To <= 60_000);
    }

    [Fact]
    public void A_new_alert_after_the_motion_stopped_starts_a_new_60_s()
    {
        using var rig = new IconRig(new FakeAgent());
        rig.Alerts.Raise(Info());
        rig.Run(70);
        Assert.False(rig.Vm.IsFrameTimerRunning);
        var start = rig.Clock.Monotonic;
        rig.Alerts.Raise(Action());
        var moves = Moves(rig, start, 70, TimeSpan.FromMilliseconds(16));
        Assert.Equal(15, moves.Count);
        Assert.InRange(moves[0].From, -50, 50);
    }

    [Fact]
    public void One_badge_at_a_time_the_action_over_the_information_over_the_count()
    {
        using var rig = new IconRig(new FakeAgent());
        rig.Vm.MessageCount = 3;
        Assert.Equal("3", rig.Vm.BadgeGlyph);
        rig.Alerts.Raise(Info());
        Assert.Equal("i", rig.Vm.BadgeGlyph);
        rig.Alerts.Raise(Action());
        Assert.Equal("!", rig.Vm.BadgeGlyph);
        rig.Alerts.Clear("due");
        Assert.Equal("i", rig.Vm.BadgeGlyph);
        rig.Vm.SetPanelOpen(true);
        Assert.Equal("3", rig.Vm.BadgeGlyph);
    }

    [Fact]
    public void A_message_count_has_no_pop_and_no_motion()
    {
        using var rig = new IconRig(new FakeAgent());
        rig.Vm.MessageCount = 12;
        Assert.Equal("9+", rig.Vm.BadgeGlyph);
        Assert.Equal(1, rig.Vm.Frame.BadgeScale);
        for (var i = 0; i < 100; i++)
        {
            rig.Run(0.016);
            Assert.Equal(0, rig.Vm.ShakeX);
            Assert.Equal(1, rig.Vm.Frame.BadgeScale);
        }
        Assert.False(rig.Vm.IsFrameTimerRunning);
    }

    [Fact]
    public void The_count_is_0_until_messaging_drives_it_and_a_chat_message_does_not_touch_it()
    {
        var agent = new FakeAgent { ChatUnread = 5 };
        using var rig = new IconRig(agent);
        rig.Vm.Update();
        Assert.Equal(0, rig.Vm.MessageCount);
        Assert.False(rig.Vm.HasBadge);
    }

    [Fact]
    public void With_the_panel_open_a_new_card_goes_on_top_with_no_badge_and_no_motion()
    {
        using var rig = new IconRig(new FakeAgent());
        rig.Vm.SetPanelOpen(true);
        rig.Alerts.Raise(Action());
        Assert.False(rig.Vm.HasBadge);
        rig.Run(2);
        Assert.Equal(0, rig.Vm.ShakeX);
        Assert.False(rig.Vm.IsFrameTimerRunning);
        Assert.Single(rig.Alerts.Cards);
    }

    [Fact]
    public void While_hidden_by_a_full_screen_app_the_60_s_waits_and_starts_when_it_shows()
    {
        using var rig = new IconRig(new FakeAgent());
        rig.Vm.SetShown(false);
        rig.Alerts.Raise(Action());
        rig.Run(122);
        Assert.Equal(0, rig.Vm.ShakeX);
        Assert.False(rig.Vm.IsFrameTimerRunning);

        rig.Vm.SetShown(true);
        var start = rig.Clock.Monotonic;
        var moves = Moves(rig, start, 70, TimeSpan.FromMilliseconds(16));
        Assert.Equal(15, moves.Count);
        Assert.InRange(moves[0].From, -50, 50);
    }

    [Fact]
    public void Hidden_mid_motion_the_rest_of_the_60_s_waits()
    {
        using var rig = new IconRig(new FakeAgent());
        rig.Alerts.Raise(Action());
        rig.Run(20);
        rig.Vm.SetShown(false);
        rig.Run(120);
        rig.Vm.SetShown(true);
        var start = rig.Clock.Monotonic;
        var moves = Moves(rig, start, 50, TimeSpan.FromMilliseconds(16));
        Assert.Equal(10, moves.Count);
        Assert.True(moves[^1].To <= 40_000);
    }
}
