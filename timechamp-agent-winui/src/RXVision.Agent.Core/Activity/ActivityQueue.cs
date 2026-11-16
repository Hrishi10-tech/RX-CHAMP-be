using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Activity;

/// <summary>
/// Samples waiting to reach the server, strictly oldest first, kept on disk
/// (encrypted: window titles are personal data) so a restart, a crash or an
/// update loses nothing. One file per person, so on a shared PC one person's
/// samples can never be sent as another's.
///
/// Order matters to the server: it credits a sample's duration only when a
/// later one arrives, so anything sent out of order would count for nothing.
///
/// 4.0: an offline stretch can last days, and the server keeps offline backlog for
/// up to 7 days (a day replayed from the journal counts as focus only the time its
/// samples cover), so nothing is dropped for its age: the cap is a whole week at the
/// fastest sampling rate (3.x kept about 16 hours). The server decides what is too
/// old to store; a wrong PC clock can never make the agent throw samples away.
/// </summary>
public sealed class ActivityQueue
{
    /// <summary>A week at the fastest sampling rate (one every 30 seconds). Beyond that the oldest go first.</summary>
    public const int MaxItems = 7 * 24 * 120;

    private readonly object _gate = new();
    private readonly List<ActivityReport> _items = new();
    private readonly ProtectedFile _file;
    private readonly ILog _log;
    private readonly int _maxItems;
    // Removals not written yet (a drain saves every few samples, not the whole file after each one).
    private bool _dirty;

    /// <param name="maxItems">Tests only: a smaller cap than <see cref="MaxItems"/>.</param>
    public ActivityQueue(ISecretStore secrets, string dataDir, string userId, ILog log, int maxItems = MaxItems)
    {
        _log = log;
        _maxItems = Math.Max(1, maxItems);
        var safe = new string(userId.Where(char.IsLetterOrDigit).ToArray());
        _file = new ProtectedFile(secrets, Path.Combine(dataDir, $"queue-{safe}.bin"), hidden: true);
        Load();
    }

    public int Count { get { lock (_gate) return _items.Count; } }

    /// <summary>The pace this person's samples may be sent at (the server's per-person limit), shared by every tracker.</summary>
    public SendPacer Pacer { get; } = new();

    /// <summary>The newest sample's time (ISO UTC), or null when nothing waits.</summary>
    public string? LastAt { get { lock (_gate) return _items.Count > 0 ? _items[^1].At : null; } }

    public void Enqueue(ActivityReport report)
    {
        lock (_gate)
        {
            // Never behind what is already queued: the server would not credit it.
            if (_items.Count > 0 && string.CompareOrdinal(report.At, _items[^1].At) < 0)
            {
                report.At = _items[^1].At;
            }
            _items.Add(report);
            var overflow = _items.Count - _maxItems;
            if (overflow > 0)
            {
                _items.RemoveRange(0, overflow);
                _log.Warn("activity", $"queue full, dropped the {overflow} oldest sample(s)");
            }
            Save();
        }
    }

    public ActivityReport? Peek()
    {
        lock (_gate) return _items.Count > 0 ? _items[0] : null;
    }

    /// <summary>
    /// Removes the head if it is still <paramref name="expected"/> (it was sent or rejected).
    /// <paramref name="persist"/> false: it is written by the next <see cref="Persist"/> (a
    /// drain of a long backlog saves every few samples, not the whole file after each one).
    /// </summary>
    public void Remove(ActivityReport expected, bool persist = true)
    {
        lock (_gate)
        {
            if (_items.Count > 0 && ReferenceEquals(_items[0], expected))
            {
                _items.RemoveAt(0);
                _dirty = true;
                if (persist) Save();
            }
        }
    }

    /// <summary>Writes the removals not saved yet.</summary>
    public void Persist()
    {
        lock (_gate)
        {
            if (_dirty) Save();
        }
    }


    /// <summary>Removes the live samples taken at or after <paramref name="atIso"/> (ISO UTC); returns how many.</summary>
    public int DropLiveFrom(string atIso)
    {
        lock (_gate)
        {
            var removed = _items.RemoveAll(i => i.Kind == "live" && string.CompareOrdinal(i.At, atIso) >= 0);
            if (removed > 0) Save();
            return removed;
        }
    }

    public void Clear()
    {
        lock (_gate)
        {
            _items.Clear();
            _unread = false;
            _file.Delete();
        }
    }

    // The file could not be read yet (its key is in a secret store that has not answered):
    // it is read before the next save, and never overwritten or deleted unread.
    private bool _unread;

    /// <summary>Samples kept on disk by an earlier run, or false when the file's key cannot be read now.</summary>
    private bool Load()
    {
        if (!_file.TryRead(out var bytes))
        {
            if (!_unread) _log.Warn("activity", "the saved queue cannot be read yet (the secret store has not answered); it is kept");
            _unread = true;
            return false;
        }
        _unread = false;
        if (bytes is null) return true;
        try
        {
            var items = JsonSerializer.Deserialize<List<ActivityReport>>(bytes, Json.Options);
            if (items is not null)
            {
                // Before anything queued meanwhile, in time order.
                _items.InsertRange(0, items);
                _items.Sort((a, b) => string.CompareOrdinal(a.At, b.At));
                if (_items.Count > _maxItems) _items.RemoveRange(0, _items.Count - _maxItems);
            }
        }
        catch (JsonException)
        {
            _file.Delete();
        }
        return true;
    }

    private void Save()
    {
        if (_unread && !Load()) return;
        try
        {
            if (_items.Count == 0) _file.Delete();
            else _file.Write(JsonSerializer.SerializeToUtf8Bytes(_items, Json.Options));
            _dirty = false;
        }
        catch (Exception ex)
        {
            _log.Warn("activity", "could not save the queue", ex);
        }
    }
}
