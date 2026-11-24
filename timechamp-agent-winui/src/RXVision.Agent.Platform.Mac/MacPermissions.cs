using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Platform.Mac.Native;

namespace RXVision.Agent.Platform.Mac;

/// <summary>
/// macOS privacy permissions. Screen Recording is the one the agent needs (for
/// screenshots and window titles); Accessibility is reported but not required.
/// The settings deep-links open the right Privacy pane.
/// </summary>
[SupportedOSPlatform("macos")]
internal sealed class MacPermissions : IPermissions
{
    private const string ScreenCaptureUrl = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
    private const string AccessibilityUrl = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

    /// <summary>Written the first time the system prompt is asked for.</summary>
    internal const string RequestedMarker = "screen-recording-requested";

    private readonly string _marker;
    private readonly ILog _log;

    public MacPermissions(string dataDir, ILog log)
    {
        _marker = Path.Combine(dataDir, RequestedMarker);
        _log = log;
    }

    /// <summary>
    /// Granted, or not yet: NotDetermined until this app has shown the system
    /// prompt once (macOS can only say yes or no, and the prompt appears only the
    /// first time), Denied after that. The UI asks again only when NotDetermined
    /// and otherwise opens the Privacy pane.
    /// </summary>
    public PermissionState ScreenRecording
    {
        get
        {
            try
            {
                if (CoreGraphics.CGPreflightScreenCaptureAccess()) return PermissionState.Granted;
                return File.Exists(_marker) ? PermissionState.Denied : PermissionState.NotDetermined;
            }
            catch { return PermissionState.Denied; }
        }
    }

    public PermissionState Accessibility
    {
        get
        {
            try { return ApplicationServices.AXIsProcessTrusted() ? PermissionState.Granted : PermissionState.Denied; }
            catch { return PermissionState.Denied; }
        }
    }

    public void RequestScreenRecording()
    {
        try { File.WriteAllText(_marker, DateTimeOffset.UtcNow.ToString("o")); }
        catch (Exception ex) { _log.Warn("permissions", "could not note the screen recording request", ex); }
        try { CoreGraphics.CGRequestScreenCaptureAccess(); }
        catch (Exception ex) { _log.Warn("permissions", "screen recording request failed", ex); }
    }

    public void OpenScreenRecordingSettings() => Open(ScreenCaptureUrl);
    public void OpenAccessibilitySettings() => Open(AccessibilityUrl);

    /// <summary>
    /// The person turned Screen Recording on, yet this build is refused: the entry in
    /// Settings belongs to the build before the last update (its ad-hoc signature).
    /// macOS will not prompt while that entry exists, and turning it off and on does
    /// not help; removing it does. tccutil may reset this app's own entry without admin
    /// rights, after which the normal system prompt appears ("Open System Settings",
    /// then "Quit &amp; Reopen"). Done once per run: macOS shows the prompt at most once
    /// per process, so a second click opens Settings instead.
    /// </summary>
    public void RenewScreenRecording()
    {
        if (Interlocked.Exchange(ref _renewed, 1) == 1)
        {
            OpenScreenRecordingSettings();
            return;
        }
        var reset = ProcessRunner.Run("/usr/bin/tccutil",
            new[] { "reset", "ScreenCapture", MacUpdateInstaller.ExpectedBundleId }, TimeSpan.FromSeconds(10));
        if (!reset.Ok)
        {
            _log.Warn("permissions", $"could not clear the old screen recording entry (exit {reset.ExitCode}: {reset.StdErr.Trim()}); opening Settings");
            OpenScreenRecordingSettings();
            return;
        }
        _log.Info("permissions", "cleared the old screen recording entry; asking again");
        RequestScreenRecording();
    }

    private int _renewed;

    private void Open(string url)
    {
        if (!ProcessRunner.Launch("/usr/bin/open", new[] { url }))
            _log.Warn("permissions", "could not open Privacy settings");
    }
}
