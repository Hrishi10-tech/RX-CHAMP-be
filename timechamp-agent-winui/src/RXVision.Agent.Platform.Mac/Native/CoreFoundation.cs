using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace RXVision.Agent.Platform.Mac.Native;

/// <summary>
/// CoreFoundation P/Invoke. CFTypeRef/CFStringRef/CFDictionaryRef/CFArrayRef/
/// CFBooleanRef/CFNumberRef are all opaque pointers (IntPtr). CFIndex is nint.
/// Ownership: anything from a Create/Copy call is owned by us and must be
/// released with <see cref="CFRelease"/>; anything from a Get call is borrowed
/// and must not be released.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class CoreFoundation
{
    private const string Lib = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

    /// <summary>kCFStringEncodingUTF8.</summary>
    internal const uint EncodingUtf8 = 0x08000100;

    /// <summary>kCFNumberSInt64Type (CFNumberGetValue converts to this).</summary>
    internal const nint NumberSInt64Type = 4;

    [DllImport(Lib)]
    internal static extern void CFRelease(IntPtr cf);

    [DllImport(Lib)]
    internal static extern IntPtr CFStringCreateWithCString(IntPtr alloc,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string cStr, uint encoding);

    [DllImport(Lib)]
    internal static extern IntPtr CFDictionaryGetValue(IntPtr theDict, IntPtr key);

    [DllImport(Lib)]
    [return: MarshalAs(UnmanagedType.I1)]
    internal static extern bool CFBooleanGetValue(IntPtr boolean);

    [DllImport(Lib)]
    internal static extern nint CFArrayGetCount(IntPtr theArray);

    [DllImport(Lib)]
    internal static extern IntPtr CFArrayGetValueAtIndex(IntPtr theArray, nint idx);

    [DllImport(Lib)]
    internal static extern nint CFStringGetLength(IntPtr theString);

    [DllImport(Lib)]
    internal static extern IntPtr CFStringGetCStringPtr(IntPtr theString, uint encoding);

    [DllImport(Lib)]
    [return: MarshalAs(UnmanagedType.I1)]
    internal static extern bool CFStringGetCString(IntPtr theString, byte[] buffer, nint bufferSize, uint encoding);

    [DllImport(Lib)]
    [return: MarshalAs(UnmanagedType.I1)]
    internal static extern bool CFNumberGetValue(IntPtr number, nint theType, out long value);

    /// <summary>CFTypeID discriminator so we never misread a value as the wrong kind.</summary>
    [DllImport(Lib)]
    internal static extern nint CFGetTypeID(IntPtr cf);

    [DllImport(Lib)]
    internal static extern nint CFBooleanGetTypeID();

    [DllImport(Lib)]
    internal static extern nint CFStringGetTypeID();

    [DllImport(Lib)]
    internal static extern nint CFNumberGetTypeID();

    /// <summary>Creates an owned CFString from a managed string. Caller must CFRelease it.</summary>
    internal static IntPtr CreateString(string value) =>
        CFStringCreateWithCString(IntPtr.Zero, value, EncodingUtf8);

    /// <summary>Reads a borrowed CFStringRef into a managed string (null when not a CFString).</summary>
    internal static string? StringToManaged(IntPtr cfString)
    {
        if (cfString == IntPtr.Zero) return null;
        if (CFGetTypeID(cfString) != CFStringGetTypeID()) return null;

        // Fast path: a direct pointer to the backing bytes is sometimes available.
        var direct = CFStringGetCStringPtr(cfString, EncodingUtf8);
        if (direct != IntPtr.Zero)
        {
            var s = Marshal.PtrToStringUTF8(direct);
            if (!string.IsNullOrEmpty(s)) return s;
        }

        var length = CFStringGetLength(cfString);
        if (length <= 0) return string.Empty;
        // Up to 4 UTF-8 bytes per UTF-16 unit, plus the null terminator.
        var capacity = (checked((int)length) * 4) + 1;
        var buffer = new byte[capacity];
        if (!CFStringGetCString(cfString, buffer, capacity, EncodingUtf8)) return null;
        var end = Array.IndexOf(buffer, (byte)0);
        if (end < 0) end = buffer.Length;
        return System.Text.Encoding.UTF8.GetString(buffer, 0, end);
    }

    /// <summary>Reads a borrowed CFNumberRef as a long (null when not a CFNumber).</summary>
    internal static long? NumberToManaged(IntPtr cfNumber)
    {
        if (cfNumber == IntPtr.Zero) return null;
        if (CFGetTypeID(cfNumber) != CFNumberGetTypeID()) return null;
        // CFNumberGetValue returns false only on a lossy conversion but still
        // writes the converted value, which is what we want for ints that fit.
        CFNumberGetValue(cfNumber, NumberSInt64Type, out var value);
        return value;
    }

    /// <summary>Reads a borrowed CFBooleanRef (null when the value is not a CFBoolean).</summary>
    internal static bool? BooleanToManaged(IntPtr cfBoolean)
    {
        if (cfBoolean == IntPtr.Zero) return null;
        if (CFGetTypeID(cfBoolean) != CFBooleanGetTypeID()) return null;
        return CFBooleanGetValue(cfBoolean);
    }
}
