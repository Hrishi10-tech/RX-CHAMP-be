using System.Globalization;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Offline;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Realtime;
using RXVision.Agent.Core.Update;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;

namespace RXVision.Agent.Services;

/// <summary>
/// The real agent, as the UI sees it. Core raises its events on background
/// threads; every one is re-raised here on the UI thread, in order. Core's async
/// methods run on the thread pool, so a slow disk, keychain or network call can
/// never freeze a window, and the UI's own continuations come back to the UI
/// thread as usual.
/// </summary>
public sealed class AgentFacade : IAgent, IDisposable
{
    private readonly AgentHost _host;
    private readonly IUiDispatcher _ui;
    private readonly ILog _log;
    private ChatService? _chatSource;
    private ChatAdapter? _chat;
    private readonly AvatarsAdapter _avatars;

    public AgentFacade(AgentHost host, IUiDispatcher ui, ILog log)
    {
        _host = host;
        _ui = ui;
        _log = log;
        _avatars = new AvatarsAdapter(host);
        host.MyAvatarChanged += () => Raise(_avatars.RaiseChanged);
        host.PersonAvatarChanged += (id, avatar) => Raise(() => _avatars.RaisePersonChanged(id, avatar));
        host.StateChanged += s => Raise(() => StateChanged?.Invoke(s));
        host.PresenceChanged += p => Raise(() => PresenceChanged?.Invoke(p));
        host.BreaksChanged += () => Raise(() => BreaksChanged?.Invoke());
        host.WorkdayChanged += () => Raise(() => WorkdayChanged?.Invoke());
        host.DayProgressChanged += () => Raise(() => DayProgressChanged?.Invoke());
        host.MeetingAlertsChanged += () => Raise(() => MeetingAlertsChanged?.Invoke());
        host.NoticePendingChanged += () => Raise(() => NoticePendingChanged?.Invoke());
        host.MeetingsChanged += () => Raise(() => MeetingsChanged?.Invoke());
        host.ApprovalsChanged += () => Raise(() => ApprovalsChanged?.Invoke());
        host.ChatMessageReceived += m => Raise(() => ChatMessageReceived?.Invoke(m));
        host.ChatUnreadChanged += n => Raise(() => ChatUnreadChanged?.Invoke(n));
        host.NotificationReceived += n => Raise(() => NotificationReceived?.Invoke(n));
        host.RingChanged += r => Raise(() => RingChanged?.Invoke(r));
        host.BreakAutoSkipped += r => Raise(() => BreakAutoSkipped?.Invoke(r));
        host.Nudge += n => Raise(() => Nudge?.Invoke(n));
        host.ActionRefused += m => Raise(() => ActionRefused?.Invoke(m));
        host.EndDayHeld += h => Raise(() => EndDayHeld?.Invoke(h));
        host.AwayChanged += () => Raise(() => AwayChanged?.Invoke());
        host.HistoryChanged += () => Raise(() => HistoryChanged?.Invoke());
        host.LeaveChanged += () => Raise(() => LeaveChanged?.Invoke());
        host.UpdateAvailable += o => Raise(() => UpdateAvailable?.Invoke(o));
        host.ExitRequested += () => Raise(() => ExitRequested?.Invoke());
        host.SignedOutUnexpectedly += r => Raise(() => SignedOutUnexpectedly?.Invoke(r));
        host.ShiftEndQuestion += q => Raise(() => ShiftEndQuestion?.Invoke(q));
        host.SignedOutForNextShift += () => Raise(() => SignedOutForNextShift?.Invoke());
    }

    private void Raise(Action action) => _ui.Post(() =>
    {
        try { action(); }
        catch (Exception ex) { _log.Error("ui", "event handler failed", ex); }
    });

    public AgentState State => _host.State;
    public PublicUser? User => _host.User;
    public CurrentPresence Presence => _host.Presence;
    public PresenceTotals Totals => _host.Totals;
    public WorkdayToday? Workday => _host.Workday;
    public bool DayKnown => _host.DayKnown;
    public string? SignInNotice => _host.SignInNotice;
    public void SignInNoticeShown() => _host.SignInNoticeShown();
    public string? BuiltForHosts => AgentOptions.BuiltForProductionOnly ? null : string.Join(", ", AgentOptions.BuiltInHosts);
    public string? UnsignedUpdatesNote => UpdateSignature.UnsignedBuildNote;
    public MeetingRecord? LiveMeeting => _host.LiveMeeting;
    public DayProgress? DayProgress => _host.DayProgress;
    public IReadOnlyList<MeetingAlert> MeetingAlerts => _host.MeetingAlerts;
    public TimeSpan IdleFor => _host.IdleFor;
    public bool NoticePending => _host.NoticePending;
    public bool FeatureOn(string name) => _host.Features.On(name);
    public IReadOnlyList<ApprovalItem> MyApprovals => _host.MyApprovals;
    public string ApiBaseUrl => _host.ApiBaseUrl;
    public string Version => _host.Version;
    public IPlatform Platform => _host.Platform;
    public AgentOptions Options => _host.Options;
    public RingView? Ring => _host.Ring;
    public int ChatUnread => _host.ChatUnread;
    public BreakPanel BreakPanel => _host.BreakPanel;
    public DateTimeOffset Now => _host.Clock.UtcNow;
    public IClock Clock => _host.Clock.Local;
    public UpdateOffer? PendingUpdate => _host.PendingUpdate;
    public int PendingSamples => _host.PendingSamples;
    public DateTimeOffset LastSampleSent => _host.LastSampleSent;
    public int FocusSec => _host.FocusSec;
    public AllowanceNow Allowance => _host.Allowance;
    public int PendingActions => _host.PendingActions;
    public bool Online => _host.Online;
    public DateTimeOffset? LastSyncAt => _host.LastSyncAt;
    public DateTimeOffset? AwaySince => _host.AwaySince;
    public IdleConfig? IdleConfig => _host.IdleConfig;
    public bool IsBiometric => _host.IsBiometric;
    public IReadOnlyList<string> Presets(string kind) => _host.Presets(kind);

    public IAvatars Avatars => _avatars;

    public IChat? Chat
    {
        get
        {
            var source = _host.Chat;
            if (source is null) return null;
            if (!ReferenceEquals(source, _chatSource))
            {
                // A setup code for another server rebuilds the services.
                _chatSource = source;
                _chat = new ChatAdapter(source);
            }
            return _chat;
        }
    }

    public string BusinessTime(DateTimeOffset instant) => Clock12.Format(BusinessLocal(instant));

    public DateTimeOffset BusinessLocal(DateTimeOffset instant) => instant.ToOffset(_host.BusinessOffset(instant));

    public string BusinessDate(DateTimeOffset instant) =>
        BusinessLocal(instant).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public event Action<AgentState>? StateChanged;
    public event Action<CurrentPresence>? PresenceChanged;
    public event Action? BreaksChanged;
    public event Action? WorkdayChanged;
    public event Action? DayProgressChanged;
    public event Action? MeetingAlertsChanged;
    public event Action? NoticePendingChanged;
    public event Action? MeetingsChanged;
    public event Action? ApprovalsChanged;
    public event Action<ChatMessage>? ChatMessageReceived;
    public event Action<int>? ChatUnreadChanged;
    public event Action<NotificationItem>? NotificationReceived;
    public event Action<RingView?>? RingChanged;
    public event Action<BreakRecord>? BreakAutoSkipped;
    public event Action<AgentNudge>? Nudge;
    public event Action<string>? ActionRefused;
    public event Action<HeldEndDay>? EndDayHeld;
    public HeldEndDay? HeldEndDay => _host.HeldEndDay;
    public event Action? AwayChanged;
    public event Action? HistoryChanged;
    public event Action? LeaveChanged;
    public event Action<UpdateOffer>? UpdateAvailable;
    public event Action? ExitRequested;
    public event Action<string>? SignedOutUnexpectedly;
    public event Action<ShiftQuestion>? ShiftEndQuestion;
    public event Action? SignedOutForNextShift;

    public Task StartAsync() => Task.Run(_host.StartAsync);
    public Task<string?> SignInAsync(string email, string password, string? server) => Task.Run(() => _host.SignInAsync(email, password, server));
    public Task<string?> SignInWithCodeAsync(string code) => Task.Run(() => _host.SignInWithCodeAsync(code));
    public Task AcknowledgeNoticeAsync() => Task.Run(_host.AcknowledgeNoticeAsync);
    public Task<StartDayOutcome> StartDayAsync(string? lateReason = null) => Task.Run(() => _host.StartDayAsync(lateReason));
    public Task<ApiResult<System.Text.Json.JsonElement>> AddLateReasonAsync(string reason) => Task.Run(() => _host.AddLateReasonAsync(reason));
    public Task<(StaffGuide? Guide, bool Fresh)> GetGuideAsync() => Task.Run(_host.GetGuideAsync);
    public Task<ApiResult<CalendarYear>> GetCalendarAsync(int year) => Task.Run(() => _host.GetCalendarAsync(year));
    public Task<ApiResult<MyLeave>> GetMyLeaveAsync() => Task.Run(_host.GetMyLeaveAsync);
    public Task<ApiResult<LeavePreview>> PreviewLeaveAsync(LeaveRequestBody body) => Task.Run(() => _host.PreviewLeaveAsync(body));
    public Task<ApiResult<LeaveRequest>> RequestLeaveAsync(LeaveRequestBody body) => Task.Run(() => _host.RequestLeaveAsync(body));
    public Task<ApiResult<LeaveRequest>> CancelLeaveAsync(string requestId) => Task.Run(() => _host.CancelLeaveAsync(requestId));
    public Task<EndDayOutcome> EndDayAsync(IReadOnlyList<SkipComment>? comments, DateTimeOffset? at = null) => Task.Run(() => _host.EndDayAsync(comments, at));
    public Task<StartOutcome> TakeBreakAsync(string kind, string? reason) => Task.Run(() => _host.TakeBreakAsync(kind, reason));
    public Task<StartOutcome> TakeFreeBreakAsync(string presenceType) => Task.Run(() => _host.TakeFreeBreakAsync(presenceType));
    public Task<ActionOutcome> QuickBreakAsync(int plannedMin) => Task.Run(() => _host.QuickBreakAsync(plannedMin));
    public Task<ActionOutcome> PauseBreakAsync() => Task.Run(_host.PauseBreakAsync);
    public Task<ActionOutcome> ResumeBreakAsync() => Task.Run(_host.ResumeBreakAsync);
    public Task<SkipOutcome> SkipBreakAsync(string kind, string? reason) => Task.Run(() => _host.SkipBreakAsync(kind, reason));
    public Task<CommentOutcome> CommentBreakAsync(string breakId, string comment) => Task.Run(() => _host.CommentBreakAsync(breakId, comment));
    public Task<EndOutcome> BackToWorkAsync() => Task.Run(() => _host.BackToWorkAsync());
    public Task<EndOutcome> EndMeetingAsync() => Task.Run(_host.EndMeetingAsync);
    public Task<MeetingStatusOutcome> StartMeetingStatusAsync(string source) => Task.Run(() => _host.StartMeetingStatusAsync(source));
    public Task<MeetingStatusOutcome> ConfirmMeetingAsync() => Task.Run(_host.ConfirmMeetingAsync);
    public void DismissMeetingAlert(MeetingAlertKind kind) => _host.DismissMeetingAlert(kind);
    public void MeetingPanelClosed() => _host.MeetingPanelClosed();
    public Task<MeetingOutcome> StartMeetingAsync(string agenda, IReadOnlyList<MeetingParticipant> participants, string momSender) =>
        Task.Run(() => _host.StartMeetingAsync(agenda, participants, momSender));
    public Task<MeetingOutcome> LogPastMeetingAsync(DateTimeOffset startedAt, int durationMin, string agenda, IReadOnlyList<MeetingParticipant> participants, string momSender) =>
        Task.Run(() => _host.LogPastMeetingAsync(startedAt, durationMin, agenda, participants, momSender));
    public Task<AwayOutcome> AnswerAwayAsync(AwayAnswer answer) => Task.Run(() => _host.AnswerAwayAsync(answer));
    public Task<IReadOnlyList<ParticipantOption>?> SearchParticipantsAsync(string? query) => Task.Run(() => _host.SearchParticipantsAsync(query));
    public Task<(HistoryMonth? History, bool Fresh)> GetHistoryAsync(string month) => Task.Run(() => _host.GetHistoryAsync(month));
    public Task<ManualDownload> DownloadUpdateAsync() => Task.Run(_host.DownloadUpdateAsync);
    public Task RefreshPresenceAsync() => Task.Run(_host.RefreshPresenceAsync);
    public Task RefreshWorkdayAsync() => Task.Run(_host.RefreshWorkdayAsync);
    public Task<int> SyncNowAsync(TimeSpan timeout) => Task.Run(() => _host.SyncNowAsync(timeout));
    public Task<KeyOutcome> SignOutWithKeyAsync(string key) => Task.Run(() => _host.SignOutWithKeyAsync(key));
    public Task<KeyOutcome> QuitCheckAsync(string key) => Task.Run(() => _host.QuitCheckAsync(key));
    public Task<bool> ContinueShiftAsync() => Task.Run(_host.ContinueShiftAsync);
    public void DeclineShift() => _host.DeclineShift();
    public void Shutdown() => _host.Shutdown();

    public void Dispose() => _host.Dispose();

    private sealed class AvatarsAdapter : IAvatars
    {
        private static readonly ApiResult<MyAvatar> NotSignedIn = ApiResult<MyAvatar>.TransientFailure("Sign in again to carry on.");
        private readonly AgentHost _host;

        public AvatarsAdapter(AgentHost host) => _host = host;

        public MyAvatar? Mine => _host.Avatars?.Mine;
        public string? ShownId => _host.Avatars?.ShownId;
        public string? PersonName => _host.Avatars?.PersonName;
        public event Action? Changed;
        public event Action<string, string?>? PersonChanged;
        public void RaiseChanged() => Changed?.Invoke();
        public void RaisePersonChanged(string userId, string? avatarId) => PersonChanged?.Invoke(userId, avatarId);

        public Task RefreshAsync() => Task.Run(() => _host.Avatars?.RefreshAsync() ?? Task.CompletedTask);

        public Task<ApiResult<MyAvatar>> SaveAsync(string avatarId) =>
            Task.Run(() => _host.Avatars?.SaveAsync(avatarId) ?? Task.FromResult(NotSignedIn));

        public Task<ApiResult<MyAvatar>> ResetAsync() =>
            Task.Run(() => _host.Avatars?.ResetAsync() ?? Task.FromResult(NotSignedIn));

        public Task<ApiResult<DayProgress>> GetDayProgressAsync() => Task.Run(_host.GetDayProgressAsync);
    }

    private sealed class ChatAdapter : IChat
    {
        private readonly ChatService _chat;
        public ChatAdapter(ChatService chat) => _chat = chat;
        public IReadOnlyList<ChatContact> Contacts => _chat.Contacts;
        public bool ContactsLoaded => _chat.ContactsLoaded;
        public ChatContact? DefaultContact => _chat.DefaultContact;
        public string NameOf(string userId) => _chat.NameOf(userId);
        public Task<bool> LoadContactsAsync() => Task.Run(() => _chat.LoadContactsAsync());
        public Task<IReadOnlyList<ChatMessage>?> LoadConversationAsync(string contactId) => Task.Run(() => _chat.LoadConversationAsync(contactId));
        public Task<ApiResult<ChatMessage>> SendAsync(string contactId, string body) => Task.Run(() => _chat.SendAsync(contactId, body));
        public Task RefreshUnreadAsync() => Task.Run(() => _chat.RefreshUnreadAsync());
        public void BumpUnread() => _chat.BumpUnread();
    }
}
