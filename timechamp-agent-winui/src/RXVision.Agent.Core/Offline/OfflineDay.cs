using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Offline;

/// <summary>
/// When a server answer was asked for: it may become the new base only if no action was
/// on its way to the server then, and none was sent while it was asked for (otherwise
/// the answer may or may not include that action).
/// </summary>
public readonly record struct FetchStamp(long SendSeq, int InFlight);

/// <summary>
/// Today as the person lives it, offline or not (SPEC 6 "Local state"): the server's
/// last day plus every action since. Owns the journal (actions not yet sent), the
/// actions sent but not yet in a fresh server answer, the ids the server gave to what
/// was created here, and the state file, so a restart starts where it left off without
/// the server. One per signed-in person.
/// </summary>
public sealed class OfflineDay
{
    public const string LocalPrefix = "local:";

    private readonly ISecretStore _secrets;
    private readonly string _dataDir;
    private readonly ILog _log;
    private readonly ServerClock _clock;
    private readonly object _gate = new();
    private string? _userId;
    private Journal? _journal;
    private ProtectedFile? _stateFile;
    private SavedState _state = new();
    private DayView _view = DayView.Empty;
    private long _sendSeq;
    private int _inFlight;
    private bool _stateUnreadable;

    public OfflineDay(ISecretStore secrets, string dataDir, ServerClock clock, ILog log)
    {
        _secrets = secrets;
        _dataDir = dataDir;
        _clock = clock;
        _log = log;
    }

    /// <summary>The day changed (an action, an answer adopted, an action done). Background thread.</summary>
    public event Action? Changed;

    public string? UserId { get { lock (_gate) return _userId; } }

    /// <summary>The day to show (cheap; rebuilt only when something changed).</summary>
    public DayView View { get { lock (_gate) return _view; } }

    /// <summary>The server's last answers (what the actions are applied on).</summary>
    public DayBase Base { get { lock (_gate) return _state.Base; } }

    /// <summary>Actions waiting for the server, oldest first.</summary>
    public IReadOnlyList<JournalEvent> Pending => _journal?.Pending ?? Array.Empty<JournalEvent>();

    public int PendingCount => _journal?.Count ?? 0;

    /// <summary>The journal could be read (its key answered); nothing may be sent before.</summary>
    public bool JournalLoaded => _journal?.Loaded ?? false;

    /// <summary>A day was known from an earlier run or an answer since (false: nothing known at all).</summary>
    public bool HasDay { get { lock (_gate) return _view.Workday is not null; } }

    /// <summary>When the journal last emptied after sending (the "synced" time), or null.</summary>
    public DateTimeOffset? LastSyncAt { get { lock (_gate) return _state.LastSyncAt; } }

    /// <summary>The away pop-up's start, while it is open (kept across restarts).</summary>
    public DateTimeOffset? AwaySince { get { lock (_gate) return _state.AwaySince; } }

    /// <summary>The business time zone's offset now (from the day itself).</summary>
    public TimeSpan BusinessOffset(DateTimeOffset at)
    {
        DayBase b;
        DayView v;
        lock (_gate) { b = _state.Base; v = _view; }
        return BusinessClock.Offset(v.Breaks ?? b.Breaks, v.Workday ?? b.Workday, at);
    }

    public string BusinessDate(DateTimeOffset at) => BusinessClock.Date(at, BusinessOffset(at));

    // ---- Open and close ----------------------------------------------------------------------

    private string FileId(string userId) => new(userId.Where(char.IsLetterOrDigit).ToArray());

    public string JournalPath(string userId) => Path.Combine(_dataDir, $"journal-{FileId(userId)}.bin");
    public string StatePath(string userId) => Path.Combine(_dataDir, $"state-{FileId(userId)}.bin");

    /// <summary>
    /// Reads this person's journal and state (an earlier run's day, actions not yet sent,
    /// the server clock's offset). Nothing needs the server.
    /// </summary>
    public void Open(string userId)
    {
        lock (_gate)
        {
            if (_userId == userId && _journal is not null) return;
            _userId = userId;
            _journal = new Journal(_secrets, JournalPath(userId), _log);
            _stateFile = new ProtectedFile(_secrets, StatePath(userId), durable: true, hidden: true);
            _state = new SavedState { UserId = userId };
            _stateUnreadable = false;
            if (_stateFile.TryRead(out var bytes))
            {
                if (bytes is not null)
                {
                    try
                    {
                        var saved = JsonSerializer.Deserialize<SavedState>(bytes, Json.Options);
                        if (saved is not null && saved.UserId == userId) _state = saved;
                    }
                    catch (JsonException ex)
                    {
                        _log.Warn("offline", "the saved day could not be read; starting from the server's", ex);
                    }
                }
            }
            else
            {
                _stateUnreadable = true;
                _log.Warn("offline", "the saved day cannot be read yet (the secret store has not answered)");
            }
            if (!_journal.Load()) _log.Warn("offline", "the journal cannot be read yet (the secret store has not answered); it is read before anything is sent");
            var maxSeq = _journal.Pending.Select(e => e.Seq).DefaultIfEmpty(0).Max();
            if (maxSeq > _state.Seq) _state.Seq = maxSeq;
            if (_state.ClockKnown) _clock.Seed(TimeSpan.FromTicks(_state.ClockOffsetTicks));
            var pending = _journal.Count;
            _log.Info("offline", $"day restored: {(_state.Base.Workday is { } w ? $"{w.Date} {w.State}" : "no day yet")}, {pending} action(s) waiting, {_state.Applied.Count} sent and not yet in a fresh answer");
            RebuildLocked();
        }
        RaiseChanged();
    }

    /// <summary>Forgets the person in memory (the files stay: a sign-in as them carries on).</summary>
    public void Close()
    {
        lock (_gate)
        {
            SaveLocked();
            _userId = null;
            _journal = null;
            _stateFile = null;
            _state = new SavedState();
            _view = DayView.Empty;
        }
        RaiseChanged();
    }

    /// <summary>
    /// Deletes this person's journal and state (a key sign-out with nothing left to send).
    /// Nothing is written for them after this: <see cref="Close"/> used to save the emptied
    /// state again, so a state file came back after every key sign-out (seen end to end).
    /// </summary>
    public void DeleteFiles()
    {
        lock (_gate)
        {
            _journal?.Clear();
            _stateFile?.Delete();
            _stateFile = null;
            _state = new SavedState { UserId = _userId ?? "" };
            _view = DayView.Empty;
        }
        RaiseChanged();
    }

    // ---- Actions ---------------------------------------------------------------------------

    /// <summary>A fresh id for something created here (a break, a meeting) until the server's is known.</summary>
    public static string NewLocalId() => LocalPrefix + Guid.NewGuid().ToString("N");

    public static bool IsLocalId(string? id) => id is not null && id.StartsWith(LocalPrefix, StringComparison.Ordinal);

    /// <summary>
    /// Journals an action (on disk, fsynced, before this returns) at <paramref name="at"/>
    /// (now on the server's clock when null) and shows it at once.
    /// </summary>
    /// <param name="id">The event's id when the caller already has one (it waits for the answer, see <see cref="SyncWorker.Expect"/>).</param>
    public JournalEvent Record(string kind, EventPayload payload, DateTimeOffset? at = null, string? id = null)
    {
        JournalEvent e;
        lock (_gate)
        {
            if (_journal is null) throw new InvalidOperationException("No one is signed in.");
            e = new JournalEvent
            {
                Id = id ?? Guid.NewGuid().ToString(),
                Kind = kind,
                At = at ?? _clock.UtcNow,
                Payload = payload,
                Seq = ++_state.Seq,
            };
            var durable = _journal.Append(e);
            _log.Info("offline", $"recorded {e}{(durable ? "" : " (in memory until the journal can be written)")}");
            SaveLocked();
            RebuildLocked();
        }
        RaiseChanged();
        return e;
    }

    // ---- Sending ---------------------------------------------------------------------------

    /// <summary>Taken before asking the server for a part of the day (see <see cref="Adopt"/>).</summary>
    public FetchStamp Stamp()
    {
        lock (_gate) return new FetchStamp(_sendSeq, _inFlight);
    }

    /// <summary>An action is on its way to the server.</summary>
    public void BeginSend()
    {
        lock (_gate)
        {
            _sendSeq++;
            _inFlight++;
        }
    }

    public void EndSend()
    {
        lock (_gate) _inFlight = Math.Max(0, _inFlight - 1);
    }

    /// <summary>The server took the action: it leaves the journal and stays shown until a fresh answer has it.</summary>
    public void Acknowledge(JournalEvent e, string? createdId)
    {
        lock (_gate)
        {
            if (_journal is null) return;
            _journal.Remove(e.Id);
            e.State = EventStates.Sent;
            _state.Applied.Add(new AppliedEntry { Event = e, Parts = PartsOf(e.Kind) });
            if (e.Payload.LocalId is { } local && !string.IsNullOrEmpty(createdId)) _state.Ids[local] = createdId;
            if (_journal.Count == 0) _state.LastSyncAt = DateTimeOffset.UtcNow;
            SaveLocked();
            RebuildLocked();
        }
        RaiseChanged();
    }

    /// <summary>The server refused the action for good: it leaves the journal and is no longer shown.</summary>
    public void Refuse(JournalEvent e)
    {
        lock (_gate)
        {
            if (_journal is null) return;
            _journal.Remove(e.Id);
            // What it would have created never existed there: later actions on it are dropped.
            if (e.Payload.LocalId is { } local) _state.Ids[local] = "";
            if (_journal.Count == 0) _state.LastSyncAt = DateTimeOffset.UtcNow;
            SaveLocked();
            RebuildLocked();
        }
        RaiseChanged();
    }

    /// <summary>The server's id for something created here, the id as it is, or "" for something the server refused to create.</summary>
    public string? Resolve(string? id)
    {
        if (id is null) return null;
        lock (_gate) return _state.Ids.TryGetValue(id, out var server) ? server : id;
    }

    // ---- Server answers ------------------------------------------------------------------------

    /// <summary>
    /// A fresh answer for one part of the day. Kept as the new base when it is known to
    /// hold every action sent so far (see <see cref="FetchStamp"/>); actions not yet sent
    /// show on top of it. Returns whether it was kept.
    /// </summary>
    public bool Adopt(DayParts part, object? answer, FetchStamp stamp)
    {
        lock (_gate)
        {
            if (_journal is null || answer is null) return false;
            if (stamp.InFlight > 0 || stamp.SendSeq != _sendSeq)
            {
                _log.Debug("offline", $"a {part} answer overlapped an action on its way; not kept");
                return false;
            }
            switch (part)
            {
                case DayParts.Workday when answer is WorkdayToday w:
                    _state.Base.Workday = w;
                    break;
                case DayParts.Breaks when answer is BreakDay b:
                    _state.Base.Breaks = b;
                    break;
                case DayParts.Meetings when answer is IReadOnlyList<MeetingRecord> m:
                    _state.Base.Meetings = m.ToList();
                    break;
                default:
                    return false;
            }
            // Every action sent before this answer was asked for is in it now.
            foreach (var applied in _state.Applied) applied.Parts &= ~part;
            _state.Applied.RemoveAll(a => a.Parts == DayParts.None);
            if (_state.Applied.Count == 0 && _journal.Count == 0)
            {
                // Nothing points at local ids any more.
                _state.Ids.Clear();
            }
            SaveLocked();
            RebuildLocked();
        }
        RaiseChanged();
        return true;
    }

    /// <summary>The server's presence and totals (used where the day has no record of them).</summary>
    public void AdoptPresence(CurrentPresence? presence, PresenceTotals? totals, FetchStamp stamp)
    {
        lock (_gate)
        {
            if (_journal is null || stamp.InFlight > 0 || stamp.SendSeq != _sendSeq) return;
            if (presence is not null) _state.Base.Presence = presence;
            if (totals is not null) _state.Base.Totals = totals;
            SaveLocked();
        }
    }

    /// <summary>Keeps the server clock's offset with the day, so a restart offline judges times as before.</summary>
    public void SaveClock()
    {
        lock (_gate)
        {
            if (_journal is null || !_clock.Known) return;
            var ticks = _clock.Offset.Ticks;
            if (_state.ClockKnown && Math.Abs(ticks - _state.ClockOffsetTicks) < TimeSpan.TicksPerSecond) return;
            _state.ClockOffsetTicks = ticks;
            _state.ClockKnown = true;
            SaveLocked();
        }
    }

    /// <summary>The away pop-up opened (since then) or closed (null). Kept across restarts.</summary>
    public void SetAway(DateTimeOffset? since)
    {
        lock (_gate)
        {
            if (_journal is null || _state.AwaySince == since) return;
            _state.AwaySince = since;
            SaveLocked();
        }
    }

    /// <summary>The last History answer for a month (shown while offline).</summary>
    public HistoryMonth? CachedHistory(string month)
    {
        lock (_gate) return _state.History.TryGetValue(month, out var h) ? h : null;
    }

    public void CacheHistory(HistoryMonth history)
    {
        lock (_gate)
        {
            if (_journal is null || string.IsNullOrEmpty(history.Month)) return;
            _state.History[history.Month] = history;
            // A few months are plenty.
            foreach (var old in _state.History.Keys.OrderByDescending(k => k, StringComparer.Ordinal).Skip(4).ToList())
                _state.History.Remove(old);
            SaveLocked();
        }
    }

    /// <summary>Works the day out again (the date changed at midnight).</summary>
    public void Rebuild()
    {
        lock (_gate) RebuildLocked();
        RaiseChanged();
    }

    // ---- Plumbing ------------------------------------------------------------------------------

    /// <summary>Which parts of the day an action changes (a fresh answer for each takes it in).</summary>
    public static DayParts PartsOf(string kind) => kind switch
    {
        EventKinds.StartDay or EventKinds.EndDay => DayParts.All,
        EventKinds.BreakStart or EventKinds.BreakFree or EventKinds.BreakQuick or EventKinds.BreakPause
            or EventKinds.BreakResume or EventKinds.BreakEnd or EventKinds.BreakSkip => DayParts.Breaks | DayParts.Workday,
        EventKinds.BreakComment => DayParts.Breaks | DayParts.Workday,
        EventKinds.MeetingStart or EventKinds.MeetingEnd or EventKinds.MeetingPast => DayParts.Meetings | DayParts.Workday,
        EventKinds.Away => DayParts.Workday | DayParts.Breaks,
        EventKinds.AwayUnexplained => DayParts.Workday,
        _ => DayParts.All,
    };

    private void RebuildLocked()
    {
        if (_journal is null)
        {
            _view = DayView.Empty;
            return;
        }
        var events = _state.Applied.Select(a => new ProjectedEvent(a.Event, a.Parts))
            .Concat(_journal.Pending.Select(e => new ProjectedEvent(e, DayParts.All)))
            .ToList();
        var b = _state.Base;
        var now = _clock.UtcNow;
        var offset = BusinessClock.Offset(b.Breaks, b.Workday, now);
        try
        {
            _view = DayProjection.Build(b, events, id => id is not null && _state.Ids.TryGetValue(id, out var s) ? s : id,
                at => BusinessClock.Date(at, offset), BusinessClock.Date(now, offset));
        }
        catch (Exception ex)
        {
            // Never leave the person without a day on screen: show the server's as it was.
            _log.Error("offline", "could not work out the day from the journal; showing the server's", ex);
            _view = new DayView { Workday = b.Workday, Breaks = b.Breaks, Meetings = b.Meetings };
        }
    }

    private void SaveLocked()
    {
        if (_stateFile is null || _stateUnreadable && !TryReadAgainLocked()) return;
        try
        {
            _state.SavedAt = DateTimeOffset.UtcNow;
            _stateFile.Write(JsonSerializer.SerializeToUtf8Bytes(_state, Json.Options));
        }
        catch (Exception ex)
        {
            _log.Warn("offline", "could not save the day", ex);
        }
    }

    /// <summary>The state file could not be read at open: read it now before writing over it.</summary>
    private bool TryReadAgainLocked()
    {
        if (_stateFile is null || !_stateFile.TryRead(out var bytes)) return false;
        _stateUnreadable = false;
        if (bytes is null) return true;
        try
        {
            if (JsonSerializer.Deserialize<SavedState>(bytes, Json.Options) is { } saved && saved.UserId == _userId)
            {
                // Its day is older than anything learned since; only its counters and ids matter.
                _state.Seq = Math.Max(_state.Seq, saved.Seq);
                foreach (var (k, v) in saved.Ids) _state.Ids.TryAdd(k, v);
                if (_state.Base.Workday is null) _state.Base = saved.Base;
            }
        }
        catch (JsonException) { }
        return true;
    }

    private void RaiseChanged()
    {
        try { Changed?.Invoke(); }
        catch (Exception ex) { _log.Error("offline", "a day-changed handler failed", ex); }
    }

    /// <summary>What the state file holds.</summary>
    private sealed class SavedState
    {
        public int Format { get; set; } = 1;
        public string UserId { get; set; } = "";
        /// <summary>The last action number given out (X-Client-Seq).</summary>
        public long Seq { get; set; }
        public DayBase Base { get; set; } = new();
        public List<AppliedEntry> Applied { get; set; } = new();
        public Dictionary<string, string> Ids { get; set; } = new();
        public long ClockOffsetTicks { get; set; }
        public bool ClockKnown { get; set; }
        public DateTimeOffset? AwaySince { get; set; }
        public DateTimeOffset? LastSyncAt { get; set; }
        public Dictionary<string, HistoryMonth> History { get; set; } = new();
        public DateTimeOffset SavedAt { get; set; }
    }

    private sealed class AppliedEntry
    {
        public JournalEvent Event { get; set; } = new();
        /// <summary>The parts of the day whose server answer does not have it yet.</summary>
        public DayParts Parts { get; set; }
    }
}
