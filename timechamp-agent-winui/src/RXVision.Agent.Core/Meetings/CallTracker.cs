namespace RXVision.Agent.Core.Meetings;

/// <summary>What the person's status is, as far as the call suggestions care.</summary>
public enum MeetingCallStatus { Working, InMeeting, Other }

public enum CallSuggestionKind { StartMeeting, EndMeeting }

/// <summary>"Start meeting?" or "End meeting?" for one call.</summary>
public sealed record CallSuggestion(CallSuggestionKind Kind, string CallId, string App, bool IsHuddle);

/// <summary>
/// Turns what the detectors saw on each tick into at most one quiet suggestion (AGENT.md section 6).
/// A call starts after a match on 2 ticks in a row and ends after no match on 4, so a reconnect or
/// a window change does not count. One suggestion per call; Not now ends it for that call. An
/// unanswered Start meeting? goes when the call ends; an unanswered End meeting? goes when a new
/// call starts or the meeting ends. A meeting with no call seen never gets End meeting?. Nothing
/// here changes a status: that only happens when the person taps. Pure: no clock, no threads.
/// </summary>
public sealed class CallTracker
{
    public const int TicksToStart = 2;
    public const int TicksToEnd = 4;

    private readonly Dictionary<string, Track> _tracks = new();

    /// <summary>The suggestion to show now, or null.</summary>
    public CallSuggestion? Suggestion { get; private set; }

    /// <summary>A call the detectors hold as started, for one of the rows.</summary>
    public IEnumerable<DetectedCall> Confirmed => _tracks.Values.Where(t => t.Confirmed).Select(t => t.Call);

    /// <summary>
    /// One tick of the detectors, while Working or In a meeting and unlocked. <paramref name="seen"/>
    /// is what they found now, <paramref name="status"/> the person's status now.
    /// </summary>
    public void Tick(IReadOnlyCollection<DetectedCall> seen, MeetingCallStatus status)
    {
        var started = false;
        DetectedCall? ended = null;
        var endedInMeeting = false;
        foreach (var call in seen)
        {
            if (!_tracks.TryGetValue(call.Id, out var track)) _tracks[call.Id] = track = new Track(call);
            track.Call = call;
            track.Misses = 0;
            track.Hits++;
            if (!track.Confirmed && track.Hits >= TicksToStart)
            {
                track.Confirmed = true;
                started = true;
            }
        }
        foreach (var track in _tracks.Values.ToList())
        {
            if (seen.Any(c => c.Id == track.Call.Id)) continue;
            track.Hits = 0;
            if (!track.Confirmed)
            {
                _tracks.Remove(track.Call.Id);
                continue;
            }
            if (++track.Misses < TicksToEnd) continue;
            ended = track.Call;
            endedInMeeting = track.SeenInMeeting;
            _tracks.Remove(track.Call.Id);
        }

        if (status == MeetingCallStatus.InMeeting)
        {
            if (started && Suggestion?.Kind == CallSuggestionKind.EndMeeting) Suggestion = null;
            if (ended is not null && endedInMeeting && !_tracks.Values.Any(t => t.Confirmed))
                Suggestion = new CallSuggestion(CallSuggestionKind.EndMeeting, ended.Id, ended.App, ended.IsHuddle);
        }
        Settle(status);
    }

    /// <summary>The status moved between ticks: what is no longer true goes at once.</summary>
    public void Settle(MeetingCallStatus status)
    {
        switch (status)
        {
            case MeetingCallStatus.InMeeting:
                if (Suggestion?.Kind == CallSuggestionKind.StartMeeting) Suggestion = null;
                foreach (var track in _tracks.Values.Where(t => t.Confirmed))
                {
                    track.SeenInMeeting = true;
                    track.Answered = true;
                }
                break;
            case MeetingCallStatus.Working:
                if (Suggestion?.Kind == CallSuggestionKind.EndMeeting) Suggestion = null;
                foreach (var track in _tracks.Values) track.SeenInMeeting = false;
                if (Suggestion is { Kind: CallSuggestionKind.StartMeeting } shown
                    && !(_tracks.TryGetValue(shown.CallId, out var showing) && showing.Confirmed)) Suggestion = null;
                if (Suggestion is null && _tracks.Values.FirstOrDefault(t => t.Confirmed && !t.Answered) is { } next)
                {
                    next.Answered = true;
                    Suggestion = new CallSuggestion(CallSuggestionKind.StartMeeting, next.Call.Id, next.Call.App, next.Call.IsHuddle);
                }
                break;
            default:
                Suggestion = null;
                foreach (var track in _tracks.Values) track.SeenInMeeting = false;
                break;
        }
    }

    /// <summary>Not now, or a tap on the suggestion: it goes, and this call never asks again.</summary>
    public void Dismiss() => Suggestion = null;

    /// <summary>A new day, or someone else signing in: nothing carries over.</summary>
    public void Reset()
    {
        _tracks.Clear();
        Suggestion = null;
    }

    private sealed class Track
    {
        public Track(DetectedCall call) => Call = call;
        public DetectedCall Call { get; set; }
        public int Hits { get; set; }
        public int Misses { get; set; }
        public bool Confirmed { get; set; }
        /// <summary>Its one Start meeting? has gone out, or a meeting already covered it.</summary>
        public bool Answered { get; set; }
        public bool SeenInMeeting { get; set; }
    }
}
