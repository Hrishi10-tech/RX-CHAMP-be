using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Platform.Mac.Native;

namespace RXVision.Agent.Platform.Mac;

/// <summary>
/// Keeps App Nap off for the life of the process. A menu-bar app whose windows
/// are hidden or covered can be napped, which throttles its timers and would
/// delay activity samples, idle checks and heartbeats. The activity used,
/// NSActivityUserInitiatedAllowingIdleSystemSleep, still lets the Mac sleep when
/// idle: it only stops the throttling.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacAppNap
{
    /// <summary>NSActivityUserInitiated (0x00FFFFFF | IdleSystemSleepDisabled) without IdleSystemSleepDisabled (1 &lt;&lt; 20).</summary>
    internal const ulong UserInitiatedAllowingIdleSystemSleep = 0x00FFFFFFUL & ~(1UL << 20);

    // Held for the life of the process: releasing the token would end the activity.
    private static IntPtr s_activity;
    private static IntPtr s_reason;

    public static void Prevent(ILog log)
    {
        try
        {
            if (s_activity != IntPtr.Zero) return;
            // Foundation is not necessarily loaded this early (before Avalonia starts AppKit).
            NativeLibrary.Load(ObjC.FoundationPath);
            var processInfoClass = ObjC.objc_getClass("NSProcessInfo");
            if (processInfoClass == IntPtr.Zero)
            {
                log.Warn("platform", "App Nap: NSProcessInfo not found");
                return;
            }
            var processInfo = ObjC.Send(processInfoClass, ObjC.sel_registerName("processInfo"));
            if (processInfo == IntPtr.Zero) return;

            // A CFString is toll-free bridged to NSString; it stays alive with the activity.
            s_reason = CoreFoundation.CFStringCreateWithCString(IntPtr.Zero, "Recording working time", CoreFoundation.EncodingUtf8);
            var activity = ObjC.Send(processInfo, ObjC.sel_registerName("beginActivityWithOptions:reason:"),
                UserInitiatedAllowingIdleSystemSleep, s_reason);
            if (activity == IntPtr.Zero)
            {
                log.Warn("platform", "App Nap: the activity was not started");
                return;
            }
            // The token comes back autoreleased; own it so it outlives any pool.
            s_activity = ObjC.Send(activity, ObjC.sel_registerName("retain"));
            log.Info("platform", "App Nap is off while RX Vision runs");
        }
        catch (Exception ex)
        {
            log.Warn("platform", "App Nap could not be turned off", ex);
        }
    }
}
