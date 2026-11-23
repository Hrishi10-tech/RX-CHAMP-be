using System.Globalization;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Update;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels.Dialogs;

namespace RXVision.Agent.UI.Tests;

/// <summary>13 Oct 2026 in IST (UTC+05:30), the business time zone of the test days.</summary>
public static class Ist
{
    public static readonly TimeSpan Offset = TimeSpan.FromHours(5.5);

    public static DateTimeOffset At(string hm)
    {
        var parts = hm.Split(':').Select(int.Parse).ToArray();
        return new DateTimeOffset(2026, 10, 13, parts[0], parts[1], parts.Length > 2 ? parts[2] : 0, Offset);
    }
}

/// <summary>Break days like the server sends: General shift 09:30 to 18:30, breaks 11:00, 13:00, 16:00.</summary>
public static class Days
{
    public static BreakSlot Slot(string kind, string start, int duration, int before = 30, int after = 60, int lead = 1, int ring = 5)
    {
        var s = Ist.At(start);
        string Hm(DateTimeOffset t) => t.ToString("HH:mm", CultureInfo.InvariantCulture);
        return new BreakSlot
        {
            Kind = kind,
            Label = kind switch { "MORNING" => "Morning break", "LUNCH" => "Lunch break", _ => "Evening break" },
            PresenceType = kind == "LUNCH" ? "LUNCH" : "BREAK",
            DurationMin = duration,
            ScheduledStart = s.ToUniversalTime(),
            ScheduledEnd = s.AddMinutes(duration).ToUniversalTime(),
            WindowOpen = s.AddMinutes(-before).ToUniversalTime(),
            WindowClose = s.AddMinutes(after).ToUniversalTime(),
            RingStart = s.AddMinutes(-lead).ToUniversalTime(),
            RingEnd = s.AddMinutes(-lead + ring).ToUniversalTime(),
            Local = new BreakLocalTimes
            {
                Start = start,
                End = Hm(s.AddMinutes(duration)),
                WindowOpen = Hm(s.AddMinutes(-before)),
                WindowClose = Hm(s.AddMinutes(after)),
                RingStart = Hm(s.AddMinutes(-lead)),
                RingEnd = Hm(s.AddMinutes(-lead + ring)),
            },
        };
    }

    public static BreakDay General(ShiftRules? rules = null) => new()
    {
        Date = "2026-10-13",
        Timezone = "Asia/Kolkata",
        Mode = "SCHEDULED",
        Workday = true,
        Shift = new ShiftInfo { Id = "s1", Name = "General", Start = "09:30", End = "18:30", Rules = rules ?? new ShiftRules() },
        Source = "DEFAULT",
        ReasonMinChars = 10,
        Breaks = new List<BreakSlot>
        {
            Slot("MORNING", "11:00", 15).Skippable(),
            Slot("LUNCH", "13:00", 30),
            Slot("EVENING", "16:00", 15).Skippable(),
        },
    };

    /// <summary>The shift lets this break be skipped (3.1 default for morning and evening).</summary>
    public static BreakSlot Skippable(this BreakSlot slot, bool allow = true)
    {
        slot.AllowSkip = allow;
        return slot;
    }

    /// <summary>A skip record: SKIPPED with the person's reason, or AUTO_SKIPPED at the window's close.</summary>
    public static BreakRecord Skip(string kind, string at, bool auto, string? reason = null, string approval = "PENDING", int duration = 15)
    {
        var label = kind switch { "MORNING" => "Morning break", "LUNCH" => "Lunch break", _ => "Evening break" };
        return new BreakRecord
        {
            Id = kind.ToLowerInvariant() + (auto ? "-auto" : "-skip"),
            Date = "2026-10-13",
            Kind = kind,
            Label = label,
            PresenceType = kind == "LUNCH" ? "LUNCH" : "BREAK",
            DurationMin = duration,
            StartedAt = Ist.At(at).ToUniversalTime(),
            EndedAt = Ist.At(at).ToUniversalTime(),
            Outcome = auto ? BreakOutcomes.AutoSkipped : BreakOutcomes.Skipped,
            Timing = auto ? "OUTSIDE_WINDOW" : "ON_TIME",
            Reason = reason,
            ApprovalStatus = approval,
            NeedsComment = reason is null && approval == "PENDING",
        };
    }

    /// <summary>A skip still waiting for its comment, as the work day lists it.</summary>
    public static SkipNeedingComment NeedsComment(string kind, string at, string date = "2026-10-13", int minChars = 10) => new()
    {
        Id = kind.ToLowerInvariant() + "-auto",
        Date = date,
        Kind = kind,
        Label = kind switch { "MORNING" => "Morning break", "LUNCH" => "Lunch break", _ => "Evening break" },
        Outcome = BreakOutcomes.AutoSkipped,
        SkippedAt = Ist.At(at).ToUniversalTime(),
        DurationMin = kind == "LUNCH" ? 30 : 15,
        MinChars = minChars,
    };

    /// <summary>Today as GET /workday/me/today says it: open since 09:24, focus 1h 00m at 10:24.</summary>
    public static WorkdayToday Open(string startedAt = "09:24", string serverNow = "10:24", int focusSec = 3600, bool running = true) => new()
    {
        Date = "2026-10-13",
        ServerNow = Ist.At(serverNow).ToUniversalTime(),
        Timezone = "Asia/Kolkata",
        State = WorkdayStates.Open,
        StartedAt = Ist.At(startedAt).ToUniversalTime(),
        Sessions = new List<WorkSessionView> { new() { StartedAt = Ist.At(startedAt).ToUniversalTime() } },
        Focus = new FocusView { FocusSec = focusSec, Running = running, SpanSec = focusSec },
        Shift = new ShiftRef { Id = "s1", Name = "General", Start = "09:30", End = "18:30" },
        ExpectedSec = 8 * 3600,
        Settings = new WorkdaySettings { ApprovalSlaHours = 48, ReasonMinChars = 10 },
        PortalUrl = "https://app.rxvision.shop",
    };

    public static WorkdayToday NotStarted(string serverNow = "08:55") => new()
    {
        Date = "2026-10-13",
        ServerNow = Ist.At(serverNow).ToUniversalTime(),
        Timezone = "Asia/Kolkata",
        State = WorkdayStates.NotStarted,
        Shift = new ShiftRef { Id = "s1", Name = "General", Start = "09:30", End = "18:30" },
        ExpectedSec = 8 * 3600,
        PortalUrl = "https://app.rxvision.shop",
    };

    public static BreakDay Free() => new()
    {
        Date = "2026-10-13",
        Timezone = "Asia/Kolkata",
        Mode = "FREE",
        Workday = true,
    };

    public static BreakRecord Taken(string kind, string from, string to, string timing = "ON_TIME", string approval = "NOT_REQUIRED",
        int duration = 15, string? note = null, string? by = null)
    {
        var start = Ist.At(from);
        var end = Ist.At(to);
        var took = (int)(end - start).TotalSeconds;
        return new BreakRecord
        {
            Id = kind.ToLowerInvariant() + "-rec",
            Date = "2026-10-13",
            Kind = kind,
            Label = kind switch { "MORNING" => "Morning break", "LUNCH" => "Lunch break", _ => "Evening break" },
            PresenceType = kind == "LUNCH" ? "LUNCH" : "BREAK",
            DurationMin = duration,
            StartedAt = start.ToUniversalTime(),
            EndedAt = end.ToUniversalTime(),
            TookSec = took,
            OverrunSec = Math.Max(0, took - duration * 60),
            Timing = timing,
            ApprovalStatus = approval,
            DecisionNote = note,
            DecidedByName = by,
        };
    }

    public static BreakRecord Running(string kind, string from, int duration = 15, string timing = "ON_TIME", string approval = "NOT_REQUIRED") => new()
    {
        Id = kind.ToLowerInvariant() + "-run",
        Date = "2026-10-13",
        Kind = kind,
        Label = kind switch { "MORNING" => "Morning break", "LUNCH" => "Lunch break", _ => "Evening break" },
        PresenceType = kind == "LUNCH" ? "LUNCH" : "BREAK",
        DurationMin = duration,
        StartedAt = Ist.At(from).ToUniversalTime(),
        InProgress = true,
        Timing = timing,
        ApprovalStatus = approval,
    };

    /// <summary>A running break, set both on its slot and as the day's active break.</summary>
    public static BreakDay WithActive(this BreakDay day, BreakRecord record)
    {
        day.Breaks.Single(b => b.Kind == record.Kind).Record = record;
        day.ActiveBreak = record;
        return day;
    }

    public static BreakDay WithRecord(this BreakDay day, BreakRecord record)
    {
        day.Breaks.Single(b => b.Kind == record.Kind).Record = record;
        return day;
    }
}

/// <summary>A scripted agent: state, day and outcomes are set by the test; calls are recorded.</summary>
public sealed class FakeAgent : IAgent
{
    public FakeAgent(string now = "10:45")
    {
        Now = Ist.At(now);
        User = new PublicUser { Id = "u-1", Email = "asha@timechamp.test", FirstName = "Asha", LastName = "Kumar", Role = "USER" };
        Workday = Days.Open(serverNow: now);
        Totals = new PresenceTotals { BreakSec = 0, LunchSec = 0, MeetingSec = 30 * 60, OnlineSec = 4 * 3600 + 35 * 60 };
    }

    public AgentState State { get; set; } = AgentState.Running;
    public PublicUser? User { get; set; }
    public CurrentPresence Presence { get; set; } = new();
    public WorkdayToday? Workday { get; set; }
    public bool DayKnown { get; set; } = true;
    public string? SignInNotice { get; set; }
    public void SignInNoticeShown() => SignInNotice = null;
    public string? BuiltForHosts { get; set; }
    public string? UnsignedUpdatesNote { get; set; }
    public MeetingRecord? LiveMeeting { get; set; }

    // ---- 3.6: the status, the ring, the meeting cards, the flags ----
    public DayProgress? DayProgress { get; set; }
    public List<MeetingAlert> Alerts { get; set; } = new();
    public IReadOnlyList<MeetingAlert> MeetingAlerts => Alerts;
    public TimeSpan IdleFor { get; set; }
    private bool _noticePending;
    public bool NoticePending
    {
        get => _noticePending;
        set { _noticePending = value; NoticePendingChanged?.Invoke(); }
    }
    public event Action? NoticePendingChanged;
    public HashSet<string> FlagsOn { get; } = new();
    public bool FeatureOn(string name) => FlagsOn.Contains(name);
    public Queue<MeetingStatusOutcome> MeetingStatusOutcomes { get; } = new();
    public List<string> MeetingStartSources { get; } = new();
    public int ConfirmCalls { get; private set; }
    public List<MeetingAlertKind> DismissedAlerts { get; } = new();
    public int PanelClosedCalls { get; private set; }
    public event Action? DayProgressChanged;
    public event Action? MeetingAlertsChanged;
    public void RaiseDayProgress() => DayProgressChanged?.Invoke();
    public void RaiseMeetingAlerts() => MeetingAlertsChanged?.Invoke();

    public Task<MeetingStatusOutcome> StartMeetingStatusAsync(string source)
    {
        MeetingStartSources.Add(source);
        var outcome = MeetingStatusOutcomes.Count > 0 ? MeetingStatusOutcomes.Dequeue() : new MeetingStatusOutcome.Done(Progress(DayProgressStatus.Meeting));
        if (outcome is MeetingStatusOutcome.Done done)
        {
            DayProgress = done.Progress;
            Presence = new CurrentPresence { Status = done.Progress.InMeeting ? PresenceStatus.Meeting : PresenceStatus.Working, Since = Now };
        }
        return Task.FromResult(outcome);
    }

    public Task<MeetingStatusOutcome> ConfirmMeetingAsync()
    {
        ConfirmCalls++;
        var outcome = MeetingStatusOutcomes.Count > 0 ? MeetingStatusOutcomes.Dequeue() : new MeetingStatusOutcome.Done(Progress(DayProgressStatus.Meeting));
        if (outcome is MeetingStatusOutcome.Done done) DayProgress = done.Progress;
        return Task.FromResult(outcome);
    }

    public void DismissMeetingAlert(MeetingAlertKind kind)
    {
        DismissedAlerts.Add(kind);
        Alerts.RemoveAll(a => a.Kind == kind);
    }

    public void MeetingPanelClosed()
    {
        PanelClosedCalls++;
        Alerts.RemoveAll(a => a.Kind == MeetingAlertKind.BackToWorking);
    }

    /// <summary>A day progress as the server answers it, 5h 12m into an 8 hour target, with the check's times counted from <see cref="Now"/>.</summary>
    public DayProgress Progress(string status, int workedSec = 5 * 3600 + 12 * 60, DateTimeOffset? meetingFrom = null) => new()
    {
        Status = status,
        Date = "2026-10-13",
        WorkedSec = workedSec,
        TargetSec = 8 * 3600,
        TargetFromShift = true,
        OverSec = Math.Max(0, workedSec - 8 * 3600),
        MeetingStartedAt = status == DayProgressStatus.Meeting ? meetingFrom ?? Now : null,
        MeetingPromptAt = status == DayProgressStatus.Meeting ? (meetingFrom ?? Now).AddHours(2) : null,
        MeetingFallbackAt = status == DayProgressStatus.Meeting ? (meetingFrom ?? Now).AddHours(2).AddMinutes(10) : null,
    };

    // ---- 4.0 ----
    /// <summary>Focus time now: set by a test, else the work day's clock.</summary>
    public int? FocusOverride { get; set; }
    public int FocusSec => FocusOverride ?? Core.Workday.FocusClock.At(Workday, Now,
        BreakPanel.Active?.StartedAt ?? (Presence.Status is PresenceStatus.Break or PresenceStatus.Lunch ? Presence.Since : null) ?? AwaySince);
    public Core.Offline.AllowanceNow Allowance => Core.Offline.DayProjection.Allowance(Workday, Day, Now);
    public int PendingActions { get; set; }
    public bool Online { get; set; } = true;
    public DateTimeOffset? LastSyncAt { get; set; } = Ist.At("10:44");
    public DateTimeOffset? AwaySince { get; set; }
    public IdleConfig? IdleConfig { get; set; }
    public List<ApprovalItem> Approvals { get; } = new();
    public IReadOnlyList<ApprovalItem> MyApprovals => Approvals;
    public PresenceTotals Totals { get; set; }
    public string ApiBaseUrl { get; set; } = "https://api.rxvision.shop/api/v1";
    public string Version => "4.0.0";
    public DevPlatform Dev { get; } = new(Path.Combine(Path.GetTempPath(), "rxv-ui-tests-" + Guid.NewGuid().ToString("N")));
    private IPlatform? _platform;
    public IPlatform Platform { get => _platform ?? Dev; set => _platform = value; }
    public AgentOptions Options { get; } = new AgentOptions().Normalised();
    public RingView? Ring => BreakPanel.Ring;
    public int ChatUnread { get; set; }
    public FakeChat FakeChat { get; } = new();
    public IChat? Chat => FakeChat;
    public FakeAvatars FakeAvatars { get; } = new();
    public IAvatars Avatars => FakeAvatars;
    public BreakDay? Day { get; set; } = Days.General();
    public BreakPanel BreakPanel => BreakSchedule.Compute(Day, Now);
    public DateTimeOffset Now { get; set; }
    /// <summary>The one clock: tests move it through <see cref="ManualClock"/>; <see cref="Now"/> stays what they set.</summary>
    public Core.Util.ManualClock ManualClock { get; } = new(Ist.At("00:00"));
    public Core.Util.IClock Clock => ManualClock;
    public UpdateOffer? PendingUpdate { get; set; }
    public int PendingSamples { get; set; }
    public DateTimeOffset LastSampleSent { get; set; } = Ist.At("10:44");

    public string BusinessTime(DateTimeOffset instant) => Core.Util.Clock12.Format(instant.ToOffset(Ist.Offset));
    public DateTimeOffset BusinessLocal(DateTimeOffset instant) => instant.ToOffset(Ist.Offset);
    public string BusinessDate(DateTimeOffset instant) => instant.ToOffset(Ist.Offset).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public void SetNow(string hm) => Now = Ist.At(hm);

    // ---- Scripted outcomes and recorded calls -------------------------------------------------

    public Queue<StartOutcome> StartOutcomes { get; } = new();
    public Queue<EndOutcome> EndOutcomes { get; } = new();
    public Queue<SkipOutcome> SkipOutcomes { get; } = new();
    public Queue<CommentOutcome> CommentOutcomes { get; } = new();
    public Queue<MeetingOutcome> MeetingOutcomes { get; } = new();
    public Queue<StartDayOutcome> StartDayOutcomes { get; } = new();
    public Queue<EndDayOutcome> EndDayOutcomes { get; } = new();
    public List<(string Kind, string? Reason)> TakeCalls { get; } = new();
    public List<string> FreeCalls { get; } = new();
    public int BackToWorkCalls { get; private set; }
    public List<(string Kind, string? Reason)> SkipCalls { get; } = new();
    public List<(string Id, string Comment)> CommentCalls { get; } = new();
    public List<(string Agenda, IReadOnlyList<MeetingParticipant> People, string MomSender)> MeetingCalls { get; } = new();
    public List<(DateTimeOffset StartedAt, int Minutes, string Agenda, IReadOnlyList<MeetingParticipant> People, string MomSender)> PastMeetingCalls { get; } = new();
    public List<int> QuickCalls { get; } = new();
    public int PauseCalls { get; private set; }
    public int ResumeCalls { get; private set; }
    public Queue<ActionOutcome> ActionOutcomes { get; } = new();
    public List<AwayAnswer> AwayCalls { get; } = new();
    public Queue<AwayOutcome> AwayOutcomes { get; } = new();
    public List<string> HistoryCalls { get; } = new();
    public Func<string, (HistoryMonth? History, bool Fresh)> HistoryFor { get; set; } = _ => (null, false);
    public List<string> SignOutKeys { get; } = new();
    public List<string> QuitKeys { get; } = new();
    public Queue<KeyOutcome> KeyOutcomes { get; } = new();
    public List<TimeSpan> SyncCalls { get; } = new();
    /// <summary>What SyncNowAsync leaves waiting (default: everything sent).</summary>
    public int SyncLeaves { get; set; }
    public List<IReadOnlyList<SkipComment>?> EndDayCalls { get; } = new();
    public int EndMeetingCalls { get; private set; }
    public int StartDayCalls { get; private set; }
    public List<string?> SearchCalls { get; } = new();
    public List<ParticipantOption> Directory { get; } = new()
    {
        new() { Id = "m-1", Name = "Maya Reddy", Department = "Operations" },
        new() { Id = "p-2", Name = "Praveen Kumar", Department = "Engineering" },
        new() { Id = "k-3", Name = "Kavya R", Department = "Engineering" },
        new() { Id = "u-1", Name = "Asha Kumar", Department = "Engineering" },
    };
    public int WorkdayRefreshes { get; private set; }
    public List<(string Email, string Password, string? Server)> SignInCalls { get; } = new();
    public string? SignInError { get; set; }

#pragma warning disable CS0067 // events the views do not need in these tests
    public event Action<AgentState>? StateChanged;
    public event Action<CurrentPresence>? PresenceChanged;
    public event Action? BreaksChanged;
    public event Action? WorkdayChanged;
    public event Action? MeetingsChanged;
    public event Action? ApprovalsChanged;
    public event Action<ChatMessage>? ChatMessageReceived;
    public event Action<int>? ChatUnreadChanged;
    public event Action<NotificationItem>? NotificationReceived;
    public event Action<RingView?>? RingChanged;
    public event Action<BreakRecord>? BreakAutoSkipped;
    public event Action<AgentNudge>? Nudge;
    public event Action<string>? ActionRefused;
    public event Action? AwayChanged;
    public event Action? HistoryChanged;
    public event Action<UpdateOffer>? UpdateAvailable;
    public event Action? ExitRequested;
    public event Action<string>? SignedOutUnexpectedly;
    public event Action? SignedOutForNextShift;
#pragma warning restore CS0067
    public event Action<ShiftQuestion>? ShiftEndQuestion;
    public void RaiseShiftQuestion(ShiftQuestion q) => ShiftEndQuestion?.Invoke(q);
    public int ContinuedShifts { get; private set; }
    public int DeclinedShifts { get; private set; }
    public Task<bool> ContinueShiftAsync() { ContinuedShifts++; return Task.FromResult(true); }
    public void DeclineShift() => DeclinedShifts++;

    public void RaiseNudge(AgentNudge nudge) => Nudge?.Invoke(nudge);
    public void RaiseAutoSkipped(BreakRecord record) => BreakAutoSkipped?.Invoke(record);
    public void RaiseWorkday() => WorkdayChanged?.Invoke();
    public void RaiseActionRefused(string message) => ActionRefused?.Invoke(message);
    public void RaiseAway() => AwayChanged?.Invoke();
    public void RaiseHistory() => HistoryChanged?.Invoke();

    public void RaiseState(AgentState state)
    {
        State = state;
        StateChanged?.Invoke(state);
    }

    public void RaiseChat(ChatMessage m) => ChatMessageReceived?.Invoke(m);

    public Task StartAsync() => Task.CompletedTask;

    public Task<string?> SignInAsync(string email, string password, string? server)
    {
        SignInCalls.Add((email, password, server));
        return Task.FromResult(SignInError);
    }

    public Task<string?> SignInWithCodeAsync(string code) => Task.FromResult<string?>(null);
    public Task AcknowledgeNoticeAsync() => Task.CompletedTask;

    /// <summary>The time each End Day was asked for (null: now), in step with <see cref="EndDayCalls"/>.</summary>
    public List<DateTimeOffset?> EndDayTimes { get; } = new();
    public HeldEndDay? HeldEndDay { get; set; }
    public event Action<HeldEndDay>? EndDayHeld;
    public void RaiseEndDayHeld(HeldEndDay held)
    {
        HeldEndDay = held;
        EndDayHeld?.Invoke(held);
    }

    public Task<EndDayOutcome> EndDayAsync(IReadOnlyList<SkipComment>? comments, DateTimeOffset? at = null)
    {
        EndDayCalls.Add(comments);
        EndDayTimes.Add(at);
        var outcome = EndDayOutcomes.Count > 0 ? EndDayOutcomes.Dequeue() : new EndDayOutcome.Ended(null, at ?? Now);
        if (outcome is not (EndDayOutcome.CommentsRequired or EndDayOutcome.CommentInvalid or EndDayOutcome.Offline)) HeldEndDay = null;
        if (outcome is EndDayOutcome.Ended ended)
        {
            // As the server answers: the day is closed and its focus time stops.
            State = AgentState.DayEnded;
            Presence = new CurrentPresence { Status = PresenceStatus.DayEnded };
            if (ended.Workday is { } day) Workday = day;
            else if (Workday is { } w)
            {
                w.Focus.FocusSec = Core.Workday.FocusClock.At(w, Now);
                w.Focus.Running = false;
                w.ServerNow = Now;
                w.State = WorkdayStates.Ended;
                w.EndedAt = ended.EndedAt ?? Now;
                w.SkipsNeedingComment.Clear();
            }
        }
        return Task.FromResult(outcome);
    }

    // ---- 3.2 to 3.5: the staff pages, presets, biometric staff ----
    public bool IsBiometric { get; set; }
    public Dictionary<string, List<string>> PresetLists { get; } = new();
    public IReadOnlyList<string> Presets(string kind) => PresetLists.TryGetValue(kind, out var list) ? list : Array.Empty<string>();
    public event Action? LeaveChanged;
    public void RaiseLeave() => LeaveChanged?.Invoke();
    /// <summary>The late note sent with each Start Day (null: none), in step with <see cref="StartDayCalls"/>.</summary>
    public List<string?> StartDayReasons { get; } = new();
    public List<string> LateReasons { get; } = new();
    public ApiResult<System.Text.Json.JsonElement> LateReasonResult { get; set; } = ApiResult<System.Text.Json.JsonElement>.Success(default);
    public (StaffGuide? Guide, bool Fresh) GuideResult { get; set; } = (null, false);
    public Func<int, ApiResult<CalendarYear>> CalendarFor { get; set; } = _ => ApiResult<CalendarYear>.TransientFailure("offline");
    public ApiResult<MyLeave> LeaveResult { get; set; } = ApiResult<MyLeave>.TransientFailure("offline");
    public Func<LeaveRequestBody, ApiResult<LeavePreview>> PreviewFor { get; set; } = _ => ApiResult<LeavePreview>.Success(new LeavePreview { Ok = true });
    public Queue<ApiResult<LeaveRequest>> LeaveResults { get; } = new();
    public List<LeaveRequestBody> LeaveRequests { get; } = new();
    public List<string> LeaveCancels { get; } = new();

    public Task<ApiResult<System.Text.Json.JsonElement>> AddLateReasonAsync(string reason)
    {
        LateReasons.Add(reason);
        return Task.FromResult(LateReasonResult);
    }

    public Task<(StaffGuide? Guide, bool Fresh)> GetGuideAsync() => Task.FromResult(GuideResult);
    public Task<ApiResult<CalendarYear>> GetCalendarAsync(int year) => Task.FromResult(CalendarFor(year));
    public Task<ApiResult<MyLeave>> GetMyLeaveAsync() => Task.FromResult(LeaveResult);
    public Task<ApiResult<LeavePreview>> PreviewLeaveAsync(LeaveRequestBody body) => Task.FromResult(PreviewFor(body));

    public Task<ApiResult<LeaveRequest>> RequestLeaveAsync(LeaveRequestBody body)
    {
        LeaveRequests.Add(body);
        return Task.FromResult(LeaveResults.Count > 0
            ? LeaveResults.Dequeue()
            : ApiResult<LeaveRequest>.Success(new LeaveRequest { Id = "l-new", Span = "Mon 9 Nov", Status = LeaveStatuses.Pending, WaitingFor = "Maya Reddy" }));
    }

    public Task<ApiResult<LeaveRequest>> CancelLeaveAsync(string requestId)
    {
        LeaveCancels.Add(requestId);
        return Task.FromResult(ApiResult<LeaveRequest>.Success(new LeaveRequest { Id = requestId, Status = LeaveStatuses.Cancelled }));
    }

    public Task<StartDayOutcome> StartDayAsync(string? lateReason = null)
    {
        StartDayReasons.Add(lateReason);
        StartDayCalls++;
        var outcome = StartDayOutcomes.Count > 0 ? StartDayOutcomes.Dequeue() : new StartDayOutcome.Started(Days.Open(), false);
        if (outcome is StartDayOutcome.Started started)
        {
            State = AgentState.Running;
            Presence = new CurrentPresence { Status = PresenceStatus.Working, Since = Now };
            if (started.Workday is { } day) Workday = day;
        }
        return Task.FromResult(outcome);
    }

    public Task<ActionOutcome> QuickBreakAsync(int plannedMin)
    {
        QuickCalls.Add(plannedMin);
        return Task.FromResult(ActionOutcomes.Count > 0 ? ActionOutcomes.Dequeue() : new ActionOutcome.Done(null));
    }

    public Task<ActionOutcome> PauseBreakAsync()
    {
        PauseCalls++;
        return Task.FromResult(ActionOutcomes.Count > 0 ? ActionOutcomes.Dequeue() : new ActionOutcome.Done(null));
    }

    public Task<ActionOutcome> ResumeBreakAsync()
    {
        ResumeCalls++;
        return Task.FromResult(ActionOutcomes.Count > 0 ? ActionOutcomes.Dequeue() : new ActionOutcome.Done(null));
    }

    public Task<AwayOutcome> AnswerAwayAsync(AwayAnswer answer)
    {
        AwayCalls.Add(answer);
        var outcome = AwayOutcomes.Count > 0 ? AwayOutcomes.Dequeue() : new AwayOutcome.Recorded();
        if (outcome is AwayOutcome.Recorded or AwayOutcome.OnBreak) AwaySince = null;
        return Task.FromResult(outcome);
    }

    public Task<(HistoryMonth? History, bool Fresh)> GetHistoryAsync(string month)
    {
        HistoryCalls.Add(month);
        return Task.FromResult(HistoryFor(month));
    }

    public Task<int> SyncNowAsync(TimeSpan timeout)
    {
        SyncCalls.Add(timeout);
        PendingActions = SyncLeaves;
        return Task.FromResult(SyncLeaves);
    }

    public Task<KeyOutcome> SignOutWithKeyAsync(string key)
    {
        SignOutKeys.Add(key);
        var outcome = KeyOutcomes.Count > 0 ? KeyOutcomes.Dequeue() : new KeyOutcome.Accepted();
        if (outcome is KeyOutcome.Accepted) State = AgentState.SignIn;
        return Task.FromResult(outcome);
    }

    public Task<KeyOutcome> QuitCheckAsync(string key)
    {
        QuitKeys.Add(key);
        return Task.FromResult(KeyOutcomes.Count > 0 ? KeyOutcomes.Dequeue() : new KeyOutcome.Accepted());
    }

    public Task<StartOutcome> TakeBreakAsync(string kind, string? reason)
    {
        TakeCalls.Add((kind, reason));
        return Task.FromResult(StartOutcomes.Count > 0 ? StartOutcomes.Dequeue() : new StartOutcome.Started(null, "BREAK"));
    }

    public Task<StartOutcome> TakeFreeBreakAsync(string presenceType)
    {
        FreeCalls.Add(presenceType);
        return Task.FromResult(StartOutcomes.Count > 0 ? StartOutcomes.Dequeue() : new StartOutcome.Started(null, presenceType));
    }

    public Task<SkipOutcome> SkipBreakAsync(string kind, string? reason)
    {
        SkipCalls.Add((kind, reason));
        return Task.FromResult(SkipOutcomes.Count > 0 ? SkipOutcomes.Dequeue() : new SkipOutcome.Skipped(null));
    }

    public Task<CommentOutcome> CommentBreakAsync(string breakId, string comment)
    {
        CommentCalls.Add((breakId, comment));
        return Task.FromResult(CommentOutcomes.Count > 0 ? CommentOutcomes.Dequeue() : new CommentOutcome.Saved(null));
    }

    public Task<EndOutcome> BackToWorkAsync()
    {
        BackToWorkCalls++;
        return Task.FromResult(EndOutcomes.Count > 0 ? EndOutcomes.Dequeue() : new EndOutcome.Ended(null));
    }

    public Task<EndOutcome> EndMeetingAsync()
    {
        EndMeetingCalls++;
        var outcome = EndOutcomes.Count > 0 ? EndOutcomes.Dequeue() : new EndOutcome.MeetingEnded(LiveMeeting, false);
        if (outcome is EndOutcome.MeetingEnded)
        {
            LiveMeeting = null;
            Presence = new CurrentPresence { Status = PresenceStatus.Working };
            if (DayProgress is { InMeeting: true }) DayProgress = Progress(DayProgressStatus.Working);
        }
        return Task.FromResult(outcome);
    }

    public Task<MeetingOutcome> StartMeetingAsync(string agenda, IReadOnlyList<MeetingParticipant> participants, string momSender)
    {
        MeetingCalls.Add((agenda, participants, momSender));
        var outcome = MeetingOutcomes.Count > 0 ? MeetingOutcomes.Dequeue() : new MeetingOutcome.Started(new MeetingRecord
        {
            Id = "meet-1", Mode = MeetingModes.Live, Agenda = agenda, Participants = participants.ToList(), StartedAt = Now, InProgress = true,
            MomSender = momSender,
        });
        if (outcome is MeetingOutcome.Started started)
        {
            LiveMeeting = started.Meeting;
            Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = Now, Note = agenda };
        }
        return Task.FromResult(outcome);
    }

    public Task<MeetingOutcome> LogPastMeetingAsync(DateTimeOffset startedAt, int durationMin, string agenda, IReadOnlyList<MeetingParticipant> participants, string momSender)
    {
        PastMeetingCalls.Add((startedAt, durationMin, agenda, participants, momSender));
        return Task.FromResult(MeetingOutcomes.Count > 0 ? MeetingOutcomes.Dequeue() : new MeetingOutcome.Logged(null));
    }

    public Task<IReadOnlyList<ParticipantOption>?> SearchParticipantsAsync(string? query)
    {
        SearchCalls.Add(query);
        var q = (query ?? "").Trim();
        return Task.FromResult<IReadOnlyList<ParticipantOption>?>(
            Directory.Where(p => q.Length == 0 || p.Name.Contains(q, StringComparison.OrdinalIgnoreCase)).ToList());
    }

    public ManualDownload DownloadResult { get; set; } = new("/home/asha/Downloads/RXVision-3.1.0.exe", null);
    public int DownloadCalls { get; private set; }

    public Task<ManualDownload> DownloadUpdateAsync()
    {
        DownloadCalls++;
        return Task.FromResult(DownloadResult);
    }

    public Task RefreshPresenceAsync() => Task.CompletedTask;

    /// <summary>What a read of GET /me/day-progress answers (the core reads it in 4.0; tests set it by hand).</summary>
    public Func<DayProgress?>? DayProgressSource { get; set; }

    public Task RefreshWorkdayAsync()
    {
        WorkdayRefreshes++;
        return Task.CompletedTask;
    }
    public void Shutdown() { }
}

public sealed class FakeChat : IChat
{
    public List<ChatContact> ContactList { get; } = new()
    {
        new ChatContact { UserId = "m-1", Name = "Maya Reddy", Email = "manager@timechamp.test", Role = "MANAGER", Relation = "MANAGER" },
    };

    public List<ChatMessage> Conversation { get; } = new();
    public Queue<ApiResult<ChatMessage>> SendResults { get; } = new();
    public List<string> Sent { get; } = new();
    public int Loads { get; private set; }
    public int Bumps { get; private set; }

    public IReadOnlyList<ChatContact> Contacts => ContactList;
    public bool ContactsLoaded { get; set; } = true;
    public ChatContact? DefaultContact => ContactList.FirstOrDefault();
    public string NameOf(string userId) => ContactList.FirstOrDefault(c => c.UserId == userId)?.Name ?? "Someone";
    public Task<bool> LoadContactsAsync() => Task.FromResult(true);

    public Task<IReadOnlyList<ChatMessage>?> LoadConversationAsync(string contactId)
    {
        Loads++;
        return Task.FromResult<IReadOnlyList<ChatMessage>?>(Conversation.ToList());
    }

    public Task<ApiResult<ChatMessage>> SendAsync(string contactId, string body)
    {
        Sent.Add(body);
        if (SendResults.Count > 0) return Task.FromResult(SendResults.Dequeue());
        var message = new ChatMessage { Id = Guid.NewGuid().ToString(), FromUserId = "u-1", ToUserId = contactId, Body = body.Trim(), Mine = true, CreatedAt = DateTimeOffset.UtcNow };
        return Task.FromResult(ApiResult<ChatMessage>.Success(message));
    }

    public Task RefreshUnreadAsync() => Task.CompletedTask;
    public void BumpUnread() => Bumps++;
}

/// <summary>
/// The person's avatar as a test scripts it. A save lands at once and waits for
/// <see cref="Hold"/> when one is set, the way the real one answers later; an answer that does
/// not take puts the old avatar back. The real behaviour is proved on AvatarService itself.
/// </summary>
public sealed class FakeAvatars : IAvatars
{
    public MyAvatar? Mine { get; set; }
    public string? ShownId { get; set; }
    public string? PersonName { get; set; }
    public event Action? Changed;
    public event Action<string, string?>? PersonChanged;
    public Queue<ApiResult<MyAvatar>> Answers { get; } = new();
    public List<string> Saves { get; } = new();
    public int Resets { get; private set; }
    public int Refreshes { get; private set; }
    public TaskCompletionSource? Hold { get; set; }
    public ApiResult<DayProgress> DayAnswer { get; set; } = ApiResult<DayProgress>.TransientFailure("offline");
    public int DayReads { get; private set; }

    /// <summary>The person has this gender's library, the server shows this avatar, and this is their stored choice (null: the RX mark).</summary>
    public FakeAvatars Have(string library, string avatarId, string? chosen = null)
    {
        Mine = new MyAvatar
        {
            Library = library,
            AvatarId = avatarId,
            ChosenAvatarId = chosen,
            DefaultAvatarId = library == "male" ? "M01" : "F01",
        };
        ShownId = chosen;
        return this;
    }

    public void RaiseChanged() => Changed?.Invoke();
    public void RaisePerson(string userId, string? avatarId) => PersonChanged?.Invoke(userId, avatarId);

    public Task RefreshAsync()
    {
        Refreshes++;
        return Task.CompletedTask;
    }

    public Task<ApiResult<MyAvatar>> SaveAsync(string avatarId)
    {
        Saves.Add(avatarId);
        return ChangeAsync(avatarId, () =>
        {
            var library = Mine?.Library ?? "male";
            return new MyAvatar { Library = library, AvatarId = avatarId, ChosenAvatarId = avatarId, DefaultAvatarId = Mine?.DefaultAvatarId };
        });
    }

    public Task<ApiResult<MyAvatar>> ResetAsync()
    {
        Resets++;
        return ChangeAsync(null, () =>
            new MyAvatar { Library = Mine?.Library, AvatarId = Mine?.DefaultAvatarId, ChosenAvatarId = null, DefaultAvatarId = Mine?.DefaultAvatarId });
    }

    private async Task<ApiResult<MyAvatar>> ChangeAsync(string? showNow, Func<MyAvatar> saved)
    {
        var before = ShownId;
        ShownId = showNow;
        Changed?.Invoke();
        if (Hold is { } hold) await hold.Task;
        var answer = Answers.Count > 0 ? Answers.Dequeue() : ApiResult<MyAvatar>.Success(saved());
        if (answer.Ok)
        {
            Mine = answer.Data;
            ShownId = answer.Data?.ChosenAvatarId;
        }
        else
        {
            ShownId = before;
        }
        Changed?.Invoke();
        return answer;
    }

    public Task<ApiResult<DayProgress>> GetDayProgressAsync()
    {
        DayReads++;
        return Task.FromResult(DayAnswer);
    }
}

/// <summary>Answers dialogs from a script; records what was shown.</summary>
public sealed class FakeDialogs : IDialogService
{
    public List<DialogViewModel> Shown { get; } = new();
    public Queue<Func<DialogViewModel, bool>> Answers { get; } = new();

    public FakeDialogs Answer(Func<DialogViewModel, bool> answer)
    {
        Answers.Enqueue(answer);
        return this;
    }

    /// <summary>Presses the dialog's third button (Skip break, Leave them out).</summary>
    public FakeDialogs Alternative(Action<DialogViewModel>? check = null) => Answer(d =>
    {
        check?.Invoke(d);
        d.AlternativeCommand.Execute(null);
        return false;
    });

    public Task<bool> ShowAsync(DialogViewModel dialog)
    {
        Shown.Add(dialog);
        var answer = Answers.Count > 0 ? Answers.Dequeue() : _ => false;
        return Task.FromResult(answer(dialog));
    }
}
