using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Avatars;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>Formal, Casual or Smart: the library's three sets of 25, by their look (D-85).</summary>
public sealed partial class AvatarSetViewModel : ObservableObject
{
    /// <summary>What each set is called: suits and ties, bright and open, smart casual.</summary>
    public static string NameOf(int number) => number switch { 1 => "Formal", 2 => "Casual", 3 => "Smart", _ => $"Set {number}" };

    public AvatarSetViewModel(int number, Action<int> choose)
    {
        Number = number;
        Label = NameOf(number);
        ChooseCommand = new RelayCommand(() => choose(number));
    }

    public int Number { get; }
    public string Label { get; }
    public IRelayCommand ChooseCommand { get; }
    [ObservableProperty] private bool _isSelected;
}

/// <summary>An avatar in the grid.</summary>
public sealed partial class AvatarTileViewModel : ObservableObject
{
    public AvatarTileViewModel(string id, Action<string> pick)
    {
        Id = id;
        PickCommand = new RelayCommand(() => pick(id));
    }

    public string Id { get; }
    /// <summary>What a screen reader says.</summary>
    public string SpokenName => $"Avatar {Id}";
    public IRelayCommand PickCommand { get; }
    [ObservableProperty] private bool _isSelected;
}

/// <summary>
/// Profile, then the account (design page 9, D-85): a live preview with the person's status and
/// today's ring, the RX logo (the default), their own library's sets, and Save. Presets only:
/// nothing here can offer a file, and nothing but a manifest ID ever leaves.
///
/// Tapping previews only. Save goes through <see cref="IAvatars"/>, which updates the floating
/// icon at once and puts the old avatar back if the server does not take it. Saving the RX logo
/// clears the stored choice (DELETE /me/avatar).
/// </summary>
public sealed partial class AvatarPickerViewModel : ObservableObject
{
    /// <summary>C-641.</summary>
    public const string TryAgainLine = "Try saving your avatar again.";

    /// <summary>C-642, in 4.0 words: a person with no gender set has no library (avatarId null) and shows the RX mark.</summary>
    public const string NoLibraryLine = "Ask the organisation admin to set up your profile. Then you can choose your avatar.";

    /// <summary>Across, in the grid.</summary>
    public const int Columns = 6;

    private static readonly TimeSpan DayReadEvery = TimeSpan.FromSeconds(60);

    private readonly IAgent _agent;
    private readonly IAvatars _avatars;
    private readonly AvatarLibrary _library;
    private readonly ILog _log;
    private string? _libraryName;
    private string? _picked;
    /// <summary>The RX logo is tapped, not yet saved.</summary>
    private bool _pickedMark;
    private int? _chosenSet;
    private int _shownSet;
    private DayProgress? _day;
    private TimeSpan _dayReadAt;
    private TimeSpan _lastDayRead;
    private bool _open;

    public AvatarPickerViewModel(IAgent agent, ILog log, AvatarLibrary? library = null)
    {
        _agent = agent;
        _avatars = agent.Avatars;
        _library = library ?? AvatarLibrary.Bundled;
        _log = log;
    }

    public ObservableCollection<AvatarSetViewModel> Sets { get; } = new();
    public ObservableCollection<AvatarTileViewModel> Tiles { get; } = new();
    public string NoLibraryText => NoLibraryLine;

    [ObservableProperty] private string? _previewId;
    /// <summary>The RX logo is what shows in the preview (the default, or tapped).</summary>
    [ObservableProperty] private bool _isMarkSelected;
    [ObservableProperty] private PreviewLook _look = PreviewLook.Unknown;
    [ObservableProperty] private string? _statusLabel;
    [ObservableProperty] private string _countText = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    private string? _error;

    public bool HasError => !string.IsNullOrEmpty(Error);

    /// <summary>The person has a library to choose from; else C-642 stands in the grid's place.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasNoLibrary))]
    private bool _hasLibrary;

    /// <summary>C-642 shows only once the server has said there is no library, not while it is asked.</summary>
    [ObservableProperty] private bool _hasNoLibrary;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SaveCommand))]
    private bool _isBusy;

    /// <summary>The grid's row to bring into view when a set comes up.</summary>
    public int RowToShow { get; private set; }

    /// <summary>A new set came up (the view scrolls to <see cref="RowToShow"/>).</summary>
    public event Action? SetShown;

    /// <summary>Back, to Profile (set by the app).</summary>
    public Action? BackRequested { get; set; }
    /// <summary>Close (set by the app).</summary>
    public Action? CloseRequested { get; set; }

    [RelayCommand]
    private void Back() => BackRequested?.Invoke();

    [RelayCommand]
    private void Close() => CloseRequested?.Invoke();

    // ---- Open and close -------------------------------------------------------------------------

    /// <summary>The window came up: shows what is known at once, then reads what the server has.</summary>
    public async Task OpenAsync()
    {
        if (!_open)
        {
            _open = true;
            _avatars.Changed += Follow;
            _agent.WorkdayChanged += ReadDayNow;
            _agent.PresenceChanged += OnPresenceChanged;
        }
        Follow();
        UpdatePreview();
        await Task.WhenAll(_avatars.RefreshAsync(), ReadDayAsync());
    }

    /// <summary>The window went away.</summary>
    public void Closed()
    {
        if (!_open) return;
        _open = false;
        _avatars.Changed -= Follow;
        _agent.WorkdayChanged -= ReadDayNow;
        _agent.PresenceChanged -= OnPresenceChanged;
    }

    /// <summary>The screen's second, while open: the preview's words, and the day read once a minute.</summary>
    public void Tick()
    {
        UpdatePreview();
        if (_agent.Clock.Monotonic - _lastDayRead >= DayReadEvery) _ = ReadDayQuietlyAsync();
    }

    // ---- Choosing -------------------------------------------------------------------------------

    private void Pick(string id)
    {
        if (IsBusy) return;
        _picked = id;
        _pickedMark = false;
        Error = null;
        Follow();
    }

    /// <summary>The RX logo: the default. Previews only, like any tile.</summary>
    [RelayCommand]
    private void PickMark()
    {
        if (IsBusy) return;
        _picked = null;
        _pickedMark = true;
        Error = null;
        Follow();
    }

    private void ChooseSet(int number)
    {
        _chosenSet = number;
        Follow();
    }

    [RelayCommand(CanExecute = nameof(CanSave))]
    private async Task SaveAsync()
    {
        if (_pickedMark) await RunAsync(() => _avatars.ResetAsync());
        else if (_picked is { } id) await RunAsync(() => _avatars.SaveAsync(id));
    }

    private bool CanSave() => !IsBusy &&
        (_pickedMark ? _avatars.ShownId is not null : _picked is not null && _picked != _avatars.ShownId);

    private async Task RunAsync(Func<Task<ApiResult<MyAvatar>>> call)
    {
        IsBusy = true;
        Error = null;
        try
        {
            var result = await call();
            if (result.Ok)
            {
                _picked = null;
                _pickedMark = false;
                return;
            }
            // A refusal is the server's to word (C-907 to C-910, C-916); no answer at all is C-641.
            Error = result.Outcome == ApiOutcome.Rejected && !string.IsNullOrEmpty(result.Message) ? result.Message : TryAgainLine;
            if (result.Code is "GENDER_NOT_SET" or "AVATAR_OTHER_LIBRARY")
            {
                // The profile changed under this window: what it offered no longer holds.
                _picked = null;
                await _avatars.RefreshAsync();
            }
        }
        catch (Exception ex)
        {
            _log.Warn("avatar", "saving the avatar failed", ex);
            Error = TryAgainLine;
        }
        finally
        {
            IsBusy = false;
            Follow();
        }
    }

    // ---- What shows -----------------------------------------------------------------------------

    /// <summary>Everything from the person's avatar as it stands now. A change from elsewhere lands here too.</summary>
    private void Follow()
    {
        var mine = _avatars.Mine;
        var shown = _avatars.ShownId;
        // Before the server's first answer, and with no network: the ID says which library it is.
        var libraryName = mine is not null ? mine.Library : _library.Find(shown)?.Library;
        if (libraryName != _libraryName)
        {
            _libraryName = libraryName;
            _picked = null;
            _pickedMark = false;
            _chosenSet = null;
            _shownSet = 0;
            Sets.Clear();
            foreach (var number in _library.SetsOf(libraryName)) Sets.Add(new AvatarSetViewModel(number, ChooseSet));
            Tiles.Clear();
        }
        // The pick became what shows, here or on another device: nothing is left to save.
        if (!IsBusy && _picked is not null && _picked == shown) _picked = null;
        if (!IsBusy && _pickedMark && shown is null) _pickedMark = false;

        var current = _pickedMark ? null : _picked ?? shown;
        PreviewId = current;
        IsMarkSelected = current is null;
        HasLibrary = libraryName is not null;
        HasNoLibrary = libraryName is null && mine is not null;
        CountText = libraryName is null ? "" : $"{_library.Of(libraryName).Count} {libraryName} avatars";

        var set = _chosenSet ?? _library.Find(current)?.Set ?? (Sets.Count > 0 ? Sets[0].Number : 0);
        if (set != _shownSet)
        {
            _shownSet = set;
            Tiles.Clear();
            foreach (var entry in _library.Of(libraryName, set)) Tiles.Add(new AvatarTileViewModel(entry.Id, Pick));
            var selected = Tiles.Select(t => t.Id).ToList().IndexOf(current ?? "");
            RowToShow = selected < 0 ? 0 : selected / Columns;
            SetShown?.Invoke();
        }
        foreach (var tab in Sets) tab.IsSelected = tab.Number == set;
        foreach (var tile in Tiles) tile.IsSelected = tile.Id == current;
        SaveCommand.NotifyCanExecuteChanged();
    }

    // ---- The preview's status and ring ----------------------------------------------------------

    private void OnPresenceChanged(CurrentPresence presence) => ReadDayNow();

    private void ReadDayNow() => _ = ReadDayQuietlyAsync();

    private async Task ReadDayQuietlyAsync()
    {
        try { await ReadDayAsync(); }
        catch (Exception ex) { _log.Warn("avatar", "reading the day for the preview failed", ex); }
    }

    private async Task ReadDayAsync()
    {
        _lastDayRead = _agent.Clock.Monotonic;
        var result = await _avatars.GetDayProgressAsync();
        if (result.Ok && result.Data is { } day)
        {
            _day = day;
            _dayReadAt = _agent.Clock.Monotonic;
        }
        UpdatePreview();
    }

    private void UpdatePreview()
    {
        var now = _agent.Now;
        var day = _day ?? LocalDay(now);
        if (day is null)
        {
            Look = PreviewLook.Unknown;
            StatusLabel = null;
            return;
        }
        var status = PreviewWords.StatusOf(day.Status, day.BreakEndsAt, now);
        var worked = day.WorkedSec;
        // Between reads the time counts on only while it would on the server.
        if (_day is not null && status is PreviewStatus.Working or PreviewStatus.Meeting)
            worked += (int)(_agent.Clock.Monotonic - _dayReadAt).TotalSeconds;
        Look = PreviewLook.For(status, worked, day.TargetSec);
        var extendedBy = day.BreakEndsAt is { } ends ? now - ends : TimeSpan.Zero;
        var sameDay = day.Date.Length == 0 || day.Date == _agent.BusinessDate(now);
        StatusLabel = PreviewWords.Label(status, worked, day.TargetSec, sameDay, extendedBy);
    }

    /// <summary>With no answer from the server: the day as this agent knows it, so the ring still draws offline.</summary>
    private DayProgress? LocalDay(DateTimeOffset now)
    {
        var workday = _agent.Workday;
        var panel = _agent.BreakPanel;
        var presence = _agent.Presence.Status;
        var status = _agent.State switch
        {
            AgentState.NotStarted => DayProgressStatus.NotStarted,
            AgentState.DayEnded => DayProgressStatus.Ended,
            AgentState.Running when panel.Active is not null || presence is PresenceStatus.Break or PresenceStatus.Lunch => DayProgressStatus.Break,
            AgentState.Running when presence == PresenceStatus.Meeting => DayProgressStatus.Meeting,
            AgentState.Running => DayProgressStatus.Working,
            _ => null,
        };
        if (status is null) return null;
        return new DayProgress
        {
            Status = status,
            Date = workday?.Date ?? "",
            WorkedSec = FocusClock.At(workday, now, panel.Active?.StartedAt),
            TargetSec = workday is { ExpectedSec: > 0 } ? workday.ExpectedSec : PreviewWords.DefaultTargetSec,
        };
    }
}
