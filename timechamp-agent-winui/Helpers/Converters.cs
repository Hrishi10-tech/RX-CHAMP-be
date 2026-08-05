using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Media;

namespace TimeChampAgent.Helpers;

/// <summary>bool → one of two brushes. Parameter is "#activeHex|#inactiveHex".</summary>
public sealed class ActiveBrushConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        var active = value is bool b && b;
        var parts = (parameter as string ?? "#00000000|#00000000").Split('|');
        var hex = active ? parts[0] : parts[^1];
        return hex.Equals("transparent", StringComparison.OrdinalIgnoreCase)
            ? new SolidColorBrush(Microsoft.UI.Colors.Transparent)
            : UiUtil.Brush(hex);
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language) =>
        throw new NotSupportedException();
}

/// <summary>Boolean NOT.</summary>
public sealed class InverseBoolConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => value is not (bool and true);
    public object ConvertBack(object value, Type targetType, object parameter, string language) => value is not (bool and true);
}

/// <summary>true → Visible, false → Collapsed. Pass parameter "invert" to flip.</summary>
public sealed class BoolToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        var b = value is bool v && v;
        if (parameter is string s && s.Equals("invert", StringComparison.OrdinalIgnoreCase)) b = !b;
        return b ? Visibility.Visible : Visibility.Collapsed;
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language) =>
        value is Visibility vis && vis == Visibility.Visible;
}
