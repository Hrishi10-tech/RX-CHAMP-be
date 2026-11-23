using System.Collections.Concurrent;

namespace RXVision.Agent.Core.Platform.Dev;

/// <summary>
/// A stand-in OS for tests and for running the app on a developer box (Linux):
/// everything works, nothing is real. Values can be steered from tests.
/// </summary>
public sealed class DevPlatform : IPlatform, IPaths, IIdleProbe, ILockProbe, ISleepClock, IForegroundProbe, ICallWindowProbe,
    IScreenCapture, ISecretStore, IAutostart, IPermissions, IScreenInfo, IUpdateInstaller, IShell, ILegacyMigration
{
    private readonly ConcurrentDictionary<string, byte[]> _secrets = new();
    private bool _locked;

    public DevPlatform(string? root = null)
    {
        var baseDir = root ?? Path.Combine(Path.GetTempPath(), "rxvision-dev-" + Environment.UserName);
        DataDir = Path.Combine(baseDir, "data");
        LogDir = Path.Combine(baseDir, "logs");
        TempDir = Path.Combine(baseDir, "tmp");
        AppDir = AppContext.BaseDirectory;
        foreach (var d in new[] { DataDir, LogDir, TempDir }) Directory.CreateDirectory(d);
    }

    public string Name => "dev";
    public string UpdateChannel => "windows";
    public IPaths Paths => this;
    public IIdleProbe Idle => this;
    public ILockProbe Lock => this;
    public ISleepClock SleepClock => this;
    public IForegroundProbe Foreground => this;
    public ICallWindowProbe CallWindows => this;
    public IScreenCapture Screen => this;
    public ISecretStore Secrets => SecretsOverride ?? this;
    /// <summary>Tests: another secret store in place of the in-memory one (a Keychain that hangs).</summary>
    public ISecretStore? SecretsOverride { get; set; }
    public IAutostart Autostart => this;
    public IPermissions Permissions => this;
    public IScreenInfo ScreenInfo => this;
    public IUpdateInstaller Updater => this;
    public IShell Shell => this;
    public ILegacyMigration Legacy => this;

    // Paths
    public string DataDir { get; }
    public string LogDir { get; }
    public string AppDir { get; set; }
    public string TempDir { get; }

    // Steering for tests
    public TimeSpan IdleFor { get; set; } = TimeSpan.Zero;
    public ForegroundInfo Front { get; set; } = new("Visual Studio Code", "AgentHost.cs - rxvision", null);
    /// <summary>The windows the call detectors read.</summary>
    public List<CallWindow> Windows { get; set; } = new();
    /// <summary>Every browser's tab titles, for a call whose tab is behind another.</summary>
    public List<string> Tabs { get; set; } = new();
    /// <summary>The owners the call detectors asked about, each read.</summary>
    public List<IReadOnlyCollection<string>> WindowReads { get; } = new();
    public int TabReads { get; private set; }
    public TimeSpan? NextSleep { get; set; }
    public TimeSpan ProbeDelay { get; set; } = TimeSpan.Zero;
    public bool AutostartOn { get; private set; }
    public List<string> OpenedUrls { get; } = new();
    public List<string> RevealedFiles { get; } = new();

    public void SetLocked(bool locked)
    {
        _locked = locked;
        Changed?.Invoke(locked);
    }

    public TimeSpan IdleTime() => IdleFor;

    public bool IsLocked => _locked;
    public event Action<bool>? Changed;
    public void Start() { }
    public void Stop() { }

    public void Prime() { }
    public TimeSpan? SleptSinceLastCall()
    {
        var s = NextSleep;
        NextSleep = null;
        return s;
    }

    public ForegroundInfo Snapshot(bool includeUrl)
    {
        if (ProbeDelay > TimeSpan.Zero) Thread.Sleep(ProbeDelay);
        return includeUrl ? Front : Front with { Url = null };
    }

    /// <summary>Tests: while set and not signalled, window reads block (a hung browser).</summary>
    public ManualResetEventSlim? WindowGate { get; set; }

    public IReadOnlyList<CallWindow> WindowsOf(IReadOnlyCollection<string> owners)
    {
        lock (WindowReads) WindowReads.Add(owners);
        WindowGate?.Wait();
        return Windows.Where(w => owners.Contains(w.Owner, StringComparer.OrdinalIgnoreCase)).ToList();
    }

    public IReadOnlyList<string> TabTitlesOf(string browserOwner)
    {
        TabReads++;
        return Tabs;
    }

    /// <summary>A tiny valid JPEG (1x1), enough for the server's type check.</summary>
    public static readonly byte[] TinyJpeg = Convert.FromBase64String(
        "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=");

    public int Captures { get; private set; }

    public CapturedImage? Capture(int maxLongSide, int quality)
    {
        Captures++;
        return new(TinyJpeg, "image/jpeg", 1, 1);
    }

    public void Save(string key, byte[] data) => _secrets[key] = data;
    public byte[]? Load(string key) => _secrets.TryGetValue(key, out var v) ? v : null;
    public void Delete(string key) => _secrets.TryRemove(key, out _);

    public bool IsEnabled() => AutostartOn;
    public void Enable() => AutostartOn = true;
    public void Disable() => AutostartOn = false;

    public PermissionState ScreenRecording => PermissionState.NotApplicable;
    public PermissionState Accessibility => PermissionState.NotApplicable;
    public void RequestScreenRecording() { }
    public void OpenScreenRecordingSettings() { }
    public void OpenAccessibilitySettings() { }


    public bool IsFullScreenAppInFront() => false;

    public bool CanSelfUpdate => false;
    public bool Launch(string verifiedFile, string version) => false;

    public void OpenUrl(string url) => OpenedUrls.Add(url);
    public void RevealFile(string path) => RevealedFiles.Add(path);

    public LegacySession? TryReadSession() => null;
    public EnrollmentConfig? TryReadEnrollment() => null;
    public void Cleanup() { }
}
