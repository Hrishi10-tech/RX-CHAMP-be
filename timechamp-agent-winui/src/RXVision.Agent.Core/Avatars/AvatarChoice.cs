namespace RXVision.Agent.Core.Avatars;

/// <summary>
/// The agent's default is the RX mark, not a gender default (D-85). The server answers other people
/// with their choice, or their gender's default when they have none; the agent reads a default as
/// no choice. The person's own circle uses their exact stored choice (<c>chosenAvatarId</c>).
/// </summary>
public static class AvatarChoice
{
    /// <summary>The library defaults: M01 and F01.</summary>
    public static bool IsLibraryDefault(string? id) => id is "M01" or "F01";

    /// <summary>What to draw for an ID the server gave: the avatar, or null for the RX mark.</summary>
    public static string? Shown(string? id) => string.IsNullOrEmpty(id) || IsLibraryDefault(id) ? null : id;
}
