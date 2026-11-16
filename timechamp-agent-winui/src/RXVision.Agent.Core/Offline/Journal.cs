using System.Buffers.Binary;
using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Offline;

/// <summary>
/// The person's actions waiting for the server, in order, on disk (SPEC 6 "Journal").
///
/// Append-only and encrypted: each record is [length: 4 bytes][AES-256-GCM blob]
/// holding either an action or the acknowledgement that one is done. An action is
/// on disk, flushed to the device (fsync), before <see cref="Append"/> returns, so the
/// screen never shows something a crash could lose. A crash in the middle of a write
/// leaves a torn last record: reading stops there and the file is rewritten without
/// it. Rewritten in one piece (atomically) when it holds mostly acknowledgements.
/// One file per person.
/// </summary>
public sealed class Journal
{
    private const int CompactAfter = 64;
    private const int MaxRecord = 1 << 20;

    private readonly ISecretStore _secrets;
    private readonly string _path;
    private readonly ILog _log;
    private readonly object _gate = new();
    private readonly List<JournalEvent> _pending = new();
    // Actions taken while the file's key could not be read (a Keychain prompt not answered):
    // kept in memory and written as soon as it can be.
    private readonly List<JournalEvent> _unwritten = new();
    private int _records;
    private bool _loaded;

    public Journal(ISecretStore secrets, string path, ILog log)
    {
        _secrets = secrets;
        _path = path;
        _log = log;
    }

    public string FilePath => _path;

    /// <summary>The actions not yet done, oldest first (a copy).</summary>
    public IReadOnlyList<JournalEvent> Pending
    {
        get { lock (_gate) return _pending.ToList(); }
    }

    public int Count
    {
        get { lock (_gate) return _pending.Count; }
    }

    /// <summary>The file has been read (false while its key could not be read yet).</summary>
    public bool Loaded
    {
        get { lock (_gate) return _loaded; }
    }

    /// <summary>
    /// Reads the file: every action without an acknowledgement, in order. False when the
    /// key cannot be read now; the file is then left alone (never overwritten unread).
    /// </summary>
    public bool Load()
    {
        lock (_gate) return LoadLocked();
    }

    private bool LoadLocked()
    {
        if (_loaded) return true;
        byte[] bytes;
        byte[]? key;
        try
        {
            if (!File.Exists(_path))
            {
                _loaded = true;
                FlushUnwrittenLocked();
                return true;
            }
            bytes = File.ReadAllBytes(_path);
            key = FileKeys.Existing(_secrets);
        }
        catch (TimeoutException)
        {
            return false;
        }
        catch (Exception ex)
        {
            _log.Warn("journal", "could not read the journal", ex);
            return false;
        }
        if (key is null)
        {
            // The key is gone (a new user profile, a wiped keychain): nothing here can be read.
            _log.Warn("journal", "the journal's key is gone; its actions cannot be read and are dropped");
            HiddenFile.Delete(_path);
            _loaded = true;
            FlushUnwrittenLocked();
            return true;
        }

        var found = new List<JournalEvent>();
        var offset = 0;
        var records = 0;
        var torn = false;
        while (offset < bytes.Length)
        {
            if (bytes.Length - offset < 4) { torn = true; break; }
            var length = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(offset, 4));
            if (length <= 0 || length > MaxRecord || bytes.Length - offset - 4 < length) { torn = true; break; }
            var plain = FileKeys.Open(key, bytes.AsSpan(offset + 4, length));
            if (plain is null) { torn = true; break; }
            offset += 4 + length;
            records++;
            try
            {
                var record = JsonSerializer.Deserialize<Record>(plain, Json.Options);
                if (record?.E is { } e) found.Add(e);
                else if (record?.A is { } done) found.RemoveAll(x => x.Id == done);
            }
            catch (JsonException)
            {
                torn = true;
                break;
            }
        }
        foreach (var e in found) e.State = EventStates.Pending;
        // Older than anything taken while the file could not be read.
        _pending.InsertRange(0, found.Where(f => _pending.All(p => p.Id != f.Id)));
        _records = records;
        _loaded = true;
        if (torn)
        {
            _log.Warn("journal", $"the journal's last record was incomplete (a crash while writing?); kept the {found.Count} action(s) before it");
            CompactLocked();
        }
        FlushUnwrittenLocked();
        return true;
    }

    /// <summary>
    /// Adds an action at the end, durably (fsync) before returning. False when it could
    /// only be kept in memory (the file's key cannot be read yet); it is written later.
    /// </summary>
    public bool Append(JournalEvent e)
    {
        lock (_gate)
        {
            e.State = EventStates.Pending;
            _pending.Add(e);
            if (!_loaded && !LoadLocked())
            {
                _unwritten.Add(e);
                _log.Warn("journal", $"{e} kept in memory: the journal's key cannot be read yet");
                return false;
            }
            if (!WriteLocked(new Record { E = e }))
            {
                _unwritten.Add(e);
                return false;
            }
            return true;
        }
    }

    /// <summary>The action is done (sent, or refused for good): it leaves the journal.</summary>
    public void Remove(string id)
    {
        lock (_gate)
        {
            var index = _pending.FindIndex(p => p.Id == id);
            if (index < 0) return;
            _pending.RemoveAt(index);
            var unwritten = _unwritten.RemoveAll(u => u.Id == id) > 0;
            if (!_loaded) return;
            if (_pending.Count == 0 || _records >= CompactAfter)
            {
                CompactLocked();
                return;
            }
            if (!unwritten) WriteLocked(new Record { A = id });
        }
    }

    /// <summary>Forgets everything and deletes the file (only after a key sign-out with nothing left to send).</summary>
    public void Clear()
    {
        lock (_gate)
        {
            _pending.Clear();
            _unwritten.Clear();
            _records = 0;
            HiddenFile.Delete(_path);
        }
    }

    private void FlushUnwrittenLocked()
    {
        if (_unwritten.Count == 0) return;
        foreach (var e in _unwritten.ToList())
        {
            if (!WriteLocked(new Record { E = e })) return;
            _unwritten.Remove(e);
        }
    }

    private bool WriteLocked(Record record)
    {
        try
        {
            var key = FileKeys.GetOrCreate(_secrets);
            var blob = FileKeys.Seal(key, JsonSerializer.SerializeToUtf8Bytes(record, Json.Options));
            var frame = new byte[4 + blob.Length];
            BinaryPrimitives.WriteInt32LittleEndian(frame, blob.Length);
            blob.CopyTo(frame, 4);
            var existed = File.Exists(_path);
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            using (var stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.Read))
            {
                stream.Write(frame, 0, frame.Length);
                stream.Flush(flushToDisk: true);
            }
            if (!existed) HiddenFile.Hide(_path);
            _records++;
            return true;
        }
        catch (Exception ex)
        {
            _log.Error("journal", "could not write to the journal", ex);
            return false;
        }
    }

    /// <summary>Rewrites the file with only the actions still to do (atomically, durably).</summary>
    private void CompactLocked()
    {
        try
        {
            if (_pending.Count == 0)
            {
                HiddenFile.Delete(_path);
                _records = 0;
                _unwritten.Clear();
                return;
            }
            var key = FileKeys.GetOrCreate(_secrets);
            using var buffer = new MemoryStream();
            var length = new byte[4];
            foreach (var e in _pending)
            {
                var blob = FileKeys.Seal(key, JsonSerializer.SerializeToUtf8Bytes(new Record { E = e }, Json.Options));
                BinaryPrimitives.WriteInt32LittleEndian(length, blob.Length);
                buffer.Write(length);
                buffer.Write(blob);
            }
            AtomicFile.WriteAllBytes(_path, buffer.ToArray(), durable: true, hidden: true);
            _records = _pending.Count;
            _unwritten.Clear();
        }
        catch (Exception ex)
        {
            _log.Error("journal", "could not rewrite the journal", ex);
        }
    }

    /// <summary>One line of the file: an action (E) or an acknowledgement (A, the action's id).</summary>
    private sealed class Record
    {
        public JournalEvent? E { get; set; }
        public string? A { get; set; }
    }
}
