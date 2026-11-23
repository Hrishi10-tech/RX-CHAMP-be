using CommunityToolkit.Mvvm.ComponentModel;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Icon;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>The status words the panel's header uses.</summary>
public enum BubbleStatus { Idle, Working, Away, Meeting, Overrun }

public static class BubbleStatuses
{
    /// <summary>The look of a status: one status, one look, for the icon and the panel's header.</summary>
    public static BubbleStatus For(DayStatus status, bool overrun) => status switch
    {
        DayStatus.OnBreak => overrun ? BubbleStatus.Overrun : BubbleStatus.Away,
        DayStatus.InMeeting => BubbleStatus.Meeting,
        DayStatus.Working => BubbleStatus.Working,
        _ => BubbleStatus.Idle,
    };
}

/// <summary>
/// The floating icon, with no window: what to draw (<see cref="Frame"/>), how to show it
/// (<see cref="Opacity"/>, <see cref="Saturation"/>, <see cref="ShakeX"/>) and what the label says.
/// Every number comes from the one clock. A frame timer runs only while something moves; at rest
/// only the minute tick wakes it. UI thread only.
/// </summary>
public sealed partial class BubbleViewModel : ObservableObject, IDisposable
{
    public static readonly TimeSpan MinuteTick = TimeSpan.FromMinutes(1);
    public static readonly TimeSpan SweepTakes = TimeSpan.FromSeconds(1);
    public static readonly TimeSpan CrossfadeTakes = TimeSpan.FromMilliseconds(300);
    public static readonly TimeSpan PopTakes = TimeSpan.FromMilliseconds(240);

    private readonly IAgent _agent;
    private readonly IClock _clock;
    private readonly IUiDispatcher _ui;
    private readonly DayMeter _meter;
    private readonly AlertCenter _alerts;
    private readonly IconBehaviour _behaviour;
    private readonly BadgeMotion _motion = new();
    private readonly FramePump _pump;
    private IDisposable? _minuteTimer;
    private IDisposable? _nextMove;

    private IconLook _lookFrom;
    private IconLook _lookTo;
    private TimeSpan _lookStart;
    private Tween _sweep = Tween.Still(0);
    private Tween _pop = Tween.Still(0);
    private string? _glyph;
    private bool _alertBadge;
    private bool _shown = true;
    private bool _first = true;
    private string _initials = "";

    public BubbleViewModel(IAgent agent, DayMeter meter, AlertCenter alerts, IUiDispatcher ui,
        AgentMenuViewModel? menu = null, IIconAvatarSource? avatars = null)
    {
        _agent = agent;
        _clock = agent.Clock;
        _ui = ui;
        _meter = meter;
        _alerts = alerts;
        Menu = menu;
        Avatars = avatars ?? new InitialsAvatarSource(agent);
        Avatars.Changed += () => AvatarChanged?.Invoke();
        _behaviour = new IconBehaviour(_clock, ui);
        _behaviour.Changed += () => Move();
        _pump = new FramePump(_clock, ui, Step);
        _lookFrom = _lookTo = IconLook.For(IconStatus.NotStarted, false);
        _alerts.Arrived += OnAlertArrived;
        _alerts.Changed += Update;
        _minuteTimer = _clock.StartTimer(() => _ui.Post(OnMinute), MinuteTick, MinuteTick);
        Update();
    }

    /// <summary>The right-click menu (the same as the tray's).</summary>
    public AgentMenuViewModel? Menu { get; }

    /// <summary>Where the picture comes from.</summary>
    public IIconAvatarSource Avatars { get; }

    /// <summary>The picture or the initials changed.</summary>
    public event Action? AvatarChanged;

    /// <summary>What to draw now. Equal frames draw the same pixels: nothing redraws when it holds still.</summary>
    [ObservableProperty] private IconFrame _frame;
    /// <summary>The whole icon's opacity: 1, or 0.4 faded.</summary>
    [ObservableProperty] private double _opacity = 1;
    /// <summary>The whole icon's saturation: 1, or 0.6 faded.</summary>
    [ObservableProperty] private double _saturation = 1;
    /// <summary>The shake: the drawing's shift to the side, in device-independent pixels.</summary>
    [ObservableProperty] private double _shakeX;
    /// <summary>"Working · 5h 12m of 8h".</summary>
    [ObservableProperty] private string _label = "";
    [ObservableProperty] private bool _isLabelVisible;
    /// <summary>The window's name for screen readers, updated on the minute.</summary>
    [ObservableProperty] private string _accessibleName = "RX Vision";

    /// <summary>The unread count on the icon. 4.0 drives it from the manager chat's unread count (the bubble showed it).</summary>
    [ObservableProperty] private int _messageCount;

    partial void OnMessageCountChanged(int value) => Update();

    /// <summary>The look of a status (see <see cref="BubbleStatuses.For"/>).</summary>
    public static BubbleStatus StatusFor(DayStatus status, bool overrun) => BubbleStatuses.For(status, overrun);

    /// <summary>The one clock, for the window's own timers.</summary>
    public IClock Clock => _clock;
    public IconStatus Status => _meter.Reading.Status;
    public bool HasBadge => _glyph is not null;
    public string? BadgeGlyph => _glyph;
    public bool IsFrameTimerRunning => _pump.IsRunning;
    public bool RestsFaded => _behaviour.RestsFaded;

    // ---- From the app ------------------------------------------------------------------------

    /// <summary>Follows the agent: for every event and each second. Draws nothing if nothing changed.</summary>
    public void Update()
    {
        _meter.Follow();
        var reading = _meter.Reading;
        var now = _clock.Monotonic;

        var look = IconLook.For(reading.Status, reading.Reached);
        if (look != _lookTo)
        {
            _lookFrom = IconLook.Mix(_lookFrom, _lookTo, (now - _lookStart) / CrossfadeTakes);
            _lookTo = look;
            _lookStart = _first ? now - CrossfadeTakes : now;
        }

        var sweep = reading.SweepDegrees;
        var jumped = _meter.TakeJump();
        if (Math.Abs(sweep - _sweep.To) > 0.0001)
        {
            // The sweep steps on the minute with a slow ease. A new day or a first answer simply is.
            _sweep = _first || jumped
                ? Tween.Still(sweep)
                : new Tween(_sweep.At(now), sweep, now, SweepTakes, Easing.InOut);
        }

        UpdateBadge(now);
        _behaviour.SetStatus(reading.Status);
        _behaviour.SetHolding(_glyph is not null);
        Label = reading.Label;
        AccessibleName = reading.AccessibleName;
        if (_initials != Avatars.Initials)
        {
            _initials = Avatars.Initials;
            AvatarChanged?.Invoke();
        }
        _first = false;
        Move();
    }

    /// <summary>The pointer came onto the circle or the badge.</summary>
    public void PointerOn() => _behaviour.PointerOn();

    /// <summary>The pointer left it.</summary>
    public void PointerOff() => _behaviour.PointerOff();

    /// <summary>A click, a drag, a status change by tap: the 30 s start again.</summary>
    public void Interaction() => _behaviour.Interaction();

    /// <summary>The panel opened or closed. Opening clears the badge and holds full colour; closing starts the 30 s.</summary>
    public void SetPanelOpen(bool open)
    {
        if (open == _alerts.PanelOpen) return;
        if (open)
        {
            _alerts.Opened();
            _motion.Stop();
        }
        else
        {
            _alerts.Closed();
        }
        _behaviour.SetPanelOpen(open);
        Update();
    }

    /// <summary>The icon was hidden (a full-screen app in front) or shown again: the 60 s of motion waits for it.</summary>
    public void SetShown(bool shown)
    {
        if (shown == _shown) return;
        _shown = shown;
        var now = _clock.Monotonic;
        if (shown) _motion.Resume(now);
        else _motion.Pause(now);
        Move();
    }

    /// <summary>Whoever signed in next starts clean.</summary>
    public void Reset()
    {
        _motion.Stop();
        _meter.Reset();
        _first = true;
        Update();
    }

    // ---- Alerts -------------------------------------------------------------------------------

    private void OnAlertArrived()
    {
        var now = _clock.Monotonic;
        if (_shown) _motion.Start(now);
        else _motion.Wait();
        Update();
    }

    /// <summary>One badge at a time: "!" over "i" over the count. Only an alert pops; a count just shows.</summary>
    private void UpdateBadge(TimeSpan now)
    {
        var level = _alerts.Badge;
        var glyph = level switch
        {
            AlertLevel.Action => IconGlyphs.Action,
            AlertLevel.Info => IconGlyphs.Info,
            _ => MessageCount > 0 ? IconGlyphs.Count(MessageCount) : null,
        };
        if (level is null) _motion.Stop();
        var hadAlertBadge = _alertBadge;
        _alertBadge = level is not null;
        if (glyph != _glyph)
        {
            _glyph = glyph;
            OnPropertyChanged(nameof(HasBadge));
            OnPropertyChanged(nameof(BadgeGlyph));
        }
        // A new alert during motion swaps the glyph and keeps the rhythm: no second pop.
        if (_alertBadge && !hadAlertBadge) _pop = new Tween(0, 1, now, PopTakes, Easing.Pop);
        else if (!_alertBadge) _pop = Tween.Still(1);
    }

    // ---- Motion -------------------------------------------------------------------------------

    private void OnMinute()
    {
        // The core reads the day progress at most once a minute itself (26f4aa2): the icon only follows it.
        _meter.MinuteTick();
        Update();
    }

    /// <summary>Something may have started to move: draw now, and keep drawing while it does.</summary>
    private void Move()
    {
        if (Step()) _pump.Wake();
        else if (_pump.IsRunning) _pump.Dispose();
    }

    /// <summary>One frame, computed from the clock. True while anything is still moving.</summary>
    private bool Step()
    {
        var now = _clock.Monotonic;
        var crossfade = (now - _lookStart) / CrossfadeTakes;
        var moving = crossfade < 1 || !_sweep.IsDone(now) || !_pop.IsDone(now) || _behaviour.IsMoving(now) || _motion.IsMoving(now);

        Frame = new IconFrame(IconLook.Mix(_lookFrom, _lookTo, crossfade), _sweep.At(now), _glyph, _glyph is null ? 0 : _pop.At(now));
        Opacity = _behaviour.OpacityAt(now);
        Saturation = _behaviour.SaturationAt(now);
        ShakeX = _motion.Offset(now);
        IsLabelVisible = _behaviour.Hovering;
        if (!moving) ScheduleNextMove(now);
        return moving;
    }

    /// <summary>3 s still: no frames. One timer wakes the next second of movement, or the end of the 60 s.</summary>
    private void ScheduleNextMove(TimeSpan now)
    {
        _nextMove?.Dispose();
        _nextMove = null;
        var due = _motion.NextMoveIn(now);
        if (due is { } wait) _nextMove = _clock.StartTimer(() => _ui.Post(Move), wait, Timeout.InfiniteTimeSpan);
    }

    public void Dispose()
    {
        _minuteTimer?.Dispose();
        _minuteTimer = null;
        _nextMove?.Dispose();
        _nextMove = null;
        _pump.Dispose();
        _behaviour.Dispose();
        _alerts.Arrived -= OnAlertArrived;
        _alerts.Changed -= Update;
    }
}
