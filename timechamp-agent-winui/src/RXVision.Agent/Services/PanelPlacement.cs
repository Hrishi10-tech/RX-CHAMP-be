using Avalonia;

namespace RXVision.Agent.Services;

/// <summary>
/// Where the panel opens: to the left of the icon with a 16 px gap, bottoms aligned; to the
/// right when there is no room; always inside the work area (AGENT.md section 4). In physical
/// pixels, from the icon's centre.
/// </summary>
public static class PanelPlacement
{
    public const int Width = 340;
    public const int Height = 540;
    private const double Gap = 16;
    /// <summary>Half of the icon's 56 px box.</summary>
    private const double IconHalf = 28;

    public static PixelPoint Place(PixelPoint iconCentre, PixelRect workArea, double scale)
    {
        var width = (int)Math.Round(Width * scale);
        var height = (int)Math.Round(Height * scale);
        var reach = (int)Math.Round((IconHalf + Gap) * scale);
        var x = iconCentre.X - reach - width;
        if (x < workArea.X) x = iconCentre.X + reach;
        x = Math.Clamp(x, workArea.X, Math.Max(workArea.X, workArea.Right - width));
        var y = iconCentre.Y + (int)Math.Round(IconHalf * scale) - height;
        y = Math.Clamp(y, workArea.Y, Math.Max(workArea.Y, workArea.Bottom - height));
        return new PixelPoint(x, y);
    }
}
