using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace RXVision.Agent.Platform.Mac.Native;

/// <summary>CoreGraphics (Quartz) P/Invoke: idle time, screen-capture permission,
/// the on-screen window list and the current session dictionary.</summary>
[SupportedOSPlatform("macos")]
internal static class CoreGraphics
{
    private const string Lib = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";

    /// <summary>kCGEventSourceStateCombinedSessionState.</summary>
    internal const uint EventSourceStateCombinedSession = 0;

    /// <summary>kCGAnyInputEventType (all keyboard and mouse input).</summary>
    internal const uint AnyInputEventType = 0xFFFFFFFF;

    /// <summary>kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements.</summary>
    internal const uint WindowListOnScreenNoDesktop = 0x1 | 0x10;

    /// <summary>kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements: a call on another Space too.</summary>
    internal const uint WindowListAllNoDesktop = 0x0 | 0x10;

    /// <summary>kCGNullWindowID.</summary>
    internal const uint NullWindowID = 0;

    /// <summary>Seconds since the last input event of the given type, system-wide. No permission needed.</summary>
    [DllImport(Lib)]
    internal static extern double CGEventSourceSecondsSinceLastEventType(uint stateID, uint eventType);

    /// <summary>True when this process already has Screen Recording permission. Does not prompt.</summary>
    [DllImport(Lib)]
    [return: MarshalAs(UnmanagedType.I1)]
    internal static extern bool CGPreflightScreenCaptureAccess();

    /// <summary>Asks the OS to show the Screen Recording prompt (once). Returns the current grant state.</summary>
    [DllImport(Lib)]
    [return: MarshalAs(UnmanagedType.I1)]
    internal static extern bool CGRequestScreenCaptureAccess();

    /// <summary>Copies the on-screen window list (front to back). Owned: CFRelease it.</summary>
    [DllImport(Lib)]
    internal static extern IntPtr CGWindowListCopyWindowInfo(uint option, uint relativeToWindow);

    /// <summary>Copies the current login-session dictionary, or NULL off a window-server session. Owned: CFRelease it.</summary>
    [DllImport(Lib)]
    internal static extern IntPtr CGSessionCopyCurrentDictionary();

    /// <summary>Fills <paramref name="activeDisplays"/> with up to <paramref name="maxDisplays"/> active display IDs.</summary>
    [DllImport(Lib)]
    internal static extern int CGGetActiveDisplayList(uint maxDisplays, uint[]? activeDisplays, out uint displayCount);
}
