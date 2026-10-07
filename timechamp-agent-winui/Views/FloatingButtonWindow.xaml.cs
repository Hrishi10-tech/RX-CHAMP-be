using System.IO;
using Microsoft.UI.Input;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Media.Imaging;
using TimeChampAgent.Helpers;
using TimeChampAgent.Services;
using Windows.Graphics;

namespace TimeChampAgent.Views;

/// <summary>
/// A small always-on-top round button parked against the right edge of the screen.
/// The tray icon lives behind Windows' overflow arrow, where people never find it,
/// so this is the visible way back into the agent: one click opens the dashboard,
/// another hides it.
///
/// The ring doubles as a status light — green while tracking, amber on a break or
/// in a meeting, grey once the day has ended — so it earns its place on screen
/// rather than just being a shortcut.
///
/// Deliberately has no close button: it exists because the tray icon is too easy
/// to lose, and a dismissable badge would end up just as lost. It can be dragged
/// anywhere on the desktop instead — including onto a second monitor — and it
/// remembers where it was left.
/// </summary>
public sealed partial class FloatingButtonWindow : Window
{
    /// <summary>Diameter of the round face in raw pixels at 100% scale; scaled
    /// per-monitor below. Matches the canvas the artwork is laid out on in XAML.</summary>
    private const int FaceDip = 60;

    /// <summary>Side of the whole window. Wider than the face by exactly the strip the
    /// unread badge needs along the top and right edges.</summary>
    private const int SizeDip = 68;

    /// <summary>Badge diameter, matching its box in XAML.</summary>
    private const int BadgeDip = 22;

    /// <summary>Gap from the right edge of the work area.</summary>
    private const int MarginDip = 12;

    /// <summary>Pointer travel past which a press counts as a drag, not a click.</summary>
    private const double DragThresholdPx = 4;

    private readonly OverlappedPresenter _presenter;
    private readonly Action _onClick;

    private bool _pressed;
    private bool _dragged;
    private PointInt32 _grabOffset;
    private double _scale = 1.0;
    private int _sizePx = SizeDip;
    private int _facePx = FaceDip;
    private int _badgePx = BadgeDip;
    private bool _clipReady;

    public FloatingButtonWindow(Action onClick, MenuFlyout menu)
    {
        InitializeComponent();
        _onClick = onClick;
        LoadFace();

        Title = "RX Vision";

        _presenter = (OverlappedPresenter)AppWindow.Presenter;
        _presenter.SetBorderAndTitleBar(false, false);
        _presenter.IsAlwaysOnTop = true;
        _presenter.IsResizable = false;
        _presenter.IsMaximizable = false;
        _presenter.IsMinimizable = false;

        // Keep it out of Alt+Tab and the taskbar — it is a badge, not a window.
        AppWindow.IsShownInSwitchers = false;

        Root.ContextFlyout = menu;
        Root.PointerPressed += OnPointerPressed;
        Root.PointerMoved += OnPointerMoved;
        Root.PointerReleased += OnPointerReleased;
        Root.PointerEntered += (_, _) => Hover.Opacity = 0.1;
        Root.PointerExited += (_, _) => Hover.Opacity = 0;
        ToolTipService.SetToolTip(Root, "RX Vision — click to open");

        Activated += OnFirstActivated;
    }

    /// <summary>Sizing and placement need the monitor's scale, which is only known
    /// once the window exists — hence on first activation rather than in the ctor.</summary>
    private void OnFirstActivated(object sender, WindowActivatedEventArgs args)
    {
        Activated -= OnFirstActivated;

        _scale = Native.ScaleFor(this);
        _sizePx = (int)Math.Round(SizeDip * _scale);

        // Must come before the clip: this is what actually gets the window down to
        // size (AppWindow.Resize alone is floored at SM_CXMINTRACK).
        Native.MakeBorderlessPopup(this, _sizePx);

        _facePx = (int)Math.Round(FaceDip * _scale);
        _badgePx = (int)Math.Round(BadgeDip * _scale);
        _clipReady = true;
        ApplyClip();

        var saved = BubblePosition.Load();
        if (saved is not null) MoveTo(saved.X, saved.Y);
        else MoveTo(DefaultPosition());
    }

    /// <summary>Right edge, vertically centred on the primary display — where it sits
    /// until the user drags it somewhere they prefer.</summary>
    private PointInt32 DefaultPosition()
    {
        var work = DisplayArea.Primary.WorkArea;
        var margin = (int)Math.Round(MarginDip * _scale);
        return new PointInt32(
            work.X + work.Width - _sizePx - margin,
            work.Y + (work.Height - _sizePx) / 2);
    }

    private void MoveTo(PointInt32 point) => MoveTo(point.X, point.Y);

    /// <summary>
    /// Moves the button anywhere on the desktop, kept inside the work area of whichever
    /// display it lands on — so it can be parked on a second monitor, but never dragged
    /// somewhere it can't be clicked, and never buried under the taskbar.
    /// </summary>
    private void MoveTo(int x, int y)
    {
        var target = new PointInt32(x, y);
        // Nearest, not Primary: a saved position on a monitor that has since been
        // unplugged would otherwise leave the button stranded off-screen.
        var area = DisplayArea.GetFromPoint(target, DisplayAreaFallback.Nearest)
                   ?? DisplayArea.Primary;
        var work = area.WorkArea;

        AppWindow.Move(new PointInt32(
            Math.Clamp(x, work.X, work.X + work.Width - _sizePx),
            Math.Clamp(y, work.Y, work.Y + work.Height - _sizePx)));
    }

    // ---- Status ------------------------------------------------------------

    /// <summary>
    /// Reflects tracking state on the face: untouched while working, washed amber on a
    /// break or in a meeting, and dimmed grey once the day has ended — so a glance tells
    /// the user whether anything is being recorded.
    /// </summary>
    public void SetStatus(BubbleStatus status)
    {
        var (hex, opacity) = status switch
        {
            BubbleStatus.Tracking => ("#00000000", 0.0),
            BubbleStatus.Paused => ("#F59E0B", 0.32),
            _ => ("#0B1220", 0.55),
        };
        StatusWash.Fill = UiUtil.Brush(hex);
        StatusWash.Opacity = opacity;
    }

    // ---- Unread messages ---------------------------------------------------

    /// <summary>What the badge is currently showing, so a repeat of the same count
    /// doesn't re-run the pulse and leave the button twitching every minute.</summary>
    private int _unread;

    /// <summary>
    /// Puts the unread count on the button, and draws attention to it when the count
    /// has gone up.
    ///
    /// The button is the one part of the agent that is always on screen, so it is the
    /// only place a message can be announced that the user is certain to see. Until
    /// this existed a manager's message reached a closed window and was never
    /// mentioned again.
    /// </summary>
    public void SetUnread(int count)
    {
        count = Math.Max(0, count);
        var rose = count > _unread;
        _unread = count;

        if (count == 0)
        {
            Badge.Visibility = Visibility.Collapsed;
            ApplyClip();
            return;
        }

        BadgeText.Text = count > 9 ? "9+" : count.ToString();
        Badge.Visibility = Visibility.Visible;
        ApplyClip();
        // The count is the part that matters. An animation that will not run must
        // never cost the user the badge, let alone the agent.
        if (rose) { try { Pulse(); } catch { } }
    }

    /// <summary>
    /// Cuts the window to the round face, plus the badge circle only while a badge is
    /// actually showing.
    ///
    /// The cut-out has to come and go with the badge. Leaving the badge circle in the
    /// region once the count hits zero leaves a hole with nothing drawn in it, and
    /// WinUI has no per-pixel transparency — so the hole came out as a small white
    /// dot stuck to the rim of the button after every message was read.
    /// </summary>
    private void ApplyClip()
    {
        if (!_clipReady) return;

        var faceTop = _sizePx - _facePx;
        if (Badge.Visibility == Visibility.Visible)
        {
            Native.ClipToCircleWithBadge(
                this,
                faceTopPx: faceTop,
                faceDiameterPx: _facePx,
                badgeLeftPx: _sizePx - _badgePx,
                badgeTopPx: 0,
                badgeDiameterPx: _badgePx);
        }
        else
        {
            Native.ClipToCircle(this, faceTop, _facePx);
        }
    }

    /// <summary>
    /// Two short beats on the badge when something new arrives.
    ///
    /// Deliberately the badge and not a ring around the button: the window is clipped
    /// to its circle, so anything that grew past the edge would be sliced off mid-beat
    /// rather than expanding.
    /// </summary>
    private void Pulse()
    {
        var story = new Storyboard();
        foreach (var property in new[] { "ScaleX", "ScaleY" })
        {
            // A transform's scale is a "dependent" animation — it runs on the UI thread
            // rather than the compositor, and XAML refuses to start one without this.
            var beat = new DoubleAnimationUsingKeyFrames
            {
                RepeatBehavior = new RepeatBehavior(2),
                EnableDependentAnimation = true,
            };
            beat.KeyFrames.Add(new EasingDoubleKeyFrame { KeyTime = TimeSpan.Zero, Value = 1.0 });
            beat.KeyFrames.Add(new EasingDoubleKeyFrame
            {
                KeyTime = TimeSpan.FromMilliseconds(220),
                Value = 1.35,
                EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
            });
            beat.KeyFrames.Add(new EasingDoubleKeyFrame
            {
                KeyTime = TimeSpan.FromMilliseconds(520),
                Value = 1.0,
                EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseIn },
            });
            Storyboard.SetTarget(beat, BadgeScale);
            Storyboard.SetTargetProperty(beat, property);
            story.Children.Add(beat);
        }
        story.Begin();
    }

    /// <summary>Loads the badge artwork sitting next to the exe. Deliberately a file
    /// URI: ms-appx:/// does not resolve reliably for an unpackaged app.</summary>
    private void LoadFace()
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "Assets", "agent-badge.png");
            if (File.Exists(path)) Face.Source = new BitmapImage(new Uri(path));
        }
        catch
        {
            // No art is survivable — the dark circle still works as a button.
        }
    }

    public void ShowBubble() => AppWindow.Show(activateWindow: false);

    public void HideBubble() => AppWindow.Hide();

    public bool IsVisible => AppWindow.IsVisible;

    // ---- Click vs drag -----------------------------------------------------

    private void OnPointerPressed(object sender, PointerRoutedEventArgs e)
    {
        // Left button only — a right-click belongs to the context menu.
        if (!e.GetCurrentPoint(Root).Properties.IsLeftButtonPressed) return;

        _pressed = true;
        _dragged = false;

        // Track the cursor in screen pixels, not window-relative DIPs: the window
        // moves under the pointer while dragging, which makes DIP deltas feed back
        // on themselves and the bubble judder.
        if (Native.TryGetCursorPos(out var cursor))
        {
            var pos = AppWindow.Position;
            _grabOffset = new PointInt32(cursor.X - pos.X, cursor.Y - pos.Y);
        }
        Root.CapturePointer(e.Pointer);
    }

    private void OnPointerMoved(object sender, PointerRoutedEventArgs e)
    {
        if (!_pressed || !Native.TryGetCursorPos(out var cursor)) return;

        var target = new PointInt32(cursor.X - _grabOffset.X, cursor.Y - _grabOffset.Y);
        if (!_dragged)
        {
            var moved = Math.Abs(target.Y - AppWindow.Position.Y)
                        + Math.Abs(target.X - AppWindow.Position.X);
            if (moved < DragThresholdPx) return;
            _dragged = true;
        }

        MoveTo(target.X, target.Y);
    }

    private void OnPointerReleased(object sender, PointerRoutedEventArgs e)
    {
        Root.ReleasePointerCapture(e.Pointer);
        if (!_pressed) return;
        _pressed = false;

        if (_dragged)
        {
            BubblePosition.Save(AppWindow.Position.X, AppWindow.Position.Y);
            return;
        }
        _onClick();
    }
}

/// <summary>What the ring is telling the user.</summary>
public enum BubbleStatus
{
    /// <summary>Working — activity and screenshots are being recorded.</summary>
    Tracking,

    /// <summary>On a break, at lunch, or in a meeting.</summary>
    Paused,

    /// <summary>Day ended or signed out — nothing is being recorded.</summary>
    Idle,
}
