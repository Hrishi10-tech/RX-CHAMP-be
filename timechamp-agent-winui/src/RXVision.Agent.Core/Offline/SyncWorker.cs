using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Offline;

/// <summary>What became of one action, for a caller that waited a moment for it.</summary>
public abstract record EventFate
{
    /// <summary>The server took it.</summary>
    public sealed record Done(ApiResult<JsonElement> Result) : EventFate;
    /// <summary>The server refused it for good; it was taken out of the journal.</summary>
    public sealed record Refused(ApiResult<JsonElement> Result) : EventFate;
    /// <summary>Not answered yet (offline, or behind older actions): it stays in the journal.</summary>
    public sealed record Pending : EventFate;
}

/// <summary>
/// The one sender of journalled actions (SPEC 6 "Sync"): oldest first, one at a time,
/// with X-Client-Event-Id and X-Event-At. Success or a final refusal removes the action
/// (a refusal is logged and told once); anything else waits with backoff (2 s to 5 min,
/// with jitter) and is tried again: action N+1 never goes before N. A new action wakes
/// it at once. When the journal empties after sending, <see cref="Drained"/> asks for a
/// fresh day from the server.
/// </summary>
public sealed class SyncWorker : IDisposable
{
    /// <summary>The refusal of an action that acts on something the server refused before (never sent).</summary>
    public const string TargetRefused = "What it acted on was not saved.";

    private readonly OfflineDay _day;
    private readonly Func<ApiClient?> _api;
    private readonly ILog _log;
    private readonly Backoff _backoff;
    private readonly SemaphoreSlim _wake = new(0, int.MaxValue);
    private readonly Dictionary<string, TaskCompletionSource<EventFate>> _waiters = new();
    private readonly object _gate = new();
    private CancellationTokenSource? _stop;
    private Task? _loop;
    private volatile bool _lastFailed;

    public SyncWorker(OfflineDay day, Func<ApiClient?> api, ILog log, Backoff? backoff = null)
    {
        _day = day;
        _api = api;
        _log = log;
        _backoff = backoff ?? new Backoff(TimeSpan.FromSeconds(2), TimeSpan.FromMinutes(5));
    }

    /// <summary>A refusal nobody was waiting for (to be shown once). Background thread.</summary>
    public event Action<JournalEvent, ApiResult<JsonElement>>? Refused;

    /// <summary>The journal emptied after sending: read the day from the server again. Background thread.</summary>
    public event Action? Drained;

    /// <summary>Whether sending is allowed now (signed in, not held).</summary>
    public Func<bool> MaySend { get; set; } = () => true;

    /// <summary>The last send got no answer (offline).</summary>
    public bool Offline => _lastFailed;

    public bool Running => _loop is { IsCompleted: false };

    public void Start()
    {
        lock (_gate)
        {
            if (Running) return;
            _stop = new CancellationTokenSource();
            var token = _stop.Token;
            _loop = Task.Run(() => LoopAsync(token));
        }
        Poke();
    }

    public void Stop()
    {
        lock (_gate)
        {
            _stop?.Cancel();
            _stop = null;
            foreach (var waiter in _waiters.Values) waiter.TrySetResult(new EventFate.Pending());
            _waiters.Clear();
        }
    }

    /// <summary>Try now (a new action, the network back, an unlock).</summary>
    public void Poke()
    {
        if (_wake.CurrentCount < 4) _wake.Release();
    }

    /// <summary>
    /// An id for an action about to be recorded, whose caller will wait for its fate:
    /// registered before the action exists, so an answer that comes back at once (the
    /// sender is quick) is never missed and never told twice.
    /// </summary>
    public string Expect()
    {
        var id = Guid.NewGuid().ToString();
        lock (_gate) _waiters[id] = NewWaiter();
        return id;
    }

    /// <summary>The caller of an expected action will not wait (offline): its fate so far, if any.</summary>
    public EventFate Release(string eventId)
    {
        TaskCompletionSource<EventFate>? tcs;
        lock (_gate)
        {
            if (!_waiters.Remove(eventId, out tcs)) return new EventFate.Pending();
        }
        return tcs.Task.IsCompleted ? tcs.Task.Result : new EventFate.Pending();
    }

    /// <summary>Waits up to <paramref name="timeout"/> for the server's word on one action (its caller).</summary>
    public async Task<EventFate> WaitAsync(string eventId, TimeSpan timeout)
    {
        if (timeout <= TimeSpan.Zero || !Running) return Release(eventId);
        TaskCompletionSource<EventFate> tcs;
        lock (_gate)
        {
            if (!_waiters.TryGetValue(eventId, out tcs!))
            {
                tcs = NewWaiter();
                _waiters[eventId] = tcs;
            }
        }
        Poke();
        await Task.WhenAny(tcs.Task, Task.Delay(timeout)).ConfigureAwait(false);
        // Settled while the wait was ending: the caller still gets it (it is not told twice).
        lock (_gate) _waiters.Remove(eventId);
        return tcs.Task.IsCompleted ? tcs.Task.Result : new EventFate.Pending();
    }

    private static TaskCompletionSource<EventFate> NewWaiter() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    // Completed each time the sender settles an action or a send fails (FlushAsync watches it).
    private TaskCompletionSource _progress = new(TaskCreationOptions.RunContinuationsAsynchronously);

    private void SignalProgress() => Interlocked.Exchange(ref _progress, new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).TrySetResult();

    /// <summary>
    /// Sends everything now, waiting up to <paramref name="timeout"/>; true when the journal
    /// is empty. It is not the actions' caller: a refusal on the way is told as usual.
    /// Stops early when a send gets no answer (offline).
    /// </summary>
    public async Task<bool> FlushAsync(TimeSpan timeout)
    {
        var until = DateTimeOffset.UtcNow + timeout;
        var failuresBefore = Volatile.Read(ref _failures);
        while (_day.PendingCount > 0 && Running)
        {
            var left = until - DateTimeOffset.UtcNow;
            if (left <= TimeSpan.Zero) break;
            var progress = Volatile.Read(ref _progress).Task;
            Poke();
            if (await Task.WhenAny(progress, Task.Delay(left)).ConfigureAwait(false) != progress) break;
            if (_api() is not { IsSignedIn: true }) break;
            // One failed try may be a hiccup (a 502 while the server restarts); two in a row: offline.
            if (_lastFailed && Volatile.Read(ref _failures) - failuresBefore >= 2) break;
        }
        return _day.PendingCount == 0;
    }

    private int _failures;

    private async Task LoopAsync(CancellationToken stop)
    {
        while (!stop.IsCancellationRequested)
        {
            TimeSpan? delay = null;
            try
            {
                delay = await SendAllAsync(stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stop.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _log.Error("sync", "sending the journal failed", ex);
                delay = _backoff.Next();
            }
            try
            {
                // Wait for a poke, or the backoff when something is waiting.
                if (delay is { } d) await _wake.WaitAsync(d, stop).ConfigureAwait(false);
                else await _wake.WaitAsync(stop).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>Sends oldest first until the journal is empty (null) or a send fails (the delay before the next try).</summary>
    private async Task<TimeSpan?> SendAllAsync(CancellationToken stop)
    {
        var sentSomething = false;
        while (!stop.IsCancellationRequested)
        {
            var api = _api();
            if (api is null || !api.IsSignedIn || !SafeMaySend()) return _day.PendingCount > 0 ? TimeSpan.FromSeconds(30) : null;
            if (!_day.JournalLoaded) return TimeSpan.FromSeconds(10);
            var head = _day.Pending.FirstOrDefault();
            if (head is null)
            {
                _backoff.Reset();
                if (sentSomething) RaiseDrained();
                return null;
            }

            var request = EventRequests.Build(head, _day.Resolve);
            if (request is null)
            {
                // It acts on something the server never took: it can never be sent.
                _log.Warn("sync", $"{head} dropped: what it acts on was refused earlier");
                var local = new ApiResult<JsonElement>
                {
                    Outcome = ApiOutcome.Rejected,
                    Status = 409,
                    Code = "NOT_FOUND",
                    Message = TargetRefused,
                };
                _day.Refuse(head);
                Settle(head, new EventFate.Refused(local), local);
                sentSomething = true;
                continue;
            }

            _day.BeginSend();
            ApiResult<JsonElement> result;
            try
            {
                result = await api.SendEventAsync(request.Method, request.Path, request.Body, head.Id, head.At, head.Seq, stop).ConfigureAwait(false);
                if (result.Outcome == ApiOutcome.Rejected && EventRequests.Fallback(head, result) is { } fallback)
                {
                    _log.Info("sync", $"{head}: the server has no {request.Path}; using {fallback.Path}");
                    result = await api.SendEventAsync(fallback.Method, fallback.Path, fallback.Body, head.Id, head.At, head.Seq, stop).ConfigureAwait(false);
                }
            }
            finally
            {
                _day.EndSend();
            }

            switch (result.Outcome)
            {
                case ApiOutcome.Ok:
                    _lastFailed = false;
                    _backoff.Reset();
                    _day.Acknowledge(head, EventRequests.CreatedId(result.Data));
                    _log.Info("sync", $"{head} sent{(head.Attempts > 0 ? $" after {head.Attempts} tr{(head.Attempts == 1 ? "y" : "ies")}" : "")}");
                    Settle(head, new EventFate.Done(result), null);
                    sentSomething = true;
                    continue;
                case ApiOutcome.Rejected:
                    _lastFailed = false;
                    _backoff.Reset();
                    _log.Warn("sync", $"{head} refused for good: {result.Status} {result.Code}: {result.Message}");
                    _day.Refuse(head);
                    Settle(head, new EventFate.Refused(result), result);
                    sentSomething = true;
                    continue;
                case ApiOutcome.Unauthorized:
                    // The session is gone: everything stays in the journal for the next sign-in.
                    _lastFailed = false;
                    _log.Warn("sync", $"{head} not sent: signed out; {_day.PendingCount} action(s) kept");
                    SignalProgress();
                    return null;
                default:
                    _lastFailed = true;
                    Interlocked.Increment(ref _failures);
                    head.Attempts++;
                    var wait = _backoff.Next();
                    _log.Info("sync", $"{head} not sent ({result.Status} {result.Message}); {_day.PendingCount} waiting, next try in {wait.TotalSeconds:F0} s");
                    SignalProgress();
                    return wait;
            }
        }
        return null;
    }

    /// <summary>Tells a waiting caller; a refusal nobody waited for is raised once.</summary>
    private void Settle(JournalEvent e, EventFate fate, ApiResult<JsonElement>? refusal)
    {
        try
        {
            // Its caller is waiting (or about to): it gets the answer. Decided under the
            // lock, so a caller that stops waiting at this moment still sees the result.
            lock (_gate)
            {
                if (_waiters.TryGetValue(e.Id, out var waiter) && waiter.TrySetResult(fate)) return;
            }
            if (refusal is null) return;
            try { Refused?.Invoke(e, refusal); }
            catch (Exception ex) { _log.Error("sync", "a refusal handler failed", ex); }
        }
        finally
        {
            SignalProgress();
        }
    }

    private void RaiseDrained()
    {
        try { Drained?.Invoke(); }
        catch (Exception ex) { _log.Error("sync", "a drained handler failed", ex); }
    }

    private bool SafeMaySend()
    {
        try { return MaySend(); }
        catch { return true; }
    }

    public void Dispose() => Stop();
}
