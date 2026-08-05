using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using TimeChampAgent.Helpers;

namespace TimeChampAgent.ViewModels;

/// <summary>One chat bubble, shaped for the DataTemplate (no logic in the view).</summary>
public sealed class ChatMessageViewModel
{
    public required string Id { get; init; }
    public required bool Incoming { get; init; }
    public required string Sender { get; init; }
    public required string Time { get; init; }
    public required string Body { get; init; }
    public required string Initials { get; init; }
    public required string AvatarHex { get; init; }

    // ---- Presentation (derived) ----
    public SolidColorBrush AvatarBrush => UiUtil.Brush(AvatarHex);

    public SolidColorBrush BubbleBrush =>
        Incoming ? UiUtil.Brush("#E9ECEF") : UiUtil.Brush("#3884CC");

    public SolidColorBrush BodyBrush =>
        Incoming ? UiUtil.Brush("#1A2027") : new SolidColorBrush(Microsoft.UI.Colors.White);

    public HorizontalAlignment RowAlignment =>
        Incoming ? HorizontalAlignment.Left : HorizontalAlignment.Right;

    public Visibility AvatarVisibility =>
        Incoming ? Visibility.Visible : Visibility.Collapsed;
}
