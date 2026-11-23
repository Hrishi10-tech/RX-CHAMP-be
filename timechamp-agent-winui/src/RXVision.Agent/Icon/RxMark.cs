using Avalonia;
using Avalonia.Media;
using Avalonia.Media.Immutable;

namespace RXVision.Agent.Icon;

/// <summary>
/// The RX mark in grey: what every person circle in the agent shows by default, until the person
/// picks an avatar (AGENT.md section 7, D-84, D-85). Traced from the brand mark: the R on top in light grey, the X strokes
/// behind it a step dimmer, as the lavender sits back in the original. Vectors, so it is sharp at
/// any size; the gaps between the R and the X are part of the mark.
/// </summary>
public static class RxMark
{
    /// <summary>The traced mark's own box.</summary>
    public const double Width = 121.5;
    public const double Height = 97;

    /// <summary>The mark's width as a share of the circle it sits in.</summary>
    public const double Share = 0.57;

    /// <summary>The circle behind the mark.</summary>
    public static readonly Color Fill = Color.Parse("#2B3343");
    public static readonly Color RInk = Color.Parse("#B2B9C5");
    public static readonly Color XInk = Color.Parse("#687182");

    private static readonly IImmutableBrush FillBrush = new ImmutableSolidColorBrush(Fill);
    private static readonly IImmutableBrush RBrush = new ImmutableSolidColorBrush(RInk);
    private static readonly IImmutableBrush XBrush = new ImmutableSolidColorBrush(XInk);

    /// <summary>The R: top bar, bowl, middle bar and stem in one stroke, then the leg.</summary>
    internal const string RPath =
        "M0,0 H60 A19.5,20.5 0 0 1 79.5,20.5 V35.5 A25,25 0 0 1 63.5,56.5 L83.5,97 H65 L45,58.5 H20 " +
        "A4,4 0 0 0 16.5,62.5 V97 H0 V61 A18.5,20.5 0 0 1 18,40 H57 A7.5,7.5 0 0 0 63.5,32.5 V23.5 " +
        "A9.5,7.5 0 0 0 54,16.5 H0 Z";

    /// <summary>The X strokes: the arms on the right, the piece in the bowl, the piece under it.</summary>
    internal const string XPath =
        "M102,0 H121.5 L95,46.5 L121.5,97 H102 L81.5,58 H69 Z " +
        "M35.5,22 H56.5 V34 H43.5 Z " +
        "M40,67 H43 L51,83 L44.5,97 H24.5 Z";

    private static readonly Geometry R = StreamGeometry.Parse(RPath);
    private static readonly Geometry X = StreamGeometry.Parse(XPath);

    /// <summary>The mark centred in a circle of <paramref name="diameter"/>, on the circle's fill.</summary>
    public static void DrawInCircle(DrawingContext context, Point centre, double diameter)
    {
        var radius = diameter / 2;
        context.DrawEllipse(FillBrush, null, centre, radius, radius);
        Draw(context, centre, diameter * Share);
    }

    /// <summary>The mark alone, <paramref name="width"/> wide, centred on <paramref name="centre"/>.</summary>
    public static void Draw(DrawingContext context, Point centre, double width)
    {
        if (width <= 0) return;
        var s = width / Width;
        var place = Matrix.CreateTranslation(-Width / 2, -Height / 2) * Matrix.CreateScale(s, s)
            * Matrix.CreateTranslation(centre.X, centre.Y);
        using (context.PushTransform(place))
        {
            context.DrawGeometry(XBrush, null, X);
            context.DrawGeometry(RBrush, null, R);
        }
    }
}
