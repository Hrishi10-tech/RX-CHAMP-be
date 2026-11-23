using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Icon;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>The colour of a waiting item's dot: what kind of thing it is.</summary>
public enum WaitingKind { Break, Lunch, Overrun, Meeting, Other }

/// <summary>One line of "Waiting for your manager": what it is and what it does to focus time.</summary>
public sealed class WaitingItemViewModel
{
    public WaitingItemViewModel(string key, string title, string chip, Tone chipTone, WaitingKind kind, string? toolTip)
    {
        Key = key;
        Title = title;
        Chip = chip;
        ChipTone = chipTone;
        Kind = kind;
        ToolTip = toolTip ?? title;
    }

    public string Key { get; }
    public string Title { get; }
    /// <summary>"+15 min if approved", "−15 min if rejected", or the decision ("+15 min added").</summary>
    public string Chip { get; }
    public Tone ChipTone { get; }
    public WaitingKind Kind { get; }
    public string ToolTip { get; }
}

/// <summary>
/// Today at a glance (3.1): focus time from the server, ticking while the day runs,
/// what is waiting to be decided, and time taken for breaks, lunch and meetings.
/// No activity percentage and no hourly bars: activity never changes focus time.
/// </summary>
public sealed partial class TodayViewModel : ObservableObject
{
    public const int MaxWaiting = 4;

    [ObservableProperty] private string _focusText = "0m";
    [ObservableProperty] private string _focusStatus = "";
    [ObservableProperty] private string? _dayStartedText;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasPlus))]
    private string? _plusText;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasMinus))]
    private string? _minusText;

    /// <summary>3.3: "+30 min adjusted" when a Super Manager changed today's focus time by hand.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasAdjusted))]
    private string? _adjustedText;

    [ObservableProperty] private double _progress;
    /// <summary>"3h 30m of 8h" (C-588), or "Target reached · 8h 00m today" (C-586).</summary>
    [ObservableProperty] private string _progressLine = "";
    /// <summary>"4h 30m to go" (C-589), "+15 min over target" (C-585), or null right at the target.</summary>
    [ObservableProperty] private string? _toGoLine;
    [ObservableProperty] private string _expectedText = "8h day";
    [ObservableProperty] private string _breakTotal = "0m";
    [ObservableProperty] private string _lunchTotal = "0m";
    [ObservableProperty] private string _meetingTotal = "0m";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasWaiting))]
    private int _waitingCount;

    [ObservableProperty] private string _waitingTitle = "Waiting for your manager";
    [ObservableProperty] private string? _waitingMore;

    public bool HasPlus => PlusText is not null;
    public bool HasMinus => MinusText is not null;
    public bool HasAdjusted => AdjustedText is not null;
    public bool HasWaiting => WaitingCount > 0;
    public ObservableCollection<WaitingItemViewModel> Waiting { get; } = new();

    /// <summary>"Paid breaks 1 h 05 m of 1 h 30 m · unpaid 0 m" (SPEC 8.1).</summary>
    [ObservableProperty] private string _allowanceText = "";
    /// <summary>Some break time is unpaid: the line turns amber.</summary>
    [ObservableProperty] private bool _hasUnpaid;
    [ObservableProperty] private string _allowanceToolTip = "";

    /// <summary>What the "Offline, no activity data" figure means (SPEC 2.4: it counts once the samples arrive).</summary>
    public const string UnverifiedNote = "Time recorded offline counts once the app's activity data for it arrives";

    /// <summary>"6h 10m": focus plus paid break time, what pay counts (SPEC 2.4 paidSec); null before Start Day.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasPaidTime))]
    private string? _paidTimeText;

    /// <summary>"1h 20m" of today recorded offline with no activity data yet; null when there is none.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasUnverified))]
    private string? _unverifiedText;

    public bool HasPaidTime => PaidTimeText is not null;
    public bool HasUnverified => UnverifiedText is not null;

    public const string PaidTimeToolTip = "Paid time is your focus time plus paid break time: what your pay counts.";

    /// <summary>
    /// Paid time (SPEC 2.4: focus + paid breaks) and the offline time the server has no
    /// activity data for. <paramref name="paidSec"/> null: nothing to show (the day has not
    /// started); <paramref name="unverifiedSec"/> shows only when above 0.
    /// </summary>
    public void UpdatePaid(int? paidSec, int unverifiedSec)
    {
        PaidTimeText = paidSec is { } paid ? Fmt.Focus(paid) : null;
        UnverifiedText = unverifiedSec > 0 ? Fmt.SomeDuration(unverifiedSec) : null;
    }

    public void UpdateTotals(int breakSec, int lunchSec, int meetingSec)
    {
        BreakTotal = Fmt.Duration(breakSec);
        LunchTotal = Fmt.Duration(lunchSec);
        MeetingTotal = Fmt.Duration(meetingSec);
    }

    /// <summary>The paid break allowance line (SPEC 2.4): what is used of it, and what went past it.</summary>
    public void UpdateAllowance(Core.Offline.AllowanceNow allowance)
    {
        AllowanceText = $"Paid breaks {Fmt.Spaced(allowance.PaidUsedSec)} of {Fmt.Spaced(allowance.TotalSec)} · unpaid {Fmt.Spaced(allowance.UnpaidSec)}";
        HasUnpaid = Fmt.RoundMinutes(allowance.UnpaidSec) > 0;
        AllowanceToolTip = $"Your shift's breaks ({Fmt.Spaced(allowance.ScheduledSec)}) plus a {Fmt.Spaced(allowance.BufferSec)} buffer are paid. " +
            "Minutes over a break and quick breaks come out of the buffer first; past it they are unpaid. Break time is never focus time.";
    }

    /// <summary>The focus panel: the number, why it is (not) moving, and what is still to be decided.</summary>
    /// <param name="expectedSec">Today's focus target (4.0: the shift minus the paid allowance, less part-day leave); 0 when unknown: 8 h.</param>
    /// <param name="adjustedSec">Signed seconds the Super Manager added or took off by hand.</param>
    /// <param name="dayEnded">The day is over: nothing is "to go" any more; what it reached stays.</param>
    public void UpdateFocus(int focusSec, string status, string? dayStarted, int pendingPlusSec, int pendingMinusSec, int expectedSec, int adjustedSec = 0, bool dayEnded = false)
    {
        FocusText = Fmt.Focus(focusSec);
        FocusStatus = status;
        DayStartedText = dayStarted;
        var plus = Fmt.EffectMinutes(pendingPlusSec);
        var minus = Fmt.EffectMinutes(pendingMinusSec);
        PlusText = plus > 0 ? $"{Fmt.PlusMinutes(plus)} if approved" : null;
        MinusText = minus > 0 ? $"{Fmt.MinusMinutes(minus)} if rejected" : null;
        AdjustedText = AdjustedLine(adjustedSec);
        // 4.0: the focus target is the shift less the paid break allowance, so it says Target.
        var expected = DayProgressLines.TargetOf(expectedSec);
        ExpectedText = $"Target {Fmt.Hours(expected)}";
        Progress = Math.Clamp(focusSec / (double)expected, 0, 1);
        var lines = DayProgressLines.Of(focusSec, expectedSec);
        ProgressLine = lines.Done;
        ToGoLine = dayEnded && !lines.Reached ? null : lines.Left;
    }

    /// <summary>The ring's own reading, so the panel's lines and the ring agree on the minute. Nothing is to go on a day that ended.</summary>
    public void ShowReading(DayReading reading)
    {
        Progress = reading.SweepDegrees / 360;
        ProgressLine = reading.PanelLine;
        ToGoLine = reading.PanelNote.Length == 0 || (reading.Status == IconStatus.DayEnded && !reading.Reached) ? null : reading.PanelNote;
    }

    /// <summary>3.3: focus time a Super Manager added or took off by hand, or null when none.</summary>
    public static string? AdjustedLine(int adjustedSec)
    {
        var minutes = Fmt.EffectMinutes(Math.Abs(adjustedSec));
        if (minutes == 0) return null;
        return $"{(adjustedSec > 0 ? Fmt.PlusMinutes(minutes) : Fmt.MinusMinutes(minutes))} adjusted by the Super Manager";
    }

    /// <summary>
    /// The waiting list: every pending item with its effect, then the items decided
    /// today with the decision. Rebuilt only when something changed.
    /// </summary>
    public void UpdateWaiting(IReadOnlyList<ApprovalItem> items, string? today, Func<DateTimeOffset, string> businessDate, string title)
    {
        WaitingTitle = title;
        var shown = new List<WaitingItemViewModel>();
        foreach (var item in items.Where(i => i.IsPending))
            shown.Add(new WaitingItemViewModel(Key(item), item.Title, EffectText(item), item.Effect.Mode == "PLUS" ? Tone.Good : Tone.Neutral,
                KindOf(item), item.Detail));
        foreach (var item in items.Where(i => !i.IsPending && i.DecidedAt is { } at && today is not null && businessDate(at) == today))
        {
            var rejected = item.Status == "REJECTED";
            var decision = rejected ? "Not approved" : "Approved";
            var effect = string.IsNullOrWhiteSpace(item.Effect.Text) ? decision : $"{decision} · {EffectText(item)}";
            shown.Add(new WaitingItemViewModel(Key(item), item.Title, effect, rejected ? Tone.Bad : Tone.Good, KindOf(item),
                string.IsNullOrWhiteSpace(item.DecisionNote) ? item.Detail : $"{item.DecidedByName ?? "Manager"}: {item.DecisionNote}"));
        }

        var visible = shown.Take(MaxWaiting).ToList();
        var key = string.Join("|", visible.Select(v => $"{v.Key}:{v.Title}:{v.Chip}"));
        if (key != _waitingKey)
        {
            _waitingKey = key;
            Waiting.Clear();
            foreach (var v in visible) Waiting.Add(v);
        }
        WaitingCount = shown.Count;
        WaitingMore = shown.Count > MaxWaiting ? $"and {shown.Count - MaxWaiting} more in the portal" : null;
    }

    private string _waitingKey = "";

    private static string Key(ApprovalItem item) => $"{item.Type}:{item.Id}:{item.Status}";

    /// <summary>The server's effect text; worked out from the numbers when it sent none.</summary>
    private static string EffectText(ApprovalItem item)
    {
        // A minus sign people read, even if a hyphen came over the wire.
        if (!string.IsNullOrWhiteSpace(item.Effect.Text))
            return item.Effect.Text.StartsWith('-') ? Fmt.Minus + item.Effect.Text[1..] : item.Effect.Text;
        return item.Effect.Mode switch
        {
            "PLUS" => $"{Fmt.PlusMinutes(item.Effect.Minutes)} if approved",
            "MINUS" => $"{Fmt.MinusMinutes(item.Effect.Minutes)} if rejected",
            _ => "No change to focus time",
        };
    }

    private static WaitingKind KindOf(ApprovalItem item) => item.Category switch
    {
        "MEETING_LIVE" or "MEETING_PAST" => WaitingKind.Meeting,
        "BREAK_OVERRUN" => WaitingKind.Overrun,
        _ when item.Type == "MEETING" => WaitingKind.Meeting,
        _ when item.Title.Contains("lunch", StringComparison.OrdinalIgnoreCase) => WaitingKind.Lunch,
        _ when item.Type == "BREAK" => WaitingKind.Break,
        _ => WaitingKind.Other,
    };
}
