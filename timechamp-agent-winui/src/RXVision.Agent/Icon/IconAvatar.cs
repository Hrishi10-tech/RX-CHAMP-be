using Avalonia.Media.Imaging;
using RXVision.Agent.Services;

namespace RXVision.Agent.Icon;

/// <summary>
/// Where the icon gets the person's picture: the seam the avatar library fills (AGENT.md section 7).
/// The icon asks at each display scale and draws what it gets inside the same bezel; a null picture
/// draws the initials. Nothing else in the icon knows where a picture comes from.
/// </summary>
public interface IIconAvatarSource
{
    /// <summary>The picture for a circle this many device pixels across, scaled and cached by the source; null for initials.</summary>
    Bitmap? Picture(int devicePixels);

    /// <summary>1 or 2 letters, for when there is no picture.</summary>
    string Initials { get; }

    /// <summary>The picture or the initials changed: the icon draws again.</summary>
    event Action? Changed;
}

/// <summary>The person's initials and no picture, until the avatar library is in.</summary>
public sealed class InitialsAvatarSource : IIconAvatarSource
{
    private readonly IAgent _agent;

    public InitialsAvatarSource(IAgent agent) => _agent = agent;

    public Bitmap? Picture(int devicePixels) => null;

    public string Initials => Fmt.Initials(_agent.User?.DisplayName);

    /// <summary>Initials are read on each drawing: this source has nothing to announce.</summary>
    public event Action? Changed { add { } remove { } }
}
