using RXVision.Agent.Core;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Services;

/// <summary>What Program hands the Avalonia app: the agent and everything it was built from.</summary>
public sealed record StartupContext(
    IPlatform Platform,
    AgentOptions Options,
    ILog Log,
    AgentHost Host,
    SingleInstance? Instance,
    bool StartMinimized);

/// <summary>Picks the OS implementation at runtime.</summary>
public static class PlatformFactory
{
    /// <summary>
    /// Windows: WindowsPlatform; macOS: MacPlatform; anything else, or
    /// RXV_PLATFORM=dev (Debug builds only): DevPlatform (nothing real is recorded). Diagnostics from
    /// the platform go to <paramref name="log"/> once it has a target.
    /// </summary>
    public static IPlatform Create(DeferredLog log)
    {
#if DEBUG
        // Debug builds only (security review S-03): in a release build anyone could set this
        // variable and have the agent report a fake, never idle day with blank screenshots.
        var requested = Environment.GetEnvironmentVariable("RXV_PLATFORM");
        if (string.Equals(requested, "dev", StringComparison.OrdinalIgnoreCase)) return new DevPlatform();
#endif
#if !RXV_NO_PLATFORMS
        if (OperatingSystem.IsWindows()) return new global::RXVision.Agent.Platform.Windows.WindowsPlatform(message => log.Info("platform", message));
        if (OperatingSystem.IsMacOS()) return new global::RXVision.Agent.Platform.Mac.MacPlatform(log);
#endif
        return new DevPlatform();
    }
}

/// <summary>A log that forwards to a target set later (the platform is created before the log it decides the folder of).</summary>
public sealed class DeferredLog : ILog
{
    private ILog? _target;

    public void SetTarget(ILog target) => _target = target;

    public void Write(LogLevel level, string area, string message, Exception? error = null) =>
        _target?.Write(level, area, message, error);
}
