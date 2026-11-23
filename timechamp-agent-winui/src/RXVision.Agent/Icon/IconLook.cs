using Avalonia.Media;

namespace RXVision.Agent.Icon;

/// <summary>What the icon says about the day: the five statuses, plus a break past its length.</summary>
public enum IconStatus { NotStarted, Working, Meeting, OnBreak, BreakExtended, DayEnded }

/// <summary>The colours AGENT.md section 1 sets. Nothing here has a red hue.</summary>
public static class IconColors
{
    public static readonly Color WorkingDot = Color.Parse("#34D27A");
    public static readonly Color WorkingRing = Color.Parse("#6FC9B6");
    public static readonly Color Meeting = Color.Parse("#A78BFA");
    public static readonly Color OnBreak = Color.Parse("#F2A93B");
    public static readonly Color TargetReached = Color.Parse("#34D27A");
    public static readonly Color HollowDot = Color.Parse("#8A93A3");
    public static readonly Color DarkEdge = Color.Parse("#141920");
    public static readonly Color Badge = Color.Parse("#E8EBF0");
    public static readonly Color BadgeGlyph = Color.Parse("#141920");
}

/// <summary>The dot and the ring for one status (AGENT.md section 1, D-33, D-74).</summary>
/// <param name="DotFill">How filled the dot is: 1 is solid in <paramref name="DotColor"/>, 0 is the hollow grey ring. In between only during a crossfade.</param>
public readonly record struct IconLook(Color DotColor, double DotFill, Color RingColor, double RingOpacity)
{
    public const double RingWorking = 0.90;
    public const double RingTargetReached = 0.95;
    public const double RingOnBreak = 0.36;
    public const double RingDayEnded = 0.30;

    /// <param name="reached">The ring is full: the day's time is at or past its target.</param>
    public static IconLook For(IconStatus status, bool reached) => status switch
    {
        IconStatus.NotStarted => new(IconColors.HollowDot, 0, IconColors.WorkingRing, 0),
        IconStatus.Working => reached
            ? new(IconColors.WorkingDot, 1, IconColors.TargetReached, RingTargetReached)
            : new(IconColors.WorkingDot, 1, IconColors.WorkingRing, RingWorking),
        IconStatus.Meeting => new(IconColors.Meeting, 1, IconColors.Meeting, RingWorking),
        IconStatus.OnBreak or IconStatus.BreakExtended =>
            new(IconColors.OnBreak, 1, reached ? IconColors.TargetReached : IconColors.WorkingRing, RingOnBreak),
        _ => new(IconColors.HollowDot, 0, IconColors.WorkingRing, RingDayEnded),
    };

    /// <summary>A crossfade step: colour and opacity changes never flash.</summary>
    public static IconLook Mix(IconLook from, IconLook to, double t)
    {
        if (t <= 0) return from;
        if (t >= 1) return to;
        // A hollow dot has no fill to fade from: the fill comes up in the new colour.
        var dot = from.DotFill <= 0 ? to.DotColor : to.DotFill <= 0 ? from.DotColor : Mix(from.DotColor, to.DotColor, t);
        return new(dot, from.DotFill + (to.DotFill - from.DotFill) * t, Mix(from.RingColor, to.RingColor, t),
            from.RingOpacity + (to.RingOpacity - from.RingOpacity) * t);
    }

    private static Color Mix(Color a, Color b, double t) => Color.FromArgb(
        (byte)Math.Round(a.A + (b.A - a.A) * t),
        (byte)Math.Round(a.R + (b.R - a.R) * t),
        (byte)Math.Round(a.G + (b.G - a.G) * t),
        (byte)Math.Round(a.B + (b.B - a.B) * t));
}

/// <summary>Everything one drawing of the icon depends on. Equal frames draw the same pixels.</summary>
/// <param name="SweepDegrees">The arc, clockwise from the dot; 0 draws none, 360 the whole circle.</param>
/// <param name="Glyph">"!", "i" or a count; null for no badge.</param>
/// <param name="BadgeScale">The badge's pop: 0 to 1.15 to 1.</param>
public readonly record struct IconFrame(IconLook Look, double SweepDegrees, string? Glyph, double BadgeScale);

/// <summary>What the badge's glyph is (C-591).</summary>
public static class IconGlyphs
{
    public const string Action = "!";
    public const string Info = "i";

    /// <summary>1 to 9, then 9+.</summary>
    public static string Count(int count) => count > 9 ? "9+" : count.ToString(System.Globalization.CultureInfo.InvariantCulture);
}
