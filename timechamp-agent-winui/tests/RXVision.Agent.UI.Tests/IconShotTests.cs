using Avalonia;
using Avalonia.Headless.XUnit;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using RXVision.Agent.Icon;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// Every state on a light and a dark wallpaper at 56 px, as PNGs for a person to read against the
/// design (brief, Testing). RXV_ICON_SHOTS says where; RXV_ICON_AVATARS names a folder of avatar
/// masters so the shots carry the design's own faces, else the RX mark (D-85).
/// </summary>
public class IconShotTests
{
    /// <summary>The panels design page 2 uses for "At real size".</summary>
    private static readonly (string Name, Color Colour)[] Wallpapers =
    {
        ("light", Color.Parse("#E6EAF0")),
        ("dark", Color.Parse("#232A36")),
    };

    private sealed record Shot(string Name, IconFrame Frame, string? Avatar);

    private static IEnumerable<Shot> Shots()
    {
        // The numbers each design page draws: M17 on page 3, F57 on page 4, M11 on pages 5, 6 and 7.
        yield return new("not-started", IconPixels.Frame(IconStatus.NotStarted), "male/M17.png");
        yield return new("working", IconPixels.Frame(IconStatus.Working, 5.75 / 8), "female/F57.png");
        yield return new("meeting", IconPixels.Frame(IconStatus.Meeting, 2.0 / 8), "female/F57.png");
        yield return new("on-break", IconPixels.Frame(IconStatus.OnBreak, 3.5 / 8), "female/F57.png");
        yield return new("break-extended", IconPixels.Frame(IconStatus.BreakExtended, 3.5 / 8, IconGlyphs.Action), "male/M11.png");
        yield return new("target-reached", IconPixels.Frame(IconStatus.Working, 1), "female/F57.png");
        yield return new("day-ended", IconPixels.Frame(IconStatus.DayEnded, 1), "female/F57.png");
        yield return new("badge-action", IconPixels.Frame(IconStatus.Working, 5.2 / 8, IconGlyphs.Action), "male/M11.png");
        yield return new("badge-info", IconPixels.Frame(IconStatus.Working, 5.2 / 8, IconGlyphs.Info), "male/M11.png");
        yield return new("badge-count", IconPixels.Frame(IconStatus.Meeting, 5.2 / 8, IconGlyphs.Count(3)), "male/M11.png");
        yield return new("badge-count-12", IconPixels.Frame(IconStatus.Meeting, 5.2 / 8, IconGlyphs.Count(12)), "male/M11.png");
        yield return new("mark", IconPixels.Frame(IconStatus.Working, 5.2 / 8), null);
    }

    private static Bitmap? Master(string? relative)
    {
        var folder = Environment.GetEnvironmentVariable("RXV_ICON_AVATARS");
        if (relative is null || string.IsNullOrEmpty(folder)) return null;
        var file = Path.Combine(folder, relative);
        return File.Exists(file) ? new Bitmap(file) : null;
    }

    private static string Folder =>
        Environment.GetEnvironmentVariable("RXV_ICON_SHOTS") is { Length: > 0 } dir
            ? dir
            : Path.Combine(AppContext.BaseDirectory, "TestResults", "icon");

    /// <summary>What the render tests hold to, as numbers in a file, read from the same pixels.</summary>
    [AvaloniaFact]
    public void The_measurements_as_a_table()
    {
        var lines = new List<string> { "state\tscale\tring px\tring device px at 6 o'clock\tring colour\tring opacity\tarc end, deg from the dot\tdot px\tdot with its edge px\tdot centre colour" };
        foreach (var (name, status, progress) in new[]
                 {
                     ("Not started", IconStatus.NotStarted, 0.0), ("Working", IconStatus.Working, 5.75 / 8), ("In a meeting", IconStatus.Meeting, 0.25),
                     ("On break", IconStatus.OnBreak, 3.5 / 8), ("Break extended", IconStatus.BreakExtended, 3.5 / 8),
                     ("Target reached", IconStatus.Working, 1.0), ("Day ended", IconStatus.DayEnded, 1.0),
                 })
        {
            foreach (var scale in new[] { 1.0, 2.0 })
            {
                var frame = IconPixels.Frame(status, progress);
                lines.Add(string.Join('\t', name, scale, Measure(frame, scale)));
            }
        }
        foreach (var scale in new[] { 1.0, 2.0, 4.0 })
        {
            lines.Add($"scale {scale}: avatar across {AvatarAcross(scale):0.00} px; badge whole, light {BadgeWidths(scale)}; glyph \"!\" {GlyphBox("!", scale)}, \"i\" {GlyphBox("i", scale)}, \"3\" {GlyphBox("3", scale)}");
        }
        var shadow = IconPixels.Of(IconPixels.Frame(IconStatus.NotStarted), 4);
        lines.Add("shadow, darkening down the middle column at y: " + string.Join(", ", new[] { -3.5, -1.5, -0.5, 56.5, 57.5, 58.5, 59.5, 60.5, 61.5, 62.5 }.Select(y =>
        {
            var (sx, sy) = shadow.InBox(28, y);
            return $"{y:0.0}: {shadow.At(sx, sy).A * 100:0}%";
        })));
        var timer = System.Diagnostics.Stopwatch.StartNew();
        const int runs = 200;
        var sample = IconPixels.Frame(IconStatus.Working, 0.65);
        var avatars = new IconPixels.Avatars();
        for (var i = 0; i < runs; i++)
        {
            using var bitmap = Views.IconBitmap.Draw(sample with { SweepDegrees = 200 + i * 0.01 }, 2, avatars);
            Views.IconBitmap.CopyPixels(bitmap);
        }
        lines.Add($"one drawing with its pixels read back, scale 2: {timer.Elapsed.TotalMilliseconds / runs:0.00} ms");
        Directory.CreateDirectory(Folder);
        File.WriteAllLines(Path.Combine(Folder, "measurements.tsv"), lines);
    }

    private static double AvatarAcross(double scale)
    {
        var flat = new WriteableBitmap(new PixelSize(192, 192), new Vector(96, 96), Avalonia.Platform.PixelFormat.Bgra8888, Avalonia.Platform.AlphaFormat.Premul);
        using (var target = flat.Lock())
        {
            var row = new int[192];
            Array.Fill(row, unchecked((int)0xFFFF00FF));
            for (var y = 0; y < 192; y++) System.Runtime.InteropServices.Marshal.Copy(row, 0, target.Address + y * target.RowBytes, 192);
        }
        var drawn = IconPixels.Of(IconPixels.Frame(IconStatus.NotStarted), scale, new IconPixels.Avatars(flat));
        var plain = IconPixels.Of(IconPixels.Frame(IconStatus.NotStarted), scale, new IconPixels.Avatars(null));
        var magenta = IconPixels.Colour("#FF00FF");
        var (_, row2) = drawn.InBox(0, 28);
        double across = 0;
        for (var x = 0; x < drawn.Side; x++) across += IconPixels.Towards(drawn.At(x, row2), plain.At(x, row2), magenta);
        return across / scale;
    }

    private static string BadgeWidths(double scale)
    {
        var frame = IconPixels.Frame(IconStatus.Working, 0.5, IconGlyphs.Action);
        var drawn = IconPixels.Of(frame, scale);
        var plain = IconPixels.Of(frame with { Glyph = null, BadgeScale = 0 }, scale);
        var light = IconPixels.Colour("#E8EBF0");
        var centre = IconGeometry.BadgeCentre(scale);
        var (_, cy) = drawn.InBox(centre.X, centre.Y);
        var (whole, minLight, maxLight) = (0, int.MaxValue, int.MinValue);
        for (var x = 0; x < drawn.Side; x++)
        {
            if (drawn.Raw(x, cy) != plain.Raw(x, cy)) whole++;
            if (IconPixels.Distance(drawn.At(x, cy), light) > 16) continue;
            minLight = Math.Min(minLight, x);
            maxLight = Math.Max(maxLight, x);
        }
        return $"{whole / scale:0.0}, {(maxLight - minLight + 1) / scale:0.0}";
    }

    private static string GlyphBox(string glyph, double scale)
    {
        var drawn = IconPixels.Of(IconPixels.Frame(IconStatus.Working, 0.5, glyph), scale);
        var blank = IconPixels.Of(IconPixels.Frame(IconStatus.Working, 0.5, " "), scale);
        var ink = IconPixels.Colour("#141920");
        var light = IconPixels.Colour("#E8EBF0");
        var (minX, maxX, minY, maxY) = (int.MaxValue, int.MinValue, int.MaxValue, int.MinValue);
        for (var y = 0; y < drawn.Side; y++)
        {
            for (var x = 0; x < drawn.Side; x++)
            {
                if (IconPixels.Towards(drawn.At(x, y), light, ink) < 0.5 || drawn.Raw(x, y) == blank.Raw(x, y)) continue;
                minX = Math.Min(minX, x);
                maxX = Math.Max(maxX, x);
                minY = Math.Min(minY, y);
                maxY = Math.Max(maxY, y);
            }
        }
        return $"{(maxX - minX + 1) / scale:0.00} x {(maxY - minY + 1) / scale:0.00}";
    }

    private static string Measure(IconFrame frame, double scale)
    {
        var with = IconPixels.Of(frame, scale);
        var without = IconPixels.Of(IconPixels.NoArc(frame), scale);
        var (x, _) = with.InBox(28, 0);
        var look = frame.Look;
        var ring = new Rgba(look.RingColor.R, look.RingColor.G, look.RingColor.B, 1);
        double area = 0;
        var pixels = 0;
        for (var y = with.InBox(0, 50).Y; y < with.InBox(0, 56).Y && look.RingOpacity > 0 && frame.SweepDegrees > 45; y++)
        {
            var coverage = IconPixels.Towards(with.At(x, y), without.At(x, y), ring) / look.RingOpacity;
            area += coverage;
            if (coverage > 0.5) pixels++;
        }
        double? last = null;
        for (var past = 12.0; past < 348 && frame.SweepDegrees > 0 && look.RingOpacity > 0; past += 0.25)
        {
            var at = IconGeometry.OnRing(135 + past);
            var (ax, ay) = with.InBox(at.X, at.Y);
            if (IconPixels.Towards(with.At(ax, ay), without.At(ax, ay), ring) / look.RingOpacity > 0.5) last = past;
        }
        var centre = IconGeometry.DotCentre(scale);
        var (cx, cy) = with.InBox(centre.X, centre.Y);
        var dotPixel = with.At(cx, cy);
        var edge = IconPixels.Colour("#141920");
        var (dots, edges) = (0, 0);
        var dotColour = look.DotFill > 0 ? new Rgba(look.DotColor.R, look.DotColor.G, look.DotColor.B, 1) : IconPixels.Colour("#8A93A3");
        for (var i = with.InBox(36, 0).X; i < with.InBox(56, 0).X; i++)
        {
            var pixel = with.At(i, cy);
            if (IconPixels.Towards(pixel, edge, dotColour) > 0.5 && IconPixels.Distance(pixel, dotColour) <= 60) dots++;
            else if (IconPixels.Distance(pixel, edge) <= 12) edges++;
        }
        var hex = $"#{(int)Math.Round(dotPixel.R):X2}{(int)Math.Round(dotPixel.G):X2}{(int)Math.Round(dotPixel.B):X2}";
        return string.Join('\t', pixels == 0 ? "no arc" : (area / scale).ToString("0.00"), pixels == 0 ? "none" : pixels.ToString(),
            look.RingOpacity > 0 ? $"#{look.RingColor.R:X2}{look.RingColor.G:X2}{look.RingColor.B:X2}" : "none", look.RingOpacity.ToString("0.00"),
            last is { } end ? end >= 347 ? "full circle" : end.ToString("0.0") : "no arc",
            look.DotFill > 0 ? (dots / scale).ToString("0.0") : $"hollow, outline {dots / 2.0 / scale:0.0}",
            ((dots + edges) / scale).ToString("0.0"), hex);
    }

    [AvaloniaFact]
    public void The_faded_look_on_both_wallpapers()
    {
        var avatars = new IconPixels.Avatars(Master("male/M11.png"));
        foreach (var (wallpaper, colour) in Wallpapers)
        {
            foreach (var scale in new[] { 1.0, 2.0, 4.0 })
            {
                var path = Path.Combine(Folder, $"faded-{wallpaper}-{scale:0}x.png");
                IconPixels.SavePng(IconPixels.Frame(IconStatus.Working, 5.2 / 8), scale, avatars, colour, 88, path,
                    IconBehaviour.FadedOpacity, IconBehaviour.FadedSaturation);
                Assert.True(new FileInfo(path).Length > 500, $"{path} looks empty");
            }
        }
    }

    [AvaloniaFact]
    public void Every_state_on_a_light_and_a_dark_wallpaper()
    {
        foreach (var shot in Shots())
        {
            var avatars = new IconPixels.Avatars(Master(shot.Avatar));
            foreach (var (wallpaper, colour) in Wallpapers)
            {
                foreach (var scale in new[] { 1.0, 2.0, 4.0 })
                {
                    var path = Path.Combine(Folder, $"{shot.Name}-{wallpaper}-{scale:0}x.png");
                    IconPixels.SavePng(shot.Frame, scale, avatars, colour, 88, path);
                    Assert.True(new FileInfo(path).Length > 500, $"{path} looks empty");
                }
            }
        }
    }
}
