using Avalonia.Media.Imaging;
using RXVision.Agent.Icon;

namespace RXVision.Agent.Services;

/// <summary>
/// The person on the floating icon: what the icon asks for at each display scale, and when to
/// draw again. A save, a push from another device, an admin's reset and a gender change all land
/// on <see cref="Changed"/>, a save before the server has answered.
/// </summary>
public sealed class AvatarIconSource : IIconAvatarSource
{
    private readonly IAgent _agent;
    private readonly AvatarImages _images;

    public AvatarIconSource(IAgent agent, AvatarImages? images = null)
    {
        _agent = agent;
        _images = images ?? AvatarImages.Shared;
        _agent.Avatars.Changed += () => Changed?.Invoke();
    }

    /// <summary>The avatar's manifest ID, or null for the RX mark.</summary>
    public string? AvatarId => _agent.Avatars.ShownId;

    /// <summary>The picture for a circle this many device pixels across, read from the bundle, scaled and kept; null for the RX mark.</summary>
    public Bitmap? Picture(int devicePixels) => _images.Get(AvatarId, devicePixels);

    /// <summary>The picture changed: the icon draws again.</summary>
    public event Action? Changed;
}
