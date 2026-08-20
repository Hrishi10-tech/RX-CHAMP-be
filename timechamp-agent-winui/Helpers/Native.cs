using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;
using Windows.Graphics;

namespace TimeChampAgent.Helpers;

/// <summary>
/// The handful of Win32 calls WinUI doesn't expose: clipping a window to a circle,
/// reading the cursor in screen pixels, and asking whether something is running
/// full-screen.
/// </summary>
internal static class Native
{
    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hWnd);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateEllipticRgn(int x1, int y1, int x2, int y2);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindowLongPtrW(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    private static extern IntPtr SetWindowLongPtrW(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    private const int GwlStyle = -16;
    private const int GwlExStyle = -20;

    private const long WsPopup = 0x80000000;
    private const long WsCaption = 0x00C00000;
    private const long WsThickFrame = 0x00040000;
    private const long WsMinimizeBox = 0x00020000;
    private const long WsMaximizeBox = 0x00010000;
    private const long WsSysMenu = 0x00080000;
    private const long WsExToolWindow = 0x00000080;

    private const uint SwpNoMove = 0x0002;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;
    private const uint SwpFrameChanged = 0x0020;

    [DllImport("shell32.dll")]
    private static extern int SHQueryUserNotificationState(out int state);

    // QUNS_BUSY = 2, QUNS_RUNNING_D3D_FULL_SCREEN = 3, QUNS_PRESENTATION_MODE = 4.
    private const int QunsBusy = 2;
    private const int QunsFullScreenD3D = 3;
    private const int QunsPresentation = 4;

    private static IntPtr HandleOf(Window window) =>
        WinRT.Interop.WindowNative.GetWindowHandle(window);

    /// <summary>Cursor position in physical screen pixels.</summary>
    public static bool TryGetCursorPos(out PointInt32 point)
    {
        if (GetCursorPos(out var p))
        {
            point = new PointInt32(p.X, p.Y);
            return true;
        }
        point = new PointInt32(0, 0);
        return false;
    }

    /// <summary>The monitor scale for this window (1.5 at 150%). WinUI has no
    /// per-pixel transparency, so a round button has to be cut out of a square
    /// window — and that means working in physical pixels.</summary>
    public static double ScaleFor(Window window)
    {
        var dpi = GetDpiForWindow(HandleOf(window));
        return dpi == 0 ? 1.0 : dpi / 96.0;
    }

    /// <summary>
    /// Turns the window into a plain popup at exactly the size asked for.
    /// A normal overlapped window can't go below Windows' minimum tracking width
    /// (SM_CXMINTRACK — 136px at 100%), so a 52px badge came out 136px wide with the
    /// content stranded in a corner. WS_POPUP isn't subject to that minimum.
    /// WS_EX_TOOLWINDOW additionally keeps it out of the taskbar and Alt+Tab.
    /// </summary>
    public static void MakeBorderlessPopup(Window window, int sizePx)
    {
        var hwnd = HandleOf(window);

        var style = (long)GetWindowLongPtrW(hwnd, GwlStyle);
        style &= ~(WsCaption | WsThickFrame | WsMinimizeBox | WsMaximizeBox | WsSysMenu);
        style |= WsPopup;
        SetWindowLongPtrW(hwnd, GwlStyle, (IntPtr)style);

        var exStyle = (long)GetWindowLongPtrW(hwnd, GwlExStyle);
        SetWindowLongPtrW(hwnd, GwlExStyle, (IntPtr)(exStyle | WsExToolWindow));

        // SWP_FRAMECHANGED is what makes the style edits above take effect.
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, sizePx, sizePx,
            SwpNoMove | SwpNoZOrder | SwpNoActivate | SwpFrameChanged);
    }

    /// <summary>Cuts the window down to a circle of the given diameter, so the
    /// square frame around the badge disappears.</summary>
    public static void ClipToCircle(Window window, int diameterPx)
    {
        // The region is owned by the window once set; Windows frees it, and the
        // previous one, on the next call.
        var region = CreateEllipticRgn(0, 0, diameterPx, diameterPx);
        if (region == IntPtr.Zero) return;
        SetWindowRgn(HandleOf(window), region, bRedraw: true);
    }

    /// <summary>True while a game, video or slideshow owns the whole screen. An
    /// always-on-top badge over a presentation — or a shared screen — is exactly
    /// the wrong place for it to be.</summary>
    public static bool IsFullScreenAppRunning()
    {
        if (SHQueryUserNotificationState(out var state) != 0) return false;
        return state is QunsBusy or QunsFullScreenD3D or QunsPresentation;
    }
}
