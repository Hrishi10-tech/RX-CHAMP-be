using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Icon;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels.Dialogs;

namespace RXVision.Agent.ViewModels;

public enum SyncTone { Ok, Pending, Off }

/// <summary>The pages of the main window (the hamburger menu, SPEC 8.1).</summary>
public enum DashboardPage { Dashboard, History, Leave, Calendar, Instructions }

/// <summary>Someone in the running meeting, as a small round avatar.</summary>
public sealed record MeetingPersonViewModel(string Initials, string Name);

/// <summary>
/// The main screen. Everything is recomputed from the agent by <see cref="Refresh"/>
/// (every second while the window is visible, and on every change the agent
/// reports); the commands hand over to <see cref="BreakActions"/>.
/// </summary>
public sealed partial class DashboardViewModel : ObservableObject
{
    private readonly IAgent _agent;
    private readonly BreakActions _actions;
    private readonly ILog _log;
    private readonly DayMeter _meter;
    private DateTimeOffset _permissionCheckedAt = DateTimeOffset.MinValue;
    private bool _screenRecordingDismissed;
    private string _peopleKey = "";

    /// <param name="alerts">The cards on top of the panel, shared with the icon's badge (3.6).</param>
    /// <param name="meter">The one value the ring and these progress lines both read (3.6).</param>
    public DashboardViewModel(IAgent agent, BreakActions actions, ILog log, AlertCenter? alerts = null, DayMeter? meter = null)
    {
        _agent = agent;
        _actions = actions;
        _log = log;
        Alerts = alerts ?? new AlertCenter();
        _meter = meter ?? new DayMeter(agent);

        QuickTile = new TileViewModel("Quick break", "amber", "Icon.Coffee");
        QuickTile.Command = new AsyncRelayCommand(_actions.QuickBreakAsync, () => QuickTile.CanClick && !IsBusy);
        NextTile = new TileViewModel("Next break", "teal", "Icon.Lunch");
        NextTile.Command = new AsyncRelayCommand(_actions.NextBreakAsync, () => NextTile.CanClick && !IsBusy);
        FocusTile = new TileViewModel("Focus work", "indigo", "Icon.Focus");
        FocusTile.Command = new AsyncRelayCommand(_actions.BackToWorkAsync, () => FocusTile.CanClick && !IsBusy);
        MeetingTile = new TileViewModel("Start meeting", "violet", "Icon.Meeting");
        MeetingTile.Command = new AsyncRelayCommand(() => _actions.StartMeetingAsync(), () => MeetingTile.CanClick && !IsBusy);

        Chat = new ChatViewModel(agent, log);
        History = new HistoryViewModel(agent, log);
        Leave = new LeaveViewModel(agent, actions.Dialogs, log);
        Calendar = new CalendarViewModel(agent, log);
        Instructions = new InstructionsViewModel(agent, log);
        _actions.BusyChanged += () => IsBusy = _actions.IsBusy;
    }

    public TileViewModel QuickTile { get; }
    public TileViewModel NextTile { get; }
    public TileViewModel FocusTile { get; }
    public TileViewModel MeetingTile { get; }
    /// <summary>
    /// The alerts (3.6): newest on top, their actions ready. The meeting cards (Start meeting?,
    /// End meeting?, Still in a meeting?, You're back to Working) come through here too.
    /// </summary>
    public AlertCenter Alerts { get; }
    public ActiveBreakViewModel ActiveBreak { get; } = new();
    public TodayViewModel Today { get; } = new();
    public ChatViewModel Chat { get; }
    public HistoryViewModel History { get; }
    /// <summary>Leave and comp off (3.4, 3.5).</summary>
    public LeaveViewModel Leave { get; }
    /// <summary>My calendar (3.2, the 4.0 organisation calendar).</summary>
    public CalendarViewModel Calendar { get; }
    /// <summary>The organisation's guide under the Instructions page (3.2).</summary>
    public InstructionsViewModel Instructions { get; }
    public ObservableCollection<BreakRowViewModel> Rows { get; } = new();
    public ObservableCollection<MeetingPersonViewModel> MeetingPeople { get; } = new();

    /// <summary>Set by the app: sign out (the key flow).</summary>
    public Func<Task>? SignOutRequested { get; set; }
    /// <summary>Set by the app: an Admin's or Super Admin's quit (the key flow).</summary>
    public Func<Task>? QuitRequested { get; set; }

    // ---- Header and pages -------------------------------------------------------------------

    [ObservableProperty] private string _displayName = "";
    [ObservableProperty] private string _initials = "";
    [ObservableProperty] private string _statusText = "";
    [ObservableProperty] private BubbleStatus _statusKind;
    /// <summary>"Day started 9:24 AM", or null before Start Day.</summary>
    [ObservableProperty] private string? _dayStartedText;
    [ObservableProperty] private string _syncText = "";
    /// <summary>"3h 30m of 8h", or "Target reached · 8h 00m today". The same value as the ring (3.6).</summary>
    [ObservableProperty] private string _progressLine = "";
    /// <summary>"4h 30m to go", or "+15 min over target".</summary>
    [ObservableProperty] private string _progressNote = "";
    /// <summary>The day has a total to show.</summary>
    [ObservableProperty] private bool _showProgress;
    [ObservableProperty] private SyncTone _syncTone;
    [ObservableProperty] private string _syncToolTip = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsDashboardPage), nameof(IsHistoryPage), nameof(IsLeavePage), nameof(IsCalendarPage), nameof(IsInstructionsPage))]
    private DashboardPage _page = DashboardPage.Dashboard;

    public bool IsDashboardPage => Page == DashboardPage.Dashboard;
    public bool IsHistoryPage => Page == DashboardPage.History;
    public bool IsLeavePage => Page == DashboardPage.Leave;
    public bool IsCalendarPage => Page == DashboardPage.Calendar;
    public bool IsInstructionsPage => Page == DashboardPage.Instructions;

    /// <summary>The hamburger menu is open.</summary>
    [ObservableProperty] private bool _isMenuOpen;

    /// <summary>An Admin or Super Admin: the menu offers Quit RX Vision… (with a key).</summary>
    [ObservableProperty] private bool _canQuit;

    [RelayCommand]
    private void ToggleMenu() => IsMenuOpen = !IsMenuOpen;

    [RelayCommand]
    private void CloseMenu() => IsMenuOpen = false;

    [RelayCommand]
    private void ShowDashboard()
    {
        IsMenuOpen = false;
        Page = DashboardPage.Dashboard;
        Refresh();
    }

    [RelayCommand]
    private Task ShowHistoryAsync()
    {
        IsMenuOpen = false;
        Page = DashboardPage.History;
        return History.OpenAsync();
    }

    [RelayCommand]
    private Task ShowLeaveAsync()
    {
        IsMenuOpen = false;
        Page = DashboardPage.Leave;
        return Leave.LoadAsync();
    }

    [RelayCommand]
    private Task ShowCalendarAsync()
    {
        IsMenuOpen = false;
        Page = DashboardPage.Calendar;
        return Calendar.OpenAsync();
    }

    /// <summary>Instructions: how the agent works (4.0), then the organisation's guide from the server (3.2).</summary>
    [RelayCommand]
    private Task ShowInstructionsAsync()
    {
        IsMenuOpen = false;
        Page = DashboardPage.Instructions;
        return Instructions.LoadAsync();
    }

    [RelayCommand]
    private Task SignOutAsync()
    {
        IsMenuOpen = false;
        return SignOutRequested?.Invoke() ?? Task.CompletedTask;
    }

    [RelayCommand]
    private Task QuitAsync()
    {
        IsMenuOpen = false;
        return QuitRequested?.Invoke() ?? Task.CompletedTask;
    }

    // ---- The day's state --------------------------------------------------------------------

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TilesOpacity), nameof(ShowTiles))]
    [NotifyCanExecuteChangedFor(nameof(EndDayCommand), nameof(StartDayCommand))]
    private bool _isDayEnded;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowTiles))]
    [NotifyCanExecuteChangedFor(nameof(EndDayCommand), nameof(StartDayCommand))]
    private bool _isNotStarted;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(EndDayCommand))]
    private bool _isRunning;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasUpdate))]
    private string? _updateText;

    [ObservableProperty] private bool _showScreenRecordingBanner;

    /// <summary>An End Day done offline waiting for comments (a banner with "Add comments"); null when none.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasHeldEndDay))]
    private string? _heldEndDayText;

    public bool HasHeldEndDay => HeldEndDayText is not null;
    public bool HasUpdate => UpdateText is not null;
    public double TilesOpacity => IsDayEnded ? 0.45 : 1.0;
    /// <summary>The four tiles: while the day runs (not on a break or in a meeting) and after it ended; never for biometric staff.</summary>
    public bool ShowTiles => !IsNotStarted && !IsOnBreak && !IsInMeeting && !IsBiometric;

    // ---- What the day view says about today (3.2 to 3.5) -------------------------------------

    /// <summary>"Today is Diwali" / "Today is a day off" (3.2), or null on a working day.</summary>
    [ObservableProperty] private string? _dayOffText;
    /// <summary>"On leave today · Half day (first half) · CL/SL" (3.4), or null.</summary>
    [ObservableProperty] private string? _leaveText;
    /// <summary>"Work from home (full day)", from wfh.label on the day view (3.5), or null.</summary>
    [ObservableProperty] private string? _wfhText;

    /// <summary>The late start still wants its note (a day started by another computer or an older agent): the banner's words, or null.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasLateReason))]
    private string? _lateReasonText;

    public bool HasLateReason => LateReasonText is not null;

    /// <summary>The biometric device takes this person's attendance (3.5): no day, break or meeting buttons.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowDayButtons), nameof(ShowBreakTiles), nameof(BiometricText), nameof(ShowBreakList), nameof(ShowTiles))]
    private bool _isBiometric;

    /// <summary>What a biometric person reads instead of Start Day.</summary>
    public string? BiometricText => IsBiometric ? BiometricLine : null;
    public const string BiometricLine = "Your attendance is recorded by the biometric device: your day starts with your first punch there.";
    /// <summary>A biometric day closed without a check-out punch (3.5), or null.</summary>
    [ObservableProperty] private string? _checkoutMissingText;
    public bool ShowDayButtons => !IsBiometric;
    public bool ShowBreakTiles => !IsBiometric;
    /// <summary>Breaks are not tracked for biometric staff, whatever the shift says.</summary>
    public bool ShowBreakList => !IsBiometric;

    /// <summary>"Add a note" on the late start's banner.</summary>
    [RelayCommand(CanExecute = nameof(NotBusy))]
    private Task AddLateReasonAsync() => _actions.AddLateReasonAsync();

    // ---- Not started ------------------------------------------------------------------------

    [ObservableProperty] private string _greetingText = "";
    [ObservableProperty] private string? _shiftLine;
    /// <summary>Said while the day's state could not be read from the server.</summary>
    [ObservableProperty] private string? _dayCheckText;
    /// <summary>The working day that ended within the last hours (a night shift, End Day after midnight), in words; else null.</summary>
    [ObservableProperty] private string? _lastEndedText;

    // ---- Day ended ----------------------------------------------------------------------------

    [ObservableProperty] private string _endedTitle = "";
    [ObservableProperty] private string _endedDetail = "";

    // ---- On a break, in a meeting ---------------------------------------------------------------

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowTiles))]
    private bool _isOnBreak;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowTiles))]
    private bool _isInMeeting;

    [ObservableProperty] private string _meetingTimer = "00:00";
    [ObservableProperty] private string _meetingStarted = "";
    [ObservableProperty] private string _meetingAgenda = "";
    [ObservableProperty] private string _meetingPeopleText = "";
    [ObservableProperty] private string? _meetingMomText;

    // ---- Body -------------------------------------------------------------------------------

    [ObservableProperty] private bool _isScheduled;
    [ObservableProperty] private string _shiftText = "";
    [ObservableProperty] private string _freeText = "";
    /// <summary>No rows at all (a free day before any break).</summary>
    [ObservableProperty] private bool _showFreeText;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(BackToWorkCommand), nameof(EndBreakCommand), nameof(PauseBreakCommand),
        nameof(EndDayCommand), nameof(StartDayCommand), nameof(EndMeetingCommand), nameof(AddLateReasonCommand), nameof(RecordMeetingCommand))]
    private bool _isBusy;

    partial void OnIsBusyChanged(bool value)
    {
        foreach (var tile in new[] { QuickTile, NextTile, FocusTile, MeetingTile }) tile.Command?.NotifyCanExecuteChanged();
        foreach (var row in Rows)
        {
            row.CommentCommand?.NotifyCanExecuteChanged();
            row.ResumeCommand?.NotifyCanExecuteChanged();
            row.EndCommand?.NotifyCanExecuteChanged();
        }
    }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasOverlay), nameof(OverlayWidth))]
    private DialogViewModel? _overlay;

    public bool HasOverlay => Overlay is not null;
    public double OverlayWidth => Overlay?.Width ?? 452;

    /// <summary>The window is visible and in front (set by the app).</summary>
    [ObservableProperty] private bool _isOnScreen;

    // ---- Commands -----------------------------------------------------------------------------

    /// <summary>Back to work (the tray, the menus): ends a meeting, or a break after asking.</summary>
    [RelayCommand(CanExecute = nameof(NotBusy))]
    private Task BackToWorkAsync() => _actions.BackToWorkAsync();

    /// <summary>End break on the break panel: always asks first.</summary>
    [RelayCommand(CanExecute = nameof(NotBusy))]
    private Task EndBreakAsync() => _actions.EndBreakAsync();

    [RelayCommand(CanExecute = nameof(CanPauseBreak))]
    private Task PauseBreakAsync() => _actions.PauseAsync();
    private bool CanPauseBreak() => !IsBusy && ActiveBreak.CanPause;

    [RelayCommand(CanExecute = nameof(NotBusy))]
    private Task EndMeetingAsync() => _actions.EndMeetingAsync();

    /// <summary>The 4.0 meeting dialog: a meeting with its agenda, people and minutes (works offline), or an earlier one.</summary>
    [RelayCommand(CanExecute = nameof(NotBusy))]
    private Task RecordMeetingAsync() => _actions.RecordMeetingAsync();

    private bool NotBusy() => !IsBusy;

    [RelayCommand(CanExecute = nameof(CanEndDay))]
    private Task EndDayAsync() => _actions.EndDayAsync();
    private bool CanEndDay() => IsRunning && !IsBusy && !IsBiometric && _agent.State == AgentState.Running;

    [RelayCommand(CanExecute = nameof(CanStartDay))]
    private Task StartDayAsync() => _actions.StartDayAsync();
    private bool CanStartDay() => (IsDayEnded || IsNotStarted) && !IsBusy && !IsBiometric;

    /// <summary>The update banner's button: "Download", then "Show file" once it is saved.</summary>
    [ObservableProperty] private string _downloadLabel = "Download";

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(DownloadUpdateCommand))]
    private bool _isDownloading;

    private string? _downloadedPath;

    /// <summary>
    /// The agent saves the verified build to Downloads itself (a browser link would
    /// need the agent's sign-in) and shows it in Finder or Explorer.
    /// </summary>
    [RelayCommand(CanExecute = nameof(CanDownloadUpdate))]
    private async Task DownloadUpdateAsync()
    {
        if (_downloadedPath is { } saved && File.Exists(saved))
        {
            Reveal(saved);
            return;
        }
        var version = _agent.PendingUpdate?.Version ?? "";
        IsDownloading = true;
        DownloadLabel = "Downloading...";
        UpdateText = $"Downloading RX Vision {version}...";
        try
        {
            var result = await _agent.DownloadUpdateAsync();
            if (result.Path is { } path)
            {
                _downloadedPath = path;
                DownloadLabel = "Show file";
                UpdateText = _agent.Platform.Name == "mac"
                    ? $"RX Vision {version} is in your Downloads folder. Open the zip and drag the new RX Vision into Applications to replace this one."
                    : $"RX Vision {version} is in your Downloads folder. Run the new installer.";
                Reveal(path);
            }
            else
            {
                DownloadLabel = "Try again";
                UpdateText = result.Error ?? "Couldn't download the update. Try again in a moment.";
            }
        }
        catch (Exception ex)
        {
            _log.Warn("ui", "update download failed", ex);
            DownloadLabel = "Try again";
            UpdateText = "Couldn't download the update. Try again in a moment.";
        }
        finally
        {
            IsDownloading = false;
        }
    }

    private bool CanDownloadUpdate() => !IsDownloading;

    private void Reveal(string path)
    {
        try { _agent.Platform.Shell.RevealFile(path); }
        catch (Exception ex) { _log.Warn("ui", "could not show the downloaded update", ex); }
    }

    [RelayCommand]
    private void AllowScreenRecording()
    {
        try
        {
            // Never asked yet: the system prompt is the way in (it offers to open
            // Settings itself). Asked and refused: only Settings can change it.
            // Doing both at once showed two prompts on macOS 15.
            var permissions = _agent.Platform.Permissions;
            if (permissions.ScreenRecording == PermissionState.NotDetermined) permissions.RequestScreenRecording();
            else permissions.OpenScreenRecordingSettings();
        }
        catch (Exception ex)
        {
            _log.Warn("ui", "could not open screen recording settings", ex);
        }
    }

    [RelayCommand]
    private void DismissScreenRecording()
    {
        _screenRecordingDismissed = true;
        ShowScreenRecordingBanner = false;
    }

    [RelayCommand]
    private void DismissUpdate() => UpdateText = null;

    // ---- Refresh ------------------------------------------------------------------------------

    /// <summary>Recomputes everything from the agent. Cheap; call it every second while visible.</summary>
    public void Refresh()
    {
        try
        {
            RefreshCore();
        }
        catch (Exception ex)
        {
            _log.Error("ui", "dashboard refresh failed", ex);
        }
    }

    private void RefreshCore()
    {
        var state = _agent.State;
        var now = _agent.Now;
        var panel = _agent.BreakPanel;
        var presence = _agent.Presence;
        var running = state == AgentState.Running;
        var workday = _agent.Workday;

        DisplayName = _agent.User?.DisplayName ?? "";
        Initials = Fmt.Initials(DisplayName);
        CanQuit = _actions.CanQuit;
        StatusText = _agent.AwaySince is not null && running && panel.Active is null && presence.Status == PresenceStatus.Working
            ? "Away"
            : MenuState.StatusText(state, presence.Status, panel.Active is not null);
        StatusKind = state switch
        {
            AgentState.Running when panel.Active is { Overrun: true } => BubbleStatus.Overrun,
            AgentState.Running when panel.Active is not null || presence.Status is PresenceStatus.Break or PresenceStatus.Lunch => BubbleStatus.Away,
            AgentState.Running when presence.Status == PresenceStatus.Meeting => BubbleStatus.Meeting,
            AgentState.Running when _agent.AwaySince is not null => BubbleStatus.Away,
            AgentState.Running => BubbleStatus.Working,
            _ => BubbleStatus.Idle,
        };
        IsDayEnded = state == AgentState.DayEnded;
        IsNotStarted = state == AgentState.NotStarted;
        IsRunning = running;
        DayStartedText = workday?.StartedAt is { } started && state != AgentState.NotStarted
            ? $"Day started {_agent.BusinessTime(started)}"
            : null;
        UpdateSync(state);
        UpdateProgress();
        UpdateTotals();

        var active = panel.Active ?? (running && presence.Status is PresenceStatus.Break or PresenceStatus.Lunch
            ? FromPresence(presence, now)
            : null);
        IsOnBreak = running && active is not null;
        if (IsOnBreak) ActiveBreak.Update(active!, _agent.BusinessTime, _actions.Approver, now);
        else ActiveBreak.CanPause = false;
        PauseBreakCommand.NotifyCanExecuteChanged();
        IsInMeeting = running && !IsOnBreak
            && DayStatusReader.Of(state, _agent.DayProgress, presence.Status, panel.Active is not null) == DayStatus.InMeeting;
        if (IsInMeeting) UpdateMeeting(presence, now);

        var focus = _agent.FocusSec;
        UpdateFocus(state, workday, focus, presence);
        var allowance = _agent.Allowance;
        Today.UpdateAllowance(allowance);
        UpdatePaid(state, workday, focus, allowance);
        IsBiometric = _agent.IsBiometric;
        UpdateDayNotes(workday);
        UpdateNotStarted(state, workday, panel, now);
        UpdateEnded(state, workday, focus, now);
        UpdateTiles(state, panel, focus);
        UpdateSchedule(panel, now);
        // "Decided today": the business date of the decision against the business date now
        // (a night shift's day keeps its start date past midnight, the clock does not).
        Today.UpdateWaiting(_agent.MyApprovals, _agent.BusinessDate(now), _agent.BusinessDate,
            _actions.Approver == "your manager" ? "Waiting for your manager" : _actions.Approver == "your admin" ? "Waiting for your admin" : "Waiting for an admin");
        UpdateBanners(now);
        if (IsHistoryPage) History.Tick(DateTimeOffset.UtcNow);
        EndDayCommand.NotifyCanExecuteChanged();
        StartDayCommand.NotifyCanExecuteChanged();
    }

    private void UpdateFocus(AgentState state, WorkdayToday? workday, int focus, CurrentPresence presence)
    {
        string status;
        var target = workday?.TargetSec is { } t and > 0 ? t : workday?.ExpectedSec ?? 0;
        if (state == AgentState.Running)
        {
            var activeType = _agent.BreakPanel.Active?.PresenceType;
            status = IsOnBreak
                ? (presence.Status == PresenceStatus.Lunch || activeType == PresenceStatus.Lunch ? "Paused · at lunch" : "Paused · on a break")
                : _agent.AwaySince is { } away ? $"Paused · away since {_agent.BusinessTime(away)}"
                : IsInMeeting ? "Counting · in a meeting" : "Counting";
        }
        else if (state == AgentState.DayEnded)
        {
            status = workday?.EndedAt is { } ended
                ? workday.AutoClosed
                    ? $"Closed at {_agent.BusinessTime(ended)}, no End Day"
                    : $"Day ended at {_agent.BusinessTime(ended)}"
                : "Day ended";
        }
        else if (state == AgentState.NotStarted && workday?.LastEnded is { } last && last.EndedAt != default)
        {
            // Hours after a night shift or an End Day past midnight: that day's focus
            // time, until the next day starts.
            Today.UpdateFocus(last.FocusSec, $"Last day · ended {_agent.BusinessTime(last.EndedAt)}", null, 0, 0, target);
            return;
        }
        else
        {
            status = workday?.IsWorkingDay == false
                ? $"{(string.IsNullOrWhiteSpace(workday.DayLabel) ? "Not a working day" : workday.DayLabel)} · starts when you press Start Day"
                : "Starts when you press Start Day";
        }
        Today.UpdateFocus(focus, status, DayStartedText,
            workday?.Focus.PendingPlusSec ?? 0, workday?.Focus.PendingMinusSec ?? 0, target, workday?.Focus.AdjustedSec ?? 0);
    }

    /// <summary>
    /// Paid time (SPEC 2.4: focus + paid breaks) once today has started, and the offline time the
    /// server has no activity data for yet. Paid time adds up the two numbers on screen (focus and
    /// the paid breaks line), so it ticks with them; it can only be above the server's while some
    /// offline break time is unverified, which the offline line explains.
    /// </summary>
    private void UpdatePaid(AgentState state, WorkdayToday? workday, int focus, Core.Offline.AllowanceNow allowance)
    {
        var today = state is AgentState.Running or AgentState.DayEnded;
        Today.UpdatePaid(today ? focus + allowance.PaidUsedSec : null, today ? workday?.Focus.UnverifiedSec ?? 0 : 0);
    }

    /// <summary>What the day view says about today: off, on leave, at home, and a late start's missing note.</summary>
    private void UpdateDayNotes(WorkdayToday? workday)
    {
        DayOffText = workday?.DayOff is { } off
            ? string.IsNullOrWhiteSpace(off.Name) ? "Today is a day off" : $"Today is {off.Name!.Trim()}"
            : null;
        LeaveText = workday?.Leave is { } leave
            ? string.IsNullOrWhiteSpace(leave.Categories) ? $"On leave today · {leave.Label}" : $"On leave today · {leave.Label} · {leave.Categories}"
            : null;
        WfhText = workday?.Wfh is { Label: { Length: > 0 } wfh } ? $"Work from home ({Fmt.Lower(wfh)})" : null;
        LateReasonText = workday?.LateStart is { NeedsReason: true } late
            ? $"Your day started {Fmt.Minutes(late.Minutes)} after your shift start. Add a short note for {_actions.Approver}."
            : null;
        CheckoutMissingText = IsBiometric && workday?.CheckoutMissing == true
            ? "Your day was closed with no check-out punch. Ask your manager if the time is wrong."
            : null;
    }

    private void UpdateNotStarted(AgentState state, WorkdayToday? workday, BreakPanel panel, DateTimeOffset now)
    {
        if (state != AgentState.NotStarted)
        {
            DayCheckText = null;
            LastEndedText = null;
            return;
        }
        var first = Fmt.FirstName(_agent.User?.FirstName ?? _agent.User?.DisplayName);
        var greeting = Fmt.Greeting(_agent.BusinessLocal(now));
        GreetingText = first.Length > 0 ? $"{greeting}, {first}." : $"{greeting}.";
        var shift = workday?.Shift;
        ShiftLine = shift is not null
            ? $"{shift.Name} shift · {Fmt.Hm12(shift.Start)} to {Fmt.Hm12(shift.End)}"
            : panel.ShiftName is not null
                ? panel.ShiftHours is null ? panel.ShiftName : $"{panel.ShiftName} shift · {panel.ShiftHours.Replace(" - ", " to ")}"
                : null;
        DayCheckText = !_agent.DayKnown
            ? "Can't reach RX Vision to check your day. You can still start it: it is sent as soon as the connection is back."
            : null;
        LastEndedText = workday?.LastEnded is { } last && last.EndedAt != default
            ? $"Your day of {Fmt.DayLabel(last.Date)} ended at {_agent.BusinessTime(last.EndedAt)} with {Fmt.Focus(last.FocusSec)} of focus time. Start Day when your next one begins."
            : null;
    }

    private void UpdateEnded(AgentState state, WorkdayToday? workday, int focus, DateTimeOffset now)
    {
        if (state != AgentState.DayEnded) return;
        EndedTitle = workday?.EndedAt is { } ended
            ? workday.AutoClosed
                ? $"Your day was closed at {_agent.BusinessTime(ended)}."
                : $"Your day ended at {_agent.BusinessTime(ended)}."
            : "Your day has ended.";
        // End Day after midnight (a night shift) ends the day it started on: say which.
        var which = workday is { Date.Length: > 0 } && workday.Date != _agent.BusinessDate(now)
            ? $"Focus time on {Fmt.DayLabel(workday.Date)}"
            : "Focus time today";
        EndedDetail = $"{which}: {Fmt.Focus(focus)}. Nothing is recorded now. Still working? Start Day again.";
    }

    private void UpdateMeeting(CurrentPresence presence, DateTimeOffset now)
    {
        var live = _agent.LiveMeeting;
        var since = live?.StartedAt is { } s && s != default ? s
            : _agent.DayProgress?.MeetingStartedAt
            ?? presence.Since ?? now - TimeSpan.FromSeconds(presence.ElapsedSec);
        MeetingTimer = Fmt.Clock(now - since);
        MeetingStarted = $"Started {_agent.BusinessTime(since)}";
        // In a meeting (3.6) has no agenda and no people; a meeting recorded with its details has both.
        MeetingAgenda = live?.Agenda is { Length: > 0 } agenda ? agenda
            : string.IsNullOrWhiteSpace(presence.Note) ? "In a meeting" : presence.Note!.Trim();
        var people = live?.Participants ?? new List<MeetingParticipant>();
        var key = string.Join("|", people.Select(p => p.Name));
        if (key != _peopleKey)
        {
            _peopleKey = key;
            MeetingPeople.Clear();
            foreach (var p in people.Take(5)) MeetingPeople.Add(new MeetingPersonViewModel(Fmt.Initials(p.Name), p.Name));
        }
        MeetingPeopleText = people.Count == 0 ? "" : string.Join(", ", people.Select(p => p.Name));
        MeetingMomText = string.IsNullOrWhiteSpace(live?.MomSender) ? null : $"Minutes: {live!.MomSender!.Trim()}";
    }

    /// <summary>
    /// The header pill (SPEC 6): "Offline · 3 actions waiting" while actions wait and
    /// the server can't be reached, "Syncing · 3 actions waiting" while they go,
    /// "Online · synced 2:05 PM" once everything is there.
    /// </summary>
    private void UpdateSync(AgentState state)
    {
        var pending = _agent.PendingActions;
        var online = _agent.Online;
        var actions = Fmt.Count(pending, "action", "actions");
        if (pending > 0)
        {
            SyncText = online ? $"Syncing · {actions} waiting" : $"Offline · {actions} waiting";
            SyncTone = SyncTone.Pending;
            SyncToolTip = "Everything you do is saved on this computer first and sent to RX Vision in order. Nothing is lost while you're offline.";
            return;
        }
        if (!online && state is AgentState.Running or AgentState.NotStarted or AgentState.DayEnded)
        {
            SyncText = LastSyncOrNull() is { } at ? $"Offline · synced {_agent.BusinessTime(at)}" : "Offline";
            SyncTone = SyncTone.Pending;
            SyncToolTip = "Can't reach RX Vision. Everything still works; what you do is sent when the connection is back.";
            return;
        }
        switch (state)
        {
            case AgentState.DayEnded:
                SyncText = "Day ended · nothing recorded";
                SyncTone = SyncTone.Off;
                break;
            case AgentState.NotStarted:
                SyncText = "Not started · nothing recorded";
                SyncTone = SyncTone.Off;
                break;
            case AgentState.Running:
                SyncText = LastSyncOrNull() is { } synced ? $"Online · synced {_agent.BusinessTime(synced)}" : "Online";
                SyncTone = SyncTone.Ok;
                break;
            default:
                SyncText = state == AgentState.Connecting ? "Reconnecting..." : "";
                SyncTone = SyncTone.Off;
                break;
        }
        SyncToolTip = "Everything you did has reached RX Vision.";
    }

    /// <summary>When everything last reached the server: the actions, or the activity samples, whichever is later.</summary>
    private DateTimeOffset? LastSyncOrNull()
    {
        var actions = _agent.LastSyncAt;
        var samples = _agent.LastSampleSent == DateTimeOffset.MinValue ? (DateTimeOffset?)null : _agent.LastSampleSent;
        if (actions is null) return samples;
        if (samples is null) return actions;
        return actions > samples ? actions : samples;
    }

    private void UpdateTotals()
    {
        var totals = _agent.Totals;
        Today.UpdateTotals(totals.BreakSec, totals.LunchSec, totals.MeetingSec);
    }

    /// <summary>A break or lunch the schedule does not know about (an older server, or FREE mode): count up.</summary>
    private static ActiveBreakView FromPresence(CurrentPresence presence, DateTimeOffset now)
    {
        var lunch = presence.Status == PresenceStatus.Lunch;
        var since = presence.Since ?? now - TimeSpan.FromSeconds(presence.ElapsedSec);
        var record = new BreakRecord
        {
            Label = lunch ? "Lunch" : "Break",
            PresenceType = presence.Status,
            StartedAt = since,
            Timing = "UNSCHEDULED",
            ApprovalStatus = "NOT_REQUIRED",
        };
        return BreakSchedule.Active(record, null, now);
    }

    private void UpdateTiles(AgentState state, BreakPanel panel, int focus)
    {
        var running = state == AgentState.Running;
        const string ended = "Your day has ended";

        var minutes = _agent.Workday?.Config?.QuickBreakMinutes is { Count: > 0 } m ? m : new List<int> { 5, 10, 15 };
        QuickTile.ShowQuick(panel.QuickTakenSec, minutes, running);
        NextTile.ShowNext(panel, running);

        var total = $"{Fmt.Focus(focus)} today";
        if (!running) FocusTile.Set(total, ended, TileLook.Disabled, false);
        else if (_agent.AwaySince is not null) FocusTile.Set(total, "Paused while you're away", TileLook.Idle, false);
        else FocusTile.Set(total, "Working now", TileLook.Active, false);

        var meetingSec = _agent.Totals.MeetingSec;
        if (IsBiometric) MeetingTile.Set($"{Fmt.Duration(meetingSec)} today", "Your day is on the biometric device", TileLook.Disabled, false);
        else if (!running) MeetingTile.Set($"{Fmt.Duration(meetingSec)} today", ended, TileLook.Disabled, false);
        else MeetingTile.Set($"{Fmt.Duration(meetingSec)} today", "Tap to start one", TileLook.Idle, true);
    }

    private void UpdateSchedule(BreakPanel panel, DateTimeOffset now)
    {
        IsScheduled = panel.Scheduled;
        ShiftText = panel.ShiftName is null ? "" : panel.ShiftHours is null ? panel.ShiftName : $"{panel.ShiftName} · {panel.ShiftHours}";
        FreeText = "No break schedule today. Take a break or lunch whenever you need one.";

        var wanted = new List<(string Key, Action<BreakRowViewModel> Fill)>();
        foreach (var slot in panel.Slots) wanted.Add((slot.Kind, row => row.Update(slot, panel, _agent.BusinessTime, now)));
        foreach (var quick in panel.Quick.OrderBy(q => q.StartedAt)) wanted.Add(("Q:" + quick.Id, row => row.UpdateQuick(quick, _agent.BusinessTime, now)));
        foreach (var record in panel.Unscheduled) wanted.Add(("U:" + record.Id, row => row.UpdateUnscheduled(record, _agent.BusinessTime)));
        ShowFreeText = !panel.Scheduled && wanted.Count == 0;

        for (var i = Rows.Count - 1; i >= 0; i--)
            if (wanted.All(w => w.Key != Rows[i].Kind)) Rows.RemoveAt(i);
        for (var i = 0; i < wanted.Count; i++)
        {
            var (key, fill) = wanted[i];
            var row = Rows.FirstOrDefault(r => r.Kind == key);
            if (row is null)
            {
                row = new BreakRowViewModel(key);
                var created = row;
                row.CommentCommand = new AsyncRelayCommand(
                    () => created.RecordId is { } id ? _actions.CommentAsync(id) : Task.CompletedTask,
                    () => !IsBusy);
                row.ResumeCommand = new AsyncRelayCommand(_actions.ResumeAsync, () => !IsBusy && created.CanResume);
                row.EndCommand = new AsyncRelayCommand(_actions.EndBreakAsync, () => !IsBusy && created.CanEnd);
                Rows.Insert(Math.Min(i, Rows.Count), row);
            }
            else if (Rows.IndexOf(row) != i)
            {
                Rows.Move(Rows.IndexOf(row), i);
            }
            fill(row);
            row.ResumeCommand?.NotifyCanExecuteChanged();
            row.EndCommand?.NotifyCanExecuteChanged();
        }
    }

    private void UpdateBanners(DateTimeOffset now)
    {
        // An End Day done offline waiting for comments (the toast may have been missed).
        HeldEndDayText = _agent.HeldEndDay is { } held && _agent.State == AgentState.Running
            ? $"Your End Day at {_agent.BusinessTime(held.At)} needs {(held.Breaks.Count == 1 ? "a comment on a skipped break" : $"comments on {held.Breaks.Count} skipped breaks")}. Until then your day stays open."
            : null;

        var offer = _agent.PendingUpdate;
        if (offer is { CanInstall: false } && UpdateText is null && !_updateDismissed.Contains(offer.Version))
            UpdateText = $"RX Vision {offer.Version} is available. Download it and replace this app to update.";

        if (now - _permissionCheckedAt < TimeSpan.FromSeconds(5)) return;
        _permissionCheckedAt = now;
        if (_screenRecordingDismissed)
        {
            ShowScreenRecordingBanner = false;
            return;
        }
        try
        {
            var permission = _agent.Platform.Permissions.ScreenRecording;
            ShowScreenRecordingBanner = permission is PermissionState.Denied or PermissionState.NotDetermined;
        }
        catch (Exception ex)
        {
            _log.Debug("ui", $"screen recording permission unknown: {ex.Message}");
            ShowScreenRecordingBanner = false;
        }
    }

    private readonly HashSet<string> _updateDismissed = new();

    partial void OnUpdateTextChanged(string? oldValue, string? newValue)
    {
        if (newValue is null && _agent.PendingUpdate is { } offer) _updateDismissed.Add(offer.Version);
    }

    /// <summary>History may have changed (a decision, the calendar): reload it if it is open.</summary>
    public void OnHistoryChanged()
    {
        if (IsHistoryPage) _ = History.LoadAsync();
    }

    /// <summary>The person's leave changed (a decision, comp off): read it again if its page is open.</summary>
    public void OnLeaveChanged()
    {
        if (IsLeavePage) _ = Leave.LoadAsync();
    }

    /// <summary>The ring's value in words: the same reading as the icon (3.6).</summary>
    private void UpdateProgress()
    {
        _meter.Follow();
        var reading = _meter.Reading;
        ProgressLine = reading.PanelLine;
        ProgressNote = reading.PanelNote;
        ShowProgress = reading.Status != IconStatus.NotStarted;
    }

    /// <summary>Clears what belonged to the person who signed out.</summary>
    public void Reset()
    {
        Overlay?.Cancel();
        Chat.Reset();
        Leave.Reset();
        Calendar.Reset();
        Instructions.Reset();
        Rows.Clear();
        MeetingPeople.Clear();
        _peopleKey = "";
        _screenRecordingDismissed = false;
        UpdateText = null;
        _downloadedPath = null;
        DownloadLabel = "Download";
        IsMenuOpen = false;
        Page = DashboardPage.Dashboard;
    }
}
