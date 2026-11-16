using System.Globalization;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Workday;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.Core.Tests.Live;

/// <summary>
/// Every 3.1 call the agent makes (SPEC 3.1 to 3.4), against the real API: each answer
/// read into the agent's own models and outcome types, and its values checked. One
/// fresh person and shift per test. Opt-in: see <see cref="LiveEnv"/>.
/// </summary>
[Collection(LiveCollection.Name)]
public sealed class LiveWorkdayTests
{
    private readonly LiveFixture _env;
    private readonly ITestOutputHelper _out;

    public LiveWorkdayTests(LiveFixture env, ITestOutputHelper output)
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

    internal static void Near(DateTimeOffset expected, DateTimeOffset? actual, double seconds, string what)
    {
        Assert.True(actual.HasValue, $"{what}: missing");
        var off = Math.Abs((actual!.Value - expected).TotalSeconds);
        Assert.True(off <= seconds, $"{what}: {actual:O} is {off:F1} s from {expected:O}");
    }

    private static readonly LiveBreak[] FarBreaks =
    {
        new("MORNING", 30, 15, 10, 10),
        new("LUNCH", 70, 30, 10, 10),
        new("EVENING", 150, 15, 10, 10),
    };

    /// <summary>Morning open now (and ringing), lunch and evening later.</summary>
    private static readonly LiveBreak[] MorningOpen =
    {
        new("MORNING", -1, 15, 5, 30),
        new("LUNCH", 70, 30, 20, 30),
        new("EVENING", 150, 15, 30, 20),
    };

    // ---- The working day: NOT_STARTED, OPEN, ENDED, resumed --------------------------------

    [Fact]
    public async Task A_new_day_is_not_started_then_open_then_ended_and_Start_Day_resumes_it()
    {
        if (Skipped()) return;
        var t = DateTimeOffset.UtcNow;
        var shift = await _env.Admin.CreateShiftAsync("Day", t, FarBreaks);
        var person = await _env.Admin.CreatePersonAsync("Asha", "Rao");
        await _env.Admin.AssignAsync(shift, person.Id);
        using var a = await LiveAgent.SignInAsync(person);

        // Sign-in: the person as the agent keeps them, with the version the server reads as a 3.1 agent.
        Assert.StartsWith("4.0.", AgentOptions.AppVersion);
        Assert.Equal(ApiOutcome.Ok, a.SignIn!.Outcome);
        Assert.True(a.Api.IsSignedIn);
        var u = a.User;
        Assert.Equal((person.Id, person.Email, "Asha", "Rao", "Asha Rao"), (u.Id, u.Email, u.FirstName, u.LastName, u.DisplayName));
        Assert.Equal(("USER", "Engineering"), (u.Role, u.Department));   // 4.0: approvals follow the department, not a manager id
        Assert.False(u.IsManager);
        Assert.True(u.ScreenshotsEnabled);

        // NOT_STARTED: nothing counted yet, the shift and the rules the dialogs need.
        var d = await a.DayAsync();
        Assert.Equal(WorkdayStates.NotStarted, d.State);
        Assert.True(d.IsNotStarted);
        Assert.False(d.IsOpen || d.IsEnded);
        Assert.Equal((LiveEnv.Today, "Asia/Kolkata"), (d.Date, d.Timezone));
        Near(DateTimeOffset.UtcNow, d.ServerNow, 30, "serverNow");
        Assert.True(a.Clock.Known);
        Assert.Null(d.StartedAt);
        Assert.Null(d.EndedAt);
        Assert.False(d.AutoClosed);
        Assert.Empty(d.Sessions);
        Assert.Equal(new[] { 0, 0, 0, 0, 0, 0, 0, 0 }, FocusNumbers(d.Focus));
        Assert.False(d.Focus.Running);
        Assert.Null(d.LateStart);
        Assert.Equal(shift, d.Shift!.Id);
        Assert.StartsWith("Agent IT Day", d.Shift.Name);
        Assert.Equal((LiveEnv.Hm(t.AddMinutes(-120)), LiveEnv.Hm(t.AddMinutes(180))), (d.Shift.Start, d.Shift.End));
        // 4.0: the target is the shift less its breaks and the paid buffer (SPEC 2.4).
        Assert.NotNull(d.Allowance);
        Assert.Equal(((15 + 30 + 15) * 60, 600), (d.Allowance!.ScheduledSec, d.Allowance.BufferSec));
        Assert.Equal(5 * 3600 - (15 + 30 + 15) * 60 - 600, d.ExpectedSec);
        Assert.Equal(d.ExpectedSec, d.TargetSec);
        Assert.Empty(d.SkipsNeedingComment);
        Assert.Equal((0, false), (d.OverdueApprovals, d.EndDayBlockedByOverdue));
        Assert.Equal((48, 10), (d.Settings.ApprovalSlaHours, d.Settings.ReasonMinChars));
        Assert.True(d.PortalUrl is null || (Uri.TryCreate(d.PortalUrl, UriKind.Absolute, out var portal) && portal.Scheme is "http" or "https"), d.PortalUrl);
        Assert.Equal(0, FocusClock.At(d, a.Clock.UtcNow.AddMinutes(5)));

        // No day: presence says so, a 3.1 agent's samples are not wanted and never start one, and there is nothing to end.
        var presence = await a.Api.GetCurrentPresenceAsync();
        Assert.True(presence.Ok, presence.ToString());
        Assert.Equal(PresenceStatus.NotStarted, presence.Data!.Status);
        Assert.False((await a.ReportAsync()).ShouldCapture);
        Assert.True((await a.DayAsync()).IsNotStarted);
        Assert.False(string.IsNullOrWhiteSpace(Assert.IsType<EndDayOutcome.NotStarted>(await a.Workday.EndAsync(null)).Message));

        // Start Day: OPEN from now, late against the shift (it began two hours ago).
        var start = await a.StartDayAsync();
        Assert.False(start.Resumed);
        var open = start.Workday!;
        Assert.Same(open, a.Workday.Today);
        Assert.True(open.IsOpen);
        Assert.Equal(LiveEnv.Today, open.Date);
        var s1 = Assert.Single(open.Sessions);
        Near(DateTimeOffset.UtcNow, s1.StartedAt, 10, "session start");
        Assert.Equal(s1.StartedAt, open.StartedAt);
        Assert.Null(s1.EndedAt);
        Assert.Null(s1.EndReason);
        Assert.Null(open.EndedAt);
        Assert.True(open.Focus.Running);
        Assert.InRange(open.LateStart!.Minutes, 110, 125);

        // Pressed again: the same session, not a resume.
        var again = await a.StartDayAsync();
        Assert.False(again.Resumed);
        Assert.Equal(s1.StartedAt, Assert.Single(again.Workday!.Sessions).StartedAt);

        // The day is open: samples are wanted, presence is working.
        Assert.True((await a.ReportAsync()).ShouldCapture);
        Assert.Equal(PresenceStatus.Working, (await a.Api.GetCurrentPresenceAsync()).Data!.Status);

        // Focus runs while working (SPEC 1.3), and the agent's local clock keeps pace with the server.
        var f1 = await a.DayAsync();
        await Task.Delay(2500);
        var f2 = await a.DayAsync();
        Assert.True(f1.Focus.Running && f2.Focus.Running);
        Assert.InRange(f2.Focus.FocusSec - f1.Focus.FocusSec, 1, 5);
        Assert.InRange(f2.Focus.FocusSec - (f2.Focus.SpanSec - f2.Focus.BreakSec), -1, 1);
        Assert.InRange(FocusClock.At(f1, f2.ServerNow) - f2.Focus.FocusSec, -1, 1);
        Assert.Equal(0, f2.Focus.BreakSec);
        // 4.0: paid time is focus plus paid breaks; a live day (not replayed) has no unverified time.
        Assert.Equal(f2.Focus.FocusSec + f2.Focus.PaidBreakSec, f2.Focus.PaidSec);
        Assert.Equal(0, f2.Focus.UnverifiedSec);

        // End Day: ENDED by the person, focus stands still. The answer is the day that ended.
        var end = Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null));
        Near(DateTimeOffset.UtcNow, end.EndedAt, 10, "End Day");
        var ended = end.Workday!;
        Assert.True(ended.IsEnded);
        Assert.Equal(LiveEnv.Today, ended.Date);
        Assert.InRange(ended.Focus.FocusSec, f2.Focus.FocusSec, f2.Focus.FocusSec + 30);
        Assert.Null(ended.LastEnded);
        Assert.Equal(end.EndedAt, ended.EndedAt);
        Assert.False(ended.AutoClosed);
        var closed = Assert.Single(ended.Sessions);
        Assert.Equal(("USER", end.EndedAt), (closed.EndReason, closed.EndedAt));
        Assert.False(ended.Focus.Running);
        var read = await a.DayAsync();
        Assert.True(read.IsEnded);
        Assert.Equal(end.EndedAt, read.EndedAt);
        await Task.Delay(1200);
        Assert.Equal(read.Focus.FocusSec, (await a.DayAsync()).Focus.FocusSec);
        Assert.Equal(read.Focus.FocusSec, FocusClock.At(read, a.Clock.UtcNow.AddMinutes(10)));

        // Again: the same end (idempotent). Samples are not wanted; presence says the day ended.
        Assert.Equal(end.EndedAt, Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null)).EndedAt);
        Assert.False((await a.ReportAsync()).ShouldCapture);
        Assert.Equal(PresenceStatus.DayEnded, (await a.Api.GetCurrentPresenceAsync()).Data!.Status);

        // Start Day after End Day resumes: a second session, and focus counts both but not the gap.
        await Task.Delay(2000);
        var resumed = await a.StartDayAsync();
        Assert.True(resumed.Resumed);
        var w = resumed.Workday!;
        Assert.True(w.IsOpen);
        Assert.Equal(2, w.Sessions.Count);
        Assert.Equal((s1.StartedAt, end.EndedAt, "USER"), (w.Sessions[0].StartedAt, w.Sessions[0].EndedAt, w.Sessions[0].EndReason));
        Assert.Null(w.Sessions[1].EndedAt);
        Assert.True(w.Sessions[1].StartedAt > end.EndedAt);
        Assert.Equal(s1.StartedAt, w.StartedAt);
        Assert.Null(w.EndedAt);
        var expectedSpan = (end.EndedAt!.Value - s1.StartedAt).TotalSeconds + (w.ServerNow - w.Sessions[1].StartedAt).TotalSeconds;
        Assert.InRange(w.Focus.SpanSec, expectedSpan - 2, expectedSpan + 2);
        Assert.True(w.Focus.SpanSec < (w.ServerNow - s1.StartedAt).TotalSeconds - 1.5, "the gap between the sessions is not focus");
        Assert.True(w.Focus.Running);
        Assert.Equal(PresenceStatus.Working, (await a.Api.GetCurrentPresenceAsync()).Data!.Status);
        Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null));
    }

    [Fact]
    public async Task A_day_that_ended_after_midnight_is_shown_on_the_new_dates_not_started_day()
    {
        if (Skipped()) return;
        if (LiveEnv.Db is null)
        {
            _out.WriteLine("skipped: needs RXV_IT_DB to move a session to yesterday");
            return;
        }
        var t = DateTimeOffset.UtcNow;
        var shift = await _env.Admin.CreateShiftAsync("Night", t, FarBreaks);
        var person = await _env.Admin.CreatePersonAsync("Ravi", "Iyer");
        await _env.Admin.AssignAsync(shift, person.Id);
        using var a = await LiveAgent.SignInAsync(person);
        Assert.Null((await a.DayAsync()).LastEnded);   // nothing ended yet

        await a.StartDayAsync();
        await Task.Delay(1500);
        var end = Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null));
        Assert.True(end.Workday!.IsEnded);
        Assert.Equal(LiveEnv.Today, end.Workday.Date);

        // As if the session had started yesterday (a night shift, ended just now, after midnight).
        var yesterday = LiveEnv.BusinessNow.AddDays(-1).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        await LiveEnv.SqlAsync($"UPDATE work_sessions SET date = '{yesterday}' WHERE user_id = '{person.Id}'");

        var today = await a.DayAsync();
        Assert.True(today.IsNotStarted);
        Assert.Equal(LiveEnv.Today, today.Date);
        var last = Assert.IsType<LastEndedView>(today.LastEnded);
        Assert.Equal(yesterday, last.Date);
        Near(end.EndedAt!.Value, last.EndedAt, 1, "lastEnded.endedAt");
        Assert.InRange(last.FocusSec, 0, 120);
    }

    private static int[] FocusNumbers(FocusView f) => new[]
    {
        f.FocusSec, f.SpanSec, f.BreakSec, f.MeetingSec, f.ApprovedPlusSec, f.PendingPlusSec, f.RejectedMinusSec, f.PendingMinusSec,
    };

    // ---- Breaks today and Skip break ---------------------------------------------------------

    [Fact]
    public async Task Breaks_today_say_which_can_be_skipped_and_every_skip_refusal_is_typed()
    {
        if (Skipped()) return;
        var t = DateTimeOffset.UtcNow;
        var shift = await _env.Admin.CreateShiftAsync("Skip", t, MorningOpen);
        var person = await _env.Admin.CreatePersonAsync("Ravi", "Shankar");
        await _env.Admin.AssignAsync(shift, person.Id);
        using var a = await LiveAgent.SignInAsync(person);

        // The day view: the schedule, Skip allowed per break, nothing recorded yet.
        var day = await a.BreakDayAsync();
        Assert.Equal((LiveEnv.Today, "SCHEDULED", "Asia/Kolkata"), (day.Date, day.Mode, day.Timezone));
        Assert.True(day.Scheduled);
        Assert.True(day.Workday);
        Assert.False(day.DayEnded);
        Near(DateTimeOffset.UtcNow, day.ServerNow, 30, "serverNow");
        Assert.Equal(shift, day.Shift!.Id);
        var rules = day.Shift.Rules;
        Assert.Equal((1, 5, 10, 3, true, true), (rules.RingLeadMin, rules.RingDurationMin, rules.ReasonMinChars, rules.OverrunGraceMin, rules.ReasonOnEarly, rules.ReasonOnLate));
        Assert.Equal(10, day.ReasonMinChars);
        Assert.Empty(day.SkipsNeedingComment);
        Assert.Null(day.ActiveBreak);
        Assert.Empty(day.Unscheduled);
        Assert.Equal(new[] { "MORNING:True", "LUNCH:False", "EVENING:True" }, day.Breaks.Select(b => $"{b.Kind}:{b.AllowSkip}"));
        Assert.Equal(new[] { "Morning break", "Lunch break", "Evening break" }, day.Breaks.Select(b => b.Label));
        Assert.Equal(new[] { "BREAK", "LUNCH", "BREAK" }, day.Breaks.Select(b => b.PresenceType));
        Assert.Equal(new[] { 15, 30, 15 }, day.Breaks.Select(b => b.DurationMin));
        Assert.All(day.Breaks, b => Assert.Null(b.Record));
        var m = day.Breaks[0];
        Assert.Equal(LiveEnv.AtHm(t.AddMinutes(-1)), m.ScheduledStart);
        Assert.Equal((m.ScheduledStart.AddMinutes(15), m.ScheduledStart.AddMinutes(-5), m.ScheduledStart.AddMinutes(30)), (m.ScheduledEnd, m.WindowOpen, m.WindowClose));
        Assert.Equal((m.ScheduledStart.AddMinutes(-1), m.ScheduledStart.AddMinutes(4)), (m.RingStart, m.RingEnd));
        Assert.Equal((LiveEnv.Hm(m.ScheduledStart), LiveEnv.Hm(m.ScheduledEnd), LiveEnv.Hm(m.WindowOpen), LiveEnv.Hm(m.WindowClose)),
            (m.Local.Start, m.Local.End, m.Local.WindowOpen, m.Local.WindowClose));
        var panel = a.Breaks.Panel();
        Assert.Equal(10, panel.MinChars);
        Assert.Equal((SlotState.Due, true), (panel.Slots[0].State, panel.Slots[0].CanSkip));
        Assert.Equal((SlotState.Upcoming, false), (panel.Slots[1].State, panel.Slots[1].CanSkip));
        Assert.Equal((SlotState.Upcoming, false), (panel.Slots[2].State, panel.Slots[2].CanSkip));
        Assert.Equal(BreakKinds.Morning, panel.Ring?.Kind);

        // Before Start Day: DAY_NOT_STARTED for a skip, a break and a meeting.
        Assert.Equal("DAY_NOT_STARTED", Assert.IsType<SkipOutcome.Refused>(await a.Breaks.SkipAsync(BreakKinds.Morning, "Client escalation call")).Code);
        Assert.Equal("DAY_NOT_STARTED", Assert.IsType<StartOutcome.Refused>(await a.Breaks.StartAsync(BreakKinds.Morning, null)).Code);
        Assert.Equal("DAY_NOT_STARTED", Assert.IsType<MeetingOutcome.Refused>(await a.StartMeetingAsync("Standup", Array.Empty<MeetingParticipant>())).Code);
        Assert.Equal("DAY_NOT_STARTED", Assert.IsType<MeetingOutcome.Refused>(
            await a.LogPastMeetingAsync(DateTimeOffset.UtcNow.AddMinutes(-30), 10, "Standup", Array.Empty<MeetingParticipant>())).Code);

        // After End Day: DAY_ENDED instead, and the breaks view says the day ended.
        await a.StartDayAsync();
        Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null));
        Assert.Equal("DAY_ENDED", Assert.IsType<SkipOutcome.Refused>(await a.Breaks.SkipAsync(BreakKinds.Morning, "Client escalation call")).Code);
        Assert.Equal("DAY_ENDED", Assert.IsType<StartOutcome.Refused>(await a.Breaks.StartAsync(BreakKinds.Morning, null)).Code);
        Assert.Equal("DAY_ENDED", Assert.IsType<MeetingOutcome.Refused>(await a.StartMeetingAsync("Late call", Array.Empty<MeetingParticipant>())).Code);
        Assert.True((await a.BreakDayAsync()).DayEnded);
        Assert.All(a.Breaks.Panel().Slots, s => Assert.False(s.CanSkip || s.CanStart));

        // Resumed: lunch cannot be skipped, the evening is not open, a reason is needed (the shift's minimum).
        Assert.True((await a.StartDayAsync()).Resumed);
        Assert.False((await a.BreakDayAsync()).DayEnded);
        Assert.Equal("SKIP_NOT_ALLOWED", Assert.IsType<SkipOutcome.Refused>(await a.Breaks.SkipAsync(BreakKinds.Lunch, "Client escalation call")).Code);
        Assert.Equal("BREAK_NOT_OPEN", Assert.IsType<SkipOutcome.Refused>(await a.Breaks.SkipAsync(BreakKinds.Evening, "Client escalation call")).Code);
        var noReason = Assert.IsType<SkipOutcome.NeedsReason>(await a.Breaks.SkipAsync(BreakKinds.Morning, null));
        Assert.Equal(10, noReason.MinChars);
        Assert.Contains("10 characters", noReason.Message);
        Assert.Equal(10, Assert.IsType<SkipOutcome.NeedsReason>(await a.Breaks.SkipAsync(BreakKinds.Morning, "too short")).MinChars);

        // Skipped: a SKIPPED record with the cleaned reason, waiting 48 hours for the manager, no presence.
        var skipped = Assert.IsType<SkipOutcome.Skipped>(await a.Breaks.SkipAsync(BreakKinds.Morning, "  Client   escalation call "));
        var rec = skipped.Record!;
        Assert.Equal((BreakOutcomes.Skipped, "MORNING", "Morning break", LiveEnv.Today), (rec.Outcome, rec.Kind, rec.Label, rec.Date));
        Assert.True(rec.IsSkip);
        Assert.False(rec.IsAutoSkip);
        Assert.Equal("Client escalation call", rec.Reason);
        Assert.Equal(("PENDING", "MANAGER"), (rec.ApprovalStatus, rec.ApproverRole));
        Assert.False(rec.NeedsComment);
        Assert.Null(rec.CommentedAt);
        // A skip has no presence session: a zero-length record.
        Assert.False(rec.InProgress);
        Assert.Equal((rec.StartedAt, 0), (rec.EndedAt!.Value, rec.TookSec));
        Assert.Equal((0, false), (rec.OverrunSec, rec.OverrunAsked));
        Assert.Equal((m.ScheduledStart, (int?)15), (rec.ScheduledStart!.Value, rec.DurationMin));
        Assert.Contains(rec.Timing, new[] { "ON_TIME", "LATE" });
        Near(DateTimeOffset.UtcNow, rec.StartedAt, 15, "skipped at");
        Near(rec.StartedAt.AddHours(48), rec.DueAt, 5, "due 48 hours after the skip");
        Assert.Equal(PresenceStatus.Working, (await a.Api.GetCurrentPresenceAsync()).Data!.Status);

        // It cannot be skipped twice, nor taken.
        Assert.Equal("BREAK_ALREADY_TAKEN", Assert.IsType<SkipOutcome.Refused>(await a.Breaks.SkipAsync(BreakKinds.Morning, "Client escalation call")).Code);
        Assert.Equal("BREAK_ALREADY_TAKEN", Assert.IsType<StartOutcome.Refused>(await a.Breaks.StartAsync(BreakKinds.Morning, null)).Code);

        // The slot holds the skip; the panel shows it skipped, no longer ringing.
        var after = a.Breaks.Day!;
        Assert.Equal((rec.Id, BreakOutcomes.Skipped), (after.Breaks[0].Record!.Id, after.Breaks[0].Record!.Outcome));
        Assert.Empty(after.SkipsNeedingComment);
        var p2 = a.Breaks.Panel();
        Assert.Equal((SlotState.Skipped, false, false), (p2.Slots[0].State, p2.Slots[0].CanSkip, p2.Slots[0].CanStart));
        Assert.Null(p2.Ring);

        // Focus: a skip counts, and may cost its 15 minutes if rejected.
        var w = await a.DayAsync();
        Assert.Equal(900, w.Focus.PendingMinusSec);
        Assert.True(w.Focus.Running);
        Assert.Empty(w.SkipsNeedingComment);

        // The waiting list: the skip with its effect.
        var item = Assert.Single(await a.MineAsync(), i => i.Id == rec.Id);
        Assert.Equal(("BREAK", "BREAK_SKIP", "PENDING", "Morning break skipped"), (item.Type, item.Category, item.Status, item.Title));
        Assert.True(item.IsPending);
        Assert.Equal(("Client escalation call", false), (item.Reason, item.NeedsComment));
        Assert.Equal(("MINUS", 15, "−15 min if rejected"), (item.Effect.Mode, item.Effect.Minutes, item.Effect.Text));
        Assert.Equal((rec.DueAt, false, LiveEnv.Today, rec.StartedAt), (item.DueAt, item.Overdue, item.Date, item.StartedAt));
        Assert.StartsWith("Skipped at ", item.Detail);
        Assert.Empty(item.Participants);

        // The break history carries it as well.
        var history = await a.Api.GetBreakHistoryAsync();
        Assert.True(history.Ok, history.ToString());
        Assert.Equal(LiveEnv.Today, history.Data!.To);
        Assert.Contains(history.Data.Items, r => r.Id == rec.Id && r.Outcome == BreakOutcomes.Skipped && r.Reason == "Client escalation call");

        // A skip with a reason needs no comment: End Day goes through.
        Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null));
    }

    // ---- End Day and the skip comments gate -------------------------------------------------

    [Fact]
    public async Task End_Day_inside_an_open_window_needs_a_comment_on_each_of_three_skipped_breaks()
    {
        if (Skipped()) return;
        var t = DateTimeOffset.UtcNow;
        // Morning and lunch windows closed minutes ago; the evening window is open now.
        var shift = await _env.Admin.CreateShiftAsync("Gate", t, new[]
        {
            new LiveBreak("MORNING", -7, 1, 0, 1),
            new LiveBreak("LUNCH", -5, 1, 0, 1),
            new LiveBreak("EVENING", -3, 1, 0, 30),
        }, ringLeadMin: 0, ringDurationMin: 1);
        var person = await _env.Admin.CreatePersonAsync("Anita", "Desai");
        await _env.Admin.AssignAsync(shift, person.Id);
        using var a = await LiveAgent.SignInAsync(person);

        // The day started 9 minutes ago (a Start Day press sent with its time), so all three breaks are owed.
        var started = await a.StartDayAsync(minutesBack: 9);
        Near(DateTimeOffset.UtcNow.AddMinutes(-9), started.Workday!.StartedAt, 5, "Start Day dated 9 minutes back");

        // The two closed windows were auto-skipped when the day was read: newest first, each waiting for a comment.
        var w = await a.DayAsync();
        Assert.Equal(new[] { "LUNCH", "MORNING" }, w.SkipsNeedingComment.Select(s => s.Kind));
        Assert.All(w.SkipsNeedingComment, s =>
        {
            Assert.Equal((BreakOutcomes.AutoSkipped, 10, LiveEnv.Today, (int?)1), (s.Outcome, s.MinChars, s.Date, s.DurationMin));
            Assert.NotNull(s.ScheduledStart);
        });
        var day = await a.BreakDayAsync();
        Assert.Equal(new[] { "LUNCH", "MORNING" }, day.SkipsNeedingComment.Select(s => s.Kind));
        foreach (var slot in day.Breaks.Take(2))
        {
            var r = slot.Record!;
            Assert.Equal((BreakOutcomes.AutoSkipped, "PENDING", "OUTSIDE_WINDOW", 0, "SYSTEM"), (r.Outcome, r.ApprovalStatus, r.Timing, r.MinutesOff, r.Source));
            Assert.True(r.IsAutoSkip && r.NeedsComment);
            Assert.Null(r.Reason);
            Assert.Equal(slot.WindowClose, r.StartedAt);
            Assert.Contains(w.SkipsNeedingComment, s => s.Id == r.Id && s.SkippedAt == r.StartedAt && s.ScheduledStart == slot.ScheduledStart);
        }
        Assert.Null(day.Breaks[2].Record);
        Assert.Equal(day.Breaks.Take(2).Select(s => s.Record!.Id).Order(), a.AutoSkips.Select(r => r.Id).Order());
        var panel = a.Breaks.Panel();
        Assert.Equal(new[] { SlotState.AutoSkipped, SlotState.AutoSkipped, SlotState.OpenLate }, panel.Slots.Select(s => s.State));
        Assert.True(panel.Slots[2].CanSkip);

        // End Day pressed while the evening's window is open (4.0: judged before it writes): the gate
        // lists the two skips waiting and the evening's auto-skip End Day would make, with the id it
        // will get. Nothing is written: the evening is still open, and can still be taken or skipped.
        var pressed = DateTimeOffset.UtcNow;
        var gate = Assert.IsType<EndDayOutcome.CommentsRequired>(await a.Workday.EndAsync(null));
        Assert.Contains("3 skipped breaks", gate.Message);
        Assert.Equal(new[] { "LUNCH", "MORNING", "EVENING" }, gate.Breaks.Select(b => b.Kind));
        Assert.Equal(new[] { "Lunch break", "Morning break", "Evening break" }, gate.Breaks.Select(b => b.Label));
        Assert.All(gate.Breaks, b => Assert.Equal((BreakOutcomes.AutoSkipped, 10, LiveEnv.Today), (b.Outcome, b.MinChars, b.Date)));
        Near(pressed, gate.Breaks[2].SkippedAt, 10, "the evening would be skipped when End Day is pressed");
        var (l, mo, e) = (gate.Breaks[0].Id, gate.Breaks[1].Id, gate.Breaks[2].Id);
        Assert.True((await a.DayAsync()).IsOpen);
        var withoutEvening = await a.BreakDayAsync();
        Assert.Null(withoutEvening.Breaks[2].Record);
        var evening = a.Breaks.Panel().Slots[2];
        Assert.Equal((SlotState.OpenLate, true, true, (string?)null), (evening.State, evening.CanStart, evening.CanSkip, evening.PendingAutoSkip?.Id));

        // A refused comment fails the whole call, typed: which break, why, and the minimum. Nothing is saved.
        var tooShort = Assert.IsType<EndDayOutcome.CommentInvalid>(await a.Workday.EndAsync(new[]
        {
            new SkipComment(mo, "Back-to-back client calls"), new SkipComment(l, "  Too   short "), new SkipComment(e, "Production issue on the bridge"),
        }));
        Assert.Equal((l, (int?)10, "TOO_SHORT"), (tooShort.BreakId, tooShort.MinChars, tooShort.Problem));
        Assert.Contains("10 characters", tooShort.Message);
        var tooLong = Assert.IsType<EndDayOutcome.CommentInvalid>(await a.Workday.EndAsync(new[] { new SkipComment(l, new string('x', 501)) }));
        Assert.Equal((l, "TOO_LONG"), (tooLong.BreakId, tooLong.Problem));
        var twice = Assert.IsType<EndDayOutcome.CommentInvalid>(await a.Workday.EndAsync(new[]
        {
            new SkipComment(mo, "Back-to-back client calls"), new SkipComment(mo, "Back-to-back client calls"),
        }));
        Assert.Equal((mo, "DUPLICATE"), (twice.BreakId, twice.Problem));
        var unknown = Guid.NewGuid().ToString();
        var notFound = Assert.IsType<EndDayOutcome.CommentInvalid>(await a.Workday.EndAsync(new[] { new SkipComment(unknown, "Back-to-back client calls") }));
        Assert.Equal((unknown, "NOT_FOUND", (int?)null), (notFound.BreakId, notFound.Problem, notFound.MinChars));
        var untouched = await a.BreakDayAsync();
        Assert.All(untouched.Breaks.Take(2), s => Assert.Null(s.Record!.Reason));
        Assert.Null(untouched.Breaks[2].Record);
        Assert.Equal(2, (await a.DayAsync()).SkipsNeedingComment.Count);

        // Two comments of three: End Day still waits for the third, and (judged before it writes) saves neither.
        var oneLeft = Assert.IsType<EndDayOutcome.CommentsRequired>(await a.Workday.EndAsync(new[]
        {
            new SkipComment(mo, "  Back-to-back   client calls "), new SkipComment(l, "Lunch call with the US team"),
        }));
        Assert.Equal(e, Assert.Single(oneLeft.Breaks).Id);
        var notYet = await a.BreakDayAsync();
        Assert.All(notYet.Breaks.Take(2), s => Assert.Null(s.Record!.Reason));
        Assert.Null(notYet.Breaks[2].Record);

        // All three, keyed by the ids the gate gave (the evening's did not exist yet): saved, the day ends,
        // and the evening's auto-skip carries the id it was announced with.
        var ended = Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(new[]
        {
            new SkipComment(mo, "  Back-to-back   client calls "), new SkipComment(l, "Lunch call with the US team"), new SkipComment(e, "Production issue on the bridge"),
        }));
        Assert.True(ended.Workday!.IsEnded);
        Assert.Empty(ended.Workday.SkipsNeedingComment);
        var saved = await a.BreakDayAsync();
        Assert.Equal(new[] { "Back-to-back client calls", "Lunch call with the US team", "Production issue on the bridge" },
            saved.Breaks.Select(b => b.Record!.Reason));
        Assert.Equal(new[] { mo, l, e }, saved.Breaks.Select(b => b.Record!.Id));
        Assert.All(saved.Breaks, b => Assert.NotNull(b.Record!.CommentedAt));

        // Each waits for the manager, commented, with what a rejection would cost.
        var mine = await a.MineAsync();
        foreach (var id in new[] { e, l, mo })
        {
            var item = Assert.Single(mine, i => i.Id == id);
            Assert.Equal(("BREAK_AUTO_SKIP", "PENDING", false), (item.Category, item.Status, item.NeedsComment));
            Assert.Equal(("MINUS", 1, "−1 min if rejected"), (item.Effect.Mode, item.Effect.Minutes, item.Effect.Text));
            Assert.EndsWith("auto-skipped", item.Title);
        }
        Assert.Equal(3 * 60, (await a.DayAsync()).Focus.PendingMinusSec);
    }

    [Fact]
    public async Task A_break_End_Day_skipped_in_its_open_window_can_still_be_taken_and_then_needs_no_comment()
    {
        if (Skipped()) return;
        var t = DateTimeOffset.UtcNow;
        // The morning break began 3 minutes ago; its window stays open for half an hour.
        var shift = await _env.Admin.CreateShiftAsync("Replace", t, new[]
        {
            new LiveBreak("MORNING", -3, 15, 5, 30),
            new LiveBreak("LUNCH", 70, 30, 10, 10),
            new LiveBreak("EVENING", 150, 15, 10, 10),
        }, ringLeadMin: 0, ringDurationMin: 1);
        var person = await _env.Admin.CreatePersonAsync("Kiran", "Shah");
        await _env.Admin.AssignAsync(shift, person.Id);
        using var a = await LiveAgent.SignInAsync(person);
        await a.StartDayAsync(minutesBack: 9);

        // End Day would auto-skip the owed morning break and asks for its comment first (4.0: nothing
        // is written until it has it); the day carries on and the morning is still open.
        var gate = Assert.IsType<EndDayOutcome.CommentsRequired>(await a.Workday.EndAsync(null));
        var skipped = Assert.Single(gate.Breaks);
        Assert.Equal(("MORNING", BreakOutcomes.AutoSkipped), (skipped.Kind, skipped.Outcome));
        var day = await a.BreakDayAsync();
        Assert.Null(day.Breaks[0].Record);
        var morning = a.Breaks.Panel().Slots[0];
        Assert.Equal((true, (string?)null), (morning.CanStart, morning.PendingAutoSkip?.Id));

        // Taken after all: no auto-skip is ever made, so no comment is owed.
        var started = Assert.IsType<StartOutcome.Started>(await a.Breaks.StartAsync("MORNING", "Client escalation call"));
        Assert.Equal("BREAK", started.PresenceType);
        Assert.Empty((await a.DayAsync()).SkipsNeedingComment);
        Assert.IsType<EndOutcome.Ended>(await a.Breaks.EndAsync(null));
        Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null));
    }

    [Fact]
    public async Task An_auto_skipped_break_takes_one_comment()
    {
        if (Skipped()) return;
        var t = DateTimeOffset.UtcNow;
        var shift = await _env.Admin.CreateShiftAsync("Comment", t, new[]
        {
            new LiveBreak("MORNING", -7, 1, 0, 1),
            new LiveBreak("LUNCH", 60, 30, 20, 30),
            new LiveBreak("EVENING", 150, 15, 20, 20),
        }, ringLeadMin: 0, ringDurationMin: 1);
        var person = await _env.Admin.CreatePersonAsync("Rohan", "Iyer");
        await _env.Admin.AssignAsync(shift, person.Id);
        using var a = await LiveAgent.SignInAsync(person);
        await a.StartDayAsync(minutesBack: 9);

        var day = await a.BreakDayAsync();
        var auto = day.Breaks[0].Record!;
        Assert.Equal((BreakOutcomes.AutoSkipped, true), (auto.Outcome, auto.NeedsComment));
        Assert.Equal(auto.Id, Assert.Single(day.SkipsNeedingComment).Id);
        Assert.Equal(auto.Id, Assert.Single(a.AutoSkips).Id);

        // The server counts a comment with its spaces collapsed: "Too   short" is 9 characters.
        Assert.Equal(10, Assert.IsType<CommentOutcome.NeedsReason>(await a.Breaks.CommentAsync(auto.Id, "  Too   short ")).MinChars);
        Assert.Equal("VALIDATION_ERROR", Assert.IsType<CommentOutcome.Refused>(await a.Breaks.CommentAsync(auto.Id, new string('x', 501))).Code);
        Assert.Equal("NOT_FOUND", Assert.IsType<CommentOutcome.Refused>(await a.Breaks.CommentAsync(Guid.NewGuid().ToString(), "Back-to-back client calls")).Code);

        var saved = Assert.IsType<CommentOutcome.Saved>(await a.Breaks.CommentAsync(auto.Id, " Back-to-back   client calls "));
        Assert.Equal((auto.Id, "Back-to-back client calls", false), (saved.Record!.Id, saved.Record.Reason, saved.Record.NeedsComment));
        Assert.Equal((BreakOutcomes.AutoSkipped, "PENDING"), (saved.Record.Outcome, saved.Record.ApprovalStatus));
        Near(DateTimeOffset.UtcNow, saved.Record.CommentedAt, 15, "commented at");
        Assert.Empty(a.Breaks.Day!.SkipsNeedingComment);   // the service read the day again
        Assert.False(a.Breaks.Day!.Breaks[0].Record!.NeedsComment);

        // Once only.
        Assert.False(string.IsNullOrWhiteSpace(Assert.IsType<CommentOutcome.NotNeeded>(await a.Breaks.CommentAsync(auto.Id, "Changing my mind now")).Message));

        var item = Assert.Single(await a.MineAsync(), i => i.Id == auto.Id);
        Assert.Equal(("BREAK_AUTO_SKIP", "Back-to-back client calls", false), (item.Category, item.Reason, item.NeedsComment));
        Assert.Empty((await a.DayAsync()).SkipsNeedingComment);
        Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null));
    }

    /// <summary>
    /// 4.0: the organisation's Admin is the top of the organisation (a Super Admin belongs to
    /// none, and an Admin is made from Organisations, not People): their skip needs no
    /// approval, and they are never gated. The seeded Admin is the person here.
    /// </summary>
    [Fact]
    public async Task An_Admins_skip_needs_no_approval_and_an_Admin_is_never_gated()
    {
        if (Skipped()) return;
        var t = DateTimeOffset.UtcNow;
        var shift = await _env.Admin.CreateShiftAsync("Admin", t, MorningOpen);
        var person = new LivePerson(_env.Admin.Id, "orgadmin@timechamp.test", "Anita", "Menon");
        await _env.Admin.AssignAsync(shift, person.Id);
        using var a = await LiveAgent.SignInAsync(person, "orgadmin123");
        Assert.Equal("ADMIN", a.User.Role);
        var today = await a.DayAsync();
        if (today.IsEnded || today.IsOpen)
        {
            _out.WriteLine($"skipped: the seeded Admin's day is already {today.State} (run on a fresh database)");
            return;
        }
        await a.StartDayAsync();

        var rec = Assert.IsType<SkipOutcome.Skipped>(await a.Breaks.SkipAsync(BreakKinds.Morning, "Board meeting all morning")).Record!;
        Assert.Equal((BreakOutcomes.Skipped, "NOT_REQUIRED", false), (rec.Outcome, rec.ApprovalStatus, rec.NeedsComment));
        Assert.Null(rec.DueAt);
        var w = await a.DayAsync();
        Assert.Equal((0, 0), (w.Focus.PendingMinusSec, w.Focus.RejectedMinusSec));
        Assert.Empty(w.SkipsNeedingComment);
        Assert.False(w.EndDayBlockedByOverdue);
        Assert.DoesNotContain(await a.MineAsync(), i => i.Id == rec.Id);
        Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null));
    }

    [Fact]
    public async Task On_a_day_off_breaks_are_plain_and_still_pause_focus()
    {
        if (Skipped()) return;
        var t = DateTimeOffset.UtcNow;
        var isoToday = ((int)LiveEnv.BusinessNow.DayOfWeek + 6) % 7 + 1;
        var shift = await _env.Admin.CreateShiftAsync("Off", t, MorningOpen, workDays: Enumerable.Range(1, 7).Where(d => d != isoToday).ToArray());
        var person = await _env.Admin.CreatePersonAsync("Imran", "Sheikh");
        await _env.Admin.AssignAsync(shift, person.Id);
        using var a = await LiveAgent.SignInAsync(person);

        // No schedule today: the plain break and lunch of the older flow.
        var day = await a.BreakDayAsync();
        Assert.Equal(("FREE", false, false), (day.Mode, day.Scheduled, day.Workday));
        Assert.Empty(day.Breaks);
        Assert.False(a.Breaks.Panel().Scheduled);

        await a.StartDayAsync();
        Assert.Equal("BREAK_NOT_SCHEDULED", Assert.IsType<SkipOutcome.Refused>(await a.Breaks.SkipAsync(BreakKinds.Morning, "Client escalation call")).Code);
        var lunch = Assert.IsType<StartOutcome.Started>(await a.Breaks.StartFreeAsync(PresenceStatus.Lunch));
        Assert.Equal(PresenceStatus.Lunch, lunch.PresenceType);
        Assert.Equal(PresenceStatus.Lunch, (await a.Api.GetCurrentPresenceAsync()).Data!.Status);
        var on = await a.DayAsync();
        Assert.False(on.Focus.Running);
        await Task.Delay(1500);
        var back = Assert.IsType<EndOutcome.Ended>(await a.Breaks.EndAsync(null));
        Assert.Null(back.Record);
        Assert.Equal(PresenceStatus.Working, (await a.Api.GetCurrentPresenceAsync()).Data!.Status);
        var w = await a.DayAsync();
        Assert.True(w.Focus.Running);
        Assert.True(w.Focus.BreakSec >= 1, $"breakSec {w.Focus.BreakSec}");
        Assert.InRange(w.Focus.FocusSec - (w.Focus.SpanSec - w.Focus.BreakSec), -1, 1);
        Assert.IsType<EndOutcome.NothingRunning>(await a.Breaks.EndAsync(null));
        Assert.IsType<EndDayOutcome.Ended>(await a.Workday.EndAsync(null));
    }

    // ---- A Manager's End Day and overdue approvals ------------------------------------------

    [Fact]
    public async Task A_manager_cannot_end_the_day_with_an_approval_overdue_until_it_is_decided()
    {
        if (Skipped()) return;
        if (LiveEnv.Db is null)
        {
            _out.WriteLine("skipped: set RXV_IT_DB (the API's local database) to make an approval overdue");
            return;
        }
        await _env.Admin.SendAsync(HttpMethod.Patch, "settings", new { blockManagerEndDayWhenOverdue = true });
        var t = DateTimeOffset.UtcNow;
        var shift = await _env.Admin.CreateShiftAsync("Manager", t, MorningOpen);
        // 4.0: Kiran manages a department of his own; Neha's items go to him.
        var department = await _env.Admin.CreateDepartmentAsync("Payments");
        var kiran = await _env.Admin.CreatePersonAsync("Kiran", "Rao", "MANAGER", department);
        var neha = await _env.Admin.CreatePersonAsync("Neha", "Joshi", "USER", department);
        await _env.Admin.AssignAsync(shift, kiran.Id, neha.Id);
        using var staff = await LiveAgent.SignInAsync(neha);
        using var mgr = await LiveAgent.SignInAsync(kiran);
        Assert.Equal(("MANAGER", true), (mgr.User.Role, mgr.User.IsManager));

        // An item routed to the manager.
        await staff.StartDayAsync();
        var skip = Assert.IsType<SkipOutcome.Skipped>(await staff.Breaks.SkipAsync(BreakKinds.Morning, "Payment run cannot wait")).Record!;
        Assert.Equal(("PENDING", "MANAGER"), (skip.ApprovalStatus, skip.ApproverRole));
        await mgr.StartDayAsync();
        var before = await mgr.DayAsync();
        Assert.Equal((0, false), (before.OverdueApprovals, before.EndDayBlockedByOverdue));

        // Its 48 hours pass (what the 15-minute job then finds).
        var dueText = await LiveEnv.SqlAsync(
            $"update break_records set due_at = (now() at time zone 'utc') - interval '2 hours' where id = '{skip.Id}' " +
            "returning to_char(due_at, 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')");
        var dueAt = DateTimeOffset.Parse(dueText.Split('\n')[0].Trim(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);
        var blocked = await mgr.DayAsync();
        Assert.Equal((1, true), (blocked.OverdueApprovals, blocked.EndDayBlockedByOverdue));

        // End Day is refused with the count and the oldest due time; the day keeps running.
        var refused = Assert.IsType<EndDayOutcome.ApprovalsOverdue>(await mgr.Workday.EndAsync(null));
        Assert.Equal((1, dueAt), (refused.Count, refused.OldestDueAt));
        Assert.Contains("past 48 hours", refused.Message);
        Assert.True((await mgr.DayAsync()).IsOpen);
        var waiting = Assert.Single(await staff.MineAsync(), i => i.Id == skip.Id);
        Assert.True(waiting.Overdue && waiting.IsPending);

        // A Super Admin decides it in the portal; then the manager's End Day goes through.
        var decided = await _env.Admin.ApproveAsync("break", skip.Id, "Fine this once");
        Assert.Equal("APPROVED", decided.GetProperty("status").GetString());
        var free = await mgr.DayAsync();
        Assert.Equal((0, false), (free.OverdueApprovals, free.EndDayBlockedByOverdue));
        var ended = Assert.IsType<EndDayOutcome.Ended>(await mgr.Workday.EndAsync(null));
        Assert.True(ended.Workday!.IsEnded);

        // The person sees the decision and its effect on focus time.
        var item = Assert.Single(await staff.MineAsync(), i => i.Id == skip.Id);
        Assert.Equal(("APPROVED", false, _env.Admin.Name, "Fine this once"), (item.Status, item.IsPending, item.DecidedByName, item.DecisionNote));
        Assert.NotNull(item.DecidedAt);
        Assert.Equal(("NONE", "Counted as focus time"), (item.Effect.Mode, item.Effect.Text));
        Assert.Equal(0, (await staff.DayAsync()).Focus.PendingMinusSec);
        Assert.IsType<EndDayOutcome.Ended>(await staff.Workday.EndAsync(null));
    }
}
