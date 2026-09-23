using System.Timers;
using Timer = System.Timers.Timer;

namespace TimeChampAgent.Services;

/// <summary>
/// Samples what the user is doing — the foreground app, window title, the website
/// host if it's a browser, and whether the machine is idle — about once a minute,
/// and reports it to the backend (<c>/activity/report</c>). The server rolls these
/// samples up into "top apps / websites", idle time, an hourly split and the live
/// "using now" view the manager sees.
///
/// The server answers each report with the day's progress and a <c>shouldCapture</c>
/// gate. Sampling runs for the WHOLE working day — including overtime past the 9h
/// basis and idle stretches — and stops only once the user ends their day (the
/// "End Day" button sets <c>shouldCapture = false</c>), at which point this service
/// raises <see cref="DayEnded"/> so the app stops activity + screen captures.
/// <c>clockedOut</c> (9h reached) is informational only and never stops anything.
/// </summary>
public sealed class ActivityService
{
    private readonly ApiClient _api;
    private readonly AgentConfig _config;
    private Timer? _timer;
    private volatile bool _run;

    /// <summary>
    /// Serialises reporting. The timer and the lock/unlock hook can both fire a
    /// sample, and the server closes each sample by the arrival of the next one — so
    /// two reports racing would stamp each other's durations. It matters more now
    /// that waking sends a backdated sample immediately before the live one.
    /// </summary>
    private readonly SemaphoreSlim _reporting = new(1, 1);

    /// <summary>When the last sample this agent sent was stamped. A backdated sleep
    /// sample is never allowed to land before it, because the server only closes a
    /// sample with one that comes after it.</summary>
    private DateTime _lastSampleAtUtc = DateTime.MinValue;

    /// <summary>When a sample last reached the server, for the watchdog to judge by.
    /// <see cref="DateTime.MinValue"/> until the first one lands.</summary>
    public DateTime LastSampleAtUtc => _lastSampleAtUtc;

    /// <summary>Whether sampling is meant to be running — false after <see cref="Stop"/>.</summary>
    public bool IsRunning => _run;

    /// <summary>Raised (once) when the user's working day has ended (End Day).</summary>
    public event Action? DayEnded;

    /// <summary>Carries the server's per-user screenshot switch from every report, so
    /// flipping it in the dashboard reaches the agent within a minute. Screenshots only —
    /// activity tracking is never affected by it.</summary>
    public event Action<bool>? ScreenshotsEnabledChanged;

    public ActivityService(ApiClient api, AgentConfig config)
    {
        _api = api;
        _config = config;
    }

    public void Start()
    {
        if (_run) return;
        _run = true;

        var interval = TimeSpan.FromSeconds(Math.Max(15, _config.ActivitySeconds));
        _timer = new Timer(interval.TotalMilliseconds) { AutoReset = true };
        _timer.Elapsed += (_, _) => _ = SampleAndReport();
        _timer.Start();

        // Locking / unlocking must land on the second it happens, not up to a whole
        // interval later — otherwise the boundary sample straddles both states and
        // work time bleeds into the locked stretch (and vice versa).
        LockWatcher.Start();
        LockWatcher.Changed += OnLockChanged;

        // Start the clocks together, so the stretch before tracking began is never
        // mistaken for a sleep the user should be credited for.
        SleepWatcher.Prime();

        _ = SampleAndReport(); // one immediately so "using now" isn't empty
    }

    public void Stop()
    {
        _run = false;
        LockWatcher.Changed -= OnLockChanged;
        _timer?.Stop();
        _timer?.Dispose();
        _timer = null;
    }

    private void OnLockChanged(bool locked) => _ = SampleAndReport();

    private async Task SampleAndReport()
    {
        if (!_run || !_api.IsAuthenticated) return;
        await _reporting.WaitAsync();
        try
        {
            // Before the live sample: if the machine was asleep, say so, so the hole
            // it left is accounted for rather than silently dropped.
            await ReportSleepIfAnyAsync();

            var report = await Task.Run(BuildSample);
            var ack = await _api.ReportActivityAsync(report);
            // Only once the server has taken it. Stamping this on every attempt made
            // the watchdog blind to the failure it exists to catch: an agent whose
            // reports all fail still looked freshly heard from, so tracking that had
            // stopped was never restarted. Two users lost over an hour each that way.
            if (ack is not null) _lastSampleAtUtc = DateTime.UtcNow;

            // Independent of the day-ended check below: this governs the 5-minute
            // capture alone, and must not touch tracking.
            if (ack is not null) ScreenshotsEnabledChanged?.Invoke(ack.ScreenshotsEnabled);
            // Keep sampling through overtime (clockedOut is informational). Stop only
            // once the day has been ended server-side (shouldCapture flips to false).
            if (ack is { ShouldCapture: false })
            {
                Stop();
                DayEnded?.Invoke();
            }
        }
        catch { /* best-effort telemetry */ }
        finally
        {
            _reporting.Release();
        }
    }

    /// <summary>
    /// Reports a stretch the machine spent asleep, as one sample stamped at the moment
    /// it went under and marked locked.
    ///
    /// That marking is the whole trick. The server already knows how to account for a
    /// hole that opens on a locked sample — it was written for Win+L, where the lock
    /// screen proves nobody was working — and a machine that was demonstrably asleep
    /// is the same fact by a different route. So this needs nothing new on the server:
    /// the sleep sample closes the day's last waking one, and the gap after it is
    /// credited as idle by the rules already in place.
    ///
    /// Sent before the live sample and never after, because the server closes each
    /// sample with whichever one arrives next.
    /// </summary>
    private async Task ReportSleepIfAnyAsync()
    {
        var slept = SleepWatcher.SleepSinceLastCall();
        if (slept is null) return;

        var wentUnder = DateTime.UtcNow - slept.Value;
        // Never behind the last sample sent: the server ignores a sample that predates
        // the open one, which would leave the hole unexplained after all.
        if (_lastSampleAtUtc != DateTime.MinValue && wentUnder <= _lastSampleAtUtc)
            wentUnder = _lastSampleAtUtc.AddSeconds(1);
        if (wentUnder >= DateTime.UtcNow) return;

        var ok = await _api.ReportActivityAsync(new ActivityReport
        {
            At = wentUnder.ToString("o"),
            Idle = true,
            Locked = true,
            // Nobody was in front of any app, so attribute the time to none.
            App = null,
            Title = null,
            Url = null,
            LoginAt = SessionInfo.LoginTimeUtc()?.ToString("o"),
        });

        if (ok is not null) _lastSampleAtUtc = wentUnder;
        App.Log($"slept {slept.Value.TotalMinutes:F0}m from {wentUnder:HH:mm:ss}Z — reported");
    }

    /// <summary>Reads the foreground app/window/website + idle into a report. Off the UI thread.</summary>
    private ActivityReport BuildSample()
    {
        // A locked workstation is idle straight away — no waiting out the threshold,
        // since nobody can be working behind the lock screen.
        var locked = LockWatcher.IsLocked;
        var idle = locked || IdleWatcher.IdleSeconds() >= _config.IdleThresholdSeconds;
        var fg = ForegroundWatcher.Current();

        // Don't read the address bar while idle (nothing is actively happening).
        string? host = idle ? null : BrowserUrl.HostFor(fg.Handle, fg.Process);

        return new ActivityReport
        {
            At = DateTime.UtcNow.ToString("o"),
            Idle = idle,
            Locked = locked,
            // The lock screen isn't the user's app — don't attribute time to whatever
            // happened to be in front when they locked.
            App = locked ? null : fg.App,
            Title = locked ? null : fg.Title,
            Url = host,
            // The PC login time (server keeps the earliest per day). Sent every
            // sample; it's the same value all session, so it's cheap and idempotent.
            LoginAt = SessionInfo.LoginTimeUtc()?.ToString("o"),
        };
    }
}
