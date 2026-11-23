using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Breaks;

/// <summary>Result of trying to start a break.</summary>
public abstract record StartOutcome
{
    public sealed record Started(BreakRecord? Record, string PresenceType) : StartOutcome;
    /// <summary>Early or late: ask for a reason (at least <paramref name="MinChars"/> characters) and try again.</summary>
    public sealed record NeedsReason(string Timing, int MinutesOff, int MinChars, string Message) : StartOutcome;
    /// <summary>The server refused (window closed, already taken, day ended...). Show the message.</summary>
    public sealed record Refused(string Code, string Message) : StartOutcome;
    /// <summary>No answer from the server. Nothing started; the person can try again.</summary>
    public sealed record Offline(string Message) : StartOutcome;
}

/// <summary>Result of Back to work (a break, lunch or meeting).</summary>
public abstract record EndOutcome
{
    public sealed record Ended(BreakRecord? Record) : EndOutcome;
    /// <summary>A meeting ended (or was discarded: under a minute is not kept).</summary>
    public sealed record MeetingEnded(MeetingRecord? Meeting, bool Discarded) : EndOutcome;
    public sealed record NothingRunning : EndOutcome;
    /// <summary>Asked to count the minutes over without enough of a reason (the shift wants <paramref name="MinChars"/>).</summary>
    public sealed record NeedsReason(int MinChars, string Message) : EndOutcome;
    public sealed record Offline(string Message) : EndOutcome;
    public sealed record Refused(string Message) : EndOutcome;
}

/// <summary>Result of skipping a scheduled break.</summary>
public abstract record SkipOutcome
{
    public sealed record Skipped(BreakRecord? Record) : SkipOutcome;
    /// <summary>A reason of at least <paramref name="MinChars"/> characters is needed (422 REASON_REQUIRED).</summary>
    public sealed record NeedsReason(int MinChars, string Message) : SkipOutcome;
    /// <summary>The server refused (window closed, already taken, not allowed...). Show the message.</summary>
    public sealed record Refused(string Code, string Message) : SkipOutcome;
    /// <summary>No answer: nothing was skipped; the person can try again.</summary>
    public sealed record Offline(string Message) : SkipOutcome;
}

/// <summary>Result of a quick break, a pause or a resume (4.0).</summary>
public abstract record ActionOutcome
{
    public sealed record Done(BreakRecord? Record) : ActionOutcome;
    /// <summary>It can't happen now (not on a break, window closed, quick breaks can't pause...). Show the message.</summary>
    public sealed record Refused(string Code, string Message) : ActionOutcome;
}

/// <summary>Result of adding the comment to a skip.</summary>
public abstract record CommentOutcome
{
    public sealed record Saved(BreakRecord? Record) : CommentOutcome;
    /// <summary>Too short for the shift's minimum (422 REASON_REQUIRED).</summary>
    public sealed record NeedsReason(int MinChars, string Message) : CommentOutcome;
    /// <summary>It already has a reason, or is not a skip (409 COMMENT_NOT_NEEDED). Nothing to do.</summary>
    public sealed record NotNeeded(string Message) : CommentOutcome;
    public sealed record Refused(string Code, string Message) : CommentOutcome;
    public sealed record Offline(string Message) : CommentOutcome;
}

/// <summary>
/// Today's scheduled breaks: keeps the day the server sent, refreshes it, and
/// starts, skips and ends breaks. On a day without a schedule (or against an older
/// server) it falls back to the plain break/lunch statuses.
/// </summary>
public sealed class BreakService
{
    private const int DefaultMinChars = 10;
    private readonly ApiClient _api;
    private readonly ServerClock _clock;
    private readonly ILog _log;
    private readonly object _gate = new();
    private BreakDay? _day;
    private bool _serverSupportsSchedule = true;
    private DateTimeOffset _lastRefresh = DateTimeOffset.MinValue;
    private readonly HashSet<string> _seenAutoSkips = new();
    // Bumped by Reset (sign-out): a day asked for by the session before is never kept.
    private long _epoch;
    // Every GET is numbered; an answer older than the one already kept is dropped (a slow
    // answer must not bring back a break just taken, or its ring).
    private long _requestSeq;
    private long _keptSeq;

    public BreakService(ApiClient api, ServerClock clock, ILog log)
    {
        _api = api;
        _clock = clock;
        _log = log;
    }

    /// <summary>Raised whenever the day changes (refresh, start, end). Background thread.</summary>
    public event Action? Changed;

    /// <summary>
    /// A break of today was auto-skipped (its window closed untaken) and waits for the
    /// person's comment. Raised once per record, after <see cref="Changed"/>. Background thread.
    /// </summary>
    public event Action<BreakRecord>? AutoSkipped;

    public BreakDay? Day { get { lock (_gate) return _day; } }
    public bool ServerSupportsSchedule => _serverSupportsSchedule;
    public DateTimeOffset LastRefresh { get { lock (_gate) return _lastRefresh; } }
    public DateTimeOffset Now => _clock.UtcNow;

    /// <summary>The minimum length of a reason or comment for this shift.</summary>
    public int MinChars
    {
        get
        {
            var day = Day;
            var min = day?.ReasonMinChars ?? day?.Shift?.Rules.ReasonMinChars ?? DefaultMinChars;
            return Math.Clamp(min, 1, 500);
        }
    }

    /// <summary>The panel as of now (call every second from the UI).</summary>
    public BreakPanel Panel() => BreakSchedule.Compute(Day, _clock.UtcNow);

    public async Task<bool> RefreshAsync(CancellationToken ct = default)
    {
        if (!_serverSupportsSchedule || !_api.IsSignedIn) return false;
        var epoch = Interlocked.Read(ref _epoch);
        var seq = Interlocked.Increment(ref _requestSeq);
        var result = await _api.GetBreakDayAsync(ct);
        if (result.Ok && result.Data is not null)
        {
            List<BreakRecord> fresh;
            lock (_gate)
            {
                if (_epoch != epoch) return false;
                if (seq < _keptSeq)
                {
                    _log.Debug("breaks", "an older answer arrived after a newer one; not kept");
                    return false;
                }
                _keptSeq = seq;
                _day = result.Data;
                fresh = NewAutoSkipsLocked(result.Data, _clock.UtcNow);
                _lastRefresh = DateTimeOffset.UtcNow;
            }
            Changed?.Invoke();
            foreach (var record in fresh)
            {
                _log.Info("breaks", $"{record.Kind} was auto-skipped at its window's close");
                AutoSkipped?.Invoke(record);
            }
            return true;
        }
        if (result.Outcome == ApiOutcome.Rejected && result.Status == 404)
        {
            // An API from before scheduled breaks: work the old way from now on.
            _serverSupportsSchedule = false;
            _log.Info("breaks", "server has no break schedule; using plain break/lunch");
            lock (_gate) _day = null;
            Changed?.Invoke();
        }
        return false;
    }

    /// <summary>
    /// Today's auto-skips waiting for a comment that have not been announced yet. One End
    /// Day made while its window is still open is not news yet: the break can still be
    /// taken (it is announced if the window then closes untaken).
    /// </summary>
    private List<BreakRecord> NewAutoSkipsLocked(BreakDay day, DateTimeOffset now)
    {
        var fresh = new List<BreakRecord>();
        foreach (var slot in day.Breaks)
        {
            if (slot.Record is not { IsAutoSkip: true, NeedsComment: true } record || string.IsNullOrEmpty(record.Id)) continue;
            if (BreakSchedule.IsReplaceableAutoSkip(record, slot.WindowClose, now)) continue;
            if (_seenAutoSkips.Add(record.Id)) fresh.Add(record);
        }
        return fresh;
    }

    /// <summary>
    /// Skips the person is already being asked about (the End Day dialog lists them):
    /// a later refresh that finds them does not announce them a second time.
    /// </summary>
    public void MarkAnnounced(IEnumerable<string> breakIds)
    {
        lock (_gate)
        {
            foreach (var id in breakIds)
                if (!string.IsNullOrEmpty(id)) _seenAutoSkips.Add(id);
        }
    }

    /// <summary>Clears everything (sign-out).</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _day = null;
            _seenAutoSkips.Clear();
            _epoch++;
        }
        _serverSupportsSchedule = true;
        Changed?.Invoke();
    }

    /// <summary>
    /// Starts a scheduled break. Pass the reason when the panel said one is needed
    /// (or after a NeedsReason answer). On a day without a schedule, use <see cref="StartFreeAsync"/>.
    /// </summary>
    public async Task<StartOutcome> StartAsync(string kind, string? reason, CancellationToken ct = default)
    {
        var result = await _api.StartBreakAsync(kind, reason, ct);
        if (result.Ok)
        {
            _log.Info("breaks", $"started {kind} ({result.Data?.Record.Timing})");
            await RefreshAsync(ct);
            return new StartOutcome.Started(result.Data?.Record, result.Data?.Record.PresenceType ?? "BREAK");
        }
        if (result.Transient) return new StartOutcome.Offline("Can't reach RX Vision, so the break hasn't started. Try again in a moment.");
        if (result.Code is "BREAK_NOT_SCHEDULED" or "BREAK_ALREADY_TAKEN" or "BREAK_ORDER" or "ALREADY_ON_BREAK"
            or "BREAK_WINDOW_CLOSED" or "DAY_ENDED" or "DAY_NOT_STARTED")
        {
            // The day changed under us (an override, a skip elsewhere, the window closed): refresh so the panel says so.
            await RefreshAsync(ct);
        }
        return StartRefusal(result, MinChars);
    }

    /// <summary>A refused break start in the person's terms (also for a replayed one).</summary>
    public static StartOutcome StartRefusal<T>(ApiResult<T> result, int minChars)
    {
        if (result.Outcome == ApiOutcome.Unauthorized) return new StartOutcome.Refused("SIGNED_OUT", "You're signed out. Sign in again to take a break.");
        if (result.Code == "REASON_REQUIRED")
        {
            return new StartOutcome.NeedsReason(
                result.DetailString("timing") ?? "LATE",
                result.DetailInt("minutesOff") ?? 0,
                result.DetailInt("minChars") ?? minChars,
                result.Message ?? "Add a reason for your manager.");
        }
        return new StartOutcome.Refused(result.Code ?? "REFUSED", result.Message ?? "That break can't start right now.");
    }

    /// <summary>A plain break or lunch (no schedule today, or an older server).</summary>
    public async Task<StartOutcome> StartFreeAsync(string presenceType, CancellationToken ct = default)
    {
        var result = await _api.StartPresenceAsync(presenceType, null, ct);
        if (result.Ok)
        {
            await RefreshAsync(ct);
            return new StartOutcome.Started(null, presenceType);
        }
        if (result.Transient) return new StartOutcome.Offline("Can't reach RX Vision, so the break hasn't started. Try again in a moment.");
        return new StartOutcome.Refused(result.Code ?? "REFUSED", result.Message ?? "That can't start right now.");
    }

    /// <summary>
    /// Skips a scheduled break while its window is open. The reason is required
    /// (the shift's minimum) except for a Super Admin.
    /// </summary>
    public async Task<SkipOutcome> SkipAsync(string kind, string? reason, CancellationToken ct = default)
    {
        var result = await _api.SkipBreakAsync(kind, reason, ct);
        if (result.Ok)
        {
            _log.Info("breaks", $"skipped {kind}");
            await RefreshAsync(ct);
            return new SkipOutcome.Skipped(result.Data?.Record);
        }
        if (result.Transient) return new SkipOutcome.Offline("Can't reach RX Vision, so the break isn't skipped. Try again in a moment.");
        if (result.Outcome != ApiOutcome.Unauthorized && result.Code != "REASON_REQUIRED")
        {
            // The window closed, it was taken or skipped elsewhere, the day ended: show it as it is now.
            await RefreshAsync(ct);
        }
        return SkipRefusal(result, MinChars);
    }

    /// <summary>A refused skip in the person's terms (also for a replayed one).</summary>
    public static SkipOutcome SkipRefusal<T>(ApiResult<T> result, int minChars)
    {
        if (result.Outcome == ApiOutcome.Unauthorized) return new SkipOutcome.Refused("SIGNED_OUT", "You're signed out. Sign in again to skip a break.");
        if (result.Code == "REASON_REQUIRED")
        {
            return new SkipOutcome.NeedsReason(
                Math.Clamp(result.DetailInt("minChars") ?? minChars, 1, 500),
                result.Message ?? "Add a reason for your manager.");
        }
        return new SkipOutcome.Refused(result.Code ?? "REFUSED", result.Message ?? "That break can't be skipped right now.");
    }

    /// <summary>The one comment a skip with no reason takes (any approval status).</summary>
    public async Task<CommentOutcome> CommentAsync(string breakId, string comment, CancellationToken ct = default)
    {
        var result = await _api.CommentBreakAsync(breakId, comment, ct);
        if (result.Ok)
        {
            _log.Info("breaks", "comment added to a skipped break");
            await RefreshAsync(ct);
            return new CommentOutcome.Saved(result.Data?.Record);
        }
        if (result.Transient) return new CommentOutcome.Offline("Can't reach RX Vision, so the comment isn't saved. Try again in a moment.");
        if (result.Outcome != ApiOutcome.Unauthorized && result.Code != "REASON_REQUIRED") await RefreshAsync(ct);
        return CommentRefusal(result, MinChars);
    }

    /// <summary>A refused comment in the person's terms (also for a replayed one).</summary>
    public static CommentOutcome CommentRefusal<T>(ApiResult<T> result, int minChars)
    {
        if (result.Outcome == ApiOutcome.Unauthorized) return new CommentOutcome.Refused("SIGNED_OUT", "You're signed out. Sign in again to add a comment.");
        return result.Code switch
        {
            "REASON_REQUIRED" => new CommentOutcome.NeedsReason(
                Math.Clamp(result.DetailInt("minChars") ?? minChars, 1, 500),
                result.Message ?? "Add a little more for your manager."),
            "COMMENT_NOT_NEEDED" => new CommentOutcome.NotNeeded(result.Message ?? "That break already has a comment."),
            _ => new CommentOutcome.Refused(result.Code ?? (result.Status == 404 ? "NOT_FOUND" : "REFUSED"),
                result.Message ?? "That comment can't be added."),
        };
    }

    /// <summary>
    /// Back to work. Never refused by the server for being late; a retry after
    /// success is harmless. <paramref name="askToCount"/>: see <see cref="ApiClient.EndBreakAsync"/>.
    /// </summary>
    public async Task<EndOutcome> EndAsync(string? overrunReason, bool? askToCount = null, CancellationToken ct = default)
    {
        if (_serverSupportsSchedule)
        {
            var result = await _api.EndBreakAsync(overrunReason, askToCount, ct);
            if (result.Ok)
            {
                await RefreshAsync(ct);
                return result.Data is { Ended: true } ? new EndOutcome.Ended(result.Data.Record) : new EndOutcome.NothingRunning();
            }
            if (result.Transient) return new EndOutcome.Offline("Can't reach RX Vision. Your break is still running; try again in a moment.");
            if (result.Code == "REASON_REQUIRED")
            {
                return new EndOutcome.NeedsReason(
                    Math.Clamp(result.DetailInt("minChars") ?? MinChars, 1, 500),
                    result.Message ?? "Add a reason for your manager, or leave the minutes out.");
            }
            if (result.Status != 404) return new EndOutcome.Refused(result.Message ?? "Couldn't end the break.");
        }

        var plain = await _api.EndPresenceAsync(ct);
        if (plain.Ok) return new EndOutcome.Ended(null);
        if (plain.Transient) return new EndOutcome.Offline("Can't reach RX Vision. Your break is still running; try again in a moment.");
        return new EndOutcome.Refused(plain.Message ?? "Couldn't end the break.");
    }
}
