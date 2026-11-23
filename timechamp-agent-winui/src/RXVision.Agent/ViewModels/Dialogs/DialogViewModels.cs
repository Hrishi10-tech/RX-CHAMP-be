using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core.Api;

namespace RXVision.Agent.ViewModels.Dialogs;

/// <summary>
/// A question for the person, shown over the dashboard (or on its own when the
/// dashboard is closed). Completes with true for the primary button, false for
/// Cancel, Esc or closing it, and false with <see cref="ChoseAlternative"/> set
/// for a third button (Skip break, Leave them out).
/// </summary>
public abstract partial class DialogViewModel : ObservableObject
{
    private readonly TaskCompletionSource<bool> _done = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public abstract string Title { get; }
    /// <summary>The card's width, in DIPs.</summary>
    public virtual double Width => 452;
    public Task<bool> Completion => _done.Task;
    public bool IsCompleted => _done.Task.IsCompleted;

    /// <summary>The person chose the third button (see <see cref="AlternativeCommand"/>).</summary>
    public bool ChoseAlternative { get; private set; }

    /// <summary>Why the last try did not go through (the server's answer), shown in the dialog.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    private string? _error;

    public bool HasError => !string.IsNullOrWhiteSpace(Error);

    protected virtual bool CanSubmit() => true;

    /// <summary>The primary button (and Enter).</summary>
    [RelayCommand(CanExecute = nameof(CanSubmit))]
    private void Submit()
    {
        if (CanSubmit()) Complete(true);
    }

    /// <summary>Cancel (and Esc, and closing the window).</summary>
    [RelayCommand]
    public void Cancel() => Complete(false);

    /// <summary>The third button: goes another way (completes false, with <see cref="ChoseAlternative"/> set).</summary>
    [RelayCommand]
    private void Alternative()
    {
        if (IsCompleted) return;
        ChoseAlternative = true;
        Complete(false);
    }

    protected void Complete(bool primary) => _done.TrySetResult(primary);
}

/// <summary>A confirmation (two buttons), a notice (one button), or a choice with a third button.</summary>
public sealed partial class MessageDialogViewModel : DialogViewModel
{
    public MessageDialogViewModel(string title, string message)
    {
        Title = title;
        Message = message;
    }

    public override string Title { get; }
    public string Message { get; }
    public string PrimaryText { get; init; } = "OK";
    /// <summary>Null for a notice with a single button.</summary>
    public string? CancelText { get; init; }
    /// <summary>A third button (e.g. "Skip break"), or null.</summary>
    public string? AltText { get; init; }
    public bool IsDanger { get; init; }
    public string? TagText { get; init; }
    public string? TagDetail { get; init; }
    public Tone TagTone { get; init; } = Tone.Warn;

    public bool HasCancel => CancelText is not null;
    public bool HasAlt => AltText is not null;
    public bool HasNoAlt => AltText is null;
    public bool HasTag => TagText is not null;
    /// <summary>A little wider with three buttons, so none is cut.</summary>
    public override double Width => HasAlt ? 484 : base.Width;
}

/// <summary>A quick answer that fills the text box with one tap.</summary>
public sealed partial class ChipViewModel : ObservableObject
{
    public ChipViewModel(string label, Action<string> pick)
    {
        Label = label;
        PickCommand = new RelayCommand(() => pick(Label));
    }

    public string Label { get; }
    public IRelayCommand PickCommand { get; }

    /// <summary>The text box holds exactly this chip.</summary>
    [ObservableProperty] private bool _isOn;
}

/// <summary>
/// A required reason: for starting a break early or late, for skipping one, for a
/// skipped break's comment, or for counting the minutes over a break. Has a minimum
/// length, and optionally quick chips and a third button.
/// </summary>
public sealed partial class ReasonDialogViewModel : DialogViewModel
{
    public const int MaxChars = 500;

    public ReasonDialogViewModel(string title, string message, int minChars, IEnumerable<string>? chips = null)
    {
        Title = title;
        Message = message;
        MinChars = Math.Clamp(minChars, 1, MaxChars);
        foreach (var chip in chips ?? Array.Empty<string>()) Chips.Add(new ChipViewModel(chip, Pick));
    }

    public override string Title { get; }
    public string Message { get; }
    public int MinChars { get; private set; }
    public string? TagText { get; init; }
    public string? TagDetail { get; init; }
    public Tone TagTone { get; init; } = Tone.Warn;
    public string Label { get; init; } = "Reason";
    public string Placeholder { get; init; } = "";
    public string PrimaryText { get; init; } = "Start break";
    public string CancelText { get; init; } = "Cancel";
    /// <summary>A third button that goes ahead without the reason (e.g. "Skip break", "Leave them out"), or null.</summary>
    public string? AltText { get; init; }
    public string Hint { get; init; } = "Required. Your manager reviews it today.";
    public bool HasTag => TagText is not null;
    public bool HasAlt => AltText is not null;
    public bool HasNoAlt => AltText is null;
    /// <summary>A little wider with three buttons, so none is cut.</summary>
    public override double Width => HasAlt ? 484 : base.Width;
    public bool HasChips => Chips.Count > 0;
    public int MaxLength => MaxChars;
    public ObservableCollection<ChipViewModel> Chips { get; } = new();

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Length), nameof(CountText), nameof(CountOk))]
    private string _text = "";

    partial void OnTextChanged(string value)
    {
        var clean = ReasonText.Clean(value);
        foreach (var chip in Chips) chip.IsOn = chip.Label == clean;
        SubmitCommand.NotifyCanExecuteChanged();
    }

    private void Pick(string chip) => Text = chip;

    /// <summary>The server asked for more: raise the minimum (it says how many).</summary>
    public void RequireAtLeast(int minChars)
    {
        MinChars = Math.Clamp(Math.Max(MinChars, minChars), 1, MaxChars);
        OnPropertyChanged(nameof(MinChars));
        OnPropertyChanged(nameof(CountText));
        OnPropertyChanged(nameof(CountOk));
        SubmitCommand.NotifyCanExecuteChanged();
    }

    /// <summary>Characters that count, as the server counts them: the ends trimmed, a run of spaces as one.</summary>
    public int Length => Reason.Length;
    public bool CountOk => (Length >= MinChars || IsPickedPreset) && Length <= MaxChars;

    /// <summary>
    /// The chips are the organisation's quick answers (3.2): the server takes one as it is,
    /// whatever its length. Off for the agent's own chips, which must meet the minimum.
    /// </summary>
    public bool PresetsPassAnyLength { get; init; }

    private bool IsPickedPreset => PresetsPassAnyLength && Length > 0 && Chips.Any(c => c.Label == Reason);

    public string CountText => IsPickedPreset ? "Looks good" : ReasonCount.Text(Length, MinChars, MaxChars);

    public string Reason => ReasonText.Clean(Text);

    protected override bool CanSubmit() => CountOk;
}

/// <summary>The little counter under a reason box.</summary>
internal static class ReasonCount
{
    public static string Text(int length, int min, int max)
    {
        var missing = min - length;
        if (missing > 0) return missing == 1 ? "1 more character" : $"{missing} more characters";
        var left = max - length;
        if (left < 0) return $"{-left} too many";
        return left <= 50 ? $"{left} characters left" : "Looks good";
    }
}

/// <summary>An optional note (kept for older flows; a skippable note).</summary>
public sealed partial class NoteDialogViewModel : DialogViewModel
{
    public const int MaxChars = 500;

    public NoteDialogViewModel(string title, string message)
    {
        Title = title;
        Message = message;
    }

    public override string Title { get; }
    public string Message { get; }
    public string Label { get; init; } = "Note (optional)";
    public string Placeholder { get; init; } = "";
    public string PrimaryText { get; init; } = "OK";
    public string CancelText { get; init; } = "Cancel";
    /// <summary>A third button that goes ahead without a note (null: not offered).</summary>
    public string? SkipText { get; init; }
    public bool HasSkip => SkipText is not null;
    public int MaxLength => MaxChars;

    [ObservableProperty] private string _text = "";

    public bool Skipped { get; private set; }

    /// <summary>The note to send, or null when it was left empty or skipped.</summary>
    public string? Note => Skipped || string.IsNullOrWhiteSpace(Text) ? null : Text.Trim();

    [RelayCommand]
    private void Skip()
    {
        Skipped = true;
        Complete(true);
    }
}

/// <summary>One skipped break in the End Day dialog, with its own comment box.</summary>
public sealed partial class SkipCommentItemViewModel : ObservableObject
{
    public SkipCommentItemViewModel(string id, string name, string when, int minChars, IEnumerable<string> chips, string? draft = null, string? kind = null)
    {
        Id = id;
        IsLunch = kind == Core.Api.BreakKinds.Lunch;
        Name = name;
        When = when;
        MinChars = Math.Clamp(minChars, 1, ReasonDialogViewModel.MaxChars);
        foreach (var chip in chips) Chips.Add(new ChipViewModel(chip, c => Text = c));
        _text = draft ?? "";
        OnTextChanged(_text);
    }

    public string Id { get; }
    /// <summary>Lunch shows the lunch icon; the breaks show the cup.</summary>
    public bool IsLunch { get; }
    /// <summary>"Morning break".</summary>
    public string Name { get; }
    /// <summary>"Auto-skipped at 12:00".</summary>
    public string When { get; }
    public int MinChars { get; private set; }
    public int MaxLength => ReasonDialogViewModel.MaxChars;
    public ObservableCollection<ChipViewModel> Chips { get; } = new();
    public string BoxLabel => $"Why was the {Services.Fmt.Lower(Name)} skipped?";

    /// <summary>Raised when the text changes (the dialog re-checks its End Day button).</summary>
    public event Action? Changed;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CountOk), nameof(Help))]
    private string _text = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError), nameof(Help))]
    private string? _error;

    partial void OnTextChanged(string value)
    {
        var clean = ReasonText.Clean(value);
        foreach (var chip in Chips) chip.IsOn = chip.Label == clean;
        if (Error is not null) Error = null;
        Changed?.Invoke();
    }

    public void RequireAtLeast(int minChars)
    {
        MinChars = Math.Clamp(Math.Max(MinChars, minChars), 1, ReasonDialogViewModel.MaxChars);
        OnPropertyChanged(nameof(MinChars));
        OnPropertyChanged(nameof(CountOk));
        OnPropertyChanged(nameof(Help));
        Changed?.Invoke();
    }

    public bool HasError => Error is not null;
    /// <summary>The comment as the server counts and keeps it: the ends trimmed, a run of spaces as one.</summary>
    public string Comment => ReasonText.Clean(Text);
    public bool CountOk => Comment.Length >= MinChars && Comment.Length <= ReasonDialogViewModel.MaxChars;

    public string Help => Error
        ?? (CountOk ? "Looks good"
            : Comment.Length > ReasonDialogViewModel.MaxChars ? ReasonCount.Text(Comment.Length, MinChars, ReasonDialogViewModel.MaxChars)
            : $"Required. {MinChars} characters or more.");
}

/// <summary>
/// Before End Day: every skipped break still waiting for a comment, each with its
/// own box. End Day is enabled only when every box has the minimum.
/// </summary>
public sealed partial class EndDayDialogViewModel : DialogViewModel
{
    /// <param name="intro">Said instead of the usual first line (an End Day done offline that waits for these comments).</param>
    public EndDayDialogViewModel(IEnumerable<SkipCommentItemViewModel> items, string approver, string approverCapital, string? intro = null)
    {
        foreach (var item in items)
        {
            item.Changed += () => SubmitCommand.NotifyCanExecuteChanged();
            Items.Add(item);
        }
        var n = Items.Count;
        Message = intro ?? (n == 1
            ? $"1 skipped break needs a comment. It goes to {approver} with your comment."
            : $"{n} skipped breaks need a comment. Each goes to {approver} with your comment.");
        Note = n == 1
            ? $"Your focus time kept counting through this break. {approverCapital} approves or rejects it; a rejection takes its minutes off."
            : $"Your focus time kept counting through these breaks. {approverCapital} approves or rejects each one; a rejection takes that break's minutes off.";
    }

    public override string Title => "Before you end the day";
    public override double Width => 600;
    public string Message { get; }
    public string Note { get; }
    public string PrimaryText => "End Day";
    public string CancelText => "Not now";
    public ObservableCollection<SkipCommentItemViewModel> Items { get; } = new();
    /// <summary>The height of three comment boxes (the compact card, see EndDayDialogView): up to three show whole.</summary>
    public const double ThreeBoxes = 372;
    /// <summary>Up to three boxes show at once (they fit the dashboard at its default size); more scroll inside the dialog.</summary>
    public double ListMaxHeight => Items.Count > 3 ? ThreeBoxes : double.PositiveInfinity;

    public IReadOnlyList<Core.Api.SkipComment> Comments =>
        Items.Select(i => new Core.Api.SkipComment(i.Id, i.Comment)).ToList();

    protected override bool CanSubmit() => Items.Count > 0 && Items.All(i => i.CountOk);
}
