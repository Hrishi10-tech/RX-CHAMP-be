using System.Globalization;
using System.Text.Json;
using RXVision.Agent.Core.Activity;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Offline;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Realtime;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Update;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;

namespace RXVision.Agent.Core;

public enum AgentState
{
    /// <summary>Launching: restoring the saved session.</summary>
    Starting,
    /// <summary>Nobody is signed in: show the sign-in screen.</summary>
    SignIn,
    /// <summary>No saved session but a per-user enrollment the server must answer; or the secret store has not answered yet.</summary>
    Connecting,
    /// <summary>Signed in; the monitoring notice must be acknowledged before tracking starts.</summary>
    NeedsNotice,
    /// <summary>
    /// Signed in; the day has not started. Nothing is recorded until Start Day (3.1: a
    /// day never starts by itself).
    /// </summary>
    NotStarted,
    /// <summary>Signed in and recording the working day.</summary>
    Running,
    /// <summary>Signed in; the day was ended (End Day). Nothing is recorded until Start Day.</summary>
    DayEnded,
}

public enum NudgeKind
{
    /// <summary>"Good morning, Asha. Start Day when you begin work." At sign-in or the first unlock of a day.</summary>
    Greeting,
    /// <summary>"You're at your desk. Start Day?" After 5 minutes of input with the day not started; at most hourly.</summary>
    AtDesk,
}

/// <summary>A reminder to start the day, for the UI to show as a toast.</summary>
public sealed record AgentNudge(NudgeKind Kind, string? Date);

/// <summary>
/// 4.1 shared computer: "Are you taking the next shift?" <paramref name="Deadline"/> is
/// when the person is signed out without a "Yes". <paramref name="Last"/>: the last time it asks.
/// </summary>
public sealed record ShiftQuestion(DateTimeOffset ShiftEnd, DateTimeOffset Deadline, bool Last);

/// <summary>Result of signing out (or quitting) with an admin's key (4.0, SPEC 2.8).</summary>
public abstract record KeyOutcome
{
    /// <summary>The key was taken: signed out (or free to quit).</summary>
    public sealed record Accepted : KeyOutcome;
    /// <summary>Actions or samples are still waiting for the server: nothing was asked.</summary>
    public sealed record NotSynced(int Actions, int Samples, string Message) : KeyOutcome;
    /// <summary>403 SIGNOUT_KEY_INVALID (or not an admin, for quit).</summary>
    public sealed record WrongKey(string Message) : KeyOutcome;
    /// <summary>429: five wrong keys in ten minutes.</summary>
    public sealed record TooManyTries(string Message) : KeyOutcome;
    /// <summary>No answer from the server.</summary>
    public sealed record Offline(string Message) : KeyOutcome;
    public sealed record Refused(string Message) : KeyOutcome;
}

/// <summary>An answer in the away pop-up (SPEC 2.5).</summary>
public sealed record AwayAnswer(string ReasonKey, string? Comment = null, IReadOnlyList<MeetingParticipant>? Participants = null, string? MomSender = null);

/// <summary>Result of answering the away pop-up.</summary>
public abstract record AwayOutcome
{
    /// <summary>Recorded; waits for approval (not BREAK).</summary>
    public sealed record Recorded : AwayOutcome;
    /// <summary>"Took a break": a quick break runs from the away start.</summary>
    public sealed record OnBreak : AwayOutcome;
    /// <summary>A field is missing or wrong (the message says which).</summary>
    public sealed record Invalid(string Message, IReadOnlyList<string> Fields) : AwayOutcome;
    public sealed record Refused(string Message) : AwayOutcome;
}

/// <summary>
/// The agent, minus the UI. Owns the session state machine and starts and stops
/// every loop (activity, heartbeat, screenshots, sockets, breaks, updates) as the
/// state changes, so no timer is ever left running in the wrong state. The UI
/// calls the public methods and listens to the events (raised on background
/// threads; marshal to the UI thread).
///
/// 4.0 offline first (SPEC 6): after sign-in every action is journalled on disk,
/// shown at once from the local day (<see cref="OfflineDay"/>), and replayed to the
/// server in order by the <see cref="SyncWorker"/>; nothing waits for the network,
/// and a restart starts in the last known state. The server's answers become the
/// base the local day is worked out from whenever they are known to be complete.
/// </summary>
public sealed class AgentHost : IDisposable
{
    /// <summary>No "Good morning" and no "You're at your desk" for this long after a day ended (a night shift, End Day after midnight).</summary>
    public static readonly TimeSpan NudgeHoldAfterEndDay = TimeSpan.FromHours(4);
    /// <summary>The agent's own one-second clock stood still this long: the machine slept (or the process was frozen).</summary>
    public static readonly TimeSpan ResumeGap = TimeSpan.FromSeconds(45);
    /// <summary>The longest a secret store call (the Keychain) may take before the agent carries on without it.</summary>
    public static readonly TimeSpan SecretStoreLimit = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan DayCheckEvery = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan NudgeSampleEvery = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan AwaySampleEvery = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan SampleDrainEvery = TimeSpan.FromSeconds(60);

    private readonly IPlatform _platform;
    private readonly AgentOptions _options;
    private readonly ILog _log;
    private readonly TimeBoundSecretStore _secrets;
    private readonly SessionStore _sessions;
    private readonly ServerClock _clock;
    private readonly AgentIdentity _identity;
    private readonly HttpMessageHandler? _handler;
    private readonly OfflineDay _day;
    private readonly SyncWorker _sync;
    private readonly object _gate = new();

    private AgentServices? _svc;
    private ActivityTracker? _tracker;
    // One queue per person for the life of the process: a tracker that is replaced
    // and the one replacing it then share it, so a sample is never sent twice.
    private ActivityQueue? _queue;
    private string? _queueUserId;
    private DateTimeOffset _stuckTickSeen = DateTimeOffset.MinValue;
    private EnrollmentConfig? _enrollment;
    private Timer? _heartbeat;
    private Timer? _watchdog;
    private Timer? _breakRefresh;
    private Timer? _ringTimer;
    private Timer? _dayCheck;
    private Timer? _pendingTimer;
    private Timer? _nudgeTimer;
    private Timer? _reconnect;
    private Timer? _awayTimer;
    private Timer? _drainTimer;
    // One sign-in at a time: the background reconnect and a manual sign-in both
    // replace the API session, so they must never interleave.
    private readonly SemaphoreSlim _signInGate = new(1, 1);
    // One change of the working day's state at a time.
    private readonly SemaphoreSlim _dayGate = new(1, 1);
    private CancellationTokenSource _lifetime = new();
    private string? _ringKey;
    private DateTimeOffset _lastChime = DateTimeOffset.MinValue;
    private readonly HashSet<string> _acknowledgedRings = new();
    private DateTime _localDate = DateTime.Now.Date;

    // ---- The working day ----
    // Bumped on every sign-in and sign-out: work begun for an earlier session is dropped.
    private long _sessionGen;
    private volatile bool _dayKnown;
    private string? _dayDate;
    private string? _greetedDate;
    private Backoff _pendingBackoff = new(TimeSpan.FromSeconds(10), TimeSpan.FromMinutes(2));
    private int _resolvingCapture;
    private readonly DeskNudge _deskNudge = new();
    private readonly Dictionary<string, (int Attempts, DateTimeOffset Last)> _closedWindows = new();
    // When a working day last ended (End Day here, or as the server reports it), UTC ticks.
    private long _lastEndedTicks;
    // Sleep and resume: the one-second ring timer marks the agent alive; a gap means the
    // machine slept. Until the day is checked again nothing is captured, sent or beaten.
    private long _aliveTicks;
    private volatile bool _resumeHold;
    private long _resumeAtTicks;
    private int _resumeChecking;
    // The server said the session was closed while recording was held after a sleep.
    private int _closedWhileHeld;
    // Away (4.0): the last input seen while the screen was unlocked (server clock, UTC ticks).
    private long _lastActiveTicks;

    /// <param name="secretStoreLimit">Tests only: the time limit on a secret store call (else <see cref="SecretStoreLimit"/>).</param>
    public AgentHost(IPlatform platform, AgentOptions options, ILog log, HttpMessageHandler? handler = null, IClock? clock = null,
        TimeSpan? secretStoreLimit = null)
    {
        _platform = platform;
        _options = options;
        _log = log;
        _handler = handler;
        _clock = new ServerClock(clock);
        // A Keychain prompt or a hung secret store must never keep the agent at "Starting".
        _secrets = new TimeBoundSecretStore(platform.Secrets, secretStoreLimit ?? SecretStoreLimit, log);
        // A Keychain prompt answered late: sign in with what the store now gives.
        _secrets.Answered += () =>
        {
            if (_waitingForStore) _ = Task.Run(() => SafeAsync("auth", RetryStoreAsync));
            // A save refused while it was out (the refresh token rotates): keep the current one.
            else if (_svc is { Api.IsSignedIn: true } svc) svc.Api.PersistSession();
        };
        _sessions = new SessionStore(_secrets);
        _identity = new AgentIdentity(AgentOptions.AppVersion, platform.Name, DeviceId.Get(platform.Paths.DataDir));
        _day = new OfflineDay(_secrets, platform.Paths.DataDir, _clock, log);
        _day.Changed += OnDayChanged;
        _sync = new SyncWorker(_day, () => _svc?.Api, log) { MaySend = () => !_resumeHold };
        _sync.Refused += OnActionRefused;
        // The journal is with the server: the samples taken meanwhile go next. A first batch goes
        // before the day is read again, so a day replayed from a short offline stretch already
        // has its activity data (the server counts replayed time only where samples cover it).
        _sync.Drained += () => _ = SafeAsync("sync", async () =>
        {
            await DrainSamplesAfterJournalAsync();
            await RefreshAllAsync(greet: false);
        });
    }

    // ---- State for the UI -----------------------------------------------------------

    private volatile AgentState _state = AgentState.Starting;
    public AgentState State => _state;
    public PublicUser? User => _svc?.Api.CurrentUser;
    public string ApiBaseUrl => _svc?.Api.BaseUri.ToString().TrimEnd('/') ?? _options.ApiBaseUrl;
    public string Version => _identity.Version;
    public IPlatform Platform => _platform;
    public AgentOptions Options => _options;
    public ServerClock Clock => _clock;
    public bool HasEnrollment => _enrollment is not null;
    public RingView? Ring { get; private set; }
    public int ChatUnread => _svc?.Chat.Unread ?? 0;
    public ChatService? Chat => _svc?.Chat;
    public BreakService? Breaks => _svc?.Breaks;
    public UpdateOffer? PendingUpdate { get; private set; }
    public int PendingSamples => _queue?.Count ?? 0;
    public DateTimeOffset LastSampleSent => _tracker?.LastSent ?? DateTimeOffset.MinValue;

    /// <summary>
    /// How long an action waits for the server's word before the local result stands
    /// (only while the server answered recently): a refusal seen in time comes back
    /// typed (a reason needed, comments needed), so the dialog can ask.
    /// </summary>
    public TimeSpan ImmediateWait { get; set; } = TimeSpan.FromSeconds(3);

    /// <summary>The day as the person lives it: the server's last word plus every action since.</summary>
    public DayView Day => _day.View;

    /// <summary>Today's work day (focus time, skips to comment, the gates), or null when nothing is known yet.</summary>
    public WorkdayToday? Workday => _day.View.Workday;
    /// <summary>A day is known (from the server now, or kept from an earlier run).</summary>
    public bool DayKnown => _dayKnown;
    /// <summary>Today's break day (projected).</summary>
    public BreakDay? BreakDay => _day.View.Breaks;
    /// <summary>The meeting in progress, if it has a record.</summary>
    public MeetingRecord? LiveMeeting => _day.View.LiveMeeting;
    /// <summary>The person's own items with their approver, pending first (the waiting list).</summary>
    public IReadOnlyList<ApprovalItem> MyApprovals => _svc?.Approvals.Mine ?? Array.Empty<ApprovalItem>();

    /// <summary>The break panel as of now (cheap; call every second while visible).</summary>
    public BreakPanel BreakPanel => BreakSchedule.Compute(_day.View.Breaks, _clock.UtcNow);

    /// <summary>Actions waiting for the server (the header's "Offline · N actions waiting").</summary>
    public int PendingActions => _day.PendingCount;
    /// <summary>The server answered the last call (false: offline, or nothing tried yet).</summary>
    public bool Online => _svc?.Api.Reachable == true && !_sync.Offline;
    /// <summary>When the journal last emptied (the "synced" time), or null.</summary>
    public DateTimeOffset? LastSyncAt => _day.LastSyncAt;

    /// <summary>Focus time now: the server's number plus what happened since (SPEC 2.4).</summary>
    public int FocusSec => _day.View.Focus.At(_clock.UtcNow, AwaySince);
    /// <summary>The paid break allowance as of now.</summary>
    public AllowanceNow Allowance => DayProjection.Allowance(_day.View.Workday, _day.View.Breaks, _clock.UtcNow);
    /// <summary>The away pop-up is open since then (null: not open).</summary>
    public DateTimeOffset? AwaySince => _day.AwaySince;
    /// <summary>The effective away settings (4.0), or null before the server sent any.</summary>
    public IdleConfig? IdleConfig => _day.View.Workday?.Config?.Idle ?? _day.Base.Workday?.Config?.Idle;

    // The server answered ATTENDANCE_BY_BIOMETRIC this session: the day buttons stay hidden.
    private volatile bool _biometricRefused;

    /// <summary>
    /// The biometric device takes this person's attendance (3.5): no Start Day, End Day,
    /// break or meeting buttons, and no reminders to start the day.
    /// </summary>
    public bool IsBiometric => _biometricRefused || Workday?.IsBiometric == true;

    /// <summary>The organisation's quick answers for a comment box (3.2; empty when none are known).</summary>
    public IReadOnlyList<string> Presets(string kind) =>
        (_day.View.Breaks?.ReasonPresets ?? _day.Base.Breaks?.ReasonPresets) is { } all && all.TryGetValue(kind, out var list)
            ? list.Where(p => !string.IsNullOrWhiteSpace(p)).ToList()
            : Array.Empty<string>();

    /// <summary>The person's status now, from the day (a break, a meeting, working).</summary>
    public CurrentPresence Presence
    {
        get
        {
            switch (State)
            {
                case AgentState.NotStarted: return new CurrentPresence { Status = PresenceStatus.NotStarted };
                case AgentState.DayEnded: return new CurrentPresence { Status = PresenceStatus.DayEnded };
            }
            var view = _day.View;
            if (DayProjection.ActiveBreakOf(view.Breaks) is { } active)
            {
                return new CurrentPresence
                {
                    Status = active.PresenceType == PresenceStatus.Lunch ? PresenceStatus.Lunch : PresenceStatus.Break,
                    Since = active.StartedAt,
                    Note = active.Label,
                };
            }
            if (view.LiveMeeting is { } meeting)
                return new CurrentPresence { Status = PresenceStatus.Meeting, Since = meeting.StartedAt, Note = meeting.Agenda };
            // A plain break or a meeting without a record (an older agent or server) shows only in presence.
            if (view.LocalChanges == 0 && _day.Base.Presence is { Status: PresenceStatus.Break or PresenceStatus.Lunch or PresenceStatus.Meeting } server)
                return server;
            return new CurrentPresence { Status = PresenceStatus.Working, Since = view.Workday?.StartedAt };
        }
    }

    /// <summary>Break, lunch and meeting time taken today (worked out from the day; the server's totals as a fallback).</summary>
    public PresenceTotals Totals
    {
        get
        {
            var view = _day.View;
            var server = _day.Base.Totals ?? new PresenceTotals();
            var hasRecords = view.Breaks is { } b && (b.Breaks.Any(s => s.Record is not null) || b.Quick.Count > 0 || b.Unscheduled.Count > 0 || b.ActiveBreak is not null);
            if (!hasRecords && view.Meetings.Count == 0) return server;
            var t = DayProjection.Totals(view.Breaks, view.Meetings, _clock.UtcNow);
            return new PresenceTotals
            {
                BreakSec = hasRecords ? t.BreakSec : server.BreakSec,
                LunchSec = hasRecords ? t.LunchSec : server.LunchSec,
                MeetingSec = view.Meetings.Count > 0 ? t.MeetingSec : server.MeetingSec,
                OnlineSec = server.OnlineSec,
                IdleSec = server.IdleSec,
            };
        }
    }

    /// <summary>"yyyy-MM-dd" of an instant in the business time zone.</summary>
    public string BusinessDate(DateTimeOffset at) => _day.BusinessDate(at);
    /// <summary>The business time zone's offset at an instant.</summary>
    public TimeSpan BusinessOffset(DateTimeOffset at) => _day.BusinessOffset(at);

    public event Action<AgentState>? StateChanged;
    public event Action<CurrentPresence>? PresenceChanged;
    public event Action? BreaksChanged;
    /// <summary>A new view of today (an action, an answer from the server).</summary>
    public event Action? WorkdayChanged;
    public event Action? MeetingsChanged;
    public event Action? ApprovalsChanged;
    public event Action<ChatMessage>? ChatMessageReceived;
    public event Action<int>? ChatUnreadChanged;
    public event Action<NotificationItem>? NotificationReceived;
    /// <summary>The ring started (non-null) or stopped (null).</summary>
    public event Action<RingView?>? RingChanged;
    /// <summary>A break of today was auto-skipped while the day ran and needs a comment (once per break).</summary>
    public event Action<BreakRecord>? BreakAutoSkipped;
    /// <summary>A reminder to start the day.</summary>
    public event Action<AgentNudge>? Nudge;
    /// <summary>An action replayed later was refused by the server (shown once; the day is read again).</summary>
    public event Action<string>? ActionRefused;
    /// <summary>The away pop-up opened or closed (see <see cref="AwaySince"/>).</summary>
    public event Action? AwayChanged;
    /// <summary>History may have changed (a decision, a calendar change).</summary>
    public event Action? HistoryChanged;
    /// <summary>The person's leave may have changed (a decision, comp off, a request made here).</summary>
    public event Action? LeaveChanged;
    public event Action<UpdateOffer>? UpdateAvailable;
    /// <summary>The app must exit (an update installer is running).</summary>
    public event Action? ExitRequested;
    /// <summary>The session was lost; the message says why. The state is SignIn afterwards.</summary>
    public event Action<string>? SignedOutUnexpectedly;

    private long Gen => Interlocked.Read(ref _sessionGen);

    // ---- Lifecycle --------------------------------------------------------------------

    /// <summary>Restores the session (or enrolls) and starts whatever the state calls for.</summary>
    public async Task StartAsync()
    {
        // First, before anything that can wait on the person: the Mac update script
        // keeps the previous build until this one has reported itself and stayed up.
        UpdateService.ReportRunning(_platform.Paths.DataDir, AgentOptions.AppVersion, _log);
        await _signInGate.WaitAsync();
        try
        {
            if (await TryStartFromStoreAsync()) return;
            WaitForStore();
        }
        finally
        {
            _signInGate.Release();
        }
    }

    /// <summary>
    /// Signs in with what this machine keeps: its saved session (4.0: at once, without
    /// the server), else its enrollment, else what 2.x left. False when the secret store
    /// has not answered (a Keychain prompt not answered yet) and nothing else would sign
    /// in: that is "not known yet", never "nobody", so the sign-in screen is kept for a
    /// store that answered empty.
    /// </summary>
    private async Task<bool> TryStartFromStoreAsync()
    {
        // What the store has answered is kept across tries: with a prompt per item, each
        // try may get one more answer, and the next must not ask for the same one again.
        if (!_storeEnrollment.Known && TryLoadEnrollment(out var readEnrollment)) _storeEnrollment = (true, readEnrollment);
        if (!_storeSession.Known && _sessions.TryLoad(out var readSession)) _storeSession = (true, readSession);
        var enrollmentKnown = _storeEnrollment.Known;
        var sessionKnown = _storeSession.Known;
        var saved = _storeSession.Value;
        var everythingKnown = enrollmentKnown && sessionKnown;
        if (enrollmentKnown) _enrollment = _storeEnrollment.Value;
        var legacy = sessionKnown && saved is null ? _platform.Legacy.TryReadSession() : null;

        // S-02: a stored address is held to the allowlist too (one saved before this build, or written by hand).
        var baseUrl = AgentOptions.NormaliseUrl(_enrollment?.ApiBaseUrl) ?? AgentOptions.NormaliseUrl(saved?.ApiBaseUrl) ?? _options.ApiBaseUrl;
        if (_enrollment is not null && AgentOptions.NormaliseUrl(_enrollment.ApiBaseUrl) is null)
        {
            _log.Warn("session", "the stored enrollment names a server this build does not talk to; ignoring it");
            _enrollment = null;
            SignInNotice = ServerNotAllowed;
        }
        if (saved is not null && AgentOptions.NormaliseUrl(saved.ApiBaseUrl) is null)
        {
            // Review AG-2: never a silent sign-out. The sign-in window says why it is there.
            _log.Warn("session", "the saved session names a server this build does not talk to; sign-in is asked again");
            saved = null;
            SignInNotice = ServerNotAllowed;
        }
        if (saved is not null && _enrollment is not null && !SameServer(saved.ApiBaseUrl, _enrollment.ApiBaseUrl))
        {
            // A per-user download for another server: that is who this machine belongs to now.
            saved = null;
        }
        UseServer(baseUrl);

        if (saved is not null)
        {
            // 4.0: a saved session restores without the server; its token is checked in the background.
            _storeEnrollment = default;
            _storeSession = default;
            _waitingForStore = false;
            var svc = _svc!;
            svc.Api.RestoreOffline(saved);
            _log.Info("auth", "restored the saved session; checking it with the server in the background");
            await BeginSessionAsync();
            _ = SafeAsync("auth", () => VerifyRestoredSessionAsync(svc));
            return true;
        }

        var restore = legacy is null ? null : new SavedSession
        {
            ApiBaseUrl = baseUrl,
            RefreshToken = legacy.RefreshToken,
            UserId = legacy.UserId,
            Email = legacy.Email,
            DisplayName = legacy.DisplayName,
        };
        if (restore is null && _enrollment is null && !everythingKnown) return false;

        _storeEnrollment = default;
        _storeSession = default;
        var outcome = await TrySignInSilentlyAsync(restore);
        if (outcome == ApiOutcome.Ok)
        {
            _waitingForStore = false;
            if (legacy is not null) _platform.Legacy.Cleanup();
            await BeginSessionAsync();
        }
        else if (outcome == ApiOutcome.Transient)
        {
            _waitingForStore = false;
            SetState(AgentState.Connecting);
            ScheduleReconnect(restore);
        }
        else
        {
            // Refused; the store may still hold more than it has said (an enrollment).
            if (!everythingKnown) return false;
            _waitingForStore = false;
            SetState(AgentState.SignIn);
        }
        return true;
    }

    /// <summary>
    /// A session restored without the server: renew its token now. A token the server
    /// refuses ends the session (the journal stays on disk for the next sign-in); no
    /// answer leaves it to the next call that needs it.
    /// </summary>
    private async Task VerifyRestoredSessionAsync(AgentServices svc)
    {
        var gen = Gen;
        var outcome = await svc.Api.RefreshAsync();
        if (gen != Gen) return;
        if (outcome == ApiOutcome.Ok) _log.Info("auth", "the saved session is good");
        else if (outcome == ApiOutcome.Transient) _log.Info("auth", "the server can't be reached; working offline");
    }

    // The secret store has not answered yet: Connecting, read again until it does.
    private volatile bool _waitingForStore;
    private (bool Known, EnrollmentConfig? Value) _storeEnrollment;
    private (bool Known, SavedSession? Value) _storeSession;
    private Timer? _storeRetry;
    private int _storeRetrying;
    private Backoff _storeBackoff = new(TimeSpan.FromSeconds(5), TimeSpan.FromMinutes(1));

    private void WaitForStore()
    {
        _log.Warn("auth", "the secret store (the Keychain) has not answered; signing in as soon as it does");
        _waitingForStore = true;
        SetState(AgentState.Connecting);
        ScheduleStoreRetry();
    }

    private void ScheduleStoreRetry()
    {
        lock (_gate)
        {
            _storeRetry?.Dispose();
            _storeRetry = new Timer(_ => _ = SafeAsync("auth", RetryStoreAsync), null, _storeBackoff.Next(), Timeout.InfiniteTimeSpan);
        }
    }

    private void StopStoreRetry()
    {
        _waitingForStore = false;
        lock (_gate)
        {
            _storeRetry?.Dispose();
            _storeRetry = null;
        }
        _storeBackoff.Reset();
    }

    /// <summary>Reads the enrollment and the session again and signs in once the store answers.</summary>
    private async Task RetryStoreAsync()
    {
        if (!_waitingForStore || Interlocked.Exchange(ref _storeRetrying, 1) == 1) return;
        try
        {
            if (!await _signInGate.WaitAsync(0))
            {
                ScheduleStoreRetry();   // a manual sign-in is under way
                return;
            }
            try
            {
                if (!_waitingForStore || State != AgentState.Connecting) return;
                if (await TryStartFromStoreAsync())
                {
                    StopStoreRetry();
                    return;
                }
            }
            finally
            {
                _signInGate.Release();
            }
            if (_waitingForStore) ScheduleStoreRetry();
        }
        finally
        {
            Interlocked.Exchange(ref _storeRetrying, 0);
        }
    }

    private async Task<ApiOutcome> TrySignInSilentlyAsync(SavedSession? saved)
    {
        var svc = _svc!;
        var sawTransient = false;
        if (saved is not null)
        {
            var restored = await svc.Api.RestoreAsync(saved);
            if (restored.Ok) return ApiOutcome.Ok;
            if (restored.Outcome == ApiOutcome.Transient) sawTransient = true;
            else _sessions.Clear();
        }
        if (_enrollment is not null)
        {
            var enrolled = await svc.Api.EnrollAsync(_enrollment.EnrollmentToken);
            if (enrolled.Ok) return ApiOutcome.Ok;
            if (enrolled.Outcome == ApiOutcome.Transient) sawTransient = true;
            else _log.Warn("auth", $"enrollment refused: {enrolled.Message}");
        }
        return sawTransient ? ApiOutcome.Transient : ApiOutcome.Rejected;
    }

    /// <summary>Retries a silent sign-in with backoff until the server answers.</summary>
    private void ScheduleReconnect(SavedSession? saved)
    {
        var backoff = new Backoff(TimeSpan.FromSeconds(15), TimeSpan.FromMinutes(5));
        void Arm() => _reconnect = new Timer(async _ =>
        {
            // A timer callback must never throw: on a pool thread that ends the process.
            try
            {
                if (State != AgentState.Connecting) return;
                if (!await _signInGate.WaitAsync(0)) { Arm(); return; } // a manual sign-in is under way
                try
                {
                    if (State != AgentState.Connecting) return;
                    var outcome = await TrySignInSilentlyAsync(_sessions.Load() ?? saved);
                    if (State != AgentState.Connecting) return;
                    if (outcome == ApiOutcome.Ok) { await BeginSessionAsync(); return; }
                    if (outcome == ApiOutcome.Rejected) { SetState(AgentState.SignIn); return; }
                }
                finally
                {
                    _signInGate.Release();
                }
                Arm();
            }
            catch (Exception ex)
            {
                _log.Warn("auth", "reconnect attempt failed; trying again", ex);
                if (State == AgentState.Connecting) Arm();
            }
        }, null, backoff.Next(), Timeout.InfiniteTimeSpan);
        _reconnect?.Dispose();
        Arm();
    }

    /// <summary>Email and password from the sign-in screen. Returns an error to show, or null.</summary>
    public async Task<string?> SignInAsync(string email, string password, string? server = null)
    {
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrEmpty(password)) return "Enter your email and password.";
        StopReconnect();
        await _signInGate.WaitAsync();
        try
        {
            // The background reconnect may have got in first while we waited.
            if (IsSignedInState(State)) return null;
            if (!string.IsNullOrWhiteSpace(server))
            {
                var url = AgentOptions.NormaliseUrl(server, _options.AllowInsecureHttp);
                if (url is null)
                    // S-02: an https address this build may not use is not a typing slip.
                    return server.Trim().StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                        ? ServerNotAllowed
                        : "Start the server address with https://";
                UseServer(url);
            }
            var result = await _svc!.Api.LoginAsync(email, password);
            if (!result.Ok) return result.Message ?? "Sign-in failed.";
            await BeginSessionAsync();
            return null;
        }
        finally
        {
            _signInGate.Release();
        }
    }

    private static bool IsSignedInState(AgentState state) =>
        state is AgentState.NeedsNotice or AgentState.NotStarted or AgentState.Running or AgentState.DayEnded;

    private static bool IsDayState(AgentState state) =>
        state is AgentState.NotStarted or AgentState.Running or AgentState.DayEnded;

    private void StopReconnect()
    {
        _reconnect?.Dispose();
        _reconnect = null;
        StopStoreRetry();
    }

    /// <summary>A setup code from the portal (or an enrollment token). Returns an error to show, or null.</summary>
    public async Task<string?> SignInWithCodeAsync(string code)
    {
        var enrollment = Enrollment.FromSetupCode(code, ApiBaseUrl);
        if (enrollment is null) return "That setup code isn't valid. Copy it again from the portal.";
        StopReconnect();
        await _signInGate.WaitAsync();
        try
        {
            if (IsSignedInState(State)) return null;
            UseServer(enrollment.ApiBaseUrl);
            var result = await _svc!.Api.EnrollAsync(enrollment.EnrollmentToken);
            if (!result.Ok) return result.Outcome == ApiOutcome.Transient ? result.Message : "That setup code was refused. Ask your manager for a new one.";
            _enrollment = enrollment;
            _sessions.SaveEnrollment(enrollment);
            await BeginSessionAsync();
            return null;
        }
        finally
        {
            _signInGate.Release();
        }
    }

    private void UseServer(string baseUrl)
    {
        lock (_gate)
        {
            if (_svc is not null && SameServer(_svc.Api.BaseUri.ToString(), baseUrl)) return;
            _svc?.Dispose();
            _svc = new AgentServices(baseUrl, _identity, _sessions, _clock, _platform, _options, _log, _handler);
            Wire(_svc);
        }
    }

    private void Wire(AgentServices svc)
    {
        svc.Api.EnrollmentToken = () => _enrollment?.EnrollmentToken;
        svc.Api.SessionLost += reason => _ = OnSessionLostAsync(reason);
        svc.Breaks.AutoSkipped += record =>
        {
            // Only while the day runs: a skip found at sign-in on an ended day is old news.
            if (State == AgentState.Running) BreakAutoSkipped?.Invoke(record);
        };
        svc.Approvals.Changed += () => ApprovalsChanged?.Invoke();
        svc.Chat.MessageReceived += m => ChatMessageReceived?.Invoke(m);
        svc.Chat.UnreadChanged += n => ChatUnreadChanged?.Invoke(n);
        svc.Notifications.Received += n =>
        {
            NotificationReceived?.Invoke(n);
            OnNotification(svc, n);
        };
        svc.Notifications.DayChanged += what =>
        {
            // config:changed, workday:changed, or a decision: today again, and History if open.
            _log.Info("day", $"the server says the day changed ({what}); reading it again");
            _ = SafeAsync("day", () => DayCheckAsync(greet: false));
            if (what.StartsWith("WORKDAY", StringComparison.Ordinal) || what == "DECIDED") _ = SafeAsync("breaks", FetchBreaksAsync);
            try { HistoryChanged?.Invoke(); }
            catch (Exception ex) { _log.Error("day", "a history handler failed", ex); }
            // Leave decided, comp off or a decision elsewhere (3.4: workday:changed LEAVE).
            if (what is "WORKDAY:LEAVE" or "WORKDAY:COMPOFF" or "WORKDAY:DECISION") RaiseLeaveChanged();
        };
        svc.Updates.Available += offer => { PendingUpdate = offer; UpdateAvailable?.Invoke(offer); };
        svc.Updates.ExitForUpdate += () => ExitRequested?.Invoke();
        svc.ScreenshotSocket.On("screenshot:capture", _ => OnManagerCaptureRequest());
        svc.Screenshots.AllowAuto = () => MayCapture();
    }

    /// <summary>
    /// Whether a screenshot (automatic or a manager's) may be taken now: only while the
    /// day runs, not on a break or lunch (by presence or by the break schedule), and not
    /// straight after the machine woke until the day has been checked again.
    /// </summary>
    private bool MayCapture() =>
        RecordingAllowed()
        && Presence.Status is not (PresenceStatus.Break or PresenceStatus.Lunch)
        && BreakPanel.Active is null;

    /// <summary>
    /// A manager asked for a screenshot. It follows the same rules as the automatic
    /// shots: only while the day is running (Start Day pressed, notice accepted), and
    /// never during a break or lunch. Returns whether a capture was started.
    /// </summary>
    internal bool OnManagerCaptureRequest()
    {
        var svc = _svc;
        if (svc is null) return false;
        if (!MayCapture())
        {
            _log.Info("screenshots", $"capture request ignored ({State}, {Presence.Status}{(_resumeHold ? ", checking the day after a sleep" : "")})");
            return false;
        }
        _ = SafeAsync("screenshots", () => svc.Screenshots.CaptureNowAsync());
        return true;
    }

    /// <summary>What a notification changes in the person's own day.</summary>
    private void OnNotification(AgentServices svc, NotificationItem n)
    {
        switch (n.Type)
        {
            case "BREAK_DECIDED":
            case "MEETING_DECIDED":
            case "AWAY_DECIDED":
                // A decision on one of your items moves your focus time, the waiting list and History.
                _ = SafeAsync("breaks", FetchBreaksAsync);
                _ = SafeAsync("day", RefreshExtrasAsync);
                _ = SafeAsync("day", () => DayCheckAsync(greet: false));
                break;
            case "DAY_AUTO_CLOSED":
            case "APPROVALS_OVERDUE":
            case "APPROVALS_ESCALATED":
            case "BIOMETRIC_NO_CHECKOUT":
            case "WFH_DECIDED":
            case "WFH_REVOKED":
                _ = SafeAsync("day", () => DayCheckAsync(greet: false));
                break;
            case "LEAVE_DECIDED":
            case "LEAVE_REVOKED":
            case "LEAVE_ADJUSTED":
            case "LEAVE_UPDATED":
            case "COMPOFF_DECIDED":
            case "COMPOFF_CREDITED":
            case "COMPOFF_EXPIRING":
                // Leave moves today's target and the Leave page (3.4, 3.5).
                _ = SafeAsync("day", () => DayCheckAsync(greet: false));
                RaiseLeaveChanged();
                break;
        }
    }

    private void RaiseLeaveChanged()
    {
        try { LeaveChanged?.Invoke(); }
        catch (Exception ex) { _log.Error("leave", "a leave handler failed", ex); }
    }

    /// <summary>The server said the biometric device takes this person's attendance: the day buttons go for this session.</summary>
    private void NoteBiometric(string? code)
    {
        if (code != "ATTENDANCE_BY_BIOMETRIC" || _biometricRefused) return;
        _biometricRefused = true;
        _log.Info("day", "attendance is taken by the biometric device; the day buttons are hidden");
        try { WorkdayChanged?.Invoke(); }
        catch (Exception ex) { _log.Error("day", "a workday handler failed", ex); }
    }

    private static bool SameServer(string a, string b) =>
        string.Equals(a.TrimEnd('/'), b.TrimEnd('/'), StringComparison.OrdinalIgnoreCase);

    private const string LegacyEnrollmentDone = "legacy-enrollment.done";

    /// <summary>
    /// Who this machine enrolls as, newest source first: a per-user install that
    /// just wrote its sidecar beside the app; then what this agent keeps (a setup
    /// code, or an earlier install); last, once only, what a 2.x install left (the
    /// copy the installer carried across beside the app, else the 2.x folder).
    /// The legacy files are never read again after that, so they can neither
    /// override a newer enrollment nor sign someone back in after they signed out.
    /// </summary>
    /// <returns>False when the secret store has not answered: the enrollment is not known yet.</returns>
    private bool TryLoadEnrollment(out EnrollmentConfig? enrollment)
    {
        enrollment = Enrollment.FromSidecar(_platform.Paths.AppDir);
        if (enrollment is not null)
        {
            // Keep the token out of a plain file once it is in the secret store (and only then).
            if (_sessions.SaveEnrollment(enrollment))
            {
                try
                {
                    var path = Path.Combine(_platform.Paths.AppDir, Enrollment.SidecarName);
                    if (File.Exists(path)) File.Delete(path);
                }
                catch { /* read-only install folder: harmless, it is re-read and re-saved */ }
            }
            FinishLegacyEnrollment();
            return true;
        }

        if (!_sessions.TryLoadEnrollment(out var stored))
        {
            // Not answered: what it holds is unknown, so nothing older may stand in for it.
            return false;
        }
        if (stored is not null)
        {
            FinishLegacyEnrollment();
            enrollment = stored;
            return true;
        }

        if (File.Exists(LegacyEnrollmentMarker))
        {
            DeleteQuietly(CarriedLegacyEnrollment);
            return true;
        }
        var legacy = Enrollment.FromSidecar(_platform.Paths.AppDir, Enrollment.LegacySidecarName);
        if (legacy is null)
        {
            try { legacy = _platform.Legacy.TryReadEnrollment(); }
            catch (Exception ex) { _log.Warn("auth", "could not read the 2.x enrollment", ex); }
        }
        FinishLegacyEnrollment();
        if (legacy is not null)
        {
            _log.Info("auth", "using the enrollment a 2.x install left");
            _sessions.SaveEnrollment(legacy);
        }
        enrollment = legacy;
        return true;
    }

    private string LegacyEnrollmentMarker => Path.Combine(_platform.Paths.DataDir, LegacyEnrollmentDone);
    private string CarriedLegacyEnrollment => Path.Combine(_platform.Paths.AppDir, Enrollment.LegacySidecarName);

    /// <summary>
    /// The 2.x enrollment is done with: read now, or made obsolete by a newer one. It is
    /// never read again (the installer does not carry it across again either).
    /// </summary>
    private void FinishLegacyEnrollment()
    {
        if (!File.Exists(LegacyEnrollmentMarker))
        {
            try { AtomicFile.WriteAllBytes(LegacyEnrollmentMarker, Array.Empty<byte>()); }
            catch (Exception ex) { _log.Warn("auth", "could not record the 2.x enrollment as done", ex); }
        }
        DeleteQuietly(CarriedLegacyEnrollment);
    }

    private static void DeleteQuietly(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch { /* read-only install folder: harmless, it is never read again */ }
    }

    // ---- Session ------------------------------------------------------------------------

    private async Task BeginSessionAsync()
    {
        var svc = _svc!;
        var user = svc.Api.CurrentUser!;
        Interlocked.Increment(ref _sessionGen);
        _dayKnown = false;
        _log.Info("session", $"signed in as {user.Id} ({user.Role}) on {svc.Api.BaseUri.Host}");
        svc.Screenshots.AutoEnabled = user.ScreenshotsEnabled;

        try { _platform.Autostart.Enable(); }
        catch (Exception ex) { _log.Warn("session", "could not enable start at login", ex); }

        // The day as an earlier run left it, the journal, and the sender (4.0, offline first).
        _day.Open(user.Id);
        EnsureQueue(svc, user.Id);
        _sync.Start();
        StartSampleDrain();

        // Things that run whatever the day's state: chat, notifications, the
        // manager's capture channel, updates, and the lock watch (the first unlock of
        // a day greets the person).
        WatchLock();
        svc.Chat.Start();
        svc.Notifications.Start();
        svc.ScreenshotSocket.Start();
        svc.Updates.Start();
        _ = SafeAsync("chat", () => svc.Chat.LoadContactsAsync());
        _ = SafeAsync("chat", () => svc.Chat.RefreshUnreadAsync());
        var gen = Gen;
        _ = SafeAsync("session", () => RefreshUserAsync(svc, gen));
        StartBreakTimers();

        if (!NoticeAcknowledged(user.Id))
        {
            SetState(AgentState.NeedsNotice);
            _ = SafeAsync("day", () => RefreshAllAsync(greet: false));
            return;
        }
        await EnterDayStateAsync();
    }

    /// <summary>C-966: an https server this build may not use (S-02, AG-2).</summary>
    public const string ServerNotAllowed = "Check the server address with your manager.";

    /// <summary>
    /// A line the sign-in window shows once when it opens: set when a saved session or setup was
    /// for a server this build does not talk to, so the person is not signed out without a word.
    /// </summary>
    public string? SignInNotice { get; private set; }

    /// <summary>The sign-in window has shown <see cref="SignInNotice"/>.</summary>
    public void SignInNoticeShown()
    {
        SignInNotice = null;
    }

    /// <summary>
    /// The person's role and settings as the server has them now: a session saved by
    /// 2.9.1 has no role (a manager would get staff wording and rules), and a role or
    /// the screenshot setting can change between sign-ins. Kept with the session.
    /// </summary>
    private async Task RefreshUserAsync(AgentServices svc, long gen)
    {
        var before = svc.Api.CurrentUser;
        var fresh = await svc.Api.RefreshCurrentUserAsync();
        if (fresh is null || gen != Gen) return;
        if (before?.Role != fresh.Role)
            _log.Info("session", $"role from the server: {fresh.Role ?? "none"} (the saved session said {before?.Role ?? "nothing"})");
        svc.Screenshots.AutoEnabled = fresh.ScreenshotsEnabled;
    }

    /// <summary>The person read the monitoring notice; tracking may start.</summary>
    public async Task AcknowledgeNoticeAsync()
    {
        var user = User;
        if (user is null) return;
        try { AtomicFile.WriteAllBytes(NoticeFile(user.Id), System.Text.Encoding.UTF8.GetBytes(DateTimeOffset.UtcNow.ToString("o"))); }
        catch { }
        if (State == AgentState.NeedsNotice) await EnterDayStateAsync();
    }

    private string NoticeFile(string userId) =>
        Path.Combine(_platform.Paths.DataDir, $"notice-{new string(userId.Where(char.IsLetterOrDigit).ToArray())}.txt");

    private bool NoticeAcknowledged(string userId) => File.Exists(NoticeFile(userId));

    /// <summary>
    /// After sign-in and the notice: the day as last known decides at once (OPEN tracks,
    /// ENDED is DayEnded, NOT_STARTED waits for Start Day), then the server is asked in
    /// the background. Nothing known at all is NotStarted, retried until the server says.
    /// </summary>
    private async Task EnterDayStateAsync()
    {
        var gen = Gen;
        await _dayGate.WaitAsync();
        try
        {
            if (gen != Gen) return;
            ApplyDayLocked(greet: true);
        }
        finally
        {
            _dayGate.Release();
        }
        StartDayCheck();
        StartAwayWatch();
        _ = SafeAsync("day", () => RefreshAllAsync(greet: true));
    }

    /// <summary>
    /// Moves to the state the day calls for. Runs under the day gate. With nothing known
    /// yet: NotStarted (a guess), and the day is asked for again until the server says.
    /// </summary>
    private void ApplyDayLocked(bool greet)
    {
        var day = _day.View.Workday;
        if (day is null)
        {
            _dayKnown = false;
            if (State != AgentState.NotStarted) EnterNotStarted();
            SchedulePending();
            return;
        }
        _dayKnown = true;
        Apply(day, greet);
    }

    /// <summary>
    /// Moves to the state the day calls for. The day is open while any work session is
    /// (past midnight too: the session keeps its day), so anything else while Running
    /// means the session was closed, by End Day (here or elsewhere) or by the server
    /// (a machine asleep overnight is auto-closed): recording stops at once.
    /// </summary>
    private void Apply(WorkdayToday day, bool greet)
    {
        NoteDayEnded(day);
        if (day.IsOpen)
        {
            if (State != AgentState.Running)
            {
                _log.Info("day", $"the day is open ({day.Date}); tracking");
                EnterRunning(day.Date);
            }
            _dayDate = day.Date;
            return;
        }

        // The day is no longer open (ended elsewhere, closed by the server): nothing left to end.
        // Not while it is this agent's own End Day on its way (the held one, sent again).
        if (_heldEndDay is not null && !_day.Pending.Any(p => p.Kind == EventKinds.EndDay))
        {
            _log.Info("day", "the End Day held for comments is dropped: the day is no longer open");
            _heldEndDay = null;
        }

        if (State == AgentState.Running)
        {
            _log.Info("day", day.IsEnded
                ? day.AutoClosed ? "the day was closed by the server (missed End Day); recording stops" : "the day was ended; recording stops"
                : $"no work session is open ({day.Date} not started); recording stops");
            if (_resumeHold) Interlocked.Exchange(ref _closedWhileHeld, 1);
        }

        if (day.IsEnded)
        {
            if (State != AgentState.DayEnded) EnterDayEnded(day.Date);
            _dayDate = day.Date;
            return;
        }

        // NOT_STARTED: wait for Start Day.
        if (State != AgentState.NotStarted) EnterNotStarted();
        _dayDate = day.Date;
        if (greet && _greetedDate != day.Date)
        {
            if (!MayNudge(day))
            {
                _log.Info("day", "not greeting: a day off, a full day of leave, or a biometric day");
            }
            else if (RecentlyEnded(out var ago))
            {
                // A day that ended a moment ago (a night shift, End Day after midnight): a
                // "Good morning" now would invite a stray session. A later unlock greets.
                _log.Info("day", $"not greeting: the last day ended {ago.TotalMinutes:F0} min ago");
            }
            else
            {
                _greetedDate = day.Date;
                lock (_gate) _deskNudge.Shown(DateTimeOffset.UtcNow);
                Nudge?.Invoke(new AgentNudge(NudgeKind.Greeting, day.Date));
            }
        }
    }

    /// <summary>
    /// Nothing nags on a day off or a full day of leave (3.2, 3.4; Start Day stays
    /// available), or for someone whose day the biometric device opens (3.5).
    /// </summary>
    private bool MayNudge(WorkdayToday? day) =>
        !IsBiometric && day?.DayOff is null && day?.Leave is not { Full: true };

    /// <summary>Remembers when the last working day ended, from the day.</summary>
    private void NoteDayEnded(WorkdayToday day)
    {
        var ended = day.IsEnded ? day.EndedAt : day.IsNotStarted ? day.LastEnded?.EndedAt : null;
        if (ended is { } at && at != default) NoteDayEnded(at);
    }

    private void NoteDayEnded(DateTimeOffset at)
    {
        var ticks = at.UtcTicks;
        long seen;
        do
        {
            seen = Interlocked.Read(ref _lastEndedTicks);
            if (ticks <= seen) return;
        } while (Interlocked.CompareExchange(ref _lastEndedTicks, ticks, seen) != seen);
    }

    /// <summary>No greeting and no desk nudge now: a working day ended within <see cref="NudgeHoldAfterEndDay"/>.</summary>
    internal bool NudgesHeld => RecentlyEnded(out _);

    /// <summary>A working day ended within <see cref="NudgeHoldAfterEndDay"/> (server clock).</summary>
    private bool RecentlyEnded(out TimeSpan ago)
    {
        var ticks = Interlocked.Read(ref _lastEndedTicks);
        ago = ticks == 0 ? TimeSpan.MaxValue : _clock.UtcNow - new DateTimeOffset(ticks, TimeSpan.Zero);
        return ticks != 0 && ago >= TimeSpan.Zero && ago < NudgeHoldAfterEndDay;
    }

    private void EnterRunning(string? date)
    {
        _dayDate = date ?? _dayDate;
        StopNudges();
        Interlocked.Exchange(ref _lastActiveTicks, _clock.UtcNow.UtcTicks);
        StartTracking();
    }

    private void EnterNotStarted()
    {
        StopTracking();
        CloseAwayQuietly();
        SetState(AgentState.NotStarted);
        PresenceChanged?.Invoke(Presence);
        StartNudges();
    }

    private void StartTracking()
    {
        var svc = _svc!;
        var user = svc.Api.CurrentUser;
        if (user is null) return;

        _tracker?.Retire();
        EnsureQueue(svc, user.Id);
        _tracker = new ActivityTracker(svc.Api, _platform, _options, _queue!, _log) { MaySend = SamplesMaySend };
        _stuckTickSeen = DateTimeOffset.MinValue;
        _tracker.Acknowledged += OnAck;
        _tracker.BacklogSent += OnBacklogSent;
        MarkAlive();
        _resumeHold = false;
        Interlocked.Exchange(ref _closedWhileHeld, 0);
        WatchLock();
        _tracker.Start();
        svc.Screenshots.Start();

        _heartbeat?.Dispose();
        var beat = TimeSpan.FromSeconds(_options.HeartbeatSeconds);
        _heartbeat = new Timer(_ => _ = SafeAsync("heartbeat", HeartbeatAsync), null, TimeSpan.FromSeconds(5), beat);

        _watchdog?.Dispose();
        _watchdog = new Timer(_ => Guard("watchdog", Watchdog), null, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(2));

        SetState(AgentState.Running);
        PresenceChanged?.Invoke(Presence);
    }

    private void StopTracking()
    {
        _tracker?.Stop();
        _svc?.Screenshots.Stop();
        _heartbeat?.Dispose();
        _heartbeat = null;
        _watchdog?.Dispose();
        _watchdog = null;
    }

    /// <summary>This person's sample queue (kept across sign-outs; another person never sends it).</summary>
    private void EnsureQueue(AgentServices svc, string userId)
    {
        if (_queue is null || _queueUserId != userId)
        {
            _queue = new ActivityQueue(_secrets, _platform.Paths.DataDir, userId, _log);
            _queueUserId = userId;
            _tracker?.Retire();
            _tracker = new ActivityTracker(svc.Api, _platform, _options, _queue, _log) { MaySend = SamplesMaySend };
            _tracker.Acknowledged += OnAck;
            _tracker.BacklogSent += OnBacklogSent;
        }
    }

    /// <summary>The journal just emptied: one batch of the samples waiting behind it, now.</summary>
    private async Task DrainSamplesAfterJournalAsync()
    {
        var tracker = _tracker;
        if (tracker is null || _queue is not { Count: > 0 } || !SamplesMaySend()) return;
        try { await tracker.DrainAsync(ActivityTracker.DrainPerTick, _lifetime.Token); }
        catch (OperationCanceledException) { }
    }

    /// <summary>
    /// Samples taken offline (or before a restart) are all with the server (SPEC 2.4): time it
    /// reported as "Offline, no activity data" counts now. Today and History are read again.
    /// </summary>
    private void OnBacklogSent()
    {
        _log.Info("activity", "the samples taken offline are with the server; reading the day again");
        _ = SafeAsync("activity", async () =>
        {
            await DayCheckAsync(greet: false);
            try { HistoryChanged?.Invoke(); }
            catch (Exception ex) { _log.Error("day", "a history handler failed", ex); }
        });
    }

    /// <summary>
    /// Samples taken while the day ran go out whatever the state now (4.0: also after End
    /// Day, and after a restart), but only after the journal: the server must know of
    /// Start Day before the samples that follow it.
    /// </summary>
    private void StartSampleDrain()
    {
        lock (_gate)
        {
            _drainTimer?.Dispose();
            _drainTimer = new Timer(_ => _ = SafeAsync("activity", DrainSamplesAsync), null, TimeSpan.FromSeconds(20), SampleDrainEvery);
        }
    }

    private async Task DrainSamplesAsync()
    {
        var tracker = _tracker;
        if (tracker is null || tracker.IsRunning || _queue is not { Count: > 0 } || !SamplesMaySend()) return;
        await tracker.DrainAsync(ActivityTracker.DrainPerTick, _lifetime.Token);
    }

    /// <summary>Drains the sample queue now (tests).</summary>
    internal Task DrainSamplesNowAsync() => DrainSamplesAsync();

    private void WatchLock()
    {
        try { _platform.Lock.Start(); } catch (Exception ex) { _log.Warn("lock", "lock watch failed", ex); }
        _platform.Lock.Changed -= OnLockChanged;
        _platform.Lock.Changed += OnLockChanged;
    }

    private void OnAck(ActivityAck ack)
    {
        var svc = _svc;
        if (svc is null) return;
        if (svc.Screenshots.AutoEnabled != ack.ScreenshotsEnabled)
        {
            svc.Screenshots.AutoEnabled = ack.ScreenshotsEnabled;
            _log.Info("screenshots", $"automatic screenshots {(ack.ScreenshotsEnabled ? "on" : "off")}");
        }
        if (!ack.ShouldCapture && State == AgentState.Running && Interlocked.Exchange(ref _resolvingCapture, 1) == 0)
        {
            _ = SafeAsync("day", async () =>
            {
                try { await OnCaptureRefusedAsync(); }
                finally { Interlocked.Exchange(ref _resolvingCapture, 0); }
            });
        }
    }

    /// <summary>
    /// The server says no session is open (the day was ended elsewhere, closed for a
    /// missed End Day, or never started). Samples go only once the journal is empty, so
    /// this is the server's word on everything done here: stop recording at once and
    /// follow the server's day.
    /// </summary>
    private async Task OnCaptureRefusedAsync()
    {
        var svc = _svc;
        if (svc is null) return;
        var gen = Gen;
        await _dayGate.WaitAsync();
        try
        {
            if (gen != Gen || State != AgentState.Running) return;
            _log.Info("day", "the server says no work session is open; recording stops");
            StopTracking();
        }
        finally
        {
            _dayGate.Release();
        }

        var answered = await FetchWorkdayAsync();
        await _dayGate.WaitAsync();
        try
        {
            if (gen != Gen || State != AgentState.Running) return;
            if (answered && _day.View.Workday is { IsOpen: true })
            {
                _log.Warn("day", "the day reads as open after all; recording again");
                StartTracking();
                return;
            }
            // Unknown: stay stopped; the watchdog and the day check sort it out within minutes.
            if (answered) ApplyDayLocked(greet: false);
        }
        finally
        {
            _dayGate.Release();
        }
    }

    private async Task HeartbeatAsync()
    {
        var svc = _svc;
        if (svc is null || !RecordingAllowed()) return;
        bool idle;
        try
        {
            idle = _platform.Lock.IsLocked || _platform.Idle.IdleTime() >= TimeSpan.FromSeconds(_options.IdleThresholdSeconds);
        }
        catch { idle = false; }
        await svc.Api.HeartbeatAsync(idle);
    }

    /// <summary>
    /// Restarts tracking that has quietly stopped: the tracker is not running, or one
    /// tick has been in progress for over five minutes on two checks in a row (two
    /// minutes apart). A single sighting is not enough: a machine that has just woken
    /// with a request still in flight looks stuck by the wall clock for a moment.
    /// </summary>
    private void Watchdog()
    {
        var tracker = _tracker;
        if (State != AgentState.Running || tracker is null) return;
        if (!tracker.IsRunning)
        {
            _log.Warn("watchdog", "activity tracking was not running; restarting it");
            StartTracking();
            return;
        }
        if (tracker.TickInProgressSince is { } since && DateTimeOffset.UtcNow - since > TimeSpan.FromMinutes(5))
        {
            if (_stuckTickSeen == since)
            {
                _log.Warn("watchdog", $"an activity tick has been stuck since {since:HH:mm:ss}Z; restarting tracking");
                StartTracking();
            }
            else
            {
                _stuckTickSeen = since;
            }
            return;
        }
        _stuckTickSeen = DateTimeOffset.MinValue;
    }

    /// <summary>Runs a timer's work: an exception thrown on a pool thread would end the process.</summary>
    private void Guard(string area, Action work)
    {
        try { work(); }
        catch (Exception ex) { _log.Error(area, "timer work failed", ex); }
    }

    /// <summary>Runs background work that nobody awaits: never throws, always logs.</summary>
    private async Task SafeAsync(string area, Func<Task> work)
    {
        try { await work(); }
        catch (Exception ex) { _log.Error(area, "background work failed", ex); }
    }

    // ---- Sleep and resume ----------------------------------------------------------------

    private void MarkAlive() => Interlocked.Exchange(ref _aliveTicks, DateTimeOffset.UtcNow.UtcTicks);

    /// <summary>
    /// Whether anything may be recorded now (a sample sent, a screenshot, a heartbeat):
    /// the day runs, and no sleep is being checked. Notices a sleep itself, so whichever
    /// timer fires first after the machine wakes holds everything.
    /// </summary>
    private bool RecordingAllowed() => State == AgentState.Running && SendingAllowed();

    /// <summary>
    /// Whether queued samples may go out now: not while a sleep is being checked. (Samples
    /// taken while the day ran may still go after it ended.)
    /// </summary>
    private bool SendingAllowed()
    {
        NoteResumeIfAny();
        return !_resumeHold;
    }

    /// <summary>Samples follow the journal: none goes before every action is with the server.</summary>
    private bool SamplesMaySend() => SendingAllowed() && _day.PendingCount == 0;

    /// <summary>The one-second clock stood still: the machine slept. Check the day before recording again.</summary>
    private void NoteResumeIfAny()
    {
        var now = DateTimeOffset.UtcNow.UtcTicks;
        var last = Interlocked.Exchange(ref _aliveTicks, now);
        if (last == 0 || now - last < ResumeGap.Ticks || State != AgentState.Running) return;
        BeginResumeCheck(TimeSpan.FromTicks(now - last), last);
    }

    /// <param name="lastAlive">The agent's last sign of life before the gap (UTC ticks).</param>
    private void BeginResumeCheck(TimeSpan gap, long lastAlive)
    {
        if (!_resumeHold)
        {
            // Everything sampled after the last sign of life (marked every second) was
            // taken after waking, including a sample the waking tick took before it
            // noticed the gap.
            Interlocked.Exchange(ref _resumeAtTicks, lastAlive + TimeSpan.TicksPerSecond);
            _resumeHold = true;
        }
        if (Interlocked.Exchange(ref _resumeChecking, 1) == 1) return;
        _log.Info("day", $"the agent's clock stood still for {gap.TotalMinutes:F1} min (asleep?); checking the day before recording again");
        // Off the caller's thread: it is a timer or a sample on its way.
        _ = Task.Run(() => SafeAsync("day", async () =>
        {
            try { await ResumeCheckAsync(); }
            finally { Interlocked.Exchange(ref _resumeChecking, 0); }
        }));
    }

    /// <summary>
    /// After a sleep: asks the server for the day (again and again while offline), then
    /// lets recording go on if the session is still open. If it was closed meanwhile
    /// (auto-closed overnight, ended elsewhere) the day check has already stopped
    /// tracking, and the samples taken since waking are not sent.
    /// </summary>
    private async Task ResumeCheckAsync()
    {
        var gen = Gen;
        var wait = TimeSpan.FromSeconds(5);
        while (_resumeHold && gen == Gen && State == AgentState.Running)
        {
            if (await DayCheckAsync(greet: false)) break;
            try { await Task.Delay(wait, _lifetime.Token); }
            catch (OperationCanceledException) { return; }
            wait = TimeSpan.FromSeconds(Math.Min(60, wait.TotalSeconds * 2));
        }
        if (!_resumeHold) return;
        var since = new DateTimeOffset(Interlocked.Read(ref _resumeAtTicks), TimeSpan.Zero);
        var closed = Interlocked.Exchange(ref _closedWhileHeld, 0) == 1;
        _resumeHold = false;
        _sync.Poke();
        if (gen != Gen) return;
        if (State == AgentState.Running)
        {
            _log.Info("day", "the session is still open after the sleep; recording again");
            return;
        }
        // Ended here meanwhile (End Day right after waking): what was taken was in the day.
        if (!closed) return;
        var dropped = _tracker?.DropLiveSince(since) ?? 0;
        if (dropped > 0) _log.Info("activity", $"{dropped} sample(s) taken after waking were not sent: the session had closed while asleep");
    }

    /// <summary>Notices a sleep now (tests); returns whether recording is held for a day check.</summary>
    internal bool CheckForResumeNow()
    {
        NoteResumeIfAny();
        return _resumeHold;
    }

    /// <summary>Pretends the agent's own clock stood still since <paramref name="since"/> (tests).</summary>
    internal void SetAliveForTests(DateTimeOffset since) => Interlocked.Exchange(ref _aliveTicks, since.UtcTicks);

    private void OnLockChanged(bool locked)
    {
        if (locked) return;
        // Back at the desk: sockets are often dead after a sleep, and the day may
        // have rolled over or been started or ended elsewhere.
        _svc?.Chat.Reconnect();
        _svc?.Notifications.Reconnect();
        _svc?.ScreenshotSocket.Reconnect();
        _sync.Poke();
        _ = SafeAsync("breaks", FetchBreaksAsync);
        _ = SafeAsync("day", () => DayCheckAsync(greet: true));
    }

    // ---- The day from the server ------------------------------------------------------------

    /// <summary>
    /// Reads today's work day; kept as the day's base when it is known to be complete
    /// (see <see cref="OfflineDay.Adopt"/>). True when the server answered.
    /// </summary>
    private async Task<bool> FetchWorkdayAsync()
    {
        var svc = _svc;
        if (svc is null || !svc.Api.IsSignedIn) return false;
        var stamp = _day.Stamp();
        var result = await svc.Workday.RefreshAsync();
        if (!result.Ok || result.Data is null) return false;
        if (_day.UserId == svc.Api.CurrentUser?.Id) _day.Adopt(DayParts.Workday, result.Data, stamp);
        _day.SaveClock();
        return true;
    }

    private async Task FetchBreaksAsync()
    {
        var svc = _svc;
        if (svc is null || !svc.Api.IsSignedIn) return;
        var stamp = _day.Stamp();
        if (!await svc.Breaks.RefreshAsync()) return;
        if (svc.Breaks.Day is { } day && _day.UserId == svc.Api.CurrentUser?.Id) _day.Adopt(DayParts.Breaks, day, stamp);
        _day.SaveClock();
    }

    private async Task FetchMeetingsAsync()
    {
        var svc = _svc;
        if (svc is null || !svc.Api.IsSignedIn) return;
        var stamp = _day.Stamp();
        if (!await svc.Meetings.RefreshAsync()) return;
        if (_day.UserId == svc.Api.CurrentUser?.Id) _day.Adopt(DayParts.Meetings, svc.Meetings.Today, stamp);
    }

    /// <summary>Everything about today from the server (after sign-in, after the journal emptied).</summary>
    private async Task RefreshAllAsync(bool greet)
    {
        var svc = _svc;
        if (svc is null || !svc.Api.IsSignedIn) return;
        await FetchBreaksAsync();
        await RefreshPresenceAsync();
        var answered = await DayCheckAsync(greet);
        if (!answered && !_dayKnown) SchedulePending();
        await RefreshExtrasAsync();
    }

    /// <summary>Arms a retry while nothing at all is known about the day.</summary>
    private void SchedulePending()
    {
        lock (_gate)
        {
            _pendingTimer?.Dispose();
            _pendingTimer = new Timer(_ => _ = SafeAsync("day", PendingTickAsync), null, _pendingBackoff.Next(), Timeout.InfiniteTimeSpan);
        }
    }

    private async Task PendingTickAsync()
    {
        var svc = _svc;
        if (svc is null || !svc.Api.IsSignedIn) return;
        var gen = Gen;
        if (!_dayKnown && IsDayState(State))
        {
            await RefreshAllAsync(greet: true);
            if (!_dayKnown && gen == Gen) SchedulePending();
            else _pendingBackoff.Reset();
        }
    }

    /// <summary>Runs the retry now instead of at its timer (tests).</summary>
    internal Task RetryPendingNowAsync() => PendingTickAsync();

    /// <summary>Runs the day check now instead of at its timer (tests).</summary>
    internal Task DayCheckNowAsync(bool greet = false) => DayCheckAsync(greet);

    /// <summary>Takes an activity sample now instead of at the minute (tests).</summary>
    internal Task SampleNowAsync() => _tracker?.TickAsync() ?? Task.CompletedTask;

    /// <summary>The sender (tests: wait for it, poke it).</summary>
    internal SyncWorker Sync => _sync;

    /// <summary>The UI asks for fresh numbers (the dashboard is open): the day, meetings and the waiting list.</summary>
    public async Task RefreshWorkdayAsync()
    {
        await DayCheckAsync(greet: false);
        await RefreshExtrasAsync();
    }

    /// <summary>
    /// Reads the server's day and follows it (every few minutes, after an unlock, at
    /// midnight, on some notifications).
    /// </summary>
    /// <returns>Whether the server answered.</returns>
    private async Task<bool> DayCheckAsync(bool greet)
    {
        var svc = _svc;
        if (svc is null || !svc.Api.IsSignedIn || !IsDayState(State)) return false;
        var gen = Gen;
        var answered = await FetchWorkdayAsync();
        if (!answered) return false;
        await _dayGate.WaitAsync();
        try
        {
            if (gen != Gen || !IsDayState(State)) return true;
            ApplyDayLocked(greet);
            return true;
        }
        finally
        {
            _dayGate.Release();
        }
    }

    // ---- 4.1 shared computer: the shift-end handover ------------------------------------

    private static readonly TimeSpan HandoverEvery = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ExtendRetryEvery = TimeSpan.FromSeconds(30);
    private const int ExtendTries = 20;
    private readonly ShiftHandover _handover = new();
    private Timer? _handoverTimer;
    private int _handoverBusy;

    /// <summary>"Are you taking the next shift?" is due (raised 15 and 5 minutes before the shift ends).</summary>
    public event Action<ShiftQuestion>? ShiftEndQuestion;

    /// <summary>Signed out at the shift end (or after End Day) so the next person can sign in.</summary>
    public event Action? SignedOutForNextShift;

    /// <summary>When a person who is not continuing is signed out; null before the question.</summary>
    public DateTimeOffset? HandoverDeadline => _handover.Deadline;

    private void HandoverTick()
    {
        var config = Workday?.Config;
        var step = _handover.Next(_clock.UtcNow, config?.SharedComputer == true, config?.ShiftEndAt,
            config?.Extended == true, State == AgentState.Running);
        switch (step)
        {
            case HandoverStep.Ask or HandoverStep.AskLast when config?.ShiftEndAt is { } end:
                _log.Info("handover", step == HandoverStep.AskLast ? "asking again about the next shift" : "asking about the next shift");
                ShiftEndQuestion?.Invoke(new ShiftQuestion(end, _handover.Deadline ?? end, step == HandoverStep.AskLast));
                break;
            case HandoverStep.SignOut:
                if (Interlocked.Exchange(ref _handoverBusy, 1) != 0) return;
                _ = SafeAsync("handover", async () =>
                {
                    try { await SignOutForNextShiftAsync(); }
                    finally { Volatile.Write(ref _handoverBusy, 0); }
                });
                break;
        }
    }

    /// <summary>
    /// "Yes, I'm taking the next shift": the day carries on (same day, no approval) until
    /// End Day. Told to RX Vision now, or retried for a while when it can't be reached.
    /// </summary>
    public async Task<bool> ContinueShiftAsync()
    {
        _handover.Continue();
        _log.Info("handover", "taking the next shift; the day carries on");
        for (var attempt = 1; attempt <= ExtendTries; attempt++)
        {
            var svc = _svc;
            if (svc?.Api.CurrentUser is null) return false;
            var result = await svc.Api.ExtendShiftAsync();
            if (result.Ok)
            {
                await FetchWorkdayAsync();
                return true;
            }
            if (!result.Transient)
            {
                _log.Warn("handover", $"carrying the day on was refused ({result.Status} {result.Code}: {result.Message})");
                return false;
            }
            await Task.Delay(ExtendRetryEvery);
        }
        _log.Warn("handover", "could not reach RX Vision to carry the day on");
        return false;
    }

    /// <summary>"No": signed out at the shift end.</summary>
    public void DeclineShift()
    {
        _log.Info("handover", "not taking the next shift; signing out at the shift end");
        _handover.Decline();
    }

    /// <summary>
    /// The day ends (at the shift end, without End Day's questions) and this person is
    /// signed out, so the next one can sign in. Everything recorded reaches RX Vision
    /// first; offline it waits and tries again on the next tick, so one person's work is
    /// never left behind for the next.
    /// </summary>
    private async Task SignOutForNextShiftAsync()
    {
        var svc = _svc;
        if (svc?.Api.CurrentUser is null) return;
        if (State == AgentState.Running)
        {
            if (await EnsureSyncedAsync() is { } waiting)
            {
                _log.Info("handover", $"waiting to sign out: {waiting.Message}");
                return;
            }
            var ended = await svc.Api.EndDayAtShiftEndAsync();
            if (!ended.Ok && ended.Code != "DAY_NOT_STARTED")
            {
                if (ended.Code == "SHARED_COMPUTER_OFF") _handover.Reset();
                _log.Warn("handover", $"ending the day at the shift end failed ({ended.Status} {ended.Code}: {ended.Message})");
                return;
            }
            _log.Info("handover", "day ended at the shift end");
        }
        if (await EnsureSyncedAsync() is { } left)
        {
            _log.Info("handover", $"waiting to sign out: {left.Message}");
            return;
        }
        var result = await svc.Api.AutoSignOutAsync();
        if (!result.Ok)
        {
            if (result.Code == "SHARED_COMPUTER_OFF") _handover.Reset();
            _log.Warn("handover", $"signing out for the next shift failed ({result.Status} {result.Code}: {result.Message})");
            return;
        }
        _log.Info("session", "signed out for the next shift (shared computer)");
        await ClearSessionAsync(clearData: true, callLogout: false, keepAutostart: true);
        _handover.Reset();
        SignedOutForNextShift?.Invoke();
    }

    private void StartDayCheck()
    {
        lock (_gate)
        {
            _handoverTimer?.Dispose();
            _handoverTimer = new Timer(_ => Guard("handover", HandoverTick), null, HandoverEvery, HandoverEvery);
            _dayCheck?.Dispose();
            _dayCheck = new Timer(_ => _ = SafeAsync("day", async () =>
            {
                await DayCheckAsync(greet: false);
                await RefreshExtrasAsync();
            }), null, DayCheckEvery, DayCheckEvery);
        }
    }

    /// <summary>Meetings and the waiting list (cheap; after anything that changes them).</summary>
    private async Task RefreshExtrasAsync()
    {
        var svc = _svc;
        if (svc is null || !svc.Api.IsSignedIn || !IsDayState(State)) return;
        await svc.Approvals.RefreshAsync();
        await FetchMeetingsAsync();
    }

    /// <summary>The day changed: tell the UI, ring if due, and follow the day's state.</summary>
    private void OnDayChanged()
    {
        try
        {
            WorkdayChanged?.Invoke();
            BreaksChanged?.Invoke();
            MeetingsChanged?.Invoke();
            PresenceChanged?.Invoke(Presence);
        }
        catch (Exception ex)
        {
            _log.Error("day", "a day-changed handler failed", ex);
        }
        Guard("ring", CheckRing);
        if (IsDayState(State)) _ = SafeAsync("day", ApplyDayAsync);
    }

    private async Task ApplyDayAsync()
    {
        var gen = Gen;
        await _dayGate.WaitAsync();
        try
        {
            if (gen == Gen && IsDayState(State) && _day.UserId is not null) ApplyDayLocked(greet: false);
        }
        finally
        {
            _dayGate.Release();
        }
    }

    /// <summary>A replayed action the server refused after its caller stopped waiting: said once, then the day is read again.</summary>
    private void OnActionRefused(JournalEvent e, ApiResult<JsonElement> result)
    {
        var local = e.At.ToOffset(BusinessOffset(e.At));
        var when = Clock12.Format(local);
        var date = local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var month = date[..7];
        var what = EventRequests.Describe(e);
        NoteBiometric(result.Code);

        // End Day refused for comments on skipped breaks (ones never seen offline, or auto-skips
        // End Day itself would make): held, so the person adds them and End Day goes again with
        // its own time (SPEC 3.1). The comments dialog is the notice.
        if (e.Kind == EventKinds.EndDay && WorkdayService.EndDayRefusal(result) is EndDayOutcome.CommentsRequired { Breaks.Count: > 0 } needs)
        {
            var held = new HeldEndDay(e.At, needs.Breaks, needs.Message);
            _heldEndDay = held;
            _log.Warn("sync", $"{e} refused: {needs.Breaks.Count} skipped break(s) need a comment; End Day at {when} held for them");
            try { EndDayHeld?.Invoke(held); }
            catch (Exception ex) { _log.Error("sync", "an End Day handler failed", ex); }
            _ = SafeAsync("day", () => RefreshAllAsync(greet: false));
            return;
        }

        string? message;
        if (DayRefusal(result) is { } why)
        {
            // About the day (or the month) itself: every action dated in it gets the same answer,
            // so it is said once, for the first of them.
            var scope = result.Code == MonthLocked ? month : date;
            bool first;
            lock (_toldScopes)
            {
                first = _toldScopes.Add($"{result.Code}:{scope}");
                _toldScopes.Add(scope);
            }
            message = first ? $"{what} on {local.ToString("d MMM", CultureInfo.InvariantCulture)} at {when} couldn't be saved. {why}" : null;
            _log.Warn("sync", $"{e} refused for good: {result.Status} {result.Code}: {result.Message}{(first ? "" : " (already told)")}");
        }
        else if (result is { Status: 409, Code: "NOT_FOUND", Message: SyncWorker.TargetRefused } && Told(date, month))
        {
            // It acted on something its day's refusal already covered: that notice says it all.
            message = null;
            _log.Warn("sync", $"{e} dropped: what it acted on was refused ({date})");
        }
        else
        {
            message = $"{what} at {when} couldn't be saved: {result.Message ?? "the server refused it"}";
            _log.Warn("sync", message);
        }
        if (message is not null)
        {
            try { ActionRefused?.Invoke(message); }
            catch (Exception ex) { _log.Error("sync", "a refusal handler failed", ex); }
        }
        _ = SafeAsync("day", () => RefreshAllAsync(greet: false));
    }

    /// <summary>The server's code for an action dated in a month closed for payroll (409).</summary>
    public const string MonthLocked = "MONTH_LOCKED";

    /// <summary>
    /// The person's words for a final refusal about the action's day itself (4.0 replay), or null
    /// for any other refusal: the month closed for payroll, the day already ended by then (a replay
    /// past its latest end), no day running then (a plain break or a meeting end with no day open),
    /// or a time the day cannot take (EVENT_TIME_INVALID: too old, out of order, or an End Day
    /// before the open session began; the server's sentence says which).
    /// </summary>
    public static string? DayRefusal<T>(ApiResult<T> result) => result.Code switch
    {
        MonthLocked => "That day's month is closed for payroll; ask your Admin.",
        "DAY_ENDED" => "Your day had already ended by then.",
        "DAY_NOT_STARTED" => "Your day wasn't running then.",
        "EVENT_TIME_INVALID" => string.IsNullOrWhiteSpace(result.Message) ? "Its time doesn't fit your day on RX Vision." : result.Message!.Trim(),
        _ => null,
    };

    // The days and months a refusal was said for ("2026-10-13", "2026-10"), and which ("CODE:scope").
    private readonly HashSet<string> _toldScopes = new(StringComparer.Ordinal);

    private bool Told(string date, string month)
    {
        lock (_toldScopes) return _toldScopes.Contains(date) || _toldScopes.Contains(month);
    }

    /// <summary>
    /// An End Day done offline that the server refused for comments on skipped breaks, waiting
    /// for them; null when there is none. End Day with <c>at</c> = its time sends it again.
    /// </summary>
    public HeldEndDay? HeldEndDay => _heldEndDay;
    private volatile HeldEndDay? _heldEndDay;

    /// <summary>An End Day done offline needs comments before it can end that day (background thread).</summary>
    public event Action<HeldEndDay>? EndDayHeld;

    // ---- Recording an action ----------------------------------------------------------------

    /// <summary>
    /// Journals an action and waits a moment for the server's word on it (only while the
    /// server answered recently: offline, the local result stands at once).
    /// </summary>
    private async Task<(JournalEvent Event, EventFate Fate)> RecordAsync(string kind, EventPayload payload, DateTimeOffset? at = null)
    {
        var e = RecordExpected(kind, payload, at);
        _sync.Poke();
        var fate = await WaitForAsync(e);
        if (fate is EventFate.Refused refused) NoteBiometric(refused.Result.Code);
        return (e, fate);
    }

    /// <summary>Records an action whose caller will ask for its fate (the waiter is in place before it can be sent).</summary>
    private JournalEvent RecordExpected(string kind, EventPayload payload, DateTimeOffset? at = null)
    {
        // Anything else done after a held End Day's time: the day went on, so that End Day is no
        // longer what the person wants (and the server would take nothing older than this action).
        if (kind != EventKinds.EndDay && _heldEndDay is not null)
        {
            _log.Info("day", $"the End Day held for comments is dropped: {kind} came after it");
            _heldEndDay = null;
        }
        var id = _sync.Expect();
        try
        {
            return _day.Record(kind, payload, at, id);
        }
        catch
        {
            _sync.Release(id);
            throw;
        }
    }

    /// <summary>
    /// The server's word on an action, waited for a moment while it answered recently and
    /// nothing older waits ahead of it; offline the local result stands at once.
    /// </summary>
    private Task<EventFate> WaitForAsync(JournalEvent e)
    {
        var pending = _day.Pending;
        // Already answered (the sender is quick): its fate is there to collect.
        if (pending.All(p => p.Id != e.Id)) return _sync.WaitAsync(e.Id, ImmediateWait);
        var online = _svc?.Api.Reachable == true && !_sync.Offline && pending.FirstOrDefault()?.Id == e.Id;
        return online ? _sync.WaitAsync(e.Id, ImmediateWait) : Task.FromResult(_sync.Release(e.Id));
    }

    /// <summary>Sends everything waiting now, for up to <paramref name="timeout"/>; returns what is left.</summary>
    public async Task<int> SyncNowAsync(TimeSpan timeout)
    {
        if (_day.PendingCount == 0) return 0;
        await _sync.FlushAsync(timeout);
        return _day.PendingCount;
    }

    // ---- The working day ----------------------------------------------------------------

    /// <summary>
    /// Start Day: the day opens at once (journalled), and goes to the server with its time.
    /// A late first start (3.2) asks for its note first, by the day as known, before anything
    /// is recorded; the server's 422 LATE_REASON_REQUIRED, when it answers in time, asks the
    /// same way. Press again with <paramref name="lateReason"/>.
    /// </summary>
    public async Task<StartDayOutcome> StartDayAsync(string? lateReason = null)
    {
        var svc = _svc;
        if (svc?.Api.CurrentUser is null) return new StartDayOutcome.Refused("SIGNED_OUT", "Sign in first.");
        var gen = Gen;
        JournalEvent e;
        bool resumed;
        await _dayGate.WaitAsync();
        try
        {
            if (gen != Gen) return new StartDayOutcome.Refused("SIGNED_OUT", "Sign in first.");
            switch (State)
            {
                case AgentState.Running:
                    return new StartDayOutcome.Started(Workday, false);
                case AgentState.NotStarted:
                case AgentState.DayEnded:
                    break;
                default:
                    return new StartDayOutcome.Refused("NOT_READY", "Finish signing in first.");
            }
            resumed = State == AgentState.DayEnded;
            var note = string.IsNullOrWhiteSpace(lateReason) ? null : ReasonText.Clean(lateReason);
            if (note is null && !resumed && IsLateStart(_clock.UtcNow) is { } needs)
            {
                _log.Info("day", $"Start Day {needs.MinutesLate} min after the shift start: asking for the note first");
                return needs;
            }
            e = RecordExpected(EventKinds.StartDay, new EventPayload { Reason = note });
            _sync.Poke();
            _log.Info("day", $"Start Day{(resumed ? " (again)" : "")}{(note is null ? "" : ", with the late start's note")}");
            ApplyDayLocked(greet: false);
        }
        finally
        {
            _dayGate.Release();
        }
        var fate = await WaitForAsync(e);
        if (fate is EventFate.Refused refused)
        {
            NoteBiometric(refused.Result.Code);
            if (LateStartRule.FromRefusal(refused.Result) is { } asked)
            {
                // The server judged the start late (its day differs from the one known here):
                // nothing was recorded, so ask and press again.
                _log.Info("day", "Start Day refused: the late start needs its note");
                return asked;
            }
            var outcome = new StartDayOutcome.Refused(refused.Result.Code ?? "REFUSED", refused.Result.Message ?? "Couldn't start your day.");
            _log.Warn("day", $"Start Day refused: {outcome.Code} {outcome.Message}");
            return outcome;
        }
        _ = SafeAsync("day", FetchBreaksAsync);
        return new StartDayOutcome.Started(Workday, resumed);
    }

    /// <summary>A first Start Day now would be late and wants a note (by today as known), else null.</summary>
    internal StartDayOutcome.NeedsLateReason? IsLateStart(DateTimeOffset now) =>
        LateStartRule.Check(_day.View.Workday ?? _day.Base.Workday, _svc?.Api.CurrentUser?.Role, now, BusinessDate(now), BusinessOffset(now),
            Presets(PresetKinds.LateDayStart), at => Clock12.Format(at.ToOffset(BusinessOffset(at))));

    // ---- The late start's note, the guide, My calendar, leave (3.2 to 3.5) ---------------------

    /// <summary>"Add a note": a late start made without one (another computer, an older agent).</summary>
    public async Task<ApiResult<JsonElement>> AddLateReasonAsync(string reason)
    {
        var svc = _svc;
        if (svc is null || !svc.Api.IsSignedIn) return NotSignedIn<JsonElement>();
        var result = await svc.Api.AddLateReasonAsync(reason);
        if (result.Ok) _ = SafeAsync("day", () => DayCheckAsync(greet: false));
        return result;
    }

    private const string GuideFile = "guide.json";

    /// <summary>
    /// The Instructions page from the server (3.2), or the copy an earlier answer left when it
    /// can't be asked. <c>Fresh</c> false: that copy, or nothing yet.
    /// </summary>
    public async Task<(StaffGuide? Guide, bool Fresh)> GetGuideAsync()
    {
        var path = Path.Combine(_platform.Paths.DataDir, GuideFile);
        var svc = _svc;
        if (svc is not null && svc.Api.IsSignedIn)
        {
            var result = await svc.Api.GetGuideAsync();
            if (result.Ok && result.Data is { } guide)
            {
                try { AtomicFile.WriteAllBytes(path, JsonSerializer.SerializeToUtf8Bytes(guide, Json.Options)); }
                catch (Exception ex) { _log.Warn("guide", "could not keep the guide on disk", ex); }
                return (guide, true);
            }
        }
        try
        {
            if (File.Exists(path)) return (JsonSerializer.Deserialize<StaffGuide>(File.ReadAllBytes(path), Json.Options), false);
        }
        catch (Exception ex)
        {
            _log.Warn("guide", "the kept guide could not be read", ex);
        }
        return (null, false);
    }

    private static ApiResult<T> NotSignedIn<T>() => new() { Outcome = ApiOutcome.Rejected, Message = "Sign in first." };

    /// <summary>The person's own year (GET /calendar/people/:id/year), as My calendar shows it.</summary>
    public async Task<ApiResult<CalendarYear>> GetCalendarAsync(int year)
    {
        var svc = _svc;
        if (svc?.Api.CurrentUser is not { } user) return NotSignedIn<CalendarYear>();
        var result = await svc.Api.GetPersonYearAsync(user.Id, year);
        return result.Ok && result.Data is { } data
            ? result.As(CalendarYear.From(data, BusinessDate(_clock.UtcNow)))
            : result.As<CalendarYear>();
    }

    /// <summary>Balances, comp off, requests and the policy (3.4, 3.5).</summary>
    public async Task<ApiResult<MyLeave>> GetMyLeaveAsync() =>
        _svc is { } svc ? await svc.Api.GetMyLeaveAsync() : NotSignedIn<MyLeave>();

    /// <summary>What a request would charge, or the first thing that stops it. Nothing is made.</summary>
    public async Task<ApiResult<LeavePreview>> PreviewLeaveAsync(LeaveRequestBody body) =>
        _svc is { } svc ? await svc.Api.PreviewLeaveAsync(body) : NotSignedIn<LeavePreview>();

    public async Task<ApiResult<LeaveRequest>> RequestLeaveAsync(LeaveRequestBody body)
    {
        var svc = _svc;
        if (svc is null) return NotSignedIn<LeaveRequest>();
        var result = await svc.Api.RequestLeaveAsync(body);
        if (result.Ok)
        {
            RaiseLeaveChanged();
            _ = SafeAsync("day", () => DayCheckAsync(greet: false));
        }
        return result;
    }

    public async Task<ApiResult<LeaveRequest>> CancelLeaveAsync(string requestId)
    {
        var svc = _svc;
        if (svc is null) return NotSignedIn<LeaveRequest>();
        var result = await svc.Api.CancelLeaveAsync(requestId);
        if (result.Ok)
        {
            RaiseLeaveChanged();
            _ = SafeAsync("day", () => DayCheckAsync(greet: false));
        }
        return result;
    }

    /// <summary>
    /// End Day: ends at once (journalled), with a comment for each skipped break that
    /// needs one. Comments still missing and approvals past due are asked about first
    /// (from the day as known); the server's own answer, when it comes in time, is
    /// returned typed (the dialog asks again).
    /// </summary>
    /// <param name="at">
    /// The held End Day's time (<see cref="HeldEndDay"/>): the day ends then, not now. Null: now.
    /// </param>
    public async Task<EndDayOutcome> EndDayAsync(IReadOnlyList<SkipComment>? comments = null, DateTimeOffset? at = null)
    {
        var before = _heldEndDay;
        var outcome = await EndDayCoreAsync(comments, at);
        // 4.1 shared computer: the person ended their day, so they are signed out for the
        // next one: at once (still offline: the handover timer tries again every 30 seconds).
        if (outcome is EndDayOutcome.Ended && Workday?.Config?.SharedComputer == true)
        {
            _log.Info("handover", "day ended on a shared computer; signing out");
            _handover.SignOutNow();
            _ = Task.Run(() => Guard("handover", HandoverTick));
        }
        // A held End Day is done with once the day ended, or End Day was refused for anything a
        // comment cannot fix; asked for comments again, it stays (with the server's newest list).
        switch (outcome)
        {
            case EndDayOutcome.CommentsRequired { Breaks.Count: > 0 } again when at is { } time:
                _heldEndDay = new HeldEndDay(time, again.Breaks, again.Message);
                break;
            case EndDayOutcome.CommentsRequired or EndDayOutcome.CommentInvalid or EndDayOutcome.Offline:
                if (at is not null) _heldEndDay ??= before;
                break;
            default:
                _heldEndDay = null;
                break;
        }
        return outcome;
    }

    private async Task<EndDayOutcome> EndDayCoreAsync(IReadOnlyList<SkipComment>? comments, DateTimeOffset? at)
    {
        var svc = _svc;
        if (svc is null) return new EndDayOutcome.Refused("SIGNED_OUT", "Sign in first.");
        if (State == AgentState.DayEnded) return new EndDayOutcome.Ended(Workday, Workday?.EndedAt);
        if (State != AgentState.Running) return new EndDayOutcome.NotStarted("Your day hasn't started, so there is nothing to end.");
        var gen = Gen;

        var day = Workday;
        var given = (comments ?? Array.Empty<SkipComment>()).Where(c => ReasonText.Clean(c.Comment).Length > 0).Select(c => c.BreakId).ToHashSet();
        var missing = (day?.SkipsNeedingComment ?? new List<SkipNeedingComment>()).Where(s => !given.Contains(s.Id)).ToList();
        if (missing.Count > 0)
            return new EndDayOutcome.CommentsRequired(missing, missing.Count == 1 ? "A skipped break needs a comment." : "Some skipped breaks need a comment.");
        if (day is { EndDayBlockedByOverdue: true } && svc.Api.Reachable != true)
            return new EndDayOutcome.ApprovalsOverdue(day.OverdueApprovals, null, "Approvals are past due. Decide them in the portal to end your day.");

        // Samples first when the server is there (offline they wait in their queue).
        var tracker = _tracker;
        if (tracker is not null && svc.Api.Reachable && _day.PendingCount == 0) await tracker.FlushAsync(TimeSpan.FromSeconds(5));

        JournalEvent e;
        await _dayGate.WaitAsync();
        try
        {
            if (gen != Gen) return new EndDayOutcome.Refused("SIGNED_OUT", "Sign in first.");
            if (State == AgentState.DayEnded) return new EndDayOutcome.Ended(Workday, Workday?.EndedAt);
            if (State != AgentState.Running) return new EndDayOutcome.NotStarted("Your day hasn't started, so there is nothing to end.");
            var now = _clock.UtcNow;
            // A held End Day ends the day when the person ended it (never later than now).
            var endAt = at is { } held && held < now ? held : now;
            // The away pop-up still open: that time is away with no answer (SPEC 2.5). After a
            // held End Day's time it is outside the day: the pop-up just closes.
            if (_day.AwaySince is { } away)
            {
                if (away < endAt) _day.Record(EventKinds.AwayUnexplained, new EventPayload { StartedAt = away, EndedAt = endAt }, endAt);
                SetAway(null);
            }
            e = RecordExpected(EventKinds.EndDay, new EventPayload { Comments = comments?.Select(c => new SkipComment(c.BreakId, ReasonText.Clean(c.Comment))).ToList() }, endAt);
            _sync.Poke();
            _log.Info("day", endAt < now ? $"End Day at {endAt:HH:mm:ss}Z (held, with its comments)" : "End Day");
            NoteDayEnded(endAt);
            ApplyDayLocked(greet: false);
        }
        finally
        {
            _dayGate.Release();
        }

        var fate = await WaitForAsync(e);
        if (fate is not EventFate.Refused refused) return new EndDayOutcome.Ended(Workday, e.At);

        var outcome = WorkdayService.EndDayRefusal(refused.Result);
        await FetchWorkdayAsync();
        switch (outcome)
        {
            case EndDayOutcome.CommentsRequired required when required.Breaks.Count == 0:
                // The list did not come with the answer: today's view has it.
                var listed = Workday?.SkipsNeedingComment ?? new List<SkipNeedingComment>();
                outcome = required with { Breaks = listed };
                await AfterEndDayGateAsync(svc, listed);
                break;
            case EndDayOutcome.CommentsRequired required:
                await AfterEndDayGateAsync(svc, required.Breaks);
                break;
            case EndDayOutcome.ApprovalsOverdue:
                // A 4.0 server judges End Day before it writes (nothing saved); a 3.1 one saved the
                // comments and auto-skipped owed breaks before this gate stopped it: read the breaks.
                await AfterEndDayGateAsync(svc, null);
                break;
        }
        _ = SafeAsync("day", RefreshExtrasAsync);
        return outcome;
    }

    /// <summary>
    /// End Day was stopped by a gate. A 3.1 server had taken its first steps (saved the
    /// comments, auto-skipped every owed break whose window was still open); a 4.0 one judges
    /// before it writes and lists the auto-skips it would make, each with the id it will get.
    /// Read the break day again, so the panel knows either way. The breaks the End Day dialog
    /// is asking about (made or still to be made) are not announced again as "auto-skipped"
    /// toasts when they appear. Waits a few seconds at most.
    /// </summary>
    private async Task AfterEndDayGateAsync(AgentServices svc, IReadOnlyList<SkipNeedingComment>? asking)
    {
        if (asking is not null) svc.Breaks.MarkAnnounced(asking.Select(b => b.Id));
        var refresh = SafeAsync("breaks", FetchBreaksAsync);
        await Task.WhenAny(refresh, Task.Delay(EndDayGateRefreshWait));
    }

    private static readonly TimeSpan EndDayGateRefreshWait = TimeSpan.FromSeconds(3);

    private void EnterDayEnded(string? date)
    {
        _dayDate = date ?? _dayDate;
        StopTracking();
        StopNudges();
        CloseAwayQuietly();
        SetState(AgentState.DayEnded);
        PresenceChanged?.Invoke(Presence);
    }

    // ---- Start Day reminders --------------------------------------------------------------

    private void StartNudges()
    {
        lock (_gate)
        {
            _deskNudge.Reset();
            _nudgeTimer?.Dispose();
            _nudgeTimer = new Timer(_ => Guard("nudge", NudgeTick), null, NudgeSampleEvery, NudgeSampleEvery);
        }
    }

    private void StopNudges()
    {
        lock (_gate)
        {
            _nudgeTimer?.Dispose();
            _nudgeTimer = null;
            _deskNudge.Reset();
        }
    }

    private void NudgeTick()
    {
        // Not within hours of a day ending (after a night shift, or End Day after
        // midnight, sitting on is not a new day).
        if (State != AgentState.NotStarted || RecentlyEnded(out _) || !MayNudge(Workday))
        {
            lock (_gate) _deskNudge.Reset();
            return;
        }
        TimeSpan idle;
        bool locked;
        try { locked = _platform.Lock.IsLocked; } catch { locked = false; }
        try { idle = _platform.Idle.IdleTime(); } catch { idle = TimeSpan.MaxValue; }
        bool due;
        lock (_gate) due = _deskNudge.Observe(DateTimeOffset.UtcNow, idle, locked);
        if (due)
        {
            _log.Info("day", "at the desk with the day not started; reminding");
            Nudge?.Invoke(new AgentNudge(NudgeKind.AtDesk, _dayDate));
        }
    }

    // ---- Breaks, lunch, meetings ----------------------------------------------------------

    private StartOutcome.Refused? NotRunning() => State switch
    {
        AgentState.Running => null,
        AgentState.DayEnded => new StartOutcome.Refused("DAY_ENDED", "Your working day has ended."),
        AgentState.NotStarted => new StartOutcome.Refused("DAY_NOT_STARTED", "Start your day first."),
        AgentState.NeedsNotice => new StartOutcome.Refused("NOT_READY", "Finish setting up RX Vision first."),
        _ => new StartOutcome.Refused("SIGNED_OUT", "Sign in first."),
    };

    private bool OnABreak => BreakPanel.Active is not null || Presence.Status is PresenceStatus.Break or PresenceStatus.Lunch;
    private bool InAMeeting => LiveMeeting is not null || Presence.Status == PresenceStatus.Meeting;

    /// <summary>Starts a scheduled break (kind MORNING/LUNCH/EVENING), with a reason when needed.</summary>
    public async Task<StartOutcome> TakeBreakAsync(string kind, string? reason)
    {
        if (_svc is null) return new StartOutcome.Refused("SIGNED_OUT", "Sign in first.");
        if (NotRunning() is { } refused) return refused;
        if (OnABreak) return new StartOutcome.Refused("ALREADY_ON_BREAK", "You're already on a break. End it first.");
        if (InAMeeting) return new StartOutcome.Refused("IN_MEETING", "You're in a meeting. End it first.");
        var panel = BreakPanel;
        var slot = panel.Slots.FirstOrDefault(s => s.Kind == kind);
        if (slot is null) return new StartOutcome.Refused("BREAK_NOT_SCHEDULED", "That break isn't in your shift today.");
        if (panel.Paused is not null && panel.Paused.Kind != kind)
            return new StartOutcome.Refused("BREAK_PAUSED", $"Your {Lower(panel.Paused.Label)} is paused. Resume or end it first.");
        if (!slot.CanStart)
        {
            return slot.State switch
            {
                SlotState.Upcoming => new StartOutcome.Refused("BREAK_WINDOW_CLOSED", $"{slot.Label} opens at {slot.LocalWindowOpen}."),
                SlotState.Closed => new StartOutcome.Refused("BREAK_WINDOW_CLOSED", $"{slot.Label} closed at {slot.LocalWindowClose}."),
                SlotState.Unavailable => new StartOutcome.Refused("BREAK_ORDER", "A later break was already taken today."),
                SlotState.Paused => new StartOutcome.Refused("BREAK_PAUSED", "It is paused: resume it instead."),
                _ => new StartOutcome.Refused("BREAK_ALREADY_TAKEN", $"{slot.Label} is already taken today."),
            };
        }
        if (slot.ReasonRequired && ReasonText.Clean(reason).Length < panel.MinChars)
        {
            var early = slot.TimingIfStartedNow == "EARLY";
            return new StartOutcome.NeedsReason(slot.TimingIfStartedNow ?? "LATE", slot.MinutesOffIfStartedNow, panel.MinChars,
                $"You're starting it {slot.MinutesOffIfStartedNow} min {(early ? "early" : "late")}. Add a reason for your manager.");
        }
        var localId = OfflineDay.NewLocalId();
        var (_, fate) = await RecordAsync(EventKinds.BreakStart, new EventPayload { BreakKind = kind, Reason = ReasonText.Clean(reason), LocalId = localId });
        if (fate is EventFate.Refused r) return BreakService.StartRefusal(r.Result, panel.MinChars);
        _log.Info("breaks", $"started {kind}");
        return new StartOutcome.Started(FindRecord(localId), slot.PresenceType);
    }

    /// <summary>A plain break or lunch (no schedule today).</summary>
    public async Task<StartOutcome> TakeFreeBreakAsync(string presenceType)
    {
        if (_svc is null) return new StartOutcome.Refused("SIGNED_OUT", "Sign in first.");
        if (NotRunning() is { } refused) return refused;
        if (OnABreak) return new StartOutcome.Refused("ALREADY_ON_BREAK", "You're already on a break. End it first.");
        if (InAMeeting) return new StartOutcome.Refused("IN_MEETING", "You're in a meeting. End it first.");
        var type = presenceType == PresenceStatus.Lunch ? PresenceStatus.Lunch : PresenceStatus.Break;
        var (_, fate) = await RecordAsync(EventKinds.BreakFree, new EventPayload { PresenceType = type, LocalId = OfflineDay.NewLocalId() });
        if (fate is EventFate.Refused r) return new StartOutcome.Refused(r.Result.Code ?? "REFUSED", r.Result.Message ?? "That can't start right now.");
        return new StartOutcome.Started(null, type);
    }

    /// <summary>A quick break (4.0): any time the day is open and nothing else runs; 5, 10 or 15 minutes.</summary>
    public async Task<ActionOutcome> QuickBreakAsync(int plannedMin)
    {
        if (_svc is null) return new ActionOutcome.Refused("SIGNED_OUT", "Sign in first.");
        if (NotRunning() is { } refused) return new ActionOutcome.Refused(refused.Code, refused.Message);
        if (OnABreak) return new ActionOutcome.Refused("ON_BREAK", "You're already on a break. End it first.");
        if (InAMeeting) return new ActionOutcome.Refused("IN_MEETING", "You're in a meeting. End it first.");
        var minutes = Math.Clamp(plannedMin, 1, 60);
        var localId = OfflineDay.NewLocalId();
        var (_, fate) = await RecordAsync(EventKinds.BreakQuick, new EventPayload { PlannedMin = minutes, LocalId = localId });
        if (fate is EventFate.Refused r) return new ActionOutcome.Refused(r.Result.Code ?? "REFUSED", r.Result.Message ?? "The quick break couldn't start.");
        _log.Info("breaks", $"quick break of {minutes} min");
        return new ActionOutcome.Done(FindRecord(localId));
    }

    /// <summary>Pauses the scheduled break running now (4.0): focus restarts; it can be resumed inside its window.</summary>
    public async Task<ActionOutcome> PauseBreakAsync()
    {
        if (_svc is null) return new ActionOutcome.Refused("SIGNED_OUT", "Sign in first.");
        var active = BreakPanel.Active;
        if (active is null) return new ActionOutcome.Refused("NOT_ACTIVE", "No break is running.");
        if (!active.CanPause || active.Id is null) return new ActionOutcome.Refused("NOT_PAUSABLE", "Only a scheduled break can be paused.");
        var (_, fate) = await RecordAsync(EventKinds.BreakPause, new EventPayload { TargetId = active.Id });
        if (fate is EventFate.Refused r) return new ActionOutcome.Refused(r.Result.Code ?? "REFUSED", r.Result.Message ?? "The break couldn't be paused.");
        _log.Info("breaks", $"paused {active.Kind}");
        return new ActionOutcome.Done(FindRecord(active.Id));
    }

    /// <summary>Resumes the paused break (4.0): only before its window closes, with nothing else running.</summary>
    public async Task<ActionOutcome> ResumeBreakAsync()
    {
        if (_svc is null) return new ActionOutcome.Refused("SIGNED_OUT", "Sign in first.");
        if (NotRunning() is { } refused) return new ActionOutcome.Refused(refused.Code, refused.Message);
        var panel = BreakPanel;
        var paused = panel.Paused;
        if (paused?.Record is null)
        {
            // Paused, and its window closed meanwhile (the panel shows it as taken now): say so,
            // with the time, as the server does (409 RESUME_WINDOW_CLOSED), not "nothing paused".
            var closed = panel.Slots.FirstOrDefault(s => s.Record is { IsPaused: true } && _clock.UtcNow >= s.WindowClose);
            return closed is not null
                ? new ActionOutcome.Refused("RESUME_WINDOW_CLOSED", $"Its window closed at {closed.LocalWindowClose}, so it can't be resumed.")
                : new ActionOutcome.Refused("NOT_PAUSED", "No break is paused.");
        }
        if (_clock.UtcNow >= paused.WindowClose)
            return new ActionOutcome.Refused("RESUME_WINDOW_CLOSED", $"Its window closed at {paused.LocalWindowClose}, so it can't be resumed.");
        if (OnABreak) return new ActionOutcome.Refused("ON_BREAK", "You're on another break. End it first.");
        if (InAMeeting) return new ActionOutcome.Refused("IN_MEETING", "You're in a meeting. End it first.");
        var (_, fate) = await RecordAsync(EventKinds.BreakResume, new EventPayload { TargetId = paused.Record.Id });
        if (fate is EventFate.Refused r) return new ActionOutcome.Refused(r.Result.Code ?? "REFUSED", r.Result.Message ?? "The break couldn't be resumed.");
        _log.Info("breaks", $"resumed {paused.Kind}");
        return new ActionOutcome.Done(FindRecord(paused.Record.Id));
    }

    /// <summary>Skips a scheduled break (a reason unless a Super Admin). Focus time keeps counting.</summary>
    public async Task<SkipOutcome> SkipBreakAsync(string kind, string? reason)
    {
        if (_svc is null) return new SkipOutcome.Refused("SIGNED_OUT", "Sign in first.");
        if (NotRunning() is { } refused) return new SkipOutcome.Refused(refused.Code, refused.Message);
        var panel = BreakPanel;
        var slot = panel.Slots.FirstOrDefault(s => s.Kind == kind);
        if (slot is null) return new SkipOutcome.Refused("BREAK_NOT_SCHEDULED", "That break isn't in your shift today.");
        if (!slot.CanSkip) return new SkipOutcome.Refused(slot.AllowSkip ? "BREAK_WINDOW_CLOSED" : "SKIP_NOT_ALLOWED",
            slot.AllowSkip ? "That break can't be skipped right now." : "Your shift doesn't allow skipping this break.");
        var superAdmin = User?.Role == "SUPER_ADMIN";
        if (!superAdmin && ReasonText.Clean(reason).Length < panel.MinChars)
            return new SkipOutcome.NeedsReason(panel.MinChars, $"Add a reason of {panel.MinChars} characters or more.");
        var (_, fate) = await RecordAsync(EventKinds.BreakSkip, new EventPayload { BreakKind = kind, Reason = ReasonText.Clean(reason), LocalId = OfflineDay.NewLocalId() });
        if (fate is EventFate.Refused r) return BreakService.SkipRefusal(r.Result, panel.MinChars);
        _log.Info("breaks", $"skipped {kind}");
        return new SkipOutcome.Skipped(BreakPanel.Slots.FirstOrDefault(s => s.Kind == kind)?.Record);
    }

    /// <summary>The comment for a skip that has none (an auto-skip, from today or an earlier day).</summary>
    public async Task<CommentOutcome> CommentBreakAsync(string breakId, string comment)
    {
        if (_svc?.Api.CurrentUser is null) return new CommentOutcome.Refused("SIGNED_OUT", "Sign in first.");
        var panel = BreakPanel;
        var listed = Workday?.SkipsNeedingComment.FirstOrDefault(s => s.Id == breakId);
        var minChars = Math.Max(1, listed?.MinChars ?? panel.MinChars);
        if (ReasonText.Clean(comment).Length < minChars)
            return new CommentOutcome.NeedsReason(minChars, $"Add a little more for your manager ({minChars} characters or more).");
        var inSlot = panel.Slots.Any(s => s.Record?.Id == breakId);
        if (listed is null && !inSlot) return new CommentOutcome.NotNeeded("That break already has a comment, or is no longer waiting for one.");
        var (_, fate) = await RecordAsync(EventKinds.BreakComment, new EventPayload { TargetId = breakId, Comment = ReasonText.Clean(comment) });
        if (fate is EventFate.Refused r) return BreakService.CommentRefusal(r.Result, minChars);
        _log.Info("breaks", "comment added to a skipped break");
        return new CommentOutcome.Saved(null);
    }

    /// <summary>
    /// End break (4.0: always confirmed in the UI first; no "count the minutes over"
    /// step: the buffer covers overruns) or Meeting ended. Ends a running break, a
    /// quick one, or a paused one.
    /// </summary>
    public async Task<EndOutcome> BackToWorkAsync(string? overrunReason = null, bool? askToCount = null)
    {
        if (_svc is null) return new EndOutcome.Refused("Sign in first.");
        var panel = BreakPanel;
        if (panel.Active is null && panel.Paused is null && Presence.Status == PresenceStatus.Meeting) return await EndMeetingAsync();
        if (panel.Active is null && panel.Paused is null && Presence.Status is not (PresenceStatus.Break or PresenceStatus.Lunch))
            return new EndOutcome.NothingRunning();
        var id = panel.Active?.Id ?? panel.Paused?.Record?.Id;
        var (_, fate) = await RecordAsync(EventKinds.BreakEnd, new EventPayload { TargetId = id });
        if (fate is EventFate.Refused r) return new EndOutcome.Refused(r.Result.Message ?? "Couldn't end the break.");
        _log.Info("breaks", "break ended");
        return new EndOutcome.Ended(id is null ? null : FindRecord(id));
    }

    /// <summary>Meeting ended.</summary>
    public async Task<EndOutcome> EndMeetingAsync()
    {
        if (_svc is null) return new EndOutcome.Refused("Sign in first.");
        var live = LiveMeeting;
        if (live is null && Presence.Status != PresenceStatus.Meeting) return new EndOutcome.NothingRunning();
        var (_, fate) = await RecordAsync(EventKinds.MeetingEnd, new EventPayload { TargetId = live?.Id });
        if (fate is EventFate.Refused r && r.Result.Status != 404) return new EndOutcome.Refused(r.Result.Message ?? "Couldn't end the meeting.");
        var ended = live is null ? null : _day.View.Meetings.FirstOrDefault(m => m.Id == live.Id);
        var discarded = live is not null && ended is null;
        _log.Info("meetings", discarded ? "meeting ended under a minute; not kept" : "meeting ended");
        return new EndOutcome.MeetingEnded(ended ?? live, discarded);
    }

    /// <summary>Starts a live meeting with its agenda, people and who will mail the minutes (focus time keeps counting).</summary>
    public async Task<MeetingOutcome> StartMeetingAsync(string agenda, IReadOnlyList<MeetingParticipant> participants, string? momSender = null)
    {
        if (_svc is null) return new MeetingOutcome.Refused("SIGNED_OUT", "Sign in first.");
        if (NotRunning() is { } refused) return new MeetingOutcome.Refused(refused.Code, refused.Message);
        if (OnABreak) return new MeetingOutcome.Refused("ON_BREAK", "End your break first.");
        if (InAMeeting) return new MeetingOutcome.Refused("MEETING_IN_PROGRESS", "You're already in a meeting.");
        if (MeetingProblem(agenda, momSender) is { } invalid) return invalid;
        var localId = OfflineDay.NewLocalId();
        var (_, fate) = await RecordAsync(EventKinds.MeetingStart, new EventPayload
        {
            LocalId = localId,
            Agenda = ReasonText.Clean(agenda),
            Participants = ApiClient.CleanParticipants(participants),
            MomSender = ApiClient.CleanName(momSender),
        });
        if (fate is EventFate.Refused r) return MeetingService.Failed(r.Result, "Couldn't start the meeting.");
        _log.Info("meetings", $"started a meeting with {participants.Count} people");
        return new MeetingOutcome.Started(FindMeeting(localId) ?? LiveMeeting);
    }

    /// <summary>Logs a meeting that already happened today (inside the working day, before now, overlapping nothing).</summary>
    public async Task<MeetingOutcome> LogPastMeetingAsync(DateTimeOffset startedAt, int durationMin, string agenda,
        IReadOnlyList<MeetingParticipant> participants, string? momSender = null)
    {
        if (_svc is null) return new MeetingOutcome.Refused("SIGNED_OUT", "Sign in first.");
        if (NotRunning() is { } refused) return new MeetingOutcome.Refused(refused.Code, refused.Message);
        if (MeetingProblem(agenda, momSender) is { } invalid) return invalid;
        var end = startedAt.AddMinutes(durationMin);
        if (Workday?.StartedAt is { } dayStart && startedAt < dayStart)
            return new MeetingOutcome.Invalid("MEETING_OUTSIDE_DAY", "That time is outside your working day.", null);
        if (end > _clock.UtcNow.AddMinutes(1))
            return new MeetingOutcome.Invalid("MEETING_IN_FUTURE", "That runs past now.", null);
        var now = _clock.UtcNow;
        if (_day.View.Breaks is { } breaks)
        {
            foreach (var record in DayProjection.AllBreakRecords(breaks).Where(b => !b.IsSkip))
            {
                foreach (var seg in DayProjection.SegmentsOf(record))
                {
                    var segEnd = seg.EndedAt ?? now;
                    if (seg.StartedAt < end && segEnd > startedAt)
                        return new MeetingOutcome.Invalid("MEETING_OVERLAPS_BREAK", "That overlaps a break.",
                            new MeetingClash { Kind = record.PresenceType, StartedAt = seg.StartedAt, EndedAt = segEnd });
                }
            }
        }
        foreach (var m in _day.View.Meetings)
        {
            var mEnd = m.EndedAt ?? now;
            if (m.StartedAt < end && mEnd > startedAt)
                return new MeetingOutcome.Invalid("MEETING_OVERLAPS_MEETING", "That overlaps another meeting.",
                    new MeetingClash { Kind = "MEETING", StartedAt = m.StartedAt, EndedAt = mEnd });
        }
        var localId = OfflineDay.NewLocalId();
        var (_, fate) = await RecordAsync(EventKinds.MeetingPast, new EventPayload
        {
            LocalId = localId,
            StartedAt = startedAt,
            DurationMin = durationMin,
            Agenda = ReasonText.Clean(agenda),
            Participants = ApiClient.CleanParticipants(participants),
            MomSender = ApiClient.CleanName(momSender),
        });
        if (fate is EventFate.Refused r) return MeetingService.Failed(r.Result, "Couldn't log the meeting.");
        _log.Info("meetings", $"logged an earlier meeting of {durationMin} min");
        return new MeetingOutcome.Logged(FindMeeting(localId));
    }

    /// <summary>4.0: an agenda, and who will mail the minutes (2 to 80 characters).</summary>
    private static MeetingOutcome? MeetingProblem(string agenda, string? momSender)
    {
        if (ReasonText.Clean(agenda).Length == 0) return new MeetingOutcome.Invalid("VALIDATION", "Add what the meeting is about.", null);
        var mom = ReasonText.Clean(momSender);
        if (mom.Length < 2 || mom.Length > ApiClient.MaxMomSender)
            return new MeetingOutcome.Invalid("MOM_SENDER_REQUIRED", "Add who will mail the minutes (2 to 80 characters).", null);
        return null;
    }

    /// <summary>People for the meeting picker, or null when the server can't be asked (free names still work).</summary>
    public async Task<IReadOnlyList<ParticipantOption>?> SearchParticipantsAsync(string? query)
    {
        var svc = _svc;
        if (svc?.Api.CurrentUser is null) return null;
        return await svc.Meetings.SearchAsync(query);
    }

    /// <summary>Presence and the day's totals from the server (used where the day has no record of them).</summary>
    public async Task RefreshPresenceAsync()
    {
        var svc = _svc;
        if (svc is null || !svc.Api.IsSignedIn) return;
        var stamp = _day.Stamp();
        var current = await svc.Api.GetCurrentPresenceAsync();
        var today = await svc.Api.GetPresenceTodayAsync();
        _day.AdoptPresence(current.Ok ? current.Data : null, today.Ok ? today.Data?.Totals : null, stamp);
        PresenceChanged?.Invoke(Presence);
    }

    /// <summary>The month's days, meetings and away entries (SPEC 2.7); the last answer while offline.</summary>
    public async Task<(HistoryMonth? History, bool Fresh)> GetHistoryAsync(string month)
    {
        var svc = _svc;
        if (svc is null || !svc.Api.IsSignedIn) return (_day.CachedHistory(month), false);
        var result = await svc.Api.GetHistoryAsync(month);
        if (result.Ok && result.Data is { } history)
        {
            if (string.IsNullOrEmpty(history.Month)) history.Month = month;
            _day.CacheHistory(history);
            return (history, true);
        }
        return (_day.CachedHistory(month), false);
    }

    /// <summary>
    /// An update this app cannot install by itself: saves the verified build to
    /// the Downloads folder and returns where, so the person can install it.
    /// </summary>
    public async Task<ManualDownload> DownloadUpdateAsync()
    {
        var svc = _svc;
        if (svc is null) return new ManualDownload(null, "Sign in to download the update.");
        return await svc.Updates.DownloadForManualInstallAsync();
    }

    private BreakRecord? FindRecord(string id)
    {
        var breaks = _day.View.Breaks;
        if (breaks is null) return null;
        var resolved = _day.Resolve(id);
        return DayProjection.AllBreakRecords(breaks).Concat(breaks.ActiveBreak is { } a ? new[] { a } : Array.Empty<BreakRecord>())
            .FirstOrDefault(r => r.Id == id || r.Id == resolved);
    }

    /// <summary>A meeting of today by the id it was created with here (shown with the server's id once it took it).</summary>
    private MeetingRecord? FindMeeting(string id)
    {
        var resolved = _day.Resolve(id);
        return _day.View.Meetings.FirstOrDefault(m => m.Id == id || m.Id == resolved);
    }

    private static string Lower(string label) => string.IsNullOrEmpty(label) ? label : char.ToLowerInvariant(label[0]) + label[1..];

    // ---- Away (4.0) ----------------------------------------------------------------------

    private void StartAwayWatch()
    {
        Interlocked.Exchange(ref _lastActiveTicks, _clock.UtcNow.UtcTicks);
        lock (_gate)
        {
            _awayTimer?.Dispose();
            _awayTimer = new Timer(_ => Guard("away", AwayTick), null, AwaySampleEvery, AwaySampleEvery);
        }
    }

    /// <summary>Tests: the last input seen (as if the agent had been watching since then).</summary>
    internal void SetLastActiveForTests(DateTimeOffset at) => Interlocked.Exchange(ref _lastActiveTicks, at.UtcTicks);

    /// <summary>Samples input (every few seconds) and opens the away pop-up when the rule says so.</summary>
    internal void AwayTick()
    {
        var now = _clock.UtcNow;
        bool locked;
        TimeSpan idle;
        try { locked = _platform.Lock.IsLocked; } catch { locked = false; }
        try { idle = _platform.Idle.IdleTime(); } catch { idle = TimeSpan.Zero; }
        var lastActive = new DateTimeOffset(Interlocked.Read(ref _lastActiveTicks), TimeSpan.Zero);
        lastActive = AwayRule.LastActive(lastActive, now, idle, locked);
        Interlocked.Exchange(ref _lastActiveTicks, lastActive.UtcTicks);
        if (_day.AwaySince is not null || State != AgentState.Running) return;

        var config = IdleConfig;
        if (!AwayRule.ShouldOpen(config, onBreak: OnABreak, inMeeting: InAMeeting, lastActive, now)) return;
        var start = AwayRule.BoundStart(lastActive, Workday, _day.View.Breaks, _day.View.Meetings);
        _log.Info("away", $"away since {start:HH:mm:ss}Z (no input for {(now - lastActive).TotalMinutes:F0} min{(locked ? ", locked" : "")}); asking why");
        SetAway(start);
    }

    private void SetAway(DateTimeOffset? since)
    {
        if (_day.AwaySince == since) return;
        _day.SetAway(since);
        try { AwayChanged?.Invoke(); }
        catch (Exception ex) { _log.Error("away", "an away handler failed", ex); }
        WorkdayChanged?.Invoke();
    }

    /// <summary>The day stopped (ended, not started): an open pop-up has nothing to ask about.</summary>
    private void CloseAwayQuietly()
    {
        if (_day.UserId is not null && _day.AwaySince is not null) SetAway(null);
    }

    /// <summary>
    /// The person says why they were away (SPEC 2.5). "Took a break" opens a quick break
    /// from the away start (the pop-up then shows "On a break"); every other reason is
    /// recorded for approval and the pop-up closes.
    /// </summary>
    public async Task<AwayOutcome> AnswerAwayAsync(AwayAnswer answer)
    {
        if (_svc is null) return new AwayOutcome.Refused("Sign in first.");
        var since = _day.AwaySince;
        if (since is null) return new AwayOutcome.Refused("Nothing to answer.");
        var reasons = IdleConfig?.Reasons is { Count: > 0 } r ? r : AwayKinds.Defaults();
        var reason = reasons.FirstOrDefault(x => x.Key == answer.ReasonKey);
        if (reason is null) return new AwayOutcome.Invalid("Pick a reason.", new[] { "reasonKey" });
        if (AwayRule.Problem(reason.Kind, answer) is { } problem) return problem;

        var payload = new EventPayload
        {
            StartedAt = since,
            ReasonKey = reason.Key,
            ReasonKind = reason.Kind,
            ReasonLabel = reason.Label,
            Comment = reason.Kind == AwayKinds.Break ? null : ReasonText.Clean(answer.Comment),
            Participants = reason.Kind == AwayKinds.Meeting ? ApiClient.CleanParticipants(answer.Participants) : null,
            MomSender = reason.Kind == AwayKinds.Meeting ? ApiClient.CleanName(answer.MomSender) : null,
            LocalId = reason.Kind == AwayKinds.Break ? OfflineDay.NewLocalId() : null,
        };
        SetAway(null);
        var (_, fate) = await RecordAsync(EventKinds.Away, payload);
        if (fate is EventFate.Refused { Result.Code: "AWAY_OVERLAP" } overlap && OverlapEnd(overlap.Result, since.Value) is { } after)
        {
            // The server has the earlier answer ending later than it ended here: it reached the
            // server a few seconds late and was timed when it arrived (an action under 30 s old
            // runs at the server's time). This stretch starts where that one ends.
            _log.Info("away", $"the server's earlier away time ends at {after:HH:mm:ss}Z, after this one's start; starting it there");
            payload = new EventPayload
            {
                StartedAt = after,
                ReasonKey = payload.ReasonKey,
                ReasonKind = payload.ReasonKind,
                ReasonLabel = payload.ReasonLabel,
                Comment = payload.Comment,
                Participants = payload.Participants,
                MomSender = payload.MomSender,
                LocalId = payload.LocalId,
            };
            (_, fate) = await RecordAsync(EventKinds.Away, payload);
        }
        if (fate is EventFate.Refused refused)
        {
            // Ask again, with the same start.
            SetAway(since);
            var fields = refused.Result.Detail<List<string>>("fields") ?? new List<string>();
            return refused.Result.Code == "AWAY_FIELDS"
                ? new AwayOutcome.Invalid(refused.Result.Message ?? "Some details are missing.", fields)
                : new AwayOutcome.Refused(refused.Result.Message ?? "That answer couldn't be saved.");
        }
        _log.Info("away", $"away answered: {reason.Kind}");
        Interlocked.Exchange(ref _lastActiveTicks, _clock.UtcNow.UtcTicks);
        return reason.Kind == AwayKinds.Break ? new AwayOutcome.OnBreak() : new AwayOutcome.Recorded();
    }

    /// <summary>
    /// 409 AWAY_OVERLAP names the away time already recorded (details.existing): when it
    /// started before this stretch and ends after its start, but before now, this stretch can
    /// start at its end instead. Null otherwise (a real overlap: the answer is refused).
    /// </summary>
    private DateTimeOffset? OverlapEnd(ApiResult<JsonElement> refused, DateTimeOffset since)
    {
        var existing = refused.Detail<AwayEntry>("existing");
        if (existing?.EndedAt is not { } end || existing.StartedAt > since) return null;
        return end > since && end < _clock.UtcNow ? end : null;
    }

    // ---- Ring -----------------------------------------------------------------------------

    private void StartBreakTimers()
    {
        _breakRefresh?.Dispose();
        _breakRefresh = new Timer(_ => Guard("breaks", () =>
        {
            // Every 15 minutes, and straight away when the date changes at midnight.
            var svc = _svc;
            if (svc is null) return;
            var today = DateTime.Now.Date;
            var newDate = today != _localDate;
            if (newDate || DateTimeOffset.UtcNow - svc.Breaks.LastRefresh > TimeSpan.FromMinutes(15))
            {
                _localDate = today;
                _ = SafeAsync("breaks", FetchBreaksAsync);
                if (newDate)
                {
                    lock (_ringGate) _closedWindows.Clear();
                    _day.Rebuild();
                    _ = SafeAsync("day", () => DayCheckAsync(greet: false));
                }
            }
        }), null, TimeSpan.FromMinutes(1), TimeSpan.FromMinutes(1));

        MarkAlive();
        _ringTimer?.Dispose();
        _ringTimer = new Timer(_ => Guard("ring", CheckRing), null, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1));
    }

    /// <summary>Raises RingChanged on transitions and plays the chime while ringing (until acknowledged).</summary>
    private readonly object _ringGate = new();

    private void CheckRing()
    {
        NoteResumeIfAny();
        lock (_ringGate) CheckRingLocked();
    }

    private void CheckRingLocked()
    {
        if (_svc is null) return;
        var now = _clock.UtcNow;
        var panel = BreakPanel;
        var date = _day.View.Breaks?.Date ?? "";
        var ring = State is AgentState.Running or AgentState.NeedsNotice ? panel.Ring : null;
        var key = ring is null ? null : $"{date}|{ring.Kind}";
        if (key != _ringKey)
        {
            _ringKey = key;
            Ring = ring;
            _lastChime = DateTimeOffset.MinValue;
            RingChanged?.Invoke(ring);
        }
        bool chime;
        lock (_acknowledgedRings) chime = ring is { Sound: true } && !_acknowledgedRings.Contains(key!);
        if (chime && DateTimeOffset.UtcNow - _lastChime >= TimeSpan.FromSeconds(20))
        {
            _lastChime = DateTimeOffset.UtcNow;
            try { _platform.Sound.PlayChime(); } catch { }
        }
        WatchClosedWindows(panel, now);
    }

    /// <summary>
    /// A window that just closed untaken while the day runs is auto-skipped by the
    /// server when it is next asked: ask a few seconds after it closes (and twice more
    /// a minute apart if that fails), so the row and the toast come at once.
    /// </summary>
    private void WatchClosedWindows(BreakPanel panel, DateTimeOffset now)
    {
        if (State != AgentState.Running) return;
        var date = _day.View.Breaks?.Date;
        foreach (var slot in panel.Slots)
        {
            if (slot.State != SlotState.Closed) continue;
            if (now < slot.WindowClose.AddSeconds(3) || now > slot.WindowClose.AddMinutes(10)) continue;
            var key = $"{date}|{slot.Kind}";
            _closedWindows.TryGetValue(key, out var seen);
            if (seen.Attempts >= 3 || now - seen.Last < TimeSpan.FromSeconds(60)) continue;
            _closedWindows[key] = (seen.Attempts + 1, now);
            _ = SafeAsync("breaks", FetchBreaksAsync);
        }
    }

    /// <summary>The person opened the agent while it rang: stop the sound (the ring stays visible).</summary>
    public void AcknowledgeRing()
    {
        if (Ring is not { } r) return;
        var date = _day.View.Breaks?.Date ?? "";
        lock (_acknowledgedRings) _acknowledgedRings.Add($"{date}|{r.Kind}");
    }

    // ---- Sign-out and quit (4.0: an admin's key) ----------------------------------------

    /// <summary>
    /// Sign out with an admin's key (SPEC 2.8): everything recorded goes to the server
    /// first (the journal must be empty, and the samples sent); then the key is checked;
    /// only then is this device's data cleared. Needs the internet.
    /// </summary>
    public async Task<KeyOutcome> SignOutWithKeyAsync(string key)
    {
        var svc = _svc;
        if (svc?.Api.CurrentUser is null) return new KeyOutcome.Refused("Sign in first.");
        if (ApiClient.NormaliseKey(key).Length == 0) return new KeyOutcome.WrongKey("Enter the key from your admin.");
        if (await EnsureSyncedAsync() is { } notSynced) return notSynced;

        var result = await svc.Api.SignOutWithKeyAsync(key);
        if (KeyFailure(result) is { } failed) return failed;
        _log.Info("session", "signed out with an admin's key");
        await ClearSessionAsync(clearData: true, callLogout: false);
        return new KeyOutcome.Accepted();
    }

    /// <summary>Quit for an Admin or Super Admin, with a key (SPEC 2.8). Nothing is cleared.</summary>
    public async Task<KeyOutcome> QuitCheckAsync(string key)
    {
        var svc = _svc;
        if (svc?.Api.CurrentUser is null) return new KeyOutcome.Accepted();
        if (ApiClient.NormaliseKey(key).Length == 0) return new KeyOutcome.WrongKey("Enter the key from your admin.");
        var result = await svc.Api.QuitCheckAsync(key);
        if (KeyFailure(result) is { } failed) return failed;
        _log.Info("session", "quit allowed with a key");
        return new KeyOutcome.Accepted();
    }

    /// <summary>Everything sent (actions, then samples), or why not.</summary>
    private async Task<KeyOutcome.NotSynced?> EnsureSyncedAsync()
    {
        var left = await SyncNowAsync(TimeSpan.FromSeconds(20));
        if (left > 0)
            return new KeyOutcome.NotSynced(left, PendingSamples, Online
                ? $"{left} action(s) are still being sent. Try again in a moment."
                : "You're offline. Signing out needs the internet: everything you did must reach RX Vision first.");
        var tracker = _tracker;
        if (_queue is { Count: > 0 } && tracker is not null)
        {
            try { await tracker.FlushAsync(TimeSpan.FromSeconds(15)); }
            catch (Exception ex) { _log.Warn("activity", "sending samples before sign-out failed", ex); }
        }
        if (_queue is { Count: > 0 } q)
        {
            // They go at the server's pace (SendPacer): say how long that is.
            var minutes = (int)Math.Ceiling(q.Count / (double)SendPacer.PerMinute);
            return new KeyOutcome.NotSynced(0, q.Count, Online
                ? minutes <= 1
                    ? $"{q.Count} activity sample(s) are still being sent. Try again in a moment."
                    : $"{q.Count} activity samples are still being sent, about {minutes} minutes. Try again then."
                : "You're offline. Signing out needs the internet: everything you did must reach RX Vision first.");
        }
        return null;
    }

    private static KeyOutcome? KeyFailure(ApiResult<JsonElement> result)
    {
        if (result.Ok) return null;
        // 429 is no network trouble here: it is too many wrong keys.
        if (result.Status == 429)
            return new KeyOutcome.TooManyTries(result.Message is { Length: > 0 } m && result.Code is not null ? m : "Too many wrong keys. Wait 10 minutes and try again.");
        if (result.Status == 403 || result.Code == "SIGNOUT_KEY_INVALID")
            return new KeyOutcome.WrongKey("That key isn't valid for you. Check it with your admin (keys work for 24 hours).");
        if (result.Transient) return new KeyOutcome.Offline("Can't reach RX Vision. Signing out needs the internet.");
        return new KeyOutcome.Refused(result.Message ?? "The key was refused.");
    }

    /// <summary>
    /// Signs out here without a key (3.x behaviour; tests and a lost session only). The
    /// journal and samples are kept on disk: they go out at the next sign-in as this person.
    /// </summary>
    internal Task SignOutAsync() => ClearSessionAsync(clearData: false, callLogout: true);

    private async Task ClearSessionAsync(bool clearData, bool callLogout, bool keepAutostart = false)
    {
        _handover.Reset();
        _log.Info("session", clearData ? "sign-out: clearing this device's data" : "sign-out");
        Interlocked.Increment(ref _sessionGen);
        StopTracking();
        StopNudges();
        _sync.Stop();
        if (_tracker is not null)
        {
            if (!clearData) await _tracker.FlushAsync(TimeSpan.FromSeconds(5));
            _tracker.Dispose();
            _tracker = null;
        }
        _platform.Lock.Changed -= OnLockChanged;
        var svc = _svc;
        if (svc is not null)
        {
            svc.StopAll();
            svc.Breaks.Reset();
            svc.Chat.Reset();
            svc.Workday.Reset();
            svc.Meetings.Reset();
            svc.Approvals.Reset();
            if (callLogout) await svc.Api.LogoutAsync();
            else svc.Api.DropSession();
        }
        if (clearData)
        {
            // Only after everything reached the server (a key sign-out).
            _day.DeleteFiles();
            _queue?.Clear();
            DeleteQueues();
        }
        _day.Close();
        _queue = null;
        _queueUserId = null;
        _sessions.ClearEnrollment();
        _enrollment = null;
        _dayKnown = false;
        _greetedDate = null;
        _biometricRefused = false;
        // A shared computer stays set up for the next person: the app starts with Windows.
        if (!keepAutostart)
        {
            try { _platform.Autostart.Disable(); } catch { }
        }
        StopTimers();
        SetState(AgentState.SignIn);
    }

    private async Task OnSessionLostAsync(string reason)
    {
        _handover.Reset();
        _biometricRefused = false;
        Interlocked.Increment(ref _sessionGen);
        StopTracking();
        StopNudges();
        _sync.Stop();
        _svc?.StopAll();
        StopTimers();
        _svc?.Api.DropSession();
        if (_svc is { } svc)
        {
            // Whoever signs in next starts clean (it may be someone else on this machine);
            // this person's journal and samples stay on disk for their next sign-in.
            svc.Breaks.Reset();
            svc.Chat.Reset();
            svc.Workday.Reset();
            svc.Meetings.Reset();
            svc.Approvals.Reset();
        }
        _day.Close();
        _dayKnown = false;
        SetState(AgentState.SignIn);
        SignedOutUnexpectedly?.Invoke(reason);
        // A per-user build can sign itself back in: keep trying in the background.
        if (_enrollment is not null)
        {
            SetState(AgentState.Connecting);
            ScheduleReconnect(null);
        }
        await Task.CompletedTask;
    }

    private void DeleteQueues()
    {
        try
        {
            var user = _queueUserId;
            foreach (var f in Directory.EnumerateFiles(_platform.Paths.DataDir, "queue-*.bin")) HiddenFile.Delete(f);
        }
        catch { }
    }

    private void StopTimers()
    {
        _breakRefresh?.Dispose(); _breakRefresh = null;
        _ringTimer?.Dispose(); _ringTimer = null;
        lock (_gate)
        {
            _dayCheck?.Dispose(); _dayCheck = null;
            _handoverTimer?.Dispose(); _handoverTimer = null;
            _pendingTimer?.Dispose(); _pendingTimer = null;
            _nudgeTimer?.Dispose(); _nudgeTimer = null;
            _awayTimer?.Dispose(); _awayTimer = null;
            _drainTimer?.Dispose(); _drainTimer = null;
        }
        _reconnect?.Dispose(); _reconnect = null;
        StopStoreRetry();
        lock (_ringGate) _closedWindows.Clear();
        lock (_acknowledgedRings) _acknowledgedRings.Clear();
        lock (_toldScopes) _toldScopes.Clear();
        _heldEndDay = null;
        if (Ring is not null)
        {
            Ring = null;
            _ringKey = null;
            RingChanged?.Invoke(null);
        }
    }

    private void SetState(AgentState next)
    {
        if (_state == next) return;
        _state = next;
        _log.Info("state", next.ToString());
        StateChanged?.Invoke(next);
    }

    /// <summary>Stops everything before the app exits (the journal, the day and queued samples stay on disk).</summary>
    public void Shutdown()
    {
        _lifetime.Cancel();
        _sync.Stop();
        StopTracking();
        StopTimers();
        _svc?.StopAll();
        try { _platform.Lock.Stop(); } catch { }
    }

    public void Dispose()
    {
        Shutdown();
        _tracker?.Dispose();
        _svc?.Dispose();
        _sync.Dispose();
        _lifetime.Dispose();
    }
}

/// <summary>A random id for this install, sent with every request (multi-device users).</summary>
public static class DeviceId
{
    public static string Get(string dataDir)
    {
        var path = Path.Combine(dataDir, "device-id");
        try
        {
            if (File.Exists(path))
            {
                var existing = File.ReadAllText(path).Trim();
                if (Guid.TryParse(existing, out _)) return existing;
            }
            var id = Guid.NewGuid().ToString();
            AtomicFile.WriteAllBytes(path, System.Text.Encoding.UTF8.GetBytes(id));
            return id;
        }
        catch
        {
            return Guid.NewGuid().ToString();
        }
    }
}
