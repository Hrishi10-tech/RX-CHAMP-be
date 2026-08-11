using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml.Media;
using TimeChampAgent.Helpers;
using TimeChampAgent.Services;

namespace TimeChampAgent.ViewModels;

/// <summary>
/// Drives the whole dashboard. All live state lives here as observable properties;
/// the view only binds and renders. A 1-second clock advances the timers locally and
/// every 5th tick re-syncs with the server (same cadence as the original agent).
/// </summary>
public partial class DashboardViewModel : ObservableObject
{
    private readonly ApiClient _api;
    private readonly DispatcherQueue _ui;
    private DispatcherQueueTimer? _clock;
    private int _tick;

    private readonly DateTime _shiftStart = DateTime.Now;
    private string _status = "WORKING";
    private int _onlineSec, _sessionElapsed, _breakSec, _lunchSec, _meetingSec;
    private int _basisSec = 9 * 3600;

    // Chat
    private string? _peerId;
    private string _peerName = "";
    private readonly HashSet<string> _renderedIds = new();
    private bool _chatLoaded;

    /// <summary>Set by the view: confirm dialog (title/body → yes?). </summary>
    public Func<string, Task<bool>>? ConfirmAsync { get; set; }
    /// <summary>Set by the view: text-prompt dialog (message → entered text or null).</summary>
    public Func<string, Task<string?>>? PromptAsync { get; set; }
    /// <summary>Set by App: sign the user out.</summary>
    public Func<Task>? SignOutRequested { get; set; }
    /// <summary>Set by App: end the working day (with confirm).</summary>
    public Func<Task>? EndDayRequested { get; set; }
    /// <summary>Set by App: resume the working day after an End Day.</summary>
    public Func<Task>? StartDayRequested { get; set; }

    // ---- Observable state --------------------------------------------------
    [ObservableProperty] private string _timerText = "00h : 00m : 00s";
    [ObservableProperty] private string _shiftStartedText = "";
    [ObservableProperty] private string _todayHoursValue = "0m";
    [ObservableProperty] private string _syncText = "SYNCED · Updated just now";
    [ObservableProperty] private double _ringFraction;
    [ObservableProperty] private double _focusFraction;
    [ObservableProperty] private string _focusScoreText = "—";

    [ObservableProperty] private string _breakValue = "0m / 30m";
    [ObservableProperty] private string _lunchValue = "0m / 60m";
    [ObservableProperty] private string _focusValue = "0m Total";
    [ObservableProperty] private string _meetingValue = "0m Total";
    [ObservableProperty] private SolidColorBrush _breakValueBrush = UiUtil.Brush("#8A93A8");
    [ObservableProperty] private SolidColorBrush _lunchValueBrush = UiUtil.Brush("#8A93A8");

    // "Time taken today" card values.
    [ObservableProperty] private string _breakTaken = "0m";
    [ObservableProperty] private string _lunchTaken = "0m";
    [ObservableProperty] private string _meetingTaken = "0m";

    [ObservableProperty] private bool _breakActive;
    [ObservableProperty] private bool _lunchActive;
    [ObservableProperty] private bool _focusActive = true;
    [ObservableProperty] private bool _meetingActive;

    [ObservableProperty] private bool _pauseEnabled = true;
    [ObservableProperty] private bool _resumeEnabled;
    [ObservableProperty] private double _pauseOpacity = 1.0;
    [ObservableProperty] private double _resumeOpacity = 0.5;

    [ObservableProperty] private string _chatHeader = "RX Champ Chat";
    [ObservableProperty] private string _chatInput = "";
    [ObservableProperty] private string _focusCaption = "";

    // ---- End of day --------------------------------------------------------
    // Once the day is ended nothing may keep counting: the local clock stops, the
    // status tiles go inert, and the banner says so. Set by App on End Day, and
    // re-read from the server on every refresh so a day ended elsewhere lands here too.

    [ObservableProperty] private bool _dayEnded;
    /// <summary>False once the day has ended — status tiles and End Day stop responding.</summary>
    [ObservableProperty] private bool _trackingEnabled = true;
    /// <summary>Dims the status tiles once they can no longer be used.</summary>
    [ObservableProperty] private double _tileOpacity = 1.0;

    partial void OnDayEndedChanged(bool value)
    {
        TrackingEnabled = !value;
        TileOpacity = value ? 0.45 : 1.0;

        if (!value)
        {
            // Resumed: the local clock and status come back to life; App follows
            // with a RefreshAsync that repaints the real status + totals.
            StartClock();
            SyncText = "Resuming…";
            return;
        }

        StopClock();
        ApplyStatus(DayEndedStatus);
        RenderTimers();
        SyncText = "DAY ENDED · today's hours are final";
    }

    /// <summary>Status the server reports for a day that has been ended.</summary>
    private const string DayEndedStatus = "DAY_ENDED";

    public ObservableCollection<BarViewModel> ProductivityBars { get; } = new();
    public ObservableCollection<ChatMessageViewModel> Messages { get; } = new();

    public DashboardViewModel(ApiClient api)
    {
        _api = api;
        _ui = DispatcherQueue.GetForCurrentThread();
        ShiftStartedText = _shiftStart.ToString("hh:mm tt");
    }

    public void StartClock()
    {
        if (_clock is not null) return;
        _clock = _ui.CreateTimer();
        _clock.Interval = TimeSpan.FromSeconds(1);
        _clock.Tick += (_, _) => OnClockTick();
        _clock.Start();
    }

    public void StopClock() => _clock?.Stop();

    public async Task LoadChatAsync()
    {
        if (_chatLoaded) return;
        _chatLoaded = true;

        var contacts = await _api.GetContactsAsync() ?? new List<ChatContact>();
        var peer = contacts.FirstOrDefault(c => c.Role == "MANAGER") ?? contacts.FirstOrDefault();
        if (peer is null) { ChatHeader = "No one to chat with yet"; return; }

        _peerId = peer.UserId;
        _peerName = peer.Name;
        ChatHeader = $"Chat · {_peerName}";

        Messages.Clear();
        _renderedIds.Clear();
        var history = await _api.GetConversationAsync(_peerId) ?? new List<ChatMessage>();
        foreach (var m in history) RenderMessage(m);
    }

    private void OnClockTick()
    {
        // The day's totals are final once it has ended — nothing ticks up after that.
        if (DayEnded) return;

        if (_status == "WORKING") _onlineSec++;
        else _sessionElapsed++;

        RenderTimers();
        if (++_tick % 5 == 0) _ = RefreshAsync();
    }

    public async Task RefreshAsync()
    {
        var today = await _api.GetTodayAsync();
        if (today is null) { SyncText = "Offline — will sync"; return; }

        _status = today.Current?.Status ?? "WORKING";
        if (_status == DayEndedStatus) DayEnded = true;
        _onlineSec = today.Totals.OnlineSec;
        _sessionElapsed = today.Current?.ElapsedSec ?? 0;
        _breakSec = today.Totals.BreakSec;
        _lunchSec = today.Totals.LunchSec;
        _meetingSec = today.Totals.MeetingSec;

        ApplyStatus(_status);
        RenderTimers();
        if (!DayEnded) SyncText = $"SYNCED · {DateTime.Now:HH:mm:ss}";

        var activity = await _api.GetActivityTodayAsync();
        if (activity is not null)
        {
            // The day may have been ended from the tray, or on a previous run.
            if (activity.DayEnded) DayEnded = true;
            if (activity.WorkingBasisSec > 0) _basisSec = activity.WorkingBasisSec;
            UpdateFocus(activity);
            UpdateBars(activity.Hourly);
            RingFraction = _basisSec > 0 ? _onlineSec / (double)_basisSec : 0;
        }
    }

    private void UpdateFocus(DailyActivity a)
    {
        var tracked = a.ActiveSec + a.IdleSec;
        if (tracked <= 0) { FocusScoreText = "—"; FocusFraction = 0; FocusCaption = ""; return; }
        var score = (int)Math.Round(100.0 * a.ActiveSec / tracked);
        FocusScoreText = $"{score}%";
        FocusFraction = score / 100.0;
        FocusCaption = score >= 80 ? "Excellent Focus!" : score >= 50 ? "Good Focus" : "Keep Going";
    }

    private void UpdateBars(List<HourBucket> hourly)
    {
        ProductivityBars.Clear();
        var nowHour = DateTime.Now.Hour;
        var start = Math.Max(0, nowHour - 10);

        var slice = new List<HourBucket>();
        for (var h = start; h <= nowHour; h++)
            slice.Add(hourly.FirstOrDefault(b => b.Hour == h) ?? new HourBucket { Hour = h });

        var max = Math.Max(1, slice.Max(b => b.ActiveSec));
        for (var i = 0; i < slice.Count; i++)
        {
            var b = slice[i];
            var frac = b.ActiveSec / (double)max;
            ProductivityBars.Add(new BarViewModel
            {
                Height = 5 + frac * 74,
                Fraction = frac,
                Opacity = b.Hour == nowHour ? 1.0 : 0.9,
                // Label the first, last and every 2nd hour so the axis isn't crowded.
                Label = (i == 0 || i == slice.Count - 1 || i % 2 == 0) ? HourLabel(b.Hour) : "",
            });
        }
    }

    /// <summary>Formats a 0–23 hour as a short label, e.g. 0→"12a", 13→"1p".</summary>
    private static string HourLabel(int hour)
    {
        var suffix = hour < 12 ? "a" : "p";
        var h12 = hour % 12; if (h12 == 0) h12 = 12;
        return $"{h12}{suffix}";
    }

    private void RenderTimers()
    {
        TimerText = FmtClock(_onlineSec);
        TodayHoursValue = FmtTotal(_onlineSec);
        RingFraction = _basisSec > 0 ? _onlineSec / (double)_basisSec : 0;

        BreakValue = _status == "BREAK" ? FmtRun(_sessionElapsed) : $"{Mins(_breakSec)}m / 30m";
        LunchValue = _status == "LUNCH" ? FmtRun(_sessionElapsed) : $"{Mins(_lunchSec)}m / 60m";
        FocusValue = $"{FmtTotal(_onlineSec)} Total";
        MeetingValue = _status == "MEETING" ? $"{FmtRun(_sessionElapsed)} · running" : $"{FmtTotal(_meetingSec)} Total";

        BreakValueBrush = UiUtil.Brush(_status == "BREAK" ? "#F59E0B" : "#8A93A8");
        LunchValueBrush = UiUtil.Brush(_status == "LUNCH" ? "#14B8A6" : "#8A93A8");

        // Running totals for the "Time Taken Today" card (a live session adds its elapsed).
        BreakTaken = FmtTotal(_breakSec + (_status == "BREAK" ? _sessionElapsed : 0));
        LunchTaken = FmtTotal(_lunchSec + (_status == "LUNCH" ? _sessionElapsed : 0));
        MeetingTaken = FmtTotal(_meetingSec + (_status == "MEETING" ? _sessionElapsed : 0));
    }

    private void ApplyStatus(string status)
    {
        // A day that has ended has no live status at all — every tile goes inert.
        if (status == DayEndedStatus)
        {
            BreakActive = LunchActive = MeetingActive = FocusActive = false;
            PauseEnabled = ResumeEnabled = false;
            PauseOpacity = ResumeOpacity = 0.5;
            return;
        }

        var working = status == "WORKING";
        BreakActive = status == "BREAK";
        LunchActive = status == "LUNCH";
        MeetingActive = status == "MEETING";
        FocusActive = working;

        PauseEnabled = working;
        ResumeEnabled = !working;
        PauseOpacity = working ? 1.0 : 0.5;
        ResumeOpacity = working ? 0.5 : 1.0;
    }

    /// <summary>Blocks a status change once the day is over. The server refuses these
    /// too — this just avoids a pointless round trip and a confusing error.</summary>
    private bool Blocked => DayEnded;

    // ---- Commands ----------------------------------------------------------

    [RelayCommand] private Task Pause() => Blocked ? Task.CompletedTask : Go(() => _api.StartAsync("BREAK", null));
    [RelayCommand] private Task Resume() => Blocked ? Task.CompletedTask : Go(() => _api.EndAsync());
    [RelayCommand] private Task FocusWork() => Blocked ? Task.CompletedTask : Go(() => _api.EndAsync());

    [RelayCommand]
    private async Task Break()
    {
        if (Blocked) return;
        if (ConfirmAsync is null || await ConfirmAsync("Are you sure you want to take a break? Your current timer will be paused."))
            await Go(() => _api.StartAsync("BREAK", null));
    }

    [RelayCommand]
    private async Task Lunch()
    {
        if (Blocked) return;
        if (ConfirmAsync is null || await ConfirmAsync("Are you sure you want to go to lunch? Your current timer will be paused."))
            await Go(() => _api.StartAsync("LUNCH", null));
    }

    [RelayCommand]
    private async Task Meeting()
    {
        if (Blocked) return;
        var note = PromptAsync is null ? null : await PromptAsync("Add a note for your manager (optional):");
        await Go(() => _api.StartAsync("MEETING", string.IsNullOrWhiteSpace(note) ? null : note));
    }

    [RelayCommand]
    private async Task EndDay()
    {
        if (Blocked) return;
        if (EndDayRequested is not null) await EndDayRequested();
    }

    [RelayCommand]
    private async Task StartDay()
    {
        // Only meaningful once the day has ended; App re-checks and resumes tracking.
        if (!DayEnded) return;
        if (StartDayRequested is not null) await StartDayRequested();
    }
    [RelayCommand] private async Task SignOut() { StopClock(); if (SignOutRequested is not null) await SignOutRequested(); }

    [RelayCommand]
    private async Task SendChat()
    {
        var text = ChatInput.Trim();
        if (string.IsNullOrEmpty(text) || _peerId is null) return;
        ChatInput = "";
        var sent = await _api.SendMessageAsync(_peerId, text);
        if (sent is not null) RenderMessage(sent);
    }

    private async Task Go(Func<Task> action)
    {
        _sessionElapsed = 0;
        await action();
        await RefreshAsync();
    }

    // ---- Chat rendering ----------------------------------------------------

    /// <summary>Called by App when a live message arrives — marshalled to the UI thread here.</summary>
    public void OnChatMessage(ChatMessage m)
    {
        _ui.TryEnqueue(() =>
        {
            if (_peerId is null) return;
            if (m.FromUserId != _peerId && m.ToUserId != _peerId) return;
            RenderMessage(m);
        });
    }

    private void RenderMessage(ChatMessage m)
    {
        if (!_renderedIds.Add(m.Id)) return; // dedupe REST echo vs socket delivery
        var incoming = !m.Mine;
        Messages.Add(new ChatMessageViewModel
        {
            Id = m.Id,
            Incoming = incoming,
            Sender = incoming ? _peerName : "You",
            Initials = incoming ? Initials(_peerName) : "ME",
            Time = m.CreatedAt.ToLocalTime().ToString("hh:mm tt"),
            Body = m.Body,
            AvatarHex = incoming ? "#E85D75" : "#2563EB",
        });
    }

    // ---- Formatting helpers ------------------------------------------------

    private static string Initials(string name)
    {
        var parts = name.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return "?";
        if (parts.Length == 1) return parts[0][..1].ToUpperInvariant();
        return (parts[0][..1] + parts[^1][..1]).ToUpperInvariant();
    }

    private static int Mins(int seconds) => Math.Max(0, seconds) / 60;

    private static string FmtClock(int seconds)
    {
        var t = TimeSpan.FromSeconds(Math.Max(0, seconds));
        return $"{(int)t.TotalHours:00}h : {t.Minutes:00}m : {t.Seconds:00}s";
    }

    private static string FmtRun(int seconds)
    {
        var t = TimeSpan.FromSeconds(Math.Max(0, seconds));
        return $"{(int)t.TotalMinutes}m {t.Seconds:00}s";
    }

    private static string FmtTotal(int seconds)
    {
        var t = TimeSpan.FromSeconds(Math.Max(0, seconds));
        return t.TotalHours >= 1 ? $"{(int)t.TotalHours}h {t.Minutes}m" : $"{t.Minutes}m";
    }
}
