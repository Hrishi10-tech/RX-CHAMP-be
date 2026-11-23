using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Platform.Mac;

/// <summary>Opens URLs with the system <c>open</c> command.</summary>
[SupportedOSPlatform("macos")]
internal sealed class MacShell : IShell
{
    private readonly ILog _log;

    public MacShell(ILog log) => _log = log;

    public void OpenUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return;
        // Only hand real web/mailto URLs to `open`, never an arbitrary path that
        // could launch something unexpected.
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https" or "mailto"))
        {
            _log.Warn("shell", $"refusing to open non-web url");
            return;
        }
        // AbsoluteUri keeps the escaping (ToString() would turn %20 back into a
        // space, and `open` then reads the argument as a file path).
        if (!ProcessRunner.Launch("/usr/bin/open", new[] { uri.AbsoluteUri }))
            _log.Warn("shell", "open failed");
    }

    public void RevealFile(string path)
    {
        // `open -R` selects the file in Finder; it never opens or runs it.
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path) || !File.Exists(path))
        {
            _log.Warn("shell", "nothing to show");
            return;
        }
        if (!ProcessRunner.Launch("/usr/bin/open", new[] { "-R", path }))
            _log.Warn("shell", "reveal failed");
    }
}

/// <summary>There is no older macOS agent to migrate from: everything is a no-op.</summary>
internal sealed class MacLegacyMigration : ILegacyMigration
{
    public LegacySession? TryReadSession() => null;
    public EnrollmentConfig? TryReadEnrollment() => null;
    public void Cleanup() { }
}
