using RXVision.Agent.Core.Api;

namespace RXVision.Agent.Core.Offline;

/// <summary>What the person did (SPEC 6 "Journal"): every user action after sign-in is one of these.</summary>
public static class EventKinds
{
    public const string StartDay = "START_DAY";
    public const string EndDay = "END_DAY";
    /// <summary>A scheduled break (MORNING, LUNCH, EVENING) started.</summary>
    public const string BreakStart = "BREAK_START";
    /// <summary>A plain break or lunch on a day without a schedule (presence/start).</summary>
    public const string BreakFree = "BREAK_FREE";
    /// <summary>A quick break (4.0): 5, 10 or 15 minutes, any time.</summary>
    public const string BreakQuick = "BREAK_QUICK";
    public const string BreakPause = "BREAK_PAUSE";
    public const string BreakResume = "BREAK_RESUME";
    /// <summary>End break / back to work (also ends a quick, paused or plain break).</summary>
    public const string BreakEnd = "BREAK_END";
    public const string BreakSkip = "BREAK_SKIP";
    public const string BreakComment = "BREAK_COMMENT";
    public const string MeetingStart = "MEETING_START";
    public const string MeetingEnd = "MEETING_END";
    public const string MeetingPast = "MEETING_PAST";
    /// <summary>An answer in the away pop-up (BREAK kind opens a back-dated quick break).</summary>
    public const string Away = "AWAY";
    /// <summary>Away with no answer (End Day with the pop-up open).</summary>
    public const string AwayUnexplained = "AWAY_UNEXPLAINED";
}

/// <summary>
/// One journalled action: <c>{id, kind, at, payload, attempts}</c>. <see cref="At"/> is
/// when the person did it on the server's clock (sent as X-Event-At), <see cref="Id"/>
/// a uuid (sent as X-Client-Event-Id, so a replay is never applied twice), and
/// <see cref="Seq"/> this device's running number for its actions (X-Client-Seq).
/// </summary>
public sealed class JournalEvent
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public long Seq { get; set; }
    public string Kind { get; set; } = "";
    public DateTimeOffset At { get; set; }
    public EventPayload Payload { get; set; } = new();
    /// <summary>Sends tried without an answer (kept in memory; reset on restart).</summary>
    public int Attempts { get; set; }
    /// <summary>PENDING while in the journal; SENT once the server took it (it then waits to show in a fresh day).</summary>
    public string State { get; set; } = EventStates.Pending;

    public override string ToString() => $"{Kind} {Id[..Math.Min(8, Id.Length)]} at {At:HH:mm:ss}Z";
}

public static class EventStates
{
    public const string Pending = "PENDING";
    public const string Sent = "SENT";
}

/// <summary>Everything an action may carry; each kind uses its own few fields.</summary>
public sealed class EventPayload
{
    /// <summary>The id given here to what the action creates (a break, a meeting), until the server's id is known.</summary>
    public string? LocalId { get; set; }
    /// <summary>MORNING, LUNCH, EVENING (scheduled), QUICK.</summary>
    public string? BreakKind { get; set; }
    /// <summary>BREAK or LUNCH (a plain break on a day without a schedule).</summary>
    public string? PresenceType { get; set; }
    /// <summary>The break (or meeting) acted on: a server id, or a local id from an earlier action.</summary>
    public string? TargetId { get; set; }
    /// <summary>An early or late start's reason, or a skip's.</summary>
    public string? Reason { get; set; }
    /// <summary>A skipped break's comment, a meeting's or away answer's one line.</summary>
    public string? Comment { get; set; }
    public int? PlannedMin { get; set; }
    public List<SkipComment>? Comments { get; set; }
    public string? Agenda { get; set; }
    public List<MeetingParticipant>? Participants { get; set; }
    public string? MomSender { get; set; }
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    public int? DurationMin { get; set; }
    /// <summary>The away reason's key, kind and label (as the config said when it was chosen).</summary>
    public string? ReasonKey { get; set; }
    public string? ReasonKind { get; set; }
    public string? ReasonLabel { get; set; }
}
