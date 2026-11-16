using System.Text.Json;
using System.Text.RegularExpressions;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.ViewModels.Dialogs;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.E2E.Tests;

/// <summary>Quick breaks, a scheduled break with pause and resume, and the refusals (scenario 2).</summary>
public sealed class BreakTests : E2ETest
{
    public BreakTests(E2EFixture env, ITestOutputHelper output) : base(env, output) { }

    private static readonly Regex Time12 = new(@"\b\d{1,2}:\d{2} (AM|PM)\b");

    private static async Task<JsonElement> BreaksAsync(Portal server) => (await server.GetAsync("breaks/me/today")).Data;

    [Fact]
    public async Task Quick_breaks_of_5_10_and_15_minutes_start_and_end_once_confirmed()
    {
        if (Skipped()) return;
        var rig = await AgentForAsync("Kiran", "Rao");
        var server = await ServerViewAsync(rig.Person);
        Assert.IsType<StartDayOutcome.Started>(await rig.Agent.StartDayAsync());
        await rig.WaitSyncedAsync();

        var ids = new List<string>();
        foreach (var minutes in new[] { 5, 10, 15 })
        {
            // The Quick break tile: pick the length, it starts.
            rig.Dialogs.Answer(d =>
            {
                var q = Assert.IsType<QuickBreakDialogViewModel>(d);
                Assert.Equal(new[] { 5, 10, 15 }, q.Choices.Select(c => c.Minutes));
                q.Pick(q.Choices.Single(c => c.Minutes == minutes));
                return true;
            });
            await rig.Ui.RunAsync(() => Tap(rig.Dashboard.QuickTile));
            var active = rig.Host.BreakPanel.Active;
            Assert.NotNull(active);
            Assert.True(active!.IsQuick);
            await rig.WaitSyncedAsync();

            // On the server at once, with the planned length.
            var day = await BreaksAsync(server);
            var running = day.GetProperty("active");
            Assert.Equal("QUICK", running.GetProperty("kind").GetString());
            Assert.Equal(minutes, running.GetProperty("plannedMin").GetInt32());
            var id = running.GetProperty("id").GetString()!;
            ids.Add(id);
            Assert.Equal(id, rig.Host.BreakPanel.Active!.Id);

            // End break asks first; "Stay on break" keeps it running.
            rig.Dialogs.Answer(d =>
            {
                var m = Assert.IsType<MessageDialogViewModel>(d);
                Assert.Equal("End your quick break now?", m.Title);
                Assert.Contains("left", m.Message);
                return false;
            });
            await rig.Ui.RunAsync(() => rig.Dashboard.EndBreakCommand.ExecuteAsync(null));
            Assert.NotNull(rig.Host.BreakPanel.Active);
            Assert.Equal(id, (await BreaksAsync(server)).GetProperty("active").GetProperty("id").GetString());

            // Confirmed: it ends here and there.
            rig.Dialogs.Answer(_ => true);
            await rig.Ui.RunAsync(() => rig.Dashboard.EndBreakCommand.ExecuteAsync(null));
            Assert.Null(rig.Host.BreakPanel.Active);
            await rig.WaitSyncedAsync();
            day = await BreaksAsync(server);
            Assert.Equal(JsonValueKind.Null, day.GetProperty("active").ValueKind);
            var ended = day.GetProperty("quick").EnumerateArray().Single(q => q.GetProperty("id").GetString() == id);
            Assert.NotEqual(JsonValueKind.Null, ended.GetProperty("endedAt").ValueKind);
        }

        // The agent's day, read again, has the three quick breaks the server has.
        await rig.Agent.RefreshWorkdayAsync();
        await E2EEnv.WaitFor(() => rig.Host.BreakDay!.Quick.Count == 3, TimeSpan.FromSeconds(10), "three quick breaks in the agent's day");
        Assert.Equal(ids.OrderBy(x => x), rig.Host.BreakDay!.Quick.Select(q => q.Id).OrderBy(x => x));
        Assert.Equal(new[] { 5, 10, 15 }, rig.Host.BreakDay.Quick.OrderBy(q => q.StartedAt).Select(q => q.PlannedMin ?? 0));
        // The allowance as the agent works it out matches the server's.
        var allowance = rig.Host.Allowance;
        var serverAllowance = Read<WorkdayToday>((await server.GetAsync("workday/me/today")).Data).Allowance!;
        Say($"allowance after three quick breaks: agent paid {allowance.PaidUsedSec} s + buffer {allowance.BufferUsedSec} s, unpaid {allowance.UnpaidSec} s; " +
            $"server paid {serverAllowance.PaidUsedSec} s + buffer {serverAllowance.BufferUsedSec} s, unpaid {serverAllowance.UnpaidSec} s");
        Assert.Equal(serverAllowance.TotalSec, allowance.TotalSec);
        Assert.InRange(allowance.PaidUsedSec + allowance.BufferUsedSec, serverAllowance.PaidUsedSec + serverAllowance.BufferUsedSec - 2,
            serverAllowance.PaidUsedSec + serverAllowance.BufferUsedSec + 2);
    }

    [Fact]
    public async Task A_scheduled_break_pauses_and_resumes_inside_its_window_and_ends()
    {
        if (Skipped()) return;
        var rig = await AgentForAsync("Divya", "Menon");
        var server = await ServerViewAsync(rig.Person);
        Assert.IsType<StartDayOutcome.Started>(await rig.Agent.StartDayAsync());

        // Next break tile: lunch is open; start it (on time: one confirmation).
        rig.Dialogs.Answer(d =>
        {
            var m = Assert.IsType<MessageDialogViewModel>(d);
            Assert.Equal("Start lunch break?", m.Title);
            Assert.Matches(Time12, m.Message);   // "Back by 4:20 AM"
            return true;
        });
        await rig.Ui.RunAsync(() => Tap(rig.Dashboard.NextTile));
        var active = rig.Host.BreakPanel.Active;
        Assert.NotNull(active);
        Assert.Equal(BreakKinds.Lunch, active!.Kind);
        Assert.True(active.CanPause);
        await rig.WaitSyncedAsync();
        var lunchId = (await BreaksAsync(server)).GetProperty("activeBreak").GetProperty("id").GetString()!;
        Assert.Equal(lunchId, rig.Host.BreakPanel.Active!.Id);

        // A quick break while on lunch is refused here, before anything is sent.
        var onBreak = Assert.IsType<ActionOutcome.Refused>(await rig.Agent.QuickBreakAsync(5));
        Assert.Equal("ON_BREAK", onBreak.Code);

        // Pause: focus starts again; the server has it paused, resumable until the window closes.
        await Task.Delay(1500);
        await rig.Ui.RunAsync(() => rig.Dashboard.PauseBreakCommand.ExecuteAsync(null));
        Assert.Null(rig.Host.BreakPanel.Active);
        Assert.NotNull(rig.Host.BreakPanel.Paused);
        await rig.WaitSyncedAsync();
        var day = await BreaksAsync(server);
        Assert.Equal(lunchId, day.GetProperty("pausedBreak").GetProperty("id").GetString());
        var slot = day.GetProperty("breaks").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "LUNCH");
        Assert.Equal("PAUSED", slot.GetProperty("state").GetString());
        Assert.True(slot.GetProperty("canResume").GetBoolean());
        Assert.Equal(slot.GetProperty("resumeUntil").GetDateTimeOffset(), rig.Host.BreakPanel.Paused!.WindowClose);

        // While paused a quick break may run (focus restarted); resuming then is refused until it ends.
        await Task.Delay(1500);
        Assert.IsType<ActionOutcome.Done>(await rig.Agent.QuickBreakAsync(5));
        var resumeOnBreak = Assert.IsType<ActionOutcome.Refused>(await rig.Agent.ResumeBreakAsync());
        Assert.Equal("ON_BREAK", resumeOnBreak.Code);
        Assert.IsType<EndOutcome.Ended>(await rig.Agent.BackToWorkAsync());
        await rig.WaitSyncedAsync();

        // Resume (the Next break tile resumes a paused break): two segments.
        await Task.Delay(1500);
        await rig.Ui.RunAsync(() => Tap(rig.Dashboard.NextTile));
        Assert.Equal(lunchId, rig.Host.BreakPanel.Active?.Id);
        await rig.WaitSyncedAsync();
        day = await BreaksAsync(server);
        Assert.Equal(lunchId, day.GetProperty("activeBreak").GetProperty("id").GetString());
        Assert.Equal(2, day.GetProperty("activeBreak").GetProperty("segments").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, day.GetProperty("pausedBreak").ValueKind);

        // End break, confirmed.
        await Task.Delay(1500);
        rig.Dialogs.Answer(d =>
        {
            var m = Assert.IsType<MessageDialogViewModel>(d);
            Assert.Equal("End your lunch break now?", m.Title);
            return true;
        });
        await rig.Ui.RunAsync(() => rig.Dashboard.EndBreakCommand.ExecuteAsync(null));
        Assert.Null(rig.Host.BreakPanel.Active);
        await rig.WaitSyncedAsync();
        day = await BreaksAsync(server);
        var lunch = day.GetProperty("breaks").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "LUNCH");
        Assert.Equal("ENDED", lunch.GetProperty("state").GetString());
        Assert.True(lunch.GetProperty("takenSec").GetInt32() >= 3, lunch.GetRawText());
        // The agent's own slot agrees once it reads the day again.
        await rig.Agent.RefreshWorkdayAsync();
        await E2EEnv.WaitFor(() => rig.Host.BreakPanel.Slots.Single(s => s.Kind == BreakKinds.Lunch).State == SlotState.Taken,
            TimeSpan.FromSeconds(10), "lunch taken in the agent's panel");
        Assert.Equal(2, rig.Host.BreakDay!.Breaks.Single(s => s.Kind == BreakKinds.Lunch).Segments.Count);
    }

    [Fact]
    public async Task Refusals_from_the_server_and_from_the_agent_come_back_typed()
    {
        if (Skipped()) return;
        var rig = await AgentForAsync("Farhan", "Ali");
        var server = await ServerViewAsync(rig.Person);
        Assert.IsType<StartDayOutcome.Started>(await rig.Agent.StartDayAsync());
        await rig.WaitSyncedAsync();

        // A quick break cannot pause: the agent says so, and the server agrees.
        Assert.IsType<ActionOutcome.Done>(await rig.Agent.QuickBreakAsync(5));
        await rig.WaitSyncedAsync();
        var notPausable = Assert.IsType<ActionOutcome.Refused>(await rig.Agent.PauseBreakAsync());
        Assert.Equal("NOT_PAUSABLE", notPausable.Code);
        rig.Dialogs.Answer(_ => false);
        await rig.Ui.RunAsync(rig.Actions.PauseAsync);
        Assert.Equal("This break can't pause", rig.Dialogs.Last<MessageDialogViewModel>()!.Title);
        var quickId = rig.Host.BreakPanel.Active!.Id!;
        var serverPause = await server.PostAsync($"breaks/{quickId}/pause");
        Assert.Equal((409, "NOT_PAUSABLE"), (serverPause.Status, serverPause.Code));
        Assert.IsType<EndOutcome.Ended>(await rig.Agent.BackToWorkAsync());
        await rig.WaitSyncedAsync();

        // The server refuses what the agent could not know: a break started on another device.
        var elsewhere = await server.PostAsync("breaks/quick/start", new { plannedMin = 10 });
        Assert.True(elsewhere.Ok, elsewhere.ToString());
        Assert.Null(rig.Host.BreakPanel.Active);   // not known here yet
        rig.Dialogs.Answer(d => { ((QuickBreakDialogViewModel)d).Pick(((QuickBreakDialogViewModel)d).Choices[0]); return true; });
        rig.Dialogs.Answer(_ => true);   // the alert
        await rig.Ui.RunAsync(rig.Actions.QuickBreakAsync);
        var alert = rig.Dialogs.Last<MessageDialogViewModel>()!;
        Assert.Equal("Couldn't start your quick break", alert.Title);
        Say($"server refusal shown: {alert.Message}");
        Assert.False(string.IsNullOrWhiteSpace(alert.Message));
        // Nothing waits, and the agent reads the day again: the other device's break shows here.
        Assert.Equal(0, rig.Host.PendingActions);
        await E2EEnv.WaitFor(() => rig.Host.BreakPanel.Active?.Id == elsewhere.Data.GetProperty("record").GetProperty("id").GetString(),
            TimeSpan.FromSeconds(15), "the other device's quick break in the agent");
        Assert.Equal(1, rig.Http.Count("POST", "/breaks/quick/start", 409));
        Assert.IsType<EndOutcome.Ended>(await rig.Agent.BackToWorkAsync());
        await rig.WaitSyncedAsync();
    }

    [Fact]
    public async Task A_paused_break_cannot_resume_after_its_window_closes()
    {
        if (Skipped()) return;
        // Morning started a minute ago, its window closes within the next two minutes.
        var rig = await AgentForAsync("Sneha", "Pillai", new[]
        {
            new ShiftBreak("MORNING", -1, 15, 5, 2),
            new ShiftBreak("LUNCH", 90, 30, 10, 10),
            new ShiftBreak("EVENING", 180, 15, 10, 10),
        }, ringDurationMin: 1);
        var server = await ServerViewAsync(rig.Person);
        Assert.IsType<StartDayOutcome.Started>(await rig.Agent.StartDayAsync());
        Assert.IsType<StartOutcome.Started>(await rig.Agent.TakeBreakAsync(BreakKinds.Morning, null));
        await Task.Delay(1200);
        Assert.IsType<ActionOutcome.Done>(await rig.Agent.PauseBreakAsync());
        await rig.WaitSyncedAsync();
        var paused = rig.Host.BreakPanel.Paused!;
        var morningId = paused.Record!.Id;
        Say($"morning window closes at {E2EEnv.Clock12(paused.WindowClose)} ({paused.WindowClose:HH:mm:ss}Z)");
        var wait = paused.WindowClose - DateTimeOffset.UtcNow + TimeSpan.FromSeconds(2);
        Assert.True(wait < TimeSpan.FromMinutes(3), $"window closes in {wait}");
        if (wait > TimeSpan.Zero) await Task.Delay(wait);

        // The agent refuses with the window's close in 12-hour time; the server agrees.
        var refused = Assert.IsType<ActionOutcome.Refused>(await rig.Agent.ResumeBreakAsync());
        Assert.Equal("RESUME_WINDOW_CLOSED", refused.Code);
        Assert.Matches(Time12, refused.Message);
        Say($"agent: {refused.Message}");
        var serverResume = await server.PostAsync($"breaks/{morningId}/resume");
        Say($"server resume after the window: {serverResume}");
        Assert.Equal(409, serverResume.Status);
        Assert.True(serverResume.Code is "RESUME_WINDOW_CLOSED" or "NOT_PAUSED", serverResume.ToString());

        // What the panel shows for it now, and the server's slot.
        await rig.Agent.RefreshWorkdayAsync();
        var slot = (await BreaksAsync(server)).GetProperty("breaks").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "MORNING");
        Say($"server morning slot after its window: state {slot.GetProperty("state").GetString()}, canResume {slot.GetProperty("canResume").GetBoolean()}");
        var mine = rig.Host.BreakPanel.Slots.Single(s => s.Kind == BreakKinds.Morning);
        Say($"agent morning slot: {mine.State}, paused panel {(rig.Host.BreakPanel.Paused is null ? "none" : "still shown")}");
        Assert.False(slot.GetProperty("canResume").GetBoolean());
    }
}
