using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Workday;
using Xunit;
using Xunit.Abstractions;
using static RXVision.Agent.Core.Tests.Live.LiveWorkdayTests;

namespace RXVision.Agent.Core.Tests.Live;

/// <summary>
/// The 3.1 flows that need the clock to move: a break over its length (back late,
/// asking to count the minutes or leaving them out), a meeting over a minute, and
/// the whole AgentHost through a working day with an owed lunch. They start
/// together in <see cref="LiveFixture"/>; each test waits only for what is left.
/// </summary>
[Collection(LiveCollection.Name)]
public sealed class LiveTimedTests
{
    private static readonly TimeSpan OverOneMinute = TimeSpan.FromSeconds(66);
    private readonly LiveFixture _env;
    private readonly ITestOutputHelper _out;

    public LiveTimedTests(LiveFixture env, ITestOutputHelper output)
    {
        _env = env;
        _out = output;
    }

    private bool Skipped()
    {
        if (_env.Skip is null) return false;
        _out.WriteLine(_env.Skip);
        return true;
    }

    // ---- Back late ----------------------------------------------------------------------------

    /// <summary>
    /// 4.0 (SPEC 2.3, 2.4): a 4.0 agent is never asked to have the minutes over counted, even
    /// if it sends the 3.1 askToCount: the break ends with no approval, the whole break stays out
    /// of focus, and the minutes over come out of the paid buffer.
    /// </summary>
    [Fact]
    public async Task Back_late_a_4_0_agent_is_never_asked_and_the_minutes_over_come_from_the_buffer()
    {
        if (Skipped()) return;
        var run = await _env.AskToCount;
        var a = run.Agent;
        Assert.Equal(("ON_TIME", "NOT_REQUIRED", true, BreakOutcomes.Taken), (run.Break.Timing, run.Break.ApprovalStatus, run.Break.InProgress, run.Break.Outcome));
        Assert.Equal((BreakKinds.Morning, (int?)1), (run.Break.Kind, run.Break.DurationMin));
        Assert.True(run.DayBefore.Focus.Running);

        // On the break: focus is paused while break time grows; presence is BREAK.
        var b1 = await a.DayAsync();
        await Task.Delay(2200);
        var b2 = await a.DayAsync();
        Assert.False(b1.Focus.Running || b2.Focus.Running);
        Assert.InRange(b2.Focus.FocusSec - b1.Focus.FocusSec, -1, 1);
        Assert.InRange(b2.Focus.BreakSec - b1.Focus.BreakSec, 1, 5);
        Assert.InRange(b2.Focus.SpanSec - b1.Focus.SpanSec, 1, 5);
        Assert.Equal(b1.Focus.FocusSec, FocusClock.At(b1, b2.ServerNow));
        Assert.Equal(PresenceStatus.Break, (await a.Api.GetCurrentPresenceAsync()).Data!.Status);
        Assert.Equal(BreakKinds.Morning, (await a.BreakDayAsync()).ActiveBreak?.Kind);

        await LiveEnv.WaitUntil(run.StartedAt + OverOneMinute, _out.WriteLine, "for the one-minute break to run over");
        await a.BreakDayAsync();
        var active = a.Breaks.Panel().Active!;
        Assert.True(active.Overrun && active.PastGrace, "the panel shows it over and past the shift's grace (0)");
        Assert.StartsWith(BreakSchedule.Minus, active.Countdown);

        // Even asking to count (the 3.1 question) ends it at once, with nothing to approve.
        var ended = Assert.IsType<EndOutcome.Ended>(await a.Breaks.EndAsync(null, askToCount: true));
        var r = ended.Record!;
        Assert.Equal((run.Break.Id, false, false, "NOT_REQUIRED"), (r.Id, r.InProgress, r.OverrunAsked, r.ApprovalStatus));
        Assert.Null(r.OverrunReason);
        Assert.True(r.TookSec >= 66, $"took {r.TookSec} s");
        Assert.InRange(r.OverrunSec, r.TookSec - 61, r.TookSec - 59);

        // Focus: the whole break stays out; nothing waits; the minutes over are paid from the buffer.
        var w = await a.DayAsync();
        Assert.True(w.Focus.Running);
        Assert.Equal((0, 0), (w.Focus.PendingPlusSec, w.Focus.ApprovedPlusSec));
        Assert.InRange(w.Focus.BreakSec, r.TookSec - 1, r.TookSec + 1);
        Assert.InRange(w.Focus.FocusSec - (w.Focus.SpanSec - w.Focus.BreakSec), -1, 1);
        Assert.NotNull(w.Allowance);
        Assert.InRange(w.Allowance!.BufferUsedSec, r.OverrunSec - 1, r.OverrunSec + 1);
        Assert.InRange(w.Allowance.PaidUsedSec, r.TookSec - 1, r.TookSec + 1);   // the length plus the buffer: all of it paid
        Assert.Equal(0, w.Allowance.UnpaidSec);
        Assert.Equal(PresenceStatus.Working, (await a.Api.GetCurrentPresenceAsync()).Data!.Status);
        Assert.DoesNotContain(await a.MineAsync(), i => i.Id == r.Id);
        Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null));
    }

    [Fact]
    public async Task Back_late_with_no_question_needs_no_approval()
    {
        if (Skipped()) return;
        var run = await _env.LeaveOut;
        var a = run.Agent;
        Assert.Equal(("ON_TIME", "NOT_REQUIRED"), (run.Break.Timing, run.Break.ApprovalStatus));
        await LiveEnv.WaitUntil(run.StartedAt + OverOneMinute, _out.WriteLine, "for the one-minute break to run over");

        // What the 4.0 agent sends: End break, nothing else.
        var ended = Assert.IsType<EndOutcome.Ended>(await a.Breaks.EndAsync(null));
        var r = ended.Record!;
        Assert.Equal((run.Break.Id, false, false, "NOT_REQUIRED"), (r.Id, r.InProgress, r.OverrunAsked, r.ApprovalStatus));
        Assert.Null(r.OverrunReason);
        Assert.InRange(r.OverrunSec, r.TookSec - 61, r.TookSec - 59);
        Assert.True(r.OverrunSec >= 5, $"overrun {r.OverrunSec} s");

        var w = await a.DayAsync();
        Assert.Equal((0, 0), (w.Focus.PendingPlusSec, w.Focus.ApprovedPlusSec));
        Assert.InRange(w.Focus.BreakSec, r.TookSec - 1, r.TookSec + 1);
        Assert.InRange(w.Focus.FocusSec - (w.Focus.SpanSec - w.Focus.BreakSec), -1, 1);
        Assert.True(w.Focus.Running);
        Assert.DoesNotContain(await a.MineAsync(), i => i.Id == r.Id);
        Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null));
    }
    // ---- Meetings ---------------------------------------------------------------------------

    [Fact]
    public async Task Meetings_live_under_a_minute_discarded_over_a_minute_kept_and_logged_with_every_refusal()
    {
        if (Skipped()) return;
        var run = await _env.Meetings;
        var a = run.Agent;
        var dayStart = run.Day.Sessions.Single().StartedAt;
        Near(DateTimeOffset.UtcNow.AddMinutes(-9), dayStart, 120, "the day started about 9 minutes before");

        // The participants picker: people of the company by name, never the caller.
        var manager = Assert.Single(run.FoundManager!, p => p.Id == _env.ManagerId);
        Assert.Equal(("Maya Reddy", "Engineering"), (manager.Name, manager.Department));
        Assert.NotEmpty(run.FoundAnyone!);
        Assert.True(run.FoundAnyone!.Count <= 50);
        Assert.DoesNotContain(run.FoundAnyone!, p => p.Id == a.User.Id);
        Assert.All(run.FoundAnyone!, p => Assert.False(string.IsNullOrWhiteSpace(p.Id) || string.IsNullOrWhiteSpace(p.Name)));

        // An earlier meeting logged inside the day: PAST, pending, its length; one over it is refused with what it overlaps.
        var logged = Assert.IsType<MeetingOutcome.Logged>(run.Logged).Meeting!;
        Assert.Equal((MeetingModes.Past, "Client sync", "PENDING", 300, false), (logged.Mode, logged.Agenda, logged.ApprovalStatus, logged.DurationSec, logged.InProgress));
        Assert.Equal((dayStart.AddMinutes(1), (DateTimeOffset?)dayStart.AddMinutes(6)), (logged.StartedAt, logged.EndedAt));
        Assert.Equal("Asha (client)", Assert.Single(logged.Participants).Name);
        Assert.Null(logged.Participants[0].Id);
        Assert.Equal(LiveEnv.Today, logged.Date);
        Assert.NotNull(logged.DueAt);
        var overlap = Assert.IsType<MeetingOutcome.Invalid>(run.OverlapsMeeting);
        Assert.Equal("MEETING_OVERLAPS_MEETING", overlap.Code);
        Assert.Equal(("MEETING", (DateTimeOffset?)logged.StartedAt, logged.EndedAt), (overlap.With!.Kind, overlap.With.StartedAt, overlap.With.EndedAt));

        // A live meeting: focus keeps running in it; one meeting at a time; ended within a minute it is not kept.
        var quick = Assert.IsType<MeetingOutcome.Started>(run.QuickStarted).Meeting!;
        Assert.Equal((MeetingModes.Live, "Quick sync", true, "PENDING"), (quick.Mode, quick.Agenda, quick.InProgress, quick.ApprovalStatus));
        Assert.Equal("Asha", Assert.Single(quick.Participants).Name);
        Assert.Equal("MEETING_IN_PROGRESS", Assert.IsType<MeetingOutcome.Refused>(run.SecondWhileLive).Code);
        Assert.True(run.DayInMeeting.Focus.Running, "meetings count as focus as they happen");
        var discarded = Assert.IsType<EndOutcome.MeetingEnded>(run.QuickEnded);
        Assert.True(discarded.Discarded);
        Assert.Null(discarded.Meeting);
        Assert.DoesNotContain(run.AfterQuick, m => m.Id == quick.Id);
        Assert.Equal("ON_BREAK", Assert.IsType<MeetingOutcome.Refused>(run.WhileOnBreak).Code);

        // Logging needs a time that has passed, inside the day, clear of breaks.
        var now = DateTimeOffset.UtcNow;
        var future = Assert.IsType<MeetingOutcome.Invalid>(await a.LogPastMeetingAsync(now.AddMinutes(-2), 5, "Future call", Array.Empty<MeetingParticipant>()));
        Assert.Equal("MEETING_IN_FUTURE", future.Code);
        Assert.Null(future.With);
        var outside = Assert.IsType<MeetingOutcome.Invalid>(await a.LogPastMeetingAsync(dayStart.AddMinutes(-10), 5, "Before work", Array.Empty<MeetingParticipant>()));
        Assert.Equal("MEETING_OUTSIDE_DAY", outside.Code);
        Assert.False(string.IsNullOrWhiteSpace(outside.Message));
        Assert.Equal("VALIDATION_ERROR", Assert.IsType<MeetingOutcome.Invalid>(await a.LogPastMeetingAsync(dayStart.AddMinutes(1), 4, "Tiny", Array.Empty<MeetingParticipant>())).Code);
        Assert.Equal("VALIDATION_ERROR", Assert.IsType<MeetingOutcome.Invalid>(await a.LogPastMeetingAsync(dayStart.AddMinutes(1), 5, "   ", Array.Empty<MeetingParticipant>())).Code);
        // Over the break taken earlier: it must end before now, so wait until half a minute after the break began.
        await LiveEnv.WaitUntil(run.Break.StartedAt.AddSeconds(35), _out.WriteLine, "until a meeting over the break can have ended");
        var overBreak = Assert.IsType<MeetingOutcome.Invalid>(await a.LogPastMeetingAsync(run.Break.StartedAt.AddSeconds(-270), 5, "Over the break", Array.Empty<MeetingParticipant>()));
        Assert.Equal(("MEETING_OVERLAPS_BREAK", "BREAK"), (overBreak.Code, overBreak.With?.Kind));
        Near(run.Break.StartedAt, overBreak.With!.StartedAt, 1, "the break it overlaps");
        Near(run.Break.EndedAt!.Value, overBreak.With.EndedAt, 1, "the end of the break it overlaps");

        // The meeting over a minute: kept, pending, with its people (the picked one keeps the id).
        var live = Assert.IsType<MeetingOutcome.Started>(run.Live).Meeting!;
        Assert.Equal(("Sprint review", true), (live.Agenda, live.InProgress));
        Assert.Equal(new[] { $"{_env.ManagerId}|Maya Reddy", "|Vikram, Pune" }, live.Participants.Select(p => $"{p.Id}|{p.Name}"));
        await LiveEnv.WaitUntil(run.LiveSince + OverOneMinute, _out.WriteLine, "for the meeting to pass a minute");
        Assert.Equal(PresenceStatus.Meeting, (await a.Api.GetCurrentPresenceAsync()).Data!.Status);
        await a.Meetings.RefreshAsync();
        Assert.Equal(live.Id, a.Meetings.Live?.Id);
        Assert.True(a.Meetings.Live!.DurationSec >= 60, "live seconds while it runs");
        var kept = Assert.IsType<EndOutcome.MeetingEnded>(await a.Meetings.EndAsync());
        Assert.False(kept.Discarded);
        var m = kept.Meeting!;
        Assert.Equal((live.Id, false, "PENDING", MeetingModes.Live), (m.Id, m.InProgress, m.ApprovalStatus, m.Mode));
        Assert.True(m.DurationSec >= 66, $"{m.DurationSec} s");
        Assert.Equal((m.EndedAt!.Value - m.StartedAt).TotalSeconds, m.DurationSec, 1.0);
        Assert.Null(a.Meetings.Live);
        Assert.Equal(PresenceStatus.Working, (await a.Api.GetCurrentPresenceAsync()).Data!.Status);

        // Meeting ended again (a retry) changes nothing.
        var again = await a.Api.EndMeetingAsync(m.Id);
        Assert.True(again.Ok, again.ToString());
        Assert.Equal((false, m.Id, m.EndedAt), (again.Data!.Discarded, again.Data.Meeting?.Id, again.Data.Meeting?.EndedAt));

        // Today's meetings, and both waiting for the manager with what a rejection would cost.
        await a.Meetings.RefreshAsync();
        Assert.Equal(new[] { logged.Id, m.Id }.Order(), a.Meetings.Today.Select(x => x.Id).Order());
        var mine = await a.MineAsync();
        var liveItem = Assert.Single(mine, i => i.Id == m.Id);
        var liveMin = Math.Max(1, (int)Math.Round(m.DurationSec / 60.0, MidpointRounding.AwayFromZero));
        Assert.Equal(("MEETING", "MEETING_LIVE", "PENDING", "Meeting: Sprint review", $"Sprint review · minutes by {LiveEnv.MomSender}"), (liveItem.Type, liveItem.Category, liveItem.Status, liveItem.Title, liveItem.Reason));
        Assert.Equal(("MINUS", liveMin, $"−{liveMin} min if rejected"), (liveItem.Effect.Mode, liveItem.Effect.Minutes, liveItem.Effect.Text));
        Assert.Equal(2, liveItem.Participants.Count);
        Assert.Equal((false, m.DurationSec), (liveItem.InProgress, liveItem.DurationSec));
        var pastItem = Assert.Single(mine, i => i.Id == logged.Id);
        Assert.Equal(("MEETING_PAST", "MINUS", 5, "−5 min if rejected"), (pastItem.Category, pastItem.Effect.Mode, pastItem.Effect.Minutes, pastItem.Effect.Text));

        // Focus: meetings count as they happen; both may cost their time if rejected.
        var w = await a.DayAsync();
        Assert.True(w.Focus.MeetingSec >= 300 + m.DurationSec, $"meetingSec {w.Focus.MeetingSec}");
        Assert.Equal(300 + m.DurationSec, w.Focus.PendingMinusSec);
        Assert.InRange(w.Focus.FocusSec - (w.Focus.SpanSec - w.Focus.BreakSec), -1, 1);
        Assert.True(w.Focus.Running);
        Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null));
    }

    // ---- The whole agent through a working day ---------------------------------------------------

    [Fact]
    public async Task AgentHost_runs_a_working_day_against_the_live_api()
    {
        if (Skipped()) return;
        var run = await _env.HostDay;
        var host = run.Host;
        try
        {
            // Signed in on a new day: the notice, then NotStarted with the greeting, and nothing recorded.
            Assert.Equal(AgentState.NeedsNotice, run.AfterSignIn);
            Assert.Equal(AgentState.NotStarted, run.AfterNotice);
            Assert.True(run.DayAtSignIn!.IsNotStarted);
            Assert.Equal(PresenceStatus.NotStarted, run.PresenceAtSignIn);
            var greeting = Assert.Single(run.Nudges);
            Assert.Equal((NudgeKind.Greeting, LiveEnv.Today), (greeting.Kind, greeting.Date));
            Assert.Equal(0, run.TrackingCallsWhileNotStarted);
            Assert.Equal("DAY_NOT_STARTED", Assert.IsType<StartOutcome.Refused>(run.BreakWhileNotStarted).Code);
            Assert.Equal("DAY_NOT_STARTED", Assert.IsType<SkipOutcome.Refused>(run.SkipWhileNotStarted).Code);
            Assert.IsType<EndDayOutcome.NotStarted>(run.EndWhileNotStarted);
            var panel = run.PanelAtSignIn!;
            Assert.True(panel.Scheduled);
            Assert.Equal(new[] { true, false, false }, panel.Slots.Select(s => s.CanSkip));

            // Start Day: Running, tracking.
            var started = Assert.IsType<StartDayOutcome.Started>(run.StartDay);
            Assert.False(started.Resumed);
            Assert.True(started.Workday!.IsOpen);
            Assert.Equal(AgentState.Running, run.AfterStartDay);
            Assert.True(run.FirstSampleSent > DateTimeOffset.MinValue);
            Assert.True(run.Http.Count("POST", "/activity/report") >= 1);

            // Skip: lunch is refused by the server; the morning is skipped with its reason.
            Assert.Equal("SKIP_NOT_ALLOWED", Assert.IsType<SkipOutcome.Refused>(run.SkipLunch).Code);
            var skip = Assert.IsType<SkipOutcome.Skipped>(run.SkipMorning).Record!;
            Assert.Equal((BreakOutcomes.Skipped, "Client escalation call", "PENDING"), (skip.Outcome, skip.Reason, skip.ApprovalStatus));
            Assert.Equal(SlotState.Skipped, run.PanelAfterSkip!.Slots[0].State);

            // Focus runs while the day runs, ticking locally between the server's answers.
            await host.RefreshWorkdayAsync();
            var day = host.Workday!;
            Assert.True(day.IsOpen && day.Focus.Running);
            Assert.Equal(10 * 60, day.Focus.PendingMinusSec);   // the host shift's morning is 10 minutes
            var mine = Assert.Single(host.MyApprovals, i => i.Id == skip.Id);
            Assert.Equal("−10 min if rejected", mine.Effect.Text);
            Assert.True(FocusClock.At(day, host.Clock.UtcNow.AddSeconds(30)) >= day.Focus.FocusSec + 29);

            // Lunch starts while the day runs, so it is owed. End Day inside its window: blocked, typed.
            await LiveEnv.WaitUntil(run.LunchAt.AddSeconds(3), _out.WriteLine, "for the lunch to start (owed by the open day)");
            var blocked = Assert.IsType<EndDayOutcome.CommentsRequired>(await host.EndDayAsync());
            var lunch = Assert.Single(blocked.Breaks);
            Assert.Equal(("LUNCH", "Lunch break", BreakOutcomes.AutoSkipped, 10), (lunch.Kind, lunch.Label, lunch.Outcome, lunch.MinChars));
            Assert.Equal(AgentState.Running, host.State);
            // 4.0: End Day is judged before it writes. Lunch is listed with the id its auto-skip will
            // get, but nothing is made yet: the slot is still open and can be taken.
            await host.RefreshWorkdayAsync();
            var lunchSlot = host.BreakPanel.Slots.Single(s => s.Kind == BreakKinds.Lunch);
            Assert.Null(lunchSlot.PendingAutoSkip);
            Assert.True(lunchSlot.CanStart);
            Assert.DoesNotContain(host.Workday!.SkipsNeedingComment, s => s.Id == lunch.Id);

            // A comment too short is refused for that break; the day still runs.
            var invalid = Assert.IsType<EndDayOutcome.CommentInvalid>(await host.EndDayAsync(new[] { new SkipComment(lunch.Id, "Too short") }));
            Assert.Equal((lunch.Id, (int?)10, "TOO_SHORT"), (invalid.BreakId, invalid.MinChars, invalid.Problem));
            Assert.Equal(AgentState.Running, host.State);

            // With the comment: the day ends; nothing is recorded any more.
            var ended = Assert.IsType<EndDayOutcome.Ended>(await host.EndDayAsync(new[] { new SkipComment(lunch.Id, "Customer escalation ran through lunch") }));
            Assert.True(ended.Workday!.IsEnded);
            Assert.NotNull(ended.EndedAt);
            Assert.Equal(AgentState.DayEnded, host.State);
            Assert.Equal(PresenceStatus.DayEnded, host.Presence.Status);
            Assert.Empty(host.Workday!.SkipsNeedingComment);
            await host.RefreshWorkdayAsync();
            var lunchItem = Assert.Single(host.MyApprovals, i => i.Id == lunch.Id);
            Assert.Equal(("BREAK_AUTO_SKIP", "Customer escalation ran through lunch"), (lunchItem.Category, lunchItem.Reason));
            Assert.Equal("DAY_ENDED", Assert.IsType<SkipOutcome.Refused>(await host.SkipBreakAsync(BreakKinds.Evening, "Client escalation call")).Code);

            // Start Day again resumes: a second session.
            var resumed = Assert.IsType<StartDayOutcome.Started>(await host.StartDayAsync());
            Assert.True(resumed.Resumed);
            Assert.Equal(AgentState.Running, host.State);
            Assert.Equal(2, host.Workday!.Sessions.Count);
            Assert.IsType<EndDayOutcome.Ended>(await host.EndDayAsync());
            Assert.Equal(AgentState.DayEnded, host.State);

            await host.SignOutAsync();
            Assert.Equal(AgentState.SignIn, host.State);
        }
        finally
        {
            foreach (var line in run.Log.Lines) _out.WriteLine(line);
        }
    }
}
