using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Platform.Mac;

/// <summary>
/// macOS implementation of <see cref="IPlatform"/>. Every probe is built once here
/// and none throws out of its members (they log and return a safe default), as the
/// seam requires. The UI constructs this with <c>new MacPlatform()</c> on macOS.
/// </summary>
[SupportedOSPlatform("macos")]
public sealed class MacPlatform : IPlatform
{
    private readonly MacPaths _paths;
    private readonly ILog _log;
    private readonly MacIdleProbe _idle;
    private readonly MacLockProbe _lock;
    private readonly MacSleepClock _sleep;
    private readonly MacForegroundProbe _foreground;
    private readonly MacCallWindowProbe _callWindows;
    private readonly MacScreenCapture _screen;
    private readonly MacSecretStore _secrets;
    private readonly MacAutostart _autostart;
    private readonly MacPermissions _permissions;
    private readonly MacSoundPlayer _sound;
    private readonly MacScreenInfo _screenInfo;
    private readonly MacUpdateInstaller _updater;
    private readonly MacShell _shell;
    private readonly MacLegacyMigration _legacy;

    public MacPlatform() : this(null) { }

    /// <summary>The log is optional so the UI can call <c>new MacPlatform()</c>; by
    /// default platform diagnostics roll into agent-mac.log beside the app logs.</summary>
    public MacPlatform(ILog? log)
    {
        _paths = new MacPaths();
        _log = log ?? SafeDefaultLog(_paths.LogDir);

        _idle = new MacIdleProbe();
        _lock = new MacLockProbe(_log);
        _sleep = new MacSleepClock();
        _foreground = new MacForegroundProbe(_log);
        _callWindows = new MacCallWindowProbe(_log);
        _screen = new MacScreenCapture(_paths.TempDir, _log);
        _secrets = new MacSecretStore(_paths.DataDir, _log);
        _autostart = new MacAutostart(_paths.AppDir, _log);
        _permissions = new MacPermissions(_paths.DataDir, _log);
        _sound = new MacSoundPlayer(_paths.AppDir, _log);
        _screenInfo = new MacScreenInfo();
        _updater = new MacUpdateInstaller(_paths.AppDir, _paths.TempDir, _paths.LogDir, _paths.DataDir, _log);
        _shell = new MacShell(_log);
        _legacy = new MacLegacyMigration();

        // Throttled timers would delay samples and heartbeats; never let that happen.
        MacAppNap.Prevent(_log);
    }

    public string Name => "mac";

    public string UpdateChannel =>
        RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "mac" : "mac-x64";

    public IPaths Paths => _paths;
    public IIdleProbe Idle => _idle;
    public ILockProbe Lock => _lock;
    public ISleepClock SleepClock => _sleep;
    public IForegroundProbe Foreground => _foreground;
    public ICallWindowProbe CallWindows => _callWindows;
    public IScreenCapture Screen => _screen;
    public ISecretStore Secrets => _secrets;
    public IAutostart Autostart => _autostart;
    public IPermissions Permissions => _permissions;
    public ISoundPlayer Sound => _sound;
    public IScreenInfo ScreenInfo => _screenInfo;
    public IUpdateInstaller Updater => _updater;
    public IShell Shell => _shell;
    public ILegacyMigration Legacy => _legacy;

    private static ILog SafeDefaultLog(string logDir)
    {
        try { return new RollingFileLog(logDir, "agent-mac"); }
        catch { return NullLog.Instance; }
    }
}
