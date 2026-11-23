using Avalonia;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using RXVision.Agent.Icon;
using RXVision.Agent.Views;

namespace RXVision.Agent.UI.Tests;

/// <summary>One colour with its alpha, not premultiplied.</summary>
public readonly record struct Rgba(double R, double G, double B, double A)
{
    /// <summary>The hue in degrees and the saturation (HSL), for the no-red sweep.</summary>
    public (double Hue, double Saturation) HueSaturation()
    {
        var max = Math.Max(R, Math.Max(G, B));
        var min = Math.Min(R, Math.Min(G, B));
        var d = max - min;
        if (d <= 0) return (0, 0);
        var l = (max + min) / 2 / 255;
        var s = d / 255 / (1 - Math.Abs(2 * l - 1));
        var h = max == R ? 60 * (((G - B) / d + 6) % 6) : max == G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4);
        return (h, s);
    }
}

/// <summary>The pixels of one drawing of the icon, read back from the real painter at a display scale.</summary>
public sealed class IconPixels
{
    private readonly byte[] _bytes;
    private readonly bool _redFirst;

    private IconPixels(byte[] bytes, int side, double scale, bool redFirst)
    {
        _bytes = bytes;
        Side = side;
        Scale = scale;
        _redFirst = redFirst;
    }

    public int Side { get; }
    public double Scale { get; }

    /// <summary>A flat picture, to read the avatar's circle; or none, for the RX mark.</summary>
    public sealed class Avatars : IIconAvatarSource
    {
        private readonly Bitmap? _picture;
        public Avatars(Bitmap? picture = null) => _picture = picture;
        public List<int> Asked { get; } = new();
        public Bitmap? Picture(int devicePixels)
        {
            Asked.Add(devicePixels);
            return _picture;
        }
        public event Action? Changed { add { } remove { } }
    }

    public static IconPixels Of(IconFrame frame, double scale = 1, IIconAvatarSource? avatars = null)
    {
        using var bitmap = IconBitmap.Draw(frame, scale, avatars ?? new Avatars());
        return new IconPixels(IconBitmap.CopyPixels(bitmap), bitmap.PixelSize.Width, scale, bitmap.Format == Avalonia.Platform.PixelFormat.Rgba8888);
    }

    /// <summary>The frame for a status at a share of the target, drawn at rest.</summary>
    public static IconFrame Frame(IconStatus status, double progress = 0.5, string? glyph = null)
    {
        var sweep = status == IconStatus.NotStarted ? 0 : Math.Min(progress, 1) * 360;
        return new IconFrame(IconLook.For(status, progress >= 1), sweep, glyph, glyph is null ? 0 : 1);
    }

    /// <summary>The same frame with no arc: what the ring is laid over.</summary>
    public static IconFrame NoArc(IconFrame frame) => frame with { SweepDegrees = 0 };

    /// <summary>The device pixel at (x, y) of the canvas: premultiplied red, green, blue, alpha.</summary>
    public (byte R, byte G, byte B, byte A) Raw(int x, int y)
    {
        var i = (y * Side + x) * 4;
        return _redFirst
            ? (_bytes[i], _bytes[i + 1], _bytes[i + 2], _bytes[i + 3])
            : (_bytes[i + 2], _bytes[i + 1], _bytes[i], _bytes[i + 3]);
    }

    public Rgba At(int x, int y)
    {
        var (r, g, b, a) = Raw(x, y);
        if (a == 0) return new Rgba(0, 0, 0, 0);
        var k = 255.0 / a;
        return new Rgba(r * k, g * k, b * k, a / 255.0);
    }

    /// <summary>A point given in the 56 px box's own units, to the device pixel holding it.</summary>
    public (int X, int Y) InBox(double x, double y) =>
        ((int)Math.Floor((x + IconGeometry.Margin) * Scale), (int)Math.Floor((y + IconGeometry.Margin) * Scale));

    public static Rgba Colour(string hex)
    {
        var c = Color.Parse(hex);
        return new Rgba(c.R, c.G, c.B, c.A / 255.0);
    }

    public static double Distance(Rgba a, Rgba b) =>
        Math.Max(Math.Abs(a.R - b.R), Math.Max(Math.Abs(a.G - b.G), Math.Abs(a.B - b.B)));

    /// <summary>What a colour at this opacity over this pixel gives.</summary>
    public static Rgba Over(Rgba under, Rgba colour, double opacity) => new(
        under.R + (colour.R - under.R) * opacity,
        under.G + (colour.G - under.G) * opacity,
        under.B + (colour.B - under.B) * opacity,
        1);

    /// <summary>How far a pixel moved from <paramref name="from"/> towards <paramref name="to"/>, 0 to 1.</summary>
    public static double Towards(Rgba pixel, Rgba from, Rgba to)
    {
        var dr = to.R - from.R;
        var dg = to.G - from.G;
        var db = to.B - from.B;
        var length = dr * dr + dg * dg + db * db;
        if (length <= 0) return 0;
        return Math.Clamp(((pixel.R - from.R) * dr + (pixel.G - from.G) * dg + (pixel.B - from.B) * db) / length, 0, 1);
    }

    /// <summary>The pixels as a file, for a person to look at, at this opacity and saturation.</summary>
    public static void SavePng(IconFrame frame, double scale, IIconAvatarSource? avatars, Color wallpaper, int frameSide, string path,
        double opacity = 1, double saturation = 1)
    {
        using var icon = IconBitmap.Draw(frame, scale, avatars ?? new Avatars());
        Bitmap shown = icon;
        if (saturation < 1)
        {
            var toned = new WriteableBitmap(icon.PixelSize, icon.Dpi, icon.Format ?? Avalonia.Platform.PixelFormat.Bgra8888, Avalonia.Platform.AlphaFormat.Premul);
            using (var target = toned.Lock())
            {
                IconBitmap.Desaturate(IconBitmap.CopyPixels(icon), target, saturation, icon.Format ?? Avalonia.Platform.PixelFormat.Bgra8888);
            }
            shown = toned;
        }
        var side = (int)Math.Round(frameSide * scale);
        using var page = new RenderTargetBitmap(new PixelSize(side, side), new Vector(96 * scale, 96 * scale));
        using (var context = page.CreateDrawingContext())
        {
            context.FillRectangle(new SolidColorBrush(wallpaper), new Rect(0, 0, frameSide, frameSide));
            var at = (frameSide - IconGeometry.Canvas) / 2;
            using var fade = context.PushOpacity(opacity);
            IconBitmap.Show(context, shown, new Point(at, at), scale);
        }
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        page.Save(path);
    }
}
