using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;

namespace RXVision.Agent.Core.Meetings;

public enum MeetingAlertKind { StartMeeting, EndMeeting, StillInMeeting, BackToWorking }

/// <summary>
/// A card the meeting feature wants on top of the panel, with its badge on the icon: never a
/// window of its own. <see cref="At"/>: when the meeting started (Still in a meeting?), or when
/// the status moved (Back to Working).
/// </summary>
public sealed record MeetingAlert(MeetingAlertKind Kind, string? App = null, bool IsHuddle = false, DateTimeOffset? At = null)
{
    /// <summary>"!" when an answer is needed, else "i".</summary>
    public bool NeedsAction => Kind == MeetingAlertKind.StillInMeeting;
    public string Badge => NeedsAction ? "!" : "i";
}

/// <summary>
/// What the meeting feature watches, and nothing else about the person: the server's two times
/// for the 2 hour check, read from the day progress so a restart or a sleep loses neither, and
/// the call detectors' tick. Only ever produces cards. The one thing it asks of the server is
/// the day progress at the fallback moment; every status change is the server's answer to a
/// tap, or the server's own fallback.
/// </summary>
public sealed class MeetingMonitor
{
    /// <summary>How often the detectors run, while Working or In a meeting and unlocked.</summary>
    public static readonly TimeSpan CallTickEvery = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan ProbeLimit = TimeSpan.FromSeconds(8);
    /// <summary>The server's and the agent's clocks can differ by this much at the fallback moment.</summary>
    private static readonly TimeSpan FallbackSlack = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan FallbackAskEvery = TimeSpan.FromSeconds(5);
    /// <summary>
    /// Core review C-R09: quick asks per fallback moment; after these the agent asks once a minute
    /// (the API's poll limit), so a clock running ahead, or a server that keeps answering MEETING
    /// with a past moment, never turns into twelve calls a minute.
    /// </summary>
    internal const int FallbackQuickAsks = 6;
    private static readonly TimeSpan FallbackAskSlow = TimeSpan.FromMinutes(1);

    private readonly IPlatform _platform;
    private readonly IClock _clock;
    private readonly ILog _log;
    private readonly CallDetectionTable _table;
    private readonly string _os;
    private readonly object _gate = new();
    private readonly CallTracker _tracker = new();
    private DayProgress? _progress;
    private DateTimeOffset? _fellBackAt;
    private IReadOnlyList<MeetingAlert> _alerts = Array.Empty<MeetingAlert>();
    private TimeSpan _fallbackAskedAt = TimeSpan.MinValue;
    private DateTimeOffset? _fallbackAskedFor;
    private int _fallbackAsks;
    private int _callTicking;
    private Task<IReadOnlyList<DetectedCall>>? _probe;
    private volatile bool _endTapped;

    /// <summary>The pacing clock for the fallback asks (4.0 has no monotonic clock: the server clock stands in).</summary>
    private TimeSpan Now => TimeSpan.FromTicks(_clock.UtcNow.UtcTicks);

    public MeetingMonitor(IPlatform platform, IClock clock, ILog log, CallDetectionTable? table = null)
    {
        _platform = platform;
        _clock = clock;
        _log = log;
        _table = table ?? CallDetectionTable.Shipped;
        _os = CallDetectionTable.OsKey(platform.Name);
    }

    /// <summary>The person's status now, as far as suggestions care. Set by the host.</summary>
    public Func<MeetingCallStatus> Status { get; set; } = () => MeetingCallStatus.Other;

    /// <summary>Set by the host: the fallback moment has come, ask the server (it applies the fallback on read).</summary>
    public Action<DayProgress> FallbackDue { get; set; } = _ => { };

    /// <summary>The cards to show, what needs an answer first.</summary>
    public IReadOnlyList<MeetingAlert> Alerts { get { lock (_gate) return _alerts; } }

    /// <summary>The cards changed. Background thread.</summary>
    public event Action? AlertsChanged;

    /// <summary>The server's fallback ran at that moment: idle timers restart there. Background thread.</summary>
    public event Action<DateTimeOffset>? FellBack;

    /// <summary>The person tapped End meeting: its answer is not the fallback's, whatever the time.</summary>
    public void EndTapped(bool tapped) => _endTapped = tapped;

    /// <summary>A new day progress: what it was, and what it is now.</summary>
    public void OnProgress(DayProgress? before, DayProgress now)
    {
        DateTimeOffset? fellBackAt = null;
        var status = Status();
        lock (_gate)
        {
            _progress = now;
            if (before is { InMeeting: true, MeetingFallbackAt: { } fallback } && !now.InMeeting
                && _clock.UtcNow >= fallback - FallbackSlack)
            {
                fellBackAt = fallback;
                if (now.Status == DayProgressStatus.Working && !_endTapped) _fellBackAt = fallback;
            }
            if (now.Status != DayProgressStatus.Working) _fellBackAt = null;
            _tracker.Settle(status);
        }
        if (fellBackAt is { } at)
        {
            _log.Info("meetings", "no answer to the 2 hour check; back to Working");
            FellBack?.Invoke(at);
        }
        ApplyRestore();
        Publish();
    }

    /// <summary>The agent's second: the prompt comes on time and the fallback is asked for at its moment. Cheap.</summary>
    public void Tick()
    {
        DayProgress? due = null;
        lock (_gate)
        {
            if (_progress is { InMeeting: true, MeetingFallbackAt: { } fallback } running && _clock.UtcNow >= fallback)
            {
                if (_fallbackAskedFor != fallback)
                {
                    _fallbackAskedFor = fallback;
                    _fallbackAsks = 0;
                    _fallbackAskedAt = TimeSpan.MinValue;
                }
                var every = _fallbackAsks < FallbackQuickAsks ? FallbackAskEvery : FallbackAskSlow;
                if (_fallbackAskedAt == TimeSpan.MinValue || Now - _fallbackAskedAt >= every)
                {
                    _fallbackAskedAt = Now;
                    _fallbackAsks++;
                    due = running;
                }
            }
            if (_progress is not { InMeeting: true })
            {
                _fallbackAskedAt = TimeSpan.MinValue;
                _fallbackAskedFor = null;
                _fallbackAsks = 0;
            }
        }
        if (due is not null) FallbackDue(due);
        Publish();
    }

    /// <summary>Not now on a suggestion: it ends for that call. Or the Back to Working card's Close.</summary>
    public void Dismiss(MeetingAlertKind kind)
    {
        DateTimeOffset? read = null;
        lock (_gate)
        {
            if (kind is MeetingAlertKind.StartMeeting or MeetingAlertKind.EndMeeting) _tracker.Dismiss();
            if (kind == MeetingAlertKind.BackToWorking)
            {
                read = _fellBackAt;
                _fellBackAt = null;
            }
        }
        if (read is { } at) FallbackCardRead?.Invoke(at);
        Publish();
    }

    /// <summary>The Back to Working card for the fallback at this moment was read (the host keeps it on disk).</summary>
    public event Action<DateTimeOffset>? FallbackCardRead;

    private (IReadOnlyList<MeetingRecord> Today, DateTimeOffset? AlreadyRead)? _restore;

    /// <summary>
    /// Core review C-R08: after a restart (or an update) during the 2 hour fallback the agent has
    /// no earlier answer to compare with. Today's meetings say it: the last status meeting ended
    /// NO_ANSWER and the person is Working, so the card comes back (unless it was read) and idle
    /// time restarts at that moment. Applied with the first day progress if none is known yet.
    /// </summary>
    public void RestoreFallback(IReadOnlyList<MeetingRecord> today, DateTimeOffset? alreadyRead)
    {
        lock (_gate) _restore = (today, alreadyRead);
        ApplyRestore();
    }

    private void ApplyRestore()
    {
        DateTimeOffset? fellBack = null;
        lock (_gate)
        {
            if (_restore is not { } restore || _progress is null) return;
            _restore = null;
            if (_progress.Status != DayProgressStatus.Working || _fellBackAt is not null) return;
            if (restore.Today.Any(m => m.IsStatus && m.InProgress)) return;
            var last = restore.Today.Where(m => m.IsStatus && m.EndedAt is not null).OrderBy(m => m.EndedAt).LastOrDefault();
            if (last is not { EndReason: "NO_ANSWER", EndedAt: { } endedAt } || endedAt == restore.AlreadyRead) return;
            _fellBackAt = endedAt;
            fellBack = endedAt;
        }
        _log.Info("meetings", "restarted after the 2 hour fallback; the Back to Working card is shown again");
        FellBack?.Invoke(fellBack.Value);
        Publish();
    }

    /// <summary>The panel closed: the card that only informs has been read.</summary>
    public void PanelClosed() => Dismiss(MeetingAlertKind.BackToWorking);

    /// <summary>A new day, or someone else signing in: nothing carries over.</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _tracker.Reset();
            _progress = null;
            _fellBackAt = null;
            _fallbackAskedAt = TimeSpan.MinValue;
            _restore = null;
        }
        _endTapped = false;
        Publish();
    }

    /// <summary>The day ended or has not started: no call carries into the next stretch of work.</summary>
    public void ForgetCalls()
    {
        lock (_gate) _tracker.Reset();
        Publish();
    }

    /// <summary>
    /// Tests: one tick that really runs. A timer's tick may be running already (a moved clock
    /// fires it); CallTickAsync would then skip, so this waits for it to finish first.
    /// </summary>
    internal bool CallTicking => Volatile.Read(ref _callTicking) == 1 || _probe is { IsCompleted: false };

    internal async Task CallTickWhenFreeAsync()
    {
        while (Volatile.Read(ref _callTicking) == 1) await Task.Delay(5);
        await CallTickAsync();
    }

    /// <summary>One tick of the call detectors. Keeps nothing but which row saw a call.</summary>
    public async Task CallTickAsync()
    {
        if (Interlocked.Exchange(ref _callTicking, 1) == 1) return;
        try
        {
            if (Status() == MeetingCallStatus.Other)
            {
                lock (_gate) _tracker.Settle(MeetingCallStatus.Other);
                Publish();
                return;
            }
            if (_platform.Lock.IsLocked) return;
            // Core review C-R12: a probe that timed out may still be blocked inside the OS (a hung
            // browser's tabs). No new probe starts until it has come back, so blocked threads never pile up.
            if (_probe is { IsCompleted: false }) return;
            IReadOnlyList<DetectedCall> seen;
            var probe = _probe = Task.Run(ReadCalls);
            try
            {
                seen = await probe.WaitAsync(ProbeLimit);
            }
            catch (TimeoutException)
            {
                _log.Info("meetings", "the window read timed out; this tick does not count");
                return;
            }
            var status = Status();
            lock (_gate) _tracker.Tick(seen, status);
            Publish();
        }
        catch (Exception ex)
        {
            _log.Warn("meetings", "call detection tick failed", ex);
        }
        finally
        {
            Interlocked.Exchange(ref _callTicking, 0);
        }
    }

    private IReadOnlyList<DetectedCall> ReadCalls()
    {
        var windows = _platform.CallWindows.WindowsOf(_table.OwnersFor(_os));
        var seen = _table.Match(_os, windows);
        // A page on another site can call itself the same: the existing foreground read names the host.
        if (seen.Any(c => c.BrowserOwner is not null))
            seen = _table.Match(_os, windows, _platform.Foreground.Snapshot(includeUrl: true));

        // A browser window's title shows only its active tab: look for the tab before calling the call ended.
        List<DetectedCall> tracked;
        lock (_gate) tracked = _tracker.Confirmed.Where(c => c.BrowserOwner is not null).ToList();
        foreach (var call in tracked.Where(c => seen.All(s => s.Id != c.Id)))
        {
            if (_table.TabHoldsCall(call.Id, _platform.CallWindows.TabTitlesOf(call.BrowserOwner!)))
                seen = seen.Append(call).ToList();
        }
        return seen;
    }

    private void Publish()
    {
        bool changed;
        lock (_gate)
        {
            var next = Compute();
            changed = !next.SequenceEqual(_alerts);
            if (changed) _alerts = next;
        }
        if (changed) AlertsChanged?.Invoke();
    }

    private List<MeetingAlert> Compute()
    {
        var list = new List<MeetingAlert>();
        if (_progress is { InMeeting: true, MeetingPromptAt: { } prompt } p && _clock.UtcNow >= prompt)
            list.Add(new MeetingAlert(MeetingAlertKind.StillInMeeting, At: p.MeetingStartedAt));
        if (_fellBackAt is { } at) list.Add(new MeetingAlert(MeetingAlertKind.BackToWorking, At: at));
        if (_tracker.Suggestion is { } s)
            list.Add(new MeetingAlert(s.Kind == CallSuggestionKind.StartMeeting ? MeetingAlertKind.StartMeeting : MeetingAlertKind.EndMeeting, s.App, s.IsHuddle));
        return list;
    }
}
