using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Avalonia.Controls;

namespace RXVision.Agent.Interop;

/// <summary>
/// The floating button and the toast must never take focus from what the person
/// is typing in. Avalonia's ShowActivated covers showing them; on Windows the
/// window is also marked WS_EX_NOACTIVATE (clicks no longer activate it) and
/// WS_EX_TOOLWINDOW (kept out of Alt+Tab). Elsewhere this does nothing.
/// </summary>
internal static class NativeWindow
{
    public static void MakeNonActivating(Window window)
    {
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            var handle = window.TryGetPlatformHandle()?.Handle ?? IntPtr.Zero;
            if (handle != IntPtr.Zero) Win32.AddExStyle(handle, Win32.WS_EX_NOACTIVATE | Win32.WS_EX_TOOLWINDOW);
        }
        catch
        {
            // Cosmetic: a window that can take focus still works.
        }
    }

    [SupportedOSPlatform("windows")]
    private static class Win32
    {
        public const int GWL_EXSTYLE = -20;
        public const long WS_EX_NOACTIVATE = 0x08000000L;
        public const long WS_EX_TOOLWINDOW = 0x00000080L;

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
        private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
        private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

        public static void AddExStyle(IntPtr hwnd, long bits)
        {
            var current = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
            if ((current & bits) == bits) return;
            SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(current | bits));
        }
    }
}
