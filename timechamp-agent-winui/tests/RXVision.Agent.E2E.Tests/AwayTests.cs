using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.ViewModels;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.E2E.Tests;

/// <summary>
/// The away pop-up (scenario 4): every reason the department offers, answered in the
/// pop-up's own view model; the pop-up opening again by itself after the set minutes
/// without input; a manager's decisions reaching the agent (its day and History).
/// Three people in parallel, two answers each, so the waits overlap.
/// </summary>
public sealed class AwayTests : E2ETest
{
    public AwayTests(E2EFixture env, ITestOutputHelper output) : base(env, output) { }

    private sealed record Answered(string Key, DateTimeOffset Since, DateTimeOffset At, string Outcome);

    /// <summary>Waits for the pop-up, answers it as a person would, and says what happened.</summary>
    private async Task<Answered> AnswerAsync(AgentRig rig, string key, Action<AwayViewModel> fill, TimeSpan wait)
    {
        await E2EEnv.WaitFor(() => rig.Host.AwaySince is not null, wait, $"the away pop-up for {rig.Person.FirstName} ({key})");
        var since = rig.Host.AwaySince!.Value;
        var vm = await rig.Ui.Run(() => new AwayViewModel(rig.Agent, rig.Log));
        Assert.Equal($"Away since {E2EEnv.Clock12(since)}", vm.SinceText);
        Assert.Equal(new[] { "BREAK", "THINKING", "MEETING", "HARDWARE", "OTHER", E2EFixture.CustomReasonKey }, vm.Reasons.Select(r => r.Key));
        Assert.Contains(vm.Reasons, r => r.Key == E2EFixture.CustomReasonKey && r.Label == E2EFixture.CustomReasonLabel);
        var at = DateTimeOffset.UtcNow;
        var outcome = await rig.Ui.RunAsync(async () =>
        {
            vm.Reasons.Single(r => r.Key == key).PickCommand.Execute(null);
            fill(vm);
            Assert.Null(vm.Problem());
            await vm.SubmitCommand.ExecuteAsync(null);
            return vm.IsDone ? "recorded" : vm.IsOnBreak ? "on break" : $"error: {vm.Error}";
        });
        Say($"{rig.Person.FirstName}: away since {E2EEnv.Clock12(since)} ({since:HH:mm:ss}Z) answered {key} at {at:HH:mm:ss}Z: {outcome}");
        if (outcome == "on break")
        {
            // The pop-up shows the break; End break asks first, there.
            await Task.Delay(5000);
            await rig.Ui.RunAsync(async () =>
            {
                vm.EndBreakCommand.Execute(null);
                Assert.True(vm.IsConfirmingEnd);
                await vm.ConfirmEndCommand.ExecuteAsync(null);
            });
            Assert.True(vm.IsDone, vm.Error);
        }
        return new Answered(key, since, at, outcome);
    }

    [Fact]
    public async Task Every_reason_is_answered_and_a_managers_decision_reaches_the_agent()
    {
        if (Skipped()) return;
        async Task<AgentRig> PersonAsync(string first, string last)
        {
            var rig = await AgentForAsync(first, last, beforeSignIn: async p =>
            {
                await Env.AwayOnAsync(p);
                await E2EFixture.StartDayEarlierAsync(p, TimeSpan.FromMinutes(30));
            });
            Assert.Equal(Core.AgentState.Running, rig.Host.State);
            Assert.True(rig.Host.IdleConfig!.Enabled);
            Assert.Equal(2, rig.Host.IdleConfig.Minutes);
            return rig;
        }
        var rigs = await Task.WhenAll(PersonAsync("Arjun", "Mehta"), PersonAsync("Lakshmi", "Iyer"), PersonAsync("Rohan", "Das"));
        var (arjun, lakshmi, rohan) = (rigs[0], rigs[1], rigs[2]);

        // Nothing typed for three minutes: the pop-up opens with that start.
        var lastInput = DateTimeOffset.UtcNow.AddMinutes(-3);
        foreach (var rig in rigs) rig.AwayFrom(lastInput);
        foreach (var rig in rigs) Near(lastInput, rig.Host.AwaySince, 1, $"{rig.Person.FirstName}'s away start");

        var first = await Task.WhenAll(
            AnswerAsync(arjun, "BREAK", _ => { }, TimeSpan.FromSeconds(5)),
            AnswerAsync(lakshmi, "MEETING", vm =>
            {
                vm.ParticipantsText = "Ravi, Neha";
                vm.Summary = "Hallway sync on the release";
                vm.MomSender = "Ravi";
            }, TimeSpan.FromSeconds(5)),
            OfflineAnswerAsync(rohan));
        Assert.Equal("on break", first[0].Outcome);
        Assert.Equal("recorded", first[1].Outcome);
        Assert.Equal("recorded", first[2].Outcome);
        foreach (var rig in rigs) await rig.WaitSyncedAsync(TimeSpan.FromSeconds(60));

        // "Took a break" became a quick break from the away start, on the server too.
        var arjunServer = await ServerViewAsync(arjun.Person);
        var arjunQuick = (await arjunServer.GetAsync("breaks/me/today")).Data.GetProperty("quick").EnumerateArray().Single();
        Near(first[0].Since, arjunQuick.GetProperty("startedAt").GetDateTimeOffset(), 1, "the away break's start on the server");
        Assert.NotEqual(JsonValueKind.Null, arjunQuick.GetProperty("endedAt").ValueKind);

        // Nobody touches the keyboard: each pop-up opens again by itself after 2 minutes.
        var second = await Task.WhenAll(
            AnswerAsync(arjun, "THINKING", vm => vm.Comment = "Thinking through the cache design", TimeSpan.FromMinutes(3)),
            AnswerAsync(lakshmi, "HARDWARE", vm => vm.Comment = "Soldering the sensor board", TimeSpan.FromMinutes(3)),
            AnswerAsync(rohan, E2EFixture.CustomReasonKey, vm => vm.Comment = "Visited the client site", TimeSpan.FromMinutes(3)));
        foreach (var rig in rigs) rig.Input();
        foreach (var rig in rigs) await rig.WaitSyncedAsync(TimeSpan.FromSeconds(60));
        // Arjun's second stretch starts where his break ended; the others' where they answered.
        Near(DateTimeOffset.Parse(arjunQuick.GetProperty("endedAt").GetString()!), second[0].Since, 6, "Arjun's second away start");
        Near(first[1].At, second[1].Since, 6, "Lakshmi's second away start");
        Near(first[2].At, second[2].Since, 20, "Rohan's second away start");
        Assert.All(second, a => Assert.Equal("recorded", a.Outcome));

        // Every non-break answer is waiting for the manager, with what was typed.
        var pending = new Dictionary<AgentRig, List<JsonElement>>();
        foreach (var rig in rigs)
        {
            var me = await ServerViewAsync(rig.Person);
            var items = (await me.GetAsync("approvals/me?days=1")).Data.GetProperty("items").EnumerateArray()
                .Where(i => i.GetProperty("type").GetString() == "AWAY").ToList();
            Assert.All(items, i => Assert.Equal("PENDING", i.GetProperty("status").GetString()));
            pending[rig] = items;
            Assert.True(rig.Host.Workday!.Away!.PendingSec >= 0);
        }
        Assert.Single(pending[arjun]);
        Assert.Equal(2, pending[lakshmi].Count);
        Assert.Equal(2, pending[rohan].Count);
        var meeting = pending[lakshmi].Single(i => i.GetProperty("away").GetProperty("reasonKind").GetString() == "MEETING").GetProperty("away");
        Assert.Equal("Ravi", meeting.GetProperty("momSender").GetString());
        Assert.Equal(2, meeting.GetProperty("participants").GetArrayLength());
        Assert.Equal("Hallway sync on the release", meeting.GetProperty("comment").GetString());
        Assert.Contains(pending[rohan], i => i.GetProperty("away").GetProperty("reasonKey").GetString() == E2EFixture.CustomReasonKey
            && i.GetProperty("away").GetProperty("reasonLabel").GetString() == E2EFixture.CustomReasonLabel);

        // Back to back (Rohan's first answer reached the server late and was timed when it
        // arrived): the server starts the next stretch where the earlier one ended, so no answer
        // is refused as an overlap and none is sent twice (the agent's one retry never runs).
        foreach (var rig in rigs)
        {
            Assert.Equal(0, rig.Http.Count("POST", "/away", 409));
            var answers = rig.Http.Calls.Where(c => c.Method == "POST" && c.Path.EndsWith("/away", StringComparison.Ordinal) && c.Status == 200).ToList();
            Assert.Equal(2, answers.Count);
            Assert.Equal(2, answers.Select(c => c.EventId).Distinct().Count());
        }
        var rohanAway = pending[rohan].Select(i => i.GetProperty("away")).OrderBy(a => a.GetProperty("startedAt").GetDateTimeOffset()).ToList();
        Assert.True(rohanAway[1].GetProperty("startedAt").GetDateTimeOffset() >= rohanAway[0].GetProperty("endedAt").GetDateTimeOffset(),
            "Rohan's second away time starts where the first one ended");
        Say($"Rohan on the server: {string.Join(" | ", rohanAway.Select(a => $"{a.GetProperty("startedAt").GetDateTimeOffset():HH:mm:ss}-{a.GetProperty("endedAt").GetDateTimeOffset():HH:mm:ss}"))}");

        // History open on every agent before the decisions.
        foreach (var rig in rigs) await rig.Ui.RunAsync(() => rig.Dashboard.ShowHistoryCommand.ExecuteAsync(null));
        foreach (var rig in rigs)
        {
            Assert.True(rig.Dashboard.History.HasData, $"{rig.Person.FirstName}'s History: {rig.Dashboard.History.Problem}");
            Assert.Null(rig.Dashboard.History.StaleText);
            Assert.Equal(pending[rig].Count, rig.Dashboard.History.Away.Count);
            Assert.All(rig.Dashboard.History.Away, a => Assert.Equal("Pending", a.StatusText));
        }
        var historyEvents = rigs.ToDictionary(r => r, r => r.Events.Count(e => e.EndsWith(":history", StringComparison.Ordinal)));

        // The manager decides: everything approved except Lakshmi's hardware stretch.
        var rejected = pending[lakshmi].Single(i => i.GetProperty("away").GetProperty("reasonKind").GetString() == "HARDWARE").GetProperty("id").GetString()!;
        foreach (var item in pending.Values.SelectMany(x => x))
        {
            var id = item.GetProperty("id").GetString()!;
            var decided = id == rejected
                ? await Env.Manager.PostAsync($"approvals/away/{id}/reject", new { note = "Use a scheduled break for bench work" })
                : await Env.Manager.PostAsync($"approvals/away/{id}/approve", new { note = "ok" });
            Assert.True(decided.Ok, $"decide {id}: {decided}");
        }

        // The agents hear of it (socket), read their day again, and History reloads by itself.
        foreach (var rig in rigs)
        {
            await E2EEnv.WaitFor(() => rig.Host.Workday?.Away?.PendingSec == 0, TimeSpan.FromSeconds(30), $"{rig.Person.FirstName}'s day without pending away time");
            await E2EEnv.WaitFor(() => rig.Events.Count(e => e.EndsWith(":history", StringComparison.Ordinal)) > historyEvents[rig],
                TimeSpan.FromSeconds(30), $"{rig.Person.FirstName}'s History told of the decision");
            await E2EEnv.WaitFor(() => rig.Dashboard.History.Away.Count > 0 && rig.Dashboard.History.Away.All(a => a.StatusText != "Pending"),
                TimeSpan.FromSeconds(30), $"{rig.Person.FirstName}'s History rows decided");
            Say($"{rig.Person.FirstName} History away: {string.Join(" | ", rig.Dashboard.History.Away.Select(a => $"{a.When} {a.Reason} {a.StatusText}"))}");
            Assert.All(rig.Dashboard.History.Away, a => Assert.Matches(@"\d{1,2}:\d{2} (AM|PM)", a.When));
            // The agent's focus time now matches the server's.
            var server = Read<Core.Api.WorkdayToday>((await (await ServerViewAsync(rig.Person)).GetAsync("workday/me/today")).Data);
            Assert.InRange(rig.Host.FocusSec, server.Focus.FocusSec - 5, server.Focus.FocusSec + 5);
        }
        Assert.Contains(lakshmi.Dashboard.History.Away, a => a.StatusText == "Rejected");
        Assert.Contains(lakshmi.Dashboard.History.Away, a => a.StatusText == "Approved");
        Assert.All(rohan.Dashboard.History.Away, a => Assert.Equal("Approved", a.StatusText));
        Assert.Contains(lakshmi.Dashboard.History.Meetings, m => m.Mom == "Minutes: Ravi");
    }

    /// <summary>Rohan answers "Other work" with the network gone; it comes back ten seconds later.</summary>
    private async Task<Answered> OfflineAnswerAsync(AgentRig rohan)
    {
        rohan.Relay.GoOffline();
        try
        {
            var answered = await AnswerAsync(rohan, "OTHER", vm => vm.Comment = "Rack cabling in the lab", TimeSpan.FromSeconds(5));
            Assert.Equal(1, rohan.Host.PendingActions);
            await Task.Delay(10_000);
            return answered;
        }
        finally
        {
            rohan.Relay.GoOnline();
        }
    }
}
