using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Platform.Mac.Native;
using SkiaSharp;

namespace RXVision.Agent.Platform.Mac;

/// <summary>
/// Captures every display with the system <c>screencapture</c> tool, stitches them
/// side by side, scales so the longest side is within the limit, and re-encodes as
/// JPEG with SkiaSharp. Returns null (never throws) when Screen Recording is not
/// granted, when nothing could be captured, or on timeout (15 s budget).
/// </summary>
[SupportedOSPlatform("macos")]
internal sealed class MacScreenCapture : IScreenCapture
{
    private static readonly TimeSpan Budget = TimeSpan.FromSeconds(15);
    private readonly string _tempDir;
    private readonly ILog _log;

    public MacScreenCapture(string tempDir, ILog log)
    {
        _tempDir = tempDir;
        _log = log;
        SweepLeftovers(tempDir, DateTime.UtcNow, log);
    }

    /// <summary>
    /// Security review S-09: a crash, a force quit or an update's kill can stop a capture before its
    /// files are deleted, leaving a full-size image of every screen in the cache folder. Any
    /// capture file older than a minute is a leftover (a capture takes 15 seconds at most).
    /// </summary>
    internal static int SweepLeftovers(string tempDir, DateTime nowUtc, ILog log)
    {
        var removed = 0;
        try
        {
            if (!Directory.Exists(tempDir)) return 0;
            foreach (var file in Directory.EnumerateFiles(tempDir, "cap-*.jpg"))
            {
                try
                {
                    if (nowUtc - File.GetLastWriteTimeUtc(file) < TimeSpan.FromMinutes(1)) continue;
                    File.Delete(file);
                    removed++;
                }
                catch { /* the next start tries again */ }
            }
            if (removed > 0) log.Info("screen", $"removed {removed} capture file(s) left by an earlier run");
        }
        catch { }
        return removed;
    }

    public CapturedImage? Capture(int maxLongSide, int quality)
    {
        try
        {
            if (!CoreGraphics.CGPreflightScreenCaptureAccess())
            {
                _log.Info("screen", "screen recording permission not granted; no capture");
                return null;
            }
        }
        catch (Exception ex)
        {
            _log.Warn("screen", "preflight failed", ex);
            return null;
        }

        var deadline = DateTimeOffset.UtcNow + Budget;
        var files = new List<string>();
        // Every file screencapture may have written, used or not (a killed or failed
        // run can still leave a screenshot behind): all are deleted below.
        var written = new List<string>();
        try
        {
            var count = DisplayCount();
            for (var i = 1; i <= count; i++)
            {
                var remaining = deadline - DateTimeOffset.UtcNow;
                if (remaining <= TimeSpan.Zero) break;
                var file = Path.Combine(_tempDir, $"cap-{Guid.NewGuid():N}.jpg");
                written.Add(file);
                var result = ProcessRunner.Run("/usr/sbin/screencapture",
                    new[] { "-x", "-t", "jpg", "-D", i.ToString(), file }, remaining);
                if (result.Ok && File.Exists(file) && new FileInfo(file).Length > 0)
                    files.Add(file);
                else if (result.TimedOut)
                    _log.Warn("screen", $"screencapture timed out on display {i}");
            }

            if (files.Count == 0)
            {
                _log.Info("screen", "no displays captured");
                return null;
            }

            return Compose(files, maxLongSide, quality);
        }
        catch (Exception ex)
        {
            _log.Warn("screen", "capture failed", ex);
            return null;
        }
        finally
        {
            foreach (var f in written)
            {
                try { if (File.Exists(f)) File.Delete(f); } catch { }
            }
        }
    }

    private static int DisplayCount()
    {
        try
        {
            if (CoreGraphics.CGGetActiveDisplayList(0, null, out var count) == 0 && count >= 1)
                return (int)Math.Min(count, 16u);
        }
        catch { }
        return 1;
    }

    private CapturedImage? Compose(List<string> files, int maxLongSide, int quality)
    {
        var bitmaps = new List<SKBitmap>();
        try
        {
            foreach (var f in files)
            {
                var bmp = SKBitmap.Decode(f);
                if (bmp is not null) bitmaps.Add(bmp);
            }
            if (bitmaps.Count == 0) return null;

            var totalWidth = bitmaps.Sum(b => b.Width);
            var maxHeight = bitmaps.Max(b => b.Height);
            if (totalWidth <= 0 || maxHeight <= 0) return null;

            using var stitched = new SKBitmap(totalWidth, maxHeight, SKColorType.Rgba8888, SKAlphaType.Premul);
            using (var canvas = new SKCanvas(stitched))
            {
                canvas.Clear(SKColors.Black);
                var x = 0;
                foreach (var b in bitmaps)
                {
                    canvas.DrawBitmap(b, x, 0); // top-aligned side by side
                    x += b.Width;
                }
            }

            var longest = Math.Max(totalWidth, maxHeight);
            SKBitmap toEncode = stitched;
            SKBitmap? resized = null;
            if (longest > maxLongSide && maxLongSide > 0)
            {
                var scale = maxLongSide / (double)longest;
                var newW = Math.Max(1, (int)Math.Round(totalWidth * scale));
                var newH = Math.Max(1, (int)Math.Round(maxHeight * scale));
                resized = stitched.Resize(new SKImageInfo(newW, newH), SKFilterQuality.Medium);
                if (resized is not null) toEncode = resized;
            }

            try
            {
                using var image = SKImage.FromBitmap(toEncode);
                using var data = image.Encode(SKEncodedImageFormat.Jpeg, Math.Clamp(quality, 1, 100));
                if (data is null) return null;
                return new CapturedImage(data.ToArray(), "image/jpeg", toEncode.Width, toEncode.Height);
            }
            finally
            {
                resized?.Dispose();
            }
        }
        finally
        {
            foreach (var b in bitmaps) b.Dispose();
        }
    }
}
