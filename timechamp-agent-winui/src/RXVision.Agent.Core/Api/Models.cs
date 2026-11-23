using System.Text.Json.Serialization;

namespace RXVision.Agent.Core.Api;

// All request/response shapes the agent uses. Field names follow the API
// (see backend/docs/shift-breaks-api.md); unknown fields are ignored, so a newer
// server never breaks an older agent.

// ---- Auth ---------------------------------------------------------------------

public sealed class PublicUser
{
    public string Id { get; set; } = "";
    public string Email { get; set; } = "";
    public string? FirstName { get; set; }
    public string? LastName { get; set; }
    public string? Role { get; set; }
    public string? Department { get; set; }
    public string? ManagerId { get; set; }
    public bool ScreenshotsEnabled { get; set; } = true;

    [JsonIgnore]
    public string DisplayName
    {
        get
        {
            var n = string.Join(" ", new[] { FirstName, LastName }.Where(s => !string.IsNullOrWhiteSpace(s)));
            return n.Length > 0 ? n : Email;
        }
    }

    [JsonIgnore] public bool IsManager => Role is "MANAGER" or "SUPER_ADMIN";
}

public sealed class AuthResponse
{
    public PublicUser? User { get; set; }
}

// ---- Presence -----------------------------------------------------------------

public static class PresenceStatus
{
    public const string Working = "WORKING";
    public const string Break = "BREAK";
    public const string Lunch = "LUNCH";
    public const string Meeting = "MEETING";
    public const string DayEnded = "DAY_ENDED";
    /// <summary>No work session open and none today (3.1).</summary>
    public const string NotStarted = "NOT_STARTED";
}

public sealed class CurrentPresence
{
    public string Status { get; set; } = PresenceStatus.Working;
    public string? SessionId { get; set; }
    public string? Note { get; set; }
    public DateTimeOffset? Since { get; set; }
    public int ElapsedSec { get; set; }
}

public sealed class PresenceTotals
{
    public int BreakSec { get; set; }
    public int LunchSec { get; set; }
    public int MeetingSec { get; set; }
    public int OnlineSec { get; set; }
    public int IdleSec { get; set; }
}

public sealed class PresenceToday
{
    public string Date { get; set; } = "";
    public CurrentPresence? Current { get; set; }
    public PresenceTotals Totals { get; set; } = new();
}

// ---- Activity -----------------------------------------------------------------

/// <summary>One sample for POST /activity/report. Lengths are capped before sending.</summary>
public sealed class ActivityReport
{
    public const int MaxApp = 200;
    public const int MaxTitle = 500;
    public const int MaxUrl = 255;

    public string At { get; set; } = "";
    public bool Idle { get; set; }
    public bool Locked { get; set; }
    public string? App { get; set; }
    public string? Title { get; set; }
    public string? Url { get; set; }

    /// <summary>What kind of sample this is (live, sleep, away); kept locally for logs only.</summary>
    [JsonIgnore] public string Kind { get; set; } = "live";

    public ActivityReport Truncated()
    {
        App = Cap(App, MaxApp);
        Title = Cap(Title, MaxTitle);
        Url = Cap(Url, MaxUrl);
        return this;
    }

    private static string? Cap(string? value, int max)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        value = value.Trim();
        if (value.Length <= max) return value;
        // Never split a surrogate pair.
        var cut = max;
        if (char.IsHighSurrogate(value[cut - 1])) cut--;
        return value[..cut];
    }
}

public sealed class ActivityAck
{
    public int ActiveSec { get; set; }
    public int WorkingBasisSec { get; set; }
    public int RemainingSec { get; set; }
    public bool ClockedOut { get; set; }
    public bool DayEnded { get; set; }
    /// <summary>False only once the day was ended. Defaults to true so a malformed ack never stops tracking.</summary>
    public bool ShouldCapture { get; set; } = true;
    public bool ScreenshotsEnabled { get; set; } = true;
}

public sealed class HourBucket
{
    public int Hour { get; set; }
    public int ActiveSec { get; set; }
    public int IdleSec { get; set; }
}

public sealed class DailyActivity
{
    public string Date { get; set; } = "";
    public int ActiveSec { get; set; }
    public int IdleSec { get; set; }
    public int WorkingBasisSec { get; set; }
    public int RemainingSec { get; set; }
    public bool DayEnded { get; set; }
    public DateTimeOffset? LoginAt { get; set; }
    public List<HourBucket> Hourly { get; set; } = new();
}

// ---- Scheduled breaks ---------------------------------------------------------

public static class BreakKinds
{
    public const string Morning = "MORNING";
    public const string Lunch = "LUNCH";
    public const string Evening = "EVENING";
    /// <summary>A quick break (4.0): any time, 5, 10 or 15 minutes, not scheduled.</summary>
    public const string Quick = "QUICK";
    /// <summary>The scheduled kinds, in the day's order (QUICK is not one of them).</summary>
    public static readonly string[] All = { Morning, Lunch, Evening };
}

/// <summary>A break record's state (4.0): an open segment, paused inside its window, or over.</summary>
public static class BreakStates
{
    public const string Active = "ACTIVE";
    public const string Paused = "PAUSED";
    public const string Ended = "ENDED";
}

/// <summary>One stretch of a break (4.0: a scheduled break can be paused and resumed).</summary>
public sealed class BreakSegment
{
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
}

public sealed class ShiftRules
{
    public int RingLeadMin { get; set; } = 1;
    public int RingDurationMin { get; set; } = 5;
    public bool ReasonOnEarly { get; set; } = true;
    public bool ReasonOnLate { get; set; } = true;
    public int ReasonMinChars { get; set; } = 10;
    public bool OverrunReason { get; set; }
    /// <summary>Minutes over a break's length that need no approval (3.1 default 3).</summary>
    public int OverrunGraceMin { get; set; } = 3;
}

public sealed class ShiftInfo
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Start { get; set; } = "";
    public string End { get; set; } = "";
    public ShiftRules Rules { get; set; } = new();
}

public sealed class BreakLocalTimes
{
    public string Start { get; set; } = "";
    public string End { get; set; } = "";
    public string WindowOpen { get; set; } = "";
    public string WindowClose { get; set; } = "";
    public string RingStart { get; set; } = "";
    public string RingEnd { get; set; } = "";
}

/// <summary>What a break record says happened (3.1): taken, skipped by the person, or skipped by the server.</summary>
public static class BreakOutcomes
{
    public const string Taken = "TAKEN";
    public const string Skipped = "SKIPPED";
    public const string AutoSkipped = "AUTO_SKIPPED";

    public static bool IsSkip(string? outcome) => outcome is Skipped or AutoSkipped;
}

public sealed class BreakRecord
{
    public string Id { get; set; } = "";
    public string Date { get; set; } = "";
    public string? Kind { get; set; }
    public string Label { get; set; } = "";
    public string PresenceType { get; set; } = "BREAK";
    public string? ShiftName { get; set; }
    public DateTimeOffset? ScheduledStart { get; set; }
    public int? DurationMin { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    public bool InProgress { get; set; }
    public int TookSec { get; set; }
    /// <summary>Seconds past the break's length (0 within it, or for a skip; null from the server reads as 0).</summary>
    public int OverrunSec { get; set; }
    /// <summary>ON_TIME, EARLY, LATE, OUTSIDE_WINDOW or UNSCHEDULED.</summary>
    public string Timing { get; set; } = "ON_TIME";
    public int MinutesOff { get; set; }
    public string? Reason { get; set; }
    public string? OverrunReason { get; set; }
    public string Source { get; set; } = "AGENT";
    /// <summary>NOT_REQUIRED, PENDING, APPROVED or REJECTED.</summary>
    public string ApprovalStatus { get; set; } = "NOT_REQUIRED";
    public string? ApproverRole { get; set; }
    public DateTimeOffset? DecidedAt { get; set; }
    public string? DecisionNote { get; set; }
    public string? DecidedByName { get; set; }
    /// <summary>TAKEN, SKIPPED or AUTO_SKIPPED (3.1; an older server sends none: taken).</summary>
    public string? Outcome { get; set; }
    /// <summary>The person asked for the minutes over to count (3.1).</summary>
    public bool OverrunAsked { get; set; }
    public DateTimeOffset? CommentedAt { get; set; }
    public DateTimeOffset? DueAt { get; set; }
    /// <summary>A skip with no reason, still pending: it takes one comment, and End Day waits for it.</summary>
    public bool NeedsComment { get; set; }
    /// <summary>ACTIVE, PAUSED or ENDED (4.0; null from an older server).</summary>
    public string? State { get; set; }
    /// <summary>A quick break's planned length (4.0).</summary>
    public int? PlannedMin { get; set; }
    /// <summary>Time taken so far, all segments (4.0; null from an older server).</summary>
    public int? TakenSec { get; set; }
    /// <summary>Its stretches (4.0; empty from an older server: StartedAt to EndedAt).</summary>
    public List<BreakSegment> Segments { get; set; } = new();
    /// <summary>What is left of its length (4.0; negative when over).</summary>
    public int? RemainingSec { get; set; }
    /// <summary>Paused and its window still open (4.0).</summary>
    public bool CanResume { get; set; }
    public DateTimeOffset? ResumeUntil { get; set; }

    [JsonIgnore] public bool IsSkip => BreakOutcomes.IsSkip(Outcome);
    [JsonIgnore] public bool IsPaused => State == BreakStates.Paused;
    [JsonIgnore] public bool IsAutoSkip => Outcome == BreakOutcomes.AutoSkipped;
}

public sealed class BreakSlot
{
    public string Kind { get; set; } = "";
    public string Label { get; set; } = "";
    public string PresenceType { get; set; } = "BREAK";
    public int DurationMin { get; set; }
    public DateTimeOffset ScheduledStart { get; set; }
    public DateTimeOffset ScheduledEnd { get; set; }
    public DateTimeOffset WindowOpen { get; set; }
    public DateTimeOffset WindowClose { get; set; }
    public DateTimeOffset RingStart { get; set; }
    public DateTimeOffset RingEnd { get; set; }
    public BreakLocalTimes Local { get; set; } = new();
    /// <summary>The break as taken, skipped or auto-skipped today, or null.</summary>
    public BreakRecord? Record { get; set; }
    /// <summary>The shift lets the person skip this break (3.1; absent from an older server: no).</summary>
    public bool AllowSkip { get; set; }
    /// <summary>ACTIVE, PAUSED or ENDED once started (4.0), else null.</summary>
    public string? State { get; set; }
    /// <summary>Taken so far, all segments (4.0).</summary>
    public int? TakenSec { get; set; }
    /// <summary>What is left of its length (4.0; negative when over).</summary>
    public int? RemainingSec { get; set; }
    /// <summary>Paused and its window still open (4.0).</summary>
    public bool CanResume { get; set; }
    /// <summary>A paused break can be resumed until this (its window's close, 4.0).</summary>
    public DateTimeOffset? ResumeUntil { get; set; }
    public List<BreakSegment> Segments { get; set; } = new();
}

/// <summary>A quick break of today (4.0, GET /breaks/me/today quick[]).</summary>
public sealed class QuickBreakView
{
    public string Id { get; set; } = "";
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    /// <summary>5, 10 or 15 (null: an away break, no planned length).</summary>
    public int? PlannedMin { get; set; }
    public int TakenSec { get; set; }
}

/// <summary>The break running now (4.0, GET /breaks/me/today active).</summary>
public sealed class ActiveBreakInfo
{
    public string Id { get; set; } = "";
    /// <summary>MORNING, LUNCH, EVENING or QUICK.</summary>
    public string? Kind { get; set; }
    public DateTimeOffset SegmentStartedAt { get; set; }
    public int TakenBeforeSec { get; set; }
    public int? PlannedMin { get; set; }
    public int? DurationMin { get; set; }
}

/// <summary>GET /breaks/me/today.</summary>
public sealed class BreakDay
{
    public string Date { get; set; } = "";
    public DateTimeOffset ServerNow { get; set; }
    public string Timezone { get; set; } = "";
    /// <summary>SCHEDULED (follow the slots) or FREE (no schedule today: plain break/lunch).</summary>
    public string Mode { get; set; } = "FREE";
    public bool Workday { get; set; }
    public bool DayEnded { get; set; }
    public ShiftInfo? Shift { get; set; }
    public string Source { get; set; } = "NONE";
    public List<BreakSlot> Breaks { get; set; } = new();
    public List<BreakRecord> Unscheduled { get; set; } = new();
    public BreakRecord? ActiveBreak { get; set; }
    /// <summary>Skips still waiting for a comment, newest first, up to 31 days back (3.1).</summary>
    public List<SkipNeedingComment> SkipsNeedingComment { get; set; } = new();
    /// <summary>The shift's minimum for a reason or comment (3.1; null from an older server).</summary>
    public int? ReasonMinChars { get; set; }
    /// <summary>Today's quick breaks (4.0).</summary>
    public List<QuickBreakView> Quick { get; set; } = new();
    /// <summary>The break running now with its segment (4.0), or null.</summary>
    public ActiveBreakInfo? Active { get; set; }
    /// <summary>A scheduled break paused inside its window (4.0), or null.</summary>
    public BreakRecord? PausedBreak { get; set; }
    /// <summary>The lengths a quick break may have (4.0; 5, 10, 15).</summary>
    public List<int>? QuickBreakMinutes { get; set; }
    /// <summary>Worked out here from the cached shift for a new day while offline (never from the server).</summary>
    public bool Estimated { get; set; }
    /// <summary>The quick answers per comment box, by kind (3.2; see <see cref="PresetKinds"/>), or null from an older server.</summary>
    public Dictionary<string, List<string>>? ReasonPresets { get; set; }

    [JsonIgnore] public bool Scheduled => Mode == "SCHEDULED";
}

public sealed class StartBreakRequest
{
    public string Kind { get; set; } = "";
    public string? Reason { get; set; }
}

public sealed class StartBreakResult
{
    public BreakRecord Record { get; set; } = new();
    public CurrentPresence? Presence { get; set; }
}

public sealed class EndBreakRequest
{
    public string? OverrunReason { get; set; }
    /// <summary>True: ask the approver to count the minutes over; false: leave them out; null: not asked (older agents).</summary>
    public bool? AskToCount { get; set; }
}

/// <summary>POST /breaks/skip.</summary>
public sealed class SkipBreakRequest
{
    public string Kind { get; set; } = "";
    public string? Reason { get; set; }
}

/// <summary>POST /breaks/:id/comment.</summary>
public sealed class BreakCommentRequest
{
    public string Comment { get; set; } = "";
}

/// <summary>{ record } from POST /breaks/skip and POST /breaks/:id/comment.</summary>
public sealed class BreakRecordResult
{
    public BreakRecord? Record { get; set; }
}

public sealed class EndBreakResult
{
    public bool Ended { get; set; }
    public BreakRecord? Record { get; set; }
}

public sealed class BreakHistory
{
    public string From { get; set; } = "";
    public string To { get; set; } = "";
    public List<BreakRecord> Items { get; set; } = new();
}

// ---- Work day (3.1) -----------------------------------------------------------

public static class WorkdayStates
{
    public const string NotStarted = "NOT_STARTED";
    public const string Open = "OPEN";
    public const string Ended = "ENDED";
}

public sealed class WorkSessionView
{
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    /// <summary>USER, AUTO_CLOSED, or null while open.</summary>
    public string? EndReason { get; set; }
}

/// <summary>Focus time as of the answer's serverNow (see SPEC 1.3).</summary>
public sealed class FocusView
{
    public int FocusSec { get; set; }
    /// <summary>The day is open and the person is not on a break or lunch (meetings count): focus is ticking.</summary>
    public bool Running { get; set; }
    public int SpanSec { get; set; }
    public int BreakSec { get; set; }
    public int MeetingSec { get; set; }
    public int ApprovedPlusSec { get; set; }
    public int PendingPlusSec { get; set; }
    public int RejectedMinusSec { get; set; }
    public int PendingMinusSec { get; set; }
    // ---- 4.0 (SPEC 2.4): absent from a 3.1 server (read as 0 and null)
    public int PaidBreakSec { get; set; }
    public int UnpaidBreakSec { get; set; }
    /// <summary>
    /// Time in sessions an offline replay opened that the agent's activity samples do not
    /// cover (yet): not focus, not paid ("Offline, no activity data"). It counts once the
    /// samples for it reach the server.
    /// </summary>
    public int UnverifiedSec { get; set; }
    /// <summary>Payroll time, focusSec + paidBreakSec ("Paid time"); null from a 3.1 server.</summary>
    public int? PaidSec { get; set; }
    /// <summary>3.3: focus seconds a Super Manager added (+) or took off (−) by hand, already inside FocusSec; 0 from an older server.</summary>
    public int AdjustedSec { get; set; }
}

/// <summary>A first Start Day after the grace (3.2): how far past it, and whether a reason is still wanted.</summary>
public sealed class LateStartView
{
    public int Minutes { get; set; }
    public int GraceMin { get; set; }
    public string? Reason { get; set; }
    /// <summary>A reason is asked for and none was given: offer "Add a note".</summary>
    public bool NeedsReason { get; set; }
}

/// <summary>A day off by the calendar (3.2): HOLIDAY (with its name) or WEEKLY_OFF.</summary>
public sealed class DayOffView
{
    public string Kind { get; set; } = "";
    public string? Name { get; set; }
}

/// <summary>Today's leave on the day view (3.4), or null.</summary>
public sealed class LeaveTodayView
{
    public double Days { get; set; }
    public bool Full { get; set; }
    /// <summary>"Half day (first half)".</summary>
    public string Label { get; set; } = "";
    /// <summary>"CL/SL".</summary>
    public string Categories { get; set; } = "";
}

/// <summary>Work from home on the day view (3.5), or null. Agent staff only read the label.</summary>
public sealed class WfhTodayView
{
    /// <summary>"Full day", "Half day (first half)" or "Waiting for approval".</summary>
    public string Label { get; set; } = "";
}

/// <summary>How the person's attendance is taken (3.5).</summary>
public static class AttendanceSources
{
    public const string Agent = "AGENT";
    public const string Biometric = "BIOMETRIC";
}

public sealed class AttendanceView
{
    /// <summary>AGENT or BIOMETRIC.</summary>
    public string Source { get; set; } = AttendanceSources.Agent;
}

/// <summary>The kinds of quick answers (reasonPresets on GET /breaks/me/today, 3.2).</summary>
public static class PresetKinds
{
    public const string LateDayStart = "LATE_DAY_START";
    public const string BreakEarly = "BREAK_EARLY";
    public const string BreakLate = "BREAK_LATE";
    public const string BreakSkip = "BREAK_SKIP";
    public const string SkipComment = "SKIP_COMMENT";
    public const string BreakOverrun = "BREAK_OVERRUN";
    public const string MeetingAgenda = "MEETING_AGENDA";
    public const string LeaveReason = "LEAVE_REASON";
}

public sealed class ShiftRef
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Start { get; set; } = "";
    public string End { get; set; } = "";
}

/// <summary>A skip (manual or automatic) with no reason yet, still pending: End Day waits for its comment.</summary>
public sealed class SkipNeedingComment
{
    public string Id { get; set; } = "";
    public string Date { get; set; } = "";
    public string Kind { get; set; } = "";
    public string Label { get; set; } = "";
    /// <summary>SKIPPED or AUTO_SKIPPED.</summary>
    public string Outcome { get; set; } = BreakOutcomes.AutoSkipped;
    public DateTimeOffset SkippedAt { get; set; }
    public DateTimeOffset? ScheduledStart { get; set; }
    public int? DurationMin { get; set; }
    public int MinChars { get; set; } = 10;
}

public sealed class WorkdaySettings
{
    public int ApprovalSlaHours { get; set; } = 48;
    public int ReasonMinChars { get; set; } = 10;
    /// <summary>Minutes after the shift start before a first Start Day is late (3.2).</summary>
    public int LateStartGraceMin { get; set; }
    /// <summary>A late first start asks why (3.2; the organisation's setting).</summary>
    public bool RequireLateStartReason { get; set; }
}

/// <summary>GET /workday/me/today: the day's state, focus time and what End Day will ask for.</summary>
public sealed class WorkdayToday
{
    public string Date { get; set; } = "";
    public DateTimeOffset ServerNow { get; set; }
    public string Timezone { get; set; } = "";
    /// <summary>NOT_STARTED, OPEN or ENDED (see <see cref="WorkdayStates"/>).</summary>
    public string State { get; set; } = WorkdayStates.NotStarted;
    /// <summary>The first session's start today.</summary>
    public DateTimeOffset? StartedAt { get; set; }
    /// <summary>The last session's end, when ENDED.</summary>
    public DateTimeOffset? EndedAt { get; set; }
    /// <summary>The last session today was closed by the server (a missed End Day).</summary>
    public bool AutoClosed { get; set; }
    public List<WorkSessionView> Sessions { get; set; } = new();
    public FocusView Focus { get; set; } = new();
    public LateStartView? LateStart { get; set; }
    public ShiftRef? Shift { get; set; }
    public int ExpectedSec { get; set; }
    public List<SkipNeedingComment> SkipsNeedingComment { get; set; } = new();
    /// <summary>Managers and Super Admins: items routed to them past their due time.</summary>
    public int OverdueApprovals { get; set; }
    public bool EndDayBlockedByOverdue { get; set; }
    public WorkdaySettings Settings { get; set; } = new();
    /// <summary>The portal's address (for "Open approvals"), or null when the server does not know it.</summary>
    public string? PortalUrl { get; set; }
    /// <summary>
    /// While today is NOT_STARTED: the working day that ended within the last 12 hours
    /// (after midnight, or after a night shift), with its focus time; else null.
    /// </summary>
    public LastEndedView? LastEnded { get; set; }
    /// <summary>4.0: the input-tracking (away) settings, quick-break lengths and the paid buffer.</summary>
    public WorkdayConfig? Config { get; set; }
    /// <summary>4.0: today's paid break allowance and what is used of it.</summary>
    public AllowanceView? Allowance { get; set; }
    /// <summary>4.0: today's focus target (shift minus the allowance; 0 on a non-working day).</summary>
    public int? TargetSec { get; set; }
    public bool? IsWorkingDay { get; set; }
    /// <summary>A holiday's name or the day's label from the calendar (4.0).</summary>
    public string? DayLabel { get; set; }
    /// <summary>4.0: away time waiting for approval and away time never explained.</summary>
    public AwayTotals? Away { get; set; }
    /// <summary>A day off by the calendar (3.2), or null on a working day.</summary>
    public DayOffView? DayOff { get; set; }
    /// <summary>Approved leave today (3.4), or null.</summary>
    public LeaveTodayView? Leave { get; set; }
    /// <summary>Part-day leave: when the working part starts (the late-start mark moves to it), else null.</summary>
    public DateTimeOffset? WorkingFrom { get; set; }
    /// <summary>How attendance is taken (3.5): the agent, or the biometric device.</summary>
    public AttendanceView? Attendance { get; set; }
    /// <summary>Work from home today (3.5), or null.</summary>
    public WfhTodayView? Wfh { get; set; }
    /// <summary>Biometric staff: the day was closed with no check-out punch (3.5).</summary>
    public bool CheckoutMissing { get; set; }

    [JsonIgnore] public bool IsBiometric => Attendance?.Source == AttendanceSources.Biometric;
    [JsonIgnore] public bool IsOpen => State == WorkdayStates.Open;
    [JsonIgnore] public bool IsEnded => State == WorkdayStates.Ended;
    [JsonIgnore] public bool IsNotStarted => State is not (WorkdayStates.Open or WorkdayStates.Ended);
}

/// <summary>4.0: GET /workday/me/today config.</summary>
public sealed class WorkdayConfig
{
    public IdleConfig Idle { get; set; } = new();
    public List<int> QuickBreakMinutes { get; set; } = new() { 5, 10, 15 };
    public int BreakBufferMin { get; set; } = 10;
    // ---- 4.1 shared computer (absent from a 4.0 server: off) ----
    /// <summary>The person's department shares one computer between shifts.</summary>
    public bool SharedComputer { get; set; }
    /// <summary>Today's shift end, or null with no shift or on a day off.</summary>
    public DateTimeOffset? ShiftEndAt { get; set; }
    /// <summary>The open day was carried on into the next shift (no more questions today).</summary>
    public bool Extended { get; set; }
}

/// <summary>The effective input-tracking (away) setting for this person (4.0, SPEC 2.5).</summary>
public sealed class IdleConfig
{
    public bool Enabled { get; set; }
    public int Minutes { get; set; } = 5;
    public List<AwayReason> Reasons { get; set; } = new();
}

/// <summary>A reason the away pop-up offers.</summary>
public sealed class AwayReason
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    /// <summary>BREAK, THINKING, MEETING, HARDWARE, OTHER or CUSTOM.</summary>
    public string Kind { get; set; } = "";
    /// <summary>The fields it asks for (the agent knows them by kind; the server may list them).</summary>
    public List<string> Fields { get; set; } = new();
}

public static class AwayKinds
{
    public const string Break = "BREAK";
    public const string Thinking = "THINKING";
    public const string Meeting = "MEETING";
    public const string Hardware = "HARDWARE";
    public const string Other = "OTHER";
    public const string Custom = "CUSTOM";

    /// <summary>The 4.0 built-ins with their default labels (SPEC 2.5), for when the server sent none.</summary>
    public static List<AwayReason> Defaults() => new()
    {
        new() { Key = Break, Label = "Took a break", Kind = Break },
        new() { Key = Thinking, Label = "Thinking", Kind = Thinking },
        new() { Key = Meeting, Label = "Short meeting", Kind = Meeting },
        new() { Key = Other, Label = "Other work", Kind = Other },
    };
}

/// <summary>4.0: the paid break allowance (SPEC 2.4).</summary>
public sealed class AllowanceView
{
    public int ScheduledSec { get; set; }
    public int BufferSec { get; set; }
    public int TotalSec { get; set; }
    public int PaidUsedSec { get; set; }
    public int BufferUsedSec { get; set; }
    public int UnpaidSec { get; set; }
}

public sealed class AwayTotals
{
    public int PendingSec { get; set; }
    public int UnexplainedSec { get; set; }
}

/// <summary>The working day that ended last (WorkdayToday.LastEnded).</summary>
public sealed class LastEndedView
{
    public string Date { get; set; } = "";
    public DateTimeOffset EndedAt { get; set; }
    public int FocusSec { get; set; }
}

/// <summary>POST /activity/start-day. StartedAt (ISO-8601 UTC) only on a retry: the time Start Day was pressed.</summary>
public sealed class StartDayRequest
{
    public string? StartedAt { get; set; }
    /// <summary>Why the first start comes after the shift start plus the grace (3.2; 4.1 agents send it).</summary>
    public string? LateReason { get; set; }
}

/// <summary>POST /workday/me/late-reason: the note for a late start already made.</summary>
public sealed class LateReasonRequest
{
    public string Reason { get; set; } = "";
}

public sealed class StartDayResult
{
    public bool Ok { get; set; }
    public string Date { get; set; } = "";
    /// <summary>A second session on the same day (Start Day after an End Day).</summary>
    public bool Resumed { get; set; }
    public WorkdayToday? Workday { get; set; }
}

/// <summary>One comment for a skipped break, sent with End Day.</summary>
public sealed class SkipComment
{
    public SkipComment() { }

    public SkipComment(string breakId, string comment)
    {
        BreakId = breakId;
        Comment = comment;
    }

    public string BreakId { get; set; } = "";
    public string Comment { get; set; } = "";
}

/// <summary>POST /activity/end-day.</summary>
public sealed class EndDayRequest
{
    public List<SkipComment>? Comments { get; set; }
}

public sealed class EndDayResult
{
    public bool Ok { get; set; }
    public string Date { get; set; } = "";
    public DateTimeOffset? EndedAt { get; set; }
    public WorkdayToday? Workday { get; set; }
}

// ---- Meetings (3.1) -----------------------------------------------------------

public static class MeetingModes
{
    public const string Live = "LIVE";
    public const string Past = "PAST";
}

/// <summary>Someone in a meeting: a person in the company (with an id) or a free name.</summary>
public sealed class MeetingParticipant
{
    public MeetingParticipant() { }

    public MeetingParticipant(string? id, string name)
    {
        Id = id;
        Name = name;
    }

    public string? Id { get; set; }
    public string Name { get; set; } = "";
}

public sealed class MeetingRecord
{
    public string Id { get; set; } = "";
    public string Date { get; set; } = "";
    /// <summary>LIVE or PAST.</summary>
    public string Mode { get; set; } = MeetingModes.Live;
    public string Agenda { get; set; } = "";
    public List<MeetingParticipant> Participants { get; set; } = new();
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    public bool InProgress { get; set; }
    /// <summary>Live seconds while in progress, else the length.</summary>
    public int DurationSec { get; set; }
    public string ApprovalStatus { get; set; } = "PENDING";
    public DateTimeOffset? DueAt { get; set; }
    public DateTimeOffset? DecidedAt { get; set; }
    public string? DecisionNote { get; set; }
    public string? DecidedByName { get; set; }
    /// <summary>Who will mail the minutes (4.0).</summary>
    public string? MomSender { get; set; }
    /// <summary>STATUS for In a meeting (3.6); anything else was declared with an agenda.</summary>
    public string? Kind { get; set; }
    /// <summary>Why a status meeting ended: USER, BREAK, END_DAY, NO_ANSWER or AUTO_CLOSED.</summary>
    public string? EndReason { get; set; }
    public bool IsStatus => Kind == MeetingKinds.Status;
}

/// <summary>What a meeting is: In a meeting from the status routes (3.6), or declared with an agenda.</summary>
public static class MeetingKinds
{
    public const string Status = "STATUS";
}

public sealed class StartMeetingRequest
{
    public string Agenda { get; set; } = "";
    public List<MeetingParticipant> Participants { get; set; } = new();
    /// <summary>Who will mail the minutes (4.0: required from a 4.0 agent, 2..80 characters).</summary>
    public string? MomSender { get; set; }
}

public sealed class StartMeetingResult
{
    public MeetingRecord? Meeting { get; set; }
    public CurrentPresence? Presence { get; set; }
}

public sealed class EndMeetingResult
{
    public MeetingRecord? Meeting { get; set; }
    /// <summary>A live meeting under a minute is not kept.</summary>
    public bool Discarded { get; set; }
}

/// <summary>POST /meetings/past. StartedAt is ISO-8601 UTC.</summary>
public sealed class PastMeetingRequest
{
    public string StartedAt { get; set; } = "";
    public int DurationMin { get; set; }
    public string Agenda { get; set; } = "";
    public List<MeetingParticipant> Participants { get; set; } = new();
    public string? MomSender { get; set; }
}

public sealed class MeetingResult
{
    public MeetingRecord? Meeting { get; set; }
}

public sealed class MeetingList
{
    public List<MeetingRecord> Items { get; set; } = new();
}

/// <summary>An active person in the caller's company, from GET /meetings/participants.</summary>
public sealed class ParticipantOption
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string? Department { get; set; }
}

public sealed class ParticipantList
{
    public List<ParticipantOption> Items { get; set; } = new();
}

/// <summary>What a meeting would overlap (details.with of a 422 from POST /meetings/past).</summary>
public sealed class MeetingClash
{
    /// <summary>BREAK, LUNCH or MEETING.</summary>
    public string Kind { get; set; } = "";
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
}

// ---- Approvals (3.1) ------------------------------------------------------------

public sealed class ApprovalEffect
{
    /// <summary>PLUS, MINUS or NONE.</summary>
    public string Mode { get; set; } = "NONE";
    public int Minutes { get; set; }
    /// <summary>Ready to show: "+15 min if approved", "−15 min taken off", "No change to focus time".</summary>
    public string Text { get; set; } = "";
}

/// <summary>One of the caller's own items waiting for (or decided by) their approver.</summary>
public sealed class ApprovalItem
{
    /// <summary>BREAK or MEETING.</summary>
    public string Type { get; set; } = "";
    public string Id { get; set; } = "";
    public string Category { get; set; } = "";
    public string Date { get; set; } = "";
    public string Title { get; set; } = "";
    public string Detail { get; set; } = "";
    public string? Reason { get; set; }
    public bool NeedsComment { get; set; }
    public List<MeetingParticipant> Participants { get; set; } = new();
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    public bool InProgress { get; set; }
    public int DurationSec { get; set; }
    public ApprovalEffect Effect { get; set; } = new();
    /// <summary>PENDING, APPROVED or REJECTED.</summary>
    public string Status { get; set; } = "PENDING";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? DueAt { get; set; }
    public bool Overdue { get; set; }
    public DateTimeOffset? DecidedAt { get; set; }
    public string? DecidedByName { get; set; }
    public string? DecisionNote { get; set; }

    [JsonIgnore] public bool IsPending => Status == "PENDING";
}

public sealed class ApprovalList
{
    public List<ApprovalItem> Items { get; set; } = new();
}

// ---- Chat ---------------------------------------------------------------------

public sealed class ChatContact
{
    public string UserId { get; set; } = "";
    public string Name { get; set; } = "";
    public string Email { get; set; } = "";
    public string? Role { get; set; }
    public string? Department { get; set; }
    /// <summary>MANAGER (who they report to), REPORT (their staff) or ORG.</summary>
    public string? Relation { get; set; }
}

public sealed class ChatMessage
{
    public string Id { get; set; } = "";
    public string FromUserId { get; set; } = "";
    public string ToUserId { get; set; } = "";
    public string Body { get; set; } = "";
    public bool Mine { get; set; }
    public bool Read { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public sealed class UnreadCount
{
    public int Count { get; set; }
}

// ---- Notifications --------------------------------------------------------------

public sealed class NotificationItem
{
    public string Id { get; set; } = "";
    public string Type { get; set; } = "";
    public string Title { get; set; } = "";
    public string? Body { get; set; }
    public string? FromUserId { get; set; }
    public bool Read { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

// ---- 4.0.1: presigned screenshot upload -----------------------------------------

/// <summary>POST /screenshots/upload-url: where and how to upload one shot to S3.</summary>
public sealed class UploadTicket
{
    public string Key { get; set; } = "";
    public string Url { get; set; } = "";
    public Dictionary<string, string> Fields { get; set; } = new();
    public long MaxBytes { get; set; }
    public int ExpiresIn { get; set; }
}

// ---- Agent updates --------------------------------------------------------------

public sealed class AgentVersionInfo
{
    public string Version { get; set; } = "";
    public string FileName { get; set; } = "";
    public bool Available { get; set; }
    public long SizeBytes { get; set; }
    public string? Sha256 { get; set; }
    public string? Platform { get; set; }
}

// ---- 4.0: quick breaks, away, history, sign-out keys ------------------------------

/// <summary>POST /breaks/quick/start.</summary>
public sealed class QuickBreakRequest
{
    public int PlannedMin { get; set; }
}

/// <summary>POST /away: why the person was away (SPEC 2.5).</summary>
public sealed class AwayRequest
{
    public string StartedAt { get; set; } = "";
    public string ReasonKey { get; set; } = "";
    public string? Comment { get; set; }
    public List<MeetingParticipant>? Participants { get; set; }
    public string? MomSender { get; set; }
}

/// <summary>An away stretch as the server keeps it (POST /away answers; details.existing of 409 AWAY_OVERLAP).</summary>
public sealed class AwayEntry
{
    public string Id { get; set; } = "";
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    public string? ReasonKey { get; set; }
    public string? Status { get; set; }
}

/// <summary>POST /away/unexplained: away with no answer (End Day with the pop-up open).</summary>
public sealed class AwayUnexplainedRequest
{
    public string StartedAt { get; set; } = "";
    public string EndedAt { get; set; } = "";
}

/// <summary>POST /agent/sign-out and /agent/quit-check.</summary>
public sealed class SignOutKeyRequest
{
    public string Key { get; set; } = "";
}

/// <summary>GET /features: each release flag, true or false. A flag reads off until the server says it is on.</summary>
public sealed class FeatureFlags
{
    public Dictionary<string, bool> Flags { get; set; } = new();

    public bool On(string name) => Flags.TryGetValue(name, out var on) && on;
}

/// <summary>The release flags the agent reads (src/shared/features/feature-flags.ts on the API).</summary>
public static class FeatureNames
{
    /// <summary>2.7 Data handling: the monitoring notice adds its sentence about retention and AI exclusions.</summary>
    public const string DataHandling = "dataHandling";
    /// <summary>The redesigned (calm) desktop agent.</summary>
    public const string AgentCalmUi = "agentCalmUi";
    /// <summary>2.1 Messaging.</summary>
    public const string Messaging = "messaging";
}

/// <summary>GET /workday/me/history?month=YYYY-MM (SPEC 5.6).</summary>
public sealed class HistoryMonth
{
    public string Month { get; set; } = "";
    public bool IsCurrent { get; set; }
    public int WorkingDays { get; set; }
    public int TargetSec { get; set; }
    public int FocusSec { get; set; }
    public int PaidBreakSec { get; set; }
    public int UnpaidBreakSec { get; set; }
    public int MeetingsSec { get; set; }
    public int PendingSec { get; set; }
    public int ProjectedSec { get; set; }
    /// <summary>Offline time with no activity data (not focus, not paid).</summary>
    public int UnverifiedSec { get; set; }
    /// <summary>Payroll time, focus + paid breaks; null from a server before it (then worked out).</summary>
    public int? PaidSec { get; set; }
    /// <summary>"Paid time": the server's, else focus + paid breaks (as the server reads a month locked before it).</summary>
    [JsonIgnore] public int Paid => PaidSec ?? FocusSec + PaidBreakSec;
    public List<HistoryDay> Days { get; set; } = new();
    public List<HistoryMeeting> Meetings { get; set; } = new();
    public List<HistoryAway> Away { get; set; } = new();
}

public static class DayStatuses
{
    public const string Full = "FULL";
    public const string Half = "HALF";
    public const string Absent = "ABSENT";
    public const string Off = "OFF";
    public const string Extra = "EXTRA";
    public const string InProgress = "IN_PROGRESS";
    public const string Upcoming = "UPCOMING";
}

public sealed class HistoryDay
{
    public string Date { get; set; } = "";
    /// <summary>The 4.0 server sends 1 (Monday) to 7 (Sunday); kept as text either way.</summary>
    [JsonConverter(typeof(TextOrNumberConverter))]
    public string? Weekday { get; set; }
    public bool IsWorkingDay { get; set; }
    public string? Label { get; set; }
    /// <summary>FULL, HALF, ABSENT, OFF, EXTRA, IN_PROGRESS or UPCOMING.</summary>
    public string Status { get; set; } = "";
    public DateTimeOffset? StartedAt { get; set; }
    public DateTimeOffset? EndedAt { get; set; }
    public int FocusSec { get; set; }
    public int TargetSec { get; set; }
    public int BreakSec { get; set; }
    public int PaidBreakSec { get; set; }
    public int UnpaidBreakSec { get; set; }
    public int Meetings { get; set; }
    public int MeetingsSec { get; set; }
    public int PendingSec { get; set; }
    public int ApprovedAwaySec { get; set; }
    /// <summary>Offline time with no activity data (not focus, not paid).</summary>
    public int UnverifiedSec { get; set; }
    /// <summary>Payroll time, focus + paid breaks; null from a server before it (then worked out).</summary>
    public int? PaidSec { get; set; }
    /// <summary>"Paid time": the server's, else focus + paid breaks.</summary>
    [JsonIgnore] public int Paid => PaidSec ?? FocusSec + PaidBreakSec;
}

public sealed class HistoryMeeting
{
    public string Date { get; set; } = "";
    public DateTimeOffset StartedAt { get; set; }
    public int DurationSec { get; set; }
    public string Agenda { get; set; } = "";
    public List<MeetingParticipant> Participants { get; set; } = new();
    public string? MomSender { get; set; }
    public string Status { get; set; } = "";
}

public sealed class HistoryAway
{
    public string Date { get; set; } = "";
    public DateTimeOffset StartedAt { get; set; }
    public int Seconds { get; set; }
    public string? Reason { get; set; }
    public string? Comment { get; set; }
    public string Status { get; set; } = "";
}
