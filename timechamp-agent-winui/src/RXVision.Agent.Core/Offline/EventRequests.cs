using System.Text.Json;
using RXVision.Agent.Core.Api;

namespace RXVision.Agent.Core.Offline;

/// <summary>The HTTP call that replays one action.</summary>
public sealed record EventRequest(HttpMethod Method, string Path, object Body);

/// <summary>
/// Turns a journalled action into the API call that replays it (SPEC 5.6), and reads
/// the id of what the server created from its answer.
/// </summary>
public static class EventRequests
{
    /// <summary>
    /// The call for <paramref name="e"/>, or null when it can no longer be sent: it acts on
    /// something created here that the server never took (that action was refused).
    /// </summary>
    public static EventRequest? Build(JournalEvent e, Func<string?, string?> resolve)
    {
        var p = e.Payload;
        string? Target()
        {
            var id = resolve(p.TargetId);
            return string.IsNullOrEmpty(id) || OfflineDay.IsLocalId(id) ? null : id;
        }
        switch (e.Kind)
        {
            case EventKinds.StartDay:
                // The press time goes in the body too: a 3.1 server takes it (within 10 minutes);
                // a 4.0 server reads X-Event-At.
                // A late first start carries its note (3.2; a 4.1 server asks for it with 422 LATE_REASON_REQUIRED).
                return new EventRequest(HttpMethod.Post, "activity/start-day",
                    new StartDayRequest { StartedAt = ApiClient.Iso(e.At), LateReason = OrNull(p.Reason) });
            case EventKinds.EndDay:
                return new EventRequest(HttpMethod.Post, "activity/end-day", new EndDayRequest
                {
                    Comments = p.Comments is { Count: > 0 } c ? c.Select(x => new SkipComment(x.BreakId, ReasonText.Clean(x.Comment))).ToList() : null,
                });
            case EventKinds.BreakStart:
                return new EventRequest(HttpMethod.Post, "breaks/start", new StartBreakRequest { Kind = p.BreakKind ?? "", Reason = OrNull(p.Reason) });
            case EventKinds.BreakFree:
                return new EventRequest(HttpMethod.Post, "presence/start", new { type = p.PresenceType ?? PresenceStatus.Break });
            case EventKinds.BreakQuick:
                return new EventRequest(HttpMethod.Post, "breaks/quick/start", new QuickBreakRequest { PlannedMin = p.PlannedMin ?? 5 });
            case EventKinds.BreakPause:
                return Target() is { } pause ? new EventRequest(HttpMethod.Post, $"breaks/{Uri.EscapeDataString(pause)}/pause", new { }) : null;
            case EventKinds.BreakResume:
                return Target() is { } resume ? new EventRequest(HttpMethod.Post, $"breaks/{Uri.EscapeDataString(resume)}/resume", new { }) : null;
            case EventKinds.BreakEnd:
                // Ending a break the server refused to start: there is nothing to end there
                // (and the call must not end some other break). Resolve answers "" for those.
                if (p.TargetId is { } ending && resolve(ending) == "") return null;
                return new EventRequest(HttpMethod.Post, "breaks/end", new EndBreakRequest());
            case EventKinds.BreakSkip:
                return new EventRequest(HttpMethod.Post, "breaks/skip", new SkipBreakRequest { Kind = p.BreakKind ?? "", Reason = OrNull(p.Reason) });
            case EventKinds.BreakComment:
                return Target() is { } comment
                    ? new EventRequest(HttpMethod.Post, $"breaks/{Uri.EscapeDataString(comment)}/comment", new BreakCommentRequest { Comment = ReasonText.Clean(p.Comment) })
                    : null;
            case EventKinds.MeetingStart:
                return new EventRequest(HttpMethod.Post, "meetings/start", new StartMeetingRequest
                {
                    Agenda = ReasonText.Clean(p.Agenda),
                    Participants = ApiClient.CleanParticipants(p.Participants),
                    MomSender = ApiClient.CleanName(p.MomSender),
                });
            case EventKinds.MeetingEnd:
                if (p.TargetId is null) return new EventRequest(HttpMethod.Post, "presence/end", new { });
                return Target() is { } meeting ? new EventRequest(HttpMethod.Post, $"meetings/{Uri.EscapeDataString(meeting)}/end", new { }) : null;
            case EventKinds.MeetingPast:
                return new EventRequest(HttpMethod.Post, "meetings/past", new PastMeetingRequest
                {
                    StartedAt = ApiClient.Iso(p.StartedAt ?? e.At),
                    DurationMin = p.DurationMin ?? 0,
                    Agenda = ReasonText.Clean(p.Agenda),
                    Participants = ApiClient.CleanParticipants(p.Participants),
                    MomSender = ApiClient.CleanName(p.MomSender),
                });
            case EventKinds.Away:
                return new EventRequest(HttpMethod.Post, "away", new AwayRequest
                {
                    StartedAt = ApiClient.Iso(p.StartedAt ?? e.At),
                    ReasonKey = p.ReasonKey ?? "",
                    Comment = OrNull(p.Comment),
                    Participants = p.ReasonKind == AwayKinds.Meeting ? ApiClient.CleanParticipants(p.Participants) : null,
                    MomSender = p.ReasonKind == AwayKinds.Meeting ? ApiClient.CleanName(p.MomSender) : null,
                });
            case EventKinds.AwayUnexplained:
                return new EventRequest(HttpMethod.Post, "away/unexplained", new AwayUnexplainedRequest
                {
                    StartedAt = ApiClient.Iso(p.StartedAt ?? e.At),
                    EndedAt = ApiClient.Iso(p.EndedAt ?? e.At),
                });
            default:
                return null;
        }
    }

    /// <summary>
    /// What a server older than the action knows instead (a 404 for the 4.0 path): End break
    /// on a server without scheduled breaks ends the plain presence.
    /// </summary>
    public static EventRequest? Fallback(JournalEvent e, ApiResult<JsonElement> refused) =>
        e.Kind == EventKinds.BreakEnd && refused.Status == 404 && refused.Code is null or "NOT_FOUND"
            ? new EventRequest(HttpMethod.Post, "presence/end", new { })
            : null;

    /// <summary>
    /// The id of what the action created (a break, a meeting, an away entry), from the
    /// server's answer: { record }, { break } (an away answer of "Took a break"),
    /// { meeting }, { event } (SPEC 5.6) or { away } (what the 4.0 server sends for any
    /// other away answer), else the answer's own id (pause and resume).
    /// </summary>
    public static string? CreatedId(JsonElement data)
    {
        if (data.ValueKind != JsonValueKind.Object) return null;
        foreach (var name in new[] { "record", "break", "meeting", "event", "away" })
            if (data.TryGetProperty(name, out var inner) && Id(inner) is { } id) return id;
        return Id(data);
    }

    private static string? Id(JsonElement element) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String
            ? id.GetString()
            : null;

    private static string? OrNull(string? text)
    {
        var clean = ReasonText.Clean(text);
        return clean.Length == 0 ? null : clean;
    }

    /// <summary>"Your morning break at 11:02 AM", for the one notice a refused action gets.</summary>
    public static string Describe(JournalEvent e) => e.Kind switch
    {
        EventKinds.StartDay => "Start Day",
        EventKinds.EndDay => "End Day",
        EventKinds.BreakStart => "Starting your break",
        EventKinds.BreakFree => "Starting your break",
        EventKinds.BreakQuick => "Starting your quick break",
        EventKinds.BreakPause => "Pausing your break",
        EventKinds.BreakResume => "Resuming your break",
        EventKinds.BreakEnd => "Ending your break",
        EventKinds.BreakSkip => "Skipping your break",
        EventKinds.BreakComment => "Your comment",
        EventKinds.MeetingStart => "Starting your meeting",
        EventKinds.MeetingEnd => "Ending your meeting",
        EventKinds.MeetingPast => "Logging your meeting",
        EventKinds.Away => "Your away answer",
        EventKinds.AwayUnexplained => "Your away time",
        _ => "An action",
    };
}
