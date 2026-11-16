using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace RXVision.Agent.ViewModels.Dialogs;

/// <summary>One length the quick-break picker offers (5, 10 or 15 minutes).</summary>
public sealed partial class MinutesChoiceViewModel : ObservableObject
{
    public MinutesChoiceViewModel(int minutes, Action<MinutesChoiceViewModel> pick)
    {
        Minutes = minutes;
        Label = $"{minutes} min";
        PickCommand = new RelayCommand(() => pick(this));
    }

    public int Minutes { get; }
    public string Label { get; }
    public IRelayCommand PickCommand { get; }

    [ObservableProperty] private bool _isOn;
}

/// <summary>
/// Quick break (4.0, SPEC 8.1): choose 5, 10 or 15 minutes, then Start. Any time the day
/// is open; it counts against the paid buffer, and nothing ends it but End break.
/// </summary>
public sealed partial class QuickBreakDialogViewModel : DialogViewModel
{
    public QuickBreakDialogViewModel(IEnumerable<int> minutes, int bufferMin, int? preselect = null)
    {
        foreach (var m in minutes.Where(m => m is > 0 and <= 60).Distinct().OrderBy(m => m))
            Choices.Add(new MinutesChoiceViewModel(m, Pick));
        if (Choices.Count == 0)
            foreach (var m in new[] { 5, 10, 15 }) Choices.Add(new MinutesChoiceViewModel(m, Pick));
        BufferMin = Math.Max(0, bufferMin);
        var first = Choices.FirstOrDefault(c => c.Minutes == preselect) ?? Choices.FirstOrDefault(c => c.Minutes == 10) ?? Choices[0];
        Pick(first);
    }

    public override string Title => "Take a quick break";
    public override double Width => 440;
    public ObservableCollection<MinutesChoiceViewModel> Choices { get; } = new();
    public int BufferMin { get; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(PrimaryText))]
    private int _selectedMinutes;

    public string PrimaryText => $"Start {SelectedMinutes} min break";
    public string Message => "Any time, for 5, 10 or 15 minutes. Your focus time pauses until you tap End break.";
    public string Summary => BufferMin > 0
        ? $"Quick breaks are paid from your {BufferMin} min buffer; past it they are unpaid break time."
        : "Quick breaks are unpaid break time.";

    /// <summary>Picks a length (tests and the chips).</summary>
    public void Pick(MinutesChoiceViewModel choice)
    {
        foreach (var c in Choices) c.IsOn = ReferenceEquals(c, choice);
        SelectedMinutes = choice.Minutes;
        SubmitCommand.NotifyCanExecuteChanged();
    }

    protected override bool CanSubmit() => SelectedMinutes > 0;
}

/// <summary>
/// The admin's key for signing out (or for an Admin's quit), SPEC 2.8: five words and a
/// number, valid 24 hours. A wrong key comes back with the reason under the box.
/// </summary>
public sealed partial class KeyDialogViewModel : DialogViewModel
{
    public KeyDialogViewModel(string title, string message, string primaryText)
    {
        Title = title;
        Message = message;
        PrimaryText = primaryText;
    }

    public override string Title { get; }
    public string Message { get; }
    public string PrimaryText { get; }
    public string Hint { get; init; } = "Ask your admin for a key. It looks like: amber orbit cedar river lamp 42";
    public bool IsDanger { get; init; }

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SubmitCommand))]
    private string _key = "";

    partial void OnKeyChanged(string value)
    {
        if (Error is not null) Error = null;
    }

    /// <summary>The key as it is sent: words in lower case, single spaces.</summary>
    public string CleanKey => Core.Api.ApiClient.NormaliseKey(Key);

    protected override bool CanSubmit() => CleanKey.Length >= 3;
}

/// <summary>Something is under way (sending the journal before sign-out): closed by the flow when done, or Cancel.</summary>
public sealed partial class ProgressDialogViewModel : DialogViewModel
{
    public ProgressDialogViewModel(string title, string message)
    {
        _heading = title;
        _message = message;
    }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title))]
    private string _heading;

    public override string Title => Heading;
    [ObservableProperty] private string _message;
    public string CancelText { get; init; } = "Cancel";

    /// <summary>The work is done: the dialog closes as if confirmed.</summary>
    public void Finish() => Complete(true);
}
