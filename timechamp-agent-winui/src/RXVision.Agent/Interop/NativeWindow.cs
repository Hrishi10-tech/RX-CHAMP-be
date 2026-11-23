using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Avalonia;
using Avalonia.Controls;

namespace RXVision.Agent.Interop;

/// <summary>
/// The floating button and the toast must never take focus from what the person
/// is typing in. Avalonia's ShowActivated covers showing them; on Windows the
/// window is also marked WS_EX_NOACTIVATE (clicks no longer activate it) and
/// WS_EX_TOOLWINDOW (kept out of Alt+Tab). Elsewhere this does nothing. The floating
/// icon can also let clicks through for a while, on Windows and on macOS.
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

    /// <summary>Whether the whole window lets clicks through to what is underneath. Cosmetic: a failure leaves it catching them.</summary>
    public static void SetClickThrough(Window window, bool through)
    {
        try
        {
            var handle = window.TryGetPlatformHandle();
            if (handle is null || handle.Handle == IntPtr.Zero) return;
            if (OperatingSystem.IsWindows() && handle.HandleDescriptor == "HWND") Win32.SetClickThrough(handle.Handle, through);
            else if (OperatingSystem.IsMacOS() && handle.HandleDescriptor == "NSWindow") Mac.SetIgnoresMouseEvents(handle.Handle, through);
        }
        catch
        {
            // It keeps catching clicks on its margin, as it does on any other desktop.
        }
    }

    /// <summary>Where the pointer is, in the units of <see cref="Window.Position"/>; null where it can't be told.</summary>
    public static PixelPoint? CursorPosition(Window window)
    {
        try
        {
            var handle = window.TryGetPlatformHandle();
            if (handle is null || handle.Handle == IntPtr.Zero) return null;
            if (OperatingSystem.IsWindows() && handle.HandleDescriptor == "HWND") return Win32.Cursor();
            if (OperatingSystem.IsMacOS() && handle.HandleDescriptor == "NSWindow")
            {
                // AppKit counts from the bottom of the primary screen; Avalonia from its top.
                var primary = window.Screens.Primary;
                var at = Mac.MouseLocation();
                return primary is null ? null : new PixelPoint((int)Math.Round(at.X), primary.Bounds.Height - (int)Math.Round(at.Y));
            }
            return null;
        }
        catch
        {
            return null;
        }
    }

    [SupportedOSPlatform("macos")]
    private static class Mac
    {
        private const string Objc = "/usr/lib/libobjc.A.dylib";

        [StructLayout(LayoutKind.Sequential)]
        public readonly record struct NsPoint(double X, double Y);

        [DllImport(Objc)]
        private static extern IntPtr objc_getClass(string name);

        [DllImport(Objc)]
        private static extern IntPtr sel_registerName(string name);

        [DllImport(Objc, EntryPoint = "objc_msgSend")]
        private static extern void SendBool(IntPtr receiver, IntPtr selector, [MarshalAs(UnmanagedType.I1)] bool value);

        [DllImport(Objc, EntryPoint = "objc_msgSend")]
        private static extern NsPoint SendPoint(IntPtr receiver, IntPtr selector);

        public static void SetIgnoresMouseEvents(IntPtr nsWindow, bool ignore) =>
            SendBool(nsWindow, sel_registerName("setIgnoresMouseEvents:"), ignore);

        public static NsPoint MouseLocation() => SendPoint(objc_getClass("NSEvent"), sel_registerName("mouseLocation"));
    }

    [SupportedOSPlatform("windows")]
    private static class Win32
    {
        public const int GWL_EXSTYLE = -20;
        public const long WS_EX_NOACTIVATE = 0x08000000L;
        public const long WS_EX_TOOLWINDOW = 0x00000080L;
        private const long WS_EX_LAYERED = 0x00080000L;
        private const long WS_EX_TRANSPARENT = 0x00000020L;
        private const uint LWA_ALPHA = 0x00000002;

        [StructLayout(LayoutKind.Sequential)]
        private struct NativePoint
        {
            public int X;
            public int Y;
        }

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetCursorPos(out NativePoint point);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint colorKey, byte alpha, uint flags);

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

        /// <summary>Layered and transparent together send clicks to the window underneath; full alpha keeps it drawn as it is.</summary>
        public static void SetClickThrough(IntPtr hwnd, bool through)
        {
            var current = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
            var bits = WS_EX_LAYERED | WS_EX_TRANSPARENT;
            SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(through ? current | bits : current & ~bits));
            if (through) SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);
        }

        public static PixelPoint? Cursor() => GetCursorPos(out var p) ? new PixelPoint(p.X, p.Y) : null;
    }
}
