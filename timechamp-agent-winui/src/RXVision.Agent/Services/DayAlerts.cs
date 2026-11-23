using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Icon;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Services;

/// <summary>
/// Turns what the agent knows into alerts (AGENT.md section 3, words from the deck). Break due,
/// Break ends in 2 min and Break extended are read from the agent each second; the rest come from
/// its events. Each fires once and clears itself when it stops being true.
/// 4.0 keeps its own away pop-up (SPEC 2.5: the person says what the time was), so 3.6's local
/// "You've been away" card is not raised here; a quick break past its planned length and an End
/// Day waiting for comments, which 4.0 said in toasts, are cards like the rest.
/// </summary>
public sealed class DayAlerts
{
    public const string BreakDueKey = "break:due";
    public const string BreakEndingKey = "break:ending";
    public const string BreakExtendedKey = "break:extended";
    public const string StartDayKey = "day:start";
    public const string EndDayHeldKey = "day:held";
    private const string SkippedPrefix = "break:skipped:";
    private const string NoticePrefix = "note:";

    /// <summary>A break longer than this gets the "ends in 2 min" card.</summary>
    public static readonly TimeSpan EndingAt = TimeSpan.FromMinutes(2);

    private readonly IAgent _agent;
    private readonly AlertCenter _center;
    private readonly BreakActions _actions;
    private readonly Action<string> _openUrl;
    private readonly MeetingAlerts _meetings;
    private string? _dueSlot;
    private string? _endingBreak;

    /// <param name="openUrl">Opens a page in the browser (the portal, for an approval).</param>
    public DayAlerts(IAgent agent, AlertCenter center, BreakActions actions, Action<string> openUrl)
    {
        _agent = agent;
        _center = center;
        _actions = actions;
        _openUrl = openUrl;
        _meetings = new MeetingAlerts(agent, center, actions);
    }

    /// <summary>Brings the alerts in line with the agent. Cheap: once a second.</summary>
    public void Sync()
    {
        var running = _agent.State == AgentState.Running;
        var status = DayMeter.StatusOf(_agent);
        var panel = _agent.BreakPanel;
        SyncBreakDue(running, status, panel);
        SyncBreakRunning(running, panel);
        if (_agent.State != AgentState.NotStarted) _center.Clear(StartDayKey);
        SyncSkipped(running, panel);
        if (_agent.HeldEndDay is null) _center.Clear(EndDayHeldKey);
        _meetings.Sync();
    }

    public void Reset()
    {
        _center.ClearAll();
        _dueSlot = null;
        _endingBreak = null;
    }

    // ---- From the schedule ----------------------------------------------------------------------

    /// <summary>Fires at the ring's start while Working or In a meeting; goes when taken, skipped, or the window closes.</summary>
    private void SyncBreakDue(bool running, IconStatus status, BreakPanel panel)
    {
        // Biometric staff have no break buttons and no reminders (3.5).
        var due = running && !_agent.IsBiometric;
        if (due && status is IconStatus.Working or IconStatus.Meeting && panel.Ring is { } ring && _dueSlot != ring.Kind
            && panel.Slots.FirstOrDefault(s => s.Kind == ring.Kind) is { } slot)
        {
            _dueSlot = ring.Kind;
            _center.Raise(BreakDueCard(slot));
        }
        if (_dueSlot is null) return;
        var open = due && panel.Slots.Any(s => s.Kind == _dueSlot && s.CanStart);
        if (open) return;
        _dueSlot = null;
        _center.Clear(BreakDueKey);
    }

    private AlertCard BreakDueCard(SlotView slot)
    {
        var kind = slot.Kind;
        var presence = slot.PresenceType;
        return new AlertCard(BreakDueKey, AlertLevel.Action, $"Time for your {Fmt.Lower(slot.Label)}", $"{slot.DurationMin} min, from {slot.LocalStart}.")
        {
            PrimaryText = "Take a break",
            OnPrimary = () => _actions.TakeAsync(presence, kind, confirm: false),
            SecondaryText = slot.CanSkip ? "Skip this break" : null,
            OnSecondary = slot.CanSkip ? () => _actions.SkipAsync(kind) : null,
        };
    }

    /// <summary>120 s left on a break longer than that, then the length runs out. A break with no length has neither.</summary>
    private void SyncBreakRunning(bool running, BreakPanel panel)
    {
        var active = running ? panel.Active : null;
        var key = active is null ? null : $"{active.Kind}|{active.StartedAt.UtcTicks}";
        if (key != _endingBreak)
        {
            _endingBreak = key;
            _center.Clear(BreakEndingKey);
            _center.Clear(BreakExtendedKey);
        }
        if (active?.Remaining is not { } left || active.DurationMin is not { } minutes || minutes <= 0)
        {
            _center.Clear(BreakEndingKey);
            _center.Clear(BreakExtendedKey);
            return;
        }
        if (active.Overrun)
        {
            _center.Clear(BreakEndingKey);
            if (!_center.Has(BreakExtendedKey)) _center.Raise(BreakExtendedCard(active, minutes));
        }
        else if (left <= EndingAt && TimeSpan.FromMinutes(minutes) > EndingAt && !_center.Has(BreakEndingKey))
        {
            _center.Raise(new AlertCard(BreakEndingKey, AlertLevel.Info, "Break ends in 2 min", "Your ring starts again when you resume.")
            {
                PrimaryText = "Resume now",
                OnPrimary = _actions.BackToWorkAsync,
            });
        }
    }

    private AlertCard BreakExtendedCard(ActiveBreakView active, int minutes)
    {
        if (active.IsQuick)
        {
            // 4.0 quick break (SPEC 2.3): nothing ends by itself; minutes over come out of the paid buffer.
            return new AlertCard(BreakExtendedKey, AlertLevel.Action, $"Your {minutes} min quick break is up.",
                "It keeps counting until you end it. Minutes over come out of your paid buffer.")
            {
                PrimaryText = "End break",
                OnPrimary = _actions.EndBreakAsync,
            };
        }
        var ended = _agent.BusinessTime(active.StartedAt.AddMinutes(minutes));
        return new AlertCard(BreakExtendedKey, AlertLevel.Action, "Break extended", $"Your {Fmt.Lower(active.Label)} ended at {ended}.")
        {
            PrimaryText = "Resume work",
            OnPrimary = _actions.BackToWorkAsync,
        };
    }

    // ---- From the agent's events -----------------------------------------------------------------

    /// <summary>The window closed untaken while the day ran: "!", until the comment is sent.</summary>
    public void OnAutoSkipped(BreakRecord record)
    {
        if (_agent.State != AgentState.Running) return;
        var label = string.IsNullOrWhiteSpace(record.Label) ? "Break" : record.Label;
        var id = record.Id;
        _center.Raise(new AlertCard(SkippedPrefix + id, AlertLevel.Action, $"{label} skipped for you.", "Add a comment before you end your day.")
        {
            PrimaryText = "Add comment",
            OnPrimary = () => _actions.CommentAsync(id),
        });
    }

    private void SyncSkipped(bool running, BreakPanel panel)
    {
        foreach (var card in _center.Cards.Where(c => c.Key.StartsWith(SkippedPrefix, StringComparison.Ordinal)).ToList())
        {
            var id = card.Key[SkippedPrefix.Length..];
            var record = panel.Slots.Select(s => s.Record).FirstOrDefault(r => r?.Id == id);
            if (!running || record is { NeedsComment: false }) _center.Clear(card.Key);
        }
    }

    /// <summary>The nudge to start the day: "i", until the day has started.</summary>
    public void OnNudge(AgentNudge nudge)
    {
        if (_agent.State != AgentState.NotStarted) return;
        var first = Fmt.FirstName(_agent.User?.FirstName ?? _agent.User?.DisplayName);
        var greeting = Fmt.Greeting(_agent.BusinessLocal(_agent.Now));
        var title = nudge.Kind switch
        {
            NudgeKind.AtDesk => "You're at your desk. Start your day?",
            _ => first.Length > 0 ? $"{greeting}, {first}." : $"{greeting}.",
        };
        var body = nudge.Kind == NudgeKind.Greeting ? "Tap Start day when you begin work." : "Nothing is recorded until you do.";
        _center.Raise(new AlertCard(StartDayKey, AlertLevel.Info, title, body)
        {
            PrimaryText = "Start day",
            OnPrimary = _actions.StartDayAsync,
        });
    }

    /// <summary>
    /// 4.0: an End Day done offline was refused for comments on skipped breaks (said once). "!",
    /// until it is resolved: End Day adds them and the day ends at the time it was ended.
    /// </summary>
    public void OnEndDayHeld(HeldEndDay held)
    {
        var one = held.Breaks.Count == 1;
        _center.Raise(new AlertCard(EndDayHeldKey, AlertLevel.Action,
            $"Your End Day at {_agent.BusinessTime(held.At)} needs {(one ? "a comment" : "comments")}",
            one
                ? "A skipped break needs a comment before your day can end then. Until you add it, your day stays open."
                : $"{held.Breaks.Count} skipped breaks need a comment before your day can end then. Until you add them, your day stays open.")
        {
            PrimaryText = "Add comments",
            OnPrimary = _actions.EndDayAsync,
        });
    }

    /// <summary>A new notification: title and body as the server sent them, "i". Approvals open in the portal.</summary>
    public void OnNotification(NotificationItem item)
    {
        var portal = IsApproval(item.Type) ? BreakActions.ApprovalsUrl(_agent.Workday?.PortalUrl) : null;
        var key = NoticePrefix + (string.IsNullOrEmpty(item.Id) ? Guid.NewGuid().ToString() : item.Id);
        _center.Raise(new AlertCard(key, AlertLevel.Info, item.Title, item.Body ?? "")
        {
            GoneWhenRead = true,
            PrimaryText = portal is null ? null : "Open approvals",
            OnPrimary = portal is null ? null : () =>
            {
                _openUrl(portal);
                return Task.CompletedTask;
            },
        });
    }

    private static bool IsApproval(string? type) => type is
        "BREAK_APPROVAL_REQUESTED" or "SKIP_REQUESTED" or "AUTO_SKIP_REQUESTED" or "SKIP_COMMENT_ADDED"
        or "MEETING_REQUESTED" or "LEAVE_REQUESTED" or "LEAVE_CANCELLED" or "WFH_REQUESTED" or "WFH_CANCELLED"
        or "COMPOFF_CLAIMED" or "BREAK_APPROVALS_DIGEST" or "APPROVALS_DUE_SOON" or "APPROVALS_OVERDUE" or "APPROVALS_ESCALATED";
}
