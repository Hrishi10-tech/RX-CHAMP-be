using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Icon;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// A full day on the moved clock (brief, Testing): start, work, meeting, break, overrun, resume,
/// target reached, end day, the next morning, the next Start day. A stand-in server keeps the time
/// as the real one does; the ring and the panel are compared with it and with each other at every
/// minute of the day.
/// </summary>
public class MovedClockDayTests
{
    /// <summary>The server's clock on focus time: running while Working or In a meeting.</summary>
    private sealed class StandInServer
    {
        private readonly FakeAgent _agent;
        private TimeSpan _worked;
        private DateTimeOffset _markedAt;
        public string Date { get; set; } = "2026-10-13";

        public StandInServer(FakeAgent agent)
        {
            _agent = agent;
            _markedAt = agent.Now;
        }

        public int WorkedSec => (int)_worked.TotalSeconds;

        public void Accrue()
        {
            var running = _agent.State == AgentState.Running && _agent.BreakPanel.Active is null
                && _agent.Presence.Status is not (PresenceStatus.Break or PresenceStatus.Lunch);
            if (running) _worked += _agent.Now - _markedAt;
            _markedAt = _agent.Now;
        }

        public void Reset() => _worked = TimeSpan.Zero;

        public DayProgress Read()
        {
            Accrue();
            return new DayProgress
            {
                Status = _agent.State switch
                {
                    AgentState.Running when _agent.BreakPanel.Active is not null => DayProgressStatus.Break,
                    AgentState.Running when _agent.Presence.Status == PresenceStatus.Meeting => DayProgressStatus.Meeting,
                    AgentState.Running => DayProgressStatus.Working,
                    AgentState.DayEnded => DayProgressStatus.Ended,
                    _ => WorkedSec > 0 ? DayProgressStatus.Ended : DayProgressStatus.NotStarted,
                },
                Date = Date,
                WorkedSec = WorkedSec,
                TargetSec = 8 * 3600,
                OverSec = Math.Max(0, WorkedSec - 8 * 3600),
            };
        }
    }

    /// <summary>
    /// The icon has been up a little before the day starts, so that the minute ticks fall 1.5 s
    /// after each whole minute of work: the words read whole minutes, and each check, 1.5 s after a
    /// tick, finds the sweep's ease finished.
    /// </summary>
    private sealed class Day : IDisposable
    {
        public Day()
        {
            Agent = new FakeAgent("09:29") { State = AgentState.NotStarted, Workday = Days.NotStarted("09:29") };
            Server = new StandInServer(Agent);
            Agent.DayProgress = Server.Read();
            Agent.DayProgressSource = Server.Read;
            Rig = new IconRig(Agent);
            Panel = new DashboardViewModel(Agent, Rig.Actions, NullLog.Instance, Rig.Alerts, Rig.Meter);
            Rig.Vm.Update();
            Rig.Run(58.5);
        }

        public FakeAgent Agent { get; }
        public StandInServer Server { get; }
        public IconRig Rig { get; }
        public DashboardViewModel Panel { get; }

        /// <summary>Press Start day, and stand 1.5 s past the next minute tick.</summary>
        public void StartDay()
        {
            Change(() =>
            {
                Agent.State = AgentState.Running;
                Agent.Presence = new CurrentPresence { Status = PresenceStatus.Working };
                Agent.Workday = Days.Open(startedAt: "09:30", serverNow: "09:30", focusSec: 0);
            });
            Rig.Run(3);
        }

        /// <summary>What the server's workday:changed brings: the status changes, and the numbers are read again.</summary>
        public void Change(Action change)
        {
            Server.Accrue();
            change();
            Agent.DayProgress = Server.Read();
            Agent.RaiseDayProgress();
            Rig.DayAlerts.Sync();
            Rig.Vm.Update();
            Panel.Refresh();
        }

        /// <summary>Moves on minute by minute, checking the ring against the panel and the server at each one.</summary>
        public void Minutes(int minutes)
        {
            for (var i = 0; i < minutes; i++)
            {
                Rig.Run(TimeSpan.FromSeconds(60), TimeSpan.FromMilliseconds(250));
                Check();
            }
        }

        /// <summary>The ring, the hover label and the panel read one value, within a minute of the server's.</summary>
        public void Check()
        {
            Server.Accrue();
            Panel.Refresh();
            var reading = Rig.Meter.Reading;
            Assert.Equal(reading.SweepDegrees, Rig.Vm.Frame.SweepDegrees, 3);
            Assert.Equal(reading.Label, Rig.Vm.Label);
            Assert.Equal(reading.PanelLine, Panel.ProgressLine);
            Assert.Equal(reading.PanelNote, Panel.ProgressNote);
            // The same words on both: "Working · 5h 12m of 8h" and "5h 12m of 8h".
            if (!reading.Reached && reading.Status is not (IconStatus.BreakExtended or IconStatus.DayEnded))
            {
                Assert.EndsWith(Panel.ProgressLine, Rig.Vm.Label);
            }
            Assert.InRange(Server.WorkedSec - reading.WorkedSec, 0, 60);
        }

        public void Dispose() => Rig.Dispose();
    }

    private static void Is(Day day, IconStatus status, string label, string line, string note)
    {
        day.Check();
        Assert.Equal(status, day.Rig.Vm.Status);
        Assert.Equal(label, day.Rig.Vm.Label);
        Assert.Equal(line, day.Panel.ProgressLine);
        Assert.Equal(note, day.Panel.ProgressNote);
    }

    [Fact]
    public void The_ring_matches_the_panel_at_every_step_of_the_day()
    {
        using var day = new Day();
        var agent = day.Agent;
        Assert.Equal(IconStatus.NotStarted, day.Rig.Vm.Status);
        Assert.Equal(0, day.Rig.Vm.Frame.SweepDegrees);

        // 09:30 Start day. No breaks on this shift until the one the story takes.
        agent.Day = Days.Free();
        day.StartDay();
        Is(day, IconStatus.Working, "Working · 0h 00m of 8h", "0h 00m of 8h", "8h 00m to go");

        // Working to 11:00.
        day.Minutes(90);
        Is(day, IconStatus.Working, "Working · 1h 30m of 8h", "1h 30m of 8h", "6h 30m to go");

        // 11:00 In a meeting: purple, and it keeps filling.
        day.Change(() => agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = agent.Now });
        day.Minutes(30);
        Is(day, IconStatus.Meeting, "In a meeting · 2h 00m of 8h", "2h 00m of 8h", "6h 00m to go");
        Assert.Equal(90, day.Rig.Vm.Frame.SweepDegrees, 0);
        Assert.Equal(Avalonia.Media.Color.Parse("#A78BFA"), day.Rig.Vm.Frame.Look.RingColor);

        // Back to teal when the meeting ends; working on to 13:00, 3h 30m.
        day.Change(() => agent.Presence = new CurrentPresence { Status = PresenceStatus.Working });
        day.Minutes(90);
        Is(day, IconStatus.Working, "Working · 3h 30m of 8h", "3h 30m of 8h", "4h 30m to go");
        Assert.Equal(Avalonia.Media.Color.Parse("#6FC9B6"), day.Rig.Vm.Frame.Look.RingColor);

        // 13:00 a 40 minute break: paused and dimmed.
        var lunch = Days.Running("LUNCH", "13:00", duration: 40);
        lunch.StartedAt = agent.Now.ToUniversalTime();
        day.Change(() => agent.Day = Days.General().WithActive(lunch));
        day.Minutes(30);
        Is(day, IconStatus.OnBreak, "On break · 3h 30m of 8h", "3h 30m of 8h", "4h 30m to go");
        Assert.Equal(157.5, day.Rig.Vm.Frame.SweepDegrees, 1);
        Assert.Equal(0.36, day.Rig.Vm.Frame.Look.RingOpacity, 3);

        // It runs over: amber, and the ring stays where it paused.
        day.Minutes(15);
        day.Check();
        Assert.Equal(IconStatus.BreakExtended, day.Rig.Vm.Status);
        Assert.Equal("Break extended · 05:00", day.Rig.Vm.Label);
        Assert.Equal(157.5, day.Rig.Vm.Frame.SweepDegrees, 1);
        Assert.Equal("!", day.Rig.Vm.BadgeGlyph);
        Assert.Equal(1, day.Rig.Vm.Opacity, 3);

        // 13:45 resume.
        day.Change(() => agent.Day = Days.Free());
        Is(day, IconStatus.Working, "Working · 3h 30m of 8h", "3h 30m of 8h", "4h 30m to go");
        Assert.False(day.Rig.Vm.HasBadge);

        // 16:00, 5h 45m.
        day.Minutes(135);
        Is(day, IconStatus.Working, "Working · 5h 45m of 8h", "5h 45m of 8h", "2h 15m to go");

        // 18:15 target reached: full, green, and the panel says so.
        day.Minutes(134);
        Assert.Equal("Working · 7h 59m of 8h", day.Rig.Vm.Label);
        Assert.True(day.Rig.Vm.Frame.SweepDegrees < 360);
        day.Minutes(1);
        Is(day, IconStatus.Working, "Working · 8h 00m of 8h", "Target reached · 8h 00m today", "");
        Assert.Equal(360, day.Rig.Vm.Frame.SweepDegrees, 3);
        Assert.Equal(0.95, day.Rig.Vm.Frame.Look.RingOpacity, 3);
        day.Rig.Run(0.4);
        Assert.Equal(Avalonia.Media.Color.Parse("#34D27A"), day.Rig.Vm.Frame.Look.RingColor);

        // 18:30, past the target, the extra time on the panel.
        day.Minutes(15);
        Is(day, IconStatus.Working, "Working · +15 min over target", "Target reached · 8h 15m today", "+15 min over target");
        Assert.Equal(360, day.Rig.Vm.Frame.SweepDegrees, 3);

        // End day: the total stays, dimmed to 30%, teal, hollow dot.
        day.Change(() =>
        {
            agent.State = AgentState.DayEnded;
            agent.Presence = new CurrentPresence { Status = PresenceStatus.DayEnded };
        });
        day.Minutes(1);
        Is(day, IconStatus.DayEnded, "Day ended · 8h 15m today", "Target reached · 8h 15m today", "+15 min over target");
        Assert.Equal(0.30, day.Rig.Vm.Frame.Look.RingOpacity, 3);
        Assert.Equal(0, day.Rig.Vm.Frame.Look.DotFill);
        Assert.Equal(Avalonia.Media.Color.Parse("#6FC9B6"), day.Rig.Vm.Frame.Look.RingColor);

        // The next morning: the server answers ENDED with yesterday's date until the next Start day.
        day.Change(() =>
        {
            agent.Now = agent.Now.AddHours(14);
            agent.State = AgentState.NotStarted;
            agent.Presence = new CurrentPresence { Status = PresenceStatus.NotStarted };
            agent.Workday = new WorkdayToday { Date = "2026-10-14", State = WorkdayStates.NotStarted };
        });
        Is(day, IconStatus.DayEnded, "Day ended · 8h 15m", "Target reached · 8h 15m", "+15 min over target");
        Assert.Equal(360, day.Rig.Vm.Frame.SweepDegrees, 3);

        // The next Start day: the ring clears at once and fills from zero.
        day.Change(() =>
        {
            day.Server.Reset();
            day.Server.Date = "2026-10-14";
            agent.State = AgentState.Running;
            agent.Presence = new CurrentPresence { Status = PresenceStatus.Working };
            agent.Workday = new WorkdayToday { Date = "2026-10-14", State = WorkdayStates.Open };
        });
        Assert.Equal(0, day.Rig.Vm.Frame.SweepDegrees);
        Is(day, IconStatus.Working, "Working · 0h 00m of 8h", "0h 00m of 8h", "8h 00m to go");
    }

    [Fact]
    public void The_ring_moves_at_most_once_a_minute_with_a_slow_ease()
    {
        using var day = new Day();
        day.Agent.Day = Days.Free();
        day.StartDay();
        var changes = new List<(TimeSpan At, double Sweep)>();
        day.Rig.Vm.PropertyChanged += (_, e) =>
        {
            if (e.PropertyName != nameof(BubbleViewModel.Frame)) return;
            var sweep = day.Rig.Vm.Frame.SweepDegrees;
            if (changes.Count == 0 || changes[^1].Sweep != sweep) changes.Add((day.Rig.Clock.Monotonic, sweep));
        };
        // Reads and refreshes come as often as they like: workday:changed at any moment.
        for (var i = 0; i < 300; i++)
        {
            day.Rig.Run(TimeSpan.FromSeconds(1), FramePump.Interval);
            if (i % 7 == 0) day.Agent.RaiseDayProgress();
        }
        Assert.NotEmpty(changes);
        // Each step of the sweep lasts about 1 s, and steps start at least 58 s apart.
        var starts = new List<TimeSpan> { changes[0].At };
        for (var i = 1; i < changes.Count; i++)
        {
            if (changes[i].At - changes[i - 1].At > TimeSpan.FromSeconds(5)) starts.Add(changes[i].At);
            Assert.True(changes[i].Sweep >= changes[i - 1].Sweep);
        }
        Assert.InRange(starts.Count, 4, 5);
        for (var i = 1; i < starts.Count; i++)
        {
            Assert.InRange((starts[i] - starts[i - 1]).TotalSeconds, 58, 62);
        }
    }

    [Fact]
    public void The_server_correcting_the_time_shows_on_the_next_minute_not_before()
    {
        using var day = new Day();
        day.Agent.Day = Days.Free();
        day.StartDay();
        day.Agent.DayProgressSource = () => new DayProgress
        {
            Status = DayProgressStatus.Working, Date = "2026-10-13", WorkedSec = 3 * 3600, TargetSec = 8 * 3600,
        };
        day.Agent.DayProgress = day.Agent.DayProgressSource();
        day.Agent.RaiseDayProgress();
        Assert.Equal("Working · 0h 00m of 8h", day.Rig.Vm.Label);
        day.Rig.Run(60);
        Assert.Equal("Working · 3h 00m of 8h", day.Rig.Vm.Label);
    }
}
