using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Services;

/// <summary>The cards that slide in beside the button, built in one place (so their words are tested).</summary>
public static class Toasts
{
    /// <summary>The break ring: Take it, and Skip break when the shift allows it (else Open RX Vision).</summary>
    public static ToastViewModel Ring(IAgent agent, RingView ring, Action take, Action skip, Action open)
    {
        var slot = agent.BreakPanel.Slots.FirstOrDefault(s => s.Kind == ring.Kind);
        // Not a break End Day already skipped (it can be taken, not skipped again).
        var canSkip = slot is { CanSkip: true };
        return new ToastViewModel(ToastKind.BreakDue, "ring:" + ring.Kind)
        {
            Sticky = true,
            Heading = $"{ring.Label} is due now",
            Title = ring.Label,
            Stamp = slot?.LocalStart ?? agent.BusinessTime(agent.Now),
            Body = $"Rings till {agent.BusinessTime(ring.RingEnd)}. Start it now and no reason is needed.",
            PrimaryText = "Take it",
            SecondaryText = canSkip ? "Skip break" : "Open RX Vision",
            OnPrimary = take,
            OnSecondary = canSkip ? skip : null,
            OnOpen = open,
        };
    }

    /// <summary>"Morning break auto-skipped. Add a comment before End Day." Once per break.</summary>
    public static ToastViewModel AutoSkipped(IAgent agent, BreakRecord record, Action comment, Action open)
    {
        var label = string.IsNullOrWhiteSpace(record.Label) ? "Break" : record.Label;
        return new ToastViewModel(ToastKind.AutoSkip, "autoskip:" + record.Id)
        {
            Heading = "Break auto-skipped",
            Title = $"{label} auto-skipped.",
            Stamp = agent.BusinessTime(record.StartedAt == default ? agent.Now : record.StartedAt),
            Body = "Add a comment before End Day.",
            PrimaryText = "Add comment",
            Lifetime = TimeSpan.FromSeconds(20),
            OnPrimary = comment,
            OnOpen = open,
        };
    }

    /// <summary>"Good morning, Asha. Start Day when you begin work." or "You're at your desk. Start Day?"</summary>
    public static ToastViewModel Nudge(IAgent agent, AgentNudge nudge, Action start, Action open)
    {
        var first = Fmt.FirstName(agent.User?.FirstName ?? agent.User?.DisplayName);
        var greeting = Fmt.Greeting(agent.BusinessLocal(agent.Now));
        var atDesk = nudge.Kind == NudgeKind.AtDesk;
        return new ToastViewModel(ToastKind.Day, "day:start")
        {
            Heading = "Start your day",
            Title = atDesk ? "You're at your desk. Start Day?" : first.Length > 0 ? $"{greeting}, {first}." : $"{greeting}.",
            Stamp = agent.BusinessTime(agent.Now),
            Body = atDesk ? "Nothing is recorded until you do." : "Start Day when you begin work.",
            PrimaryText = "Start Day",
            SecondaryText = "Open RX Vision",
            Lifetime = TimeSpan.FromSeconds(20),
            OnPrimary = start,
            OnOpen = open,
        };
    }

    /// <summary>
    /// An action kept on this computer was refused when it reached RX Vision (SPEC 6:
    /// shown once; the day is read again from the server).
    /// </summary>
    public static ToastViewModel ActionRefused(IAgent agent, string message, Action open) =>
        new(ToastKind.Info, "action:refused:" + message)
        {
            Heading = "RX Vision",
            Title = "Something you did couldn't be saved",
            Stamp = agent.BusinessTime(agent.Now),
            Body = message,
            Lifetime = TimeSpan.FromSeconds(20),
            OnOpen = open,
        };

    /// <summary>
    /// An End Day done offline was refused for comments on skipped breaks (said once): the
    /// person adds them, and the day ends at the time they ended it.
    /// </summary>
    public static ToastViewModel EndDayHeld(IAgent agent, HeldEndDay held, Action add, Action open) =>
        new(ToastKind.Info, "endday:held:" + held.At.ToUnixTimeSeconds())
        {
            Heading = "RX Vision",
            Title = $"Your End Day at {agent.BusinessTime(held.At)} needs {(held.Breaks.Count == 1 ? "a comment" : "comments")}",
            Stamp = agent.BusinessTime(agent.Now),
            Body = held.Breaks.Count == 1
                ? "A skipped break needs a comment before your day can end then. Until you add it, your day stays open."
                : $"{held.Breaks.Count} skipped breaks need a comment before your day can end then. Until you add them, your day stays open.",
            PrimaryText = "Add comments",
            Lifetime = TimeSpan.FromSeconds(60),
            OnPrimary = add,
            OnOpen = open,
        };

    /// <summary>A quick break past its planned length: said once, nothing ends by itself (SPEC 2.3).</summary>
    public static ToastViewModel QuickOver(IAgent agent, ActiveBreakView active, Action end, Action open) =>
        new(ToastKind.Info, "quick:over:" + active.Id)
        {
            Heading = "Quick break",
            Title = $"Your {active.DurationMin ?? 0} min quick break is up.",
            Stamp = agent.BusinessTime(agent.Now),
            Body = "It keeps counting until you end it. Minutes over come out of your paid buffer.",
            PrimaryText = "End break",
            Lifetime = TimeSpan.FromSeconds(30),
            OnPrimary = end,
            OnOpen = open,
        };

    /// <summary>One quiet line for 5 seconds; dropped if it can't show within 10.</summary>
    public static ToastViewModel Cue(string line) =>
        new(ToastKind.Cue, "cue")
        {
            Title = line,
            Lifetime = TimeSpan.FromSeconds(5),
            MaxWait = TimeSpan.FromSeconds(10),
        };
}
