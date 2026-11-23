using System.Globalization;
using Avalonia;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Media.Immutable;

namespace RXVision.Agent.Icon;

/// <summary>
/// Draws the icon's layers, bottom to top, as vectors (AGENT.md section 1). The caller's context
/// holds the canvas in device-independent pixels; nothing here depends on the display scale except
/// the snapped centres of the dot and the badge.
/// </summary>
public static class IconPainter
{
    private static readonly IImmutableBrush Shadow = ShadowBrush();
    private static readonly IImmutableBrush Bezel = new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0.05, -0.04, RelativeUnit.Relative),
        EndPoint = new RelativePoint(0.95, 1.04, RelativeUnit.Relative),
        GradientStops =
        {
            new GradientStop(Color.Parse("#80878F"), 0),
            new GradientStop(Color.Parse("#757C84"), 0.12),
            new GradientStop(Color.Parse("#5B626B"), 0.22),
            new GradientStop(Color.Parse("#414853"), 0.32),
            new GradientStop(Color.Parse("#2F353F"), 0.50),
            new GradientStop(Color.Parse("#272C35"), 0.60),
            new GradientStop(Color.Parse("#393F49"), 0.77),
            new GradientStop(Color.Parse("#4D545F"), 0.92),
            new GradientStop(Color.Parse("#4D545F"), 1),
        },
    }.ToImmutable();
    private static readonly IImmutableBrush Well = new RadialGradientBrush
    {
        Center = new RelativePoint(0.5, 0.4, RelativeUnit.Relative),
        GradientOrigin = new RelativePoint(0.5, 0.4, RelativeUnit.Relative),
        RadiusX = new RelativeScalar(0.62, RelativeUnit.Relative),
        RadiusY = new RelativeScalar(0.62, RelativeUnit.Relative),
        Opacity = IconGeometry.WellOpacity,
        GradientStops =
        {
            new GradientStop(Color.Parse("#2B313C"), 0),
            new GradientStop(Color.Parse("#12161D"), 1),
        },
    }.ToImmutable();
    private static readonly IPen BezelHighlight = Stroke(Colors.White, IconGeometry.BezelHighlightOpacity, IconGeometry.BezelHighlightStroke);
    private static readonly IPen WellEdge = Stroke(Colors.Black, IconGeometry.WellEdgeOpacity, IconGeometry.WellEdgeStroke);
    private static readonly IPen AvatarEdge = Stroke(Colors.Black, IconGeometry.AvatarEdgeOpacity, IconGeometry.AvatarEdgeStroke);
    private static readonly IPen Track = Stroke(Colors.White, IconGeometry.TrackOpacity, IconGeometry.RingStroke);
    private static readonly IImmutableBrush DarkEdge = new ImmutableSolidColorBrush(IconColors.DarkEdge);
    private static readonly IImmutableBrush BadgeFill = new ImmutableSolidColorBrush(IconColors.Badge);
    private static readonly IImmutableBrush GlyphFill = new ImmutableSolidColorBrush(IconColors.BadgeGlyph);
    private static readonly IImmutableBrush InitialsFill = new ImmutableSolidColorBrush(IconColors.InitialsFill);
    private static readonly IImmutableBrush InitialsText = new ImmutableSolidColorBrush(IconColors.InitialsText);
    private static readonly IPen HollowRing = Stroke(IconColors.HollowDot, 1, IconGeometry.HollowDotStroke);

    /// <param name="context">Scaled so that one unit is one device-independent pixel, origin at the canvas's top left.</param>
    /// <param name="scale">The display scale, for the snapped centres.</param>
    /// <param name="avatar">The person's picture at this scale, or null to draw <paramref name="initials"/>.</param>
    /// <param name="span">The panel on a break with no shift: the break drawn on the ring after the held arc.</param>
    /// <param name="day">The panel with a shift: the ring as the shift's clock, breaks marked (no badge: the panel's cards say it).</param>
    public static void Paint(DrawingContext context, IconFrame frame, double scale, Bitmap? avatar, string initials, BreakSpan? span = null, DayRing? day = null)
    {
        using var inBox = context.PushTransform(Matrix.CreateTranslation(IconGeometry.Margin, IconGeometry.Margin));
        var c = new Point(IconGeometry.Centre, IconGeometry.Centre);

        PaintBase(context, c);
        PaintAvatar(context, c, avatar, initials);
        context.DrawEllipse(null, AvatarEdge, c, IconGeometry.AvatarRadius, IconGeometry.AvatarRadius);
        if (day is not null) PaintDayRing(context, frame, day);
        else if (span is { } onBreak) PaintBreakRing(context, c, frame, onBreak);
        else PaintRing(context, c, frame);
        PaintDot(context, frame.Look, scale);
        if (day is null && frame.Glyph is { } glyph && frame.BadgeScale > 0) PaintBadge(context, glyph, frame.BadgeScale, scale);
    }

    private static void PaintBase(DrawingContext context, Point c)
    {
        var shadowReach = IconGeometry.ShadowRadius + 3 * IconGeometry.ShadowSigma;
        context.DrawEllipse(Shadow, null, new Point(c.X, c.Y + IconGeometry.ShadowOffset), shadowReach, shadowReach);
        context.DrawEllipse(Bezel, null, c, IconGeometry.BezelRadius, IconGeometry.BezelRadius);
        context.DrawEllipse(null, BezelHighlight, c, IconGeometry.BezelHighlightRadius, IconGeometry.BezelHighlightRadius);
        context.DrawEllipse(Well, null, c, IconGeometry.WellRadius, IconGeometry.WellRadius);
        context.DrawEllipse(null, WellEdge, c, IconGeometry.WellRadius, IconGeometry.WellRadius);
    }

    private static void PaintAvatar(DrawingContext context, Point c, Bitmap? avatar, string initials)
    {
        var r = IconGeometry.AvatarRadius;
        var area = new Rect(c.X - r, c.Y - r, r * 2, r * 2);
        if (avatar is not null)
        {
            using var clip = context.PushClip(new RoundedRect(area, r));
            using var quality = context.PushRenderOptions(new RenderOptions { BitmapInterpolationMode = BitmapInterpolationMode.HighQuality });
            // The source rectangle of a drawn image is in the bitmap's own pixels.
            context.DrawImage(avatar, new Rect(0, 0, avatar.PixelSize.Width, avatar.PixelSize.Height), area);
            return;
        }
        context.DrawEllipse(InitialsFill, null, c, r, r);
        DrawCentred(context, initials, c, IconGeometry.InitialsSize, FontWeight.Bold, InitialsText);
    }

    private static void PaintRing(DrawingContext context, Point c, IconFrame frame)
    {
        context.DrawEllipse(null, Track, c, IconGeometry.RingRadius, IconGeometry.RingRadius);
        if (frame.SweepDegrees <= 0 || frame.Look.RingOpacity <= 0) return;
        var brush = new ImmutableSolidColorBrush(frame.Look.RingColor, frame.Look.RingOpacity);
        if (frame.SweepDegrees >= 360)
        {
            context.DrawEllipse(null, new ImmutablePen(brush, IconGeometry.RingStroke), c, IconGeometry.RingRadius, IconGeometry.RingRadius);
            return;
        }
        var pen = new ImmutablePen(brush, IconGeometry.RingStroke, lineCap: PenLineCap.Round);
        context.DrawGeometry(null, pen, Arc(frame.SweepDegrees));
    }

    /// <summary>
    /// The ring on a break, in the panel. The day's arc holds in soft amber. After a small gap the
    /// break's own section follows: a faint track as long as the break, filling in full amber as the
    /// minutes pass, closed by a second small gap. A fill that carries on past that gap is a break
    /// run over: it reads without a number. A break with no length has no section, only the fill.
    /// </summary>
    private static void PaintBreakRing(DrawingContext context, Point c, IconFrame frame, BreakSpan span)
    {
        context.DrawEllipse(null, Stroke(Colors.White, IconGeometry.TrackOpacity, BreakSpan.Stroke), c, IconGeometry.RingRadius, IconGeometry.RingRadius);
        var layout = span.Layout(frame.SweepDegrees);
        var colour = frame.Look.RingColor;
        if (layout.Held > 0) Segment(context, 0, layout.Held, colour, BreakSpan.HeldOpacity);
        if (layout.SectionLength > 0) Segment(context, layout.SectionStart, layout.SectionLength, colour, BreakSpan.SectionOpacity);
        if (layout.Fill > 0) Segment(context, layout.SectionStart, layout.Fill, colour, 1);
        if (layout.Over > 0) Segment(context, layout.OverStart, layout.Over, colour, 1);
    }

    private static void Segment(DrawingContext context, double from, double length, Color colour, double opacity, double stroke = BreakSpan.Stroke)
    {
        if (length <= 0 || opacity <= 0) return;
        var pen = new ImmutablePen(new ImmutableSolidColorBrush(colour, opacity), stroke, lineCap: PenLineCap.Flat);
        context.DrawGeometry(null, pen, length >= 359.99 ? Circle() : Arc(from, length));
    }

    private static Geometry Circle() =>
        new EllipseGeometry(new Rect(IconGeometry.Centre - IconGeometry.RingRadius, IconGeometry.Centre - IconGeometry.RingRadius, 2 * IconGeometry.RingRadius, 2 * IconGeometry.RingRadius));

    /// <summary>The panel's ring as the shift's clock (see <see cref="DayRing"/>).</summary>
    private static void PaintDayRing(DrawingContext context, IconFrame frame, DayRing day)
    {
        foreach (var arc in day.Arcs())
        {
            var (colour, opacity) = arc.Kind switch
            {
                DayRing.Kind.Track => (Colors.White, IconGeometry.TrackOpacity),
                DayRing.Kind.Section => (IconColors.OnBreak, DayRing.SectionOpacity),
                DayRing.Kind.NextSection => (IconColors.OnBreak, DayRing.NextOpacity),
                DayRing.Kind.Work => (frame.Look.RingColor, frame.Look.RingOpacity),
                DayRing.Kind.Break => (IconColors.OnBreak, DayRing.TakenOpacity),
                _ => (IconColors.OnBreak, 1.0),
            };
            Segment(context, arc.From, arc.Length, colour, opacity, DayRing.Stroke);
        }
        var notch = new ImmutablePen(new ImmutableSolidColorBrush(IconColors.DarkEdge), DayRing.Notch);
        var reach = DayRing.Stroke / 2 + 0.4;
        foreach (var degrees in day.Notches())
        {
            var radians = (IconGeometry.RingStartDegrees + degrees) * Math.PI / 180;
            Point At(double r) => new(IconGeometry.Centre + r * Math.Sin(radians), IconGeometry.Centre - r * Math.Cos(radians));
            context.DrawLine(notch, At(IconGeometry.RingRadius - reach), At(IconGeometry.RingRadius + reach));
        }
    }

    /// <summary>The ring's path from the dot, clockwise, for this many degrees.</summary>
    public static Geometry Arc(double sweepDegrees) => Arc(0, sweepDegrees);

    /// <summary>The ring's path from this many degrees past the dot, clockwise, for this many degrees.</summary>
    public static Geometry Arc(double fromDegrees, double sweepDegrees)
    {
        var geometry = new StreamGeometry();
        using var path = geometry.Open();
        var r = IconGeometry.RingRadius;
        var start = IconGeometry.RingStartDegrees + fromDegrees;
        path.BeginFigure(IconGeometry.OnRing(start), isFilled: false);
        path.ArcTo(IconGeometry.OnRing(start + sweepDegrees), new Size(r, r), 0,
            isLargeArc: sweepDegrees > 180, SweepDirection.Clockwise);
        path.EndFigure(isClosed: false);
        return geometry;
    }

    private static void PaintDot(DrawingContext context, IconLook look, double scale)
    {
        var centre = IconGeometry.DotCentre(scale);
        var r = IconGeometry.DotDiameter / 2;
        context.DrawEllipse(DarkEdge, null, centre, r + IconGeometry.DotEdge, r + IconGeometry.DotEdge);
        if (look.DotFill < 1)
        {
            // The outline's outer edge is the dot's: the stroke runs half a stroke inside it.
            var ring = r - IconGeometry.HollowDotStroke / 2;
            using var fade = context.PushOpacity(1 - look.DotFill);
            context.DrawEllipse(null, HollowRing, centre, ring, ring);
        }
        if (look.DotFill > 0)
        {
            context.DrawEllipse(new ImmutableSolidColorBrush(look.DotColor, look.DotFill), null, centre, r, r);
        }
    }

    private static void PaintBadge(DrawingContext context, string glyph, double popScale, double scale)
    {
        var centre = IconGeometry.BadgeCentre(scale);
        var pop = Matrix.CreateTranslation(-centre.X, -centre.Y) * Matrix.CreateScale(popScale, popScale) * Matrix.CreateTranslation(centre);
        using var popped = context.PushTransform(pop);
        var h = IconGeometry.BadgeDiameter;
        var w = glyph.Length > 1 ? IconGeometry.BadgePillWidth : h;
        var e = IconGeometry.BadgeEdge;
        var light = new Rect(centre.X - w / 2, centre.Y - h / 2, w, h);
        context.DrawRectangle(DarkEdge, null, light.Inflate(e), h / 2 + e, h / 2 + e);
        context.DrawRectangle(BadgeFill, null, light, h / 2, h / 2);
        // The bundled Inter stops at bold.
        DrawCentred(context, glyph, centre, IconGeometry.BadgeGlyphSize, FontWeight.Bold, GlyphFill);
    }

    /// <summary>Centred across, and on its baseline half a capital below the middle.</summary>
    private static void DrawCentred(DrawingContext context, string text, Point centre, double size, FontWeight weight, IBrush brush)
    {
        var formatted = new FormattedText(text, CultureInfo.InvariantCulture, FlowDirection.LeftToRight,
            new Typeface(FontManager.Current.DefaultFontFamily, FontStyle.Normal, weight), size, brush);
        var baseline = centre.Y + size * IconGeometry.GlyphCapHeight / 2;
        // As a path: drawn as text into a bitmap at a scale above 1, after a picture, the glyph went missing.
        var outline = formatted.BuildGeometry(new Point(centre.X - formatted.Width / 2, baseline - formatted.Baseline));
        if (outline is not null) context.DrawGeometry(brush, null, outline);
    }

    private static ImmutablePen Stroke(Color color, double opacity, double thickness) =>
        new(new ImmutableSolidColorBrush(color, opacity), thickness);

    /// <summary>A disc with a Gaussian edge: black at 42%, soft over about 6.5 px, no colour and no glow.</summary>
    private static IImmutableBrush ShadowBrush()
    {
        var reach = IconGeometry.ShadowRadius + 3 * IconGeometry.ShadowSigma;
        var inner = (IconGeometry.ShadowRadius - 3 * IconGeometry.ShadowSigma) / reach;
        var brush = new RadialGradientBrush
        {
            Center = new RelativePoint(0.5, 0.5, RelativeUnit.Relative),
            GradientOrigin = new RelativePoint(0.5, 0.5, RelativeUnit.Relative),
            RadiusX = new RelativeScalar(0.5, RelativeUnit.Relative),
            RadiusY = new RelativeScalar(0.5, RelativeUnit.Relative),
        };
        const int steps = 16;
        brush.GradientStops.Add(new GradientStop(Color.FromArgb((byte)Math.Round(255 * IconGeometry.ShadowOpacity), 0, 0, 0), 0));
        for (var i = 0; i <= steps; i++)
        {
            var at = inner + (1 - inner) * i / steps;
            var distance = (IconGeometry.ShadowRadius - at * reach) / IconGeometry.ShadowSigma;
            var alpha = i == steps ? 0 : IconGeometry.ShadowOpacity * NormalCdf(distance);
            brush.GradientStops.Add(new GradientStop(Color.FromArgb((byte)Math.Round(255 * alpha), 0, 0, 0), at));
        }
        return brush.ToImmutable();
    }

    /// <summary>The Gaussian's edge profile (Zelen and Severo's approximation, good to 7 places).</summary>
    private static double NormalCdf(double x)
    {
        var t = 1 / (1 + 0.2316419 * Math.Abs(x));
        var tail = Math.Exp(-x * x / 2) / Math.Sqrt(2 * Math.PI)
            * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
        return x >= 0 ? 1 - tail : tail;
    }
}
