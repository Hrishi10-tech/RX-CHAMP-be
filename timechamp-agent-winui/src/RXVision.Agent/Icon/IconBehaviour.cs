using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;

namespace RXVision.Agent.Icon;

/// <summary>
/// When the icon rests faded and when it comes back (AGENT.md section 2). All time comes from the
/// one clock, through one-shot timers, so nothing runs while nothing changes. "Faded" is this
/// code's word only: no person ever reads it. UI thread only.
/// </summary>
public sealed class IconBehaviour : IDisposable
{
    public const double FadedOpacity = 0.40;
    public const double FadedSaturation = 0.60;
    public static readonly TimeSpan QuietFor = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan HoverAfter = TimeSpan.FromSeconds(0.5);
    public static readonly TimeSpan ComesUpIn = TimeSpan.FromMilliseconds(150);
    public static readonly TimeSpan FadesIn = TimeSpan.FromMilliseconds(400);

    private readonly IClock _clock;
    private readonly IUiDispatcher _ui;
    private IDisposable? _quietTimer;
    private IDisposable? _hoverTimer;
    private IconStatus _status = IconStatus.NotStarted;
    private bool _holding;
    private bool _panelOpen;
    private bool _pointerOn;
    private Tween _fade = Tween.Still(0);

    public IconBehaviour(IClock clock, IUiDispatcher ui)
    {
        _clock = clock;
        _ui = ui;
    }

    /// <summary>The look may have changed: ask for <see cref="Step"/>.</summary>
    public event Action? Changed;

    /// <summary>The icon rests faded (whatever a hover is doing to it right now).</summary>
    public bool RestsFaded { get; private set; }

    /// <summary>A hover has run its half second: full colour, and the label shows.</summary>
    public bool Hovering { get; private set; }

    /// <summary>0 is full colour, 1 is the faded look.</summary>
    public double FadeAt(TimeSpan now) => _fade.At(now);
    public double OpacityAt(TimeSpan now) => 1 + (FadedOpacity - 1) * FadeAt(now);
    public double SaturationAt(TimeSpan now) => 1 + (FadedSaturation - 1) * FadeAt(now);
    public bool IsMoving(TimeSpan now) => !_fade.IsDone(now);

    private bool MayFade => _status is IconStatus.Working or IconStatus.Meeting && !_holding && !_panelOpen;

    public void SetStatus(IconStatus status)
    {
        if (status == _status) return;
        var couldFade = MayFade;
        _status = status;
        Reconsider(couldFade);
    }

    /// <summary>A "!" or "i" badge, or a message count, keeps it in full colour.</summary>
    public void SetHolding(bool holding)
    {
        if (holding == _holding) return;
        var couldFade = MayFade;
        _holding = holding;
        Reconsider(couldFade);
    }

    public void SetPanelOpen(bool open)
    {
        if (open == _panelOpen) return;
        var couldFade = MayFade;
        _panelOpen = open;
        Reconsider(couldFade);
    }

    /// <summary>A click, a drag, a status change by tap. Hover does not count. The 30 s start again.</summary>
    public void Interaction()
    {
        if (RestsFaded) Wake(ComesUpIn);
        RestsFaded = false;
        RestartQuiet();
        Changed?.Invoke();
    }

    /// <summary>The pointer came onto the circle.</summary>
    public void PointerOn()
    {
        if (_pointerOn) return;
        _pointerOn = true;
        _hoverTimer = _clock.StartTimer(() => _ui.Post(HoverRan), HoverAfter, Timeout.InfiniteTimeSpan);
    }

    /// <summary>The pointer left: sooner than the half second changes nothing; after it, back to rest at once.</summary>
    public void PointerOff()
    {
        if (!_pointerOn) return;
        _pointerOn = false;
        _hoverTimer?.Dispose();
        _hoverTimer = null;
        if (!Hovering) return;
        Hovering = false;
        if (RestsFaded) _fade = Tween.Still(1);
        Changed?.Invoke();
    }

    private void HoverRan()
    {
        _hoverTimer?.Dispose();
        _hoverTimer = null;
        if (!_pointerOn) return;
        Hovering = true;
        if (RestsFaded) Wake(ComesUpIn);
        Changed?.Invoke();
    }

    private void Reconsider(bool couldFade)
    {
        if (MayFade == couldFade) return;
        if (MayFade)
        {
            // The last reason to stay in full colour went: the 30 s start from now.
            RestartQuiet();
        }
        else
        {
            StopQuiet();
            if (RestsFaded) Wake(ComesUpIn);
            RestsFaded = false;
        }
        Changed?.Invoke();
    }

    private void RestartQuiet()
    {
        StopQuiet();
        if (MayFade) _quietTimer = _clock.StartTimer(() => _ui.Post(QuietRan), QuietFor, Timeout.InfiniteTimeSpan);
    }

    private void StopQuiet()
    {
        _quietTimer?.Dispose();
        _quietTimer = null;
    }

    private void QuietRan()
    {
        StopQuiet();
        if (!MayFade) return;
        RestsFaded = true;
        if (!Hovering) GoTo(1, FadesIn, Easing.Out);
        Changed?.Invoke();
    }

    private void Wake(TimeSpan length) => GoTo(0, length, Easing.Out);

    private void GoTo(double fade, TimeSpan length, Func<double, double> ease)
    {
        var now = _clock.Monotonic;
        _fade = new Tween(FadeAt(now), fade, now, length, ease);
    }

    public void Dispose()
    {
        StopQuiet();
        _hoverTimer?.Dispose();
        _hoverTimer = null;
    }
}
