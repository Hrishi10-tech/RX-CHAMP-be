namespace RXVision.Agent.Core.Workday;

/// <summary>The five answers of <c>status</c> on GET /me/day-progress (lunch is BREAK).</summary>
public static class DayProgressStatus
{
    public const string NotStarted = "NOT_STARTED";
    public const string Working = "WORKING";
    public const string Meeting = "MEETING";
    public const string Break = "BREAK";
    public const string Ended = "ENDED";
}

/// <summary>
/// GET /me/day-progress, and the answer of POST /meetings/status/start, end and confirm: what
/// the status dot and the ring read, built by the server from the same day as the panel's.
/// </summary>
public sealed class DayProgress
{
    public string Status { get; set; } = DayProgressStatus.NotStarted;
    /// <summary>The working day this answer is about (YYYY-MM-DD, business time).</summary>
    public string Date { get; set; } = "";
    /// <summary>The ring's value: that day's focus time, meetings included.</summary>
    public int WorkedSec { get; set; }
    /// <summary>A full circle: the day's expected time, or 8 h when the shift sets none.</summary>
    public int TargetSec { get; set; }
    public bool TargetFromShift { get; set; }
    /// <summary><see cref="WorkedSec"/> past <see cref="TargetSec"/>; 0 before the target.</summary>
    public int OverSec { get; set; }
    public DateTimeOffset? BreakStartedAt { get; set; }
    /// <summary>Null for a break with no length.</summary>
    public DateTimeOffset? BreakEndsAt { get; set; }
    public DateTimeOffset? MeetingStartedAt { get; set; }
    /// <summary>When to ask "Still in a meeting?". Null for a meeting not started from the status routes.</summary>
    public DateTimeOffset? MeetingPromptAt { get; set; }
    /// <summary>When the server switches back to Working if nobody answers.</summary>
    public DateTimeOffset? MeetingFallbackAt { get; set; }

    public bool InMeeting => Status == DayProgressStatus.Meeting;
}
