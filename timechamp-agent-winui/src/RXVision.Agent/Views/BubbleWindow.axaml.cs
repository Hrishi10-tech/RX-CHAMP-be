using System.ComponentModel;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Media;
using Avalonia.Platform;
using Avalonia.Threading;
using RXVision.Agent.Interop;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Views;

/// <summary>
/// The round button near the right edge: always on top, never takes focus,
/// click to open or hide the dashboard, drag to move (remembered per screen),
/// right-click for the menu. It grows a little while a break is due, to fit the
/// "Morning break due" label under the face; the face itself never moves.
/// </summary>
public partial class BubbleWindow : Window
{
    /// <summary>Face centre inside the window, in DIPs (the face area is 88x88 at the top, centred).</summary>
    private const double FaceTop = 44;
    private static readonly Size Compact = new(88, 88);
    private static readonly Size Expanded = new(140, 116);
    private const double DragThreshold = 4;

    private BubblePlacement? _placement;
    private BubbleViewModel? _vm;
    private PixelPoint _anchor;
    private bool _placed;
    private bool _pressed;
    private bool _dragging;
    private PixelPoint _pressPointer;
    private PixelPoint _pressAnchor;

    public BubbleWindow()
    {
        InitializeComponent();
        TransparencyLevelHint = new[] { WindowTransparencyLevel.Transparent };
        Root.PointerPressed += OnPointerPressed;
        Root.PointerMoved += OnPointerMoved;
        Root.PointerReleased += OnPointerReleased;
        Root.PointerCaptureLost += (_, _) => OnCaptureLost();
        BubbleMenu.Opening += (_, _) => Activate();
        Opened += (_, _) => OnOpened();
        DataContextChanged += (_, _) => Attach(DataContext as BubbleViewModel);
    }

    /// <summary>A click (not a drag) on the button.</summary>
    public event Action? Clicked;

    /// <summary>The button was dragged to a new place (and the place saved).</summary>
    public event Action? DragEnded;

    /// <summary>The face's centre on screen, in physical pixels.</summary>
    public PixelPoint Anchor => _anchor;

    /// <summary>
    /// The window's area on screen in physical pixels, for its current size (the
    /// toast goes beside it, never over it). Worked out the way <see cref="Place"/>
    /// places it, so it is right even before the OS has applied a resize.
    /// </summary>
    public PixelRect Footprint
    {
        get
        {
            var (position, size) = Layout();
            return new PixelRect(position, size);
        }
    }

    public void UsePlacement(BubblePlacement placement) => _placement = placement;

    private void OnOpened()
    {
        NativeWindow.MakeNonActivating(this);
        if (ActualTransparencyLevel == WindowTransparencyLevel.None)
        {
            // No compositor (some Linux desktops): a soft square beats a black one.
            Background = new SolidColorBrush(Color.Parse("#EEF0FB"));
        }
        if (!_placed)
        {
            _placed = true;
            _anchor = _placement?.Load(Screens.All, Screens.Primary) ?? BubblePlacement.Default(Screens.Primary);
            Screens.Changed += (_, _) => Place();
        }
        Place();
        // The first resize from the OS can land after Opened: place again once it has.
        Dispatcher.UIThread.Post(Place, DispatcherPriority.Background);
    }

    /// <summary>Shows the button where it was left, without taking focus.</summary>
    public void ShowQuietly()
    {
        if (IsVisible) return;
        Show();
        NativeWindow.MakeNonActivating(this);
        Place();
    }

    private void Attach(BubbleViewModel? vm)
    {
        if (_vm is not null) _vm.PropertyChanged -= OnVmChanged;
        _vm = vm;
        if (_vm is not null) _vm.PropertyChanged += OnVmChanged;
        Place();
    }

    private void OnVmChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(BubbleViewModel.HasRingLabel)) Place();
    }

    /// <summary>Sizes the window for the current mode and puts the face on its anchor, inside the screen.</summary>
    private void Place()
    {
        var size = _vm?.HasRingLabel == true ? Expanded : Compact;
        Width = size.Width;
        Height = size.Height;
        if (!_placed) return;
        Position = Layout().Position;
    }

    private (PixelPoint Position, PixelSize Size) Layout()
    {
        var size = _vm?.HasRingLabel == true ? Expanded : Compact;
        var scale = DesktopScaling;
        var pixels = new PixelSize((int)Math.Ceiling(size.Width * scale), (int)Math.Ceiling(size.Height * scale));
        var faceInWindow = new PixelPoint((int)Math.Round(size.Width / 2 * scale), (int)Math.Round(FaceTop * scale));
        return (BubblePlacement.WindowPosition(_anchor, pixels, faceInWindow, Screens.All), pixels);
    }

    private void OnPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        var point = e.GetCurrentPoint(Root);
        if (!point.Properties.IsLeftButtonPressed) return;
        _pressed = true;
        _dragging = false;
        _pressPointer = this.PointToScreen(e.GetPosition(this));
        _pressAnchor = _anchor;
        e.Pointer.Capture(Root);
        e.Handled = true;
    }

    private void OnPointerMoved(object? sender, PointerEventArgs e)
    {
        if (!_pressed) return;
        var now = this.PointToScreen(e.GetPosition(this));
        var dx = now.X - _pressPointer.X;
        var dy = now.Y - _pressPointer.Y;
        if (!_dragging)
        {
            var threshold = DragThreshold * DesktopScaling;
            if (Math.Abs(dx) + Math.Abs(dy) < threshold) return;
            _dragging = true;
        }
        _anchor = new PixelPoint(_pressAnchor.X + dx, _pressAnchor.Y + dy);
        Place();
    }

    private void OnPointerReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (!_pressed) return;
        _pressed = false;
        // Decide before letting go of the pointer: releasing the capture raises
        // PointerCaptureLost straight away.
        var wasDrag = _dragging;
        if (wasDrag) EndDrag();
        e.Pointer.Capture(null);
        if (!wasDrag && e.InitialPressMouseButton == MouseButton.Left) Clicked?.Invoke();
    }

    /// <summary>The OS took the pointer away mid-drag: keep the button where it got to.</summary>
    private void OnCaptureLost()
    {
        if (_dragging) EndDrag();
        _pressed = false;
    }

    private void EndDrag()
    {
        _dragging = false;
        KeepAnchorOnScreen();
        var screen = BubblePlacement.ScreenFor(_anchor, Screens.All);
        if (screen is not null) _placement?.Save(screen, _anchor);
        DragEnded?.Invoke();
    }

    /// <summary>After a drag, the anchor follows the clamped face so it is saved where it is drawn.</summary>
    private void KeepAnchorOnScreen()
    {
        var scale = DesktopScaling;
        var size = _vm?.HasRingLabel == true ? Expanded : Compact;
        var faceInWindow = new PixelPoint((int)Math.Round(size.Width / 2 * scale), (int)Math.Round(FaceTop * scale));
        var position = Position;
        _anchor = new PixelPoint(position.X + faceInWindow.X, position.Y + faceInWindow.Y);
    }
}
