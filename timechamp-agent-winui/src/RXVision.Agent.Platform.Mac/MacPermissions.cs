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

    private void Open(string url)
    {
        if (!ProcessRunner.Launch("/usr/bin/open", new[] { url }))
            _log.Warn("permissions", "could not open Privacy settings");
    }
}
