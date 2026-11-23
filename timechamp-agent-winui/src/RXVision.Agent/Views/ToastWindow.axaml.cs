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
/// The card that slides in beside the floating button: never takes focus, a
/// click anywhere on it opens the dashboard, and it sits to the left of the
/// button (or to the right when the button is parked on the left).
/// </summary>
public partial class ToastWindow : Window
{
    /// <summary>The clear margin around the card (for its shadow), in DIPs.</summary>
    private const double CardMargin = 12;
    /// <summary>Space between the card and the button's window, in DIPs.</summary>
    private const double Gap = 4;
    private PixelRect _avoid;
    private PixelPoint _centre;

    public ToastWindow()
    {
        InitializeComponent();
        TransparencyLevelHint = new[] { WindowTransparencyLevel.Transparent };
        Card.PointerReleased += OnCardReleased;
        Card.PointerEntered += (_, _) => HoverChanged?.Invoke(true);
        Card.PointerExited += (_, _) => HoverChanged?.Invoke(false);
        Opened += (_, _) =>
        {
            NativeWindow.MakeNonActivating(this);
            if (ActualTransparencyLevel == WindowTransparencyLevel.None) Background = new SolidColorBrush(Color.Parse("#1A2029"));
        };
        SizeChanged += (_, _) => { if (IsVisible) Place(); };
    }

    /// <summary>Slide in (off for screenshots in tests).</summary>
    public bool Animate { get; set; } = true;

    public event Action<bool>? HoverChanged;

    /// <summary>
    /// Shows the toast (its DataContext) beside the button: <paramref name="avoid"/>
    /// is the button's window (the card never covers it), <paramref name="centre"/>
    /// the face's centre, which the card lines up with. Physical pixels.
    /// </summary>
    public void ShowBeside(PixelRect avoid, PixelPoint centre)
    {
        _avoid = avoid;
        _centre = centre;
        Card.Classes.Set("animate", Animate);
        Card.Classes.Remove("shown");
        Place();
        if (!IsVisible) Show();
        NativeWindow.MakeNonActivating(this);
        Place();
        if (Animate) Dispatcher.UIThread.Post(() => Card.Classes.Add("shown"), DispatcherPriority.Background);
        else Card.Classes.Add("shown");
    }

    /// <summary>The button moved: follow it, without sliding in again.</summary>
    public void MoveBeside(PixelRect avoid, PixelPoint centre)
    {
        _avoid = avoid;
        _centre = centre;
        if (IsVisible) Place();
    }

    private void Place()
    {
        var screen = BubblePlacement.ScreenFor(_centre, Screens.All);
        var scale = screen?.Scaling ?? DesktopScaling;
        Card.Measure(new Size(Width, double.PositiveInfinity));
        var height = Math.Max(Bounds.Height, Card.DesiredSize.Height);
        var size = new PixelSize((int)Math.Ceiling(Width * scale), (int)Math.Ceiling(height * scale));
        // The card's own clear margin may sit over the button window's edge; the card itself never does.
        var inset = (int)Math.Round((CardMargin - Gap) * scale);

        var x = _avoid.X - size.Width + inset;
        var y = _centre.Y - size.Height / 2;
        if (screen is not null)
        {
            var area = screen.WorkingArea;
            if (x < area.X) x = _avoid.Right - inset;
            x = Math.Clamp(x, area.X, Math.Max(area.X, area.Right - size.Width));
            y = Math.Clamp(y, area.Y, Math.Max(area.Y, area.Bottom - size.Height));
        }
        Position = new PixelPoint(x, y);
    }

    private void OnCardReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (e.InitialPressMouseButton != MouseButton.Left) return;
        if (DataContext is ToastViewModel toast) toast.OpenCommand.Execute(null);
    }
}
