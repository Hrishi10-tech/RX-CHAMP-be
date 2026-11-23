using CommunityToolkit.Mvvm.ComponentModel;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Workday;
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
    [NotifyPropertyChangedFor(nameof(HasUnread), nameof(ShowUnread), nameof(UnreadText), nameof(ToolTip))]
    private int _unread;

    /// <summary>"!" or "i" from a meeting card the panel has not shown yet; null with nothing to see.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasAlertBadge), nameof(ShowUnread))]
    private string? _alertBadge;

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
    public bool HasAlertBadge => AlertBadge is not null;
    /// <summary>One badge at a time: a meeting card's over the count.</summary>
    public bool ShowUnread => HasUnread && !HasAlertBadge;
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

    /// <summary>The look of a status: one status, one look, for the icon and the panel's header.</summary>
    public static BubbleStatus StatusFor(DayStatus status, bool overrun) => status switch
    {
        DayStatus.OnBreak => overrun ? BubbleStatus.Overrun : BubbleStatus.Away,
        DayStatus.InMeeting => BubbleStatus.Meeting,
        DayStatus.Working => BubbleStatus.Working,
        _ => BubbleStatus.Idle,
    };

    public void Update(IAgent agent)
    {
        var panel = agent.BreakPanel;
        Status = StatusFor(DayStatusReader.Of(agent.State, agent.DayProgress, agent.Presence.Status, panel.Active is not null), panel.Active is { Overrun: true });
        IsNotStarted = agent.State == AgentState.NotStarted;
        var ring = agent.State == AgentState.Running ? agent.Ring : null;
        IsRinging = ring is not null;
        RingLabel = ring is null ? null : $"{ring.Label} due";
        Unread = agent.ChatUnread;
    }
}
