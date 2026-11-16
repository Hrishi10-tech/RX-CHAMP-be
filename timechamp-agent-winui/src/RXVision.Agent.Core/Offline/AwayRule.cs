using RXVision.Agent.Core.Api;

namespace RXVision.Agent.Core.Offline;

/// <summary>
/// When the away pop-up opens and what each answer needs (SPEC 2.5, 8.4), as pure
/// functions. Input is the OS's combined keyboard and mouse idle time (there is no
/// mouse-only signal; typing counts as present). Input is only seen while the screen
/// is unlocked, so a locked screen keeps counting as away from the last input before it.
/// </summary>
public static class AwayRule
{
    public const int MinMinutes = 2;
    public const int MaxMinutes = 60;
    public const int MinText = 3;
    public const int MaxText = 200;
    public const int MinMom = 2;
    public const int MaxMom = 80;
    public const int MaxPeople = 30;

    /// <summary>The last input, moved forward by what the OS says now (never while locked, never backwards).</summary>
    public static DateTimeOffset LastActive(DateTimeOffset previous, DateTimeOffset now, TimeSpan idle, bool locked)
    {
        if (locked) return previous;
        if (idle < TimeSpan.Zero) idle = TimeSpan.Zero;
        var input = now - idle;
        return input > previous ? input : previous;
    }

    /// <summary>
    /// Open when tracking is on for this person, nothing has been typed or clicked for the
    /// configured minutes (2 to 60), and they are not on a break or in a meeting. The
    /// caller checks the day is open.
    /// </summary>
    public static bool ShouldOpen(IdleConfig? config, bool onBreak, bool inMeeting, DateTimeOffset lastActive, DateTimeOffset now) =>
        config is { Enabled: true }
        && !onBreak
        && !inMeeting
        && now - lastActive >= TimeSpan.FromMinutes(Math.Clamp(config.Minutes, MinMinutes, MaxMinutes));

    /// <summary>
    /// The away start: the last input, but never before this session's start or the end of the
    /// last break or meeting (the server bounds it the same way; seen end to end, a meeting
    /// ended with no input after it made the agent count seconds of the meeting as away).
    /// </summary>
    public static DateTimeOffset BoundStart(DateTimeOffset lastActive, WorkdayToday? day, BreakDay? breaks,
        IReadOnlyList<MeetingRecord>? meetings = null)
    {
        var start = lastActive;
        var session = day?.Sessions.LastOrDefault(s => s.EndedAt is null)?.StartedAt ?? day?.StartedAt;
        if (session is { } s && start < s) start = s;
        if (breaks is not null)
        {
            foreach (var record in DayProjection.AllBreakRecords(breaks))
                if (!record.IsSkip && record.EndedAt is { } ended && ended > start) start = ended;
            foreach (var q in breaks.Quick)
                if (q.EndedAt is { } ended && ended > start) start = ended;
        }
        foreach (var m in meetings ?? Array.Empty<MeetingRecord>())
            if (m.Mode == MeetingModes.Live && m.EndedAt is { } ended && ended > start) start = ended;
        return start;
    }

    /// <summary>What a reason of this kind still needs, or null when the answer is complete.</summary>
    public static AwayOutcome.Invalid? Problem(string kind, AwayAnswer answer)
    {
        if (kind == AwayKinds.Break) return null;
        var comment = ReasonText.Clean(answer.Comment);
        if (kind == AwayKinds.Meeting)
        {
            var people = (answer.Participants ?? Array.Empty<MeetingParticipant>()).Count(p => ReasonText.Clean(p?.Name).Length > 0);
            if (people < 1) return new AwayOutcome.Invalid("Add who was in the meeting.", new[] { "participants" });
            if (people > MaxPeople) return new AwayOutcome.Invalid($"Up to {MaxPeople} people.", new[] { "participants" });
            if (comment.Length < MinText || comment.Length > MaxText)
                return new AwayOutcome.Invalid($"Add a one-line summary ({MinText} to {MaxText} characters).", new[] { "comment" });
            var mom = ReasonText.Clean(answer.MomSender);
            if (mom.Length < MinMom || mom.Length > MaxMom)
                return new AwayOutcome.Invalid("Add who will mail the minutes.", new[] { "momSender" });
            return null;
        }
        if (comment.Length < MinText || comment.Length > MaxText)
        {
            var what = kind == AwayKinds.Thinking ? "what you were thinking about" : "what you worked on";
            return new AwayOutcome.Invalid($"Add {what} ({MinText} to {MaxText} characters).", new[] { "comment" });
        }
        return null;
    }

    /// <summary>The fields a reason asks for, by kind (what the pop-up shows).</summary>
    public static IReadOnlyList<string> FieldsFor(string kind) => kind switch
    {
        AwayKinds.Break => Array.Empty<string>(),
        AwayKinds.Meeting => new[] { "participants", "comment", "momSender" },
        _ => new[] { "comment" },
    };
}
