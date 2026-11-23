using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace RXVision.Agent.Platform.Windows.Native;

/// <summary>
/// The Win32 entry points the platform layer calls, in one place so the P/Invoke
/// signatures can be reviewed together. Every declaration is Unicode where strings
/// are involved, uses <c>SetLastError</c> where the caller may want the reason, and
/// marshals <c>BOOL</c> as <see cref="bool"/> explicitly. x64 only (the agent ships
/// win-x64); struct layouts below are sized for that.
/// </summary>
[SupportedOSPlatform("windows")]
internal static class NativeMethods
{
    // ---- user32 : idle -------------------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    internal struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    /// <summary>32-bit tick count (ms since boot, wraps about every 49.7 days). Width
    /// matches <c>LASTINPUTINFO.dwTime</c>, which is why this is used and not the 64-bit form.</summary>
    [DllImport("kernel32.dll")]
    internal static extern uint GetTickCount();

    // ---- user32 : foreground window ------------------------------------------------------

    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern int GetWindowTextW(IntPtr hWnd, [Out] char[] lpString, int nMaxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    // ---- user32 : the call detectors' window read ----------------------------------------

    internal delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern int GetClassNameW(IntPtr hWnd, [Out] char[] lpClassName, int nMaxCount);

    // ---- user32 : lock (input desktop) ---------------------------------------------------

    /// <summary>DESKTOP_SWITCHDESKTOP: requested only to learn whether it is refused.</summary>
    internal const uint DESKTOP_SWITCHDESKTOP = 0x0100;

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern IntPtr OpenInputDesktop(uint dwFlags, [MarshalAs(UnmanagedType.Bool)] bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseDesktop(IntPtr hDesktop);

    // ---- kernel32 : sleep clock ----------------------------------------------------------

    /// <summary>Interrupt time excluding time spent suspended, in 100 ns units
    /// (the same unit as <see cref="TimeSpan.Ticks"/>).</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool QueryUnbiasedInterruptTime(out ulong UnbiasedTime);

    // ---- wtsapi32 : lock confirmation (session state) ------------------------------------

    internal static readonly IntPtr WTS_CURRENT_SERVER_HANDLE = IntPtr.Zero;
    internal const uint WTS_CURRENT_SESSION = 0xFFFFFFFF;

    /// <summary>WTS_INFO_CLASS.WTSSessionInfoEx.</summary>
    internal const int WTSSessionInfoEx = 25;

    // WTS_CONNECTSTATE_CLASS
    internal const int WTSDisconnected = 4;

    // WTSINFOEX_LEVEL1.SessionFlags
    internal const int WTS_SESSIONSTATE_LOCK = 0;
    internal const int WTS_SESSIONSTATE_UNLOCK = 1;
    internal const int WTS_SESSIONSTATE_UNKNOWN = -1;

    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool WTSQuerySessionInformationW(
        IntPtr hServer, uint SessionId, int WTSInfoClass, out IntPtr ppBuffer, out uint pBytesReturned);

    [DllImport("wtsapi32.dll")]
    internal static extern void WTSFreeMemory(IntPtr pMemory);

    // ---- user32 : screen metrics + DPI ---------------------------------------------------

    internal const int SM_XVIRTUALSCREEN = 76;
    internal const int SM_YVIRTUALSCREEN = 77;
    internal const int SM_CXVIRTUALSCREEN = 78;
    internal const int SM_CYVIRTUALSCREEN = 79;

    /// <summary>DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 as a pseudo-handle.</summary>
    internal static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new(-4);

    [DllImport("user32.dll")]
    internal static extern int GetSystemMetrics(int nIndex);

    /// <summary>Returns the thread's previous DPI context, or IntPtr.Zero on failure.
    /// Present since Windows 10 1607.</summary>
    [DllImport("user32.dll", SetLastError = true)]
    internal static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);

    // ---- crypt32 : DPAPI -----------------------------------------------------------------

    [StructLayout(LayoutKind.Sequential)]
    internal struct DATA_BLOB
    {
        public int cbData;
        public IntPtr pbData;
    }

    internal const int CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CryptProtectData(
        ref DATA_BLOB pDataIn, string? szDataDescr, IntPtr pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CryptUnprotectData(
        ref DATA_BLOB pDataIn, IntPtr ppszDataDescr, IntPtr pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);

    [DllImport("kernel32.dll")]
    internal static extern IntPtr LocalFree(IntPtr hMem);

    // ---- shell32 : full-screen / presentation state --------------------------------------

    // QUNS_BUSY = 2, QUNS_RUNNING_D3D_FULL_SCREEN = 3, QUNS_PRESENTATION_MODE = 4.
    internal const int QUNS_BUSY = 2;
    internal const int QUNS_RUNNING_D3D_FULL_SCREEN = 3;
    internal const int QUNS_PRESENTATION_MODE = 4;

    [DllImport("shell32.dll")]
    internal static extern int SHQueryUserNotificationState(out int pquns);

    // ---- winmm / user32 : chime ----------------------------------------------------------

    internal const uint SND_ASYNC = 0x0001;
    internal const uint SND_NODEFAULT = 0x0002;
    internal const uint SND_FILENAME = 0x00020000;

    [DllImport("winmm.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool PlaySoundW(string? pszSound, IntPtr hmod, uint fdwSound);

    internal const uint MB_OK = 0x00000000;

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool MessageBeep(uint uType);

    // ---- helpers -------------------------------------------------------------------------

    /// <summary>A window's class name, or null.</summary>
    internal static string? ClassNameOf(IntPtr hWnd)
    {
        var buffer = new char[256];
        var copied = GetClassNameW(hWnd, buffer, buffer.Length);
        return copied <= 0 ? null : new string(buffer, 0, copied);
    }

    /// <summary>Reads the foreground window title into a bounded buffer. Never throws.</summary>
    internal static string? ForegroundTitle(IntPtr hWnd, int maxChars = 512)
    {
        var len = GetWindowTextLengthW(hWnd);
        if (len <= 0) return null;
        var cap = Math.Min(len, maxChars);
        var buffer = new char[cap + 1];
        var copied = GetWindowTextW(hWnd, buffer, buffer.Length);
        if (copied <= 0) return null;
        var text = new string(buffer, 0, copied);
        return string.IsNullOrWhiteSpace(text) ? null : text;
    }
}
