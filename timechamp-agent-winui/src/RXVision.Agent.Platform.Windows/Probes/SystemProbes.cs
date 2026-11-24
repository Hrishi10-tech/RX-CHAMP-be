using System.Diagnostics;
using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Platform.Windows.Native;

namespace RXVision.Agent.Platform.Windows.Probes;

/// <summary>Start-at-login via the HKCU Run key. Enabling also removes the 2.x value.</summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsAutostart : IAutostart
{
    private const string ValueName = "RXVision";
    private const string LegacyValueName = "TimeChampAgent";
    private readonly Action<string>? _log;

    public WindowsAutostart(Action<string>? log) => _log = log;

    public bool IsEnabled()
    {
        try { return RunKeyRegistry.Get(ValueName) is not null; }
        catch (Exception ex) { _log?.Invoke($"autostart: read failed: {ex.Message}"); return false; }
    }

    public void Enable()
    {
        try
        {
            var exe = Environment.ProcessPath;
            if (string.IsNullOrEmpty(exe)) return;
            RunKeyRegistry.Set(ValueName, $"\"{exe}\" --minimized");
            // The 2.x value pointed at the old exe; leaving it would launch both.
            RunKeyRegistry.Delete(LegacyValueName);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"autostart: enable failed: {ex.Message}");
        }
    }

    public void Disable()
    {
        try { RunKeyRegistry.Delete(ValueName); }
        catch (Exception ex) { _log?.Invoke($"autostart: disable failed: {ex.Message}"); }
    }
}

/// <summary>Windows has no per-app privacy permissions to request; everything is NotApplicable.</summary>
internal sealed class WindowsPermissions : IPermissions
{
    public PermissionState ScreenRecording => PermissionState.NotApplicable;
    public PermissionState Accessibility => PermissionState.NotApplicable;
    public void RequestScreenRecording() { }
    public void OpenScreenRecordingSettings() { }
    public void OpenAccessibilitySettings() { }
}

/// <summary>True while a full-screen app, a game, or a presentation owns the screen.</summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsScreenInfo : IScreenInfo
{
    public bool IsFullScreenAppInFront()
    {
        try
        {
            if (NativeMethods.SHQueryUserNotificationState(out var state) != 0) return false;
            return state is NativeMethods.QUNS_BUSY
                or NativeMethods.QUNS_RUNNING_D3D_FULL_SCREEN
                or NativeMethods.QUNS_PRESENTATION_MODE;
        }
        catch
        {
            return false;
        }
    }
}

/// <summary>Plays the break chime from Assets\chime.wav in the app folder, asynchronously.</summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsSoundPlayer : ISoundPlayer
{
    private readonly string _appDir;
    private readonly Action<string>? _log;

    public WindowsSoundPlayer(string appDir, Action<string>? log)
    {
        _appDir = appDir;
        _log = log;
    }

    public void PlayChime()
    {
        try
        {
            var wav = Path.Combine(_appDir, "Assets", "chime.wav");
            if (File.Exists(wav) &&
                NativeMethods.PlaySoundW(wav, IntPtr.Zero, NativeMethods.SND_ASYNC | NativeMethods.SND_FILENAME | NativeMethods.SND_NODEFAULT))
            {
                return;
            }
            NativeMethods.MessageBeep(NativeMethods.MB_OK);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"sound: chime failed: {ex.Message}");
        }
    }
}

/// <summary>
/// Hands the verified installer to the OS to replace this install. A version already
/// handed over in the last day is not run again (see <see cref="UpdateAttempt"/>):
/// the installer rolls a build that will not start back, and without this the
/// relaunched agent would download and run the same installer again a minute later.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsUpdateInstaller : IUpdateInstaller
{
    private readonly string _attemptFile;
    private readonly string _downloadDir;
    private readonly Action<string>? _log;

    /// <param name="stateDir">A per-machine folder for the attempt record (%LOCALAPPDATA%\RXVision).</param>
    /// <param name="downloadDir">The agent's scratch folder, where updates are downloaded (IPaths.TempDir).</param>
    public WindowsUpdateInstaller(string stateDir, string downloadDir, Action<string>? log)
    {
        _attemptFile = Path.Combine(stateDir, UpdateAttempt.FileName);
        _downloadDir = downloadDir;
        _log = log;
    }

    public bool CanSelfUpdate => true;

    public bool Launch(string verifiedFile, string version)
    {
        try
        {
            string? record = null;
            try { if (File.Exists(_attemptFile)) record = File.ReadAllText(_attemptFile); }
            catch { /* unreadable: treat as no record */ }
            if (UpdateAttempt.RecentlyTried(record, version, DateTimeOffset.UtcNow))
            {
                _log?.Invoke($"update: {version} was handed to the installer within the last day and did not take; not running it again yet");
                return false;
            }

            // Recorded before the start: once the installer runs, this process is stopped.
            // A record that cannot be written only loses the loop guard, not the update.
            try { File.WriteAllText(_attemptFile, UpdateAttempt.Record(version, DateTimeOffset.UtcNow)); }
            catch (Exception ex) { _log?.Invoke($"update: could not record the attempt: {ex.Message}"); }
            DeleteStaleInstallers(verifiedFile);
            // Its own folder as the working directory: inheriting this process's (often
            // the app folder) would keep the installer from moving that folder aside.
            var psi = new ProcessStartInfo(verifiedFile)
            {
                UseShellExecute = true,
                WorkingDirectory = Path.GetDirectoryName(verifiedFile) ?? _downloadDir,
            };
            psi.ArgumentList.Add("--update");
            using var installer = Process.Start(psi);
            if (installer is not null) return true;
            TryDelete(_attemptFile);
            return false;
        }
        catch (Exception ex)
        {
            // It never ran, so it must not count as an attempt.
            TryDelete(_attemptFile);
            _log?.Invoke($"update: launch of {version} failed: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Every update leaves its installer (about 80 MB) in the download folder, and nothing
    /// else removes them. Before the next one runs, the earlier ones go: only
    /// rxvision-*.exe in the agent's own scratch folder, never the file about to run.
    /// </summary>
    private void DeleteStaleInstallers(string verifiedFile)
    {
        try
        {
            var current = Path.GetFullPath(verifiedFile);
            var dir = Path.GetDirectoryName(current);
            if (dir is null || !string.Equals(Path.TrimEndingDirectorySeparator(dir),
                    Path.TrimEndingDirectorySeparator(Path.GetFullPath(_downloadDir)), StringComparison.OrdinalIgnoreCase))
                return;
            foreach (var file in Directory.EnumerateFiles(dir, "rxvision-*.exe"))
            {
                if (string.Equals(Path.GetFullPath(file), current, StringComparison.OrdinalIgnoreCase)) continue;
                TryDelete(file);
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"update: could not clear old installers: {ex.Message}");
        }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }
    }
}

/// <summary>Opens a URL in the default browser.</summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsShell : IShell
{
    private readonly Action<string>? _log;

    public WindowsShell(Action<string>? log) => _log = log;

    public void OpenUrl(string url)
    {
        // Only real web and mail links: ShellExecute would also run a local
        // program or open a file:// path handed to it.
        if (string.IsNullOrWhiteSpace(url) ||
            !Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https" or "mailto"))
        {
            _log?.Invoke("shell: refusing to open a non-web url");
            return;
        }
        try
        {
            using var _ = Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            _log?.Invoke($"shell: open url failed: {ex.Message}");
        }
    }

    public void RevealFile(string path)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path) || !File.Exists(path))
            {
                _log?.Invoke("shell: nothing to show");
                return;
            }
            // Explorer opens the folder with the file selected; it never runs it.
            // (A Windows path cannot contain a double quote, so the quoting is safe.)
            var explorer = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
            using var _ = Process.Start(new ProcessStartInfo(explorer, $"/select,\"{path}\"") { UseShellExecute = false });
        }
        catch (Exception ex)
        {
            _log?.Invoke($"shell: reveal failed: {ex.Message}");
        }
    }
}
