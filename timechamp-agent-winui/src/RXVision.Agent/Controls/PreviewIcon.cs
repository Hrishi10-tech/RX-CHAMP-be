using System.Globalization;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Media.Immutable;
using RXVision.Agent.Services;

namespace RXVision.Agent.Controls;

/// <summary>
/// The floating icon as a plain control, for the picker's live preview at 88 px: every layer of
/// AGENT.md section 1, in vectors, scaled from the 56 px drawing, with the tapped avatar or the
/// RX mark in the well.
/// </summary>
public sealed class PreviewIcon : Control
{
    private const double Box = 56;

    private static readonly IBrush Bezel = new LinearGradientBrush
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

    private static readonly IBrush Well = new RadialGradientBrush
    {
        Center = new RelativePoint(0.5, 0.4, RelativeUnit.Relative),
        GradientOrigin = new RelativePoint(0.5, 0.4, RelativeUnit.Relative),
        RadiusX = new RelativeScalar(0.62, RelativeUnit.Relative),
        RadiusY = new RelativeScalar(0.62, RelativeUnit.Relative),
        Opacity = 0.13,
        GradientStops =
        {
            new GradientStop(Color.Parse("#2B313C"), 0),
            new GradientStop(Color.Parse("#12161D"), 1),
        },
    }.ToImmutable();

    private static readonly IBrush DarkEdge = new ImmutableSolidColorBrush(Color.Parse("#141920"));
    private static readonly IBrush BadgeFill = new ImmutableSolidColorBrush(Color.Parse("#E8EBF0"));

    public static readonly StyledProperty<string?> AvatarIdProperty =
        AvaloniaProperty.Register<PreviewIcon, string?>(nameof(AvatarId));

    public static readonly StyledProperty<PreviewLook> LookProperty =
        AvaloniaProperty.Register<PreviewIcon, PreviewLook>(nameof(Look), PreviewLook.Unknown);

    static PreviewIcon() => AffectsRender<PreviewIcon>(AvatarIdProperty, LookProperty);

    public PreviewIcon() => RenderOptions.SetBitmapInterpolationMode(this, BitmapInterpolationMode.HighQuality);

    public string? AvatarId
    {
        get => GetValue(AvatarIdProperty);
        set => SetValue(AvatarIdProperty, value);
    }

    public PreviewLook Look
    {
        get => GetValue(LookProperty);
        set => SetValue(LookProperty, value);
    }

    public override void Render(DrawingContext context)
    {
        var size = Math.Min(Bounds.Width, Bounds.Height);
        if (size <= 0) return;
        var s = size / Box;
        var origin = new Point((Bounds.Width - size) / 2, (Bounds.Height - size) / 2);
        Point At(double x, double y) => new(origin.X + x * s, origin.Y + y * s);
        void Disc(IBrush brush, double x, double y, double r) => context.DrawEllipse(brush, null, At(x, y), r * s, r * s);
        void Ring(Color colour, double opacity, double x, double y, double r, double stroke) =>
            context.DrawEllipse(null, new ImmutablePen(new ImmutableSolidColorBrush(colour, opacity), stroke * s), At(x, y), r * s, r * s);

        var centre = Box / 2;
        var look = Look;

        // 1. Shadow: black at 42%, soft, 2.4 px down, no colour and no glow.
        var shadowBox = new Rect(At(0, 0), new Size(size, size));
        context.DrawRectangle(Brushes.Transparent, null, new RoundedRect(shadowBox, size / 2),
            new BoxShadows(new BoxShadow { OffsetY = 2.4 * s, Blur = 3.2 * s, Color = Color.FromArgb(107, 0, 0, 0) }));
        // 2 to 5. Bezel, its highlight, the well and its edge.
        Disc(Bezel, centre, centre, 27.35);
        Ring(Colors.White, 0.13, centre, centre, 27.02, 0.33);
        Disc(Well, centre, centre, 22.68);
        Ring(Colors.Black, 0.50, centre, centre, 22.68, 0.51);
        // 6 and 7. The person, and the avatar's edge.
        var avatar = new Rect(At(centre - 21, centre - 21), new Size(42 * s, 42 * s));
        AvatarPainter.Draw(context, avatar, AvatarId, TopLevel.GetTopLevel(this)?.RenderScaling ?? 1);
        Ring(Colors.Black, 0.35, centre, centre, 21, 0.42);
        // 8 and 9. The track and the arc, from the dot, clockwise.
        Ring(Colors.White, 0.09, centre, centre, 25, 2);
        if (look.Ring is { } colour && look.Sweep > 0) DrawArc(context, At(centre, centre), 25 * s, look.Sweep, colour, look.RingOpacity, 2 * s);
        // 10 and 11. The dot on the ring at 135 degrees: filled, or hollow over its dark edge.
        Disc(DarkEdge, 45.68, 45.68, 4.5);
        if (look.HollowDot) Ring(look.Dot, 1, 45.68, 45.68, 3, 1);
        else Disc(new ImmutableSolidColorBrush(look.Dot), 45.68, 45.68, 3.5);
        // 12 to 14. The badge on the ring at 45 degrees.
        if (look.Badge is { } glyph)
        {
            Disc(DarkEdge, 45.68, 10.32, 7);
            Disc(BadgeFill, 45.68, 10.32, 6);
            var text = new FormattedText(glyph, CultureInfo.InvariantCulture, FlowDirection.LeftToRight,
                new Typeface(TextElement.GetFontFamily(this), FontStyle.Normal, FontWeight.ExtraBold), 7.5 * s, DarkEdge);
            var at = At(45.68, 10.32);
            context.DrawText(text, new Point(at.X - text.Width / 2, at.Y - text.Height / 2));
        }
    }

    /// <summary>Clockwise from 135 degrees (angles clockwise from 12 o'clock), round caps; a full sweep closes the circle.</summary>
    private static void DrawArc(DrawingContext context, Point centre, double radius, double sweep, Color colour, double opacity, double stroke)
    {
        var pen = new ImmutablePen(new ImmutableSolidColorBrush(colour, opacity), stroke, lineCap: PenLineCap.Round);
        if (sweep >= 1)
        {
            context.DrawEllipse(null, pen, centre, radius, radius);
            return;
        }
        Point OnRing(double degrees)
        {
            var a = degrees * Math.PI / 180;
            return new Point(centre.X + radius * Math.Sin(a), centre.Y - radius * Math.Cos(a));
        }
        var degrees = sweep * 360;
        var geometry = new StreamGeometry();
        using (var path = geometry.Open())
        {
            path.BeginFigure(OnRing(135), false);
            path.ArcTo(OnRing(135 + degrees), new Size(radius, radius), 0, degrees > 180, SweepDirection.Clockwise);
            path.EndFigure(false);
        }
        context.DrawGeometry(null, pen, geometry);
    }
}
