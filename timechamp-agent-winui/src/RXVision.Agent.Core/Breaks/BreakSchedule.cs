using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Offline;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Breaks;

/// <summary>Where "now" falls for one scheduled break.</summary>
public enum SlotPhase { Upcoming, Early, Due, Late, Closed }

/// <summary>What the person sees for one break.</summary>
public enum SlotState
{
    /// <summary>The window has not opened yet.</summary>
    Upcoming,
    /// <summary>Open, before the ring: can start, may need a reason.</summary>
    OpenEarly,
    /// <summary>Ringing: start now, on time.</summary>
    Due,
    /// <summary>Open, after the ring: can start, may need a reason.</summary>
    OpenLate,
    /// <summary>Being taken now.</summary>
    InProgress,
    /// <summary>Taken earlier today.</summary>
    Taken,
    /// <summary>The window closed with no record: it was not owed (the day had not started), or the server has not marked it yet.</summary>
    Closed,
    /// <summary>The person skipped it (a SKIPPED record, 3.1).</summary>
    Skipped,
    /// <summary>The window closed untaken while the day ran (an AUTO_SKIPPED record, 3.1): it takes a comment.</summary>
    AutoSkipped,
    /// <summary>Not available because a later break was already taken.</summary>
    Unavailable,
    /// <summary>Started, then paused inside its window (4.0): it can be resumed until the window closes.</summary>
    Paused,
}

public sealed record SlotView(
    string Kind,
    string Label,
    string PresenceType,
    int DurationMin,
    /// <summary>The break's start as people read it ("11:00 AM", 12-hour; the server sends "HH:MM").</summary>
    string LocalStart,
    string LocalEnd,
    string LocalWindowOpen,
    string LocalWindowClose,
    SlotState State,
    SlotPhase Phase,
    BreakRecord? Record,
    bool CanStart,
    bool ReasonRequired,
    /// <summary>What starting now would be judged: ON_TIME, EARLY or LATE.</summary>
    string? TimingIfStartedNow,
    int MinutesOffIfStartedNow,
    DateTimeOffset WindowOpen,
    DateTimeOffset WindowClose,
    DateTimeOffset RingStart,
    DateTimeOffset RingEnd,
    DateTimeOffset ScheduledStart,
    /// <summary>The shift lets this break be skipped.</summary>
    bool AllowSkip = false,
    /// <summary>It can be skipped now: allowed, open, no record, no later break taken, not on a break, day not ended.</summary>
    bool CanSkip = false,
    /// <summary>
    /// An auto-skip End Day made while this window was open, still waiting for its comment:
    /// taking the break replaces it (until the window closes), so the slot reads as open.
    /// </summary>
    BreakRecord? PendingAutoSkip = null,
    /// <summary>Paused, its window still open, nothing else running, the day open (4.0).</summary>
    bool CanResume = false,
    /// <summary>Taken so far, all segments (4.0).</summary>
    int TakenSec = 0);

public sealed record ActiveBreakView(
    string? Kind,
    string Label,
    string PresenceType,
    int? DurationMin,
    DateTimeOffset StartedAt,
    TimeSpan Elapsed,
    /// <summary>Time left; negative once over (the countdown goes below zero).</summary>
    TimeSpan? Remaining,
    bool Overrun,
    /// <summary>"12:34" counting down, then "−02:10" once over; "34:10" elapsed when there is no length.</summary>
    string Countdown,
    /// <summary>Over the length by more than the shift's grace (3.x kept it; 4.0 asks nothing more at End break).</summary>
    bool PastGrace,
    string ApprovalStatus,
    string Timing,
    /// <summary>The break record's id (a local id until the server's is known).</summary>
    string? Id = null,
    /// <summary>A scheduled break can be paused (4.0); quick and plain breaks cannot.</summary>
    bool CanPause = false,
    /// <summary>A quick break (4.0).</summary>
    bool IsQuick = false,
    /// <summary>When this stretch began (after a resume, later than <see cref="StartedAt"/>).</summary>
    DateTimeOffset? SegmentStartedAt = null);

public sealed record RingView(string Kind, string Label, DateTimeOffset RingEnd, bool Sound);

public sealed record BreakPanel(
    bool Scheduled,
    bool Workday,
    bool DayEnded,
    string? ShiftName,
    /// <summary>"9:30 AM - 6:30 PM".</summary>
    string? ShiftHours,
    ShiftRules Rules,
    IReadOnlyList<SlotView> Slots,
    IReadOnlyList<BreakRecord> Unscheduled,
    ActiveBreakView? Active,
    /// <summary>The break the "Take a Break" tile points at (morning or evening), if any.</summary>
    SlotView? BreakTile,
    /// <summary>The lunch slot, if the shift has one.</summary>
    SlotView? LunchTile,
    RingView? Ring,
    /// <summary>The shift's minimum length for a reason or a comment.</summary>
    int MinChars = 10)
{
    public static readonly BreakPanel Free = new(false, false, false, null, null, new ShiftRules(),
        Array.Empty<SlotView>(), Array.Empty<BreakRecord>(), null, null, null, null);

    /// <summary>
    /// The 4.0 "Next break" tile's break: one paused and resumable, else one open now,
    /// else the next to open; null when no break is left today.
    /// </summary>
    public SlotView? Next { get; init; }

    /// <summary>A paused scheduled break, if any (it can be resumed or ended).</summary>
    public SlotView? Paused { get; init; }

    /// <summary>Today's quick breaks (4.0).</summary>
    public IReadOnlyList<QuickBreakView> Quick { get; init; } = Array.Empty<QuickBreakView>();

    /// <summary>Seconds of quick breaks taken today, the running one included (4.0).</summary>
    public int QuickTakenSec { get; init; }
}

/// <summary>
/// The break rules as pure functions of the day the server sent and a clock.
/// Mirrors the server (backend/src/modules/shifts/domain/break-schedule.ts):
/// the server is the authority, this keeps the agent ringing and counting down
/// on time between refreshes, and (4.0) decides every button while offline.
/// </summary>
public static class BreakSchedule
{
    public static SlotPhase PhaseAt(BreakSlot slot, DateTimeOffset now)
    {
        if (now < slot.WindowOpen) return SlotPhase.Upcoming;
        if (now >= slot.WindowClose) return SlotPhase.Closed;
        if (now < slot.RingStart) return SlotPhase.Early;
        if (now < slot.RingEnd) return SlotPhase.Due;
        return SlotPhase.Late;
    }

    /// <summary>Whole minutes early or late, the way the server counts them.</summary>
    public static (string Timing, int MinutesOff) Judge(BreakSlot slot, DateTimeOffset now)
    {
        var delta = (now - slot.ScheduledStart).TotalMinutes;
        return PhaseAt(slot, now) switch
        {
            SlotPhase.Due => ("ON_TIME", 0),
            SlotPhase.Early => ("EARLY", Math.Max(1, (int)Math.Ceiling(-delta))),
            SlotPhase.Late => ("LATE", Math.Max(1, (int)Math.Floor(delta))),
            _ => ("OUTSIDE_WINDOW", (int)Math.Round(Math.Abs(delta))),
        };
    }

    public static BreakPanel Compute(BreakDay? day, DateTimeOffset now)
    {
        var quickTaken = day is null ? 0 : day.Quick.Sum(q => QuickTaken(q, now));
        if (day is null || !day.Scheduled)
        {
            return day is null ? BreakPanel.Free : BreakPanel.Free with
            {
                Workday = day.Workday,
                DayEnded = day.DayEnded,
                ShiftName = day.Shift?.Name,
                ShiftHours = day.Shift is { } s0 ? Clock12.Range(s0.Start, s0.End) : null,
                Active = DayProjection.ActiveBreakOf(day) is { } ab ? Active(ab, null, now) : null,
                Unscheduled = day.Unscheduled,
                MinChars = MinCharsOf(day),
                Quick = day.Quick,
                QuickTakenSec = quickTaken,
            };
        }

        var rules = day.Shift?.Rules ?? new ShiftRules();
        var active = DayProjection.ActiveBreakOf(day);
        var order = BreakKinds.All.ToList();
        // Only a break actually taken closes the earlier ones; a skip does not.
        var takenKinds = day.Breaks.Where(b => b.Record is { IsSkip: false }).Select(b => b.Kind).ToHashSet();
        var latestTakenIndex = takenKinds.Count == 0 ? -1 : takenKinds.Max(k => order.IndexOf(k));

        var slots = new List<SlotView>();
        foreach (var slot in day.Breaks.OrderBy(b => order.IndexOf(b.Kind)))
        {
            var phase = PhaseAt(slot, now);
            // An auto-skip End Day made while this window was still open (End Day was then
            // stopped by a gate, or the person chose Not now) gives way to the real break
            // until the window closes, as on the server: the slot reads as not taken.
            var replaceable = slot.Record is { } made && IsReplaceableAutoSkip(made, slot.WindowClose, now);
            var record = replaceable ? null : slot.Record;
            var laterTaken = order.IndexOf(slot.Kind) < latestTakenIndex && record is null;
            var paused = record is { State: BreakStates.Paused } && active?.Id != record.Id;
            SlotState state;
            if (paused) state = now < slot.WindowClose && !day.DayEnded ? SlotState.Paused : SlotState.Taken;
            else if (record is { InProgress: true } || (record is not null && active?.Id == record.Id)) state = SlotState.InProgress;
            else if (record is { Outcome: BreakOutcomes.AutoSkipped }) state = SlotState.AutoSkipped;
            else if (record is { Outcome: BreakOutcomes.Skipped }) state = SlotState.Skipped;
            else if (record is not null) state = SlotState.Taken;
            // A window that closed with no record is closed, whatever came after it
            // (the portal says the same); only a still-open slot is blocked by order.
            else if (phase == SlotPhase.Closed) state = SlotState.Closed;
            else if (laterTaken) state = SlotState.Unavailable;
            else state = phase switch
            {
                SlotPhase.Upcoming => SlotState.Upcoming,
                SlotPhase.Early => SlotState.OpenEarly,
                SlotPhase.Due => SlotState.Due,
                SlotPhase.Late => SlotState.OpenLate,
                _ => SlotState.Closed,
            };

            var open = state is SlotState.OpenEarly or SlotState.Due or SlotState.OpenLate;
            var canStart = open && !day.DayEnded && active is null;
            var (timing, minutesOff) = Judge(slot, now);
            var reasonRequired = canStart && ((phase == SlotPhase.Early && rules.ReasonOnEarly) || (phase == SlotPhase.Late && rules.ReasonOnLate));

            slots.Add(new SlotView(
                slot.Kind, slot.Label, slot.PresenceType, slot.DurationMin,
                Clock12.FromHm(slot.Local.Start), Clock12.FromHm(slot.Local.End), Clock12.FromHm(slot.Local.WindowOpen), Clock12.FromHm(slot.Local.WindowClose),
                state, phase, record, canStart, reasonRequired,
                open ? timing : null, open ? minutesOff : 0,
                slot.WindowOpen, slot.WindowClose, slot.RingStart, slot.RingEnd, slot.ScheduledStart,
                AllowSkip: slot.AllowSkip,
                // Already skipped (waiting for its comment): it can be taken, not skipped again.
                CanSkip: canStart && slot.AllowSkip && !replaceable,
                PendingAutoSkip: replaceable ? slot.Record : null,
                CanResume: state == SlotState.Paused && active is null && !day.DayEnded,
                TakenSec: record is null ? 0 : DayProjection.TakenOf(record, now)));
        }

        RingView? ring = null;
        if (!day.DayEnded && active is null && slots.All(s => s.State != SlotState.Paused))
        {
            // Not for a break End Day just skipped (the person was asked about it there).
            var ringing = slots.FirstOrDefault(s => s.State == SlotState.Due && s.PendingAutoSkip is null);
            if (ringing is not null) ring = new RingView(ringing.Kind, ringing.Label, ringing.RingEnd, rules.RingSound);
        }

        SlotView? Tile(Func<SlotView, bool> match)
        {
            var candidates = slots.Where(match).ToList();
            return candidates.FirstOrDefault(s => s.State is SlotState.InProgress)
                ?? candidates.FirstOrDefault(s => s.CanStart)
                ?? candidates.FirstOrDefault(s => s.State == SlotState.Upcoming)
                ?? candidates.LastOrDefault();
        }

        var pausedSlot = slots.FirstOrDefault(s => s.State == SlotState.Paused);
        var next = pausedSlot
            ?? slots.FirstOrDefault(s => s.State is SlotState.OpenEarly or SlotState.Due or SlotState.OpenLate)
            ?? slots.FirstOrDefault(s => s.State == SlotState.Upcoming);
        var activeSlot = active is null ? null : day.Breaks.FirstOrDefault(b => b.Kind == active.Kind);
        return new BreakPanel(
            Scheduled: true,
            Workday: day.Workday,
            DayEnded: day.DayEnded,
            ShiftName: day.Shift?.Name,
            ShiftHours: day.Shift is { } s ? Clock12.Range(s.Start, s.End) : null,
            Rules: rules,
            Slots: slots,
            Unscheduled: day.Unscheduled,
            Active: active is null ? null : Active(active, rules, now, activeSlot),
            BreakTile: Tile(v => v.PresenceType == "BREAK"),
            LunchTile: Tile(v => v.PresenceType == "LUNCH"),
            Ring: ring,
            MinChars: MinCharsOf(day))
        {
            Next = day.DayEnded ? null : next,
            Paused = pausedSlot,
            Quick = day.Quick,
            QuickTakenSec = quickTaken,
        };
    }

    private static int QuickTaken(QuickBreakView q, DateTimeOffset now) =>
        q.EndedAt is { } end
            ? (q.TakenSec > 0 ? q.TakenSec : (int)Math.Max(0, (end - q.StartedAt).TotalSeconds))
            : (int)Math.Max(0, (now - q.StartedAt).TotalSeconds);

    private static int MinCharsOf(BreakDay day) =>
        Math.Clamp(day.ReasonMinChars ?? day.Shift?.Rules.ReasonMinChars ?? 10, 1, 500);

    /// <summary>
    /// An AUTO_SKIPPED record End Day made inside the break's still-open window, with no
    /// comment yet: while the window is open the real break replaces it (the server's
    /// isReplaceableAutoSkip). One made when the window closed is a real auto-skip.
    /// </summary>
    public static bool IsReplaceableAutoSkip(BreakRecord record, DateTimeOffset windowClose, DateTimeOffset now) =>
        record.Outcome == BreakOutcomes.AutoSkipped
        && string.IsNullOrWhiteSpace(record.Reason)
        && record.StartedAt < windowClose
        && now < windowClose;

    public static ActiveBreakView Active(BreakRecord record, ShiftRules? rules, DateTimeOffset now, BreakSlot? slot = null)
    {
        // 4.0: a resumed break counts every segment, not the time since it first started.
        var elapsed = TimeSpan.FromSeconds(DayProjection.TakenOf(record, now));
        if (record.Segments.Count == 0)
        {
            elapsed = now - record.StartedAt;
            if (elapsed < TimeSpan.Zero) elapsed = TimeSpan.Zero;
        }
        var quick = record.Kind == BreakKinds.Quick;
        var duration = quick ? record.PlannedMin ?? record.DurationMin : record.DurationMin ?? slot?.DurationMin;
        TimeSpan? remaining = duration is { } d ? TimeSpan.FromMinutes(d) - elapsed : null;
        var overrun = remaining is { } r && r < TimeSpan.Zero;
        var countdown = remaining is { } rem ? FormatSigned(rem) : Format(elapsed);
        // Past the shift's grace (3.1: whatever the shift's old overrun-reason switch says).
        var pastGrace = rules is not null && remaining is { } r2
            && -r2 > TimeSpan.FromMinutes(Math.Max(0, rules.OverrunGraceMin));
        var segmentStart = record.Segments.LastOrDefault(s => s.EndedAt is null)?.StartedAt ?? record.StartedAt;
        return new ActiveBreakView(
            record.Kind,
            string.IsNullOrWhiteSpace(record.Label) ? (record.PresenceType == "LUNCH" ? "Lunch" : "Break") : record.Label,
            record.PresenceType,
            duration,
            record.StartedAt,
            elapsed,
            remaining,
            overrun,
            countdown,
            pastGrace,
            record.ApprovalStatus,
            record.Timing,
            Id: string.IsNullOrEmpty(record.Id) ? null : record.Id,
            CanPause: record.Kind is BreakKinds.Morning or BreakKinds.Lunch or BreakKinds.Evening,
            IsQuick: quick,
            SegmentStartedAt: segmentStart);
    }

    /// <summary>"12:34", or "1:02:03" past an hour.</summary>
    public static string Format(TimeSpan t)
    {
        if (t < TimeSpan.Zero) t = TimeSpan.Zero;
        var total = (long)Math.Floor(t.TotalSeconds);
        var h = total / 3600;
        var m = total % 3600 / 60;
        var s = total % 60;
        return h > 0 ? $"{h}:{m:00}:{s:00}" : $"{m:00}:{s:00}";
    }

    /// <summary>The minus sign people read ("−02:10"), not a hyphen.</summary>
    public const string Minus = "−";

    /// <summary>Counting down to zero, then "−mm:ss" counting up while over.</summary>
    public static string FormatSigned(TimeSpan remaining)
    {
        if (remaining >= TimeSpan.Zero)
        {
            // Round up so it reads 15:00 at the start and only shows 00:00 at the end.
            var up = TimeSpan.FromSeconds(Math.Ceiling(remaining.TotalSeconds));
            return Format(up);
        }
        return Minus + Format(remaining.Negate());
    }
}
