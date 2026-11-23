using RXVision.Agent.Core;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Services;

/// <summary>
/// The few cards that still slide in beside the icon. Anything that wants action is an alert
/// (see <see cref="AlertCenter"/>): the break ring, a break skipped for the person, the Start day
/// nudge, a notification, a quick break past its length and an End Day waiting for comments (3.6).
/// What stays here is time-bound or said once: a message, an action the server refused, 4.0.2's
/// shift-end question (it has a one-minute answer), the sign-out for the next shift, and a cue.
/// </summary>
public static class Toasts
{
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
    /// 4.1 shared computer: "Are you extending your shift?" Shown for a minute (asked again
    /// 5 minutes before the end); with no answer by the deadline the person is signed out.
    /// </summary>
    public static ToastViewModel ShiftQuestion(IAgent agent, ShiftQuestion q, Action yes, Action no, Action open) =>
        new(ToastKind.Info, "shift:end")
        {
            Lifetime = TimeSpan.FromMinutes(1),
            KeepOnOpen = true,
            Heading = q.Last ? "Your shift is ending" : "Your shift ends soon",
            Title = $"Your shift ends at {agent.BusinessTime(q.ShiftEnd)}. Are you extending your shift?",
            Stamp = agent.BusinessTime(agent.Now),
            Body = $"If not, you'll be signed out at {agent.BusinessTime(q.Deadline)} so the next person can sign in.",
            PrimaryText = "Yes",
            SecondaryText = "No",
            OnPrimary = yes,
            OnSecondary = no,
            OnOpen = open,
        };

    /// <summary>The answer to the shift-end question, said back in one line.</summary>
    public static string ShiftAnswer(IAgent agent, bool continuing, DateTimeOffset deadline) =>
        continuing
            ? "Shift extended: your time keeps counting. Tap End day when you finish."
            : $"You'll be signed out at {agent.BusinessTime(deadline)}.";

    /// <summary>Signed out at the shift end (or after End Day) on a shared computer.</summary>
    public static ToastViewModel SignedOutForNextShift() =>
        new(ToastKind.Info, "shift:signed-out")
        {
            Heading = "RX Vision",
            Title = "Signed out for the next shift",
            Body = "Your day was saved. The next person can sign in now.",
            Lifetime = TimeSpan.FromSeconds(15),
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
