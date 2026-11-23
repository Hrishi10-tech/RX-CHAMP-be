using RXVision.Agent.Core;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Api;

namespace RXVision.Agent.Services;

/// <summary>What a break asks of the person right now.</summary>
public enum BreakAlertKind { None, BreakDue, CommentNeeded, BreakEndsSoon, BreakExtended }

/// <summary>
/// The alerts a break raises, as pure functions of the agent's state and the one clock
/// (the panel's <c>Now</c>). The panel draws their cards from these; the floating icon
/// reads the same answer through <see cref="ViewModels.BubbleViewModel.BreakAlert"/> and
/// owns the badge's pop, motion and clearing. AGENT.md section 3 has the table.
/// </summary>
public static class BreakAlerts
{
    /// <summary>Break ends in 2 min fires at this much left, on breaks longer than this.</summary>
    public static readonly TimeSpan EndsSoonAt = TimeSpan.FromSeconds(120);

    /// <summary>The one badge a break asks for: "!" over "i".</summary>
    /// <param name="biometric">The biometric device takes this person's attendance: breaks ask nothing of them.</param>
    public static BreakAlertKind For(AgentState state, BreakPanel panel, WorkdayToday? workday, bool biometric = false)
    {
        if (state != AgentState.Running || biometric) return BreakAlertKind.None;
        if (panel.Active is { } active)
        {
            if (active.Overrun) return BreakAlertKind.BreakExtended;
            return EndsSoon(active) ? BreakAlertKind.BreakEndsSoon : BreakAlertKind.None;
        }
        if (DueSlot(state, panel, workday) is not null) return BreakAlertKind.BreakDue;
        return CommentWaiting(panel) is not null ? BreakAlertKind.CommentNeeded : BreakAlertKind.None;
    }

    /// <summary>"!" when action is needed, "i" for information, null for nothing (brief 1.2).</summary>
    public static string? Badge(BreakAlertKind kind) => kind switch
    {
        BreakAlertKind.BreakDue or BreakAlertKind.BreakExtended or BreakAlertKind.CommentNeeded => "!",
        BreakAlertKind.BreakEndsSoon => "i",
        _ => null,
    };

    /// <summary>120 s or less left of a break longer than 2 min; gone once it runs out.</summary>
    public static bool EndsSoon(ActiveBreakView active) =>
        active is { Overrun: false, DurationMin: > 2, Remaining: { } left } && left <= EndsSoonAt;

    /// <summary>
    /// The break whose card shows: it fired at its ring start while the day ran, and stays
    /// until it is taken, skipped or its window closes. A day started after that time never
    /// rang for it: the break can still be taken from Today's actions, with no card.
    /// </summary>
    public static SlotView? DueSlot(AgentState state, BreakPanel panel, WorkdayToday? workday)
    {
        if (state != AgentState.Running || panel.Active is not null) return null;
        return panel.Slots.FirstOrDefault(s => s.CanStart && s.PendingAutoSkip is null
            && (s.State == SlotState.Due
                || (s.State == SlotState.OpenLate && workday?.StartedAt is { } started && started <= s.RingStart)));
    }

    /// <summary>The first of today's auto-skips still waiting for its one comment.</summary>
    public static BreakRecord? CommentWaiting(BreakPanel panel) =>
        panel.Slots.Select(s => s.Record).FirstOrDefault(r => r is { NeedsComment: true, IsAutoSkip: true });
}
