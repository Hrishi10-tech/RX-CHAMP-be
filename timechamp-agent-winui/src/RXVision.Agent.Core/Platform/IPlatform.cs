namespace RXVision.Agent.Core.Platform;

/// <summary>
/// Everything the agent needs from the operating system, behind one seam. The
/// Windows and macOS projects implement it; <c>DevPlatform</c> fakes it for tests
/// and for running the UI on a developer box. Core never calls the OS directly.
///
/// Rules for implementations:
///  - never throw out of a probe: return a safe default and log;
///  - probes may be slow or hang (UI Automation, AppleScript); Core always calls
///    them off the UI thread and with a timeout, so do not add your own threads;
///  - no UI types here, ever.
/// </summary>
public interface IPlatform
{
    /// <summary>"windows", "mac" or "dev". Sent to the server and used for updates.</summary>
    string Name { get; }

    /// <summary>The download channel for updates: windows, mac (Apple Silicon) or mac-x64.</summary>
    string UpdateChannel { get; }

    IPaths Paths { get; }
    IIdleProbe Idle { get; }
    ILockProbe Lock { get; }
    ISleepClock SleepClock { get; }
    IForegroundProbe Foreground { get; }
    IScreenCapture Screen { get; }
    ISecretStore Secrets { get; }
    IAutostart Autostart { get; }
    IPermissions Permissions { get; }
    ISoundPlayer Sound { get; }
    IScreenInfo ScreenInfo { get; }
    IUpdateInstaller Updater { get; }
    IShell Shell { get; }
    ILegacyMigration Legacy { get; }
}

/// <summary>Where the agent keeps its files. All directories exist after construction.</summary>
public interface IPaths
{
    /// <summary>Per-user, per-machine data (never roams): session, queue, device id. Windows: %LOCALAPPDATA%\RXVision\data; macOS: ~/Library/Application Support/RXVision.</summary>
    string DataDir { get; }
    /// <summary>Rolling logs. Windows: %LOCALAPPDATA%\RXVision\logs; macOS: ~/Library/Logs/RXVision.</summary>
    string LogDir { get; }
    /// <summary>Where the running app's files are (AppContext.BaseDirectory by default).</summary>
    string AppDir { get; }
    /// <summary>A scratch directory for downloads and captures.</summary>
    string TempDir { get; }
}

public interface IIdleProbe
{
    /// <summary>Time since the last keyboard or mouse input, system-wide.</summary>
    TimeSpan IdleTime();
}

public interface ILockProbe
{
    /// <summary>True while the session is locked, logged off or at the login window.</summary>
    bool IsLocked { get; }
    /// <summary>Raised on lock and unlock, with the new state. Raised on a background thread.</summary>
    event Action<bool>? Changed;
    void Start();
    void Stop();
}

/// <summary>Detects time the machine spent asleep, independent of wall-clock changes.</summary>
public interface ISleepClock
{
    /// <summary>Start measuring from now (call once when tracking first starts).</summary>
    void Prime();
    /// <summary>How long the machine slept since the previous call (null when it did not, or for under a minute).</summary>
    TimeSpan? SleptSinceLastCall();
}

public sealed record ForegroundInfo(string? App, string? Title, string? Url)
{
    public static readonly ForegroundInfo Empty = new(null, null, null);
}

public interface IForegroundProbe
{
    /// <summary>
    /// The app in front, its window title, and (when <paramref name="includeUrl"/>)
    /// the website host if it is a browser. May block for a while; Core calls it
    /// with a timeout and falls back to app-only.
    /// </summary>
    ForegroundInfo Snapshot(bool includeUrl);
}

public sealed record CapturedImage(byte[] Bytes, string ContentType, int Width, int Height);

public interface IScreenCapture
{
    /// <summary>
    /// Captures every display as one image, scaled so the longest side is at most
    /// <paramref name="maxLongSide"/>, encoded as JPEG at <paramref name="quality"/>.
    /// Null when capture is not possible (no permission, locked, failure).
    /// </summary>
    CapturedImage? Capture(int maxLongSide, int quality);
}

/// <summary>Small secrets (the session, the queue key), protected by the OS for this user.</summary>
public interface ISecretStore
{
    void Save(string key, byte[] data);
    byte[]? Load(string key);
    void Delete(string key);
}

public interface IAutostart
{
    bool IsEnabled();
    void Enable();
    void Disable();
}

public enum PermissionState { Granted, Denied, NotDetermined, NotApplicable }

/// <summary>macOS privacy permissions; Windows reports NotApplicable for everything.</summary>
public interface IPermissions
{
    PermissionState ScreenRecording { get; }
    PermissionState Accessibility { get; }
    /// <summary>Asks the OS to show its prompt (macOS shows it once; afterwards only Settings can change it).</summary>
    void RequestScreenRecording();
    void OpenScreenRecordingSettings();
    void OpenAccessibilitySettings();
}

public interface ISoundPlayer
{
    /// <summary>Plays the break chime once (non-blocking).</summary>
    void PlayChime();
}

public interface IScreenInfo
{
    /// <summary>True while a full-screen app (presentation, video call, game) is in front.</summary>
    bool IsFullScreenAppInFront();
}

public interface IUpdateInstaller
{
    /// <summary>Whether this install can replace itself (false when the app folder is not writable).</summary>
    bool CanSelfUpdate { get; }
    /// <summary>
    /// Hands the verified download to the OS-specific installer. Returns true when
    /// the installer is now running and the app should exit so it can be replaced.
    /// </summary>
    bool Launch(string verifiedFile, string version);
}

public interface IShell
{
    /// <summary>Opens an http(s) or mailto link in the default app. Anything else is refused.</summary>
    void OpenUrl(string url);

    /// <summary>Shows an existing file in Finder or Explorer, selected. Never opens or runs it.</summary>
    void RevealFile(string path);
}

/// <summary>What an older agent (2.x) left behind, read once so an update keeps people signed in.</summary>
public interface ILegacyMigration
{
    /// <summary>The 2.x saved session (refresh token and who), or null.</summary>
    LegacySession? TryReadSession();
    /// <summary>The 2.x per-user enrollment (tc-enroll.json beside the old exe), or null.</summary>
    EnrollmentConfig? TryReadEnrollment();
    /// <summary>Removes the 2.x files once migrated (best effort).</summary>
    void Cleanup();
}

public sealed record LegacySession(string RefreshToken, string UserId, string Email, string DisplayName);

/// <summary>Server URL plus an enrollment token, as baked into a per-user download or a setup code.</summary>
public sealed record EnrollmentConfig(string ApiBaseUrl, string EnrollmentToken);
