using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Platform.Dev;

namespace RXVision.Agent.E2E.Tests;

/// <summary>
/// The dev platform with two changes for running against a real server: the secret
/// store is on disk (like the Windows store, protected files in the user's profile), so
/// a new agent "process" made from the same folder reads the same keys and journal; and
/// the screen is never captured, so nothing is uploaded.
/// </summary>
public sealed class E2EPlatform : IPlatform, IScreenCapture
{
    public E2EPlatform(string root)
    {
        Root = root;
        Dev = new DevPlatform(root);
        Secrets = new DiskSecrets(Path.Combine(root, "secrets"));
    }

    public string Root { get; }
    public DevPlatform Dev { get; }
    public DiskSecrets Secrets { get; }

    /// <summary>As the Windows build calls itself (the User-Agent says "RXVisionAgent/4.0.0 (windows)").</summary>
    public string Name => "windows";
    public string UpdateChannel => "windows";
    public IPaths Paths => Dev.Paths;
    public IIdleProbe Idle => Dev.Idle;
    public ILockProbe Lock => Dev.Lock;
    public ISleepClock SleepClock => Dev.SleepClock;
    public IForegroundProbe Foreground => Dev.Foreground;
    public IScreenCapture Screen => this;
    ISecretStore IPlatform.Secrets => Secrets;
    public IAutostart Autostart => Dev.Autostart;
    public IPermissions Permissions => Dev.Permissions;
    public ISoundPlayer Sound => Dev.Sound;
    public IScreenInfo ScreenInfo => Dev.ScreenInfo;
    public IUpdateInstaller Updater => Dev.Updater;
    public IShell Shell => Dev.Shell;
    public ILegacyMigration Legacy => Dev.Legacy;

    public int Captures { get; private set; }

    public CapturedImage? Capture(int maxLongSide, int quality)
    {
        Captures++;
        return null;
    }
}

/// <summary>Secrets as files in a folder: they outlive the process, as the OS stores do.</summary>
public sealed class DiskSecrets : ISecretStore
{
    private readonly string _dir;
    private readonly object _gate = new();

    public DiskSecrets(string dir)
    {
        _dir = dir;
        Directory.CreateDirectory(dir);
    }

    private string PathOf(string key) => Path.Combine(_dir, Convert.ToHexString(System.Text.Encoding.UTF8.GetBytes(key)) + ".bin");

    public void Save(string key, byte[] data)
    {
        lock (_gate) File.WriteAllBytes(PathOf(key), data);
    }

    public byte[]? Load(string key)
    {
        lock (_gate) return File.Exists(PathOf(key)) ? File.ReadAllBytes(PathOf(key)) : null;
    }

    public void Delete(string key)
    {
        lock (_gate)
        {
            if (File.Exists(PathOf(key))) File.Delete(PathOf(key));
        }
    }
}
