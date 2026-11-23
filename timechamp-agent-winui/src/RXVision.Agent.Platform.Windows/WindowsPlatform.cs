using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Platform.Windows.Probes;

namespace RXVision.Agent.Platform.Windows;

/// <summary>
/// Windows implementation of <see cref="IPlatform"/>: idle, lock, sleep, the
/// foreground window and browser host, screen capture, DPAPI secrets,
/// start-at-login, the chime, full-screen detection, self-update, and migration
/// from the 2.x agent.
///
/// The UI constructs this with <c>new WindowsPlatform()</c> on Windows. An optional
/// <paramref name="log"/> receives one-line diagnostics from the probes (they never
/// throw, per the <see cref="IPlatform"/> contract); pass null to discard them. The
/// platform layer has no access to Core's <c>ILog</c>, which is handed to services,
/// so this plain callback is how the UI can route platform diagnostics into its own log.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsPlatform : IPlatform
{
    public WindowsPlatform(Action<string>? log = null)
    {
        var paths = new WindowsPaths();
        Paths = paths;
        Idle = new WindowsIdleProbe();
        Lock = new WindowsLockProbe(log);
        SleepClock = new WindowsSleepClock(new WindowsSleepSource());
        Foreground = new WindowsForegroundProbe(log);
        CallWindows = new WindowsCallWindowProbe(log);
        Screen = new WindowsScreenCapture(log);
        Secrets = new WindowsSecretStore(paths.DataDir, log);
        Autostart = new WindowsAutostart(log);
        Permissions = new WindowsPermissions();
        Sound = new WindowsSoundPlayer(paths.AppDir, log);
        ScreenInfo = new WindowsScreenInfo();
        Updater = new WindowsUpdateInstaller(Path.GetDirectoryName(paths.TempDir) ?? paths.TempDir, paths.TempDir, log);
        Shell = new WindowsShell(log);
        Legacy = new WindowsLegacyMigration(log);
    }

    public string Name => "windows";
    public string UpdateChannel => "windows";

    public IPaths Paths { get; }
    public IIdleProbe Idle { get; }
    public ILockProbe Lock { get; }
    public ISleepClock SleepClock { get; }
    public IForegroundProbe Foreground { get; }
    public ICallWindowProbe CallWindows { get; }
    public IScreenCapture Screen { get; }
    public ISecretStore Secrets { get; }
    public IAutostart Autostart { get; }
    public IPermissions Permissions { get; }
    public ISoundPlayer Sound { get; }
    public IScreenInfo ScreenInfo { get; }
    public IUpdateInstaller Updater { get; }
    public IShell Shell { get; }
    public ILegacyMigration Legacy { get; }
}
