using Avalonia;
using Avalonia.Media;
using RXVision.Agent.Icon;
using RXVision.Agent.Services;

namespace RXVision.Agent.Controls;

/// <summary>Draws a person in a circle: their chosen avatar, else the RX mark (AGENT.md section 7, D-85).</summary>
internal static class AvatarPainter
{
    public static void Draw(DrawingContext context, Rect circle, string? avatarId, double scale)
    {
        var image = AvatarImages.Shared.Get(avatarId, (int)Math.Ceiling(circle.Width * scale));
        if (image is not null)
        {
            // Masters are transparent outside the circle; still clip to it.
            using (context.PushGeometryClip(new EllipseGeometry(circle))) context.DrawImage(image, circle);
            return;
        }
        RxMark.DrawInCircle(context, circle.Center, circle.Width);
    }
}
