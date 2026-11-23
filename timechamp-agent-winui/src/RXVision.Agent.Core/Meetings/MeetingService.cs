using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;

namespace RXVision.Agent.Core.Meetings;

/// <summary>Result of starting a meeting or logging an earlier one.</summary>
public abstract record MeetingOutcome
{
    /// <summary>A live meeting runs from now.</summary>
    public sealed record Started(MeetingRecord? Meeting) : MeetingOutcome;
    /// <summary>An earlier meeting was logged.</summary>
    public sealed record Logged(MeetingRecord? Meeting) : MeetingOutcome;
    /// <summary>
    /// The details need changing (422: outside the day, in the future, overlapping a
    /// break or another meeting, or invalid fields). <paramref name="With"/> is what it overlaps.
    /// </summary>
    public sealed record Invalid(string Code, string Message, MeetingClash? With) : MeetingOutcome;
    /// <summary>It can't happen now (409: on a break, already in a meeting, day not started).</summary>
    public sealed record Refused(string Code, string Message) : MeetingOutcome;
    public sealed record Offline(string Message) : MeetingOutcome;
}

/// <summary>Where a status meeting's start came from: the only field that travels with it.</summary>
public static class MeetingSources
{
    public const string Button = "BUTTON";
    public const string Suggestion = "SUGGESTION";
}

/// <summary>Result of a tap on the status routes (start, end, confirm).</summary>
public abstract record MeetingStatusOutcome
{
    /// <summary>The server's answer: the day progress as it stands now.</summary>
    public sealed record Done(DayProgress Progress) : MeetingStatusOutcome;
    /// <summary>It can't happen now (409: day not started or ended, on a break, already in a meeting, biometric).</summary>
    public sealed record Refused(string Code, string Message) : MeetingStatusOutcome;
    /// <summary>No answer: nothing changed; the person can try again.</summary>
    public sealed record Offline(string Message) : MeetingStatusOutcome;
}

/// <summary>
/// Meetings: In a meeting (3.6), which sends only its start and end through the status
/// routes; a live one with its agenda and people (4.0, journaled; kept for meetings
/// already queued); and earlier ones logged after the fact, which go to the approver.
/// </summary>
public sealed class MeetingService
{
    private readonly ApiClient _api;
    private readonly ILog _log;
    private readonly object _gate = new();
    private MeetingRecord? _live;
    private IReadOnlyList<MeetingRecord> _today = Array.Empty<MeetingRecord>();
    // Bumped by Reset (sign-out): an answer asked for by the session before is never kept.
    private long _epoch;

    public MeetingService(ApiClient api, ILog log)
    {
        _api = api;
        _log = log;
    }

    /// <summary>The meeting in progress (started from this or another 3.1 agent), or null.</summary>
    public MeetingRecord? Live { get { lock (_gate) return _live; } }

    /// <summary>Today's meetings, as last loaded.</summary>
    public IReadOnlyList<MeetingRecord> Today { get { lock (_gate) return _today; } }

    /// <summary>The meetings changed. Background thread.</summary>
    public event Action? Changed;

    public async Task<bool> RefreshAsync(CancellationToken ct = default)
    {
        if (!_api.IsSignedIn) return false;
        var epoch = Interlocked.Read(ref _epoch);
        var result = await _api.GetMeetingsTodayAsync(ct);
        if (!result.Ok || result.Data is null) return false;
        var items = result.Data.Items ?? new List<MeetingRecord>();
        lock (_gate)
        {
            if (_epoch != epoch) return false;
            _today = items;
            _live = items.LastOrDefault(m => m.InProgress && m.Mode == MeetingModes.Live);
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>In a meeting, at once. <paramref name="source"/>: BUTTON or SUGGESTION. Nothing else travels.</summary>
    public Task<MeetingStatusOutcome> StartStatusAsync(string source, CancellationToken ct = default) =>
        StatusAsync(_api.StartMeetingStatusAsync(source, ct), "started", "Try again in a moment. Nothing was saved yet.", "Try starting the meeting again");

    /// <summary>End meeting: back to Working, from whichever meeting runs. Safe to repeat.</summary>
    public Task<MeetingStatusOutcome> EndStatusAsync(CancellationToken ct = default) =>
        StatusAsync(_api.EndMeetingStatusAsync(ct), "ended", "Try again in a moment. Your meeting is still running.", "Try ending the meeting again");

    /// <summary>Still in it: the 2 hours start again from now. A tap that lost the race reads Working.</summary>
    public Task<MeetingStatusOutcome> ConfirmStatusAsync(CancellationToken ct = default) =>
        StatusAsync(_api.ConfirmMeetingStatusAsync(ct), "confirmed", "Try again in a moment. Your meeting is still running.", "Try again in a moment");

    private async Task<MeetingStatusOutcome> StatusAsync(Task<ApiResult<DayProgress>> call, string what, string offline, string fallback)
    {
        var result = await call;
        if (result.Ok && result.Data is { } progress)
        {
            _log.Info("meetings", $"status meeting {what}; the server says {progress.Status}");
            await RefreshAsync();
            return new MeetingStatusOutcome.Done(progress);
        }
        if (result.Ok || result.Transient) return new MeetingStatusOutcome.Offline(offline);
        if (result.Outcome == ApiOutcome.Unauthorized) return new MeetingStatusOutcome.Refused("SIGNED_OUT", "Sign in again first.");
        return new MeetingStatusOutcome.Refused(result.Code ?? "REFUSED", result.Message ?? fallback);
    }

    public async Task<MeetingOutcome> StartAsync(string agenda, IReadOnlyList<MeetingParticipant> participants, string? momSender = null, CancellationToken ct = default)
    {
        var epoch = Interlocked.Read(ref _epoch);
        var result = await _api.StartMeetingAsync(agenda, participants, momSender, ct);
        if (result.Ok)
        {
            var meeting = result.Data?.Meeting;
            lock (_gate) { if (_epoch == epoch) _live = meeting; }
            _log.Info("meetings", $"started a meeting with {participants.Count} people");
            Changed?.Invoke();
            return new MeetingOutcome.Started(meeting);
        }
        return Failed(result, "Couldn't start the meeting.");
    }

    public async Task<MeetingOutcome> LogPastAsync(DateTimeOffset startedAt, int durationMin, string agenda,
        IReadOnlyList<MeetingParticipant> participants, string? momSender = null, CancellationToken ct = default)
    {
        var result = await _api.LogPastMeetingAsync(startedAt, durationMin, agenda, participants, momSender, ct);
        if (result.Ok)
        {
            _log.Info("meetings", $"logged an earlier meeting of {durationMin} min");
            await RefreshAsync(ct);
            return new MeetingOutcome.Logged(result.Data?.Meeting);
        }
        return Failed(result, "Couldn't log the meeting.");
    }

    /// <summary>
    /// Meeting ended. Ends the live meeting record; a meeting with no record (started
    /// by an older agent) ends the plain way. Idempotent on the server.
    /// </summary>
    public async Task<EndOutcome> EndAsync(CancellationToken ct = default)
    {
        var live = Live;
        if (live is null)
        {
            // Started elsewhere, or not loaded yet: look before falling back.
            await RefreshAsync(ct);
            live = Live;
        }
        if (live is null)
        {
            var plain = await _api.EndPresenceAsync(ct);
            if (plain.Ok) return new EndOutcome.MeetingEnded(null, false);
            return plain.Transient
                ? new EndOutcome.Offline("Can't reach RX Vision. Your meeting is still running; try again in a moment.")
                : new EndOutcome.Refused(plain.Message ?? "Couldn't end the meeting.");
        }

        var result = await _api.EndMeetingAsync(live.Id, ct);
        if (result.Ok)
        {
            lock (_gate) { if (_live?.Id == live.Id) _live = null; }
            var discarded = result.Data?.Discarded ?? false;
            _log.Info("meetings", discarded ? "meeting ended under a minute; not kept" : "meeting ended");
            await RefreshAsync(ct);
            return new EndOutcome.MeetingEnded(result.Data?.Meeting, discarded);
        }
        if (result.Transient) return new EndOutcome.Offline("Can't reach RX Vision. Your meeting is still running; try again in a moment.");
        if (result.Status == 404)
        {
            // Gone already (ended elsewhere): nothing is running.
            lock (_gate) { if (_live?.Id == live.Id) _live = null; }
            await RefreshAsync(ct);
            return new EndOutcome.MeetingEnded(null, false);
        }
        return new EndOutcome.Refused(result.Message ?? "Couldn't end the meeting.");
    }

    /// <summary>Active people whose name matches, or null when the server can't be asked.</summary>
    public async Task<IReadOnlyList<ParticipantOption>?> SearchAsync(string? query, CancellationToken ct = default)
    {
        var result = await _api.SearchParticipantsAsync(query, ct);
        if (!result.Ok) return null;
        return (result.Data?.Items ?? new List<ParticipantOption>())
            .Where(p => !string.IsNullOrWhiteSpace(p.Name))
            .ToList();
    }

    /// <summary>Forgets everything (sign-out).</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _live = null;
            _today = Array.Empty<MeetingRecord>();
            _epoch++;
        }
        Changed?.Invoke();
    }

    internal static MeetingOutcome Failed<T>(ApiResult<T> result, string fallback)
    {
        if (result.Transient) return new MeetingOutcome.Offline("Can't reach RX Vision, so nothing was saved. Try again in a moment.");
        if (result.Outcome == ApiOutcome.Unauthorized) return new MeetingOutcome.Refused("SIGNED_OUT", "You're signed out. Sign in again first.");
        var code = result.Code ?? "REFUSED";
        var message = result.Message ?? fallback;
        // 422 (and 400 validation) means "change something and try again"; 409 means "not now".
        return result.Status is 400 or 422
            ? new MeetingOutcome.Invalid(code, message, result.Detail<MeetingClash>("with"))
            : new MeetingOutcome.Refused(code, message);
    }
}
