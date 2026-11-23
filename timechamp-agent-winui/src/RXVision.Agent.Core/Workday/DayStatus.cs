using RXVision.Agent.Core.Api;

namespace RXVision.Agent.Core.Workday;

/// <summary>The five statuses (brief 1.8). Exclusive: a person is in exactly one.</summary>
public enum DayStatus { NotStarted, Working, InMeeting, OnBreak, DayEnded }

public static class DayStatusReader
{
    /// <summary>
    /// The one reading of the status for the icon, the panel and the menus: the day's state, then
    /// a running break, then a meeting. 4.0 keeps the day locally first (the journal), so the
    /// presence worked out from it leads: the host's presence already follows the server's day
    /// progress for In a meeting (3.6), and the progress adds a status meeting the day has not
    /// read yet. A break or Working the server reports is never taken over the local day, which
    /// may hold actions the server has not had yet.
    /// </summary>
    public static DayStatus Of(AgentState state, DayProgress? progress, string presenceStatus, bool breakRunning)
    {
        if (state == AgentState.DayEnded) return DayStatus.DayEnded;
        if (state != AgentState.Running) return DayStatus.NotStarted;
        if (breakRunning || presenceStatus is PresenceStatus.Break or PresenceStatus.Lunch) return DayStatus.OnBreak;
        if (presenceStatus == PresenceStatus.Meeting) return DayStatus.InMeeting;
        return progress is { InMeeting: true } ? DayStatus.InMeeting : DayStatus.Working;
    }
}
