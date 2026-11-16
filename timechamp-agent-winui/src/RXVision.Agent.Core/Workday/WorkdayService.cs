using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Workday;

/// <summary>Result of Start Day.</summary>
public abstract record StartDayOutcome
{
    /// <summary>The day is open (a new session, or the one already open); tracking runs.</summary>
    public sealed record Started(WorkdayToday? Workday, bool Resumed) : StartDayOutcome;
    /// <summary>
    /// No answer from the server. The press is kept and retried in the background
    /// with the time it was made (<paramref name="PressedAt"/>, server clock), so it is never lost.
    /// </summary>
    public sealed record Pending(DateTimeOffset PressedAt, string Message) : StartDayOutcome;
    /// <summary>The server refused. Show the message.</summary>
    public sealed record Refused(string Code, string Message) : StartDayOutcome;
}

/// <summary>Result of End Day, with the server's two gates as their own answers.</summary>
public abstract record EndDayOutcome
{
    public sealed record Ended(WorkdayToday? Workday, DateTimeOffset? EndedAt) : EndDayOutcome;
    /// <summary>409 SKIP_COMMENTS_REQUIRED: one comment per break listed, then End Day again with them.</summary>
    public sealed record CommentsRequired(IReadOnlyList<SkipNeedingComment> Breaks, string Message) : EndDayOutcome;
    /// <summary>
    /// 422 COMMENT_INVALID: one comment was refused, so none was saved and nothing ended.
    /// <paramref name="Problem"/> is the server's reason (see <see cref="CommentProblems"/>):
    /// TOO_SHORT and TOO_LONG are fixed by editing that break's box; the others mean the
    /// break no longer takes a comment, so it should leave the list.
    /// </summary>
    public sealed record CommentInvalid(string? BreakId, int? MinChars, string Message, string? Problem = null) : EndDayOutcome
    {
        /// <summary>Editing the comment can fix it (too short, too long, or a reason the server did not give).</summary>
        public bool FixableByEditing => Problem is null or CommentProblems.TooShort or CommentProblems.TooLong;
    }
    /// <summary>409 APPROVALS_OVERDUE: a manager with approvals past their due time cannot end the day.</summary>
    public sealed record ApprovalsOverdue(int Count, DateTimeOffset? OldestDueAt, string Message) : EndDayOutcome;
    /// <summary>409 DAY_NOT_STARTED: there is nothing to end.</summary>
    public sealed record NotStarted(string Message) : EndDayOutcome;
    /// <summary>No answer: the day is still running; nothing was lost.</summary>
    public sealed record Offline(string Message) : EndDayOutcome;
    public sealed record Refused(string Code, string Message) : EndDayOutcome;
}

/// <summary>
/// An End Day done offline that the server refused when it reached it, for comments on
/// skipped breaks (409 SKIP_COMMENTS_REQUIRED): <paramref name="At"/> is when the person
/// ended the day, <paramref name="Breaks"/> what the server listed: skips already made and
/// the auto-skips End Day will make, each with the id it will get. End Day sent again at
/// <paramref name="At"/> with a comment for each, keyed by exactly those ids, ends that day then.
/// </summary>
public sealed record HeldEndDay(DateTimeOffset At, IReadOnlyList<SkipNeedingComment> Breaks, string Message);

/// <summary>Why End Day refused one comment (details.problem of 422 COMMENT_INVALID).</summary>
public static class CommentProblems
{
    public const string TooShort = "TOO_SHORT";
    public const string TooLong = "TOO_LONG";
    public const string NotFound = "NOT_FOUND";
    public const string NotYours = "NOT_YOURS";
    public const string NotASkip = "NOT_A_SKIP";
    public const string Duplicate = "DUPLICATE";
}

/// <summary>
/// The working day as the server sees it (GET /workday/me/today), and Start Day
/// and End Day with their answers turned into <see cref="StartDayOutcome"/> and
/// <see cref="EndDayOutcome"/>. Holds no state of its own beyond the last answer:
/// <see cref="AgentHost"/> decides what each answer means for tracking.
/// </summary>
public sealed class WorkdayService
{
    private readonly ApiClient _api;
    private readonly ILog _log;
    private readonly object _gate = new();
    private WorkdayToday? _today;
    // Bumped by every answer kept: an answer asked for before a newer one landed is not kept.
    private long _version;
    // Bumped by Reset (sign-out): an answer for the session before is never kept.
    private long _epoch;

    public WorkdayService(ApiClient api, ILog log)
    {
        _api = api;
        _log = log;
    }

    /// <summary>The last answer (null until the first one).</summary>
    public WorkdayToday? Today { get { lock (_gate) return _today; } }

    /// <summary>A new answer arrived. Background thread.</summary>
    public event Action? Changed;

    /// <summary>
    /// Asks the server for today. An answer is kept unless a newer one (say from
    /// Start Day) arrived while this one was on its way.
    /// </summary>
    public async Task<ApiResult<WorkdayToday>> RefreshAsync(CancellationToken ct = default)
    {
        var seen = Interlocked.Read(ref _version);
        var epoch = Interlocked.Read(ref _epoch);
        var result = await _api.GetWorkdayTodayAsync(ct);
        if (result.Ok && result.Data is { } day)
        {
            bool kept;
            lock (_gate)
            {
                kept = _version == seen && _epoch == epoch;
                if (kept)
                {
                    _today = day;
                    _version++;
                }
            }
            if (kept) Changed?.Invoke();
        }
        return result;
    }

    public void Set(WorkdayToday day) => SetIfCurrent(day, Interlocked.Read(ref _epoch));

    /// <summary>Keeps the answer unless the day was forgotten (sign-out) since it was asked for.</summary>
    private void SetIfCurrent(WorkdayToday day, long epoch)
    {
        lock (_gate)
        {
            if (_epoch != epoch) return;
            _today = day;
            _version++;
        }
        Changed?.Invoke();
    }

    /// <summary>Forgets the day (sign-out).</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _today = null;
            _version++;
            _epoch++;
        }
        Changed?.Invoke();
    }

    /// <summary>
    /// POST /activity/start-day. <paramref name="retryOf"/> is the time of the
    /// original press when this is a retry (sent as startedAt), else null.
    /// </summary>
    public async Task<StartDayOutcome> StartAsync(DateTimeOffset? retryOf, DateTimeOffset pressedAt, CancellationToken ct = default)
    {
        var epoch = Interlocked.Read(ref _epoch);
        var result = await _api.StartDayAsync(retryOf, ct);
        if (result.Ok)
        {
            var day = result.Data?.Workday;
            if (day is not null) SetIfCurrent(day, epoch);
            _log.Info("day", $"Start Day accepted{(result.Data?.Resumed == true ? " (resumed)" : "")}{(retryOf is null ? "" : $", pressed at {retryOf:HH:mm:ss}Z")}");
            return new StartDayOutcome.Started(day, result.Data?.Resumed ?? false);
        }
        if (result.Transient)
            return new StartDayOutcome.Pending(retryOf ?? pressedAt, "Can't reach RX Vision yet. Your day starts as soon as it answers.");
        if (result.Outcome == ApiOutcome.Unauthorized)
            return new StartDayOutcome.Refused("SIGNED_OUT", "You're signed out. Sign in again to start your day.");
        return new StartDayOutcome.Refused(result.Code ?? "REFUSED", result.Message ?? "Couldn't start your day.");
    }

    /// <summary>POST /activity/end-day with the comments for skipped breaks (if any).</summary>
    public async Task<EndDayOutcome> EndAsync(IReadOnlyList<SkipComment>? comments, CancellationToken ct = default)
    {
        var epoch = Interlocked.Read(ref _epoch);
        var result = await _api.EndDayAsync(comments, ct);
        if (result.Ok)
        {
            var day = result.Data?.Workday;
            if (day is not null) SetIfCurrent(day, epoch);
            return new EndDayOutcome.Ended(day, result.Data?.EndedAt);
        }
        if (result.Transient)
            return new EndDayOutcome.Offline("Can't reach RX Vision, so your day is still running. Check your connection and try again.");
        return EndDayRefusal(result);
    }

    /// <summary>A refused End Day in the person's terms, its gates typed (also for a replayed one).</summary>
    public static EndDayOutcome EndDayRefusal<T>(ApiResult<T> result)
    {
        if (result.Outcome == ApiOutcome.Unauthorized)
            return new EndDayOutcome.Refused("SIGNED_OUT", "You're signed out. Sign in again to end your day.");

        var message = result.Message ?? "Couldn't end your day.";
        switch (result.Code)
        {
            case "SKIP_COMMENTS_REQUIRED":
                var breaks = result.Detail<List<SkipNeedingComment>>("breaks") ?? new List<SkipNeedingComment>();
                return new EndDayOutcome.CommentsRequired(breaks.Where(b => !string.IsNullOrEmpty(b.Id)).ToList(), message);
            case "APPROVALS_OVERDUE":
                return new EndDayOutcome.ApprovalsOverdue(Math.Max(0, result.DetailInt("count") ?? 0), result.DetailTime("oldestDueAt"), message);
            case "COMMENT_INVALID":
                return new EndDayOutcome.CommentInvalid(result.DetailString("breakId"), result.DetailInt("minChars"), message, result.DetailString("problem"));
            case "DAY_NOT_STARTED":
                return new EndDayOutcome.NotStarted(message);
            default:
                return new EndDayOutcome.Refused(result.Code ?? "REFUSED", message);
        }
    }
}

/// <summary>
/// Focus time between the server's answers: its focusSec at serverNow, plus the
/// time since while it is running, stopping where a break or lunch began. The
/// server is the authority; this only keeps the number moving on screen.
/// </summary>
public static class FocusClock
{
    /// <param name="day">The last answer (null: nothing known, 0).</param>
    /// <param name="now">Now on the server's clock.</param>
    /// <param name="pausedSince">When a break or lunch began, if one is running now.</param>
    public static int At(WorkdayToday? day, DateTimeOffset now, DateTimeOffset? pausedSince = null)
    {
        if (day is null) return 0;
        var focus = Math.Max(0, day.Focus.FocusSec);
        if (!day.Focus.Running || day.ServerNow == default) return focus;
        var until = now;
        if (pausedSince is { } paused && paused < until) until = paused;
        var since = (until - day.ServerNow).TotalSeconds;
        if (since <= 0) return focus;
        // A day is never longer than a day: a wildly wrong clock must not show nonsense.
        return focus + (int)Math.Min(since, TimeSpan.FromHours(24).TotalSeconds);
    }
}

/// <summary>
/// "You're at your desk. Start Day?": keyboard or mouse use for 5 minutes in a row
/// while the day is not started, at most once an hour. Fed a sample every half
/// minute or so; a minute without input, or a locked screen, starts it over.
/// </summary>
public sealed class DeskNudge
{
    public static readonly TimeSpan ActiveFor = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan AtMostEvery = TimeSpan.FromHours(1);
    /// <summary>Input within this long counts as still at the desk (short pauses are normal).</summary>
    public static readonly TimeSpan Pause = TimeSpan.FromSeconds(60);

    private DateTimeOffset? _since;
    private DateTimeOffset _last = DateTimeOffset.MinValue;

    /// <summary>The last nudge (or greeting), which the hourly limit counts from.</summary>
    public DateTimeOffset LastNudge => _last;

    /// <summary>Counts a greeting toward the hourly limit, so the two never come back to back.</summary>
    public void Shown(DateTimeOffset at)
    {
        _last = at;
        _since = null;
    }

    public void Reset() => _since = null;

    /// <summary>True when the nudge is due now (and records it).</summary>
    public bool Observe(DateTimeOffset now, TimeSpan idle, bool locked)
    {
        if (locked || idle >= Pause || idle < TimeSpan.Zero)
        {
            _since = null;
            return false;
        }
        _since ??= now - idle;
        if (now - _since.Value < ActiveFor || now - _last < AtMostEvery) return false;
        Shown(now);
        return true;
    }
}
