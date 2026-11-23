using System.Globalization;
using Avalonia;
using Avalonia.Data.Converters;
using Avalonia.Media;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Converters;

internal static class Palette
{
    // The panel's tokens (be/docs/3.6/AGENT.md section 4): neutral, the brand colour, amber for attention. No red.
    public static readonly IBrush NeutralBg = Brush("#2B3343"), NeutralFg = Brush("#9AA3B2");
    public static readonly IBrush AmberWash = Brush("#1FF2A93B"), Amber = Brush("#F2A93B"), AmberLabel = Brush("#141920");
    public static readonly IBrush BrandWash = Brush("#1A6FC9B6"), Brand = Brush("#6FC9B6");
    public static readonly IBrush Working = Brush("#34D27A"), Meeting = Brush("#A78BFA"), Grey = Brush("#8A93A3");

    public static IBrush Brush(string hex) => new SolidColorBrush(Color.Parse(hex)).ToImmutable();
}

/// <summary>Chip background for a <see cref="Tone"/>.</summary>
public sealed class ToneBackgroundConverter : IValueConverter
{
    public static readonly ToneBackgroundConverter Instance = new();

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => value switch
    {
        Tone.Open or Tone.Active or Tone.Warn or Tone.Over or Tone.Bad => Palette.AmberWash,
        Tone.Due => Palette.Amber,
        Tone.Good => Palette.BrandWash,
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
        Tone.Open or Tone.Active or Tone.Warn or Tone.Over or Tone.Bad => Palette.Amber,
        Tone.Due => Palette.AmberLabel,
        Tone.Good => Palette.Brand,
        _ => Palette.NeutralFg,
    };

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) => throw new NotSupportedException();
}

/// <summary>The dot beside a status: green working, amber on a break (extended too), violet meeting, grey otherwise.</summary>
public sealed class StatusBrushConverter : IValueConverter
{
    public static readonly StatusBrushConverter Instance = new();

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => value switch
    {
        BubbleStatus.Working => Palette.Working,
        BubbleStatus.Away or BubbleStatus.Overrun => Palette.Amber,
        BubbleStatus.Meeting => Palette.Meeting,
        SyncTone.Ok => Palette.Working,
        SyncTone.Pending => Palette.Amber,
        _ => Palette.Grey,
    };

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) => throw new NotSupportedException();
}

/// <summary>The dot before a waiting item: amber a break or minutes over, teal lunch, violet meeting.</summary>
public sealed class WaitingDotConverter : IValueConverter
{
    public static readonly WaitingDotConverter Instance = new();

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => value switch
    {
        WaitingKind.Break or WaitingKind.Overrun => Palette.Amber,
        WaitingKind.Lunch => Palette.Brand,
        WaitingKind.Meeting => Palette.Meeting,
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

/// <summary>4.0 History: amber when the month is behind its target, the brand colour on track; a muted day at 0.6.</summary>
public sealed class BoolBrushConverter : IValueConverter
{
    private readonly object _whenTrue;
    private readonly object _whenFalse;

    private BoolBrushConverter(object whenTrue, object whenFalse)
    {
        _whenTrue = whenTrue;
        _whenFalse = whenFalse;
    }

    public static readonly BoolBrushConverter BehindBackground = new(Palette.AmberWash, Palette.BrandWash);
    public static readonly BoolBrushConverter BehindForeground = new(Palette.Amber, Palette.Brand);
    public static readonly BoolBrushConverter BarBrush = new(Palette.Amber, Palette.Brand);
    public static readonly BoolBrushConverter MutedOpacity = new(0.6, 1.0);

    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is true ? _whenTrue : _whenFalse;

    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) => throw new NotSupportedException();
}
