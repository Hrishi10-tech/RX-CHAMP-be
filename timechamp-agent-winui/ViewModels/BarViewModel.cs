using Microsoft.UI.Xaml.Media;
using TimeChampAgent.Helpers;

namespace TimeChampAgent.ViewModels;

/// <summary>One productivity bar: height + colour ramped by activity.</summary>
public sealed class BarViewModel
{
    public required double Height { get; init; }
    public required double Fraction { get; init; }
    public required double Opacity { get; init; }
    /// <summary>Hour label shown under the bar, e.g. "8a" / "12p" (blank to hide).</summary>
    public string Label { get; init; } = "";

    /// <summary>Colour ramps from a soft indigo (#C7D2FE) to a deep indigo (#4F46E5).</summary>
    public SolidColorBrush Fill => new(UiUtil.Lerp("#C7D2FE", "#4F46E5", Fraction));
}
