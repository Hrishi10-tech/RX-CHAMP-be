using System.Runtime.ExceptionServices;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Platform;

/// <summary>The secret store did not answer in time (a Keychain prompt nobody has answered yet, a hung store).</summary>
public sealed class SecretStoreTimeoutException : TimeoutException
{
    public SecretStoreTimeoutException(string message) : base(message) { }
}

/// <summary>
/// The platform's secret store with a time limit on every call. On macOS a Keychain
/// read by a build the item does not trust yet (after an ad-hoc signed update) waits
/// for the person to answer a password prompt, and a denied or locked Keychain can
/// hang; nothing may wait on that, least of all start-up.
/// <list type="bullet">
/// <item>A call that does not finish in time is left to finish in the background. A read
/// throws <see cref="SecretStoreTimeoutException"/>: "not known yet", never "nothing
/// stored" (a file key is never replaced because its read timed out).</item>
/// <item>While that call is still out (for up to <see cref="FailFastFor"/>), later calls
/// fail at once instead of queueing behind it (the Keychain store serialises calls),
/// so a sample never waits on the Keychain.</item>
/// <item>When it finishes, <see cref="Answered"/> is raised, and what a late read
/// returned is handed to the next read of that key (an answered prompt is not asked
/// again).</item>
/// </list>
/// </summary>
public sealed class TimeBoundSecretStore : ISecretStore
{
    /// <summary>How long later calls fail at once while a call that ran over is still out.</summary>
    public static readonly TimeSpan FailFastFor = TimeSpan.FromMinutes(3);
    /// <summary>How long a late read's answer stays good for the next read of its key.</summary>
    private static readonly TimeSpan LateResultFor = TimeSpan.FromMinutes(10);

    private readonly ISecretStore _inner;
    private readonly TimeSpan _limit;
    private readonly ILog _log;
    private readonly object _gate = new();
    private Task? _out;
    private DateTimeOffset _outSince;
    private readonly Dictionary<string, (byte[]? Value, DateTimeOffset At)> _late = new();

    public TimeBoundSecretStore(ISecretStore inner, TimeSpan limit, ILog log)
    {
        _inner = inner;
        _limit = limit;
        _log = log;
    }

    /// <summary>A call that ran over its limit has finished: the store answers again (raised on a pool thread).</summary>
    public event Action? Answered;

    /// <summary>A call that ran over its limit is still out: calls fail at once.</summary>
    public bool Unanswered
    {
        get { lock (_gate) return IsOutLocked(); }
    }

    public byte[]? Load(string key)
    {
        lock (_gate)
        {
            if (_late.Remove(key, out var late) && DateTimeOffset.UtcNow - late.At < LateResultFor) return late.Value;
            ThrowIfOutLocked(key);
        }
        var task = OwnThread(() => _inner.Load(key));
        if (Finished(task)) return task.Result;
        RanOver(task, $"read of '{key}'", t =>
        {
            lock (_gate) _late[key] = (((Task<byte[]?>)t).Result, DateTimeOffset.UtcNow);
        });
        throw new SecretStoreTimeoutException($"the secret store did not answer a read of '{key}' within {_limit.TotalSeconds:F1} s");
    }

    public void Save(string key, byte[] data)
    {
        lock (_gate)
        {
            _late.Remove(key);
            ThrowIfOutLocked(key);
        }
        var task = OwnThread(() => { _inner.Save(key, data); return true; });
        if (!Finished(task)) RanOver(task, $"save of '{key}'", null);
    }

    public void Delete(string key)
    {
        lock (_gate)
        {
            _late.Remove(key);
            ThrowIfOutLocked(key);
        }
        var task = OwnThread(() => { _inner.Delete(key); return true; });
        if (!Finished(task)) RanOver(task, $"delete of '{key}'", null);
    }

    /// <summary>
    /// The store's call on a thread of its own, never a thread-pool one. The caller waits for
    /// it (often holding a lock: the journal's, the day's, the file key's), so a call queued
    /// on the pool would wait behind whatever the pool is busy with; when sign-in starts a
    /// burst of work on a two-core machine, a 1 ms file write then ran over the 10-second
    /// limit, and every secret call failed for minutes after (seen end to end).
    /// </summary>
    private static Task<T> OwnThread<T>(Func<T> call) =>
        Task.Factory.StartNew(call, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

    private bool IsOutLocked() =>
        _out is { IsCompleted: false } && DateTimeOffset.UtcNow - _outSince < FailFastFor;

    private void ThrowIfOutLocked(string key)
    {
        if (IsOutLocked())
            throw new SecretStoreTimeoutException($"the secret store has not answered an earlier call; '{key}' is not tried now");
    }

    /// <summary>True when it finished in time; rethrows its own failure as is.</summary>
    private bool Finished(Task task)
    {
        try
        {
            return task.Wait(_limit);
        }
        catch (AggregateException ex) when (ex.InnerException is not null)
        {
            ExceptionDispatchInfo.Capture(ex.InnerException).Throw();
            throw;
        }
    }

    private void RanOver(Task task, string what, Action<Task>? onLate)
    {
        lock (_gate)
        {
            _out = task;
            _outSince = DateTimeOffset.UtcNow;
        }
        _log.Warn("secrets", $"the secret store did not finish a {what} within {_limit.TotalSeconds:F1} s; later calls fail at once until it does");
        task.ContinueWith(t =>
        {
            if (t.IsCompletedSuccessfully)
            {
                onLate?.Invoke(t);
                _log.Info("secrets", $"the secret store answered the {what} late");
            }
            else
            {
                _log.Warn("secrets", $"the late {what} failed", t.Exception);
            }
            bool current;
            lock (_gate)
            {
                current = ReferenceEquals(_out, t);
                if (current) _out = null;
            }
            if (current)
            {
                try { Answered?.Invoke(); }
                catch (Exception ex) { _log.Warn("secrets", "an Answered handler failed", ex); }
            }
        }, TaskScheduler.Default);
    }
}
