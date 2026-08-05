using Microsoft.UI;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace TimeChampAgent.Helpers;

/// <summary>Small colour helpers shared by the view-models.</summary>
public static class UiUtil
{
    /// <summary>Parse a hex colour like <c>#RRGGBB</c> or <c>#AARRGGBB</c>.</summary>
    public static Color ColorFromHex(string hex)
    {
        hex = hex.TrimStart('#');
        byte a = 0xFF, r, g, b;
        if (hex.Length == 8)
        {
            a = Convert.ToByte(hex.Substring(0, 2), 16);
            r = Convert.ToByte(hex.Substring(2, 2), 16);
            g = Convert.ToByte(hex.Substring(4, 2), 16);
            b = Convert.ToByte(hex.Substring(6, 2), 16);
        }
        else
        {
            r = Convert.ToByte(hex.Substring(0, 2), 16);
            g = Convert.ToByte(hex.Substring(2, 2), 16);
            b = Convert.ToByte(hex.Substring(4, 2), 16);
        }
        return Color.FromArgb(a, r, g, b);
    }

    public static SolidColorBrush Brush(string hex) => new(ColorFromHex(hex));

    /// <summary>Linearly interpolate between two hex colours (t in 0..1).</summary>
    public static Color Lerp(string fromHex, string toHex, double t)
    {
        t = Math.Max(0, Math.Min(1, t));
        var a = ColorFromHex(fromHex);
        var b = ColorFromHex(toHex);
        return Color.FromArgb(255,
            (byte)(a.R + (b.R - a.R) * t),
            (byte)(a.G + (b.G - a.G) * t),
            (byte)(a.B + (b.B - a.B) * t));
    }
}
