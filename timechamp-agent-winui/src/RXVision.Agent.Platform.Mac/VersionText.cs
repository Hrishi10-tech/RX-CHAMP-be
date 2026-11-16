namespace RXVision.Agent.Platform.Mac;

/// <summary>Pure version-string normalisation, shared by the updater and unit-tested on any OS.</summary>
internal static class VersionText
{
    /// <summary>Drops a leading v/V and any -prerelease or +build suffix: "v3.0.0-beta+7" -> "3.0.0".</summary>
    internal static string Clean(string? v)
    {
        var trimmed = (v ?? "").Trim().TrimStart('v', 'V');
        var cut = trimmed.IndexOfAny(new[] { '-', '+' });
        return cut >= 0 ? trimmed[..cut] : trimmed;
    }
}
