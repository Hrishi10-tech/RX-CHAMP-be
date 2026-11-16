using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>Colour of a status chip.</summary>
public enum Tone { Neutral, Open, Due, Active, Over, Good, Warn, Bad, Skip }

/// <summary>How a quick-status tile looks.</summary>
public enum TileLook { Idle, Open, Due, Active, Disabled }

/// <summary>One quick-status tile: Take a Break, Lunch, Focus Work or Meeting.</summary>
public sealed partial class TileViewModel : ObservableObject
{
    public TileViewModel(string title, string accent, string icon)
    {
        Title = title;
        Accent = accent;
        Icon = icon;
    }

    public string Title { get; }
    /// <summary>amber, teal, indigo or violet (a style class).</summary>
    public string Accent { get; }
    /// <summary>The icon's resource key.</summary>
    public string Icon { get; }
    public bool IsAmber => Accent == "amber";
    public bool IsTeal => Accent == "teal";
    public bool IsIndigo => Accent == "indigo";
    public bool IsViolet => Accent == "violet";
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

    public void Set(string value, string caption, TileLook look, bool canClick, string? chip = null, string? toolTip = null)
    {
        Value = value;
        Caption = caption;
        Look = look;
        CanClick = canClick;
        Chip = chip;
        ToolTip = toolTip ?? caption;
    }

    /// <summary>
    /// The 4.0 Next break tile: "Lunch at 12:20 PM" (upcoming), "Lunch · open now"
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
            // The break's name on the value line (it fits the tile); when and how on the caption.
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
                    Set(slot.Label, $"Open now · {Fmt.Minutes(slot.MinutesOffIfStartedNow)} late{reason}", OpenLook(slot), slot.CanStart, "Open");
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

    /// <summary>The 4.0 Quick break tile: today's quick-break total; any time the day runs.</summary>
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
    [ObservableProperty] private bool _isLunch;
    [ObservableProperty] private SlotState _state;
    [ObservableProperty] private string _pillText = "";
    [ObservableProperty] private Tone _pillTone;
    [ObservableProperty] private string? _approvalText;
    [ObservableProperty] private Tone _approvalTone;
    [ObservableProperty] private string _detail = "";
    [ObservableProperty] private bool _detailIsAlert;
    [ObservableProperty] private string? _note;
    [ObservableProperty] private bool _isHighlighted;

    public void Update(SlotView slot, BreakPanel panel, Func<DateTimeOffset, string> hm, DateTimeOffset now)
    {
        Name = slot.Label;
        IsLunch = slot.PresenceType == PresenceStatus.Lunch;
        IsQuick = false;
        State = slot.State;
        IsHighlighted = slot.State == SlotState.Due;
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
                Detail = $"Opens {slot.LocalWindowOpen} · due {slot.LocalStart}, {Fmt.Minutes(slot.DurationMin)}";
                break;
            case SlotState.OpenEarly:
                Pill("Open", Tone.Open);
                Detail = $"Take it now · {Fmt.Minutes(slot.MinutesOffIfStartedNow)} early{reason}";
                break;
            case SlotState.Due:
                Pill("Due now", Tone.Due);
                Detail = $"Take it now · on time until {hm(slot.RingEnd)}";
                break;
            case SlotState.OpenLate:
                Pill("Open", Tone.Open);
                Detail = $"Take it now · {Fmt.Minutes(slot.MinutesOffIfStartedNow)} late{reason}";
                break;
            case SlotState.InProgress:
            {
                var active = panel.Active;
                var over = active is { Overrun: true };
                Pill(over ? "Over time" : "In progress", over ? Tone.Over : Tone.Active);
                var started = active?.StartedAt ?? slot.Record?.StartedAt ?? slot.ScheduledStart;
                // After a resume the break ends later than start + length: what is left, from now.
                var backBy = active?.Remaining is { } left ? now + left : started.AddMinutes(active?.DurationMin ?? slot.DurationMin);
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
                Detail = $"Window closed at {slot.LocalWindowClose}";
                break;
            case SlotState.Skipped:
                Pill("Skipped", Tone.Skip);
                ShowDecision(slot.Record);
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
                Pill("Auto-skipped", Tone.Warn);
                Detail = $"Auto-skipped at {at}";
                if (record is { NeedsComment: true })
                {
                    CanComment = true;
                    Detail += " · add a comment";
                }
                else
                {
                    ShowDecision(record);
                    ShowReason(record);
                }
                break;
            }
            case SlotState.Unavailable:
                Pill("Unavailable", Tone.Neutral);
                Detail = $"Not available after {LaterTaken(slot, panel)}";
                break;
        }
    }

    private void ShowDecision(BreakRecord? record) =>
        (ApprovalText, ApprovalTone) = record?.ApprovalStatus switch
        {
            "PENDING" => ("Pending", Tone.Warn),
            "APPROVED" => ("Approved", Tone.Good),
            "REJECTED" => ("Rejected", Tone.Bad),
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
        IsLunch = record.PresenceType == PresenceStatus.Lunch;
        State = record.InProgress ? SlotState.InProgress : SlotState.Taken;
        IsHighlighted = false;
        DetailIsAlert = false;
        if (record.InProgress)
        {
            Pill("In progress", Tone.Active);
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
        IsLunch = false;
        IsHighlighted = false;
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
            Detail = "";
            return;
        }
        var (timing, timingTone) = record.Timing switch
        {
            "LATE" => ("Late", Tone.Warn),
            "EARLY" => ("Early", Tone.Warn),
            "OUTSIDE_WINDOW" => ("Outside window", Tone.Warn),
            "UNSCHEDULED" => ("Unscheduled", Tone.Neutral),
            _ => ("On time", Tone.Good),
        };
        Pill(timing, timingTone);
        (ApprovalText, ApprovalTone) = record.ApprovalStatus switch
        {
            "PENDING" => ("Pending", Tone.Warn),
            "APPROVED" => ("Approved", Tone.Good),
            "REJECTED" => ("Rejected", Tone.Bad),
            _ => ((string?)null, Tone.Neutral),
        };

        var tookSec = record.TookSec > 0 || record.EndedAt is null
            ? record.TookSec
            : (int)(record.EndedAt.Value - record.StartedAt).TotalSeconds;
        var over = record.OverrunSec > 0;
        var span = record.EndedAt is { } ended ? $"{hm(record.StartedAt)} - {hm(ended)}" : $"Started {hm(record.StartedAt)}";
        Detail = $"{span} · {Fmt.Timer(tookSec)}{(over ? $", {Fmt.Timer(record.OverrunSec)} over" : "")}";
        DetailIsAlert = over;

        if (!string.IsNullOrWhiteSpace(record.DecisionNote))
            Note = $"{(string.IsNullOrWhiteSpace(record.DecidedByName) ? "Manager" : record.DecidedByName)}: {record.DecisionNote.Trim()}";
        else if (record.ApprovalStatus == "REJECTED" && !string.IsNullOrWhiteSpace(record.DecidedByName))
            Note = $"Rejected by {record.DecidedByName}";
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
}

/// <summary>The countdown panel shown in place of the tiles while on a break or lunch.</summary>
public sealed partial class ActiveBreakViewModel : ObservableObject
{
    [ObservableProperty] private string _eyebrow = "";
    [ObservableProperty] private string _started = "";
    [ObservableProperty] private string _countdown = "00:00";
    [ObservableProperty] private string _unit = "";
    [ObservableProperty] private string? _overText;
    [ObservableProperty] private double _progress;
    [ObservableProperty] private bool _hasProgress;
    [ObservableProperty] private string _note = "";
    [ObservableProperty] private string? _approval;
    [ObservableProperty] private bool _isOverrun;
    [ObservableProperty] private bool _isLunch;
    /// <summary>A scheduled break: Pause is offered (4.0).</summary>
    [ObservableProperty] private bool _canPause;
    [ObservableProperty] private bool _isQuick;

    /// <param name="approver">Who decides an early or late start, mid-sentence ("your manager").</param>
    /// <param name="now">Now, on the server's clock ("back by" is now plus what is left: a resumed break ends later).</param>
    public void Update(ActiveBreakView view, Func<DateTimeOffset, string> hm, string approver, DateTimeOffset now)
    {
        IsLunch = view.PresenceType == PresenceStatus.Lunch;
        IsQuick = view.IsQuick;
        CanPause = view.CanPause;
        Eyebrow = view.Label.ToUpperInvariant();
        var timing = view.Timing switch { "LATE" => " · late", "EARLY" => " · early", _ => "" };
        Started = view.SegmentStartedAt is { } segment && segment - view.StartedAt > TimeSpan.FromSeconds(59)
            ? $"Started {hm(view.StartedAt)} · resumed {hm(segment)}"
            : $"Started {hm(view.StartedAt)}{timing}";
        Countdown = view.Countdown;
        IsOverrun = view.Overrun;
        Approval = view.ApprovalStatus == "PENDING" ? $"Sent to {approver} for approval" : null;

        if (view.Remaining is not { } remaining || view.DurationMin is not { } minutes)
        {
            Unit = "so far";
            OverText = null;
            HasProgress = false;
            Progress = 0;
            Note = view.IsQuick
                ? "Counting from when you were away. Your focus time is paused until you end it."
                : "Your focus time is paused until you're back.";
            return;
        }

        HasProgress = true;
        if (!view.Overrun)
        {
            Unit = "left";
            OverText = null;
            Progress = Math.Clamp(1 - remaining.TotalSeconds / (minutes * 60.0), 0, 1);
            Note = view.CanPause
                ? $"Back by {hm(now + remaining)}. Your focus time is paused. Pause it if you need to step back in."
                : $"Back by {hm(now + remaining)}. Your focus time is paused.";
        }
        else
        {
            var over = (int)Math.Max(1, Math.Floor(-remaining.TotalMinutes));
            Unit = "over";
            OverText = $"Over by {Fmt.Minutes(over)}";
            Progress = 1;
            Note = view.IsQuick
                ? $"Past the {Fmt.Minutes(minutes)} you planned. Minutes over come out of your paid buffer first."
                : "Minutes over come out of your paid buffer first, then count as unpaid break.";
        }
    }
}
