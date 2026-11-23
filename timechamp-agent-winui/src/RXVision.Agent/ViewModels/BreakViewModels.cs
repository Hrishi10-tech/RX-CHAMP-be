using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>Colour of a status chip.</summary>
public enum Tone { Neutral, Open, Due, Active, Over, Good, Warn, Bad, Skip }

/// <summary>How an action looks: idle, open, due, on it now, or not available.</summary>
public enum TileLook { Idle, Open, Due, Active, Disabled }

/// <summary>
/// One action on Today (3.6 panel): an outlined button with a quiet line under it on what it
/// does now. 4.0 keeps its own actions: Next break (start the next scheduled break, or resume
/// a paused one), Quick break and Start meeting.
/// </summary>
public sealed partial class TileViewModel : ObservableObject
{
    public TileViewModel(string title) => Title = title;

    public TileViewModel(string title, string accent, string icon)
    {
        Title = title;
        Accent = accent;
        Icon = icon;
    }

    public string Title { get; }
    /// <summary>amber, teal, indigo or violet (4.0's tiles; the panel draws every action alike).</summary>
    public string Accent { get; } = "";
    /// <summary>The icon's resource key (4.0's tiles).</summary>
    public string Icon { get; } = "";
    public IRelayCommand? Command { get; set; }

    [ObservableProperty] private string _value = "";
    [ObservableProperty] private string _caption = "";
    [ObservableProperty] private string? _chip;
    [ObservableProperty] private string? _toolTip;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsIdle), nameof(IsOpen), nameof(IsDue), nameof(IsActive), nameof(IsDisabled))]
    private TileLook _look = TileLook.Idle;

    /// <summary>Whether a click does something (the command checks it).</summary>
    [ObservableProperty] private bool _canClick;

    partial void OnCanClickChanged(bool value) => Command?.NotifyCanExecuteChanged();

    public bool IsIdle => Look == TileLook.Idle;
    public bool IsOpen => Look == TileLook.Open;
    public bool IsDue => Look == TileLook.Due;
    public bool IsActive => Look == TileLook.Active;
    public bool IsDisabled => Look == TileLook.Disabled;

    public void Set(string value, string caption, bool canClick, string? toolTip = null) =>
        Set(value, caption, canClick ? TileLook.Idle : TileLook.Disabled, canClick, null, toolTip);

    public void Set(string value, string caption, TileLook look, bool canClick, string? chip = null, string? toolTip = null)
    {
        Value = value;
        Caption = caption;
        Look = look;
        CanClick = canClick;
        Chip = chip;
        ToolTip = toolTip ?? caption;
    }

    /// <summary>A break or lunch tile on a scheduled day: what the slot allows now (3.6).</summary>
    public void ShowSlot(SlotView? slot, bool lunch, bool dayEnded)
    {
        if (slot is null)
        {
            Set(lunch ? "No lunch today" : "No breaks today", "Not in your shift", false,
                toolTip: lunch ? "Your shift has no lunch today." : "Your shift has no breaks today.");
            return;
        }
        var reason = slot.ReasonRequired ? ", reason needed" : "";
        switch (slot.State)
        {
            case SlotState.Upcoming:
                Set($"Opens {slot.LocalWindowOpen}", $"{slot.Label} at {slot.LocalStart}", false,
                    toolTip: lunch ? $"Lunch opens at {slot.LocalWindowOpen}" : $"Next break opens at {slot.LocalWindowOpen}");
                break;
            case SlotState.OpenEarly:
                Set($"Open · due {slot.LocalStart}", $"{Fmt.Minutes(slot.MinutesOffIfStartedNow)} early{reason}", slot.CanStart);
                break;
            case SlotState.Due:
                Set($"Due now · {slot.LocalStart}", "On time now, no reason needed", slot.CanStart);
                break;
            case SlotState.OpenLate:
                Set($"Was due at {slot.LocalStart}", $"{Fmt.Minutes(slot.MinutesOffIfStartedNow)} after its time{reason}", slot.CanStart);
                break;
            case SlotState.InProgress:
                Set("On break", slot.Label, false);
                break;
            default:
                Set("Done for today", lunch ? "No more lunch today" : "No more breaks today", false);
                break;
        }
        if (dayEnded) Set(Value, "Your day has ended", false);
    }

    /// <summary>
    /// The 4.0 Next break action: "Lunch at 12:20 PM" (upcoming), "Lunch · open now"
    /// (tap to start), "Lunch · paused" (tap to resume), or "No more breaks today".
    /// </summary>
    public void ShowNext(BreakPanel panel, bool running)
    {
        if (!panel.Scheduled)
        {
            Set("Break or lunch", running ? "Any time · tap to start" : "Your day has ended",
                running ? TileLook.Idle : TileLook.Disabled, running,
                toolTip: "There's no break schedule today: take a break or lunch whenever you need one.");
            return;
        }
        var slot = panel.Next;
        if (slot is null)
        {
            Set("None left today", "No more breaks · quick breaks still work", TileLook.Disabled, false,
                toolTip: "Every break in your shift is done or closed.");
        }
        else
        {
            var reason = slot.ReasonRequired ? ", reason needed" : "";
            // The break's name on the value line; when and how on the caption.
            switch (slot.State)
            {
                case SlotState.Upcoming:
                    Set(slot.Label, $"At {slot.LocalStart} · opens {slot.LocalWindowOpen}", TileLook.Disabled, false,
                        toolTip: $"{slot.Label} at {slot.LocalStart}, opens {slot.LocalWindowOpen}");
                    break;
                case SlotState.OpenEarly:
                    Set(slot.Label, $"Open now · {Fmt.Minutes(slot.MinutesOffIfStartedNow)} early{reason}", OpenLook(slot), slot.CanStart, "Open");
                    break;
                case SlotState.Due:
                    Set(slot.Label, "Due now · on time, tap to start", slot.CanStart ? TileLook.Due : TileLook.Disabled, slot.CanStart, "Due now");
                    break;
                case SlotState.OpenLate:
                    Set(slot.Label, $"Open now · {Fmt.Minutes(slot.MinutesOffIfStartedNow)} after its time{reason}", OpenLook(slot), slot.CanStart, "Open");
                    break;
                case SlotState.Paused:
                    Set(slot.Label, $"Paused · tap to resume by {slot.LocalWindowClose}",
                        slot.CanResume ? TileLook.Open : TileLook.Disabled, slot.CanResume, "Paused",
                        toolTip: $"Resume your {Fmt.Lower(slot.Label)} by {slot.LocalWindowClose}, or end it from Today's breaks.");
                    break;
                case SlotState.InProgress:
                    Set(slot.Label, "On it now", TileLook.Active, false);
                    break;
                default:
                    Set("None left today", "No more breaks · quick breaks still work", TileLook.Disabled, false);
                    break;
            }
        }
        if (!running) Set(Value, "Your day has ended", TileLook.Disabled, false);
    }

    /// <summary>The 4.0 Quick break action: today's quick-break total; any time the day runs.</summary>
    public void ShowQuick(int takenSec, IReadOnlyList<int> minutes, bool running)
    {
        var lengths = Lengths(minutes);
        Set($"{Fmt.Duration(takenSec)} today", running ? $"Any time · {lengths} min" : "Your day has ended",
            running ? TileLook.Idle : TileLook.Disabled, running,
            toolTip: $"A short break of {lengths} minutes, any time. It comes out of your paid break allowance.");
    }

    /// <summary>"5, 10 or 15".</summary>
    public static string Lengths(IReadOnlyList<int> minutes) =>
        minutes.Count == 0 ? "5, 10 or 15"
        : minutes.Count == 1 ? minutes[0].ToString(System.Globalization.CultureInfo.InvariantCulture)
        : string.Join(", ", minutes.Take(minutes.Count - 1)) + " or " + minutes[^1];

    private static TileLook OpenLook(SlotView slot) => slot.CanStart ? TileLook.Open : TileLook.Disabled;
}

/// <summary>One line of Today's breaks.</summary>
public sealed partial class BreakRowViewModel : ObservableObject
{
    public BreakRowViewModel(string kind) => Kind = kind;

    public string Kind { get; }

    /// <summary>The record behind the row (a skip that may take a comment), or null.</summary>
    public string? RecordId { get; private set; }

    /// <summary>Add comment (set by the dashboard).</summary>
    public IAsyncRelayCommand? CommentCommand { get; set; }
    /// <summary>Resume a paused break (set by the dashboard).</summary>
    public IAsyncRelayCommand? ResumeCommand { get; set; }
    /// <summary>End a paused break (set by the dashboard; it asks first).</summary>
    public IAsyncRelayCommand? EndCommand { get; set; }

    /// <summary>An auto-skip (or a skip) with no reason yet: the row offers Add comment.</summary>
    [ObservableProperty] private bool _canComment;

    /// <summary>Paused inside its window: the row offers Resume and End.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasActions))]
    private bool _canResume;

    /// <summary>Paused: the row offers End.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasActions))]
    private bool _canEnd;

    /// <summary>A quick break (4.0): the coffee icon in its own colour.</summary>
    [ObservableProperty] private bool _isQuick;

    public bool HasActions => CanResume || CanEnd;

    [ObservableProperty] private string _name = "";
    [ObservableProperty] private SlotState _state;
    [ObservableProperty] private string _pillText = "";
    [ObservableProperty] private Tone _pillTone;
    [ObservableProperty] private string? _approvalText;
    [ObservableProperty] private Tone _approvalTone;
    [ObservableProperty] private string _detail = "";
    [ObservableProperty] private bool _detailIsAlert;
    [ObservableProperty] private string? _note;
    /// <summary>The row's right side: "11:00 AM · Taken", "11:00 AM · Skipped" or the start time.</summary>
    [ObservableProperty] private string _rightText = "";
    /// <summary>The current row: bold, with Now on its right.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowRightText))]
    private bool _isCurrent;

    public bool ShowRightText => !IsCurrent;
    /// <summary>4.0: a break due now stands out (the panel marks it Now).</summary>
    public bool IsHighlighted => State == SlotState.Due;
    public bool HasNote => Note is not null;
    public bool HasApproval => ApprovalText is not null;
    public bool ShowChips => ShowTiming || HasApproval;
    /// <summary>The timing chip of a finished break, when it was not on time.</summary>
    public bool ShowTiming => State == SlotState.Taken && PillText != OnTime;
    /// <summary>The second line: what the plain row cannot say (a break still open, a skip, the minutes extended).</summary>
    public bool ShowDetail => !string.IsNullOrEmpty(Detail)
        && (DetailIsAlert || State is SlotState.OpenEarly or SlotState.OpenLate or SlotState.Closed or SlotState.Skipped or SlotState.AutoSkipped or SlotState.Unavailable or SlotState.Paused);
    /// <summary>For screen readers: the name and the state in words.</summary>
    public string SpokenText => $"{Name}: {PillText}";

    private const string OnTime = "On time";

    public void Update(SlotView slot, BreakPanel panel, Func<DateTimeOffset, string> hm, DateTimeOffset now)
    {
        Name = slot.Label;
        IsQuick = false;
        State = slot.State;
        ApprovalText = null;
        ApprovalTone = Tone.Neutral;
        DetailIsAlert = false;
        Note = null;
        RecordId = slot.Record?.Id;
        CanComment = false;
        CanResume = false;
        CanEnd = false;
        var reason = slot.ReasonRequired ? ", reason needed" : "";

        switch (slot.State)
        {
            case SlotState.Upcoming:
                Pill("Upcoming", Tone.Neutral);
                RightText = slot.LocalStart;
                Detail = $"Opens {slot.LocalWindowOpen} · due {slot.LocalStart}, {Fmt.Minutes(slot.DurationMin)}";
                break;
            case SlotState.OpenEarly:
                Pill("Open", Tone.Open);
                RightText = slot.LocalStart;
                Detail = $"Take it now · {Fmt.Minutes(slot.MinutesOffIfStartedNow)} early{reason}";
                break;
            case SlotState.Due:
                Pill("Due now", Tone.Due);
                RightText = slot.LocalStart;
                Detail = $"Take it now · on time until {hm(slot.RingEnd)}";
                break;
            case SlotState.OpenLate:
                Pill("Open", Tone.Open);
                RightText = slot.LocalStart;
                Detail = slot.ReasonRequired
                    ? "Take it now · a short note is needed"
                    : $"Take it now · {Fmt.Minutes(slot.MinutesOffIfStartedNow)} after its time";
                break;
            case SlotState.InProgress:
            {
                var active = panel.Active;
                var over = active is { Overrun: true };
                Pill(over ? "Break extended" : "In progress", over ? Tone.Over : Tone.Active);
                var started = active?.StartedAt ?? slot.Record?.StartedAt ?? slot.ScheduledStart;
                // After a resume the break ends later than start + length: what is left, from now.
                var backBy = active?.Remaining is { } left ? now + left : started.AddMinutes(active?.DurationMin ?? slot.DurationMin);
                RightText = hm(started);
                Detail = $"Started {hm(started)} · back by {hm(backBy)}";
                DetailIsAlert = over;
                break;
            }
            case SlotState.Paused:
            {
                Pill("Paused", Tone.Warn);
                var left = Math.Max(0, slot.DurationMin * 60 - slot.TakenSec);
                Detail = slot.CanResume
                    ? $"Taken {Fmt.Timer(slot.TakenSec)}, {Fmt.Timer(left)} left · resume by {slot.LocalWindowClose}"
                    : $"Taken {Fmt.Timer(slot.TakenSec)} · paused";
                CanResume = slot.CanResume;
                CanEnd = true;
                break;
            }
            case SlotState.Taken:
                ShowTaken(slot.Record, hm);
                break;
            case SlotState.Closed:
                Pill("Closed", Tone.Neutral);
                RightText = "Closed";
                Detail = $"Window closed at {slot.LocalWindowClose}";
                break;
            case SlotState.Skipped:
                Pill("Skipped", Tone.Skip);
                ShowDecision(slot.Record);
                RightText = $"{(slot.Record is { } mine ? hm(mine.StartedAt) : slot.LocalStart)} · Skipped";
                Detail = slot.Record is { } skipped
                    ? $"Skipped at {hm(skipped.StartedAt)} · focus time kept counting"
                    : "Skipped · focus time kept counting";
                ShowReason(slot.Record);
                CanComment = slot.Record is { NeedsComment: true };
                break;
            case SlotState.AutoSkipped:
            {
                var record = slot.Record;
                var at = record is null ? slot.LocalWindowClose : hm(record.StartedAt);
                Pill("Skipped for you", Tone.Warn);
                RightText = $"{at} · Skipped for you";
                if (record is { NeedsComment: true })
                {
                    CanComment = true;
                    Detail = $"Add a comment · skipped for you at {at}";
                }
                else
                {
                    Detail = $"Skipped for you at {at}";
                    ShowDecision(record);
                    ShowReason(record);
                }
                break;
            }
            case SlotState.Unavailable:
                Pill("Unavailable", Tone.Neutral);
                RightText = "Unavailable";
                Detail = $"Not available after {LaterTaken(slot, panel)}";
                break;
        }
    }

    private void ShowDecision(BreakRecord? record) =>
        (ApprovalText, ApprovalTone) = record?.ApprovalStatus switch
        {
            "PENDING" => ("Pending", Tone.Warn),
            "APPROVED" => ("Approved", Tone.Good),
            "REJECTED" => ("Not approved", Tone.Bad),
            _ => ((string?)null, Tone.Neutral),
        };

    /// <summary>The person's reason or comment in quotes, else the approver's note.</summary>
    private void ShowReason(BreakRecord? record)
    {
        if (record is null) return;
        if (!string.IsNullOrWhiteSpace(record.Reason)) Note = $"\u201C{record.Reason.Trim()}\u201D";
        if (!string.IsNullOrWhiteSpace(record.DecisionNote))
            Note = (Note is null ? "" : Note + " · ") + $"{(string.IsNullOrWhiteSpace(record.DecidedByName) ? "Manager" : record.DecidedByName)}: {record.DecisionNote.Trim()}";
    }

    /// <summary>A break from an older agent, outside the schedule.</summary>
    public void UpdateUnscheduled(BreakRecord record, Func<DateTimeOffset, string> hm)
    {
        RecordId = record.Id;
        CanComment = false;
        CanResume = false;
        CanEnd = false;
        IsQuick = false;
        Name = record.PresenceType == PresenceStatus.Lunch ? "Lunch (unscheduled)" : "Break (unscheduled)";
        State = record.InProgress ? SlotState.InProgress : SlotState.Taken;
        DetailIsAlert = false;
        if (record.InProgress)
        {
            Pill("In progress", Tone.Active);
            RightText = hm(record.StartedAt);
            Detail = $"Started {hm(record.StartedAt)}";
            ApprovalText = null;
            Note = null;
            return;
        }
        ShowTaken(record, hm);
    }

    /// <summary>A quick break (4.0): when, how long of how long planned; an away break has no plan.</summary>
    public void UpdateQuick(QuickBreakView quick, Func<DateTimeOffset, string> hm, DateTimeOffset now)
    {
        RecordId = quick.Id;
        CanComment = false;
        CanResume = false;
        CanEnd = false;
        IsQuick = true;
        ApprovalText = null;
        ApprovalTone = Tone.Neutral;
        Note = null;
        Name = quick.PlannedMin is null ? "Away break" : "Quick break";
        var running = quick.EndedAt is null;
        State = running ? SlotState.InProgress : SlotState.Taken;
        var taken = running
            ? (int)Math.Max(0, (now - quick.StartedAt).TotalSeconds)
            : quick.TakenSec > 0 ? quick.TakenSec : (int)Math.Max(0, (quick.EndedAt!.Value - quick.StartedAt).TotalSeconds);
        var plannedSec = (quick.PlannedMin ?? 0) * 60;
        var over = plannedSec > 0 && taken > plannedSec + 59;
        Pill(running ? (over ? "Over time" : "In progress") : "Quick", running ? (over ? Tone.Over : Tone.Active) : Tone.Neutral);
        var span = running ? $"Started {hm(quick.StartedAt)}" : $"{hm(quick.StartedAt)} - {hm(quick.EndedAt!.Value)}";
        var length = quick.PlannedMin is { } planned
            ? running ? $"{Fmt.Minutes(planned)} planned" : $"{Fmt.Timer(taken)} of {Fmt.Minutes(planned)}"
            : running ? "from when you were away" : Fmt.Timer(taken);
        Detail = $"{span} · {length}";
        DetailIsAlert = over;
    }

    private void ShowTaken(BreakRecord? record, Func<DateTimeOffset, string> hm)
    {
        if (record is null)
        {
            Pill("Taken", Tone.Good);
            RightText = "Taken";
            Detail = "";
            return;
        }
        var (timing, timingTone) = record.Timing switch
        {
            "LATE" => ("After its time", Tone.Warn),
            "EARLY" => ("Before its time", Tone.Warn),
            "OUTSIDE_WINDOW" => ("Outside window", Tone.Warn),
            "UNSCHEDULED" => ("Unscheduled", Tone.Neutral),
            _ => (OnTime, Tone.Good),
        };
        Pill(timing, timingTone);
        ShowDecision(record);
        RightText = $"{hm(record.StartedAt)} · Taken";

        var tookSec = record.TookSec > 0 || record.EndedAt is null
            ? record.TookSec
            : (int)(record.EndedAt.Value - record.StartedAt).TotalSeconds;
        var over = record.OverrunSec > 0;
        var span = record.EndedAt is { } ended ? $"{hm(record.StartedAt)} to {hm(ended)}" : $"Started {hm(record.StartedAt)}";
        Detail = $"{span} · {Fmt.Timer(tookSec)}{(over ? $", {Fmt.Timer(record.OverrunSec)} extended" : "")}";
        DetailIsAlert = over;

        if (!string.IsNullOrWhiteSpace(record.DecisionNote))
            Note = $"{(string.IsNullOrWhiteSpace(record.DecidedByName) ? "Manager" : record.DecidedByName)}: {record.DecisionNote.Trim()}";
        else if (record.ApprovalStatus == "REJECTED" && !string.IsNullOrWhiteSpace(record.DecidedByName))
            Note = $"Not approved by {record.DecidedByName}";
    }

    private static string LaterTaken(SlotView slot, BreakPanel panel)
    {
        var order = BreakKinds.All.ToList();
        var later = panel.Slots
            .Where(s => s.Record is not null && order.IndexOf(s.Kind) > order.IndexOf(slot.Kind))
            .OrderBy(s => order.IndexOf(s.Kind))
            .FirstOrDefault();
        return later?.Kind switch
        {
            BreakKinds.Lunch => "lunch",
            BreakKinds.Evening => "the evening break",
            BreakKinds.Morning => "the morning break",
            _ => "a later break",
        };
    }

    private void Pill(string text, Tone tone)
    {
        PillText = text;
        PillTone = tone;
    }

    partial void OnStateChanged(SlotState value) => RaiseLines();
    partial void OnPillTextChanged(string value) => RaiseLines();
    partial void OnDetailChanged(string value) => RaiseLines();
    partial void OnDetailIsAlertChanged(bool value) => RaiseLines();
    partial void OnNoteChanged(string? value) => OnPropertyChanged(nameof(HasNote));
    partial void OnApprovalTextChanged(string? value)
    {
        OnPropertyChanged(nameof(HasApproval));
        OnPropertyChanged(nameof(ShowChips));
    }

    private void RaiseLines()
    {
        OnPropertyChanged(nameof(IsHighlighted));
        OnPropertyChanged(nameof(ShowDetail));
        OnPropertyChanged(nameof(ShowTiming));
        OnPropertyChanged(nameof(ShowChips));
        OnPropertyChanged(nameof(SpokenText));
    }
}

/// <summary>Screen A on top of Today: the break that is due, Take a break, and Skip this break where the slot allows it.</summary>
public sealed partial class BreakDueViewModel : ObservableObject
{
    /// <summary>The slot's kind (null while no break is due).</summary>
    public string? Kind { get; private set; }
    public string PresenceType { get; private set; } = PresenceStatus.Break;

    [ObservableProperty] private string _title = "";
    [ObservableProperty] private string _detail = "";
    [ObservableProperty] private bool _canSkip;
    [ObservableProperty] private bool _isShown;

    public IAsyncRelayCommand? TakeCommand { get; set; }
    public IAsyncRelayCommand? SkipCommand { get; set; }

    public void Show(SlotView? slot)
    {
        Kind = slot?.Kind;
        IsShown = slot is not null;
        if (slot is null) return;
        PresenceType = slot.PresenceType;
        Title = $"Time for your {Fmt.Lower(slot.Label)}";
        Detail = $"{Fmt.Length(slot.DurationMin)}, from {slot.LocalStart}.";
        CanSkip = slot.CanSkip;
    }
}

/// <summary>
/// Today's progress in the panel's words, from the one number the ring reads: whole minutes,
/// so "3h 30m of 8h" and "4h 30m to go" always add up to the target.
/// </summary>
public readonly record struct DayProgressLines(string Done, string? Left, string LeftWhenResumed, bool Reached)
{
    /// <summary>A shift that sets no target reads 8 h (D-21).</summary>
    public const int DefaultTargetSec = 8 * 3600;

    public static int TargetOf(int expectedSec) => expectedSec > 0 ? expectedSec : DefaultTargetSec;

    public static DayProgressLines Of(int workedSec, int expectedSec)
    {
        var target = TargetOf(expectedSec);
        var workedMin = Math.Max(0, workedSec) / 60;
        var targetMin = target / 60;
        if (workedMin < targetMin)
        {
            var left = Fmt.Worked((targetMin - workedMin) * 60);
            return new DayProgressLines($"{Fmt.Worked(workedSec)} of {Fmt.Hours(target)}", $"{left} to go", $"{left} to go when you resume.", false);
        }
        var over = workedMin - targetMin;
        var extra = over > 0 ? $"{Fmt.PlusMinutes(over)} over target" : null;
        return new DayProgressLines($"Target reached · {Fmt.Worked(workedSec)} today", extra, extra ?? "It starts again when you resume.", true);
    }
}

/// <summary>
/// Screens B, C, E and F: on a break, the break extended, two minutes before it ends, and a
/// break with no length. Every line is worked out from the agent's view of the break and the
/// one clock behind it. 4.0 adds Pause (a scheduled break), quick breaks and away breaks, and
/// a resumed break that ends later than its start plus its length.
/// </summary>
public sealed partial class ActiveBreakViewModel : ObservableObject
{
    /// <summary>On break (C-601), or Break extended (C-607).</summary>
    [ObservableProperty] private string _statusText = "";
    /// <summary>The large timer: 32:18 counting down, then 04:32 counting up from zero (C-602, C-608).</summary>
    [ObservableProperty] private string _timer = "00:00";
    /// <summary>"left of your 45 min lunch break", then "Your lunch break ended at 1:45 PM."</summary>
    [ObservableProperty] private string _timerLine = "";
    /// <summary>"Ends at 1:45 PM", then "Resume work to start your ring again."</summary>
    [ObservableProperty] private string _endLine = "";
    /// <summary>Screen F: "12 min so far", on the minute; past an hour, "1h 05m so far".</summary>
    [ObservableProperty] private string _soFar = "";
    [ObservableProperty] private double _progress;
    /// <summary>False: a break with no length (screen F), which nothing can run past.</summary>
    [ObservableProperty] private bool _hasLength;
    [ObservableProperty] private bool _isOverrun;
    /// <summary>120 s or less left: screen E's card shows on top.</summary>
    [ObservableProperty] private bool _endsSoon;
    /// <summary>"Ring paused at 3h 30m": the ring's spoken name on a break.</summary>
    [ObservableProperty] private string _ringPaused = "";
    /// <summary>The focus time the ring holds at, beside it: "3h 30m".</summary>
    [ObservableProperty] private string _pausedAt = "";
    /// <summary>Under it: "of 8h focus time", or "Target reached" once the ring is full.</summary>
    [ObservableProperty] private string _pausedOf = "";
    /// <summary>Beside the ring, where "3h 30m of 8h" stands while working: "3h 30m of 8h", held.</summary>
    [ObservableProperty] private string _pausedLine = "";
    /// <summary>Under it: "Lunch break, 1:00 to 1:45 PM", or "Break since 10:00 AM" with no length.</summary>
    [ObservableProperty] private string _windowLine = "";
    /// <summary>Small, beside the ring: "Lunch break", then <see cref="Window"/> under it.</summary>
    [ObservableProperty] private string _windowLabel = "";
    /// <summary>"1:00 PM to 1:45 PM", or "Since 10:00 AM" for a break with no length.</summary>
    [ObservableProperty] private string _window = "";
    /// <summary>The ring's spoken name: "Ring paused at 3h 30m. Break extended · 04:32". The numbers the ring leaves out.</summary>
    [ObservableProperty] private string _ringName = "";
    /// <summary>"It starts again when you resume.", or "4h 30m to go when you resume." once extended.</summary>
    [ObservableProperty] private string _ringLine = "";
    /// <summary>The one-line form, for the hover label and screen readers: "Break extended · 04:32" (C-001).</summary>
    [ObservableProperty] private string _oneLine = "";
    /// <summary>"Morning break · after its time" or "· early"; null on time.</summary>
    [ObservableProperty] private string? _timingLine;
    /// <summary>"Sent to your department's managers for approval" while the start waits for its decision.</summary>
    [ObservableProperty] private string? _approval;
    /// <summary>While extended: "Extra minutes stay break time unless … approves them." Nobody decides a Super Admin's.</summary>
    [ObservableProperty] private string? _extraMinutes;

    // ---- 4.0 ---------------------------------------------------------------------------------
    /// <summary>"MORNING BREAK": the break's name.</summary>
    [ObservableProperty] private string _eyebrow = "";
    /// <summary>"Started 10:00 AM", "Started 10:00 AM · resumed 10:20 AM" after a pause.</summary>
    [ObservableProperty] private string _started = "";
    /// <summary>The timer as 4.0 showed it (the same as <see cref="Timer"/>).</summary>
    [ObservableProperty] private string _countdown = "00:00";
    /// <summary>What this break costs or how it ends: the paid buffer, a quick break's plan, an away break.</summary>
    [ObservableProperty] private string _note = "";
    [ObservableProperty] private bool _isLunch;
    /// <summary>A scheduled break: Pause is offered (4.0).</summary>
    [ObservableProperty] private bool _canPause;
    /// <summary>A quick break or an away break (4.0).</summary>
    [ObservableProperty] private bool _isQuick;
    /// <summary>4.0's word beside the timer: "left", "over", or "so far" for a break with no length.</summary>
    [ObservableProperty] private string _unit = "";
    /// <summary>4.0: "Over by 2 min" once past the length; null before.</summary>
    [ObservableProperty] private string? _overText;
    /// <summary>The break has a length, so its progress means something (4.0's name for <see cref="HasLength"/>).</summary>
    public bool HasProgress => HasLength;

    partial void OnHasLengthChanged(bool value) => OnPropertyChanged(nameof(HasProgress));

    /// <summary>4.0's form: a resumed break ends at <paramref name="now"/> plus what is left.</summary>
    public void Update(ActiveBreakView view, Func<DateTimeOffset, string> hm, string? approver, DateTimeOffset now) =>
        Update(view, hm, approver, 0, 0, now);

    /// <param name="approver">Who decides an early or late start and the minutes over, mid-sentence ("your department's managers"), or null when nobody does.</param>
    /// <param name="workedSec">The ring's value when the break began.</param>
    /// <param name="expectedSec">Today's focus target; 0 when unknown: 8 h.</param>
    /// <param name="now">Now, on the server's clock: a resumed break ends at now plus what is left. Null: its start plus its length.</param>
    public void Update(ActiveBreakView view, Func<DateTimeOffset, string> hm, string? approver = "your department's managers",
        int workedSec = 0, int expectedSec = 0, DateTimeOffset? now = null)
    {
        var label = Fmt.Lower(view.Label);
        IsLunch = view.PresenceType == PresenceStatus.Lunch;
        IsQuick = view.IsQuick;
        CanPause = view.CanPause;
        Eyebrow = view.Label.ToUpperInvariant();
        var timing = view.Timing switch { "LATE" => " · after its time", "EARLY" => " · early", _ => "" };
        Started = view.SegmentStartedAt is { } segment && segment - view.StartedAt > TimeSpan.FromSeconds(59)
            ? $"Started {hm(view.StartedAt)} · resumed {hm(segment)}"
            : $"Started {hm(view.StartedAt)}{timing}";
        Countdown = view.Countdown;
        TimingLine = view.Timing switch
        {
            "LATE" => $"{view.Label} · after its time",
            "EARLY" => $"{view.Label} · early",
            _ => null,
        };
        Approval = view.ApprovalStatus == "PENDING" && approver is not null ? $"Sent to {approver} for approval" : null;
        var lines = DayProgressLines.Of(workedSec, expectedSec);
        RingPaused = $"Ring paused at {Fmt.Worked(workedSec)}";
        PausedAt = Fmt.Worked(workedSec);
        PausedOf = lines.Reached ? "Target reached" : $"of {Fmt.Hours(DayProgressLines.TargetOf(expectedSec))} focus time";
        PausedLine = lines.Reached ? $"{PausedAt}, target reached" : $"{PausedAt} of {Fmt.Hours(DayProgressLines.TargetOf(expectedSec))}";

        if (view.Remaining is not { } remaining || view.DurationMin is not { } minutes)
        {
            StatusText = "On break";
            HasLength = false;
            IsOverrun = false;
            EndsSoon = false;
            Progress = 0;
            Timer = "";
            TimerLine = "";
            EndLine = "";
            ExtraMinutes = null;
            var elapsedMin = (int)view.Elapsed.TotalMinutes;
            SoFar = elapsedMin >= 60 ? $"{Fmt.Worked(elapsedMin * 60)} so far" : $"{Fmt.Minutes(elapsedMin)} so far";
            OneLine = $"On break · {SoFar}";
            RingLine = "It starts again when you resume.";
            WindowLabel = view.Label;
            Window = $"Since {hm(view.StartedAt)}";
            WindowLine = $"{view.Label} since {hm(view.StartedAt)}";
            Unit = "so far";
            OverText = null;
            RingName = $"{RingPaused}. {OneLine}";
            Note = view.IsQuick
                ? "Counting from when you were away. Your focus time is paused until you resume work."
                : "Your focus time is paused until you're back.";
            return;
        }

        // A break paused and resumed (4.0) ends later than its start plus its length.
        var endsAt = now is { } at ? at + remaining : view.StartedAt.AddMinutes(minutes);
        var ends = hm(endsAt);
        WindowLabel = view.Label;
        Window = $"{hm(view.StartedAt)} to {ends}";
        WindowLine = $"{view.Label}, {Fmt.Span(hm(view.StartedAt), ends)}";
        HasLength = true;
        SoFar = "";
        IsOverrun = view.Overrun;
        EndsSoon = BreakAlerts.EndsSoon(view);
        if (!view.Overrun)
        {
            StatusText = "On break";
            Timer = view.Countdown;
            TimerLine = $"left of your {Fmt.Length(minutes)} {label}";
            EndLine = $"Ends at {ends}";
            Progress = Math.Clamp(1 - remaining.TotalSeconds / (minutes * 60.0), 0, 1);
            OneLine = $"On break · {Timer}";
            RingLine = "It starts again when you resume.";
            Unit = "left";
            OverText = null;
            ExtraMinutes = null;
            Note = view.CanPause
                ? $"Back by {ends}. Your focus time is paused. Pause it if you need to step back in."
                : $"Back by {ends}. Your focus time is paused.";
        }
        else
        {
            StatusText = "Break extended";
            Timer = Fmt.Clock(remaining.Negate());
            TimerLine = $"Your {label} ended at {ends}.";
            EndLine = "Resume work to start your ring again.";
            Progress = 1;
            OneLine = $"Break extended · {Timer}";
            RingLine = lines.LeftWhenResumed;
            // 4.0: nobody is asked to count the minutes over; the paid buffer takes them first.
            ExtraMinutes = null;
            Unit = "over";
            OverText = $"Over by {Fmt.Minutes(Math.Max(1, (int)Math.Floor(-remaining.TotalMinutes)))}";
            Note = view.IsQuick
                ? $"Past the {Fmt.Minutes(minutes)} you planned. Minutes over come out of your paid buffer first."
                : "Minutes over come out of your paid buffer first, then count as unpaid break.";
        }
        RingName = $"{RingPaused}. {OneLine}";
    }
}
