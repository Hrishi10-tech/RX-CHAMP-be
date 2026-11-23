using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;

namespace RXVision.Agent.Icon;

/// <summary>The operating system's side of the icon's click area.</summary>
public interface IIconPointer
{
    /// <summary>Where the pointer is: true on the icon, false on the margin, null off the window (or not known here).</summary>
    bool? IsOnIcon();

    /// <summary>Whether the whole window lets clicks through to what is underneath.</summary>
    void SetPassThrough(bool passThrough);
}

/// <summary>
/// A window's click area cannot follow its pixels on either OS, and the shadow's soft pixels would
/// catch clicks anyway. So while the pointer is on the margin the whole window lets clicks through,
/// and a timer watches for it to leave: the window gets no pointer events meanwhile. The timer runs
/// only for that stretch. UI thread only.
/// </summary>
public sealed class IconClickThrough : IDisposable
{
    public static readonly TimeSpan WatchEvery = TimeSpan.FromMilliseconds(33);

    private readonly IIconPointer _pointer;
    private readonly IClock _clock;
    private readonly IUiDispatcher _ui;
    private IDisposable? _watch;

    public IconClickThrough(IIconPointer pointer, IClock clock, IUiDispatcher ui)
    {
        _pointer = pointer;
        _clock = clock;
        _ui = ui;
    }

    public bool IsPassingThrough => _watch is not null;

    /// <summary>The window saw the pointer on its margin.</summary>
    public void PointerOnMargin()
    {
        if (_watch is not null || _pointer.IsOnIcon() != false) return;
        _pointer.SetPassThrough(true);
        _watch = _clock.StartTimer(() => _ui.Post(Watch), WatchEvery, WatchEvery);
    }

    private void Watch()
    {
        if (_watch is null || _pointer.IsOnIcon() == false) return;
        Dispose();
        _pointer.SetPassThrough(false);
    }

    public void Dispose()
    {
        _watch?.Dispose();
        _watch = null;
    }
}
