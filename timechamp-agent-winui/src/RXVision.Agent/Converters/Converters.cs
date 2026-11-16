using System.Globalization;
using Avalonia;
using Avalonia.Data.Converters;
using Avalonia.Media;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Converters;

internal static class Palette
{
    public static readonly IBrush NeutralBg = Brush("#EEF0F4"), NeutralFg = Brush("#4B5368");
    public static readonly IBrush AmberSoft = Brush("#FEF3E0"), AmberInk = Brush("#7A4306");
    public static readonly IBrush Amber = Brush("#F59E0B"), AmberDeep = Brush("#2E1A02");
    public static readonly IBrush RedBg = Brush("#FDECEC"), RedInk = Brush("#B42318");
    public static readonly IBrush GreenBg = Brush("#E8F7EE"), GreenInk = Brush("#166534");
    public static readonly IBrush Green = Brush("#22C55E"), Violet = Brush("#8B5CF6"), Grey = Brush("#9AA2B4");
    public static readonly IBrush Brand = Brush("#4F46E5"), Red = Brush("#E5484D");
    public static readonly IBrush VioletBg = Brush("#F1ECFD"), VioletInk = Brush("#5B21B6");
    public static readonly IBrush Teal = Brush("#14B8A6");

    public static IBrush Brush(string hex) => new SolidColorBrush(Color.Parse(hex)).ToImmutable();
}

/// <summary>Chip background for a <see cref="Tone"/>.</summary>
public sealed class ToneBackgroundConverter : IValueConverter
{
    public static readonly ToneBackgroundConverter Instance = new();

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => value switch
    {
        Tone.Open or Tone.Active or Tone.Warn => Palette.AmberSoft,
        Tone.Due => Palette.Amber,
        Tone.Over or Tone.Bad => Palette.RedBg,
        Tone.Good => Palette.GreenBg,
        Tone.Skip => Palette.VioletBg,
        _ => Palette.NeutralBg,
    };

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) => throw new NotSupportedException();
}

/// <summary>Chip text colour for a <see cref="Tone"/>.</summary>
public sealed class ToneForegroundConverter : IValueConverter
{
    public static readonly ToneForegroundConverter Instance = new();

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => value switch
    {
        Tone.Open or Tone.Active or Tone.Warn => Palette.AmberInk,
        Tone.Due => Palette.AmberDeep,
        Tone.Over or Tone.Bad => Palette.RedInk,
        Tone.Good => Palette.GreenInk,
        Tone.Skip => Palette.VioletInk,
        _ => Palette.NeutralFg,
    };

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) => throw new NotSupportedException();
}

/// <summary>The dot beside a status: green working, amber away, violet meeting, red over time, grey otherwise.</summary>
public sealed class StatusBrushConverter : IValueConverter
{
    public static readonly StatusBrushConverter Instance = new();

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => value switch
    {
        BubbleStatus.Working => Palette.Green,
        BubbleStatus.Away => Palette.Amber,
        BubbleStatus.Meeting => Palette.Violet,
        BubbleStatus.Overrun => Palette.Red,
        SyncTone.Ok => Palette.Green,
        SyncTone.Pending => Palette.Amber,
        _ => Palette.Grey,
    };

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) => throw new NotSupportedException();
}

/// <summary>One value for true, another for false (History's "behind" chip, muted days).</summary>
public sealed class BoolBrushConverter : IValueConverter
{
    private readonly object _whenTrue;
    private readonly object _whenFalse;

    private BoolBrushConverter(object whenTrue, object whenFalse)
    {
        _whenTrue = whenTrue;
        _whenFalse = whenFalse;
    }

    public static readonly BoolBrushConverter BehindBackground = new(Palette.AmberSoft, Palette.GreenBg);
    public static readonly BoolBrushConverter BehindForeground = new(Palette.AmberInk, Palette.GreenInk);
    public static readonly BoolBrushConverter MutedOpacity = new(0.6, 1.0);

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is true ? _whenTrue : _whenFalse;

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) => throw new NotSupportedException();
}

/// <summary>The dot before a waiting item: amber break, teal lunch, red minutes over, violet meeting.</summary>
public sealed class WaitingDotConverter : IValueConverter
{
    public static readonly WaitingDotConverter Instance = new();

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => value switch
    {
        WaitingKind.Break => Palette.Amber,
        WaitingKind.Lunch => Palette.Teal,
        WaitingKind.Overrun => Palette.Red,
        WaitingKind.Meeting => Palette.Violet,
        _ => Palette.Grey,
    };

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) => throw new NotSupportedException();
}

/// <summary>An icon by resource key ("Icon.Clock"), so view models can name icons without UI types.</summary>
public sealed class IconConverter : IValueConverter
{
    public static readonly IconConverter Instance = new();

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
    {
        if (value is string key && Application.Current?.TryGetResource(key, null, out var resource) == true)
            return resource as Geometry;
        return null;
    }

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) => throw new NotSupportedException();
}

/// <summary>Fraction (0..1) to a width, given the full width as the parameter.</summary>
public sealed class FractionToWidthConverter : IMultiValueConverter
{
    public static readonly FractionToWidthConverter Instance = new();

    public object? Convert(IList<object?> values, Type targetType, object? parameter, CultureInfo culture)
    {
        if (values.Count < 2 || values[0] is not double fraction || values[1] is not double width) return 0.0;
        return Math.Max(0, Math.Clamp(fraction, 0, 1) * width);
    }
}

/// <summary>Adds a fixed amount to a number (e.g. a viewport height less the content margins).</summary>
public sealed class OffsetConverter : IValueConverter
{
    public static readonly OffsetConverter Minus32 = new(-32);

    private readonly double _offset;

    public OffsetConverter(double offset) => _offset = offset;

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is double d ? Math.Max(0, d + _offset) : 0.0;

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) => throw new NotSupportedException();
}
