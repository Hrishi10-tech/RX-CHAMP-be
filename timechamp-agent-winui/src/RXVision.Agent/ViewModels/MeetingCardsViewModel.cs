using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>One card on top of the panel: Start meeting?, End meeting?, Still in a meeting? or You're back to Working.</summary>
public sealed partial class MeetingCardViewModel : ObservableObject
{
    public MeetingCardViewModel(MeetingAlertKind kind, string title, string primaryText, IAsyncRelayCommand primary,
        string? secondaryText = null, IRelayCommand? secondary = null, bool secondaryIsQuiet = false, bool needsAction = false)
    {
        Kind = kind;
        Title = title;
        PrimaryText = primaryText;
        PrimaryCommand = primary;
        SecondaryText = secondaryText;
        SecondaryCommand = secondary;
        SecondaryIsQuiet = secondaryIsQuiet;
        NeedsAction = needsAction;
    }

    public MeetingAlertKind Kind { get; }
    public string Title { get; }
    public string PrimaryText { get; }
    public IAsyncRelayCommand PrimaryCommand { get; }
    public string? SecondaryText { get; }
    public IRelayCommand? SecondaryCommand { get; }
    /// <summary>A quiet text action (Not now), not an outlined button (End meeting).</summary>
    public bool SecondaryIsQuiet { get; }
    public bool ShowQuietSecondary => SecondaryCommand is not null && SecondaryIsQuiet;
    public bool ShowOutlinedSecondary => SecondaryCommand is not null && !SecondaryIsQuiet;
    /// <summary>"!" when an answer is needed (amber), else "i" (teal).</summary>
    public bool NeedsAction { get; }
    public string Badge => NeedsAction ? "!" : "i";

    [ObservableProperty] private string _body = "";
}

/// <summary>
/// The meeting feature's cards, on top of the panel, and the badge they put on the icon. These
/// are the only things a suggestion ever shows: no window opens by itself and nothing takes the
/// focus. The status changes only when the person taps. Opening the panel clears the badge; a
/// card stays until it is acted on or stops being true.
/// </summary>
public sealed partial class MeetingCardsViewModel : ObservableObject
{
    private readonly IAgent _agent;
    private readonly BreakActions _actions;
    private readonly HashSet<MeetingAlert> _seen = new();
    private IReadOnlyList<MeetingAlert> _shown = Array.Empty<MeetingAlert>();

    public MeetingCardsViewModel(IAgent agent, BreakActions actions)
    {
        _agent = agent;
        _actions = actions;
    }

    public ObservableCollection<MeetingCardViewModel> Cards { get; } = new();

    [ObservableProperty] private bool _hasCards;

    /// <summary>"!", "i" or null: what the icon shows until the panel opens.</summary>
    [ObservableProperty] private string? _badge;

    /// <summary>Follows the agent's alerts. Cheap; call it every second, panel open or not.</summary>
    public void Update(bool panelOpen)
    {
        var alerts = _agent.MeetingAlerts;
        if (panelOpen) _seen.UnionWith(alerts);
        _seen.IntersectWith(alerts);
        Badge = alerts.FirstOrDefault(a => !_seen.Contains(a))?.Badge;
        if (!alerts.SequenceEqual(_shown))
        {
            _shown = alerts.ToList();
            Cards.Clear();
            foreach (var alert in alerts) Cards.Add(Build(alert));
            HasCards = Cards.Count > 0;
        }
        for (var i = 0; i < alerts.Count && i < Cards.Count; i++) Cards[i].Body = BodyOf(alerts[i]);
    }

    /// <summary>Forgets the person who signed out.</summary>
    public void Reset()
    {
        _seen.Clear();
        _shown = Array.Empty<MeetingAlert>();
        Cards.Clear();
        HasCards = false;
        Badge = null;
    }

    private MeetingCardViewModel Build(MeetingAlert alert) => alert.Kind switch
    {
        MeetingAlertKind.StartMeeting => new MeetingCardViewModel(alert.Kind, "Start meeting?", "Start meeting",
            new AsyncRelayCommand(() => _actions.StartMeetingAsync(MeetingSources.Suggestion)),
            "Not now", new RelayCommand(() => _agent.DismissMeetingAlert(alert.Kind)), secondaryIsQuiet: true),
        MeetingAlertKind.EndMeeting => new MeetingCardViewModel(alert.Kind, "End meeting?", "End meeting",
            new AsyncRelayCommand(_actions.EndMeetingAsync),
            "Not now", new RelayCommand(() => _agent.DismissMeetingAlert(alert.Kind)), secondaryIsQuiet: true),
        MeetingAlertKind.StillInMeeting => new MeetingCardViewModel(alert.Kind, "Still in a meeting?", "Still in it",
            new AsyncRelayCommand(_actions.ConfirmMeetingAsync),
            "End meeting", new AsyncRelayCommand(_actions.EndMeetingAsync), needsAction: true),
        _ => new MeetingCardViewModel(alert.Kind, "You're back to Working", "Start meeting",
            new AsyncRelayCommand(() => _actions.StartMeetingAsync())),
    };

    private string BodyOf(MeetingAlert alert) => alert.Kind switch
    {
        MeetingAlertKind.StartMeeting => alert.IsHuddle ? "You look to be in a Slack huddle." : $"You look to be on a {alert.App} call.",
        MeetingAlertKind.EndMeeting => alert.IsHuddle ? "Your Slack huddle looks finished." : $"Your {alert.App} call looks finished.",
        MeetingAlertKind.StillInMeeting => $"You've been in this meeting for {Fmt.HoursMinutes(alert.At is { } since ? _agent.Now - since : TimeSpan.Zero)}.",
        _ => $"Tap Start meeting if you're still in one. Your status moved to Working at {(alert.At is { } at ? _agent.BusinessTime(at) : _agent.BusinessTime(_agent.Now))}.",
    };
}
