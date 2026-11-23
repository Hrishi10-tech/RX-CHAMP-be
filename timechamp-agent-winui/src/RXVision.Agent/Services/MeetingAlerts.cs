using RXVision.Agent.Core.Meetings;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Services;

/// <summary>
/// The meeting feature's cards (AGENT.md section 6, words from the deck, A21): Start meeting?,
/// End meeting?, Still in a meeting? and You're back to Working. They are all a suggestion ever
/// shows: a card on the panel and a badge on the icon, no window of their own and no focus taken.
/// The status changes only when the person taps. Read from the agent each second.
/// </summary>
public sealed class MeetingAlerts
{
    public const string StartKey = "meeting:start";
    public const string EndKey = "meeting:end";
    public const string StillKey = "meeting:still";
    public const string BackKey = "meeting:back";

    private readonly IAgent _agent;
    private readonly AlertCenter _center;
    private readonly BreakActions _actions;
    private readonly Dictionary<string, MeetingAlert> _shown = new();

    public MeetingAlerts(IAgent agent, AlertCenter center, BreakActions actions)
    {
        _agent = agent;
        _center = center;
        _actions = actions;
    }

    /// <summary>Brings the cards in line with the agent. Cheap: once a second.</summary>
    public void Sync()
    {
        var alerts = _agent.MeetingAlerts;
        foreach (var key in new[] { StartKey, EndKey, StillKey, BackKey })
        {
            var alert = alerts.FirstOrDefault(a => KeyOf(a.Kind) == key);
            _shown.TryGetValue(key, out var was);
            if (alert is null)
            {
                if (was is not null) _center.Clear(key);
                _shown.Remove(key);
                continue;
            }
            if (alert != was || !_center.Has(key))
            {
                _shown[key] = alert;
                _center.Raise(Card(alert));
            }
            else if (_center.Find(key) is { } card)
            {
                card.Body = BodyOf(alert);
            }
        }
    }

    public static string KeyOf(MeetingAlertKind kind) => kind switch
    {
        MeetingAlertKind.StartMeeting => StartKey,
        MeetingAlertKind.EndMeeting => EndKey,
        MeetingAlertKind.StillInMeeting => StillKey,
        _ => BackKey,
    };

    private AlertCard Card(MeetingAlert alert)
    {
        var kind = alert.Kind;
        var key = KeyOf(kind);
        Task NotNow()
        {
            _agent.DismissMeetingAlert(kind);
            Sync();
            return Task.CompletedTask;
        }
        return kind switch
        {
            MeetingAlertKind.StartMeeting => new AlertCard(key, AlertLevel.Info, "Start meeting?", BodyOf(alert))
            {
                PrimaryText = "Start meeting",
                OnPrimary = () => _actions.StartMeetingAsync(MeetingSources.Suggestion),
                SecondaryText = "Not now",
                OnSecondary = NotNow,
            },
            MeetingAlertKind.EndMeeting => new AlertCard(key, AlertLevel.Info, "End meeting?", BodyOf(alert))
            {
                PrimaryText = "End meeting",
                OnPrimary = _actions.EndMeetingAsync,
                SecondaryText = "Not now",
                OnSecondary = NotNow,
            },
            MeetingAlertKind.StillInMeeting => new AlertCard(key, AlertLevel.Action, "Still in a meeting?", BodyOf(alert))
            {
                PrimaryText = "Still in it",
                OnPrimary = _actions.ConfirmMeetingAsync,
                SecondaryText = "End meeting",
                OnSecondary = _actions.EndMeetingAsync,
                SecondaryIsOutlined = true,
            },
            _ => new AlertCard(key, AlertLevel.Info, "You're back to Working", BodyOf(alert))
            {
                PrimaryText = "Start meeting",
                OnPrimary = () => _actions.StartMeetingAsync(),
                GoneWhenRead = true,
            },
        };
    }

    private string BodyOf(MeetingAlert alert) => alert.Kind switch
    {
        MeetingAlertKind.StartMeeting => alert.IsHuddle ? "You look to be in a Slack huddle." : $"You look to be on a {alert.App} call.",
        MeetingAlertKind.EndMeeting => alert.IsHuddle ? "Your Slack huddle looks finished." : $"Your {alert.App} call looks finished.",
        MeetingAlertKind.StillInMeeting => $"You've been in this meeting for {Fmt.HoursMinutes(alert.At is { } since ? (int)(_agent.Now - since).TotalSeconds : 0)}.",
        _ => $"Tap Start meeting if you're still in one. Your status moved to Working at {(alert.At is { } at ? _agent.BusinessTime(at) : _agent.BusinessTime(_agent.Now))}.",
    };
}
