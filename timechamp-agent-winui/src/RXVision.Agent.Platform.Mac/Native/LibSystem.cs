using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace RXVision.Agent.Platform.Mac.Native;

[StructLayout(LayoutKind.Sequential)]
internal struct MachTimebaseInfo
{
    public uint Numer;
    public uint Denom;
}

/// <summary>libSystem P/Invoke: mach monotonic clocks (for the sleep detector),
/// the effective uid (for launchctl) and the writability probe.</summary>
[SupportedOSPlatform("macos")]
internal static class LibSystem
{
    private const string Lib = "/usr/lib/libSystem.dylib";

    internal const int W_OK = 2;

    /// <summary>Monotonic ticks that do NOT advance while the machine is asleep.</summary>
    [DllImport(Lib)]
    internal static extern ulong mach_absolute_time();

    /// <summary>Monotonic ticks that DO advance while the machine is asleep.</summary>
    [DllImport(Lib)]
    internal static extern ulong mach_continuous_time();

    /// <summary>Numerator/denominator to convert mach ticks to nanoseconds.</summary>
    [DllImport(Lib)]
    internal static extern int mach_timebase_info(out MachTimebaseInfo info);

    [DllImport(Lib)]
    internal static extern uint getuid();

    /// <summary>POSIX access(2): 0 when the path is accessible for the given mode.</summary>
    [DllImport(Lib, SetLastError = true)]
    internal static extern int access([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int mode);
}
