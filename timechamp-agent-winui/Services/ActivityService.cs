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

    /// <summary>Raised (once) when the user's working day has ended (End Day).</summary>
    public event Action? DayEnded;

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
        try
        {
            var report = await Task.Run(BuildSample);
            var ack = await _api.ReportActivityAsync(report);
            // Keep sampling through overtime (clockedOut is informational). Stop only
            // once the day has been ended server-side (shouldCapture flips to false).
            if (ack is { ShouldCapture: false })
            {
                Stop();
                DayEnded?.Invoke();
            }
        }
        catch { /* best-effort telemetry */ }
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
        };
    }
}
