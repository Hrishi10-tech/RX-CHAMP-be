using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels.Dialogs;

/// <summary>A start time offered for an earlier meeting: the instant and its "9:05 AM".</summary>
public sealed record TimeOption(DateTimeOffset At, string Label)
{
    public override string ToString() => Label;
}

/// <summary>What the meeting dialog collected.</summary>
public sealed record MeetingDraft(
    bool IsPast,
    string Agenda,
    IReadOnlyList<MeetingParticipant> People,
    DateTimeOffset? StartedAt,
    int DurationMin,
    /// <summary>Who will mail the minutes (4.0, required: 2 to 80 characters).</summary>
    string MomSender = "");

/// <summary>What the meeting dialog needs from outside: the people search, the clock and the day.</summary>
public sealed record MeetingDialogContext(
    Func<string?, Task<IReadOnlyList<ParticipantOption>?>> Search,
    DateTimeOffset Now,
    DateTimeOffset? DayStartedAt,
    Func<DateTimeOffset, string> Hm,
    string? SelfId,
    string Approver,
    /// <summary>The person's own name (the "Me" chip for who mails the minutes).</summary>
    string? SelfName = null);

/// <summary>Someone chosen for the meeting (a person, or a free name).</summary>
public sealed class ParticipantChipViewModel
{
    public ParticipantChipViewModel(MeetingParticipant person, Action<ParticipantChipViewModel> remove)
    {
        Person = person;
        Initials = Fmt.Initials(person.Name);
        RemoveCommand = new RelayCommand(() => remove(this));
    }

    public MeetingParticipant Person { get; }
    public string Name => Person.Name;
    public string Initials { get; }
    public string RemoveLabel => $"Remove {Person.Name}";
    public IRelayCommand RemoveCommand { get; }
}

/// <summary>A person the search found, or the typed text as a free name.</summary>
public sealed class ParticipantSuggestionViewModel
{
    public ParticipantSuggestionViewModel(MeetingParticipant person, string label, Action<MeetingParticipant> add)
    {
        Person = person;
        Label = label;
        AddCommand = new RelayCommand(() => add(Person));
    }

    public MeetingParticipant Person { get; }
    /// <summary>"+ Maya Reddy", or "+ Add "Vikram, Pune"" for a free name.</summary>
    public string Label { get; }
    public IRelayCommand AddCommand { get; }
}

/// <summary>A length chip for an earlier meeting: 15 min, 30 min, 45 min, 1 h.</summary>
public sealed partial class DurationChipViewModel : ObservableObject
{
    public DurationChipViewModel(int minutes, Action<int> pick)
    {
        Minutes = minutes;
        Label = minutes == 60 ? "1 h" : $"{minutes} min";
        PickCommand = new RelayCommand(() => pick(Minutes), () => IsEnabled);
    }

    public int Minutes { get; }
    public string Label { get; }
    public IRelayCommand PickCommand { get; }

    [ObservableProperty] private bool _isOn;

    [ObservableProperty] private bool _isEnabled = true;

    partial void OnIsEnabledChanged(bool value) => PickCommand.NotifyCanExecuteChanged();
}

/// <summary>
/// Meeting: Starting now (agenda and people) or Already happened (also when it
/// started today and how long it ran). People come from the company directory or
/// are typed as free names; at most 30. The server checks the rest (inside the
/// day, not overlapping a break or another meeting) and its answer is shown here.
/// </summary>
public sealed partial class MeetingDialogViewModel : DialogViewModel
{
    public const int MaxAgenda = ApiClient.MaxAgenda;
    public const int MaxPeople = ApiClient.MaxParticipants;
    public const int MaxName = ApiClient.MaxParticipantName;
    public const int MinMinutes = 5;
    public const int MinMom = 2;
    public const int MaxMom = ApiClient.MaxMomSender;
    public const int MaxMinutes = 480;
    private const int MaxSuggestions = 6;

    private readonly MeetingDialogContext _context;
    private CancellationTokenSource? _searchCts;
    private int _searchVersion;
    private IReadOnlyList<ParticipantOption> _directory = Array.Empty<ParticipantOption>();

    public MeetingDialogViewModel(MeetingDialogContext context, MeetingDraft? draft = null)
    {
        _context = context;
        StartOptions = BuildStartOptions(context);
        foreach (var minutes in new[] { 15, 30, 45, 60 }) Durations.Add(new DurationChipViewModel(minutes, PickDuration));

        _isPast = draft?.IsPast ?? false;
        _agenda = draft?.Agenda ?? "";
        _momSender = draft?.MomSender ?? "";
        foreach (var person in draft?.People ?? Array.Empty<MeetingParticipant>()) AddPerson(person);
        _minutesText = (draft is { DurationMin: > 0 } ? draft.DurationMin : 15).ToString();
        _startAt = draft?.StartedAt is { } at
            ? StartOptions.FirstOrDefault(o => o.At == at) ?? DefaultStart()
            : DefaultStart();
        Chosen.CollectionChanged += (_, _) => Revalidate();
        Revalidate();
    }

    public override string Title => IsPast ? "Log an earlier meeting" : "Start a meeting";
    public override double Width => 484;

    public ObservableCollection<ParticipantChipViewModel> Chosen { get; } = new();
    public ObservableCollection<ParticipantSuggestionViewModel> Suggestions { get; } = new();
    public ObservableCollection<DurationChipViewModel> Durations { get; } = new();
    public IReadOnlyList<TimeOption> StartOptions { get; }

    // ---- Tabs ------------------------------------------------------------------------------

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Title), nameof(IsNow), nameof(PrimaryText), nameof(PeopleLabel), nameof(Note))]
    private bool _isPast;

    public bool IsNow => !IsPast;
    public string PrimaryText => IsPast ? "Log meeting" : "Start meeting";
    public string PeopleLabel => IsPast ? "Who was in it?" : "Who is in it?";
    public bool HasStartOptions => StartOptions.Count > 0;
    public bool HasNoStartOptions => StartOptions.Count == 0;

    public string Note => IsPast
        ? $"This time is already in your focus time. {Capital(_context.Approver)} approves or rejects it; a rejection takes these minutes off."
        : $"Your focus time keeps counting while you are in it. Tap End meeting when you are back. {Capital(_context.Approver)} approves or rejects it after.";

    public string NoStartOptionsText => _context.DayStartedAt is { } started
        ? $"Your day started at {_context.Hm(started)}. A meeting can be logged once it has run for 5 minutes."
        : "Start your day first. A meeting can be logged once your day has run for 5 minutes.";

    partial void OnIsPastChanged(bool value) => Revalidate();

    [RelayCommand]
    private void ShowNow() => IsPast = false;

    [RelayCommand]
    private void ShowPast() => IsPast = true;

    // ---- Agenda ----------------------------------------------------------------------------

    [ObservableProperty] private string _agenda = "";

    partial void OnAgendaChanged(string value) => Revalidate();

    public int AgendaMax => MaxAgenda;

    // ---- Minutes of meeting (4.0) -------------------------------------------------------------

    /// <summary>Who will mail the minutes (required, 2 to 80 characters).</summary>
    [ObservableProperty] private string _momSender = "";

    partial void OnMomSenderChanged(string value) => Revalidate();

    public int MomMax => MaxMom;
    public bool HasSelfName => !string.IsNullOrWhiteSpace(_context.SelfName);
    public string SelfChip => HasSelfName ? $"Me ({Fmt.FirstName(_context.SelfName)})" : "Me";

    /// <summary>The "Me" chip: I will mail the minutes.</summary>
    [RelayCommand]
    private void MomIsMe()
    {
        if (HasSelfName) MomSender = _context.SelfName!.Trim();
    }

    // ---- People ----------------------------------------------------------------------------

    /// <summary>The search box: a name to look up, or to add as a free name with Enter.</summary>
    [ObservableProperty] private string _personQuery = "";

    partial void OnPersonQueryChanged(string value)
    {
        RebuildSuggestions();
        _ = SearchSoonAsync(value);
    }

    public bool CanAddPeople => Chosen.Count < MaxPeople;
    public string PeopleHint => Chosen.Count >= MaxPeople ? $"Up to {MaxPeople} people." : "Add people or type a name";

    [ObservableProperty] private string? _searchProblem;

    /// <summary>Enter in the search box: the person whose name matches exactly, else the typed name as a free name.</summary>
    [RelayCommand]
    private void AddTyped()
    {
        var name = (PersonQuery ?? "").Trim();
        if (name.Length == 0) return;
        var match = _directory.FirstOrDefault(p => string.Equals(p.Name.Trim(), name, StringComparison.OrdinalIgnoreCase));
        AddPerson(match is null ? new MeetingParticipant(null, name) : new MeetingParticipant(match.Id, match.Name.Trim()));
        PersonQuery = "";
    }

    private void AddPerson(MeetingParticipant person)
    {
        var name = (person.Name ?? "").Trim();
        if (name.Length == 0 || Chosen.Count >= MaxPeople) return;
        if (name.Length > MaxName) name = name[..MaxName];
        var id = string.IsNullOrWhiteSpace(person.Id) ? null : person.Id;
        var duplicate = Chosen.Any(c => id is not null
            ? c.Person.Id == id
            : c.Person.Id is null && string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase));
        if (duplicate) return;
        Chosen.Add(new ParticipantChipViewModel(new MeetingParticipant(id, name), RemovePerson));
        OnPropertyChanged(nameof(CanAddPeople));
        OnPropertyChanged(nameof(PeopleHint));
        RebuildSuggestions();
    }

    private void AddSuggested(MeetingParticipant person)
    {
        AddPerson(person);
        PersonQuery = "";
    }

    private void RemovePerson(ParticipantChipViewModel chip)
    {
        Chosen.Remove(chip);
        OnPropertyChanged(nameof(CanAddPeople));
        OnPropertyChanged(nameof(PeopleHint));
        RebuildSuggestions();
    }

    /// <summary>The first suggestions (the directory with no filter). Never throws.</summary>
    public Task LoadSuggestionsAsync() => SearchNowAsync("");

    /// <summary>Looks people up now (the debounce calls this; tests call it directly).</summary>
    public async Task SearchNowAsync(string? query)
    {
        var version = Interlocked.Increment(ref _searchVersion);
        IReadOnlyList<ParticipantOption>? found;
        try
        {
            found = await _context.Search(query);
        }
        catch
        {
            found = null;
        }
        if (version != Volatile.Read(ref _searchVersion)) return; // a newer search is on its way
        if (found is null)
        {
            SearchProblem = "Can't search the directory right now. You can still type names.";
            return;
        }
        SearchProblem = null;
        _directory = found;
        RebuildSuggestions();
    }

    /// <summary>Typing waits a quarter of a second before looking up, so a fast typist sends one search.</summary>
    private async Task SearchSoonAsync(string query)
    {
        var previous = _searchCts;
        var cts = new CancellationTokenSource();
        _searchCts = cts;
        if (previous is not null)
        {
            previous.Cancel();
            previous.Dispose();
        }
        try
        {
            await Task.Delay(250, cts.Token);
            await SearchNowAsync(query);
        }
        catch (OperationCanceledException)
        {
            // A newer keystroke took over.
        }
        catch (Exception)
        {
            SearchProblem = "Can't search the directory right now. You can still type names.";
        }
    }

    private void RebuildSuggestions()
    {
        Suggestions.Clear();
        if (!CanAddPeople) return;
        var query = (PersonQuery ?? "").Trim();
        var chosenIds = Chosen.Where(c => c.Person.Id is not null).Select(c => c.Person.Id!).ToHashSet();
        var people = _directory
            .Where(p => p.Id != _context.SelfId && !chosenIds.Contains(p.Id))
            .Where(p => query.Length == 0 || p.Name.Contains(query, StringComparison.OrdinalIgnoreCase))
            .Take(MaxSuggestions);
        foreach (var p in people)
            Suggestions.Add(new ParticipantSuggestionViewModel(new MeetingParticipant(p.Id, p.Name.Trim()), $"+ {p.Name.Trim()}", AddSuggested));
        var exact = _directory.Any(p => string.Equals(p.Name.Trim(), query, StringComparison.OrdinalIgnoreCase));
        if (query.Length > 0 && !exact && !Chosen.Any(c => string.Equals(c.Name, query, StringComparison.OrdinalIgnoreCase)))
        {
            var name = query.Length > MaxName ? query[..MaxName] : query;
            Suggestions.Add(new ParticipantSuggestionViewModel(new MeetingParticipant(null, name), $"+ Add “{name}”", AddSuggested));
        }
    }

    // ---- When (already happened) ------------------------------------------------------------

    [ObservableProperty] private TimeOption? _startAt;

    partial void OnStartAtChanged(TimeOption? value) => Revalidate();

    [ObservableProperty] private string _minutesText = "15";

    partial void OnMinutesTextChanged(string value) => Revalidate();

    private void PickDuration(int minutes) => MinutesText = minutes.ToString();

    /// <summary>The minutes typed, or null when it is not a whole number.</summary>
    public int? Minutes => int.TryParse((MinutesText ?? "").Trim(), out var m) ? m : null;

    [ObservableProperty] private string _rangeText = "";

    /// <summary>What is missing or wrong before it can be sent (null: good to go).</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasProblem))]
    private string? _problem;

    public bool HasProblem => Problem is not null;

    private void Revalidate()
    {
        var minutes = Minutes;
        foreach (var chip in Durations)
        {
            chip.IsOn = minutes == chip.Minutes;
            chip.IsEnabled = StartAt is null || StartAt.At.AddMinutes(chip.Minutes) <= _context.Now;
        }
        RangeText = StartAt is { } start && minutes is { } m and > 0
            ? $"{start.Label} to {_context.Hm(start.At.AddMinutes(m))} · {Fmt.Minutes(m)}"
            : "";
        Problem = FindProblem();
        SubmitCommand.NotifyCanExecuteChanged();
    }

    private string? FindProblem()
    {
        var agenda = (Agenda ?? "").Trim();
        if (agenda.Length == 0) return "Add what the meeting is about.";
        if (agenda.Length > MaxAgenda) return $"Keep it to {MaxAgenda} characters.";
        var mom = ReasonText.Clean(MomSender);
        if (mom.Length < MinMom) return "Add who will mail the minutes.";
        if (mom.Length > MaxMom) return $"Keep the name to {MaxMom} characters.";
        if (Chosen.Count > MaxPeople) return $"Up to {MaxPeople} people.";
        if (!IsPast) return null;
        if (StartAt is null) return HasStartOptions ? "Pick when it started." : NoStartOptionsText;
        if (Minutes is not { } m) return "Enter how long it ran, in minutes.";
        if (m < MinMinutes || m > MaxMinutes) return $"How long must be {MinMinutes} to {MaxMinutes} minutes.";
        if (StartAt.At.AddMinutes(m) > _context.Now) return "That runs past now. Pick an earlier start or fewer minutes.";
        return null;
    }

    protected override bool CanSubmit() => FindProblem() is null;

    public MeetingDraft ToDraft() => new(
        IsPast,
        (Agenda ?? "").Trim(),
        Chosen.Select(c => c.Person).ToList(),
        IsPast ? StartAt?.At : null,
        IsPast ? Minutes ?? 0 : 0,
        ReasonText.Clean(MomSender));

    // ---- Helpers ----------------------------------------------------------------------------

    /// <summary>Every 5 minutes from the start of the day (rounded up) to 5 minutes ago.</summary>
    private static IReadOnlyList<TimeOption> BuildStartOptions(MeetingDialogContext context)
    {
        if (context.DayStartedAt is not { } started) return Array.Empty<TimeOption>();
        var first = RoundUpTo5(started);
        var last = RoundDownTo5(context.Now.AddMinutes(-MinMinutes));
        var options = new List<TimeOption>();
        for (var t = first; t <= last && options.Count < 24 * 12; t = t.AddMinutes(5)) options.Add(new TimeOption(t, context.Hm(t)));
        return options;
    }

    private TimeOption? DefaultStart() =>
        StartOptions.Count == 0 ? null : StartOptions[Math.Max(0, StartOptions.Count - 1 - 5)];

    private static DateTimeOffset RoundUpTo5(DateTimeOffset t)
    {
        var minutes = Math.Ceiling(t.ToUnixTimeSeconds() / 300.0) * 300;
        return DateTimeOffset.FromUnixTimeSeconds((long)minutes).ToOffset(t.Offset);
    }

    private static DateTimeOffset RoundDownTo5(DateTimeOffset t)
    {
        var minutes = Math.Floor(t.ToUnixTimeSeconds() / 300.0) * 300;
        return DateTimeOffset.FromUnixTimeSeconds((long)minutes).ToOffset(t.Offset);
    }

    private static string Capital(string text) =>
        string.IsNullOrEmpty(text) ? text : char.ToUpperInvariant(text[0]) + text[1..];
}
