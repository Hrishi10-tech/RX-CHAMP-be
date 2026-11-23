using System.Collections.ObjectModel;
using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>One summary chip: "Working days 21".</summary>
public sealed record HistoryChipViewModel(string Label, string Value, Tone Tone = Tone.Neutral);

/// <summary>One day of the month: its status, focus against target, breaks, meetings, what is pending.</summary>
public sealed class HistoryDayViewModel
{
    public HistoryDayViewModel(HistoryDay day, Func<DateTimeOffset, string> hm, string today)
    {
        Date = day.Date;
        DateText = Fmt.DayLabel(day.Date);
        IsToday = day.Date == today;
        (StatusText, StatusTone) = Status(day);
        Label = string.IsNullOrWhiteSpace(day.Label) || StatusText == day.Label!.Trim() ? null : day.Label!.Trim();
        IsMuted = day.Status is DayStatuses.Off or DayStatuses.Upcoming;
        FocusText = Fmt.Focus(day.FocusSec);
        TargetText = day.TargetSec > 0 ? $"of {Fmt.Hours(day.TargetSec)}" : day.FocusSec > 0 ? "no target" : "";
        Progress = day.TargetSec > 0 ? Math.Clamp(day.FocusSec / (double)day.TargetSec, 0, 1) : day.FocusSec > 0 ? 1 : 0;
        Times = day.StartedAt is { } start
            ? day.EndedAt is { } end ? $"{hm(start)} - {hm(end)}" : $"From {hm(start)}"
            : null;
        BreaksText = day.BreakSec > 0
            ? Fmt.RoundMinutes(day.UnpaidBreakSec) > 0
                ? $"Breaks {Fmt.Duration(day.BreakSec)} ({Fmt.Duration(day.UnpaidBreakSec)} unpaid)"
                : $"Breaks {Fmt.Duration(day.BreakSec)}"
            : null;
        var meetings = Fmt.Count(day.Meetings, "meeting", "meetings");
        MeetingsText = day.Meetings > 0 ? $"{meetings} · {Fmt.Duration(day.MeetingsSec)}" : null;
        PendingText = Fmt.EffectMinutes(day.PendingSec) > 0 ? $"{Fmt.PlusMinutes(Fmt.EffectMinutes(day.PendingSec))} if approved" : null;
        ApprovedAwayText = Fmt.EffectMinutes(day.ApprovedAwaySec) > 0 ? $"{Fmt.PlusMinutes(Fmt.EffectMinutes(day.ApprovedAwaySec))} away approved" : null;
        // Paid time (focus + paid breaks) on any day with time in it; the offline figure only when there is some.
        PaidText = day.Paid > 0 || day.StartedAt is not null ? $"Paid time {Fmt.Focus(day.Paid)}" : null;
        UnverifiedText = day.UnverifiedSec > 0 ? $"Offline, no activity data {Fmt.SomeDuration(day.UnverifiedSec)}" : null;
        IsShort = day.Status is DayStatuses.Half or DayStatuses.Absent;
    }

    public string Date { get; }
    public string DateText { get; }
    public bool IsToday { get; }
    public string StatusText { get; }
    public Tone StatusTone { get; }
    /// <summary>The calendar's label (a holiday's name) when the status chip does not say it.</summary>
    public string? Label { get; }
    public bool IsMuted { get; }
    public bool IsShort { get; }
    public string FocusText { get; }
    public string TargetText { get; }
    public double Progress { get; }
    public string? Times { get; }
    public string? BreaksText { get; }
    public string? MeetingsText { get; }
    public string? PendingText { get; }
    public string? ApprovedAwayText { get; }
    /// <summary>"Paid time 8h 10m" (focus + paid breaks); null on a day with no time at all.</summary>
    public string? PaidText { get; }
    /// <summary>"Offline, no activity data 25m"; null when there is none.</summary>
    public string? UnverifiedText { get; }
    public string UnverifiedToolTip => TodayViewModel.UnverifiedNote + ".";

    public static (string Text, Tone Tone) Status(HistoryDay day) => day.Status switch
    {
        DayStatuses.Full => ("Full day", Tone.Good),
        DayStatuses.Half => ("Half day", Tone.Warn),
        DayStatuses.Absent => ("Absent", Tone.Bad),
        DayStatuses.Off => (string.IsNullOrWhiteSpace(day.Label) ? "Day off" : day.Label!.Trim(), Tone.Neutral),
        DayStatuses.Extra => ("Extra day", Tone.Open),
        DayStatuses.InProgress => ("Today", Tone.Active),
        DayStatuses.Upcoming => ("Upcoming", Tone.Neutral),
        _ => (string.IsNullOrWhiteSpace(day.Status) ? "—" : day.Status, Tone.Neutral),
    };
}

/// <summary>A meeting of the month, with who mails the minutes.</summary>
public sealed class HistoryMeetingViewModel
{
    public HistoryMeetingViewModel(HistoryMeeting meeting, Func<DateTimeOffset, string> hm)
    {
        When = $"{Fmt.DayLabel(meeting.Date)} · {hm(meeting.StartedAt)} · {Fmt.Timer(meeting.DurationSec)}";
        Agenda = string.IsNullOrWhiteSpace(meeting.Agenda) ? "Meeting" : meeting.Agenda.Trim();
        People = meeting.Participants.Count == 0 ? null : "With " + string.Join(", ", meeting.Participants.Select(p => p.Name));
        Mom = string.IsNullOrWhiteSpace(meeting.MomSender) ? null : $"Minutes: {meeting.MomSender!.Trim()}";
        (StatusText, StatusTone) = DecisionChip(meeting.Status);
    }

    public string When { get; }
    public string Agenda { get; }
    public string? People { get; }
    public string? Mom { get; }
    public string? StatusText { get; }
    public Tone StatusTone { get; }

    public static (string? Text, Tone Tone) DecisionChip(string? status) => status switch
    {
        "PENDING" => ("Pending", Tone.Warn),
        "APPROVED" => ("Approved", Tone.Good),
        "REJECTED" => ("Rejected", Tone.Bad),
        "UNEXPLAINED" => ("Not explained", Tone.Bad),
        "LIVE" or "IN_PROGRESS" => ("In progress", Tone.Active),
        "NOT_REQUIRED" or null or "" => (null, Tone.Neutral),
        _ => (Fmt.Lower(status.Replace('_', ' ')) is { Length: > 0 } t ? char.ToUpperInvariant(t[0]) + t[1..] : status, Tone.Neutral),
    };
}

/// <summary>An away stretch of the month and what became of it.</summary>
public sealed class HistoryAwayViewModel
{
    public HistoryAwayViewModel(HistoryAway away, Func<DateTimeOffset, string> hm)
    {
        When = $"{Fmt.DayLabel(away.Date)} · {hm(away.StartedAt)} · {Fmt.Timer(away.Seconds)}";
        Reason = string.IsNullOrWhiteSpace(away.Reason) ? "No reason given" : away.Reason!.Trim();
        Comment = string.IsNullOrWhiteSpace(away.Comment) ? null : $"“{away.Comment!.Trim()}”";
        (StatusText, StatusTone) = HistoryMeetingViewModel.DecisionChip(away.Status);
    }

    public string When { get; }
    public string Reason { get; }
    public string? Comment { get; }
    public string? StatusText { get; }
    public Tone StatusTone { get; }
}

/// <summary>
/// History (SPEC 8.2): one month at a time, worked out live by the server (a
/// decision made later changes the past day at once). Reloaded on decisions and
/// calendar changes, and every 60 seconds while it is open; offline it shows the
/// copy saved last time.
/// </summary>
public sealed partial class HistoryViewModel : ObservableObject
{
    public static readonly TimeSpan ReloadEvery = TimeSpan.FromSeconds(60);
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    private readonly IAgent _agent;
    private readonly ILog _log;
    private int _version;
    private DateTimeOffset _loadedAt = DateTimeOffset.MinValue;

    public HistoryViewModel(IAgent agent, ILog log)
    {
        _agent = agent;
        _log = log;
        _month = CurrentMonth();
        _monthTitle = Title(_month);
    }

    public ObservableCollection<HistoryChipViewModel> Chips { get; } = new();
    public ObservableCollection<HistoryDayViewModel> Days { get; } = new();
    public ObservableCollection<HistoryMeetingViewModel> Meetings { get; } = new();
    public ObservableCollection<HistoryAwayViewModel> Away { get; } = new();

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(NextMonthCommand))]
    private string _month;

    [ObservableProperty] private string _monthTitle;
    [ObservableProperty] private bool _isLoading;
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasProblem))]
    private string? _problem;
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsStale))]
    private string? _staleText;
    [ObservableProperty] private bool _hasData;

    // The ring: focus against the month's target.
    [ObservableProperty] private double _ringSweep;
    [ObservableProperty] private string _focusText = "0m";
    [ObservableProperty] private string _targetText = "";
    [ObservableProperty] private string _trackText = "";
    [ObservableProperty] private bool _isBehind;
    [ObservableProperty] private string? _projectedText;

    [ObservableProperty] private bool _hasMeetings;
    [ObservableProperty] private bool _hasAway;
    [ObservableProperty] private bool _hasDays;

    /// <summary>The month's "Offline, no activity data" time ("2h 10m"); null when there is none.</summary>
    [ObservableProperty] private string? _unverifiedText;

    /// <summary>What "Offline, no activity data" means, while the month has some; else null.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasUnverified))]
    private string? _unverifiedNote;

    public bool HasUnverified => UnverifiedNote is not null;
    public bool HasProblem => Problem is not null;
    public bool IsStale => StaleText is not null;

    public string CurrentMonth() => _agent.BusinessDate(_agent.Now)[..7];

    /// <summary>"October 2026".</summary>
    public static string Title(string month) =>
        DateTime.TryParseExact(month + "-01", "yyyy-MM-dd", Inv, DateTimeStyles.None, out var d) ? d.ToString("MMMM yyyy", Inv) : month;

    public static string Shift(string month, int by) =>
        DateTime.TryParseExact(month + "-01", "yyyy-MM-dd", Inv, DateTimeStyles.None, out var d) ? d.AddMonths(by).ToString("yyyy-MM", Inv) : month;

    [RelayCommand]
    private Task PreviousMonthAsync()
    {
        Month = Shift(Month, -1);
        return LoadAsync();
    }

    [RelayCommand(CanExecute = nameof(CanNextMonth))]
    private Task NextMonthAsync()
    {
        Month = Shift(Month, 1);
        return LoadAsync();
    }

    private bool CanNextMonth() => string.CompareOrdinal(Month, CurrentMonth()) < 0;

    [RelayCommand]
    private Task ReloadAsync() => LoadAsync();

    /// <summary>Every second while the page is open: reload once a minute.</summary>
    public void Tick(DateTimeOffset utcNow)
    {
        if (IsLoading) return;
        if (utcNow - _loadedAt >= ReloadEvery) _ = LoadAsync();
    }

    /// <summary>Opened from the menu: this month, fresh.</summary>
    public Task OpenAsync()
    {
        if (!HasData) Month = CurrentMonth();
        NextMonthCommand.NotifyCanExecuteChanged();
        return LoadAsync();
    }

    /// <summary>Loads the month shown. Never throws.</summary>
    public async Task LoadAsync()
    {
        var version = Interlocked.Increment(ref _version);
        var month = Month;
        MonthTitle = Title(month);
        IsLoading = true;
        _loadedAt = DateTimeOffset.UtcNow;
        try
        {
            var (history, fresh) = await _agent.GetHistoryAsync(month);
            if (version != Volatile.Read(ref _version)) return;
            if (history is null)
            {
                Clear();
                Problem = "Can't load this month right now. History needs RX Vision once; it opens offline after that.";
                StaleText = null;
                return;
            }
            Problem = null;
            StaleText = fresh ? null : "Offline · showing the copy saved earlier";
            Show(history);
        }
        catch (Exception ex)
        {
            _log.Warn("ui", "history load failed", ex);
            if (version == Volatile.Read(ref _version)) Problem = "Can't load this month right now. Try again in a moment.";
        }
        finally
        {
            if (version == Volatile.Read(ref _version)) IsLoading = false;
            NextMonthCommand.NotifyCanExecuteChanged();
        }
    }

    private void Clear()
    {
        HasData = false;
        UnverifiedText = null;
        UnverifiedNote = null;
        Chips.Clear();
        Days.Clear();
        Meetings.Clear();
        Away.Clear();
        HasDays = HasMeetings = HasAway = false;
    }

    /// <summary>Fills the page from the server's month.</summary>
    public void Show(HistoryMonth h)
    {
        var today = _agent.BusinessDate(_agent.Now);
        var current = h.IsCurrent || h.Month == today[..7];
        HasData = true;

        FocusText = Fmt.Focus(h.FocusSec);
        TargetText = h.TargetSec > 0 ? $"of {Fmt.Hours(h.TargetSec)}" : "no target this month";
        RingSweep = h.TargetSec > 0 ? 360 * Math.Clamp(h.FocusSec / (double)h.TargetSec, 0, 1) : 0;
        (TrackText, IsBehind) = Track(h, today, current);
        ProjectedText = current && h.ProjectedSec > 0 && h.TargetSec > 0
            ? $"At this pace about {Fmt.Hours(h.ProjectedSec)} by the month's end"
            : null;

        Chips.Clear();
        Chips.Add(new HistoryChipViewModel("Working days", h.WorkingDays.ToString(Inv)));
        Chips.Add(new HistoryChipViewModel("Worked", Fmt.Focus(h.FocusSec), Tone.Good));
        Chips.Add(new HistoryChipViewModel("Paid time", Fmt.Focus(h.Paid)));
        Chips.Add(new HistoryChipViewModel("Paid breaks", Fmt.Duration(h.PaidBreakSec)));
        Chips.Add(new HistoryChipViewModel("Unpaid breaks", Fmt.Duration(h.UnpaidBreakSec), Fmt.RoundMinutes(h.UnpaidBreakSec) > 0 ? Tone.Warn : Tone.Neutral));
        Chips.Add(new HistoryChipViewModel("Meetings", Fmt.Duration(h.MeetingsSec)));
        Chips.Add(new HistoryChipViewModel("Pending approval",
            Fmt.EffectMinutes(h.PendingSec) > 0 ? Fmt.PlusMinutes(Fmt.EffectMinutes(h.PendingSec)) : "None",
            Fmt.EffectMinutes(h.PendingSec) > 0 ? Tone.Warn : Tone.Neutral));
        // Offline time with no activity data (SPEC 2.4): only when there is some, with what it means
        // (under the chips, as Today shows it).
        UnverifiedText = h.UnverifiedSec > 0 ? Fmt.SomeDuration(h.UnverifiedSec) : null;
        UnverifiedNote = h.UnverifiedSec > 0 ? TodayViewModel.UnverifiedNote : null;

        Days.Clear();
        foreach (var day in h.Days
                     .Where(d => d.Status != DayStatuses.Upcoming && string.CompareOrdinal(d.Date, today) <= 0)
                     .OrderByDescending(d => d.Date, StringComparer.Ordinal))
            Days.Add(new HistoryDayViewModel(day, _agent.BusinessTime, today));
        HasDays = Days.Count > 0;

        Meetings.Clear();
        foreach (var meeting in h.Meetings.OrderByDescending(m => m.StartedAt)) Meetings.Add(new HistoryMeetingViewModel(meeting, _agent.BusinessTime));
        HasMeetings = Meetings.Count > 0;

        Away.Clear();
        foreach (var away in h.Away.OrderByDescending(a => a.StartedAt)) Away.Add(new HistoryAwayViewModel(away, _agent.BusinessTime));
        HasAway = Away.Count > 0;
    }

    /// <summary>
    /// "On track" or "Behind by 6 h 20 m": this month, focus so far against the
    /// targets of the days before today; an earlier month, against the whole target.
    /// </summary>
    public static (string Text, bool Behind) Track(HistoryMonth h, string today, bool current)
    {
        if (h.TargetSec <= 0) return ("No working days with a target", false);
        if (!current)
        {
            var shortBy = h.TargetSec - h.FocusSec;
            return shortBy <= 0 ? ("Target met", false) : ($"Short by {Fmt.Spaced(shortBy)}", true);
        }
        var due = h.Days.Where(d => string.CompareOrdinal(d.Date, today) < 0).Sum(d => Math.Max(0, d.TargetSec));
        var behind = due - h.FocusSec;
        return behind < 60 ? ("On track", false) : ($"Behind by {Fmt.Spaced(behind)}", true);
    }
}
