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
    /// <summary>The meeting in progress, if it has a record.</summary>
    MeetingRecord? LiveMeeting { get; }
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
    Task<StartDayOutcome> StartDayAsync();
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
    Task<EndOutcome> EndMeetingAsync();
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
