using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Offline;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Update;
using RXVision.Agent.Core.Workday;

namespace RXVision.Agent.Services;

/// <summary>
/// What the UI needs from the agent. <see cref="AgentFacade"/> wraps the real
/// <see cref="AgentHost"/>; tests use a fake. Every event is raised on the UI
/// thread, and every method runs the agent's work off the UI thread.
/// </summary>
public interface IAgent
{
    AgentState State { get; }
    PublicUser? User { get; }
    CurrentPresence Presence { get; }
    PresenceTotals Totals { get; }
    /// <summary>Today (focus time, skips to comment, the End Day gates, 4.0 config and allowance), or null before anything is known.</summary>
    WorkdayToday? Workday { get; }
    /// <summary>A day is known (from the server, or kept from an earlier run).</summary>
    bool DayKnown { get; }
    /// <summary>A line for the sign-in window to show once (a saved server this build may not use), or null.</summary>
    string? SignInNotice { get; }
    /// <summary>The sign-in window has shown <see cref="SignInNotice"/>.</summary>
    void SignInNoticeShown();
    /// <summary>The API hosts this build was made for when they are not production alone (a staging or pilot build), else null.</summary>
    string? BuiltForHosts { get; }
    /// <summary>A line to show under the version when this build does not check update signatures (a test build, audit F-01), else null.</summary>
    string? UnsignedUpdatesNote { get; }
    /// <summary>The meeting in progress, if it has a record.</summary>
    MeetingRecord? LiveMeeting { get; }
    /// <summary>The server's last word on the status and the ring (GET /me/day-progress, 3.6), or null before the first answer.</summary>
    DayProgress? DayProgress { get; }
    /// <summary>The cards the meeting feature wants shown (3.6), what needs an answer first.</summary>
    IReadOnlyList<MeetingAlert> MeetingAlerts { get; }
    /// <summary>Time since the last input, restarted at a meeting's 2 hour fallback.</summary>
    TimeSpan IdleFor { get; }
    /// <summary>The monitoring notice waits for an answer; it can sit over a day already running (core review C-R11).</summary>
    bool NoticePending { get; }
    /// <summary>A release flag from GET /features (off until the server says on).</summary>
    bool FeatureOn(string name);
    /// <summary>The person's own items with their approver, pending first.</summary>
    IReadOnlyList<ApprovalItem> MyApprovals { get; }
    string ApiBaseUrl { get; }
    string Version { get; }
    IPlatform Platform { get; }
    AgentOptions Options { get; }
    RingView? Ring { get; }
    int ChatUnread { get; }
    IChat? Chat { get; }
    /// <summary>The break panel as of now (cheap; read it every second while visible).</summary>
    BreakPanel BreakPanel { get; }
    /// <summary>Now, on the server's clock (what breaks and focus time are judged by).</summary>
    DateTimeOffset Now { get; }
    UpdateOffer? PendingUpdate { get; }
    int PendingSamples { get; }
    DateTimeOffset LastSampleSent { get; }

    // ---- 4.0 ----
    /// <summary>Focus time now (the server's number plus what happened since).</summary>
    int FocusSec { get; }
    /// <summary>The paid break allowance as of now (SPEC 2.4).</summary>
    AllowanceNow Allowance { get; }
    /// <summary>Actions waiting for the server.</summary>
    int PendingActions { get; }
    /// <summary>The server answered the last call.</summary>
    bool Online { get; }
    /// <summary>When everything last reached the server, or null.</summary>
    DateTimeOffset? LastSyncAt { get; }
    /// <summary>The away pop-up is open since then (null: closed).</summary>
    DateTimeOffset? AwaySince { get; }
    /// <summary>The away settings for this person (null: none yet).</summary>
    IdleConfig? IdleConfig { get; }

    // ---- 3.2 to 3.5 ----
    /// <summary>The biometric device takes this person's attendance: no day, break or meeting buttons.</summary>
    bool IsBiometric { get; }
    /// <summary>The organisation's quick answers for a comment box (<see cref="PresetKinds"/>); empty when none.</summary>
    IReadOnlyList<string> Presets(string kind);

    /// <summary>"9:05 AM" (12-hour) of an instant in the business time zone (the one the schedule's times are in).</summary>
    string BusinessTime(DateTimeOffset instant);

    /// <summary>The instant at the business time zone's offset (its Hour and Date are the business clock's).</summary>
    DateTimeOffset BusinessLocal(DateTimeOffset instant);

    /// <summary>"yyyy-MM-dd" of an instant in the business time zone (the day it belongs to).</summary>
    string BusinessDate(DateTimeOffset instant);

    event Action<AgentState>? StateChanged;
    event Action<CurrentPresence>? PresenceChanged;
    event Action? BreaksChanged;
    event Action? WorkdayChanged;
    /// <summary>A new day progress: the status, the ring and the 2 hour check's times.</summary>
    event Action? DayProgressChanged;
    /// <summary>The meeting cards changed.</summary>
    event Action? MeetingAlertsChanged;
    /// <summary><see cref="NoticePending"/> changed (UI thread).</summary>
    event Action? NoticePendingChanged;
    event Action? MeetingsChanged;
    event Action? ApprovalsChanged;
    event Action<ChatMessage>? ChatMessageReceived;
    event Action<int>? ChatUnreadChanged;
    event Action<NotificationItem>? NotificationReceived;
    event Action<RingView?>? RingChanged;
    event Action<BreakRecord>? BreakAutoSkipped;
    event Action<AgentNudge>? Nudge;
    /// <summary>An action sent later was refused by the server (said once).</summary>
    event Action<string>? ActionRefused;
    /// <summary>
    /// An End Day done offline was refused for comments on skipped breaks: it waits for them
    /// (<see cref="HeldEndDay"/>), and End Day with its time sends it again.
    /// </summary>
    event Action<HeldEndDay>? EndDayHeld;
    /// <summary>The End Day waiting for comments, or null.</summary>
    HeldEndDay? HeldEndDay { get; }
    /// <summary>The away pop-up opened or closed.</summary>
    event Action? AwayChanged;
    /// <summary>History may have changed (a decision, the calendar).</summary>
    event Action? HistoryChanged;
    /// <summary>The person's leave may have changed (a decision, comp off, a request made here).</summary>
    event Action? LeaveChanged;
    event Action<UpdateOffer>? UpdateAvailable;
    event Action? ExitRequested;
    event Action<string>? SignedOutUnexpectedly;
    /// <summary>4.1 shared computer: "Are you taking the next shift?" is due.</summary>
    event Action<ShiftQuestion>? ShiftEndQuestion;
    /// <summary>4.1 shared computer: signed out at the shift end for the next person.</summary>
    event Action? SignedOutForNextShift;

    Task StartAsync();
    Task<string?> SignInAsync(string email, string password, string? server);
    Task<string?> SignInWithCodeAsync(string code);
    Task AcknowledgeNoticeAsync();
    /// <param name="lateReason">The note for a late first start (after <see cref="StartDayOutcome.NeedsLateReason"/>).</param>
    Task<StartDayOutcome> StartDayAsync(string? lateReason = null);
    /// <summary>"Add a note" for a late start made without one.</summary>
    Task<ApiResult<System.Text.Json.JsonElement>> AddLateReasonAsync(string reason);
    /// <summary>The staff guide, and whether it is fresh from the server (false: the last saved copy, or none).</summary>
    Task<(StaffGuide? Guide, bool Fresh)> GetGuideAsync();
    /// <summary>The person's own year for My calendar.</summary>
    Task<ApiResult<CalendarYear>> GetCalendarAsync(int year);
    Task<ApiResult<MyLeave>> GetMyLeaveAsync();
    Task<ApiResult<LeavePreview>> PreviewLeaveAsync(LeaveRequestBody body);
    Task<ApiResult<LeaveRequest>> RequestLeaveAsync(LeaveRequestBody body);
    Task<ApiResult<LeaveRequest>> CancelLeaveAsync(string requestId);
    /// <param name="at">A held End Day's time: the day ends then. Null: now.</param>
    Task<EndDayOutcome> EndDayAsync(IReadOnlyList<SkipComment>? comments, DateTimeOffset? at = null);
    Task<StartOutcome> TakeBreakAsync(string kind, string? reason);
    Task<StartOutcome> TakeFreeBreakAsync(string presenceType);
    Task<ActionOutcome> QuickBreakAsync(int plannedMin);
    Task<ActionOutcome> PauseBreakAsync();
    Task<ActionOutcome> ResumeBreakAsync();
    Task<SkipOutcome> SkipBreakAsync(string kind, string? reason);
    Task<CommentOutcome> CommentBreakAsync(string breakId, string comment);
    /// <summary>End break (or Meeting ended when no break runs). Confirmed in the UI first.</summary>
    Task<EndOutcome> BackToWorkAsync();
    /// <summary>End meeting: a status meeting through its route (online), a meeting with an agenda through the journal.</summary>
    Task<EndOutcome> EndMeetingAsync();
    /// <summary>Start meeting (3.6): <paramref name="source"/> (<see cref="MeetingSources"/>) is all that travels.</summary>
    Task<MeetingStatusOutcome> StartMeetingStatusAsync(string source);
    /// <summary>Still in it, on the 2 hour check: the 2 hours start again from now.</summary>
    Task<MeetingStatusOutcome> ConfirmMeetingAsync();
    /// <summary>Not now on a suggestion, or the Back to Working card once read.</summary>
    void DismissMeetingAlert(MeetingAlertKind kind);
    /// <summary>The panel closed: the card that only informs has been read.</summary>
    void MeetingPanelClosed();
    /// <summary>A meeting with its agenda, people and minutes sender (4.0, journaled: works offline; goes to the approver).</summary>
    Task<MeetingOutcome> StartMeetingAsync(string agenda, IReadOnlyList<MeetingParticipant> participants, string momSender);
    Task<MeetingOutcome> LogPastMeetingAsync(DateTimeOffset startedAt, int durationMin, string agenda, IReadOnlyList<MeetingParticipant> participants, string momSender);
    Task<AwayOutcome> AnswerAwayAsync(AwayAnswer answer);
    /// <summary>People for the meeting picker; null when the server can't be asked.</summary>
    Task<IReadOnlyList<ParticipantOption>?> SearchParticipantsAsync(string? query);
    /// <summary>The month's history, and whether it is fresh from the server (false: the last saved copy).</summary>
    Task<(HistoryMonth? History, bool Fresh)> GetHistoryAsync(string month);
    /// <summary>Saves the offered update to the Downloads folder (for an app that can't replace itself).</summary>
    Task<ManualDownload> DownloadUpdateAsync();
    Task RefreshPresenceAsync();
    /// <summary>The day, meetings and the waiting list from the server (while the dashboard is open).</summary>
    Task RefreshWorkdayAsync();
    /// <summary>Sends everything waiting, for up to <paramref name="timeout"/>; returns how many actions are left.</summary>
    Task<int> SyncNowAsync(TimeSpan timeout);
    /// <summary>Sign out with an admin's key (after everything was sent).</summary>
    Task<KeyOutcome> SignOutWithKeyAsync(string key);
    /// <summary>An Admin's or Super Admin's quit, with a key.</summary>
    Task<KeyOutcome> QuitCheckAsync(string key);
    /// <summary>4.1 shared computer: "Yes, I'm taking the next shift" (the day carries on).</summary>
    Task<bool> ContinueShiftAsync();
    /// <summary>4.1 shared computer: "No": signed out at the shift end.</summary>
    void DeclineShift();
    void AcknowledgeRing();
    void Shutdown();
}

/// <summary>Chat with the people in your line (see <see cref="Core.Realtime.ChatService"/>).</summary>
public interface IChat
{
    IReadOnlyList<ChatContact> Contacts { get; }
    bool ContactsLoaded { get; }
    ChatContact? DefaultContact { get; }
    string NameOf(string userId);
    Task<bool> LoadContactsAsync();
    /// <summary>Oldest first; null when it could not be loaded. Reading marks the other side's messages read.</summary>
    Task<IReadOnlyList<ChatMessage>?> LoadConversationAsync(string contactId);
    Task<ApiResult<ChatMessage>> SendAsync(string contactId, string body);
    Task RefreshUnreadAsync();
    void BumpUnread();
}

/// <summary>Runs work on the UI thread.</summary>
public interface IUiDispatcher
{
    /// <summary>Queues the action to run on the UI thread (never inline).</summary>
    void Post(Action action);
}
