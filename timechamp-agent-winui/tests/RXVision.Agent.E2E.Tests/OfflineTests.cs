using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.E2E.Tests;

/// <summary>
/// A day lived offline (scenario 6): Start Day, a quick break, a meeting, an away answer and
/// End Day with the network gone; the agent restarted from disk; the network back. Every
/// action reaches the server once, at the time it was done; the samples taken offline follow
/// the actions with their own times; the same journal sent again doubles nothing; nothing in
/// the files is readable.
/// </summary>
public sealed class OfflineTests : E2ETest
{
    public OfflineTests(E2EFixture env, ITestOutputHelper output) : base(env, output) { }

    private static string Q(string text) => text.Replace("'", "''", StringComparison.Ordinal);

    [Fact]
    public async Task A_day_done_offline_survives_a_restart_and_reaches_the_server_once_with_its_times()
    {
        if (Skipped()) return;
        var rig = await AgentForAsync("Omar", "Sheikh", beforeSignIn: Env.AwayOnAsync);
        Assert.Equal(AgentState.NotStarted, rig.Host.State);
        var server = await ServerViewAsync(rig.Person);
        var uid = rig.Person.Id;
        var pressed = new Dictionary<string, DateTimeOffset>();

        // ---- Offline: the whole day ----------------------------------------------------------
        rig.Relay.GoOffline();
        pressed["start"] = DateTimeOffset.UtcNow;
        await rig.Ui.RunAsync(() => rig.Dashboard.StartDayCommand.ExecuteAsync(null));
        Assert.Equal(AgentState.Running, rig.Host.State);
        await E2EEnv.WaitFor(() => !rig.Host.Online, TimeSpan.FromSeconds(10), "the agent to see it is offline");
        await Task.Delay(5000);

        rig.Dialogs.Answer(d => { var q = (QuickBreakDialogViewModel)d; q.Pick(q.Choices.Single(c => c.Minutes == 5)); return true; });
        pressed["quick"] = DateTimeOffset.UtcNow;
        await rig.Ui.RunAsync(() => Tap(rig.Dashboard.QuickTile));
        Assert.True(rig.Host.BreakPanel.Active?.IsQuick);
        await Task.Delay(10_000);
        rig.Dialogs.Answer(_ => true);
        pressed["quickEnd"] = DateTimeOffset.UtcNow;
        await rig.Ui.RunAsync(() => rig.Dashboard.EndBreakCommand.ExecuteAsync(null));
        Assert.Null(rig.Host.BreakPanel.Active);
        await Task.Delay(3000);

        rig.Dialogs.Answer(MeetingTests.Fill("Offline planning", "Asha", "Asha Rao"));
        pressed["meeting"] = DateTimeOffset.UtcNow;
        await rig.Ui.RunAsync(() => Tap(rig.Dashboard.MeetingTile));
        Assert.NotNull(rig.Host.LiveMeeting);
        await Task.Delay(65_000);
        pressed["meetingEnd"] = DateTimeOffset.UtcNow;
        await rig.Ui.RunAsync(() => rig.Dashboard.EndMeetingCommand.ExecuteAsync(null));
        Assert.Null(rig.Host.LiveMeeting);

        // Nobody at the keyboard after that: two minutes later the pop-up asks.
        rig.NoInput();
        await E2EEnv.WaitFor(() => rig.Host.AwaySince is not null, TimeSpan.FromMinutes(3), "the away pop-up");
        var awaySince = rig.Host.AwaySince!.Value;
        Near(pressed["meetingEnd"], awaySince, 6, "the away start (the last input, at the meeting's end)");
        var away = await rig.Ui.Run(() => new AwayViewModel(rig.Agent, rig.Log));
        pressed["away"] = DateTimeOffset.UtcNow;
        await rig.Ui.RunAsync(async () =>
        {
            away.Reasons.Single(r => r.Key == "THINKING").PickCommand.Execute(null);
            away.Comment = "Planning the offline sync";
            await away.SubmitCommand.ExecuteAsync(null);
        });
        Assert.True(away.IsDone, away.Error);
        rig.Input();
        await Task.Delay(3000);

        rig.Dialogs.Answer(d => Assert.IsType<MessageDialogViewModel>(d).Title == "End your working day?");
        pressed["end"] = DateTimeOffset.UtcNow;
        await rig.Ui.RunAsync(() => rig.Dashboard.EndDayCommand.ExecuteAsync(null));
        Assert.Equal(AgentState.DayEnded, rig.Host.State);
        Assert.Equal(7, rig.Host.PendingActions);
        await rig.Ui.Run(rig.Dashboard.Refresh);
        Assert.Equal("Offline · 7 actions waiting", rig.Dashboard.SyncText);
        var samples = rig.Host.PendingSamples;
        Say($"offline: 7 actions and {samples} samples waiting");
        Assert.True(samples >= 6, $"samples kept while offline: {samples}");

        // Nothing on disk is readable: the journal, the day, the samples.
        var files = Directory.GetFiles(rig.DataDir).Where(f => Path.GetFileName(f) is var n && (n.StartsWith("journal-") || n.StartsWith("state-") || n.StartsWith("queue-"))).ToList();
        Assert.Equal(3, files.Count);
        foreach (var file in files)
        {
            var text = Encoding.UTF8.GetString(File.ReadAllBytes(file));
            foreach (var secret in new[] { "Offline planning", "Asha Rao", "Planning the offline sync", "START_DAY", "BREAK_QUICK", "momSender", "Visual Studio Code", "AgentHost.cs", rig.Person.Id })
                Assert.False(text.Contains(secret, StringComparison.OrdinalIgnoreCase), $"{Path.GetFileName(file)} shows \"{secret}\"");
        }
        var backup = Directory.CreateTempSubdirectory("rxv-e2e-journal-").FullName;
        foreach (var file in files.Where(f => !Path.GetFileName(f).StartsWith("queue-"))) File.Copy(file, Path.Combine(backup, Path.GetFileName(file)));

        // ---- The agent restarts from disk, still offline --------------------------------------
        await rig.RestartAsync();
        await E2EEnv.WaitFor(() => rig.Host.State == AgentState.DayEnded, TimeSpan.FromSeconds(20), "the restarted agent in its last state");
        Assert.Equal(7, rig.Host.PendingActions);
        Assert.Equal(samples, rig.Host.PendingSamples);
        Assert.Equal(rig.Person.Id, rig.Host.User?.Id);
        await rig.Ui.Run(rig.Dashboard.Refresh);
        Assert.Equal("Offline · 7 actions waiting", rig.Dashboard.SyncText);
        Assert.Equal(0, rig.Http.Calls.Count(c => c.Status == 200));

        // ---- The network comes back ------------------------------------------------------------
        var back = Stopwatch.StartNew();
        rig.Relay.GoOnline();
        await rig.WaitSyncedAsync(TimeSpan.FromMinutes(6));
        Say($"the journal reached the server {back.Elapsed.TotalSeconds:F0} s after the network came back");
        await E2EEnv.WaitFor(() => rig.Host.PendingSamples == 0, TimeSpan.FromMinutes(4), "the samples to be sent");
        Say($"the samples followed {back.Elapsed.TotalSeconds:F0} s after the network came back");
        Assert.Equal(AgentState.DayEnded, rig.Host.State);

        // Every action once, with the time it was done (X-Event-At = the press, give or take the UI).
        var events = rig.Http.Calls.Where(c => c.EventId is not null && c.Status == 200).ToList();
        Assert.Equal(7, events.Count);
        Assert.Equal(7, events.Select(e => e.EventId).Distinct().Count());
        Assert.Equal(Enumerable.Range(1, 7).Select(i => i.ToString(CultureInfo.InvariantCulture)), events.Select(e => e.Seq));
        DateTimeOffset At(string pathEnd) => DateTimeOffset.Parse(events.Single(e => e.Path.EndsWith(pathEnd, StringComparison.Ordinal)).EventAt!, CultureInfo.InvariantCulture);
        var startAt = At("/activity/start-day");
        var quickAt = At("/breaks/quick/start");
        var quickEndAt = At("/breaks/end");
        var meetingAt = At("/meetings/start");
        var meetingEndAt = DateTimeOffset.Parse(events.Single(e => e.Path.Contains("/meetings/", StringComparison.Ordinal) && e.Path.EndsWith("/end", StringComparison.Ordinal)).EventAt!, CultureInfo.InvariantCulture);
        var awayAt = At("/away");
        var endAt = At("/activity/end-day");
        Near(pressed["start"], startAt, 3, "Start Day's time");
        Near(pressed["quick"], quickAt, 3, "the quick break's time");
        Near(pressed["quickEnd"], quickEndAt, 3, "End break's time");
        Near(pressed["meeting"], meetingAt, 3, "the meeting's time");
        Near(pressed["meetingEnd"], meetingEndAt, 3, "Meeting ended's time");
        Near(pressed["away"], awayAt, 3, "the away answer's time");
        Near(pressed["end"], endAt, 3, "End Day's time");

        // The server has each of them once, at those times. SPEC 6: an action that reaches the
        // server less than 30 s after it was done runs at the server's own time (it arrives
        // a few seconds later than it happened); an older one runs at its X-Event-At exactly.
        void ServerTime(Func<Call, bool> which, DateTimeOffset? actual, string what)
        {
            var call = events.Single(which);
            var done = DateTimeOffset.Parse(call.EventAt!, CultureInfo.InvariantCulture);
            var age = call.At - done;
            Assert.True(actual.HasValue, $"{what}: missing on the server");
            if (age > TimeSpan.FromSeconds(32))
            {
                Assert.Equal(done, actual!.Value);
                return;
            }
            Assert.InRange(actual!.Value, done.AddMilliseconds(-500), call.At.AddMilliseconds(500));
            if (age < TimeSpan.FromSeconds(28) && actual.Value != done)
                Say($"{what}: sent {age.TotalSeconds:F1} s after it was done, so the server timed it on arrival, {(actual.Value - done).TotalSeconds:F1} s late");
        }
        Func<Call, bool> Ending(string end) => c => c.Path.EndsWith(end, StringComparison.Ordinal);
        Func<Call, bool> MeetingEnd = c => c.Path.Contains("/meetings/", StringComparison.Ordinal) && c.Path.EndsWith("/end", StringComparison.Ordinal);

        var dayRaw = (await server.GetAsync("workday/me/today")).Data;
        var day = Read<WorkdayToday>(dayRaw);
        Assert.Equal(WorkdayStates.Ended, day.State);
        ServerTime(Ending("/activity/start-day"), day.StartedAt, "Start Day");
        ServerTime(Ending("/activity/end-day"), day.EndedAt, "End Day");
        Assert.Single(day.Sessions);

        // Offline evidence (SPEC 2.4): the day was opened by a replayed Start Day, so it counts
        // only where the agent's samples cover it. They followed the journal, so all of it counts:
        // focus is the whole span less the break and the away time waiting for approval, paid
        // time adds the paid break, and nothing is "Offline, no activity data".
        var f = dayRaw.GetProperty("focus");
        int F(string name) => f.GetProperty(name).GetInt32();
        Say($"server focus {F("focusSec")} s of {F("spanSec")} s (break {F("breakSec")}, away pending {F("awayPendingSec")}), " +
            $"paid {F("paidSec")} s, unverified {F("unverifiedSec")} s");
        Assert.Equal(0, F("unverifiedSec"));
        Assert.Equal(F("spanSec") - F("breakSec") - F("awayPendingSec") - F("awayRejectedSec") - F("awayUnexplainedSec"), F("focusSec"));
        Assert.True(F("focusSec") >= 60, $"focus {F("focusSec")} s");
        Assert.Equal(F("focusSec") + F("paidBreakSec"), F("paidSec"));
        Assert.Equal(day.Focus.PaidSec, F("paidSec"));
        Assert.Equal(day.Focus.UnverifiedSec, F("unverifiedSec"));
        if (await E2EEnv.SqlAsync($"select source from work_sessions where user_id = '{Q(uid)}'") is { } source)
            Assert.Equal("REPLAY", source);

        // The agent read its day again once the samples were with the server: the same numbers,
        // paid time beside the paid breaks, no offline line.
        Assert.Contains(rig.Log.Lines, l => l.Contains("the samples taken offline are with the server", StringComparison.Ordinal));
        await E2EEnv.WaitFor(() => rig.Host.Workday is { Focus.UnverifiedSec: 0, IsEnded: true } w && w.Focus.FocusSec == F("focusSec"),
            TimeSpan.FromSeconds(30), "the agent's day with the samples counted");
        await rig.Ui.Run(rig.Dashboard.Refresh);
        Assert.False(rig.Dashboard.Today.HasUnverified);
        Assert.Equal(Fmt.Focus(F("focusSec")), rig.Dashboard.Today.FocusText);
        Assert.Equal(Fmt.Focus(rig.Host.FocusSec + rig.Host.Allowance.PaidUsedSec), rig.Dashboard.Today.PaidTimeText);
        Assert.InRange(rig.Host.FocusSec + rig.Host.Allowance.PaidUsedSec, F("paidSec") - 2, F("paidSec") + 2);
        Say($"agent: focus {rig.Dashboard.Today.FocusText}, {rig.Dashboard.Today.AllowanceText}, paid time {rig.Dashboard.Today.PaidTimeText}");
        await rig.Ui.RunAsync(() => rig.Dashboard.ShowHistoryCommand.ExecuteAsync(null));
        var history = rig.Dashboard.History;
        Assert.True(history.HasData, history.Problem);
        var todayRow = history.Days.Single(d => d.IsToday);
        Assert.Null(todayRow.UnverifiedText);
        Assert.Equal($"Paid time {Fmt.Focus(F("paidSec"))}", todayRow.PaidText);
        Assert.False(history.HasUnverified);
        Assert.Equal(Fmt.Focus(F("paidSec")), history.Chips.Single(c => c.Label == "Paid time").Value);
        var breaks = (await server.GetAsync("breaks/me/today")).Data;
        var quick = Assert.Single(breaks.GetProperty("quick").EnumerateArray());
        ServerTime(Ending("/breaks/quick/start"), quick.GetProperty("startedAt").GetDateTimeOffset(), "the quick break's start");
        ServerTime(Ending("/breaks/end"), quick.GetProperty("endedAt").GetDateTimeOffset(), "the quick break's end");
        Assert.Equal(5, quick.GetProperty("plannedMin").GetInt32());
        var meeting = Assert.Single((await server.GetAsync("meetings/me/today")).Data.GetProperty("items").EnumerateArray());
        ServerTime(Ending("/meetings/start"), meeting.GetProperty("startedAt").GetDateTimeOffset(), "the meeting's start");
        ServerTime(MeetingEnd, meeting.GetProperty("endedAt").GetDateTimeOffset(), "the meeting's end");
        Assert.Equal("Asha Rao", meeting.GetProperty("momSender").GetString());
        var approvals = (await server.GetAsync("approvals/me?days=1")).Data.GetProperty("items").EnumerateArray().Where(i => i.GetProperty("type").GetString() == "AWAY").ToList();
        var awayItem = Assert.Single(approvals).GetProperty("away");
        ServerTime(Ending("/away"), awayItem.GetProperty("endedAt").GetDateTimeOffset(), "the away answer");
        Near(awaySince, awayItem.GetProperty("startedAt").GetDateTimeOffset(), 1, "the away stretch's start on the server");
        Assert.Equal("Planning the offline sync", awayItem.GetProperty("comment").GetString());

        // Counted in the database too (what no list shows: duplicates).
        async Task<int?> Count(string table, string extra = "") => await E2EEnv.CountAsync($"select count(*) from {table} where user_id = '{Q(uid)}' {extra}");
        var counts = new Dictionary<string, int?>
        {
            ["work_sessions"] = await Count("work_sessions"),
            ["break_records"] = await Count("break_records"),
            ["meeting_records"] = await Count("meeting_records"),
            ["away_events"] = await Count("away_events"),
            ["agent_events"] = await Count("agent_events"),
        };
        Say("rows: " + string.Join(", ", counts.Select(c => $"{c.Key} {c.Value?.ToString(CultureInfo.InvariantCulture) ?? "(no database)"}")));
        if (counts["work_sessions"] is not null)
        {
            Assert.Equal(1, counts["work_sessions"]);
            Assert.Equal(1, counts["break_records"]);
            Assert.Equal(1, counts["meeting_records"]);
            Assert.Equal(1, counts["away_events"]);
            Assert.Equal(7, counts["agent_events"]);
            var stored = await E2EEnv.SqlAsync($"select string_agg(to_char(event_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), ',' order by event_at) from agent_events where user_id = '{Q(uid)}'");
            Assert.Equal(string.Join(",", events.Select(e => e.EventAt)), stored);
        }

        // The samples: sent after every action, oldest first, with the times they were taken.
        var sent = rig.Http.Calls.Where(c => c.Path.EndsWith("/activity/report", StringComparison.Ordinal) && c.Status == 200).ToList();
        Assert.Equal(samples, sent.Count);
        Assert.True(sent.First().At >= events.Last().At, "samples wait for the actions before them");
        var sampleTimes = sent.Select(c => JsonDocument.Parse(c.Body!).RootElement.GetProperty("at").GetString()!).ToList();
        Assert.Equal(sampleTimes.OrderBy(x => x, StringComparer.Ordinal), sampleTimes);
        Assert.True(DateTimeOffset.Parse(sampleTimes[0], CultureInfo.InvariantCulture) >= startAt.AddSeconds(-1), "the first sample is after Start Day");
        Assert.True(DateTimeOffset.Parse(sampleTimes[^1], CultureInfo.InvariantCulture) <= endAt.AddSeconds(31), "the last sample is from before End Day");
        var storedSamples = await Count("activity_samples", $"and at >= '{E2EEnv.Iso(startAt.AddSeconds(-1))}'");
        // They follow the replayed End Day, and the server keeps every one taken up to it (4.0).
        var beforeEnd = sampleTimes.Count(t => DateTimeOffset.Parse(t, CultureInfo.InvariantCulture) <= endAt);
        Say($"samples sent {sent.Count} ({beforeEnd} taken by End Day), kept by the server {storedSamples?.ToString(CultureInfo.InvariantCulture) ?? "(no database)"}");
        if (storedSamples is not null) Assert.Equal(beforeEnd, storedSamples);

        // ---- The same journal once more: nothing doubles ---------------------------------------
        await rig.RestartAsync(() =>
        {
            foreach (var file in Directory.GetFiles(backup)) File.Copy(file, Path.Combine(rig.DataDir, Path.GetFileName(file)), overwrite: true);
        });
        await E2EEnv.WaitFor(() => rig.Host.State is AgentState.DayEnded or AgentState.Running or AgentState.NotStarted, TimeSpan.FromSeconds(20), "the agent with the old journal");
        Assert.Equal(7, rig.Host.PendingActions);
        await rig.WaitSyncedAsync(TimeSpan.FromMinutes(2));
        var replayed = rig.Http.Calls.Where(c => c.EventId is not null).ToList();
        Assert.Equal(events.Select(e => e.EventId), replayed.Where(c => c.Status == 200).Select(c => c.EventId));
        if (counts["work_sessions"] is not null)
        {
            Assert.Equal(1, await Count("work_sessions"));
            Assert.Equal(1, await Count("break_records"));
            Assert.Equal(1, await Count("meeting_records"));
            Assert.Equal(1, await Count("away_events"));
            Assert.Equal(7, await Count("agent_events"));
        }
        await E2EEnv.WaitFor(() => rig.Host.State == AgentState.DayEnded, TimeSpan.FromSeconds(20), "the day read again as ended");
        Directory.Delete(backup, recursive: true);
    }

    /// <summary>
    /// The control (SPEC 2.4): a day lived offline whose activity data never reaches the server
    /// (the sample file deleted while the agent was stopped, as a reset or a tampered folder
    /// leaves it). The replayed Start Day and End Day alone prove nothing: the time is
    /// "Offline, no activity data", not focus and not paid, and the agent says so in Today and
    /// History with what it means.
    /// </summary>
    [Fact]
    public async Task A_replayed_day_without_its_activity_data_is_offline_time_not_focus()
    {
        if (Skipped()) return;
        var rig = await AgentForAsync("Farah", "Khan");
        Assert.Equal(AgentState.NotStarted, rig.Host.State);
        var server = await ServerViewAsync(rig.Person);
        var uid = rig.Person.Id;

        rig.Relay.GoOffline();
        await rig.Ui.RunAsync(() => rig.Dashboard.StartDayCommand.ExecuteAsync(null));
        Assert.Equal(AgentState.Running, rig.Host.State);
        await E2EEnv.WaitFor(() => !rig.Host.Online, TimeSpan.FromSeconds(10), "the agent to see it is offline");
        // Longer than the two minutes a replayed session's own start and end vouch for.
        await Task.Delay(TimeSpan.FromSeconds(200));
        rig.Dialogs.Answer(d => Assert.IsType<MessageDialogViewModel>(d).Title == "End your working day?");
        await rig.Ui.RunAsync(() => rig.Dashboard.EndDayCommand.ExecuteAsync(null));
        Assert.Equal(AgentState.DayEnded, rig.Host.State);
        Assert.Equal(2, rig.Host.PendingActions);
        Assert.True(rig.Host.PendingSamples >= 3, $"samples taken offline: {rig.Host.PendingSamples}");

        // The samples are lost while the agent is stopped; the journal is not.
        await rig.RestartAsync(() =>
        {
            foreach (var file in Directory.GetFiles(rig.DataDir, "queue-*")) File.Delete(file);
        });
        await E2EEnv.WaitFor(() => rig.Host.State == AgentState.DayEnded, TimeSpan.FromSeconds(20), "the restarted agent in its last state");
        Assert.Equal(2, rig.Host.PendingActions);
        Assert.Equal(0, rig.Host.PendingSamples);

        rig.Relay.GoOnline();
        await rig.WaitSyncedAsync(TimeSpan.FromMinutes(4));
        Assert.Equal(0, rig.Http.Count("POST", "/activity/report"));
        if (await E2EEnv.SqlAsync($"select source from work_sessions where user_id = '{Q(uid)}'") is { } source)
            Assert.Equal("REPLAY", source);

        // The server: the whole span is unverified; no focus, no paid time.
        var f = (await server.GetAsync("workday/me/today")).Data.GetProperty("focus");
        int F(string name) => f.GetProperty(name).GetInt32();
        Say($"server: span {F("spanSec")} s, focus {F("focusSec")} s, paid {F("paidSec")} s, unverified {F("unverifiedSec")} s");
        Assert.True(F("spanSec") >= 180, $"span {F("spanSec")} s");
        Assert.Equal(F("spanSec"), F("unverifiedSec"));
        Assert.Equal(0, F("focusSec"));
        Assert.Equal(0, F("paidSec"));

        // The agent: Today and History say so, with why.
        await E2EEnv.WaitFor(() => rig.Host.Workday is { IsEnded: true, Focus.UnverifiedSec: > 0 }, TimeSpan.FromSeconds(30), "the agent's day with its offline time");
        await rig.Ui.Run(rig.Dashboard.Refresh);
        var today = rig.Dashboard.Today;
        Assert.True(today.HasUnverified);
        Assert.Equal(Fmt.SomeDuration(F("unverifiedSec")), today.UnverifiedText);
        Assert.Equal("Time recorded offline counts once the app's activity data for it arrives", TodayViewModel.UnverifiedNote);
        Assert.Equal("0m", today.FocusText);
        Assert.Equal("0m", today.PaidTimeText);
        Say($"agent today: focus {today.FocusText}, paid time {today.PaidTimeText}, offline, no activity data {today.UnverifiedText}");

        await rig.Ui.RunAsync(() => rig.Dashboard.ShowHistoryCommand.ExecuteAsync(null));
        var history = rig.Dashboard.History;
        Assert.True(history.HasData, history.Problem);
        var row = history.Days.Single(d => d.IsToday);
        Assert.Equal($"Offline, no activity data {Fmt.SomeDuration(F("unverifiedSec"))}", row.UnverifiedText);
        Assert.Equal("Paid time 0m", row.PaidText);
        Assert.True(history.HasUnverified);
        Assert.Equal(Fmt.SomeDuration(F("unverifiedSec")), history.UnverifiedText);
        Assert.Equal(TodayViewModel.UnverifiedNote, history.UnverifiedNote);
        Say($"agent history: {row.DateText} {row.StatusText} {row.FocusText} · {row.PaidText} · {row.UnverifiedText}; month offline {history.UnverifiedText}");
    }

    /// <summary>
    /// End Day done offline while a scheduled break's window is still open, untaken. Replayed,
    /// End Day is refused for a comment on the auto-skip it would make (listed with the id it will
    /// get; nothing is written). The agent holds it, asks, and sends End Day again with the comment
    /// keyed by exactly that id, at the time the person ended the day.
    /// </summary>
    [Fact]
    public async Task An_End_Day_done_offline_is_held_for_the_auto_skip_it_makes_then_ends_the_day_at_its_time()
    {
        if (Skipped()) return;
        // The morning break's window is open (it rang from 6 to 1 minutes ago, closes in 25); the day started 20 minutes ago.
        var breaks = new[] { new ShiftBreak("MORNING", -5, 10, 5, 30), new ShiftBreak("LUNCH", 120, 40, 30, 60), new ShiftBreak("EVENING", 240, 20, 10, 10) };
        var rig = await AgentForAsync("Isha", "Varma", breaks, beforeSignIn: p => E2EFixture.StartDayEarlierAsync(p, TimeSpan.FromMinutes(20)));
        Assert.Equal(AgentState.Running, rig.Host.State);
        var server = await ServerViewAsync(rig.Person);
        var held = new List<Core.Workday.HeldEndDay>();
        rig.Agent.EndDayHeld += h => held.Add(h);

        rig.Relay.GoOffline();
        await Task.Delay(TimeSpan.FromSeconds(3));
        rig.Dialogs.Answer(d => d is MessageDialogViewModel);
        var pressed = DateTimeOffset.UtcNow;
        await rig.Ui.RunAsync(() => rig.Dashboard.EndDayCommand.ExecuteAsync(null));
        Assert.Equal(AgentState.DayEnded, rig.Host.State);
        await Task.Delay(TimeSpan.FromSeconds(35));   // so End Day replays at its own time

        rig.Relay.GoOnline();
        await rig.WaitSyncedAsync(TimeSpan.FromMinutes(3));
        await E2EEnv.WaitFor(() => held.Count == 1, TimeSpan.FromSeconds(30), "End Day held for its comments");
        var waiting = held[0];
        Near(pressed, waiting.At, 3, "the held End Day's time");
        var planned = Assert.Single(waiting.Breaks);
        Assert.Equal("MORNING", planned.Kind);
        Say($"held: End Day at {E2EEnv.Clock12(waiting.At)} for {planned.Label} (id {planned.Id}, {planned.Outcome})");
        // Refused before anything was written: the auto-skip does not exist yet, the day is still open.
        var before = (await server.GetAsync("breaks/me/today")).Data.GetProperty("breaks").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "MORNING");
        Assert.Equal(JsonValueKind.Null, before.GetProperty("record").ValueKind);
        Assert.Equal(WorkdayStates.Open, Read<WorkdayToday>((await server.GetAsync("workday/me/today")).Data).State);
        await E2EEnv.WaitFor(() => rig.Host.State == AgentState.Running, TimeSpan.FromSeconds(20), "the agent following the open day");
        await rig.Ui.Run(rig.Dashboard.Refresh);
        Assert.True(rig.Dashboard.HasHeldEndDay);

        // Add comments: the dialog says why, the comment goes keyed by the id the server gave.
        rig.Dialogs.Answer(d =>
        {
            var end = Assert.IsType<EndDayDialogViewModel>(d);
            Assert.StartsWith($"You ended your day at {E2EEnv.Clock12(waiting.At)} while offline.", end.Message);
            Assert.Equal(new[] { planned.Id }, end.Items.Select(i => i.Id));
            end.Items[0].Text = "Client call ran past the break";
            return true;
        });
        await rig.Ui.RunAsync(() => rig.Dashboard.EndDayCommand.ExecuteAsync(null));
        await rig.WaitSyncedAsync(TimeSpan.FromMinutes(1));
        Assert.Null(rig.Host.HeldEndDay);

        var day = Read<WorkdayToday>((await server.GetAsync("workday/me/today")).Data);
        Assert.Equal(WorkdayStates.Ended, day.State);
        Assert.Equal(ApiClient.Iso(waiting.At), ApiClient.Iso(day.EndedAt!.Value));   // to the millisecond, as sent
        var after = (await server.GetAsync("breaks/me/today")).Data.GetProperty("breaks").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "MORNING");
        var record = after.GetProperty("record");
        Assert.Equal(planned.Id, record.GetProperty("id").GetString());
        Assert.Equal("AUTO_SKIPPED", record.GetProperty("outcome").GetString());
        Assert.Equal("Client call ran past the break", record.GetProperty("reason").GetString());
        await E2EEnv.WaitFor(() => rig.Host.State == AgentState.DayEnded, TimeSpan.FromSeconds(20), "the agent with the day ended");
        Say($"ended at {E2EEnv.Clock12(day.EndedAt!.Value)}; {planned.Label} auto-skipped as {record.GetProperty("id").GetString()} with its comment");
    }

    /// <summary>
    /// Two days offline, as the agent sends them (SPEC 6): the journal first (yesterday's Start
    /// Day, never ended, and today's), then the samples, oldest first, through the agent's own
    /// client, queue and tracker. Yesterday's backlog lands although today's day is open, and that
    /// day counts as worked; a replayed yesterday with no samples stays "Offline, no activity data".
    /// </summary>
    [Fact]
    public async Task A_previous_days_backlog_lands_with_todays_day_open_and_one_without_stays_unverified()
    {
        if (Skipped()) return;
        var yesterday = E2EEnv.BusinessNow.Date.AddDays(-1);
        var at = new DateTimeOffset(yesterday.Year, yesterday.Month, yesterday.Day, 10, 0, 0, E2EEnv.BusinessOffset);
        var date = at.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        async Task<(Person Person, ApiClient Api, E2EPlatform Platform)> PersonAsync(string first, string last)
        {
            var person = await PortalSetup.CreateStaffAsync(Env.Admin, first, last, E2EFixture.EngineeringId);
            var platform = new E2EPlatform(Directory.CreateTempSubdirectory("rxv-e2e-days-").FullName);
            var api = new ApiClient(E2EEnv.Api!, new AgentIdentity(Core.Config.AgentOptions.AppVersion, platform.Name, Guid.NewGuid().ToString()),
                new Core.Session.SessionStore(platform.Secrets), new Core.Util.ServerClock(), Core.Util.NullLog.Instance);
            Assert.True((await api.LoginAsync(person.Email, person.Password)).Ok);
            return (person, api, platform);
        }
        async Task<HistoryDay> DayOf(ApiClient api) => (await api.GetHistoryAsync(date[..7])).Data!.Days.Single(d => d.Date == date);
        static string Show(HistoryDay d) => $"status {d.Status}, focus {d.FocusSec} s, paid {d.PaidSec} s, unverified {d.UnverifiedSec} s";

        // With samples: yesterday 10:00 Start Day (no End Day: the server closed it), today's Start Day, then 20 samples.
        var (withSamples, api, platform) = await PersonAsync("Kavya", "Rao");
        using (api)
        {
            Assert.True((await api.SendEventAsync(HttpMethod.Post, "activity/start-day", new StartDayRequest { StartedAt = ApiClient.Iso(at) }, Guid.NewGuid().ToString(), at, 1)).Ok);
            Assert.True((await api.SendEventAsync(HttpMethod.Post, "activity/start-day", new StartDayRequest(), Guid.NewGuid().ToString(), DateTimeOffset.UtcNow, 2)).Ok);
            Assert.Equal(WorkdayStates.Open, (await api.GetWorkdayTodayAsync()).Data!.State);
            var queue = new Core.Activity.ActivityQueue(platform.Secrets, platform.Paths.DataDir, withSamples.Id, Core.Util.NullLog.Instance);
            for (var i = 0; i < 20; i++) queue.Enqueue(new ActivityReport { At = ApiClient.Iso(at.AddMinutes(i).AddSeconds(30)), App = "Visual Studio Code", Title = "Planning notes" });
            var tracker = new Core.Activity.ActivityTracker(api, platform, new Core.Config.AgentOptions().Normalised(), queue, Core.Util.NullLog.Instance);
            Assert.True(await tracker.DrainAsync(Core.Activity.ActivityTracker.DrainPerTick, CancellationToken.None));
            if (await E2EEnv.CountAsync($"select count(*) from activity_samples where user_id = '{Q(withSamples.Id)}' and at < '{E2EEnv.Iso(at.AddHours(1))}'") is { } kept)
                Assert.Equal(20, kept);
            var day = await DayOf(api);
            Say($"{date} with its samples: {Show(day)}");
            Assert.Equal(0, day.UnverifiedSec);
            Assert.InRange(day.FocusSec, 18 * 60, 21 * 60);
            Assert.Equal(day.FocusSec + day.PaidBreakSec, day.PaidSec);
        }

        // Without: yesterday 10:00 to 10:20 replayed, no samples at all.
        var (_, api2, _) = await PersonAsync("Rahul", "Bose");
        using (api2)
        {
            Assert.True((await api2.SendEventAsync(HttpMethod.Post, "activity/start-day", new StartDayRequest { StartedAt = ApiClient.Iso(at) }, Guid.NewGuid().ToString(), at, 1)).Ok);
            Assert.True((await api2.SendEventAsync(HttpMethod.Post, "activity/end-day", new EndDayRequest(), Guid.NewGuid().ToString(), at.AddMinutes(20), 2)).Ok);
            var day = await DayOf(api2);
            Say($"{date} without samples: {Show(day)}");
            Assert.Equal(20 * 60, day.UnverifiedSec);
            Assert.Equal(0, day.FocusSec);
            Assert.Equal(0, day.PaidSec);
        }
    }
}
