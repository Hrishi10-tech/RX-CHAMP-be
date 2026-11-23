using Avalonia;
using Avalonia.Headless.XUnit;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using RXVision.Agent.Icon;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// Reads every number AGENT.md section 1 sets from the pixels the real painter draws, at scale 1
/// and 2. Nothing here trusts the constants: wanted values are written out.
/// </summary>
public class IconRenderTests
{
    private const double Bottom = 180; // Six o'clock, clockwise from 12.

    public static TheoryData<double> Scales => new() { 1, 2 };

    public static TheoryData<IconStatus, double, string, double, string?> Rings => new()
    {
        { IconStatus.Working, 0.5, "#6FC9B6", 0.90, "#34D27A" },
        { IconStatus.Meeting, 0.5, "#A78BFA", 0.90, "#A78BFA" },
        { IconStatus.OnBreak, 0.5, "#6FC9B6", 0.36, "#F2A93B" },
        { IconStatus.BreakExtended, 0.5, "#6FC9B6", 0.36, "#F2A93B" },
        { IconStatus.DayEnded, 0.5, "#6FC9B6", 0.30, null },
        // Past the target (D-33): the status goes first.
        { IconStatus.Working, 1, "#34D27A", 0.95, "#34D27A" },
        { IconStatus.Meeting, 1, "#A78BFA", 0.90, "#A78BFA" },
        { IconStatus.OnBreak, 1, "#34D27A", 0.36, "#F2A93B" },
        { IconStatus.DayEnded, 1, "#6FC9B6", 0.30, null },
    };

    /// <summary>The stroke's width across the ring at six o'clock: by area, and as a plain count of pixels.</summary>
    private static (double Width, int Pixels) RingAcross(double scale)
    {
        var frame = IconPixels.Frame(IconStatus.Working, 1);
        var with = IconPixels.Of(frame, scale);
        var without = IconPixels.Of(IconPixels.NoArc(frame), scale);
        var ring = IconPixels.Colour("#34D27A");
        var (x, _) = with.InBox(28, 0);
        double area = 0;
        var pixels = 0;
        for (var y = with.InBox(0, 50).Y; y < with.InBox(0, 56).Y; y++)
        {
            var coverage = IconPixels.Towards(with.At(x, y), without.At(x, y), ring) / 0.95;
            area += coverage;
            if (coverage > 0.5) pixels++;
        }
        return (area / scale, pixels);
    }

    [AvaloniaTheory]
    [MemberData(nameof(Scales))]
    public void The_ring_is_2_px_wide(double scale)
    {
        var (width, pixels) = RingAcross(scale);
        Assert.InRange(width, 1.85, 2.15);
        Assert.Equal((int)(2 * scale), pixels);
    }

    [AvaloniaTheory]
    [InlineData(1.25, 2.5)]
    [InlineData(1.5, 3)]
    [InlineData(3, 6)]
    public void Every_scale_draws_at_device_pixels_not_a_stretched_bitmap(double scale, double ringPixels)
    {
        var frame = IconPixels.Frame(IconStatus.Working, 1);
        var drawn = IconPixels.Of(frame, scale);
        Assert.Equal((int)Math.Ceiling(72 * scale), drawn.Side);
        var (width, _) = RingAcross(scale);
        Assert.InRange(width * scale, ringPixels - 0.3, ringPixels + 0.3);
    }

    [AvaloniaTheory]
    [InlineData(IconStatus.Working, "#34D27A", 1)]
    [InlineData(IconStatus.Working, "#34D27A", 2)]
    [InlineData(IconStatus.Meeting, "#A78BFA", 1)]
    [InlineData(IconStatus.Meeting, "#A78BFA", 2)]
    [InlineData(IconStatus.OnBreak, "#F2A93B", 1)]
    [InlineData(IconStatus.OnBreak, "#F2A93B", 2)]
    public void The_dot_is_7_px_with_a_dark_1_px_edge(IconStatus status, string hex, double scale)
    {
        var drawn = IconPixels.Of(IconPixels.Frame(status), scale);
        var dot = IconPixels.Colour(hex);
        var edge = IconPixels.Colour("#141920");
        // The centre sits on a pixel boundary or a middle as the size asks; the row through it holds the widest run.
        var centre = IconGeometry.DotCentre(scale);
        var (_, row) = drawn.InBox(centre.X, centre.Y);
        var dots = 0;
        var edges = 0;
        for (var x = drawn.InBox(36, 0).X; x < drawn.InBox(56, 0).X; x++)
        {
            var pixel = drawn.At(x, row);
            if (IconPixels.Towards(pixel, edge, dot) > 0.5 && IconPixels.Distance(pixel, dot) <= 60) dots++;
            else if (IconPixels.Distance(pixel, edge) <= 12) edges++;
        }
        Assert.Equal((int)(7 * scale), dots);
        Assert.Equal((int)(2 * scale), edges);
    }

    [AvaloniaFact]
    public void The_dot_sits_on_whole_pixels_so_it_stays_symmetric()
    {
        Assert.Equal(new Point(45.5, 45.5), IconGeometry.DotCentre(1));
        Assert.Equal(new Point(45.5, 45.5), IconGeometry.DotCentre(2));
        Assert.Equal(new Point(46, 10), IconGeometry.BadgeCentre(1));
        Assert.Equal(new Point(45.5, 10.5), IconGeometry.BadgeCentre(2));
        // Not a whole pixel size: it stays on the ring's path.
        Assert.Equal(45.68, IconGeometry.DotCentre(1.25).X, 2);
        Assert.Equal(45.68, IconGeometry.DotCentre(1.5).X, 2);

        var drawn = IconPixels.Of(IconPixels.Frame(IconStatus.Working));
        var (x, y) = drawn.InBox(45.5, 45.5);
        for (var d = 0; d <= 3; d++)
        {
            Assert.Equal(drawn.Raw(x - d, y), drawn.Raw(x + d, y));
            Assert.Equal(drawn.Raw(x, y - d), drawn.Raw(x, y + d));
        }
    }

    [AvaloniaTheory]
    [MemberData(nameof(Rings))]
    public void Colours_and_opacity_per_state(IconStatus status, double progress, string ringHex, double opacity, string? dotHex)
    {
        foreach (var scale in new[] { 1.0, 2.0 })
        {
            var frame = IconPixels.Frame(status, progress);
            var with = IconPixels.Of(frame, scale);
            var without = IconPixels.Of(IconPixels.NoArc(frame), scale);
            var colour = IconPixels.Colour(ringHex);
            // Six o'clock, the stroke's middle: 45 degrees past the dot, inside every arc here.
            var (x, y) = with.InBox(28, 53);
            var wanted = IconPixels.Over(without.At(x, y), colour, opacity);
            Assert.True(IconPixels.Distance(with.At(x, y), wanted) <= 2, $"{status} at {scale}: {with.At(x, y)} wanted {wanted}");

            var (dx, dy) = with.InBox(IconGeometry.DotCentre(scale).X, IconGeometry.DotCentre(scale).Y);
            var dotPixel = with.At(dx, dy);
            if (dotHex is not null) Assert.True(IconPixels.Distance(dotPixel, IconPixels.Colour(dotHex)) <= 1, $"{status} dot {dotPixel}");
        }
    }

    [AvaloniaTheory]
    [MemberData(nameof(Scales))]
    public void Not_started_and_day_ended_show_a_hollow_grey_dot_on_the_dark_disc(double scale)
    {
        foreach (var status in new[] { IconStatus.NotStarted, IconStatus.DayEnded })
        {
            var drawn = IconPixels.Of(IconPixels.Frame(status), scale);
            var outline = IconPixels.Colour("#8A93A3");
            var inside = IconPixels.Colour("#141920");
            var centre = IconGeometry.DotCentre(scale);
            var (cx, cy) = drawn.InBox(centre.X, centre.Y);
            Assert.True(IconPixels.Distance(drawn.At(cx, cy), inside) <= 1, "the middle is the dark disc: no fill");
            var outlines = 0;
            for (var x = drawn.InBox(36, 0).X; x < drawn.InBox(56, 0).X; x++)
            {
                if (IconPixels.Towards(drawn.At(x, cy), inside, outline) > 0.6 && IconPixels.Distance(drawn.At(x, cy), outline) <= 40) outlines++;
            }
            Assert.Equal((int)(2 * scale), outlines); // 1 px each side, on the row through the middle.
        }
    }

    [AvaloniaFact]
    public void Not_started_has_the_track_and_no_arc()
    {
        var empty = IconPixels.Of(IconPixels.Frame(IconStatus.NotStarted));
        // White at 9% over the metal: read against the metal just inside and just outside the stroke.
        var (x, _) = empty.InBox(28, 0);
        var inner = empty.At(x, empty.InBox(0, 51).Y);
        var outer = empty.At(x, empty.InBox(0, 54).Y);
        var metal = new Rgba((inner.R + outer.R) / 2, (inner.G + outer.G) / 2, (inner.B + outer.B) / 2, 1);
        var wanted = IconPixels.Over(metal, IconPixels.Colour("#FFFFFF"), 0.09);
        var track = empty.At(x, empty.InBox(0, 52.5).Y);
        Assert.True(IconPixels.Distance(track, wanted) <= 3, $"track {track} wanted {wanted}");

        var withArc = IconPixels.Of(IconPixels.Frame(IconStatus.Working));
        Assert.NotEqual(empty.At(x, empty.InBox(0, 52.5).Y), withArc.At(x, withArc.InBox(0, 52.5).Y));
    }

    /// <summary>Whether the arc covers the ring at this angle, clockwise from 12 o'clock.</summary>
    private static bool Covers(IconPixels with, IconPixels without, Rgba colour, double opacity, double degrees)
    {
        var at = IconGeometry.OnRing(degrees);
        var (x, y) = with.InBox(at.X, at.Y);
        return IconPixels.Towards(with.At(x, y), without.At(x, y), colour) / opacity > 0.5;
    }

    [AvaloniaTheory]
    [MemberData(nameof(Scales))]
    public void The_ring_starts_at_the_dot_and_runs_clockwise(double scale)
    {
        var frame = IconPixels.Frame(IconStatus.Working, 0.25);
        var with = IconPixels.Of(frame, scale);
        var without = IconPixels.Of(IconPixels.NoArc(frame), scale);
        var colour = IconPixels.Colour("#6FC9B6");
        // Clockwise from the dot at 135 is down and round to the left: six o'clock is on it.
        Assert.True(Covers(with, without, colour, 0.9, Bottom));
        Assert.True(Covers(with, without, colour, 0.9, 225 - 5));
        // Before the dot, on the right, is not.
        Assert.False(Covers(with, without, colour, 0.9, 135 - 15));
        Assert.False(Covers(with, without, colour, 0.9, 90));
    }

    [AvaloniaTheory]
    [InlineData(0.10, 1)]
    [InlineData(0.25, 1)]
    [InlineData(0.50, 1)]
    [InlineData(0.75, 1)]
    [InlineData(0.90, 1)]
    [InlineData(0.10, 2)]
    [InlineData(0.25, 2)]
    [InlineData(0.50, 2)]
    [InlineData(0.75, 2)]
    [InlineData(0.90, 2)]
    public void The_arcs_length_follows_the_progress(double progress, double scale)
    {
        var frame = IconPixels.Frame(IconStatus.Working, progress);
        var with = IconPixels.Of(frame, scale);
        var without = IconPixels.Of(IconPixels.NoArc(frame), scale);
        var colour = IconPixels.Colour("#6FC9B6");
        var last = 0.0;
        for (var past = 12.0; past < 348; past += 0.25)
        {
            if (Covers(with, without, colour, 0.9, 135 + past)) last = past;
        }
        // The round cap reaches 1 px past the end: 2.3 degrees. One device pixel along the ring either way.
        var wanted = progress * 360 + 2.3;
        var tolerance = 2.3 / scale + 0.5;
        Assert.InRange(last, wanted - tolerance, wanted + tolerance);
    }

    [AvaloniaFact]
    public void No_arc_at_zero_and_the_whole_circle_at_the_target()
    {
        var frame = IconPixels.Frame(IconStatus.Working, 0);
        var with = IconPixels.Of(frame);
        var without = IconPixels.Of(IconPixels.NoArc(frame));
        for (var y = 0; y < with.Side; y++)
            for (var x = 0; x < with.Side; x++)
                Assert.Equal(without.Raw(x, y), with.Raw(x, y));

        var full = IconPixels.Frame(IconStatus.Working, 1);
        var fullWith = IconPixels.Of(full);
        var fullWithout = IconPixels.Of(IconPixels.NoArc(full));
        var colour = IconPixels.Colour("#34D27A");
        for (var past = 12; past < 348; past += 3)
        {
            if (Math.Abs(135 + past - 405) < 15) continue; // The badge's corner holds no badge here, but stay clear of the dot's far side.
            Assert.True(Covers(fullWith, fullWithout, colour, 0.95, 135 + past), $"gap at {135 + past}");
        }
    }

    [AvaloniaTheory]
    [MemberData(nameof(Scales))]
    public void The_avatar_is_a_42_px_circle(double scale)
    {
        var flat = Flat(Color.Parse("#FF00FF"), 192);
        var drawn = IconPixels.Of(IconPixels.Frame(IconStatus.NotStarted), scale, new IconPixels.Avatars(flat));
        var magenta = IconPixels.Colour("#FF00FF");
        var (_, row) = drawn.InBox(0, 28);
        var (col, _) = drawn.InBox(28, 0);
        var across = 0;
        var down = 0;
        for (var i = 0; i < drawn.Side; i++)
        {
            if (IconPixels.Distance(drawn.At(i, row), magenta) <= 96) across++;
            if (IconPixels.Distance(drawn.At(col, i), magenta) <= 96) down++;
        }
        Assert.InRange(across / scale, 41.5, 42.5);
        Assert.InRange(down / scale, 41.5, 42.5);
        // A circle, not a square: the box's corner is outside it.
        var (cx, cy) = drawn.InBox(9, 9);
        Assert.True(IconPixels.Distance(drawn.At(cx, cy), magenta) > 96);
    }

    [AvaloniaFact]
    public void The_avatar_seam_is_asked_for_the_pixels_of_this_scale()
    {
        var one = new IconPixels.Avatars();
        IconPixels.Of(IconPixels.Frame(IconStatus.Working), 1, one);
        Assert.Equal(new[] { 42 }, one.Asked);
        var two = new IconPixels.Avatars();
        IconPixels.Of(IconPixels.Frame(IconStatus.Working), 2, two);
        Assert.Equal(new[] { 84 }, two.Asked);
    }

    [AvaloniaTheory]
    [MemberData(nameof(Scales))]
    public void With_no_picture_the_RX_mark_fills_the_same_42_px_circle(double scale)
    {
        var drawn = IconPixels.Of(IconPixels.Frame(IconStatus.NotStarted), scale);
        var fill = IconPixels.Colour(RxMark.Fill.ToString());
        foreach (var degrees in new[] { 0.0, 90, 180, 270 })
        {
            var a = degrees * Math.PI / 180;
            var (ix, iy) = drawn.InBox(28 + 19.5 * Math.Cos(a), 28 + 19.5 * Math.Sin(a));
            var (ox, oy) = drawn.InBox(28 + 22.5 * Math.Cos(a), 28 + 22.5 * Math.Sin(a));
            Assert.True(IconPixels.Distance(drawn.At(ix, iy), fill) <= 2, $"the fill reaches 19.5 px out at {degrees}");
            Assert.True(IconPixels.Distance(drawn.At(ox, oy), fill) > 2, $"and stops before 22.5 px at {degrees}");
        }
    }

    [AvaloniaTheory]
    [MemberData(nameof(Scales))]
    public void The_RX_mark_sits_in_the_middle_in_its_two_greys_at_0_57_of_the_circle(double scale)
    {
        var drawn = IconPixels.Of(IconPixels.Frame(IconStatus.NotStarted), scale);
        var r = IconPixels.Colour(RxMark.RInk.ToString());
        var x = IconPixels.Colour(RxMark.XInk.ToString());
        var (rs, xs) = (0, 0);
        var (minX, maxX, minY, maxY) = (int.MaxValue, int.MinValue, int.MaxValue, int.MinValue);
        for (var j = drawn.InBox(0, 10).Y; j < drawn.InBox(0, 46).Y; j++)
            for (var i = drawn.InBox(10, 0).X; i < drawn.InBox(46, 0).X; i++)
            {
                var (dx, dy) = ((i + 0.5) / scale - IconGeometry.Margin - 28, (j + 0.5) / scale - IconGeometry.Margin - 28);
                if (dx * dx + dy * dy > 19 * 19) continue; // Inside the circle: the ring's track is grey too.
                var px = drawn.At(i, j);
                var isR = IconPixels.Distance(px, r) <= 6;
                var isX = IconPixels.Distance(px, x) <= 6;
                if (isR) rs++;
                if (isX) xs++;
                if (!isR && !isX) continue;
                (minX, maxX, minY, maxY) = (Math.Min(minX, i), Math.Max(maxX, i), Math.Min(minY, j), Math.Max(maxY, j));
            }
        var area = scale * scale;
        Assert.Equal(0.57, RxMark.Share);
        Assert.True(rs > 110 * area, $"the R in light grey: {rs} pixels");
        Assert.True(xs > 40 * area, $"the X in the dimmer grey: {xs} pixels");
        Assert.True(rs > xs, "the R leads, the X sits back");
        var width = (maxX - minX + 1) / scale;
        Assert.InRange(width, IconGeometry.AvatarDiameter * RxMark.Share - 2.5, IconGeometry.AvatarDiameter * RxMark.Share + 1.5); // Edges blend into the fill.
        var (cx, cy) = drawn.InBox(28, 28);
        Assert.InRange((minX + maxX + 1) / 2.0 - cx, -1.5 * scale, 1.5 * scale);
        Assert.InRange((minY + maxY + 1) / 2.0 - cy, -1.5 * scale, 1.5 * scale);
    }

    [AvaloniaTheory]
    [InlineData(1, 46, 10)]
    [InlineData(2, 45.5, 10.5)]
    public void The_badge_is_14_px_round_12_at_the_top_right(double scale, double centreX, double centreY)
    {
        var frame = IconPixels.Frame(IconStatus.Working, 0.5, IconGlyphs.Action);
        var drawn = IconPixels.Of(frame, scale);
        var plain = IconPixels.Of(frame with { Glyph = null, BadgeScale = 0 }, scale);
        var light = IconPixels.Colour("#E8EBF0");
        var (cx, cy) = drawn.InBox(centreX, centreY);
        var (minL, maxL, minE, maxE) = (int.MaxValue, int.MinValue, int.MaxValue, int.MinValue);
        // Off the middle row, past the glyph's stem.
        var row = cy - (int)(3 * scale);
        for (var x = cx - (int)(10 * scale); x <= cx + (int)(10 * scale); x++)
        {
            if (x >= drawn.Side) continue;
            var pixel = drawn.At(x, cy);
            if (drawn.Raw(x, cy) != plain.Raw(x, cy)) { minE = Math.Min(minE, x); maxE = Math.Max(maxE, x); }
            if (IconPixels.Distance(pixel, light) <= 16) { minL = Math.Min(minL, x); maxL = Math.Max(maxL, x); }
        }
        Assert.InRange(row, 0, drawn.Side);
        Assert.Equal(14 * scale, maxE - minE + 1, 0);
        Assert.Equal(12 * scale, maxL - minL + 1, 0);
        Assert.Equal(cx, (minE + maxE + 1) / 2);
    }

    [AvaloniaTheory]
    [InlineData("!", 0.7, 2.2, 4.5, 6.5)]
    [InlineData("i", 0.7, 2.2, 4.5, 6.5)]
    [InlineData("3", 2.5, 5.5, 4.5, 6.5)]
    public void The_glyph_is_dark_and_centred_on_the_badge(string glyph, double minWidth, double maxWidth, double minHeight, double maxHeight)
    {
        var drawn = IconPixels.Of(IconPixels.Frame(IconStatus.Working, 0.5, glyph), 4);
        var ink = IconPixels.Colour("#141920");
        var centre = IconGeometry.BadgeCentre(4);
        var (cx, cy) = drawn.InBox(centre.X, centre.Y);
        var reach = 5 * 4; // Inside the light disc, clear of the dark edge.
        var (minX, maxX, minY, maxY) = (cx, cx, cy, cy);
        var inks = 0;
        for (var y = cy - reach; y <= cy + reach; y++)
        {
            for (var x = cx - reach; x <= cx + reach; x++)
            {
                var dx = x + 0.5 - cx;
                var dy = y + 0.5 - cy;
                if (dx * dx + dy * dy > reach * reach) continue;
                if (IconPixels.Distance(drawn.At(x, y), ink) > 60) continue;
                inks++;
                if (inks == 1) (minX, maxX, minY, maxY) = (x, x, y, y);
                minX = Math.Min(minX, x);
                maxX = Math.Max(maxX, x);
                minY = Math.Min(minY, y);
                maxY = Math.Max(maxY, y);
            }
        }
        Assert.True(inks > 0, "the glyph is there");
        var width = (maxX - minX + 1) / 4.0;
        var height = (maxY - minY + 1) / 4.0;
        Assert.InRange(width, minWidth, maxWidth);
        Assert.InRange(height, minHeight, maxHeight);
        Assert.InRange((minX + maxX + 1) / 2.0 / 4 - cx / 4.0, -0.5, 0.5);
        Assert.InRange((minY + maxY + 1) / 2.0 / 4 - cy / 4.0, -0.5, 0.5);
    }

    [AvaloniaTheory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void The_glyph_draws_over_a_real_picture_at_every_scale(double scale)
    {
        var picture = new IconPixels.Avatars(Flat(Color.Parse("#808890"), 192));
        var drawn = IconPixels.Of(IconPixels.Frame(IconStatus.Working, 0.5, IconGlyphs.Action), scale, picture);
        var blank = IconPixels.Of(IconPixels.Frame(IconStatus.Working, 0.5, " "), scale, picture);
        var centre = IconGeometry.BadgeCentre(scale);
        var (cx, cy) = drawn.InBox(centre.X, centre.Y);
        var reach = (int)(5 * scale);
        var inks = 0;
        for (var y = cy - reach; y <= cy + reach; y++)
            for (var x = cx - reach; x <= cx + reach; x++)
                if (drawn.Raw(x, y) != blank.Raw(x, y)) inks++;
        Assert.True(inks >= 5 * scale * scale, $"the glyph is there: {inks} pixels");
    }

    [AvaloniaFact]
    public void A_count_past_nine_is_a_pill_on_the_same_centre_and_inside_the_box()
    {
        Assert.Equal("9+", IconGlyphs.Count(12));
        Assert.Equal("9", IconGlyphs.Count(9));
        var drawn = IconPixels.Of(IconPixels.Frame(IconStatus.Meeting, 0.5, IconGlyphs.Count(12)), 2);
        var plain = IconPixels.Of(IconPixels.Frame(IconStatus.Meeting, 0.5), 2);
        var centre = IconGeometry.BadgeCentre(2);
        var (_, cy) = drawn.InBox(centre.X, centre.Y);
        var (minE, maxE) = (int.MaxValue, int.MinValue);
        for (var x = 0; x < drawn.Side; x++)
        {
            if (drawn.Raw(x, cy) == plain.Raw(x, cy)) continue;
            minE = Math.Min(minE, x);
            maxE = Math.Max(maxE, x);
        }
        Assert.Equal(17 * 2, maxE - minE + 1);
        Assert.True(maxE < (IconGeometry.Margin + IconGeometry.Box) * 2, "the pill stays inside the 56 px box");
    }

    [AvaloniaFact]
    public void The_pop_scales_the_badge_about_its_centre_and_nothing_else()
    {
        var frame = IconPixels.Frame(IconStatus.Working, 0.5, IconGlyphs.Action);
        var plain = IconPixels.Of(frame with { Glyph = null, BadgeScale = 0 });
        var half = IconPixels.Of(frame with { BadgeScale = 0.5 });
        var full = IconPixels.Of(frame);
        int Changed(IconPixels drawn)
        {
            var changed = 0;
            for (var y = 0; y < drawn.Side; y++)
                for (var x = 0; x < drawn.Side; x++)
                    if (drawn.Raw(x, y) != plain.Raw(x, y)) changed++;
            return changed;
        }
        Assert.True(Changed(half) < Changed(full) / 2);
        Assert.True(Changed(full) <= Math.PI * 7.6 * 7.6, "only the badge's own circle moved");
    }

    [AvaloniaTheory]
    [MemberData(nameof(Scales))]
    public void Outside_the_bezel_is_shadow_only_no_colour_and_no_glow(double scale)
    {
        foreach (var frame in AllFrames())
        {
            var drawn = IconPixels.Of(frame, scale);
            var (dot, badge) = (IconGeometry.DotCentre(scale), IconGeometry.BadgeCentre(scale));
            for (var y = 0; y < drawn.Side; y++)
            {
                for (var x = 0; x < drawn.Side; x++)
                {
                    var bx = (x + 0.5) / scale - IconGeometry.Margin;
                    var by = (y + 0.5) / scale - IconGeometry.Margin;
                    if (Near(bx, by, 28, 28, 27.9) || Near(bx, by, dot.X, dot.Y, 5.5) || Near(bx, by, badge.X, badge.Y, 10)) continue;
                    var (r, g, b, a) = drawn.Raw(x, y);
                    Assert.Equal((byte)0, r);
                    Assert.Equal((byte)0, g);
                    Assert.Equal((byte)0, b);
                    Assert.True(a <= 0.42 * 255 + 1, $"shadow alpha {a}");
                }
            }
        }
    }

    [AvaloniaFact]
    public void The_shadow_is_soft_and_sits_below()
    {
        var drawn = IconPixels.Of(IconPixels.Frame(IconStatus.NotStarted), 4);
        double Alpha(double y)
        {
            var (x, row) = drawn.InBox(28, y);
            return drawn.At(x, row).A;
        }
        // Darkening along the middle column; the design reads 34, 27, 21, 14, 7, 0 and 4 above.
        Assert.InRange(Alpha(56.5), 0.30, 0.42);
        Assert.InRange(Alpha(57.5), 0.23, 0.34);
        Assert.InRange(Alpha(58.5), 0.15, 0.26);
        Assert.InRange(Alpha(59.5), 0.06, 0.18);
        Assert.InRange(Alpha(60.5), 0.01, 0.10);
        Assert.InRange(Alpha(62.5), 0, 0.01);
        Assert.InRange(Alpha(-0.5), 0, 0.05);
    }

    [AvaloniaFact]
    public void The_bezel_is_graphite_metal()
    {
        var drawn = IconPixels.Of(IconPixels.Frame(IconStatus.NotStarted), 4);
        Rgba At(double degrees, double radius)
        {
            var radians = degrees * Math.PI / 180;
            var (x, y) = drawn.InBox(28 + radius * Math.Sin(radians), 28 - radius * Math.Cos(radians));
            return drawn.At(x, y);
        }
        // Light at the top left, darkest past the middle, lighter again at the bottom right.
        var topLeft = At(315, 26.7);
        var middleRight = At(45, 23.3);
        var bottomRight = At(120, 26.7);
        Assert.True(topLeft.R > middleRight.R + 20, $"{topLeft} against {middleRight}");
        Assert.True(bottomRight.R > 0x3B && bottomRight.R < 0x5A, $"{bottomRight}");
        foreach (var metal in new[] { topLeft, middleRight, bottomRight })
        {
            var (_, saturation) = metal.HueSaturation();
            Assert.True(saturation < 0.2, $"graphite, not a colour: {metal}");
        }
    }

    [AvaloniaTheory]
    [MemberData(nameof(Scales))]
    public void No_pixel_is_red_in_any_state(double scale)
    {
        foreach (var frame in AllFrames())
        {
            var drawn = IconPixels.Of(frame, scale);
            for (var y = 0; y < drawn.Side; y++)
            {
                for (var x = 0; x < drawn.Side; x++)
                {
                    var pixel = drawn.At(x, y);
                    if (pixel.A < 0.1) continue;
                    var (hue, saturation) = pixel.HueSaturation();
                    var reddish = hue >= 340 || hue <= 20;
                    Assert.False(reddish && saturation > 0.4, $"{frame} at {x},{y}: {pixel}");
                }
            }
        }
    }

    [AvaloniaTheory]
    [InlineData(1)]
    [InlineData(1.5)]
    [InlineData(2)]
    [InlineData(3)]
    public void The_bitmap_shows_one_pixel_to_one_device_pixel(double scale)
    {
        var frame = IconPixels.Frame(IconStatus.Working, 0.65);
        var drawn = IconPixels.Of(frame, scale);
        using var icon = IconBitmap.Draw(frame, scale, new IconPixels.Avatars());
        var side = drawn.Side;
        using var page = new RenderTargetBitmap(new PixelSize(side, side), new Vector(96 * scale, 96 * scale));
        using (var context = page.CreateDrawingContext())
        {
            IconBitmap.Show(context, icon, new Point(0, 0), scale);
        }
        var shown = IconBitmap.CopyPixels(page);
        var direct = IconBitmap.CopyPixels(icon);
        Assert.Equal(direct, shown);
    }

    [AvaloniaFact]
    public void The_same_frame_draws_the_same_pixels()
    {
        var frame = IconPixels.Frame(IconStatus.Working, 0.65);
        var a = IconPixels.Of(frame);
        var b = IconPixels.Of(frame);
        for (var y = 0; y < a.Side; y++)
            for (var x = 0; x < a.Side; x++)
                Assert.Equal(a.Raw(x, y), b.Raw(x, y));
    }

    private static bool Near(double x, double y, double cx, double cy, double r) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;

    private static IEnumerable<IconFrame> AllFrames()
    {
        foreach (var status in Enum.GetValues<IconStatus>())
        {
            yield return IconPixels.Frame(status, 0.65);
            yield return IconPixels.Frame(status, 1);
            yield return IconPixels.Frame(status, 0.65, IconGlyphs.Action);
            yield return IconPixels.Frame(status, 0.65, IconGlyphs.Info);
            yield return IconPixels.Frame(status, 0.65, IconGlyphs.Count(3));
        }
    }

    private static WriteableBitmap Flat(Color colour, int side)
    {
        var bitmap = new WriteableBitmap(new PixelSize(side, side), new Vector(96, 96), PixelFormat.Bgra8888, AlphaFormat.Premul);
        using var target = bitmap.Lock();
        var row = new int[side];
        Array.Fill(row, unchecked((int)((uint)colour.A << 24 | (uint)colour.R << 16 | (uint)colour.G << 8 | colour.B)));
        for (var y = 0; y < side; y++) System.Runtime.InteropServices.Marshal.Copy(row, 0, target.Address + y * target.RowBytes, side);
        return bitmap;
    }
}
