using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Approvals;

/// <summary>
/// The person's own items with their approver (GET /approvals/me), for the
/// "Waiting for your manager" card: pending first, then recent decisions.
/// </summary>
public sealed class ApprovalService
{
    public const int Days = 7;

    private readonly ApiClient _api;
    private readonly ILog _log;
    private readonly object _gate = new();
    private IReadOnlyList<ApprovalItem> _mine = Array.Empty<ApprovalItem>();
    // Bumped by Reset (sign-out): a list asked for by the session before is never kept.
    private long _epoch;

    public ApprovalService(ApiClient api, ILog log)
    {
        _api = api;
        _log = log;
    }

    public IReadOnlyList<ApprovalItem> Mine { get { lock (_gate) return _mine; } }

    /// <summary>The list changed. Background thread.</summary>
    public event Action? Changed;

    public async Task<bool> RefreshAsync(CancellationToken ct = default)
    {
        if (!_api.IsSignedIn) return false;
        var epoch = Interlocked.Read(ref _epoch);
        var result = await _api.GetMyApprovalsAsync(Days, ct);
        if (!result.Ok || result.Data is null)
        {
            if (result.Outcome == ApiOutcome.Rejected) _log.Debug("approvals", $"waiting list refused: {result}");
            return false;
        }
        var items = (result.Data.Items ?? new List<ApprovalItem>())
            .Where(i => !string.IsNullOrEmpty(i.Id))
            .ToList();
        lock (_gate)
        {
            if (_epoch != epoch) return false;
            _mine = items;
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>Forgets everything (sign-out).</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _mine = Array.Empty<ApprovalItem>();
            _epoch++;
        }
        Changed?.Invoke();
    }
}
