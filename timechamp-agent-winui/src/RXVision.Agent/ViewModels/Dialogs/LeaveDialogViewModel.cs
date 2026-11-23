using System.Collections.ObjectModel;
using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels.Dialogs;

/// <summary>What the apply form needs from outside.</summary>
public sealed record LeaveDialogContext(
    LeavePolicy Policy,
    /// <summary>Today, in the business time zone.</summary>
    DateTime Today,
    IReadOnlyList<string> ReasonPresets,
    /// <summary>Weekly days off and holidays: the first day EL/PL defaults to skips them.</summary>
    IReadOnlySet<DateTime> OffDays,
    Func<LeaveRequestBody, Task<ApiResult<LeavePreview>>> Preview,
    /// <summary>The one clock's delay (the preview waits a moment after the last change).</summary>
    Func<TimeSpan, CancellationToken, Task> Delay);

/// <summary>What was typed, to come back to the form after a refusal.</summary>
public sealed record LeaveDraft(string Category, string Kind, string? Part, DateTime? FirstDay, DateTime? LastDay, string Reason);

public sealed record LeaveChoice(string Value, string Label, string? Rule = null)
{
    public override string ToString() => Label;
}

/// <summary>
/// Apply for leave (3.4): type, how long, which part, the dates and a reason with quick
/// answers. As fields change the server previews it (300 ms after the last change): what it
/// charges and what is left, or the first thing that stops it, in its own words.
/// </summary>
public sealed partial class LeaveDialogViewModel : DialogViewModel
{
    public const int MinReason = 3;
    public const int MaxReason = 300;
    private static readonly TimeSpan PreviewWait = TimeSpan.FromMilliseconds(300);

    private readonly LeaveDialogContext _context;
    private CancellationTokenSource? _previewCts;
    private bool _firstDayTouched;
    private bool _ready;

    public LeaveDialogViewModel(LeaveDialogContext context, LeaveDraft? draft = null)
    {
        _context = context;
        PreviewLines.CollectionChanged += (_, _) => OnPropertyChanged(nameof(HasPreviewLines));
        foreach (var c in context.Policy.Categories) Categories.Add(new LeaveChoice(c.Category, c.Label, c.Rule));
        foreach (var k in context.Policy.Kinds) Kinds.Add(new LeaveChoice(k.Kind, k.Label));
        foreach (var chip in context.ReasonPresets) Chips.Add(new ChipViewModel(chip, c => Reason = c));

        _category = Categories.FirstOrDefault(c => c.Value == draft?.Category) ?? Categories.FirstOrDefault();
        _kind = Kinds.FirstOrDefault(k => k.Value == draft?.Kind) ?? Kinds.FirstOrDefault();
        FillParts(draft?.Part);
        _reason = draft?.Reason ?? "";
        _firstDayTouched = draft?.FirstDay is not null;
        _firstDay = draft?.FirstDay ?? DefaultFirstDay(_category?.Value);
        _lastDay = draft?.LastDay;
        _ready = true;
    }

    public override string Title => "Apply for leave";

    public ObservableCollection<LeaveChoice> Categories { get; } = new();
    public ObservableCollection<LeaveChoice> Kinds { get; } = new();
    public ObservableCollection<LeaveChoice> Parts { get; } = new();
    public ObservableCollection<ChipViewModel> Chips { get; } = new();

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(RuleText))]
    private LeaveChoice? _category;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsFullDay), nameof(HasParts), nameof(LastDayVisible))]
    private LeaveChoice? _kind;

    [ObservableProperty] private LeaveChoice? _part;
    [ObservableProperty] private DateTime? _firstDay;
    [ObservableProperty] private DateTime? _lastDay;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CleanReason))]
    private string _reason = "";

    /// <summary>The lines of the preview: what it charges, what is left, who decides.</summary>
    public ObservableCollection<string> PreviewLines { get; } = new();

    /// <summary>The first thing that stops the request, in the server's words.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasPreviewProblem))]
    private string? _previewProblem;

    public bool HasPreviewProblem => PreviewProblem is not null;
    /// <summary>The preview card shows once there is something to say.</summary>
    public bool HasPreviewLines => PreviewLines.Count > 0;
    public string? RuleText => Category?.Rule;
    public bool IsFullDay => Kind?.Value == LeaveKinds.FullDay;
    public bool HasParts => Parts.Count > 0;
    public bool LastDayVisible => IsFullDay;
    public bool HasChips => Chips.Count > 0;
    public string CleanReason => ReasonText.Clean(Reason);
    public string PrimaryText => "Apply";

    partial void OnCategoryChanged(LeaveChoice? value)
    {
        if (!_firstDayTouched && _ready)
        {
            _ready = false;
            FirstDay = DefaultFirstDay(value?.Value);
            _ready = true;
        }
        Changed();
    }

    partial void OnKindChanged(LeaveChoice? value)
    {
        FillParts(null);
        if (value?.Value != LeaveKinds.FullDay) LastDay = null;
        Changed();
    }

    partial void OnPartChanged(LeaveChoice? value) => Changed();

    partial void OnFirstDayChanged(DateTime? value)
    {
        if (_ready) _firstDayTouched = true;
        Changed();
    }

    partial void OnLastDayChanged(DateTime? value) => Changed();

    partial void OnReasonChanged(string value)
    {
        foreach (var chip in Chips) chip.IsOn = chip.Label == CleanReason;
        Changed();
    }

    private void Changed()
    {
        SubmitCommand.NotifyCanExecuteChanged();
        if (_ready) _ = PreviewSoonAsync();
    }

    private void FillParts(string? selected)
    {
        Parts.Clear();
        foreach (var p in _context.Policy.Kinds.FirstOrDefault(k => k.Kind == Kind?.Value)?.Parts ?? new List<LeavePartInfo>())
            Parts.Add(new LeaveChoice(p.Part, p.Label));
        Part = Parts.FirstOrDefault(p => p.Value == selected) ?? Parts.FirstOrDefault();
        OnPropertyChanged(nameof(HasParts));
    }

    /// <summary>Today for CL/SL and comp off; for EL/PL the first working day after the notice.</summary>
    private DateTime DefaultFirstDay(string? category)
    {
        if (category != LeaveCategories.ElPl) return _context.Today;
        var day = _context.Today.AddDays(Math.Max(0, _context.Policy.ElplNoticeDays));
        for (var guard = 0; guard < 31 && _context.OffDays.Contains(day); guard++) day = day.AddDays(1);
        return day;
    }

    /// <summary>Asks the server what this would do, a moment after the last change. Nothing is made.</summary>
    public async Task PreviewSoonAsync()
    {
        _previewCts?.Cancel();
        var cts = _previewCts = new CancellationTokenSource();
        try
        {
            await _context.Delay(PreviewWait, cts.Token);
            if (FirstDay is null) return;
            var body = ToBody();
            // A preview works with a short reason: a placeholder until three characters are typed.
            if (CleanReason.Length < MinReason) body.Reason = "Preview";
            var result = await _context.Preview(body);
            if (cts.IsCancellationRequested) return;
            ShowPreview(result);
        }
        catch (OperationCanceledException)
        {
            // A newer change asks again.
        }
    }

    private void ShowPreview(ApiResult<LeavePreview> result)
    {
        PreviewLines.Clear();
        if (result.Data is not { } preview)
        {
            PreviewProblem = result.Transient ? null : result.Message;
            if (result.Transient) PreviewLines.Add("You can still apply. This check isn't available right now.");
            SubmitCommand.NotifyCanExecuteChanged();
            return;
        }
        if (!preview.Ok)
        {
            PreviewProblem = preview.Problem?.Message ?? "Try other dates or another leave type.";
            SubmitCommand.NotifyCanExecuteChanged();
            return;
        }
        PreviewProblem = null;
        if (preview.Balance is { } balance)
        {
            PreviewLines.Add($"Charges {preview.DaysLabel} of {balance.Label}");
            PreviewLines.Add($"Left after: {Fmt.Days(balance.AfterDays)} (now {Fmt.Days(balance.BeforeDays)})");
        }
        foreach (var day in preview.Dates.Where(d => !d.Charged))
            PreviewLines.Add(string.IsNullOrWhiteSpace(day.Why) ? $"Not charged: {day.Label}" : $"Not charged: {day.Label} ({day.Why})");
        if (!string.IsNullOrWhiteSpace(preview.PartTimes)) PreviewLines.Add($"Away {preview.PartTimes}");
        PreviewLines.Add(preview.ApprovedAtOnce ? "Approved at once"
            : string.IsNullOrWhiteSpace(preview.WaitingFor) ? "Goes for approval" : $"Goes to {preview.WaitingFor.Trim()} for approval");
        SubmitCommand.NotifyCanExecuteChanged();
    }

    protected override bool CanSubmit() =>
        Category is not null && Kind is not null && FirstDay is not null
        && (Parts.Count == 0 || Part is not null)
        && CleanReason.Length is >= MinReason and <= MaxReason
        && PreviewProblem is null;

    public LeaveRequestBody ToBody() => new()
    {
        Category = Category?.Value ?? "",
        Kind = Kind?.Value ?? "",
        Part = Parts.Count > 0 ? Part?.Value : null,
        StartDate = Day(FirstDay),
        EndDate = IsFullDay && LastDay is not null ? Day(LastDay) : null,
        Reason = CleanReason,
    };

    public LeaveDraft ToDraft() => new(Category?.Value ?? "", Kind?.Value ?? "", Part?.Value, FirstDay, LastDay, Reason);

    private static string Day(DateTime? day) => day?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) ?? "";
}
