using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Offline;
using Xunit;

namespace RXVision.Agent.Core.Tests;

public class BreakScheduleTests
{
    // 13 Oct 2026, IST = UTC+05:30. 11:00 IST = 05:30Z.
    private static DateTimeOffset Ist(string hm)
    {
        var parts = hm.Split(':').Select(int.Parse).ToArray();
        return new DateTimeOffset(2026, 10, 13, parts[0], parts[1], parts.Length > 2 ? parts[2] : 0, TimeSpan.FromHours(5.5));
    }

    private static BreakSlot Slot(string kind, string start, int duration, int before = 30, int after = 60, int lead = 1, int ring = 5)
    {
        var s = Ist(start);
        return new BreakSlot
        {
            Kind = kind,
            Label = kind switch { "MORNING" => "Morning break", "LUNCH" => "Lunch break", _ => "Evening break" },
            PresenceType = kind == "LUNCH" ? "LUNCH" : "BREAK",
            DurationMin = duration,
            ScheduledStart = s,
            ScheduledEnd = s.AddMinutes(duration),
            WindowOpen = s.AddMinutes(-before),
            WindowClose = s.AddMinutes(after),
            RingStart = s.AddMinutes(-lead),
            RingEnd = s.AddMinutes(-lead + ring),
            Local = new BreakLocalTimes { Start = start, End = s.AddMinutes(duration).ToString("HH:mm") },
        };
    }

    private static BreakDay Day(params BreakSlot[] slots) => new()
    {
        Date = "2026-10-13",
        Mode = "SCHEDULED",
        Workday = true,
        Shift = new ShiftInfo { Name = "General", Start = "09:30", End = "18:30", Rules = new ShiftRules() },
        Breaks = slots.ToList(),
    };

    private static BreakDay General() => Day(Slot("MORNING", "11:00", 15), Slot("LUNCH", "13:00", 30), Slot("EVENING", "16:00", 15));

    [Theory]
    [InlineData("10:29:59", SlotPhase.Upcoming)]
    [InlineData("10:30", SlotPhase.Early)]
    [InlineData("10:59", SlotPhase.Due)]
    [InlineData("11:03:59", SlotPhase.Due)]
    [InlineData("11:04", SlotPhase.Late)]
    [InlineData("11:59:59", SlotPhase.Late)]
    [InlineData("12:00", SlotPhase.Closed)]
    public void Phases_follow_the_window_and_the_ring(string at, SlotPhase expected)
    {
        Assert.Equal(expected, BreakSchedule.PhaseAt(Slot("MORNING", "11:00", 15), Ist(at)));
    }

    [Fact]
    public void Judges_minutes_like_the_server()
    {
        var s = Slot("MORNING", "11:00", 15);
        Assert.Equal(("ON_TIME", 0), BreakSchedule.Judge(s, Ist("11:02")));
        Assert.Equal(("EARLY", 20), BreakSchedule.Judge(s, Ist("10:40")));
        Assert.Equal(("EARLY", 21), BreakSchedule.Judge(s, Ist("10:39:30")));
        Assert.Equal(("LATE", 12), BreakSchedule.Judge(s, Ist("11:12:59")));
    }

    [Fact]
    public void Rings_while_due_and_needs_no_reason()
    {
        var panel = BreakSchedule.Compute(General(), Ist("10:59:30"));
        Assert.NotNull(panel.Ring);
        Assert.Equal("MORNING", panel.Ring!.Kind);
        var morning = panel.Slots[0];
        Assert.Equal(SlotState.Due, morning.State);
        Assert.True(morning.CanStart);
        Assert.False(morning.ReasonRequired);
        Assert.Equal("ON_TIME", morning.TimingIfStartedNow);
        Assert.Same(morning, panel.BreakTile);
    }

    [Fact]
    public void Early_and_late_starts_need_a_reason()
    {
        var early = BreakSchedule.Compute(General(), Ist("10:45")).Slots[0];
        Assert.Equal(SlotState.OpenEarly, early.State);
        Assert.True(early.ReasonRequired);
        Assert.Equal(15, early.MinutesOffIfStartedNow);

        var late = BreakSchedule.Compute(General(), Ist("11:30")).Slots[0];
        Assert.Equal(SlotState.OpenLate, late.State);
        Assert.True(late.ReasonRequired);
        Assert.Equal("LATE", late.TimingIfStartedNow);
    }

    [Fact]
    public void No_reason_when_the_shift_does_not_ask()
    {
        var day = General();
        day.Shift!.Rules.ReasonOnLate = false;
        Assert.False(BreakSchedule.Compute(day, Ist("11:30")).Slots[0].ReasonRequired);
    }

    [Fact]
    public void A_closed_window_with_no_record_is_closed_and_the_tile_moves_on()
    {
        // 3.1: "Skipped" is a record now (the person's skip or the server's auto-skip);
        // a window that closed with no record is just closed.
        var panel = BreakSchedule.Compute(General(), Ist("12:10"));
        Assert.Equal(SlotState.Closed, panel.Slots[0].State);
        Assert.False(panel.Slots[0].CanStart);
        Assert.Equal("EVENING", panel.BreakTile!.Kind);
        Assert.Equal(SlotState.Upcoming, panel.BreakTile.State);
        Assert.Null(panel.Ring);
    }

    [Fact]
    public void A_break_taken_after_lunch_makes_the_earlier_one_unavailable()
    {
        var day = General();
        day.Breaks[1].Record = new BreakRecord { Id = "l", Kind = "LUNCH", EndedAt = Ist("13:30") };
        // Even if (by a bad schedule) the morning window were still open:
        day.Breaks[0].WindowClose = Ist("15:00");
        var panel = BreakSchedule.Compute(day, Ist("13:40"));
        Assert.Equal(SlotState.Unavailable, panel.Slots[0].State);
        Assert.False(panel.Slots[0].CanStart);
    }

    [Fact]
    public void A_window_that_closed_untaken_stays_closed_after_a_later_break()
    {
        // Lunch passed untaken, then the evening break was taken: lunch closed
        // (as the portal says), not "unavailable".
        var day = General();
        day.Breaks[2].Record = new BreakRecord { Id = "e", Kind = "EVENING", StartedAt = Ist("16:01"), EndedAt = Ist("16:14") };
        var panel = BreakSchedule.Compute(day, Ist("16:20"));
        Assert.Equal(SlotState.Closed, panel.Slots[0].State);
        Assert.Equal(SlotState.Closed, panel.Slots[1].State);
        Assert.Equal(SlotState.Taken, panel.Slots[2].State);
    }

    [Fact]
    public void Nothing_can_start_while_a_break_runs_and_the_countdown_goes_negative()
    {
        var day = General();
        var record = new BreakRecord { Id = "m", Kind = "MORNING", Label = "Morning break", PresenceType = "BREAK", DurationMin = 15, StartedAt = Ist("11:00"), InProgress = true };
        day.Breaks[0].Record = record;
        day.ActiveBreak = record;

        var running = BreakSchedule.Compute(day, Ist("11:05"));
        Assert.Equal(SlotState.InProgress, running.Slots[0].State);
        Assert.Equal("10:00", running.Active!.Countdown);
        Assert.False(running.Active.Overrun);
        Assert.Null(running.Ring);

        var over = BreakSchedule.Compute(day, Ist("11:17:30"));
        Assert.True(over.Active!.Overrun);
        Assert.Equal("\u221202:30", over.Active.Countdown);
    }

    [Fact]
    public void Countdown_reads_full_length_at_the_start()
    {
        Assert.Equal("15:00", BreakSchedule.FormatSigned(TimeSpan.FromMinutes(15)));
        Assert.Equal("14:59", BreakSchedule.FormatSigned(TimeSpan.FromSeconds(899)));
        Assert.Equal("00:01", BreakSchedule.FormatSigned(TimeSpan.FromMilliseconds(400)));
        Assert.Equal("\u22121:00:05", BreakSchedule.FormatSigned(TimeSpan.FromSeconds(-3605)));
    }

    [Fact]
    public void Past_the_grace_only_after_the_grace()
    {
        // 3.1: past the shift's grace, Back to work asks whether to count the minutes
        // over, whatever the shift's old overrun-reason switch says.
        var day = General();
        day.Shift!.Rules.OverrunReason = false;
        day.Shift.Rules.OverrunGraceMin = 2;
        var record = new BreakRecord { Id = "m", Kind = "MORNING", DurationMin = 15, StartedAt = Ist("11:00"), InProgress = true };
        day.Breaks[0].Record = record;
        day.ActiveBreak = record;
        Assert.False(BreakSchedule.Compute(day, Ist("11:16")).Active!.PastGrace);
        Assert.True(BreakSchedule.Compute(day, Ist("11:17:30")).Active!.PastGrace);
    }

    [Fact]
    public void Day_ended_stops_everything()
    {
        var day = General();
        day.DayEnded = true;
        var panel = BreakSchedule.Compute(day, Ist("10:59:30"));
        Assert.Null(panel.Ring);
        Assert.All(panel.Slots, s => Assert.False(s.CanStart));
    }

    [Fact]
    public void Free_mode_has_no_slots()
    {
        var panel = BreakSchedule.Compute(new BreakDay { Mode = "FREE", Workday = false }, Ist("11:00"));
        Assert.False(panel.Scheduled);
        Assert.Empty(panel.Slots);
        Assert.Same(BreakPanel.Free.Slots, BreakSchedule.Compute(null, Ist("11:00")).Slots);
    }
    [Fact]
    public void An_auto_skip_End_Day_made_in_an_open_window_leaves_the_break_startable_until_it_closes()
    {
        // End Day (stopped by a gate) auto-skipped the morning break at 11:02, inside its
        // window (10:30 to 12:00), with no comment yet: the server replaces it on Start.
        var day = General();
        day.Breaks[0].AllowSkip = true;
        var made = new BreakRecord { Id = "auto-m", Kind = "MORNING", Outcome = BreakOutcomes.AutoSkipped, StartedAt = Ist("11:02"), ApprovalStatus = "PENDING" };
        day.Breaks[0].Record = made;

        var open = BreakSchedule.Compute(day, Ist("11:03")).Slots[0];
        Assert.Equal(SlotState.Due, open.State);
        Assert.True(open.CanStart);
        Assert.False(open.CanSkip);          // already skipped: taken or commented, not skipped again
        Assert.Same(made, open.PendingAutoSkip);
        Assert.Null(open.Record);
        Assert.Null(BreakSchedule.Compute(day, Ist("11:03")).Ring);   // asked about at End Day: no ring

        var late = BreakSchedule.Compute(day, Ist("11:30")).Slots[0];
        Assert.Equal(SlotState.OpenLate, late.State);
        Assert.True(late.CanStart);

        // The window closed: a real auto-skip.
        var closed = BreakSchedule.Compute(day, Ist("12:00")).Slots[0];
        Assert.Equal(SlotState.AutoSkipped, closed.State);
        Assert.False(closed.CanStart);
        Assert.Null(closed.PendingAutoSkip);
    }

    [Theory]
    [InlineData("12:00", "11:02", null, false)]            // made when the window closed
    [InlineData("11:05", "11:02", "Client call", false)]   // commented: it stays
    [InlineData("11:05", "11:02", null, true)]
    [InlineData("11:59:59", "11:02", null, true)]
    public void Replaceable_auto_skips_match_the_servers_rule(string now, string made, string? reason, bool replaceable)
    {
        var record = new BreakRecord { Outcome = BreakOutcomes.AutoSkipped, StartedAt = Ist(made), Reason = reason };
        Assert.Equal(replaceable, BreakSchedule.IsReplaceableAutoSkip(record, Ist("12:00"), Ist(now)));
        Assert.False(BreakSchedule.IsReplaceableAutoSkip(new BreakRecord { Outcome = BreakOutcomes.Skipped, StartedAt = Ist(made) }, Ist("12:00"), Ist(now)));
    }

    /// <summary>
    /// Seen end to end: the server sends the running break twice (activeBreak and its slot's
    /// record, two copies once read). Ended here before the day is read again, the slot shows
    /// it taken, not still in progress.
    /// </summary>
    [Fact]
    public void A_break_ended_on_top_of_the_servers_day_shows_taken_on_its_slot()
    {
        BreakRecord Running() => new()
        {
            Id = "b-1", Kind = "MORNING", Label = "Morning break", DurationMin = 15, StartedAt = Ist("11:02"),
            InProgress = true, State = BreakStates.Active, Outcome = BreakOutcomes.Taken, ApprovalStatus = "NOT_REQUIRED",
            Segments = { new BreakSegment { StartedAt = Ist("11:02") } },
        };
        var day = General();
        day.Breaks[0].Record = Running();
        day.Breaks[0].State = BreakStates.Active;
        day.ActiveBreak = Running();
        day.Active = new ActiveBreakInfo { Id = "b-1", Kind = "MORNING", SegmentStartedAt = Ist("11:02") };
        Assert.Equal(SlotState.InProgress, BreakSchedule.Compute(day, Ist("11:10")).Slots[0].State);

        var end = new JournalEvent { Kind = EventKinds.BreakEnd, At = Ist("11:12"), Payload = new EventPayload() };
        var view = DayProjection.Build(new DayBase { Breaks = day }, new[] { new ProjectedEvent(end, DayParts.Breaks) },
            id => id, at => "2026-10-13", "2026-10-13");

        var panel = BreakSchedule.Compute(view.Breaks, Ist("11:13"));
        Assert.Null(panel.Active);
        var morning = panel.Slots.Single(s => s.Kind == "MORNING");
        Assert.Equal(SlotState.Taken, morning.State);
        Assert.Equal(600, view.Breaks!.Breaks[0].Record!.TookSec);
    }
}
