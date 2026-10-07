using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using TimeChampAgent.Helpers;
using Windows.Graphics;

namespace TimeChampAgent.Views;

/// <summary>
/// The card that announces a message, parked beside the floating button.
///
/// Windows' own toast notifications were the obvious thing to reach for and are the
/// wrong tool here: the user can switch them off per-app in Settings, Focus Assist
/// suppresses them, and an unpackaged WinUI app has to be registered specially
/// before it may raise one at all. A manager's message is not an advert, and it must
/// not be something the operating system can quietly silence — so the agent draws
/// its own card, next to the button that carries the matching badge, where the eye
/// is already going to look.
///
/// It never takes focus (<see cref="Native.MakeBorderlessPopup"/> with
/// WS_EX_NOACTIVATE) and it hides itself after <see cref="VisibleFor"/>. The badge on
/// the button is what persists; this is only the thing that catches the eye.
/// </summary>
public sealed partial class MessageToastWindow : Window
{
    private const int WidthDip = 300;
    private const int HeightDip = 150;

    /// <summary>How long the card stays up. Long enough to read two lines without
    /// hurrying, short enough that it is never in the way of the work underneath.</summary>
    private static readonly TimeSpan VisibleFor = TimeSpan.FromSeconds(8);

    private readonly Action _onView;
    private readonly DispatcherQueueTimer _hideTimer;

    private double _scale = 1.0;
    private int _widthPx = WidthDip;
    private int _heightPx = HeightDip;
    private bool _laidOut;

    public MessageToastWindow(Action onView)
    {
        InitializeComponent();
        _onView = onView;

        Title = "RX Vision message";

        var presenter = (OverlappedPresenter)AppWindow.Presenter;
        presenter.SetBorderAndTitleBar(false, false);
        presenter.IsAlwaysOnTop = true;
        presenter.IsResizable = false;
        presenter.IsMaximizable = false;
        presenter.IsMinimizable = false;
        AppWindow.IsShownInSwitchers = false;

        _hideTimer = DispatcherQueue.CreateTimer();
        _hideTimer.Interval = VisibleFor;
        _hideTimer.IsRepeating = false;
        _hideTimer.Tick += (_, _) => Dismiss();

        // A WinUI window only builds its content once it has been activated, and one
        // shown without ever activating comes up as an empty frame. So it is activated
        // here, parked beyond the edge of every monitor where nobody can see it, and
        // put away again the moment it is ready — by which time the card is drawn and
        // the first real message can simply place it and show it. Created alongside
        // the floating button, long before any message arrives.
        Activated += OnFirstActivated;
        AppWindow.Move(new PointInt32(-32000, -32000));
        Activate();
    }

    private void OnFirstActivated(object sender, WindowActivatedEventArgs args)
    {
        Activated -= OnFirstActivated;
        EnsureLaidOut();
        AppWindow.Hide();
    }

    /// <summary>Scale is only knowable once the window exists, and the window is
    /// created before it is ever shown — so this runs on whichever comes first.</summary>
    private void EnsureLaidOut()
    {
        if (_laidOut) return;
        _laidOut = true;

        _scale = Native.ScaleFor(this);
        _widthPx = (int)Math.Round(WidthDip * _scale);
        _heightPx = (int)Math.Round(HeightDip * _scale);
        Native.MakeBorderlessPopup(this, _widthPx, _heightPx, noActivate: true);
    }

    /// <summary>
    /// Fills the card in and puts it on screen under the floating button, counting
    /// down to its own dismissal.
    ///
    /// <paramref name="anchor"/> is where the button sits; the card tucks under its
    /// left side, or above it when the button is parked low enough that there is no
    /// room below. Either way it stays inside the work area of the display it lands
    /// on, so a button dragged to a second monitor keeps its card beside it.
    /// </summary>
    public void Show(string sender, string body, DateTime localTime, int unread, PointInt32 anchor, int anchorSizePx)
    {
        EnsureLaidOut();

        Sender.Text = sender;
        Initials.Text = InitialOf(sender);
        Stamp.Text = localTime.ToString("hh:mm tt");
        // One card for a burst, never a stack: three cards for three messages is three
        // interruptions for one piece of news.
        Preview.Text = unread > 1 ? $"{unread} new messages · {body}" : body;

        Place(anchor, anchorSizePx);
        // AppWindow's own "show without activating" — the floating button is put on
        // screen the same way. Reaching past WinUI to ShowWindow() instead crashed the
        // XAML runtime outright, which is a thing worth not doing twice.
        AppWindow.Show(activateWindow: false);

        _hideTimer.Stop();
        _hideTimer.Start();
    }

    private void Place(PointInt32 anchor, int anchorSizePx)
    {
        var gap = (int)Math.Round(10 * _scale);
        var area = DisplayArea.GetFromPoint(anchor, DisplayAreaFallback.Nearest) ?? DisplayArea.Primary;
        var work = area.WorkArea;

        // Under the button by preference; above it when the bottom of the screen is
        // closer than the card is tall.
        var y = anchor.Y + anchorSizePx + gap;
        if (y + _heightPx > work.Y + work.Height) y = anchor.Y - _heightPx - gap;

        // Right-aligned with the button, which is usually parked against the right
        // edge — so the card opens inwards rather than off the screen.
        var x = anchor.X + anchorSizePx - _widthPx;

        AppWindow.Move(new PointInt32(
            Math.Clamp(x, work.X, Math.Max(work.X, work.X + work.Width - _widthPx)),
            Math.Clamp(y, work.Y, Math.Max(work.Y, work.Y + work.Height - _heightPx))));
    }

    public void Dismiss()
    {
        _hideTimer.Stop();
        AppWindow.Hide();
    }

    private void OnCloseClick(object sender, RoutedEventArgs e) => Dismiss();

    private void OnViewClick(object sender, RoutedEventArgs e)
    {
        Dismiss();
        _onView();
    }

    private static string InitialOf(string name)
    {
        var trimmed = name?.Trim();
        return string.IsNullOrEmpty(trimmed) ? "?" : trimmed[..1].ToUpperInvariant();
    }
}
