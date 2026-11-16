using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Screenshots;

/// <summary>
/// Periodic and on-demand screenshots.
///
///  - Periodic (AUTO): every few minutes while the day is running, only when the
///    person's automatic screenshots are switched on, never while the screen is
///    locked and never during a break or lunch (that time is theirs).
///  - On demand (MANUAL): when a manager asks, at most one per 30 seconds, never
///    while locked.
///  - JPEG, longest side 2560, under 4 MB (the server takes 8 MB; OCR 5 MB).
///  - Stamped with the time it was taken, not the time it was uploaded.
/// </summary>
public sealed class ScreenshotService : IDisposable
{
    public const int MaxLongSide = 2560;
    public const int MaxBytes = 4 * 1024 * 1024;
    private static readonly TimeSpan ManualCooldown = TimeSpan.FromSeconds(30);

    private readonly ApiClient _api;
    private readonly IPlatform _platform;
    private readonly AgentOptions _options;
    private readonly ILog _log;
    private readonly SemaphoreSlim _busy = new(1, 1);
    private Timer? _timer;
    private volatile bool _running;
    private DateTimeOffset _lastManual = DateTimeOffset.MinValue;

    /// <summary>The server's per-person switch for automatic screenshots (from sign-in and every activity ack).</summary>
    public bool AutoEnabled { get; set; } = true;

    /// <summary>Asked before each AUTO capture: false during a break, lunch or ended day.</summary>
    public Func<bool> AllowAuto { get; set; } = () => true;

    public DateTimeOffset LastUpload { get; private set; } = DateTimeOffset.MinValue;

    public ScreenshotService(ApiClient api, IPlatform platform, AgentOptions options, ILog log)
    {
        _api = api;
        _platform = platform;
        _options = options;
        _log = log;
    }

    public void Start()
    {
        if (_running) return;
        _running = true;
        var period = TimeSpan.FromMinutes(_options.ScreenshotMinutes);
        // The first one comes after a random part of the period, never at launch:
        // the switch may be off, and machines started together should not upload together.
        var first = TimeSpan.FromSeconds(Random.Shared.Next(60, (int)Math.Max(61, period.TotalSeconds)));
        _timer = new Timer(_ => _ = CaptureAsync("AUTO"), null, first, period);
    }

    public void Stop()
    {
        _running = false;
        _timer?.Dispose();
        _timer = null;
    }

    /// <summary>A manager asked for a capture now (from the socket).</summary>
    public Task<bool> CaptureNowAsync()
    {
        var now = DateTimeOffset.UtcNow;
        if (now - _lastManual < ManualCooldown)
        {
            _log.Info("screenshots", "manual capture ignored (asked again within 30 s)");
            return Task.FromResult(false);
        }
        _lastManual = now;
        return CaptureAsync("MANUAL");
    }

    private async Task<bool> CaptureAsync(string kind)
    {
        if (!_api.IsSignedIn) return false;
        if (kind == "AUTO" && (!_running || !AutoEnabled || !SafeAllowAuto())) return false;
        if (SafeLocked()) return false;
        if (!await _busy.WaitAsync(0)) return false;
        try
        {
            var takenAt = DateTimeOffset.UtcNow;
            var image = await Task.Run(() => CaptureWithinLimits());
            if (image is null) return false;

            for (var attempt = 1; attempt <= 2; attempt++)
            {
                var result = await _api.UploadScreenshotAsync(image, kind, takenAt);
                if (result.Ok)
                {
                    LastUpload = DateTimeOffset.UtcNow;
                    return true;
                }
                if (result.Outcome != ApiOutcome.Transient)
                {
                    // 403: switched off since; 409: day ended; 413: too big. None improve with a retry.
                    _log.Info("screenshots", $"{kind} upload refused ({result.Status} {result.Code}: {result.Message})");
                    if (result.Status == 403 && kind == "AUTO") AutoEnabled = false;
                    return false;
                }
                if (attempt == 1) await Task.Delay(TimeSpan.FromSeconds(30));
            }
            _log.Warn("screenshots", $"{kind} upload failed twice; dropped");
            return false;
        }
        catch (Exception ex)
        {
            _log.Warn("screenshots", "capture failed", ex);
            return false;
        }
        finally
        {
            _busy.Release();
        }
    }

    private CapturedImage? CaptureWithinLimits()
    {
        foreach (var (side, quality) in new[] { (MaxLongSide, 70), (1920, 60), (1600, 50) })
        {
            var image = _platform.Screen.Capture(side, quality);
            if (image is null) return null;
            if (image.Bytes.Length <= MaxBytes) return image;
        }
        _log.Warn("screenshots", "capture still over 4 MB at the smallest size; skipped");
        return null;
    }

    private bool SafeLocked()
    {
        try { return _platform.Lock.IsLocked; } catch { return false; }
    }

    private bool SafeAllowAuto()
    {
        try { return AllowAuto(); } catch { return true; }
    }

    public void Dispose() => Stop();
}
