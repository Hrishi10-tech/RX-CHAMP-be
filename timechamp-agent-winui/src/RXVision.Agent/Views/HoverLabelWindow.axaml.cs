using Avalonia;
using Avalonia.Controls;
using Avalonia.Platform;
using RXVision.Agent.Interop;

namespace RXVision.Agent.Views;

/// <summary>
/// The pill with today's time, above the icon: its own window that never takes focus, not a system
/// tooltip (AGENT.md section 2). Below the icon when there is no room above; always inside the work
/// area.
/// </summary>
public partial class HoverLabelWindow : Window
{
    /// <summary>Between the icon and the pill, in device-independent pixels.</summary>
    public const double Gap = 10;

    public HoverLabelWindow()
    {
        InitializeComponent();
        TransparencyLevelHint = new[] { WindowTransparencyLevel.Transparent };
    }

    /// <summary>What the pill says now.</summary>
    public string? LabelText => Text.Text;

    public void SetText(string text) => Text.Text = text;

    /// <param name="box">The icon's 56 px box on screen, in physical pixels.</param>
    /// <param name="area">The work area of the icon's screen.</param>
    public void ShowNear(PixelRect box, PixelRect area, double scale)
    {
        if (!IsVisible)
        {
            Show();
            NativeWindow.MakeNonActivating(this);
        }
        Position = Spot(box, area, MeasuredPixels(scale), scale);
    }

    private PixelSize MeasuredPixels(double scale)
    {
        Pill.Measure(Size.Infinity);
        return new PixelSize((int)Math.Ceiling(Pill.DesiredSize.Width * scale), (int)Math.Ceiling(Pill.DesiredSize.Height * scale));
    }

    /// <summary>Centred on the icon, 10 px above it; below it when there is no room; always inside the work area.</summary>
    public static PixelPoint Spot(PixelRect box, PixelRect area, PixelSize label, double scale)
    {
        var gap = (int)Math.Round(Gap * scale);
        var x = box.X + (box.Width - label.Width) / 2;
        var above = box.Y - gap - label.Height;
        var y = above >= area.Y ? above : box.Bottom + gap;
        return new PixelPoint(
            Math.Clamp(x, area.X, Math.Max(area.X, area.Right - label.Width)),
            Math.Clamp(y, area.Y, Math.Max(area.Y, area.Bottom - label.Height)));
    }
}
