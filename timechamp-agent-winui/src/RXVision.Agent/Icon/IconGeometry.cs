using Avalonia;

namespace RXVision.Agent.Icon;

/// <summary>
/// The floating icon's numbers at its real size (AGENT.md section 1, measured from the design's
/// vector data). Device-independent pixels, origin at the top left of the 56 px box, centre 28, 28.
/// Angles run clockwise from 12 o'clock. Everything scales from here, so every display scale draws
/// the same icon as vectors at device pixels.
/// </summary>
public static class IconGeometry
{
    public const double Box = 56;
    /// <summary>Round the box, for the shadow and the shake.</summary>
    public const double Margin = 8;
    public const double Canvas = Box + 2 * Margin;
    public const double Centre = Box / 2;

    public const double ShadowRadius = 28;
    public const double ShadowOffset = 2.4;
    public const double ShadowOpacity = 0.42;
    public const double ShadowSigma = 1.6;

    public const double BezelRadius = 27.35;
    public const double BezelHighlightRadius = 27.02;
    public const double BezelHighlightStroke = 0.33;
    public const double BezelHighlightOpacity = 0.13;

    public const double WellRadius = 22.68;
    public const double WellOpacity = 0.13;
    public const double WellEdgeStroke = 0.51;
    public const double WellEdgeOpacity = 0.5;

    public const double AvatarDiameter = 42;
    public const double AvatarRadius = AvatarDiameter / 2;
    public const double AvatarEdgeStroke = 0.42;
    public const double AvatarEdgeOpacity = 0.35;

    public const double RingRadius = 25;
    public const double RingStroke = 2;
    public const double TrackOpacity = 0.09;
    /// <summary>Clockwise from 12 o'clock: the bottom right, where the status dot sits.</summary>
    public const double RingStartDegrees = 135;
    /// <summary>Clockwise from 12 o'clock: the top right, where the badge sits.</summary>
    public const double BadgeDegrees = 45;

    public const double DotDiameter = 7;
    public const double DotEdge = 1;
    public const double HollowDotStroke = 1;

    public const double BadgeDiameter = 12;
    public const double BadgeEdge = 1;
    public const double BadgePillWidth = 15;
    public const double BadgeGlyphSize = 7.5;
    /// <summary>A capital's height in Inter, in ems: the glyph sits on its baseline, half of this below the middle.</summary>
    public const double GlyphCapHeight = 0.727;

    /// <summary>A point on the ring's path.</summary>
    public static Point OnRing(double degrees)
    {
        var radians = degrees * Math.PI / 180;
        return new Point(Centre + RingRadius * Math.Sin(radians), Centre - RingRadius * Math.Cos(radians));
    }

    /// <summary>The status dot's centre at this scale, snapped so a circle of a whole pixel size stays symmetric.</summary>
    public static Point DotCentre(double scale) => Snap(OnRing(RingStartDegrees), DotDiameter * scale, scale);

    /// <summary>The badge's centre at this scale, snapped the same way.</summary>
    public static Point BadgeCentre(double scale) => Snap(OnRing(BadgeDegrees), BadgeDiameter * scale, scale);

    /// <summary>Odd diameter on x.5, even diameter on a whole number, in device pixels; any other size stays where it is.</summary>
    private static Point Snap(Point centre, double deviceDiameter, double scale)
    {
        var whole = Math.Round(deviceDiameter);
        if (Math.Abs(deviceDiameter - whole) > 0.001) return centre;
        double Fit(double value)
        {
            var device = value * scale;
            var snapped = (long)whole % 2 == 0 ? Math.Round(device, MidpointRounding.AwayFromZero) : Math.Floor(device) + 0.5;
            return snapped / scale;
        }
        return new Point(Fit(centre.X), Fit(centre.Y));
    }

    /// <summary>The bitmap's size in device pixels: the canvas at this scale, on whole pixels.</summary>
    public static PixelSize CanvasPixels(double scale)
    {
        var side = (int)Math.Ceiling(Canvas * scale - 0.001);
        return new PixelSize(side, side);
    }

    /// <summary>
    /// Whether a point on the canvas lands on the icon: the bezel circle, or the badge while one
    /// shows. The margin and the shadow pass clicks through.
    /// </summary>
    public static bool IsOnIcon(Point onCanvas, bool hasBadge)
    {
        var x = onCanvas.X - Margin;
        var y = onCanvas.Y - Margin;
        if (Distance(x, y, Centre, Centre) <= Box / 2) return true;
        if (!hasBadge) return false;
        var badge = OnRing(BadgeDegrees);
        return Distance(x, y, badge.X, badge.Y) <= BadgeDiameter / 2 + BadgeEdge;
    }

    private static double Distance(double x1, double y1, double x2, double y2) =>
        Math.Sqrt((x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2));
}
