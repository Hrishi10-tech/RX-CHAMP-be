using System.Globalization;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Activity;

/// <summary>
/// Samples what the person is doing about once a minute (foreground app, window
/// title, website host, idle, locked) and reports it, through the ordered
/// offline queue. Also reports time asleep and time the agent was not running,
/// as locked samples, so the day's timeline has no unexplained holes.
///
/// Hardened against the ways the 2.x agent lost data: the OS probe runs with a
/// timeout (a hung browser cannot stall sampling), a sample the API rejects is
/// dropped instead of blocking the queue for ever, nothing is sent out of order,
/// and the queue survives restarts.
/// </summary>
public sealed class ActivityTracker : IDisposable
{
    /// <summary>
    /// The most samples one drain sends. The pace itself is the queue's <see cref="SendPacer"/>
    /// (under the server's 120 a minute per person), shared by every drain: a tick, the drain
    /// timer, the batch after the journal, End Day's and sign-out's flush.
    /// </summary>
    public const int DrainPerTick = SendPacer.PerMinute;
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(5);

    private readonly ApiClient _api;
    private readonly IPlatform _platform;
    private readonly AgentOptions _options;
    private readonly ActivityQueue _queue;
    private readonly ILog _log;
    private readonly string _lastSampleFile;
    private Timer? _timer;
    private int _ticking;
    // One drain at a time (a tick's, or End Day's and sign-out's flush): two drains would
    // both send the head of the queue before either removed it.
    private readonly SemaphoreSlim _drainGate = new(1, 1);
    private long _tickStartedTicks; // UTC ticks of the tick in progress; 0 when none
    private volatile bool _running;
    private volatile bool _retired;
    private bool _checkedAway;
    private DateTimeOffset _lastQueuedAt = DateTimeOffset.MinValue;

    public ActivityTracker(ApiClient api, IPlatform platform, AgentOptions options, ActivityQueue queue, ILog log)
    {
        _api = api;
        _platform = platform;
        _options = options;
        _queue = queue;
        _log = log;
        _lastSampleFile = Path.Combine(platform.Paths.DataDir, "last-sample.txt");
    }

    /// <summary>When a tick last ran to the end (whatever the network did). The watchdog's signal.</summary>
    public DateTimeOffset LastTickCompleted { get; private set; } = DateTimeOffset.UtcNow;
    /// <summary>When a sample last reached the server.</summary>
    public DateTimeOffset LastSent { get; private set; } = DateTimeOffset.MinValue;
    public int Pending => _queue.Count;
    public bool IsRunning => _running;

    /// <summary>When the tick now in progress began, or null when none is running. The watchdog's signal.</summary>
    public DateTimeOffset? TickInProgressSince
    {
        get
        {
            var ticks = Interlocked.Read(ref _tickStartedTicks);
            return ticks == 0 ? null : new DateTimeOffset(ticks, TimeSpan.Zero);
        }
    }

    /// <summary>Every acknowledgement (progress, screenshot switch, day ended).</summary>
    public event Action<ActivityAck>? Acknowledged;

    /// <summary>
    /// A sample this old when it is sent is backlog (taken offline, or before a restart), not live.
    /// The server's live lag is 2 minutes; a little more here, so a slow tick never counts.
    /// </summary>
    public static readonly TimeSpan BacklogAge = TimeSpan.FromMinutes(3);

    /// <summary>
    /// The queue emptied after a drain sent backlog samples (4.0): the server now has the
    /// activity data for time recorded offline, so time it reported as unverified may now
    /// count (SPEC 2.4). The day and History are worth reading again.
    /// </summary>
    public event Action? BacklogSent;

    /// <summary>
    /// Asked before anything is sent: false while the agent re-checks the day after the
    /// machine slept (samples are still queued; they wait).
    /// </summary>
    public Func<bool> MaySend { get; set; } = () => true;

    /// <summary>What idle time reads as: the host restarts it at a meeting's fallback (brief 1.8). The OS's by default.</summary>
    public Func<TimeSpan, TimeSpan> IdleFilter { get; set; } = idle => idle;

    public void Start()
    {
        if (_running) return;
        _running = true;
        LastTickCompleted = DateTimeOffset.UtcNow;
        _platform.SleepClock.Prime();
        _platform.Lock.Changed += OnLockChanged;
        var period = TimeSpan.FromSeconds(_options.ActivitySeconds);
        _timer = new Timer(_ => _ = TickAsync(), null, TimeSpan.FromSeconds(2), period);
    }

    public void Stop()
    {
        _running = false;
        _platform.Lock.Changed -= OnLockChanged;
        _timer?.Dispose();
        _timer = null;
    }

    /// <summary>
    /// Replaced by a new tracker (the watchdog, or tracking restarted): stops, and a
    /// drain still in flight sends nothing more, so the two never both send the
    /// same queued samples.
    /// </summary>
    public void Retire()
    {
        _retired = true;
        Stop();
    }

    private void OnLockChanged(bool locked)
    {
        // The boundary must land on the second it happens, not up to a minute later.
        _ = TickAsync();
    }

    /// <summary>One sample plus a drain of the queue. Re-entrant calls are skipped.</summary>
    public async Task TickAsync()
    {
        if (!_running || !_api.IsSignedIn) return;
        if (Interlocked.Exchange(ref _ticking, 1) == 1) return;
        Interlocked.Exchange(ref _tickStartedTicks, DateTimeOffset.UtcNow.UtcTicks);
        try
        {
            var now = DateTimeOffset.UtcNow;
            if (!_checkedAway)
            {
                _checkedAway = true;
                QueueAwaySinceLastRun(now);
            }
            QueueSleepIfAny(now);
            _queue.Enqueue(await BuildSampleAsync(now));
            _lastQueuedAt = now;
            if (SafeMaySend()) await DrainAsync(DrainPerTick, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _log.Warn("activity", "tick failed", ex);
        }
        finally
        {
            LastTickCompleted = DateTimeOffset.UtcNow;
            Interlocked.Exchange(ref _tickStartedTicks, 0);
            Interlocked.Exchange(ref _ticking, 0);
        }
    }

    /// <summary>Sends queued samples, oldest first, stopping at the first transient failure. One drain at a time.</summary>
    public async Task<bool> DrainAsync(int max, CancellationToken ct)
    {
        await _drainGate.WaitAsync(ct);
        try
        {
            return await DrainLockedAsync(max, ct);
        }
        finally
        {
            _drainGate.Release();
        }
    }

    /// <summary>
    /// A drain writes the queue file after this many samples (and when it stops), not after
    /// each one: a week's backlog is a big file. A crash in between sends at most these again.
    /// </summary>
    internal const int PersistEvery = 10;

    private async Task<bool> DrainLockedAsync(int max, CancellationToken ct)
    {
        string? lastSent = null;
        var unsaved = 0;
        var backlog = false;
        try
        {
            var pacer = _queue.Pacer;
            for (var i = 0; i < max; i++)
            {
                if (_retired) return false;
                var head = _queue.Peek();
                if (head is null) return true;
                if (!pacer.TryTake())
                {
                    // The minute's budget is used (or the server asked to wait): the rest waits
                    // for a later drain, in order. Nothing is dropped.
                    NotePaced(pacer);
                    return false;
                }
                var result = await _api.ReportActivityAsync(head, ct);
                switch (result.Outcome)
                {
                    case ApiOutcome.Ok:
                        _queue.Remove(head, persist: false);
                        LastSent = DateTimeOffset.UtcNow;
                        lastSent = head.At;
                        backlog |= IsBacklog(head.At, LastSent);
                        if (result.Data is not null) Acknowledged?.Invoke(result.Data);
                        break;
                    case ApiOutcome.Rejected:
                        // Retrying a request the API refused would block the queue for ever.
                        _log.Warn("activity", $"sample dropped ({result.Status} {result.Code}: {result.Message})");
                        _queue.Remove(head, persist: false);
                        break;
                    case ApiOutcome.Transient when result.Status == 429:
                        // Too many for the server's per-person limit: the sample stays at the head and
                        // nothing goes until the wait it named (or a minute) has passed.
                        pacer.Pause(result.RetryAfter);
                        _log.Info("activity", $"the server asked to slow down (429); {_queue.Count} sample(s) wait until {pacer.NextAllowed:HH:mm:ss}Z");
                        return false;
                    default:
                        return false;
                }
                if (++unsaved >= PersistEvery)
                {
                    _queue.Persist();
                    unsaved = 0;
                }
            }
            return _queue.Count == 0;
        }
        finally
        {
            _queue.Persist();
            if (lastSent is not null) RememberLastSample(lastSent);
            if (backlog && _queue.Count == 0 && !_retired) RaiseBacklogSent();
        }
    }

    private DateTimeOffset _pacedNoted = DateTimeOffset.MinValue;

    /// <summary>Says (at most once a minute) that a backlog is going at the server's pace.</summary>
    private void NotePaced(SendPacer pacer)
    {
        var now = DateTimeOffset.UtcNow;
        if (now - _pacedNoted < TimeSpan.FromMinutes(1)) return;
        _pacedNoted = now;
        _log.Info("activity", $"{_queue.Count} sample(s) waiting; sending at most {SendPacer.PerMinute} a minute (next at {pacer.NextAllowed:HH:mm:ss}Z)");
    }

    /// <summary>Whether a sample taken at <paramref name="atIso"/> and sent at <paramref name="sentAt"/> was backlog.</summary>
    internal static bool IsBacklog(string? atIso, DateTimeOffset sentAt) =>
        DateTimeOffset.TryParse(atIso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) && sentAt - at > BacklogAge;

    private void RaiseBacklogSent()
    {
        try { BacklogSent?.Invoke(); }
        catch (Exception ex) { _log.Warn("activity", "a backlog handler failed", ex); }
    }

    /// <summary>
    /// Sends everything (before End Day, at sign-out), within <paramref name="timeout"/>.
    /// Waits for a drain already under way rather than racing it.
    /// </summary>
    public async Task<bool> FlushAsync(TimeSpan timeout)
    {
        if (!SafeMaySend()) return false;
        using var cts = new CancellationTokenSource(timeout);
        try
        {
            return await DrainAsync(ActivityQueue.MaxItems, cts.Token);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
    }

    /// <summary>
    /// The machine slept and the session turned out to be closed meanwhile: the live
    /// samples queued since it woke belong to no working day and are not sent.
    /// </summary>
    public int DropLiveSince(DateTimeOffset since) => _queue.DropLiveFrom(Iso(since));

    private bool SafeMaySend()
    {
        try { return MaySend(); }
        catch { return true; }
    }

    private async Task<ActivityReport> BuildSampleAsync(DateTimeOffset now)
    {
        var locked = SafeLocked();
        var idleFor = SafeIdle();
        var idle = locked || idleFor >= TimeSpan.FromSeconds(_options.IdleThresholdSeconds);

        var fg = ForegroundInfo.Empty;
        if (!locked)
        {
            var includeUrl = !idle;
            var probe = Task.Run(() => _platform.Foreground.Snapshot(includeUrl));
            try
            {
                fg = await probe.WaitAsync(ProbeTimeout);
            }
            catch (TimeoutException)
            {
                // A hung app (often a browser) must not stall sampling: report what we can.
                _log.Warn("activity", "foreground probe timed out; sending the sample without it");
            }
            catch (Exception ex)
            {
                _log.Warn("activity", "foreground probe failed", ex);
            }
        }

        return new ActivityReport
        {
            At = Iso(now),
            Idle = idle,
            Locked = locked,
            App = locked ? null : fg.App,
            Title = locked ? null : fg.Title,
            Url = idle ? null : fg.Url,
            Kind = "live",
        }.Truncated();
    }

    /// <summary>A locked sample where the machine went to sleep, so the gap reads as away.</summary>
    private void QueueSleepIfAny(DateTimeOffset now)
    {
        TimeSpan? slept;
        try { slept = _platform.SleepClock.SleptSinceLastCall(); }
        catch { slept = null; }
        if (slept is not { } s || s < TimeSpan.FromMinutes(1)) return;

        var wentUnder = now - s;
        if (_lastQueuedAt != DateTimeOffset.MinValue && wentUnder <= _lastQueuedAt) wentUnder = _lastQueuedAt.AddSeconds(1);
        if (wentUnder >= now) return;
        _queue.Enqueue(new ActivityReport { At = Iso(wentUnder), Idle = true, Locked = true, Kind = "sleep" });
        _lastQueuedAt = wentUnder;
        _log.Info("activity", $"slept {s.TotalMinutes:F0} min from {wentUnder:HH:mm:ss}Z");
    }

    /// <summary>
    /// On the first tick: the stretch since the last sample of a previous run (machine off,
    /// agent closed). That is the newest sample sent or still queued: after an offline run
    /// the queue holds samples newer than the last one sent, and the gap starts after them.
    /// </summary>
    private void QueueAwaySinceLastRun(DateTimeOffset now)
    {
        try
        {
            DateTimeOffset? last = null;
            if (File.Exists(_lastSampleFile)
                && DateTimeOffset.TryParse(File.ReadAllText(_lastSampleFile).Trim(), CultureInfo.InvariantCulture,
                    DateTimeStyles.AssumeUniversal, out var sent))
                last = sent;
            if (_queue.LastAt is { } queuedText
                && DateTimeOffset.TryParse(queuedText, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var queued)
                && (last is null || queued > last))
                last = queued;
            if (last is not { } from) return;
            var gap = now - from;
            // Only a real gap from the same stretch of days; anything longer is a new day anyway.
            if (gap < TimeSpan.FromMinutes(5) || gap > TimeSpan.FromHours(20)) return;
            var at = from.AddSeconds(1);
            _queue.Enqueue(new ActivityReport { At = Iso(at), Idle = true, Locked = true, Kind = "away" });
            _lastQueuedAt = at;
            _log.Info("activity", $"away {gap.TotalMinutes:F0} min since the last run");
        }
        catch (Exception ex)
        {
            _log.Warn("activity", "could not read the last sample time", ex);
        }
    }

    private void RememberLastSample(string at)
    {
        try { AtomicFile.WriteAllBytes(_lastSampleFile, System.Text.Encoding.UTF8.GetBytes(at)); }
        catch { }
    }

    private bool SafeLocked()
    {
        try { return _platform.Lock.IsLocked; } catch { return false; }
    }

    private TimeSpan SafeIdle()
    {
        try { return IdleFilter(_platform.Idle.IdleTime()); } catch { return TimeSpan.Zero; }
    }

    internal static string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    public void Dispose() => Stop();
}
