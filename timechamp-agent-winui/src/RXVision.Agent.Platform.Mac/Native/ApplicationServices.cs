using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace RXVision.Agent.Platform.Mac.Native;

/// <summary>ApplicationServices P/Invoke: the Accessibility trust check (read-only, no prompt).</summary>
[SupportedOSPlatform("macos")]
internal static class ApplicationServices
{
    private const string Lib = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";

    /// <summary>True when this process is a trusted Accessibility client.</summary>
    [DllImport(Lib)]
    [return: MarshalAs(UnmanagedType.I1)]
    internal static extern bool AXIsProcessTrusted();
}
