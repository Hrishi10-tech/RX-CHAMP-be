using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Icon;
using RXVision.Agent.ViewModels;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>Every state of the icon: its dot, its ring, its words, on the agent's own state.</summary>
public class IconStateTests
{
    private static DayProgress Progress(string status, int workedSec, int targetSec = 8 * 3600, string date = "2026-10-13") => new()
    {
        Status = status, Date = date, WorkedSec = workedSec, TargetSec = targetSec, OverSec = Math.Max(0, workedSec - targetSec),
    };

    private static IconRig Rig(string now = "10:20", Action<FakeAgent>? setup = null)
    {
        var agent = new FakeAgent(now);
        setup?.Invoke(agent);
        return new IconRig(agent);
    }

    private static void Sees(IconRig rig, IconStatus status, string label, double sweep, string dot, double fill, string ring, double opacity)
    {
        rig.Settle();
        Assert.Equal(status, rig.Vm.Status);
        Assert.Equal(label, rig.Vm.Label);
        Assert.Equal($"RX Vision · {label}", rig.Vm.AccessibleName);
        var frame = rig.Vm.Frame;
        Assert.Equal(sweep, frame.SweepDegrees, 1);
        Assert.Equal(Avalonia.Media.Color.Parse(dot), frame.Look.DotColor);
        Assert.Equal(fill, frame.Look.DotFill);
        Assert.Equal(Avalonia.Media.Color.Parse(ring), frame.Look.RingColor);
        Assert.Equal(opacity, frame.Look.RingOpacity, 3);
    }

    [Fact]
    public void Not_started_is_a_hollow_dot_and_an_empty_ring()
    {
        using var rig = Rig(setup: a =>
        {
            a.State = AgentState.NotStarted;
            a.DayProgress = Progress(DayProgressStatus.NotStarted, 0);
        });
        rig.Vm.Update();
        Sees(rig, IconStatus.NotStarted, "Not started · 0h 00m of 8h", 0, "#8A93A3", 0, "#6FC9B6", 0);
    }

    [Fact]
    public void Working_fills_from_the_servers_number()
    {
        using var rig = Rig(setup: a => a.DayProgress = Progress(DayProgressStatus.Working, 5 * 3600 + 12 * 60));
        rig.Vm.Update();
        Sees(rig, IconStatus.Working, "Working · 5h 12m of 8h", 234, "#34D27A", 1, "#6FC9B6", 0.90);
    }

    [Fact]
    public void In_a_meeting_is_purple_and_keeps_filling_then_back_to_teal()
    {
        using var rig = Rig(setup: a =>
        {
            a.Presence = new CurrentPresence { Status = PresenceStatus.Meeting };
            a.DayProgress = Progress(DayProgressStatus.Meeting, 2 * 3600);
        });
        rig.Vm.Update();
        Sees(rig, IconStatus.Meeting, "In a meeting · 2h 00m of 8h", 90, "#A78BFA", 1, "#A78BFA", 0.90);

        rig.Run(60);
        rig.Settle();
        Assert.Equal("In a meeting · 2h 01m of 8h", rig.Vm.Label);
        Assert.True(rig.Vm.Frame.SweepDegrees > 90);

        // 4.0: the local day leads, and a status meeting the server still reports holds; the meeting
        // ends when both say so (the host's presence follows the day progress).
        rig.Agent.Presence = new CurrentPresence { Status = PresenceStatus.Working };
        rig.Agent.DayProgress = Progress(DayProgressStatus.Working, 2 * 3600 + 60);
        rig.Vm.Update();
        rig.Settle();
        Assert.Equal(IconStatus.Working, rig.Vm.Status);
        Assert.Equal(Avalonia.Media.Color.Parse("#6FC9B6"), rig.Vm.Frame.Look.RingColor);
    }

    [Fact]
    public void On_break_pauses_and_dims()
    {
        using var rig = Rig("11:05", a =>
        {
            a.Day = Days.General().WithActive(Days.Running("MORNING", "11:00"));
            a.DayProgress = Progress(DayProgressStatus.Break, 3 * 3600 + 30 * 60);
        });
        rig.Vm.Update();
        Sees(rig, IconStatus.OnBreak, "On break · 3h 30m of 8h", 157.5, "#F2A93B", 1, "#6FC9B6", 0.36);
        rig.Run(120);
        rig.Settle();
        Assert.Equal("On break · 3h 30m of 8h", rig.Vm.Label);
        Assert.Equal(157.5, rig.Vm.Frame.SweepDegrees, 1);
    }

    [Fact]
    public void Break_extended_stays_amber_counts_up_from_zero_with_the_ring_dimmed()
    {
        using var rig = Rig("11:15", a =>
        {
            a.Day = Days.General().WithActive(Days.Running("MORNING", "11:00"));
            a.DayProgress = Progress(DayProgressStatus.Break, 3 * 3600 + 30 * 60);
        });
        rig.Run(1);
        Assert.Equal(IconStatus.BreakExtended, rig.Vm.Status);
        rig.Agent.SetNow("11:19:32");
        rig.Vm.Update();
        Sees(rig, IconStatus.BreakExtended, "Break extended · 04:33", 157.5, "#F2A93B", 1, "#6FC9B6", 0.36);
    }

    [Fact]
    public void A_break_with_no_length_never_extends()
    {
        using var rig = Rig("11:45", a =>
        {
            a.Day = Days.Free();
            a.Presence = new CurrentPresence { Status = PresenceStatus.Break, Since = Ist.At("10:00") };
            a.DayProgress = Progress(DayProgressStatus.Break, 3600);
        });
        rig.Vm.Update();
        Sees(rig, IconStatus.OnBreak, "On break · 1h 00m of 8h", 45, "#F2A93B", 1, "#6FC9B6", 0.36);
    }

    [Theory]
    [InlineData(IconStatus.Working, "#34D27A", 0.95, "#34D27A", "Working · +15 min over target")]
    [InlineData(IconStatus.Meeting, "#A78BFA", 0.90, "#A78BFA", "In a meeting · +15 min over target")]
    [InlineData(IconStatus.OnBreak, "#34D27A", 0.36, "#F2A93B", "On break · +15 min over target")]
    public void Past_the_target_the_circle_stays_full_and_the_status_goes_first(IconStatus status, string ring, double opacity, string dot, string label)
    {
        using var rig = Rig("10:20", a =>
        {
            a.DayProgress = Progress(DayProgressStatus.Working, 8 * 3600 + 15 * 60);
            if (status == IconStatus.Meeting) a.Presence = new CurrentPresence { Status = PresenceStatus.Meeting };
            if (status == IconStatus.OnBreak)
            {
                a.Day = Days.General().WithActive(Days.Running("MORNING", "10:15"));
            }
        });
        rig.Vm.Update();
        Sees(rig, status, label, 360, dot, 1, ring, opacity);
    }

    [Fact]
    public void Exactly_at_the_target_says_the_time_and_is_full()
    {
        using var rig = Rig(setup: a => a.DayProgress = Progress(DayProgressStatus.Working, 8 * 3600));
        rig.Vm.Update();
        Sees(rig, IconStatus.Working, "Working · 8h 00m of 8h", 360, "#34D27A", 1, "#34D27A", 0.95);
    }

    [Fact]
    public void Day_ended_keeps_the_total_at_30_percent_past_the_target_too()
    {
        using var rig = Rig("18:40", a =>
        {
            a.State = AgentState.DayEnded;
            a.DayProgress = Progress(DayProgressStatus.Ended, 8 * 3600 + 15 * 60);
        });
        rig.Vm.Update();
        Sees(rig, IconStatus.DayEnded, "Day ended · 8h 15m today", 360, "#8A93A3", 0, "#6FC9B6", 0.30);
    }

    [Fact]
    public void After_the_date_changes_the_ended_day_stays_with_no_today_until_the_next_Start_day()
    {
        using var rig = Rig("08:55", a =>
        {
            a.State = AgentState.NotStarted;
            a.Workday = Days.NotStarted();
            a.DayProgress = Progress(DayProgressStatus.Ended, 6 * 3600, date: "2026-10-12");
        });
        rig.Vm.Update();
        Sees(rig, IconStatus.DayEnded, "Day ended · 6h 00m", 270, "#8A93A3", 0, "#6FC9B6", 0.30);

        // The next Start day: today's date, from zero, at once.
        rig.Agent.State = AgentState.Running;
        rig.Agent.Workday = Days.Open();
        rig.Agent.DayProgress = Progress(DayProgressStatus.Working, 0);
        rig.Agent.RaiseDayProgress();
        Assert.Equal(0, rig.Vm.Frame.SweepDegrees);
        Sees(rig, IconStatus.Working, "Working · 0h 00m of 8h", 0, "#34D27A", 1, "#6FC9B6", 0.90);
    }

    [Fact]
    public void A_shifts_target_and_part_day_leave_set_the_full_circle()
    {
        using var rig = Rig(setup: a => a.DayProgress = Progress(DayProgressStatus.Working, 2 * 3600, targetSec: 4 * 3600));
        rig.Vm.Update();
        Sees(rig, IconStatus.Working, "Working · 2h 00m of 4h", 180, "#34D27A", 1, "#6FC9B6", 0.90);

        using var part = Rig(setup: a => a.DayProgress = Progress(DayProgressStatus.Working, 3600, targetSec: 7 * 3600 + 30 * 60));
        part.Vm.Update();
        part.Settle();
        Assert.Equal("Working · 1h 00m of 7h 30m", part.Vm.Label);
    }

    [Fact]
    public void Before_any_answer_the_day_view_stands_in_and_a_shift_with_no_target_reads_8_h()
    {
        using var rig = Rig();
        rig.Settle();
        Assert.Equal("Working · 1h 00m of 8h", rig.Vm.Label);

        using var noShift = Rig(setup: a => a.Workday!.ExpectedSec = 0);
        noShift.Settle();
        Assert.Equal("Working · 1h 00m of 8h", noShift.Vm.Label);

        using var nothing = Rig(setup: a => a.Workday = null);
        nothing.Settle();
        Assert.Equal("Working · 0h 00m of 8h", nothing.Vm.Label);
    }

    [Fact]
    public void A_status_change_never_moves_the_sweep()
    {
        using var rig = Rig(setup: a => a.DayProgress = Progress(DayProgressStatus.Working, 3600));
        rig.Vm.Update();
        rig.Settle();
        var sweep = rig.Vm.Frame.SweepDegrees;
        rig.Agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting };
        rig.Vm.Update();
        rig.Run(0.5);
        Assert.Equal(sweep, rig.Vm.Frame.SweepDegrees);
    }

    [Fact]
    public void Colour_changes_crossfade_over_300_ms_and_never_flash()
    {
        using var rig = Rig(setup: a => a.DayProgress = Progress(DayProgressStatus.Working, 3600));
        rig.Vm.Update();
        rig.Settle();
        rig.Agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting };
        rig.Vm.Update();
        var teal = Avalonia.Media.Color.Parse("#6FC9B6");
        var purple = Avalonia.Media.Color.Parse("#A78BFA");
        Assert.Equal(teal, rig.Vm.Frame.Look.RingColor);
        rig.Run(0.15);
        var middle = rig.Vm.Frame.Look.RingColor;
        Assert.InRange(middle.R, teal.R, purple.R);
        Assert.NotEqual(teal, middle);
        Assert.NotEqual(purple, middle);
        rig.Run(0.17);
        Assert.Equal(purple, rig.Vm.Frame.Look.RingColor);
    }

    [Fact]
    public void The_panels_lines_read_the_same_value()
    {
        var reading = new DayReading(IconStatus.Working, 3 * 3600 + 30 * 60, 8 * 3600);
        Assert.Equal("3h 30m of 8h", reading.PanelLine);
        Assert.Equal("4h 30m to go", reading.PanelNote);
        var past = reading with { WorkedSec = 8 * 3600 + 15 * 60 };
        Assert.Equal("Target reached · 8h 15m today", past.PanelLine);
        Assert.Equal("+15 min over target", past.PanelNote);
        var exact = reading with { WorkedSec = 8 * 3600 };
        Assert.Equal("Target reached · 8h 00m today", exact.PanelLine);
        Assert.Equal("", exact.PanelNote);
        Assert.Equal("Target reached · 8h 15m", (past with { Status = IconStatus.DayEnded, OnEarlierDate = true }).PanelLine);
    }

    [Fact]
    public void The_last_ended_day_draws_offline_from_its_copy_and_the_next_answer_replaces_it()
    {
        var dir = Path.Combine(Path.GetTempPath(), "rxv-ui-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var store = new Services.UiSettingsStore(dir, Core.Util.NullLog.Instance);
        {
            var agent = new FakeAgent("18:40") { State = AgentState.DayEnded, DayProgress = Progress(DayProgressStatus.Ended, 8 * 3600 + 15 * 60) };
            using var online = new IconRig(agent, store);
            online.Vm.Update();
        }
        Assert.Equal(8 * 3600 + 15 * 60, new Services.UiSettingsStore(dir, Core.Util.NullLog.Instance).Current.LastDay!.WorkedSec);

        // Next morning, no answer from the server yet.
        var offline = new FakeAgent("08:55") { State = AgentState.NotStarted, Workday = null };
        using var rig = new IconRig(offline, new Services.UiSettingsStore(dir, Core.Util.NullLog.Instance));
        rig.Vm.Update();
        rig.Settle();
        Assert.Equal(360, rig.Vm.Frame.SweepDegrees, 1);
        Assert.Equal(8 * 3600 + 15 * 60, rig.Meter.Reading.WorkedSec);

        // Someone else on this computer does not see it.
        var other = new FakeAgent("08:55") { State = AgentState.NotStarted, Workday = null };
        other.User = new PublicUser { Id = "u-2", Email = "b@x.test", Role = "USER" };
        using var theirs = new IconRig(other, new Services.UiSettingsStore(dir, Core.Util.NullLog.Instance));
        theirs.Vm.Update();
        Assert.Equal(0, theirs.Meter.Reading.WorkedSec);
    }

    [Fact]
    public void Signing_out_forgets_the_day()
    {
        using var rig = Rig(setup: a => a.DayProgress = Progress(DayProgressStatus.Working, 3600));
        rig.Vm.Update();
        rig.Settle();
        rig.Agent.DayProgress = null;
        rig.Agent.Workday = null;
        rig.Agent.State = AgentState.SignIn;
        rig.Vm.Reset();
        rig.Settle();
        Assert.Equal(0, rig.Vm.Frame.SweepDegrees);
        Assert.Equal(0, rig.Meter.Reading.WorkedSec);
    }
}
