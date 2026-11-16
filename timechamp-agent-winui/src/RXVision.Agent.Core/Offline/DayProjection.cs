using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Offline;

/// <summary>The three parts of the day the server sends separately.</summary>
[Flags]
public enum DayParts
{
    None = 0,
    Workday = 1,
    Breaks = 2,
    Meetings = 4,
    All = Workday | Breaks | Meetings,
}

/// <summary>The day as the server last said it (each part from its own answer). Persisted.</summary>
public sealed class DayBase
{
    public WorkdayToday? Workday { get; set; }
    public BreakDay? Breaks { get; set; }
    public List<MeetingRecord> Meetings { get; set; } = new();
    public CurrentPresence? Presence { get; set; }
    public PresenceTotals? Totals { get; set; }
}

/// <summary>An action to show on top of the server's day, with the parts it still changes there.</summary>
public sealed record ProjectedEvent(JournalEvent Event, DayParts Parts);

/// <summary>Away time recorded here (not yet in the server's day): not focus.</summary>
public sealed record AwayInterval(DateTimeOffset StartedAt, DateTimeOffset EndedAt, string Status, string? Reason, string? Comment);

/// <summary>
/// Focus time between the server's answers, from the server's last number and what
/// happened since: it counts while the day is open, except during breaks and away
/// time. Whole seconds, like the server.
/// </summary>
public sealed class FocusModel
{
    public int BaseSec { get; init; }
    public DateTimeOffset BaseAt { get; init; }
    /// <summary>Stretches the day was open since <see cref="BaseAt"/> (an open end runs to now).</summary>
    public List<(DateTimeOffset From, DateTimeOffset? To)> Open { get; init; } = new();
    /// <summary>Stretches that are not focus: breaks, away (an open end runs to now).</summary>
    public List<(DateTimeOffset From, DateTimeOffset? To)> Off { get; init; } = new();

    public static readonly FocusModel Empty = new();

    /// <summary>Focus at <paramref name="now"/>; <paramref name="awaySince"/>: an away pop-up open since then (not focus either).</summary>
    public int At(DateTimeOffset now, DateTimeOffset? awaySince = null)
    {
        double total = Math.Max(0, BaseSec);
        var off = Off.ToList();
        if (awaySince is { } away) off.Add((away, null));
        foreach (var (from, to) in Open)
        {
            var a = from < BaseAt ? BaseAt : from;
            var b = to is { } t && t < now ? t : now;
            if (b <= a) continue;
            total += (b - a).TotalSeconds - Overlap(off, a, b, now);
        }
        var max = Math.Max(0, BaseSec) + TimeSpan.FromHours(24).TotalSeconds;
        return (int)Math.Clamp(Math.Floor(total), 0, max);
    }

    /// <summary>Whether focus is counting at <paramref name="now"/>.</summary>
    public bool RunningAt(DateTimeOffset now) =>
        Open.Any(o => o.From <= now && (o.To is null || o.To > now)) && !Off.Any(o => o.From <= now && (o.To is null || o.To > now));

    /// <summary>The length of the union of <paramref name="intervals"/> inside [a, b].</summary>
    private static double Overlap(List<(DateTimeOffset From, DateTimeOffset? To)> intervals, DateTimeOffset a, DateTimeOffset b, DateTimeOffset now)
    {
        var clipped = intervals
            .Select(i => (From: i.From < a ? a : i.From, To: Min(i.To ?? now, b)))
            .Where(i => i.To > i.From)
            .OrderBy(i => i.From)
            .ToList();
        double sum = 0;
        DateTimeOffset? curFrom = null, curTo = null;
        foreach (var (from, to) in clipped)
        {
            if (curTo is null || from > curTo)
            {
                if (curFrom is { } cf && curTo is { } ct) sum += (ct - cf).TotalSeconds;
                curFrom = from;
                curTo = to;
            }
            else if (to > curTo)
            {
                curTo = to;
            }
        }
        if (curFrom is { } f && curTo is { } t2) sum += (t2 - f).TotalSeconds;
        return sum;
    }

    private static DateTimeOffset Min(DateTimeOffset x, DateTimeOffset y) => x < y ? x : y;
}

/// <summary>The day to show: the server's last day with every action since applied.</summary>
public sealed class DayView
{
    public WorkdayToday? Workday { get; init; }
    public BreakDay? Breaks { get; init; }
    public IReadOnlyList<MeetingRecord> Meetings { get; init; } = Array.Empty<MeetingRecord>();
    public MeetingRecord? LiveMeeting { get; init; }
    public FocusModel Focus { get; init; } = FocusModel.Empty;
    public IReadOnlyList<AwayInterval> Away { get; init; } = Array.Empty<AwayInterval>();
    /// <summary>Actions shown here that the server's day does not have yet.</summary>
    public int LocalChanges { get; init; }

    public static readonly DayView Empty = new();
}

/// <summary>Break time used against the paid allowance (SPEC 2.4), as of a moment.</summary>
public sealed record AllowanceNow(int ScheduledSec, int BufferSec, int PaidUsedSec, int BufferUsedSec, int UnpaidSec, int BreakSec)
{
    public int TotalSec => ScheduledSec + BufferSec;
}

/// <summary>Time taken today for breaks, lunch and meetings (the "Time taken today" line).</summary>
public sealed record TakenTotals(int BreakSec, int LunchSec, int MeetingSec, int QuickSec);

/// <summary>
/// Pure functions: the server's last day plus the journal gives today as the person
/// lived it (SPEC 6 "Local state"). The same rules as the server, as far as the agent
/// can know them: windows, order and timing from the cached shift; the server checks
/// again when each action is replayed at its own time.
/// </summary>
public static class DayProjection
{
    public const string QuickLabel = "Quick break";
    public const string AwayBreakLabel = "Away break";

    /// <param name="today">The business date now ("yyyy-MM-dd"): a finished or unstarted day from before it reads as today, not started.</param>
    public static DayView Build(DayBase b, IReadOnlyList<ProjectedEvent> events, Func<string?, string?> resolve,
        Func<DateTimeOffset, string> businessDate, string today)
    {
        var workday = Clone(b.Workday);
        var breaks = Clone(b.Breaks);
        if (breaks is not null) Normalise(breaks);
        var meetings = Clone(b.Meetings) ?? new List<MeetingRecord>();
        var away = new List<AwayInterval>();

        // A day that is over (or never began) on an earlier date: today has not started. A night
        // shift ended after midnight still reads as the day that ended until the server says more.
        var endedToday = workday is { IsEnded: true, EndedAt: { } ended } && businessDate(ended) == today;
        if (workday is not null && !workday.IsOpen && !endedToday && IsEarlier(workday.Date, today))
        {
            workday = NewDay(workday, today, State: WorkdayStates.NotStarted);
            meetings = new List<MeetingRecord>();
        }
        if (breaks is not null && IsEarlier(breaks.Date, today) && workday is not { IsOpen: true })
            breaks = RollBreaks(breaks, today);

        var focusBaseSec = workday?.Focus.FocusSec ?? 0;
        var focusBaseAt = workday is { ServerNow: var sn } && sn != default ? sn : events.FirstOrDefault()?.Event.At ?? DateTimeOffset.MinValue;
        var open = new List<(DateTimeOffset From, DateTimeOffset? To)>();
        if (workday is { IsOpen: true }) open.Add((focusBaseAt, null));
        var stoppedByServer = workday is { IsOpen: true, Focus.Running: false } && ActiveBreakOf(breaks) is null;
        DateTimeOffset? serverPausedUntil = null;

        var local = 0;
        foreach (var (e, parts) in events)
        {
            if (parts == DayParts.None) continue;
            local++;
            var at = e.At;
            var p = e.Payload;
            if (stoppedByServer && serverPausedUntil is null && e.Kind is EventKinds.BreakEnd or EventKinds.BreakStart or EventKinds.BreakQuick
                    or EventKinds.BreakFree or EventKinds.StartDay or EventKinds.EndDay)
                serverPausedUntil = at;
            switch (e.Kind)
            {
                case EventKinds.StartDay:
                {
                    var date = businessDate(at);
                    if (parts.HasFlag(DayParts.Workday))
                    {
                        if (workday is null || (!workday.IsOpen && workday.Date != date))
                        {
                            workday = NewDay(workday, date, WorkdayStates.Open, at);
                            focusBaseSec = 0;
                            focusBaseAt = at;
                            open.Clear();
                            open.Add((at, null));
                            meetings = new List<MeetingRecord>();
                        }
                        else if (!workday.IsOpen)
                        {
                            workday.State = WorkdayStates.Open;
                            workday.StartedAt ??= at;
                            workday.EndedAt = null;
                            workday.AutoClosed = false;
                            workday.Sessions.Add(new WorkSessionView { StartedAt = at });
                            workday.Focus.Running = true;
                            open.Add((at, null));
                        }
                    }
                    if (parts.HasFlag(DayParts.Breaks) && breaks is not null)
                    {
                        if (breaks.Date != date && IsEarlier(breaks.Date, date)) breaks = RollBreaks(breaks, date);
                        breaks.DayEnded = false;
                    }
                    break;
                }
                case EventKinds.EndDay:
                    if (parts.HasFlag(DayParts.Breaks) && breaks is not null)
                    {
                        EndActive(breaks, at);
                        breaks.DayEnded = true;
                    }
                    if (parts.HasFlag(DayParts.Workday) && workday is { IsOpen: true })
                    {
                        workday.State = WorkdayStates.Ended;
                        workday.EndedAt = at;
                        foreach (var s in workday.Sessions.Where(s => s.EndedAt is null))
                        {
                            s.EndedAt = at;
                            s.EndReason = "USER";
                        }
                        workday.Focus.Running = false;
                        var commented = (p.Comments ?? new List<SkipComment>()).Select(c => c.BreakId).ToHashSet();
                        workday.SkipsNeedingComment.RemoveAll(s => commented.Contains(s.Id));
                        for (var i = 0; i < open.Count; i++)
                            if (open[i].To is null) open[i] = (open[i].From, at);
                    }
                    if (parts.HasFlag(DayParts.Meetings))
                        foreach (var m in meetings.Where(m => m.InProgress)) EndMeeting(m, at);
                    break;

                case EventKinds.BreakStart when parts.HasFlag(DayParts.Breaks) && breaks is not null:
                {
                    var slot = breaks.Breaks.FirstOrDefault(s => s.Kind == p.BreakKind);
                    if (slot is null) break;
                    var (timing, minutesOff) = BreakSchedule.Judge(slot, at);
                    var record = new BreakRecord
                    {
                        Id = Created(p, e, resolve),
                        Date = breaks.Date,
                        Kind = slot.Kind,
                        Label = slot.Label,
                        PresenceType = slot.PresenceType,
                        ShiftName = breaks.Shift?.Name,
                        ScheduledStart = slot.ScheduledStart,
                        DurationMin = slot.DurationMin,
                        StartedAt = at,
                        InProgress = true,
                        Timing = timing is "EARLY" or "LATE" ? timing : "ON_TIME",
                        MinutesOff = timing is "EARLY" or "LATE" ? minutesOff : 0,
                        Reason = string.IsNullOrWhiteSpace(p.Reason) ? null : p.Reason,
                        ApprovalStatus = timing is "EARLY" or "LATE" ? "PENDING" : "NOT_REQUIRED",
                        Outcome = BreakOutcomes.Taken,
                        State = BreakStates.Active,
                        Segments = { new BreakSegment { StartedAt = at } },
                    };
                    slot.Record = record;
                    slot.State = BreakStates.Active;
                    slot.Segments = record.Segments.ToList();
                    slot.CanResume = false;
                    SetActive(breaks, record, slot.Kind, at, 0, slot.DurationMin);
                    break;
                }
                case EventKinds.BreakFree when parts.HasFlag(DayParts.Breaks) && breaks is not null:
                {
                    var lunch = p.PresenceType == PresenceStatus.Lunch;
                    var record = new BreakRecord
                    {
                        Id = Created(p, e, resolve),
                        Date = breaks.Date,
                        Label = lunch ? "Lunch" : "Break",
                        PresenceType = lunch ? PresenceStatus.Lunch : PresenceStatus.Break,
                        StartedAt = at,
                        InProgress = true,
                        Timing = "UNSCHEDULED",
                        State = BreakStates.Active,
                        Segments = { new BreakSegment { StartedAt = at } },
                    };
                    breaks.ActiveBreak = record;
                    breaks.Active = new ActiveBreakInfo { Id = record.Id, Kind = null, SegmentStartedAt = at };
                    break;
                }
                case EventKinds.BreakQuick when parts.HasFlag(DayParts.Breaks) && breaks is not null:
                    StartQuick(breaks, Created(p, e, resolve), at, p.PlannedMin, QuickLabel);
                    break;

                case EventKinds.BreakPause when parts.HasFlag(DayParts.Breaks) && breaks is not null:
                {
                    var slot = breaks.Breaks.FirstOrDefault(s => s.Record is { } r && Same(r.Id, p.TargetId, resolve));
                    if (slot?.Record is not { } record || record.State == BreakStates.Ended) break;
                    CloseSegments(record, at);
                    record.State = BreakStates.Paused;
                    record.InProgress = false;
                    record.TakenSec = TakenOf(record, at);
                    slot.State = BreakStates.Paused;
                    slot.Segments = record.Segments.ToList();
                    slot.TakenSec = record.TakenSec;
                    slot.RemainingSec = slot.DurationMin * 60 - record.TakenSec;
                    slot.ResumeUntil = slot.WindowClose;
                    slot.CanResume = at < slot.WindowClose;
                    if (breaks.ActiveBreak is { } ab && Same(ab.Id, record.Id, resolve)) breaks.ActiveBreak = null;
                    if (breaks.Active is { } act && Same(act.Id, record.Id, resolve)) breaks.Active = null;
                    break;
                }
                case EventKinds.BreakResume when parts.HasFlag(DayParts.Breaks) && breaks is not null:
                {
                    var slot = breaks.Breaks.FirstOrDefault(s => s.Record is { } r && Same(r.Id, p.TargetId, resolve));
                    if (slot?.Record is not { } record || record.State != BreakStates.Paused) break;
                    var before = TakenOf(record, at);
                    record.Segments.Add(new BreakSegment { StartedAt = at });
                    record.State = BreakStates.Active;
                    record.InProgress = true;
                    slot.State = BreakStates.Active;
                    slot.Segments = record.Segments.ToList();
                    slot.CanResume = false;
                    SetActive(breaks, record, slot.Kind, at, before, slot.DurationMin);
                    break;
                }
                case EventKinds.BreakEnd when parts.HasFlag(DayParts.Breaks) && breaks is not null:
                    EndActive(breaks, at);
                    break;

                case EventKinds.BreakSkip when parts.HasFlag(DayParts.Breaks) && breaks is not null:
                {
                    var slot = breaks.Breaks.FirstOrDefault(s => s.Kind == p.BreakKind);
                    if (slot is null) break;
                    slot.Record = new BreakRecord
                    {
                        Id = Created(p, e, resolve),
                        Date = breaks.Date,
                        Kind = slot.Kind,
                        Label = slot.Label,
                        PresenceType = slot.PresenceType,
                        ScheduledStart = slot.ScheduledStart,
                        DurationMin = slot.DurationMin,
                        StartedAt = at,
                        EndedAt = at,
                        Outcome = BreakOutcomes.Skipped,
                        Timing = BreakSchedule.Judge(slot, at).Timing is "EARLY" or "LATE" ? BreakSchedule.Judge(slot, at).Timing : "ON_TIME",
                        Reason = string.IsNullOrWhiteSpace(p.Reason) ? null : p.Reason,
                        ApprovalStatus = "PENDING",
                        NeedsComment = string.IsNullOrWhiteSpace(p.Reason),
                        State = BreakStates.Ended,
                    };
                    slot.State = BreakStates.Ended;
                    break;
                }
                case EventKinds.BreakComment:
                    if (parts.HasFlag(DayParts.Breaks) && breaks is not null)
                    {
                        foreach (var slot in breaks.Breaks)
                        {
                            if (slot.Record is not { } r || !Same(r.Id, p.TargetId, resolve)) continue;
                            r.Reason = p.Comment;
                            r.NeedsComment = false;
                            r.CommentedAt = at;
                        }
                        breaks.SkipsNeedingComment.RemoveAll(s => Same(s.Id, p.TargetId, resolve));
                    }
                    if (parts.HasFlag(DayParts.Workday) && workday is not null)
                        workday.SkipsNeedingComment.RemoveAll(s => Same(s.Id, p.TargetId, resolve));
                    break;

                case EventKinds.MeetingStart when parts.HasFlag(DayParts.Meetings):
                    meetings.Add(new MeetingRecord
                    {
                        Id = Created(p, e, resolve),
                        Date = workday?.Date ?? businessDate(at),
                        Mode = MeetingModes.Live,
                        Agenda = p.Agenda ?? "",
                        Participants = p.Participants?.ToList() ?? new List<MeetingParticipant>(),
                        MomSender = p.MomSender,
                        StartedAt = at,
                        InProgress = true,
                        ApprovalStatus = "PENDING",
                    });
                    break;
                case EventKinds.MeetingEnd when parts.HasFlag(DayParts.Meetings):
                {
                    var live = meetings.LastOrDefault(m => m.InProgress && (p.TargetId is null || Same(m.Id, p.TargetId, resolve)))
                        ?? meetings.LastOrDefault(m => m.InProgress);
                    if (live is null) break;
                    EndMeeting(live, at);
                    if (live.DurationSec < 60) meetings.Remove(live); // under a minute is not kept
                    break;
                }
                case EventKinds.MeetingPast when parts.HasFlag(DayParts.Meetings) && p.StartedAt is { } started:
                {
                    var minutes = Math.Max(0, p.DurationMin ?? 0);
                    meetings.Add(new MeetingRecord
                    {
                        Id = Created(p, e, resolve),
                        Date = workday?.Date ?? businessDate(at),
                        Mode = MeetingModes.Past,
                        Agenda = p.Agenda ?? "",
                        Participants = p.Participants?.ToList() ?? new List<MeetingParticipant>(),
                        MomSender = p.MomSender,
                        StartedAt = started,
                        EndedAt = started.AddMinutes(minutes),
                        DurationSec = minutes * 60,
                        ApprovalStatus = "PENDING",
                    });
                    break;
                }

                case EventKinds.Away:
                {
                    var start = p.StartedAt ?? at;
                    if (start > at) start = at;
                    if (p.ReasonKind == AwayKinds.Break)
                    {
                        if (parts.HasFlag(DayParts.Breaks) && breaks is not null)
                            StartQuick(breaks, Created(p, e, resolve), start, null, AwayBreakLabel);
                        break;
                    }
                    if (!parts.HasFlag(DayParts.Workday)) break;
                    away.Add(new AwayInterval(start, at, "PENDING", p.ReasonLabel ?? p.ReasonKey, p.Comment));
                    if (workday is not null)
                    {
                        var seconds = (int)Math.Max(0, (at - start).TotalSeconds);
                        workday.Away ??= new AwayTotals();
                        workday.Away.PendingSec += seconds;
                        workday.Focus.PendingPlusSec += seconds;
                    }
                    break;
                }
                case EventKinds.AwayUnexplained when parts.HasFlag(DayParts.Workday):
                {
                    var start = p.StartedAt ?? at;
                    var end = p.EndedAt ?? at;
                    if (end < start) end = start;
                    away.Add(new AwayInterval(start, end, "UNEXPLAINED", null, null));
                    if (workday is not null)
                    {
                        workday.Away ??= new AwayTotals();
                        workday.Away.UnexplainedSec += (int)(end - start).TotalSeconds;
                    }
                    break;
                }
            }
        }

        // What is not focus: every break stretch, every away stretch (clipped to after the base later).
        var off = new List<(DateTimeOffset From, DateTimeOffset? To)>();
        if (breaks is not null)
        {
            foreach (var r in AllBreakRecords(breaks))
            {
                if (r.IsSkip) continue;
                foreach (var seg in SegmentsOf(r)) off.Add((seg.StartedAt, seg.EndedAt));
            }
            foreach (var q in breaks.Quick) off.Add((q.StartedAt, q.EndedAt));
        }
        foreach (var a in away) off.Add((a.StartedAt, a.EndedAt));
        if (stoppedByServer) off.Add((focusBaseAt, serverPausedUntil));

        var live2 = meetings.LastOrDefault(m => m.InProgress && m.Mode == MeetingModes.Live);
        if (workday is not null && breaks is not null)
            workday.Focus.Running = workday.IsOpen && ActiveBreakOf(breaks) is null;

        return new DayView
        {
            Workday = workday,
            Breaks = breaks,
            Meetings = meetings,
            LiveMeeting = live2,
            Focus = new FocusModel { BaseSec = focusBaseSec, BaseAt = focusBaseAt, Open = open, Off = off },
            Away = away,
            LocalChanges = local,
        };
    }

    // ---- Breaks -----------------------------------------------------------------------------

    /// <summary>
    /// A 4.0 server's break day in the shape the agent works with: the running break as
    /// <see cref="BreakDay.ActiveBreak"/> (from <c>active</c> when only that came, a quick
    /// break included), its segments when only <c>takenBeforeSec</c> came, and a paused
    /// break on its slot.
    /// </summary>
    public static void Normalise(BreakDay day)
    {
        if (day.Active is { } a && (day.ActiveBreak is null || day.ActiveBreak.Id != a.Id))
        {
            var record = day.Breaks.Select(s => s.Record).FirstOrDefault(r => r is not null && r.Id == a.Id)
                ?? day.Unscheduled.FirstOrDefault(r => r.Id == a.Id)
                ?? (day.ActiveBreak?.Id == a.Id ? day.ActiveBreak : null);
            if (record is null && (a.Kind == BreakKinds.Quick || day.Quick.Any(q => q.Id == a.Id)))
            {
                var q = day.Quick.FirstOrDefault(x => x.Id == a.Id);
                var planned = a.PlannedMin ?? q?.PlannedMin;
                record = new BreakRecord
                {
                    Id = a.Id,
                    Date = day.Date,
                    Kind = BreakKinds.Quick,
                    Label = QuickLabel,
                    PresenceType = PresenceStatus.Break,
                    DurationMin = planned,
                    PlannedMin = planned,
                    StartedAt = q?.StartedAt ?? a.SegmentStartedAt.AddSeconds(-a.TakenBeforeSec),
                    Timing = "UNSCHEDULED",
                    ApprovalStatus = "NOT_REQUIRED",
                };
            }
            if (record is not null)
            {
                record.InProgress = true;
                record.State = BreakStates.Active;
                if (record.Segments.Count == 0 && a.SegmentStartedAt != default)
                {
                    if (a.TakenBeforeSec > 0)
                        record.Segments.Add(new BreakSegment { StartedAt = a.SegmentStartedAt.AddSeconds(-a.TakenBeforeSec), EndedAt = a.SegmentStartedAt });
                    record.Segments.Add(new BreakSegment { StartedAt = a.SegmentStartedAt });
                }
                day.ActiveBreak = record;
            }
        }
        // The server sends the running break twice (activeBreak and its slot's record, or its
        // place in the plain list): one record from here on, so ending or pausing it shows on
        // the slot too (seen end to end: a break ended after the day was read again still read
        // as in progress on its slot).
        if (day.ActiveBreak is { } running)
        {
            foreach (var slot in day.Breaks)
                if (slot.Record is { } r && r.Id == running.Id && !ReferenceEquals(r, running)) slot.Record = running;
            for (var i = 0; i < day.Unscheduled.Count; i++)
                if (day.Unscheduled[i].Id == running.Id) day.Unscheduled[i] = running;
        }
        if (day.PausedBreak is { } paused)
        {
            var slot = day.Breaks.FirstOrDefault(s => s.Record?.Id == paused.Id) ?? day.Breaks.FirstOrDefault(s => s.Kind == paused.Kind);
            if (slot is not null && slot.Record is not { State: BreakStates.Paused })
            {
                paused.State = BreakStates.Paused;
                paused.InProgress = false;
                slot.Record = paused;
            }
            if (day.ActiveBreak?.Id == paused.Id) day.ActiveBreak = null;
        }
    }

    /// <summary>Every break record the day knows (slots, quick breaks as records, plain ones, the active one).</summary>
    public static IEnumerable<BreakRecord> AllBreakRecords(BreakDay day)
    {
        var seen = new HashSet<string>();
        foreach (var slot in day.Breaks)
            if (slot.Record is { } r && seen.Add(Key(r))) yield return r;
        foreach (var r in day.Unscheduled)
            if (seen.Add(Key(r))) yield return r;
        if (day.ActiveBreak is { } active && active.Kind != BreakKinds.Quick && seen.Add(Key(active))) yield return active;
    }

    private static string Key(BreakRecord r) => string.IsNullOrEmpty(r.Id) ? $"{r.Kind}|{r.StartedAt.UtcTicks}" : r.Id;

    /// <summary>The break running now (open segment), or null.</summary>
    public static BreakRecord? ActiveBreakOf(BreakDay? day)
    {
        if (day is null) return null;
        if (day.ActiveBreak is { } ab && ab.State != BreakStates.Paused && ab.State != BreakStates.Ended) return ab;
        return null;
    }

    /// <summary>A record's stretches: its segments, else StartedAt to EndedAt (an older server).</summary>
    public static IEnumerable<BreakSegment> SegmentsOf(BreakRecord r)
    {
        if (r.Segments.Count > 0) return r.Segments;
        if (r.IsSkip) return Array.Empty<BreakSegment>();
        if (r.InProgress) return new[] { new BreakSegment { StartedAt = r.StartedAt } };
        if (r.EndedAt is { } end) return new[] { new BreakSegment { StartedAt = r.StartedAt, EndedAt = end } };
        return Array.Empty<BreakSegment>();
    }

    /// <summary>Seconds taken by a break as of <paramref name="now"/> (all its segments; 0 for a skip).</summary>
    public static int TakenOf(BreakRecord r, DateTimeOffset now)
    {
        if (r.IsSkip) return 0;
        if (r.Segments.Count == 0)
        {
            if (r.InProgress) return WholeSeconds(r.StartedAt, now);
            if (r.TookSec > 0) return r.TookSec;
            if (r.TakenSec is { } taken) return taken;
            return r.EndedAt is { } end ? WholeSeconds(r.StartedAt, end) : 0;
        }
        var sum = 0;
        foreach (var s in r.Segments) sum += WholeSeconds(s.StartedAt, s.EndedAt ?? now);
        return sum;
    }

    /// <summary>
    /// Whole seconds from <paramref name="from"/> to <paramref name="to"/> (0 when not after it), each
    /// instant floored to its second first, as the server counts (SPEC 2.4): two breaks of 0.6 s
    /// that straddle a second boundary are 1 s here and there, not 0 here and 1 there.
    /// </summary>
    public static int WholeSeconds(DateTimeOffset from, DateTimeOffset to) =>
        (int)Math.Max(0, to.ToUnixTimeSeconds() - from.ToUnixTimeSeconds());

    /// <summary>A quick break's seconds as of <paramref name="now"/>: from its instants when it ended, else to now.</summary>
    private static int QuickTaken(QuickBreakView q, DateTimeOffset now) =>
        q.EndedAt is { } end
            ? (WholeSeconds(q.StartedAt, end) is var whole and > 0 ? whole : Math.Max(0, q.TakenSec))
            : WholeSeconds(q.StartedAt, now);

    private static void CloseSegments(BreakRecord record, DateTimeOffset at)
    {
        if (record.Segments.Count == 0) record.Segments.Add(new BreakSegment { StartedAt = record.StartedAt });
        foreach (var s in record.Segments.Where(s => s.EndedAt is null)) s.EndedAt = at < s.StartedAt ? s.StartedAt : at;
    }

    private static void SetActive(BreakDay breaks, BreakRecord record, string? kind, DateTimeOffset segmentStart, int takenBefore, int? planned)
    {
        breaks.ActiveBreak = record;
        breaks.Active = new ActiveBreakInfo
        {
            Id = record.Id,
            Kind = kind,
            SegmentStartedAt = segmentStart,
            TakenBeforeSec = takenBefore,
            PlannedMin = planned,
        };
    }

    private static void StartQuick(BreakDay breaks, string id, DateTimeOffset start, int? plannedMin, string label)
    {
        breaks.Quick.Add(new QuickBreakView { Id = id, StartedAt = start, PlannedMin = plannedMin });
        var record = new BreakRecord
        {
            Id = id,
            Date = breaks.Date,
            Kind = BreakKinds.Quick,
            Label = label,
            PresenceType = PresenceStatus.Break,
            DurationMin = plannedMin,
            PlannedMin = plannedMin,
            StartedAt = start,
            InProgress = true,
            Timing = "UNSCHEDULED",
            ApprovalStatus = "NOT_REQUIRED",
            State = BreakStates.Active,
            Segments = { new BreakSegment { StartedAt = start } },
        };
        SetActive(breaks, record, BreakKinds.Quick, start, 0, plannedMin);
    }

    /// <summary>End break: the running one (scheduled, quick or plain), else a paused one (ended at its pause).</summary>
    private static void EndActive(BreakDay breaks, DateTimeOffset at)
    {
        var active = breaks.ActiveBreak;
        if (active is not null && active.State != BreakStates.Ended)
        {
            CloseSegments(active, at);
            active.State = BreakStates.Ended;
            active.InProgress = false;
            active.EndedAt = at;
            active.TakenSec = TakenOf(active, at);
            active.TookSec = active.TakenSec ?? 0;
            if (active.DurationMin is { } d && d > 0) active.OverrunSec = Math.Max(0, active.TookSec - d * 60);
            if (active.Kind == BreakKinds.Quick)
            {
                foreach (var q in breaks.Quick.Where(q => q.Id == active.Id && q.EndedAt is null))
                {
                    q.EndedAt = at;
                    q.TakenSec = active.TookSec;
                }
            }
            else if (breaks.Breaks.FirstOrDefault(s => s.Record is { } r && r.Id == active.Id) is { } slot)
            {
                slot.State = BreakStates.Ended;
                slot.Segments = active.Segments.ToList();
                slot.TakenSec = active.TookSec;
                slot.RemainingSec = slot.DurationMin * 60 - active.TookSec;
                slot.CanResume = false;
            }
            else if (breaks.Unscheduled.All(u => u.Id != active.Id))
            {
                breaks.Unscheduled.Add(active);
            }
        }
        else
        {
            // A paused break: End ends it where it was paused.
            foreach (var slot in breaks.Breaks)
            {
                if (slot.Record is not { State: BreakStates.Paused } paused) continue;
                var last = paused.Segments.LastOrDefault()?.EndedAt ?? at;
                paused.State = BreakStates.Ended;
                paused.EndedAt = last;
                paused.TookSec = TakenOf(paused, last);
                paused.TakenSec = paused.TookSec;
                if (paused.DurationMin is { } d && d > 0) paused.OverrunSec = Math.Max(0, paused.TookSec - d * 60);
                slot.State = BreakStates.Ended;
                slot.CanResume = false;
            }
        }
        breaks.ActiveBreak = null;
        breaks.Active = null;
    }

    private static void EndMeeting(MeetingRecord m, DateTimeOffset at)
    {
        m.InProgress = false;
        m.EndedAt = at;
        m.DurationSec = (int)Math.Max(0, (at - m.StartedAt).TotalSeconds);
    }

    /// <summary>
    /// The cached shift's breaks on another date (offline over midnight): the same local
    /// times, nothing taken yet. Marked estimated; the server's day replaces it.
    /// </summary>
    public static BreakDay RollBreaks(BreakDay day, string toDate)
    {
        var copy = Clone(day)!;
        var days = BusinessClock.DaysBetween(day.Date, toDate);
        var shift = TimeSpan.FromDays(days);
        foreach (var slot in copy.Breaks)
        {
            slot.ScheduledStart += shift;
            slot.ScheduledEnd += shift;
            slot.WindowOpen += shift;
            slot.WindowClose += shift;
            slot.RingStart += shift;
            slot.RingEnd += shift;
            slot.Record = null;
            slot.State = null;
            slot.TakenSec = null;
            slot.RemainingSec = null;
            slot.CanResume = false;
            slot.ResumeUntil = null;
            slot.Segments = new List<BreakSegment>();
        }
        copy.Date = toDate;
        copy.DayEnded = false;
        copy.ActiveBreak = null;
        copy.Active = null;
        copy.Quick = new List<QuickBreakView>();
        copy.Unscheduled = new List<BreakRecord>();
        copy.Estimated = true;
        return copy;
    }

    private static WorkdayToday NewDay(WorkdayToday? from, string date, string State, DateTimeOffset? startedAt = null)
    {
        var lastEnded = from is { IsEnded: true, EndedAt: { } ended }
            ? new LastEndedView { Date = from.Date, EndedAt = ended, FocusSec = from.Focus.FocusSec }
            : from?.LastEnded;
        var open = State == WorkdayStates.Open;
        return new WorkdayToday
        {
            Date = date,
            ServerNow = startedAt ?? from?.ServerNow ?? default,
            Timezone = from?.Timezone ?? "",
            State = State,
            StartedAt = open ? startedAt : null,
            Sessions = open && startedAt is { } s ? new List<WorkSessionView> { new() { StartedAt = s } } : new List<WorkSessionView>(),
            Focus = new FocusView { FocusSec = 0, Running = open },
            Shift = from?.Shift,
            ExpectedSec = from?.ExpectedSec ?? 0,
            TargetSec = from?.TargetSec,
            Settings = from?.Settings ?? new WorkdaySettings(),
            PortalUrl = from?.PortalUrl,
            Config = from?.Config,
            SkipsNeedingComment = from?.SkipsNeedingComment.Where(x => x.Date != date).ToList() ?? new List<SkipNeedingComment>(),
            LastEnded = open ? null : lastEnded,
            OverdueApprovals = from?.OverdueApprovals ?? 0,
            EndDayBlockedByOverdue = from?.EndDayBlockedByOverdue ?? false,
            Allowance = from?.Allowance is { } a ? new AllowanceView { ScheduledSec = a.ScheduledSec, BufferSec = a.BufferSec, TotalSec = a.TotalSec } : null,
        };
    }

    private static bool IsEarlier(string? date, string today) =>
        !string.IsNullOrEmpty(date) && !string.IsNullOrEmpty(today) && string.CompareOrdinal(date, today) < 0;

    /// <summary>
    /// The id of what an action created: the server's once it took the action (so the day
    /// shows the ids the server has before its next answer is read), else the local one.
    /// </summary>
    private static string Created(EventPayload p, JournalEvent e, Func<string?, string?> resolve) =>
        p.LocalId is { } local && resolve(local) is { Length: > 0 } server && !OfflineDay.IsLocalId(server) ? server : p.LocalId ?? e.Id;

    private static bool Same(string? a, string? b, Func<string?, string?> resolve) =>
        a is not null && b is not null && (a == b || (resolve(a) is { Length: > 0 } ra && ra == resolve(b)));

    // ---- Allowance and totals ------------------------------------------------------------------

    /// <summary>
    /// The paid allowance as of <paramref name="now"/> (SPEC 2.4): scheduled breaks are paid
    /// up to their length; minutes over them, quick breaks and plain breaks use the
    /// buffer; the rest is unpaid.
    /// </summary>
    public static AllowanceNow Allowance(WorkdayToday? workday, BreakDay? breaks, DateTimeOffset now)
    {
        var scheduled = workday?.Allowance is { ScheduledSec: > 0 } a ? a.ScheduledSec
            : breaks is { Scheduled: true } ? breaks.Breaks.Sum(s => Math.Max(0, s.DurationMin) * 60)
            : 0;
        var buffer = workday?.Allowance is { } al && (al.BufferSec > 0 || al.TotalSec > 0) ? al.BufferSec
            : (workday?.Config?.BreakBufferMin ?? 10) * 60;
        if (breaks is null) return new AllowanceNow(scheduled, buffer, 0, 0, 0, 0);

        int paidScheduled = 0, overrun = 0, quick = 0, other = 0, all = 0;
        foreach (var slot in breaks.Breaks)
        {
            if (slot.Record is not { } r || r.IsSkip) continue;
            var taken = TakenOf(r, now);
            var length = Math.Max(0, slot.DurationMin) * 60;
            paidScheduled += Math.Min(taken, length);
            overrun += Math.Max(0, taken - length);
            all += taken;
        }
        foreach (var q in breaks.Quick)
        {
            var taken = QuickTaken(q, now);
            quick += taken;
            all += taken;
        }
        foreach (var u in breaks.Unscheduled.Concat(breaks.ActiveBreak is { Kind: null } free && breaks.Unscheduled.All(x => x.Id != free.Id) ? new[] { free } : Array.Empty<BreakRecord>()))
        {
            var taken = TakenOf(u, now);
            other += taken;
            all += taken;
        }
        var bufferUsed = Math.Min(buffer, overrun + quick + other);
        var paid = paidScheduled + bufferUsed;
        return new AllowanceNow(scheduled, buffer, paid, bufferUsed, Math.Max(0, all - paid), all);
    }

    /// <summary>Break, lunch and meeting time taken today, as of <paramref name="now"/>.</summary>
    public static TakenTotals Totals(BreakDay? breaks, IReadOnlyList<MeetingRecord> meetings, DateTimeOffset now)
    {
        int brk = 0, lunch = 0, quick = 0;
        if (breaks is not null)
        {
            foreach (var r in AllBreakRecords(breaks))
            {
                var taken = TakenOf(r, now);
                if (r.PresenceType == PresenceStatus.Lunch) lunch += taken;
                else brk += taken;
            }
            foreach (var q in breaks.Quick)
            {
                var taken = QuickTaken(q, now);
                quick += taken;
                brk += taken;
            }
        }
        var meetingSec = meetings.Sum(m => m.InProgress ? (int)Math.Max(0, (now - m.StartedAt).TotalSeconds) : Math.Max(0, m.DurationSec));
        return new TakenTotals(brk, lunch, meetingSec, quick);
    }

    // ---- Plumbing --------------------------------------------------------------------------

    public static T? Clone<T>(T? value) where T : class =>
        value is null ? null : JsonSerializer.Deserialize<T>(JsonSerializer.SerializeToUtf8Bytes(value, Json.Options), Json.Options);
}
