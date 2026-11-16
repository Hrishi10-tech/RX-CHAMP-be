using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Platform.Mac.Native;

namespace RXVision.Agent.Platform.Mac;

/// <summary>
/// Start at login via a launchd user agent at
/// ~/Library/LaunchAgents/com.rxvision.agent.plist. Enable writes the plist
/// atomically with the current executable path (so it is idempotent and fixes the
/// path if the app moved); it does NOT bootstrap while the app is running (that
/// would launch a second copy) - launchd picks it up at the next login. A
/// translocated path (app opened from Downloads without moving it) is never
/// written: it vanishes at logout. Disable removes the plist and best-effort boots
/// the job out of the running session, unless that job is this very process
/// (bootout would SIGTERM the app the person is using; it ends at logout anyway).
/// </summary>
[SupportedOSPlatform("macos")]
internal sealed class MacAutostart : IAutostart
{
    private readonly string _appDir;
    private readonly ILog _log;
    private readonly string _plistPath;

    public MacAutostart(string appDir, ILog log)
    {
        _appDir = appDir;
        _log = log;
        var home = Environment.GetEnvironmentVariable("HOME");
        if (string.IsNullOrWhiteSpace(home)) home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        _plistPath = Path.Combine(home ?? "", "Library", "LaunchAgents", LaunchAgentPlist.FileName);
    }

    public bool IsEnabled()
    {
        try { return File.Exists(_plistPath); } catch { return false; }
    }

    public void Enable()
    {
        try
        {
            var exe = ExecutablePath();
            if (!LaunchAgentPlist.IsStableProgramPath(exe))
            {
                _log.Warn("autostart", "running from a temporary (translocated) copy; move RX Vision to Applications so it can start at login");
                return;
            }
            var bytes = Encoding.UTF8.GetBytes(LaunchAgentPlist.Build(exe));
            // Unchanged: leave the file alone (no rewrite on every launch, so no
            // repeated "background item added" notices on macOS 13+).
            if (File.Exists(_plistPath) && File.ReadAllBytes(_plistPath).AsSpan().SequenceEqual(bytes)) return;
            AtomicFile.WriteAllBytes(_plistPath, bytes);
            _log.Info("autostart", "login item written (takes effect at next login)");
        }
        catch (Exception ex)
        {
            _log.Warn("autostart", "could not write the login item", ex);
        }
    }

    public void Disable()
    {
        try
        {
            if (File.Exists(_plistPath)) File.Delete(_plistPath);
        }
        catch (Exception ex)
        {
            _log.Warn("autostart", "could not remove the login item", ex);
        }

        // Best effort: if it is loaded in this session, boot it out so launchd does
        // not restart it. Never when the job's process is this app: bootout sends it
        // SIGTERM, so signing out would make the app vanish instead of showing sign-in.
        try
        {
            var uid = LibSystem.getuid();
            var target = $"gui/{uid}/{LaunchAgentPlist.Label}";
            var print = ProcessRunner.Run("/bin/launchctl", new[] { "print", target }, TimeSpan.FromSeconds(5));
            if (!print.Ok) return; // not loaded (or launchctl unavailable): nothing to stop
            if (LaunchAgentPlist.RunningPid(print.StdOut) == Environment.ProcessId)
            {
                _log.Info("autostart", "login item removed; this session's launchd job ends when the app quits");
                return;
            }
            ProcessRunner.Run("/bin/launchctl", new[] { "bootout", target }, TimeSpan.FromSeconds(5));
        }
        catch { }
    }

    private string ExecutablePath()
    {
        try
        {
            var main = Process.GetCurrentProcess().MainModule?.FileName;
            if (!string.IsNullOrWhiteSpace(main) && File.Exists(main)) return main!;
        }
        catch { }
        return Path.Combine(_appDir, "RXVision");
    }
}
