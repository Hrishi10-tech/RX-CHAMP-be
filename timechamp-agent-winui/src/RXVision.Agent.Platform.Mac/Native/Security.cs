using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace RXVision.Agent.Platform.Mac.Native;

/// <summary>
/// Security.framework Keychain Services P/Invoke (generic passwords). Strings are
/// passed as explicit length + byte pointer (UTF-8, not null-terminated), which is
/// what these length-counted APIs expect. The password buffer returned by Find is
/// owned by the framework and must be released with SecKeychainItemFreeContent; the
/// item ref is a CF object released with CFRelease.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class Security
{
    private const string Lib = "/System/Library/Frameworks/Security.framework/Security";

    internal const int errSecSuccess = 0;
    internal const int errSecItemNotFound = -25300;
    internal const int errSecDuplicateItem = -25299;

    [DllImport(Lib)]
    internal static extern int SecKeychainFindGenericPassword(
        IntPtr keychainOrArray,
        uint serviceNameLength, byte[] serviceName,
        uint accountNameLength, byte[] accountName,
        out uint passwordLength, out IntPtr passwordData,
        out IntPtr itemRef);

    /// <summary>
    /// The same lookup returning only the item ref: NULL passwordLength and
    /// passwordData (as documented) mean nothing is decrypted, so an item whose
    /// access list does not include this build is found without a Keychain prompt.
    /// </summary>
    [DllImport(Lib, EntryPoint = "SecKeychainFindGenericPassword")]
    internal static extern int SecKeychainFindGenericPasswordItem(
        IntPtr keychainOrArray,
        uint serviceNameLength, byte[] serviceName,
        uint accountNameLength, byte[] accountName,
        IntPtr passwordLength, IntPtr passwordData,
        out IntPtr itemRef);

    [DllImport(Lib)]
    internal static extern int SecKeychainAddGenericPassword(
        IntPtr keychain,
        uint serviceNameLength, byte[] serviceName,
        uint accountNameLength, byte[] accountName,
        uint passwordLength, byte[] passwordData,
        out IntPtr itemRef);

    [DllImport(Lib)]
    internal static extern int SecKeychainItemModifyAttributesAndData(
        IntPtr itemRef,
        IntPtr attrList,
        uint length, byte[] data);

    [DllImport(Lib)]
    internal static extern int SecKeychainItemDelete(IntPtr itemRef);

    [DllImport(Lib)]
    internal static extern int SecKeychainItemFreeContent(IntPtr attrList, IntPtr data);
}
