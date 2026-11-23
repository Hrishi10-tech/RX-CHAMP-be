using RXVision.Agent.Core.Meetings;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>Two ticks to start, four to end, one suggestion per call, and only ever while it is true.</summary>
public class CallTrackerTests
{
    private static readonly DetectedCall Zoom = new("zoom", "Zoom", false);
    private static readonly DetectedCall Teams = new("teams", "Teams", false);
    private static readonly DetectedCall Slack = new("slack", "Slack", true);
    private static readonly DetectedCall[] None = Array.Empty<DetectedCall>();
    private const MeetingCallStatus Working = MeetingCallStatus.Working;
    private const MeetingCallStatus InMeeting = MeetingCallStatus.InMeeting;

    private static void Ticks(CallTracker t, int n, MeetingCallStatus status, params DetectedCall[] seen)
    {
        for (var i = 0; i < n; i++) t.Tick(seen, status);
    }

    [Fact]
    public void One_tick_is_a_window_flicker_and_two_in_a_row_are_a_call()
    {
        var t = new CallTracker();
        t.Tick(new[] { Zoom }, Working);
        Assert.Null(t.Suggestion);
        t.Tick(None, Working);
        t.Tick(new[] { Zoom }, Working);
        Assert.Null(t.Suggestion); // not in a row
        t.Tick(new[] { Zoom }, Working);
        Assert.Equal((CallSuggestionKind.StartMeeting, "zoom", "Zoom", false), (t.Suggestion!.Kind, t.Suggestion.CallId, t.Suggestion.App, t.Suggestion.IsHuddle));
    }

    [Fact]
    public void A_huddle_says_so()
    {
        var t = new CallTracker();
        Ticks(t, 2, Working, Slack);
        Assert.True(t.Suggestion!.IsHuddle);
    }

    [Fact]
    public void An_unanswered_Start_meeting_goes_when_the_call_ends_and_three_missed_ticks_are_a_reconnect()
    {
        var t = new CallTracker();
        Ticks(t, 2, Working, Zoom);
        Ticks(t, 3, Working);
        Assert.NotNull(t.Suggestion); // a reconnect or a window change
        t.Tick(new[] { Zoom }, Working); // back: the count starts again
        Ticks(t, 3, Working);
        Assert.NotNull(t.Suggestion);
        t.Tick(None, Working);
        Assert.Null(t.Suggestion);
    }

    [Fact]
    public void Not_now_ends_it_for_that_call_and_a_new_call_may_ask_again()
    {
        var t = new CallTracker();
        Ticks(t, 2, Working, Zoom);
        t.Dismiss();
        Ticks(t, 20, Working, Zoom);
        Assert.Null(t.Suggestion);
        Ticks(t, 4, Working); // that call ends
        Assert.Null(t.Suggestion); // it never got a meeting, so nothing to end
        Ticks(t, 2, Working, Zoom); // a new call
        Assert.Equal(CallSuggestionKind.StartMeeting, t.Suggestion!.Kind);
    }

    [Fact]
    public void One_suggestion_per_call_even_when_a_second_call_starts()
    {
        var t = new CallTracker();
        Ticks(t, 2, Working, Zoom);
        Assert.Equal("zoom", t.Suggestion!.CallId);
        Ticks(t, 2, Working, Zoom, Teams);
        Assert.Equal("zoom", t.Suggestion!.CallId); // still the first card
        t.Dismiss();
        t.Tick(new[] { Zoom, Teams }, Working);
        Assert.Equal("teams", t.Suggestion!.CallId); // then the other call's own
        t.Dismiss();
        t.Tick(new[] { Zoom, Teams }, Working);
        Assert.Null(t.Suggestion);
    }

    [Fact]
    public void Suggestions_start_only_while_Working_and_go_on_a_break()
    {
        var t = new CallTracker();
        Ticks(t, 2, Working, Zoom);
        t.Settle(MeetingCallStatus.Other);
        Assert.Null(t.Suggestion);
        t.Settle(Working);
        Assert.Null(t.Suggestion); // it had its one

        var fresh = new CallTracker();
        fresh.Tick(new[] { Zoom }, Working);
        fresh.Settle(MeetingCallStatus.Other);
        Assert.Null(fresh.Suggestion);
    }

    [Fact]
    public void In_a_meeting_a_call_never_asks_Start_and_its_end_asks_End_once()
    {
        var t = new CallTracker();
        Ticks(t, 2, InMeeting, Zoom);
        Assert.Null(t.Suggestion);
        Ticks(t, 3, InMeeting);
        Assert.Null(t.Suggestion);
        t.Tick(None, InMeeting);
        Assert.Equal((CallSuggestionKind.EndMeeting, "zoom"), (t.Suggestion!.Kind, t.Suggestion.CallId));
        t.Dismiss();
        Ticks(t, 10, InMeeting);
        Assert.Null(t.Suggestion);
    }

    [Fact]
    public void A_meeting_with_no_call_seen_never_asks_End()
    {
        var t = new CallTracker();
        Ticks(t, 30, InMeeting);
        Assert.Null(t.Suggestion);
        // A window seen once, gone at once: never a call.
        t.Tick(new[] { Zoom }, InMeeting);
        Ticks(t, 10, InMeeting);
        Assert.Null(t.Suggestion);
    }

    [Fact]
    public void A_suggestion_tapped_ties_the_call_to_the_meeting()
    {
        var t = new CallTracker();
        Ticks(t, 2, Working, Zoom);
        t.Settle(InMeeting); // the tap's answer
        Assert.Null(t.Suggestion);
        Ticks(t, 4, InMeeting);
        Assert.Equal(CallSuggestionKind.EndMeeting, t.Suggestion!.Kind);
    }

    [Fact]
    public void An_unanswered_End_meeting_goes_when_a_new_call_starts_or_the_meeting_ends()
    {
        var t = new CallTracker();
        Ticks(t, 2, InMeeting, Zoom);
        Ticks(t, 4, InMeeting);
        Assert.NotNull(t.Suggestion);
        t.Tick(new[] { Teams }, InMeeting);
        Assert.NotNull(t.Suggestion); // one tick is not a call yet
        t.Tick(new[] { Teams }, InMeeting);
        Assert.Null(t.Suggestion);

        var other = new CallTracker();
        Ticks(other, 2, InMeeting, Zoom);
        Ticks(other, 4, InMeeting);
        Assert.NotNull(other.Suggestion);
        other.Settle(Working);
        Assert.Null(other.Suggestion);
    }

    [Fact]
    public void One_call_ending_with_another_still_on_does_not_ask_End()
    {
        var t = new CallTracker();
        Ticks(t, 2, InMeeting, Zoom, Teams);
        Ticks(t, 4, InMeeting, Teams);
        Assert.Null(t.Suggestion);
        Ticks(t, 4, InMeeting);
        Assert.Equal("teams", t.Suggestion!.CallId);
    }

    [Fact]
    public void A_call_a_meeting_covered_does_not_ask_Start_when_the_meeting_ends_or_falls_back()
    {
        var t = new CallTracker();
        Ticks(t, 2, InMeeting, Zoom);
        t.Settle(Working); // End meeting by hand, or the fallback, with the call still up
        Ticks(t, 5, Working, Zoom);
        Assert.Null(t.Suggestion);
        // And its end asks nothing: that meeting is over.
        Ticks(t, 4, Working);
        Assert.Null(t.Suggestion);
    }

    [Fact]
    public void A_new_meeting_on_the_same_call_gets_its_own_end()
    {
        var t = new CallTracker();
        Ticks(t, 2, InMeeting, Zoom);
        t.Settle(Working);
        t.Settle(InMeeting);
        Ticks(t, 4, InMeeting);
        Assert.Equal(CallSuggestionKind.EndMeeting, t.Suggestion!.Kind);
    }

    [Fact]
    public void Reset_forgets_everything()
    {
        var t = new CallTracker();
        Ticks(t, 2, Working, Zoom);
        t.Reset();
        Assert.Null(t.Suggestion);
        Assert.Empty(t.Confirmed);
        t.Tick(new[] { Zoom }, Working);
        Assert.Null(t.Suggestion);
    }
}
