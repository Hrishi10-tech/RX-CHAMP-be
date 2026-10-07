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

    [DllImport("gdi32.dll")]
    private static extern int CombineRgn(IntPtr dest, IntPtr src1, IntPtr src2, int mode);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr obj);

    private const int RgnOr = 2;

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
    private const long WsExNoActivate = 0x08000000;


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
    public static void MakeBorderlessPopup(Window window, int sizePx) =>
        MakeBorderlessPopup(window, sizePx, sizePx, noActivate: false);

    /// <summary>
    /// As above, for a window that is not square and must never take the keyboard.
    ///
    /// WS_EX_NOACTIVATE is the whole point of the second case: a card that announces
    /// a message appears while someone is mid-sentence in another app, and a popup
    /// that steals focus eats the rest of the sentence. The card is there to be read,
    /// not typed into.
    /// </summary>
    public static void MakeBorderlessPopup(Window window, int widthPx, int heightPx, bool noActivate)
    {
        var hwnd = HandleOf(window);

        var style = (long)GetWindowLongPtrW(hwnd, GwlStyle);
        style &= ~(WsCaption | WsThickFrame | WsMinimizeBox | WsMaximizeBox | WsSysMenu);
        style |= WsPopup;
        SetWindowLongPtrW(hwnd, GwlStyle, (IntPtr)style);

        var exStyle = (long)GetWindowLongPtrW(hwnd, GwlExStyle);
        exStyle |= WsExToolWindow;
        if (noActivate) exStyle |= WsExNoActivate;
        SetWindowLongPtrW(hwnd, GwlExStyle, (IntPtr)exStyle);

        // SWP_FRAMECHANGED is what makes the style edits above take effect.
        SetWindowPos(hwnd, IntPtr.Zero, 0, 0, widthPx, heightPx,
            SwpNoMove | SwpNoZOrder | SwpNoActivate | SwpFrameChanged);
    }

    /// <summary>Whether this window is the one the user is actually working in.
    /// A window that is merely open, behind three others, is not being read.</summary>
    public static bool IsForeground(Window window) => GetForegroundWindow() == HandleOf(window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    // Showing and hiding is left to AppWindow.Show(activateWindow: false) / Hide().
    // Driving the same thing through ShowWindow() behind WinUI's back took the XAML
    // runtime down with an access violation, so only the style bit above is ours.

    /// <summary>Cuts the window down to a circle of the given diameter, so the
    /// square frame around the badge disappears.</summary>
    public static void ClipToCircle(Window window, int diameterPx) =>
        ClipToCircle(window, 0, diameterPx);

    /// <summary>The same, for a circle sitting <paramref name="topPx"/> down from the
    /// top of the window rather than filling it.</summary>
    public static void ClipToCircle(Window window, int topPx, int diameterPx)
    {
        // The region is owned by the window once set; Windows frees it, and the
        // previous one, on the next call.
        var region = CreateEllipticRgn(0, topPx, diameterPx, topPx + diameterPx);
        if (region == IntPtr.Zero) return;
        SetWindowRgn(HandleOf(window), region, bRedraw: true);
    }

    /// <summary>
    /// The same circle, plus a second one for the unread badge, so the badge may sit
    /// on the rim where a notification badge belongs.
    ///
    /// A badge inside a single circular region can only ever be tucked within it —
    /// the corner where it wants to sit is exactly the part the circle cuts away, and
    /// moving it outwards just slices it. Two circles joined is the whole trick: the
    /// window stays a round button with one bite taken out of the air beside it.
    /// </summary>
    public static void ClipToCircleWithBadge(
        Window window,
        int faceTopPx, int faceDiameterPx,
        int badgeLeftPx, int badgeTopPx, int badgeDiameterPx)
    {
        var face = CreateEllipticRgn(0, faceTopPx, faceDiameterPx, faceTopPx + faceDiameterPx);
        if (face == IntPtr.Zero) return;

        var badge = CreateEllipticRgn(
            badgeLeftPx, badgeTopPx,
            badgeLeftPx + badgeDiameterPx, badgeTopPx + badgeDiameterPx);
        if (badge != IntPtr.Zero)
        {
            CombineRgn(face, face, badge, RgnOr);
            DeleteObject(badge);
        }

        SetWindowRgn(HandleOf(window), face, bRedraw: true);
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
