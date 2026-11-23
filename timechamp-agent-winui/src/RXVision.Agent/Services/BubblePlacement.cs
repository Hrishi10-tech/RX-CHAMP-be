using Avalonia;
using Avalonia.Platform;
using RXVision.Agent.Icon;

namespace RXVision.Agent.Services;

/// <summary>
/// Where the floating icon goes: remembered per screen (by its centre), bottom right
/// of the primary screen's work area by default, and always kept inside a screen's
/// work area so it can't be lost off the edge or under the taskbar.
/// </summary>
public sealed class BubblePlacement
{
    /// <summary>The 56 px box's default distance from the right and bottom edges, in DIPs.</summary>
    public const double EdgeInset = 28;

    private readonly UiSettingsStore? _store;

    public BubblePlacement(UiSettingsStore? store) => _store = store;

    public static string KeyOf(Screen screen) =>
        $"{screen.Bounds.Width}x{screen.Bounds.Height}@{screen.Bounds.X},{screen.Bounds.Y}";

    /// <summary>The remembered face centre on a screen that is still attached, else the default.</summary>
    public PixelPoint Load(IReadOnlyList<Screen> screens, Screen? primary)
    {
        var saved = _store?.Current;
        if (saved is not null)
        {
            var preferred = saved.BubbleScreen is { } key ? screens.FirstOrDefault(s => KeyOf(s) == key) : null;
            if (preferred is not null && saved.Bubble.TryGetValue(KeyOf(preferred), out var spot)) return new PixelPoint(spot.X, spot.Y);
            foreach (var screen in screens)
                if (saved.Bubble.TryGetValue(KeyOf(screen), out var other)) return new PixelPoint(other.X, other.Y);
        }
        return Default(primary ?? screens.FirstOrDefault());
    }

    public void Save(Screen screen, PixelPoint faceCentre)
    {
        if (_store is null) return;
        var key = KeyOf(screen);
        _store.Current.Bubble[key] = new BubbleSpot { X = faceCentre.X, Y = faceCentre.Y };
        _store.Current.BubbleScreen = key;
        _store.Save();
    }

    public static PixelPoint Default(Screen? screen)
    {
        if (screen is null) return new PixelPoint(200, 200);
        var area = screen.WorkingArea;
        var fromEdge = (int)Math.Round((EdgeInset + IconGeometry.Box / 2) * DesktopPixelsPerDip(screen));
        return new PixelPoint(area.Right - fromEdge, area.Bottom - fromEdge);
    }

    /// <summary>A screen's area is in physical pixels on Windows and in points on macOS, whatever its backing scale.</summary>
    private static double DesktopPixelsPerDip(Screen screen) => OperatingSystem.IsMacOS() ? 1 : screen.Scaling;

    /// <summary>
    /// The window's top-left for a face centre, kept inside the work area of the
    /// screen the face is on (or the nearest one).
    /// </summary>
    public static PixelPoint WindowPosition(PixelPoint faceCentre, PixelSize windowSize, PixelPoint faceInWindow, IReadOnlyList<Screen> screens)
    {
        var x = faceCentre.X - faceInWindow.X;
        var y = faceCentre.Y - faceInWindow.Y;
        var screen = ScreenFor(faceCentre, screens);
        if (screen is null) return new PixelPoint(x, y);
        var area = screen.WorkingArea;
        x = Math.Clamp(x, area.X, Math.Max(area.X, area.Right - windowSize.Width));
        y = Math.Clamp(y, area.Y, Math.Max(area.Y, area.Bottom - windowSize.Height));
        return new PixelPoint(x, y);
    }

    /// <summary>The screen containing the point, else the nearest one.</summary>
    public static Screen? ScreenFor(PixelPoint point, IReadOnlyList<Screen> screens)
    {
        var inside = screens.FirstOrDefault(s => s.Bounds.Contains(point));
        if (inside is not null) return inside;
        return screens
            .OrderBy(s => Distance(s.Bounds, point))
            .FirstOrDefault();
    }

    private static double Distance(PixelRect r, PixelPoint p)
    {
        var dx = Math.Max(Math.Max(r.X - p.X, 0), p.X - r.Right);
        var dy = Math.Max(Math.Max(r.Y - p.Y, 0), p.Y - r.Bottom);
        return Math.Sqrt((double)dx * dx + (double)dy * dy);
    }
}
