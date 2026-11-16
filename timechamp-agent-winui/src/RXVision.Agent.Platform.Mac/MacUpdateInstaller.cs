using System.Runtime.Versioning;
using System.Text;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Update;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Platform.Mac.Native;

namespace RXVision.Agent.Platform.Mac;

/// <summary>
/// Self-update for an app that can replace its own bundle. The verified .zip is
/// expanded with ditto, the new bundle's identity and version are checked against
/// what we expect, quarantine is stripped, and a small detached script does the
/// swap after this process exits (then relaunches). We only claim CanSelfUpdate
/// when the folder holding the bundle is writable by this user.
/// </summary>
[SupportedOSPlatform("macos")]
internal sealed class MacUpdateInstaller : IUpdateInstaller
{
    internal const string ExpectedBundleId = "com.rxvision.agent";
    private readonly string _appDir;
    private readonly string _tempDir;
    private readonly string _logDir;
    private readonly string _dataDir;
    private readonly ILog _log;

    public MacUpdateInstaller(string appDir, string tempDir, string logDir, string dataDir, ILog log)
    {
        _appDir = appDir;
        _tempDir = tempDir;
        _logDir = logDir;
        _dataDir = dataDir;
        _log = log;
    }

    public bool CanSelfUpdate
    {
        get
        {
            try
            {
                var bundle = BundlePath();
                if (bundle is null) return false;
                var parent = Path.GetDirectoryName(bundle);
                if (string.IsNullOrEmpty(parent)) return false;
                return LibSystem.access(parent, LibSystem.W_OK) == 0;
            }
            catch
            {
                return false;
            }
        }
    }

    public bool Launch(string verifiedFile, string version)
    {
        try
        {
            var oldBundle = BundlePath();
            if (oldBundle is null)
            {
                _log.Warn("update", "not running from a .app bundle; cannot self-update");
                return false;
            }

            // What earlier updates left behind (their zips, unpack folders and scripts) goes first.
            DeleteStaleDownloads(verifiedFile);
            var extractDir = Path.Combine(_tempDir, $"update-{Guid.NewGuid():N}");
            Directory.CreateDirectory(extractDir);

            var unzip = ProcessRunner.Run("/usr/bin/ditto", new[] { "-x", "-k", verifiedFile, extractDir }, TimeSpan.FromMinutes(2));
            if (!unzip.Ok)
            {
                _log.Warn("update", $"ditto expand failed ({unzip.ExitCode}): {unzip.StdErr}");
                TryDeleteDir(extractDir);
                return false;
            }

            var newBundle = FindBundle(extractDir);
            if (newBundle is null)
            {
                _log.Warn("update", "no .app found in the downloaded archive");
                TryDeleteDir(extractDir);
                return false;
            }

            if (!VerifyBundle(newBundle, version))
            {
                TryDeleteDir(extractDir);
                return false;
            }

            // Strip the quarantine flag so the swapped-in copy is not treated as an
            // untrusted download on relaunch.
            ProcessRunner.Run("/usr/bin/xattr", new[] { "-dr", "com.apple.quarantine", newBundle }, TimeSpan.FromSeconds(20));

            var scriptPath = Path.Combine(_tempDir, $"rxvision-update-{Guid.NewGuid():N}.sh");
            var logPath = Path.Combine(_logDir, "update.log");
            var script = MacUpdateScript.Build(Environment.ProcessId, oldBundle, newBundle, logPath, VersionText.Clean(version),
                Path.Combine(_dataDir, UpdateService.RunningFileName), extractDir, verifiedFile);
            File.WriteAllBytes(scriptPath, Encoding.UTF8.GetBytes(script));
            try { File.SetUnixFileMode(scriptPath, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute); } catch { }

            var started = ProcessRunner.Launch("/bin/bash", new[] { scriptPath }, logPath);
            if (!started)
            {
                _log.Warn("update", "could not start the update script");
                return false;
            }
            _log.Info("update", $"update script started for {version}; exiting for the swap");
            return true;
        }
        catch (Exception ex)
        {
            _log.Warn("update", "self-update launch failed", ex);
            return false;
        }
    }

    /// <summary>The .app we are running from (.../RX Vision.app), or null when not in a bundle.</summary>
    private string? BundlePath()
    {
        try
        {
            // AppDir is .../RX Vision.app/Contents/MacOS - go up two levels.
            var macOs = _appDir.TrimEnd(Path.DirectorySeparatorChar);
            var contents = Path.GetDirectoryName(macOs);
            var bundle = contents is null ? null : Path.GetDirectoryName(contents);
            if (bundle is not null && bundle.EndsWith(".app", StringComparison.OrdinalIgnoreCase))
                return bundle;
            return null;
        }
        catch
        {
            return null;
        }
    }

    private static string? FindBundle(string dir)
    {
        try
        {
            var top = Directory.GetDirectories(dir, "*.app", SearchOption.TopDirectoryOnly);
            if (top.Length > 0) return top[0];
            var nested = Directory.GetDirectories(dir, "*.app", SearchOption.AllDirectories);
            return nested.Length > 0 ? nested[0] : null;
        }
        catch
        {
            return null;
        }
    }

    private bool VerifyBundle(string bundle, string expectedVersion)
    {
        var infoPlist = Path.Combine(bundle, "Contents", "Info.plist");
        if (!File.Exists(infoPlist))
        {
            _log.Warn("update", "new bundle has no Contents/Info.plist");
            return false;
        }

        var id = PlistValue(infoPlist, "CFBundleIdentifier");
        if (!string.Equals(id, ExpectedBundleId, StringComparison.Ordinal))
        {
            _log.Warn("update", $"new bundle identifier '{id}' is not '{ExpectedBundleId}'");
            return false;
        }

        var shortVer = VersionText.Clean(PlistValue(infoPlist, "CFBundleShortVersionString") ?? "");
        var bundleVer = VersionText.Clean(PlistValue(infoPlist, "CFBundleVersion") ?? "");
        var want = VersionText.Clean(expectedVersion);
        if (want.Length > 0 && want != shortVer && want != bundleVer)
        {
            _log.Warn("update", $"new bundle version ({shortVer}/{bundleVer}) does not match expected {want}");
            return false;
        }
        return true;
    }

    private static string? PlistValue(string plistPath, string key)
    {
        var r = ProcessRunner.Run("/usr/bin/plutil", new[] { "-extract", key, "raw", "-o", "-", plistPath }, TimeSpan.FromSeconds(10));
        if (!r.Ok) return null;
        var value = r.StdOut.Trim();
        return value.Length == 0 ? null : value;
    }

    private void TryDeleteDir(string dir)
    {
        try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); } catch { }
    }

    private void DeleteStaleDownloads(string keep) => MacUpdateFiles.DeleteStaleDownloads(_tempDir, keep);
}
