using Avalonia;

namespace RXVision.Agent.Services;

/// <summary>
/// Where the avatar picker goes, the panel's anchor: to the left of the floating icon with a
/// 16 px gap, bottoms aligned; to the right when there is no room; always inside the work area
/// (AGENT.md sections 4 and 7).
/// </summary>
public static class PickerPlacement
{
    public const double Gap = 16;
    /// <summary>The icon's box, in DIPs at 100%.</summary>
    public const double IconBox = 56;

    /// <param name="iconCentre">The icon's centre on screen, in physical pixels.</param>
    /// <param name="panel">The window's size in physical pixels.</param>
    public static PixelPoint Beside(PixelPoint iconCentre, double scale, PixelSize panel, PixelRect workArea)
    {
        var half = (int)Math.Round(IconBox / 2 * scale);
        var gap = (int)Math.Round(Gap * scale);
        var iconLeft = iconCentre.X - half;
        var iconRight = iconCentre.X + half;
        var iconBottom = iconCentre.Y + half;
        var x = iconLeft - gap - panel.Width;
        if (x < workArea.X) x = iconRight + gap;
        x = Math.Clamp(x, workArea.X, Math.Max(workArea.X, workArea.Right - panel.Width));
        var y = Math.Clamp(iconBottom - panel.Height, workArea.Y, Math.Max(workArea.Y, workArea.Bottom - panel.Height));
        return new PixelPoint(x, y);
    }
}
