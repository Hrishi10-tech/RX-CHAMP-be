using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Platform.Windows.Native;

namespace RXVision.Agent.Platform.Windows.Probes;

/// <summary>
/// Captures the whole virtual screen (every monitor) as one JPEG, scaled so the
/// longest side is at most <c>maxLongSide</c>. Per-monitor-v2 DPI awareness is set on
/// the capturing thread so a scaled display is captured at full pixels, not the
/// shrunk size Windows reports to a DPI-unaware process. Everything is disposed and
/// the intermediate is 24bpp to keep peak memory down. Null on any failure.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsScreenCapture : IScreenCapture
{
    private readonly Action<string>? _log;

    public WindowsScreenCapture(Action<string>? log) => _log = log;

    public CapturedImage? Capture(int maxLongSide, int quality)
    {
        var previousDpi = IntPtr.Zero;
        var dpiChanged = false;
        try
        {
            try
            {
                previousDpi = NativeMethods.SetThreadDpiAwarenessContext(NativeMethods.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
                dpiChanged = previousDpi != IntPtr.Zero;
            }
            catch (EntryPointNotFoundException)
            {
                // Windows 10 before 1607: no per-thread context. The app manifest already
                // makes the process per-monitor aware, so capture anyway.
            }

            var left = NativeMethods.GetSystemMetrics(NativeMethods.SM_XVIRTUALSCREEN);
            var top = NativeMethods.GetSystemMetrics(NativeMethods.SM_YVIRTUALSCREEN);
            var width = NativeMethods.GetSystemMetrics(NativeMethods.SM_CXVIRTUALSCREEN);
            var height = NativeMethods.GetSystemMetrics(NativeMethods.SM_CYVIRTUALSCREEN);
            if (width <= 0 || height <= 0) return null;

            using var full = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(full))
            {
                g.CopyFromScreen(left, top, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
            }

            var longest = Math.Max(width, height);
            var scale = maxLongSide > 0 && longest > maxLongSide ? (double)maxLongSide / longest : 1.0;
            var targetW = Math.Max(1, (int)Math.Round(width * scale));
            var targetH = Math.Max(1, (int)Math.Round(height * scale));

            // Render into 24bpp (no alpha) at the target size: a smaller buffer to
            // encode, and the JPEG has no use for an alpha channel.
            using var scaled = new Bitmap(targetW, targetH, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(scaled))
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                g.DrawImage(full, new Rectangle(0, 0, targetW, targetH), 0, 0, width, height, GraphicsUnit.Pixel);
            }

            var jpeg = EncodeJpeg(scaled, quality);
            if (jpeg is null) return null;
            return new CapturedImage(jpeg, "image/jpeg", targetW, targetH);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"screen: capture failed: {ex.Message}");
            return null;
        }
        finally
        {
            if (dpiChanged)
            {
                try { NativeMethods.SetThreadDpiAwarenessContext(previousDpi); } catch { }
            }
        }
    }

    private static byte[]? EncodeJpeg(Bitmap bitmap, int quality)
    {
        var encoder = JpegEncoder();
        if (encoder is null) return null;
        using var parameters = new EncoderParameters(1);
        parameters.Param[0] = new EncoderParameter(Encoder.Quality, Math.Clamp((long)quality, 1L, 100L));
        using var ms = new MemoryStream();
        bitmap.Save(ms, encoder, parameters);
        return ms.ToArray();
    }

    private static ImageCodecInfo? JpegEncoder()
    {
        foreach (var codec in ImageCodecInfo.GetImageEncoders())
            if (codec.FormatID == ImageFormat.Jpeg.Guid) return codec;
        return null;
    }
}
