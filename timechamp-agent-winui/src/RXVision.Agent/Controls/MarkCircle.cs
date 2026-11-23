using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using RXVision.Agent.Icon;

namespace RXVision.Agent.Controls;

/// <summary>
/// The grey RX mark on its own, for the picker's "RX logo" choice (D-84, D-85). Wherever a person's
/// circle shows, PersonAvatar draws their avatar, or this same mark when they have none.
/// </summary>
public sealed class MarkCircle : Control
{
    public override void Render(DrawingContext context)
    {
        var size = Math.Min(Bounds.Width, Bounds.Height);
        if (size <= 0) return;
        RxMark.DrawInCircle(context, new Point(Bounds.Width / 2, Bounds.Height / 2), size);
    }
}
