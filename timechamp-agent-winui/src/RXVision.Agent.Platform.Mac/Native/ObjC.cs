using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace RXVision.Agent.Platform.Mac.Native;

/// <summary>
/// The few Objective-C runtime calls the agent needs. objc_msgSend is bound once
/// per exact signature (on arm64 it must never be called as a variadic).
/// </summary>
[SupportedOSPlatform("macos")]
internal static class ObjC
{
    private const string Lib = "/usr/lib/libobjc.A.dylib";
    internal const string FoundationPath = "/System/Library/Frameworks/Foundation.framework/Foundation";

    [DllImport(Lib)]
    internal static extern IntPtr objc_getClass([MarshalAs(UnmanagedType.LPUTF8Str)] string name);

    [DllImport(Lib)]
    internal static extern IntPtr sel_registerName([MarshalAs(UnmanagedType.LPUTF8Str)] string name);

    /// <summary>id objc_msgSend(id self, SEL op): no arguments, object result.</summary>
    [DllImport(Lib, EntryPoint = "objc_msgSend")]
    internal static extern IntPtr Send(IntPtr receiver, IntPtr selector);

    /// <summary>id objc_msgSend(id self, SEL op, uint64_t, id): beginActivityWithOptions:reason:.</summary>
    [DllImport(Lib, EntryPoint = "objc_msgSend")]
    internal static extern IntPtr Send(IntPtr receiver, IntPtr selector, ulong arg1, IntPtr arg2);
}
