using System.ComponentModel;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Platform;
using Avalonia.Threading;
using RXVision.Agent.Icon;
using RXVision.Agent.Interop;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Views;

/// <summary>
/// The floating icon's window: 72 px at 1x, per-pixel alpha, always on top, never takes focus,
/// click to open or hide the panel, drag to move (remembered per screen), right-click for the menu.
/// Clicks land only on the bezel circle and the badge; the margin passes them through. The 56 px
/// box keeps its place on screen.
/// </summary>
public partial class BubbleWindow : Window
{
    private const double DragThreshold = 4;
    private static readonly Size Canvas = new(IconGeometry.Canvas, IconGeometry.Canvas);

    private readonly HoverLabelWindow _label = new();
    private BubblePlacement? _placement;
    private BubbleViewModel? _vm;
    private IconClickThrough? _clickThrough;
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
        IconView.PointerEntered += (_, _) => _vm?.PointerOn();
        IconView.PointerExited += (_, _) => { if (!_pressed) _vm?.PointerOff(); };
        BubbleMenu.Opening += (_, _) => Activate();
        Opened += (_, _) => OnOpened();
        Closed += (_, _) => OnClosedWindow();
        ScalingChanged += (_, _) => Place();
        PointerMoved += OnWindowPointerMoved;
        DataContextChanged += (_, _) => Attach(DataContext as BubbleViewModel);
    }

    /// <summary>A click (not a drag) on the icon.</summary>
    public event Action? Clicked;

    /// <summary>The icon was dragged to a new place (and the place saved).</summary>
    public event Action? DragEnded;

    /// <summary>The icon's centre on screen, in physical pixels.</summary>
    public PixelPoint Anchor => _anchor;

    /// <summary>The icon's view, for the tests.</summary>
    internal FloatingIconView View => IconView;

    /// <summary>The label's window, for the tests.</summary>
    internal HoverLabelWindow LabelWindow => _label;

    /// <summary>
    /// The window's area on screen in physical pixels (the toast goes beside it, never over it).
    /// Worked out the way <see cref="Place"/> places it, so it is right before the OS has moved it.
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

    private void OnClosedWindow()
    {
        _clickThrough?.Dispose();
        _clickThrough = null;
        _label.Close();
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property != IsVisibleProperty || change.GetNewValue<bool>()) return;
        // Hidden with the pointer on it (a full-screen app came up): nothing is left behind.
        _vm?.PointerOff();
        _label.Hide();
    }

    /// <summary>Shows the icon where it was left, without taking focus.</summary>
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
        IconView.Attach(vm);
        if (_vm is not null)
        {
            _vm.PropertyChanged += OnVmChanged;
            _clickThrough ??= new IconClickThrough(new NativeIconPointer(this), _vm.Clock, new AvaloniaDispatcher());
        }
        Place();
    }

    private void OnVmChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (_vm is null) return;
        switch (e.PropertyName)
        {
            case nameof(BubbleViewModel.IsLabelVisible):
                if (_vm.IsLabelVisible) ShowLabel();
                else _label.Hide();
                break;
            case nameof(BubbleViewModel.Label):
                _label.SetText(_vm.Label);
                if (_vm.IsLabelVisible) ShowLabel();
                break;
        }
    }

    private void ShowLabel()
    {
        if (_vm is null) return;
        _label.SetText(_vm.Label);
        var scale = DesktopScaling;
        var (position, _) = Layout();
        var margin = (int)Math.Round(IconGeometry.Margin * scale);
        var side = (int)Math.Round(IconGeometry.Box * scale);
        var box = new PixelRect(position.X + margin, position.Y + margin, side, side);
        var area = BubblePlacement.ScreenFor(_anchor, Screens.All)?.WorkingArea ?? box;
        _label.ShowNear(box, area, scale);
    }

    /// <summary>Sizes the window for this scale and puts the icon on its anchor, inside the screen.</summary>
    private void Place()
    {
        Width = Canvas.Width;
        Height = Canvas.Height;
        if (!_placed) return;
        Position = Layout().Position;
        if (_vm?.IsLabelVisible == true) ShowLabel();
    }

    private (PixelPoint Position, PixelSize Size) Layout()
    {
        var scale = DesktopScaling;
        var pixels = new PixelSize((int)Math.Ceiling(Canvas.Width * scale), (int)Math.Ceiling(Canvas.Height * scale));
        return (BubblePlacement.WindowPosition(_anchor, pixels, CentreInWindow(scale), Screens.All), pixels);
    }

    private static PixelPoint CentreInWindow(double scale)
    {
        var centre = (int)Math.Round(Canvas.Width / 2 * scale);
        return new PixelPoint(centre, centre);
    }

    /// <summary>The pointer on the window but off the icon: hand the margin's clicks to what is underneath.</summary>
    private void OnWindowPointerMoved(object? sender, PointerEventArgs e)
    {
        if (_pressed || _clickThrough is null || _vm is null) return;
        if (!IconGeometry.IsOnIcon(e.GetPosition(this), _vm.HasBadge)) _clickThrough.PointerOnMargin();
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
        _vm?.Interaction();
        if (!wasDrag && e.InitialPressMouseButton == MouseButton.Left) Clicked?.Invoke();
    }

    /// <summary>The OS took the pointer away mid-drag: keep the icon where it got to.</summary>
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

    /// <summary>After a drag, the anchor follows the clamped icon so it is saved where it is drawn.</summary>
    private void KeepAnchorOnScreen()
    {
        var centre = CentreInWindow(DesktopScaling);
        var position = Position;
        _anchor = new PixelPoint(position.X + centre.X, position.Y + centre.Y);
    }

    /// <summary>The native side of <see cref="IconClickThrough"/> for this window.</summary>
    private sealed class NativeIconPointer : IIconPointer
    {
        private readonly BubbleWindow _window;

        public NativeIconPointer(BubbleWindow window) => _window = window;

        public bool? IsOnIcon()
        {
            if (NativeWindow.CursorPosition(_window) is not { } cursor) return null;
            var scale = _window.DesktopScaling;
            var position = _window.Position;
            var onCanvas = new Point((cursor.X - position.X) / scale, (cursor.Y - position.Y) / scale);
            var inWindow = onCanvas.X >= 0 && onCanvas.Y >= 0 && onCanvas.X < Canvas.Width && onCanvas.Y < Canvas.Height;
            if (!inWindow) return null;
            return IconGeometry.IsOnIcon(onCanvas, _window._vm?.HasBadge == true);
        }

        public void SetPassThrough(bool passThrough) => NativeWindow.SetClickThrough(_window, passThrough);
    }
}
