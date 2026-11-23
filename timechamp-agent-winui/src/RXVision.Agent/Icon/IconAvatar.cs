using Avalonia.Media.Imaging;

namespace RXVision.Agent.Icon;

/// <summary>
/// Where the icon gets the person's picture: the seam <see cref="Services.AvatarIconSource"/> fills (AGENT.md section 7).
/// The icon asks at each display scale and draws what it gets inside the same bezel; a null picture
/// draws the RX mark, the default (D-85). Nothing else in the icon knows where a picture comes from.
/// </summary>
public interface IIconAvatarSource
{
    /// <summary>The picture for a circle this many device pixels across, scaled and cached by the source; null for the RX mark.</summary>
    Bitmap? Picture(int devicePixels);

    /// <summary>The picture changed: the icon draws again.</summary>
    event Action? Changed;
}
