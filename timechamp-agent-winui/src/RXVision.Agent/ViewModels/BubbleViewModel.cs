using CommunityToolkit.Mvvm.ComponentModel;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

public enum BubbleStatus { Idle, Working, Away, Meeting, Overrun }

/// <summary>
/// The floating button: a status ring (green working, amber on a break or lunch,
/// violet in a meeting, red over time, grey when nothing is recorded), the
/// unread badge, and the ring for a break that is due.
/// </summary>
public sealed partial class BubbleViewModel : ObservableObject
{
    public BubbleViewModel(AgentMenuViewModel? menu = null) => Menu = menu;

    /// <summary>The right-click menu (the same as the tray's).</summary>
    public AgentMenuViewModel? Menu { get; }

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsIdle), nameof(IsWorking), nameof(IsAway), nameof(IsMeeting), nameof(IsOverrun), nameof(ToolTip))]
    private BubbleStatus _status = BubbleStatus.Idle;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ToolTip))]
    private bool _isRinging;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasRingLabel))]
    private string? _ringLabel;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasUnread), nameof(UnreadText), nameof(ToolTip))]
    private int _unread;

    /// <summary>The day has not started: the tooltip says so.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ToolTip))]
    private bool _isNotStarted;

    public bool IsIdle => Status == BubbleStatus.Idle;
    public bool IsWorking => Status == BubbleStatus.Working;
    public bool IsAway => Status == BubbleStatus.Away;
    public bool IsMeeting => Status == BubbleStatus.Meeting;
    public bool IsOverrun => Status == BubbleStatus.Overrun;
    public bool HasRingLabel => !string.IsNullOrEmpty(RingLabel);
    public bool HasUnread => Unread > 0;
    public string UnreadText => Unread > 9 ? "9+" : Unread.ToString();

    public string ToolTip
    {
        get
        {
            var status = Status switch
            {
                BubbleStatus.Working => "Working",
                BubbleStatus.Away => "On a break",
                BubbleStatus.Meeting => "In a meeting",
                BubbleStatus.Overrun => "Break over time",
                _ when IsNotStarted => "Day not started",
                _ => "Not tracking",
            };
            var extra = IsRinging && RingLabel is not null ? $". {RingLabel}" : "";
            var unread = Unread > 0 ? $". {Unread} unread {(Unread == 1 ? "message" : "messages")}" : "";
            return $"RX Vision: {status}{extra}{unread}. Click to open, drag to move.";
        }
    }

    public void Update(IAgent agent)
    {
        var panel = agent.BreakPanel;
        var presence = agent.Presence.Status;
        Status = agent.State switch
        {
            AgentState.Running when panel.Active is { Overrun: true } => BubbleStatus.Overrun,
            AgentState.Running when panel.Active is not null || presence is PresenceStatus.Break or PresenceStatus.Lunch => BubbleStatus.Away,
            AgentState.Running when presence == PresenceStatus.Meeting => BubbleStatus.Meeting,
            AgentState.Running => BubbleStatus.Working,
            _ => BubbleStatus.Idle,
        };
        IsNotStarted = agent.State == AgentState.NotStarted;
        var ring = agent.State == AgentState.Running ? agent.Ring : null;
        IsRinging = ring is not null;
        RingLabel = ring is null ? null : $"{ring.Label} due";
        Unread = agent.ChatUnread;
    }
}
