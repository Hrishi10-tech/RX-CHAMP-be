using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Workday;

/// <summary>
/// The server's last word on the status and the ring (GET /me/day-progress). One reading for
/// everything that shows them: the floating icon, the panel and the meeting check.
/// </summary>
public sealed class DayProgressService
{
    private readonly ApiClient _api;
    private readonly ILog _log;
    private readonly object _gate = new();
    private DayProgress? _current;
    // Bumped by every answer kept and by Reset: an answer asked for before it is old.
    private long _stamp;

    public DayProgressService(ApiClient api, ILog log)
    {
        _api = api;
        _log = log;
    }

    /// <summary>The last answer, or null before the first.</summary>
    public DayProgress? Current { get { lock (_gate) return _current; } }

    /// <summary>A new answer was kept: what it was before, and what it is now. Background thread.</summary>
    public event Action<DayProgress?, DayProgress>? Changed;

    /// <summary>Reads it again. Returns what the server said, or null when it could not be asked.</summary>
    public async Task<DayProgress?> RefreshAsync(CancellationToken ct = default)
    {
        if (!_api.IsSignedIn) return null;
        long stamp;
        lock (_gate) stamp = _stamp;
        var result = await _api.GetDayProgressAsync(ct);
        if (!result.Ok || result.Data is not { } answer)
        {
            _log.Debug("day", $"day progress not read ({result.Outcome} {result.Status})");
            return null;
        }
        Keep(answer, stamp);
        return answer;
    }

    /// <summary>An answer that came another way: a status route, or the local switch at the fallback.</summary>
    public void Accept(DayProgress answer)
    {
        long stamp;
        lock (_gate) stamp = _stamp;
        Keep(answer, stamp);
    }

    /// <summary>Forgets everything (sign-out).</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _current = null;
            _stamp++;
        }
    }

    private void Keep(DayProgress answer, long stamp)
    {
        DayProgress? before;
        lock (_gate)
        {
            if (_stamp != stamp) return;
            before = _current;
            _current = answer;
            _stamp++;
        }
        Changed?.Invoke(before, answer);
    }
}
