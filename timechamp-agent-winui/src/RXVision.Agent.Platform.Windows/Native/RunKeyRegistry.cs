using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace RXVision.Agent.Platform.Windows.Native;

/// <summary>
/// The HKCU <c>...\CurrentVersion\Run</c> values, via advapi32 directly so no
/// Microsoft.Win32.Registry package is needed. Reads and writes REG_SZ values.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class RunKeyRegistry
{
    // HKEY_CURRENT_USER: (HKEY)(LONG)0x80000001, sign-extended to 64-bit.
    private static readonly IntPtr HKEY_CURRENT_USER = new(unchecked((int)0x80000001));
    private const string RunSubKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    private const int KEY_QUERY_VALUE = 0x0001;
    private const int KEY_SET_VALUE = 0x0002;
    private const int REG_SZ = 1;
    private const int ERROR_SUCCESS = 0;
    private const int ERROR_MORE_DATA = 234;

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegOpenKeyExW(IntPtr hKey, string lpSubKey, int ulOptions, int samDesired, out IntPtr phkResult);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegCreateKeyExW(
        IntPtr hKey, string lpSubKey, int Reserved, string? lpClass, int dwOptions, int samDesired,
        IntPtr lpSecurityAttributes, out IntPtr phkResult, out int lpdwDisposition);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegSetValueExW(IntPtr hKey, string lpValueName, int Reserved, int dwType, byte[] lpData, int cbData);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegQueryValueExW(IntPtr hKey, string lpValueName, IntPtr lpReserved, out int lpType, byte[]? lpData, ref int lpcbData);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegDeleteValueW(IntPtr hKey, string lpValueName);

    [DllImport("advapi32.dll")]
    private static extern int RegCloseKey(IntPtr hKey);

    /// <summary>Writes a REG_SZ value under the Run key, creating the key if needed.</summary>
    public static void Set(string name, string value)
    {
        if (RegCreateKeyExW(HKEY_CURRENT_USER, RunSubKey, 0, null, 0, KEY_SET_VALUE, IntPtr.Zero, out var key, out _) != ERROR_SUCCESS)
            return;
        try
        {
            var data = Encoding.Unicode.GetBytes(value + "\0");
            RegSetValueExW(key, name, 0, REG_SZ, data, data.Length);
        }
        finally
        {
            RegCloseKey(key);
        }
    }

    /// <summary>Deletes a value under the Run key (no-op if absent or the key is missing).</summary>
    public static void Delete(string name)
    {
        if (RegOpenKeyExW(HKEY_CURRENT_USER, RunSubKey, 0, KEY_SET_VALUE, out var key) != ERROR_SUCCESS)
            return;
        try
        {
            RegDeleteValueW(key, name);
        }
        finally
        {
            RegCloseKey(key);
        }
    }

    /// <summary>The string value under the Run key, or null when it is absent.</summary>
    public static string? Get(string name)
    {
        if (RegOpenKeyExW(HKEY_CURRENT_USER, RunSubKey, 0, KEY_QUERY_VALUE, out var key) != ERROR_SUCCESS)
            return null;
        try
        {
            var cb = 0;
            var probe = RegQueryValueExW(key, name, IntPtr.Zero, out _, null, ref cb);
            if ((probe != ERROR_SUCCESS && probe != ERROR_MORE_DATA) || cb <= 0) return null;

            var data = new byte[cb];
            if (RegQueryValueExW(key, name, IntPtr.Zero, out var type, data, ref cb) != ERROR_SUCCESS) return null;
            if (type != REG_SZ) return null;

            // cb is the byte count actually written; drop a trailing UTF-16 NUL.
            var chars = cb / 2;
            var text = Encoding.Unicode.GetString(data, 0, chars * 2);
            return text.TrimEnd('\0');
        }
        finally
        {
            RegCloseKey(key);
        }
    }
}
