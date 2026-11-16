using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.ViewModels.Dialogs;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.E2E.Tests;

/// <summary>Focus work and meetings, the minutes sender required (scenario 3).</summary>
public sealed class MeetingTests : E2ETest
{
    public MeetingTests(E2EFixture env, ITestOutputHelper output) : base(env, output) { }

    /// <summary>Fills the meeting dialog as a person would: agenda, one free name, who mails the minutes.</summary>
    internal static Func<DialogViewModel, bool> Fill(string agenda, string person, string? mom, bool past = false, int minutes = 5)
        => d =>
        {
            var m = Assert.IsType<MeetingDialogViewModel>(d);
            m.IsPast = past;
            m.Agenda = agenda;
            m.PersonQuery = person;
            var add = m.Suggestions.Last(s => s.Person.Name == person);
            add.AddCommand.Execute(null);
            m.MomSender = mom ?? "";
            if (past)
            {
                m.StartAt = m.StartOptions.First();
                m.MinutesText = minutes.ToString(System.Globalization.CultureInfo.InvariantCulture);
            }
            return m.Problem is null;
        };

    [Fact]
    public async Task Focus_work_ends_a_break_and_a_meeting_needs_who_mails_the_minutes()
    {
        if (Skipped()) return;
        // The day started 20 minutes ago on another device, so an earlier meeting fits in it.
        var rig = await AgentForAsync("Neha", "Kapoor", beforeSignIn: p => E2EFixture.StartDayEarlierAsync(p, TimeSpan.FromMinutes(20)));
        var server = await ServerViewAsync(rig.Person);
        Assert.Equal(Core.AgentState.Running, rig.Host.State);

        // Focus work (the tile) during a quick break: End break, confirmed; focus runs again.
        Assert.IsType<ActionOutcome.Done>(await rig.Agent.QuickBreakAsync(10));
        await rig.WaitSyncedAsync();
        Assert.False(Read<WorkdayToday>((await server.GetAsync("workday/me/today")).Data).Focus.Running);
        rig.Dialogs.Answer(d => Assert.IsType<MessageDialogViewModel>(d).Title == "End your quick break now?");
        await rig.Ui.RunAsync(() => Tap(rig.Dashboard.FocusTile));
        Assert.Null(rig.Host.BreakPanel.Active);
        await rig.WaitSyncedAsync();
        Assert.True(Read<WorkdayToday>((await server.GetAsync("workday/me/today")).Data).Focus.Running);

        // The meeting dialog will not send without who mails the minutes...
        rig.Dialogs.Answer(d =>
        {
            Assert.False(Fill("Release planning", "Asha", mom: null)(d));
            Assert.Equal("Add who will mail the minutes.", ((MeetingDialogViewModel)d).Problem);
            return false;   // Cancel
        });
        await rig.Ui.RunAsync(() => Tap(rig.Dashboard.MeetingTile));
        Assert.Null(rig.Host.LiveMeeting);
        // ...nor does the agent itself, and the server refuses a 4.0 agent that tries.
        var invalid = Assert.IsType<MeetingOutcome.Invalid>(await rig.Host.StartMeetingAsync("Release planning", new[] { new MeetingParticipant(null, "Asha") }));
        Assert.Equal("MOM_SENDER_REQUIRED", invalid.Code);
        var refused = await server.PostAsync("meetings/start", new { agenda = "Release planning", participants = new[] { new { name = "Asha" } } });
        Assert.Equal((422, "MOM_SENDER_REQUIRED"), (refused.Status, refused.Code));
        Assert.Equal(0, rig.Http.Count("POST", "/meetings/start"));

        // With the minutes sender: a live meeting, on the server at once with its sender.
        rig.Dialogs.Answer(Fill("Release planning", "Asha", mom: "Asha Rao"));
        var startedAt = DateTimeOffset.UtcNow;
        await rig.Ui.RunAsync(() => Tap(rig.Dashboard.MeetingTile));
        Assert.NotNull(rig.Host.LiveMeeting);
        await rig.WaitSyncedAsync();
        var items = (await server.GetAsync("meetings/me/today")).Data.GetProperty("items");
        var live = items.EnumerateArray().Single(m => m.GetProperty("inProgress").GetBoolean());
        Assert.Equal("Asha Rao", live.GetProperty("momSender").GetString());
        Assert.Equal("Release planning", live.GetProperty("agenda").GetString());
        Assert.Equal(live.GetProperty("id").GetString(), rig.Host.LiveMeeting!.Id);
        await rig.Ui.Run(rig.Dashboard.Refresh);
        Assert.True(rig.Dashboard.IsInMeeting);
        Say($"meeting card: {rig.Dashboard.MeetingStarted} · {rig.Dashboard.MeetingPeopleText} · {rig.Dashboard.MeetingMomText}");
        Assert.Matches(@"\d{1,2}:\d{2} (AM|PM)", rig.Dashboard.MeetingStarted);

        // A quick break is refused while in it; it runs over a minute and is kept.
        Assert.Equal("IN_MEETING", Assert.IsType<ActionOutcome.Refused>(await rig.Agent.QuickBreakAsync(5)).Code);
        await Task.Delay(startedAt.AddSeconds(65) - DateTimeOffset.UtcNow);
        await rig.Ui.RunAsync(() => rig.Dashboard.EndMeetingCommand.ExecuteAsync(null));
        Assert.Null(rig.Host.LiveMeeting);
        await rig.WaitSyncedAsync();
        items = (await server.GetAsync("meetings/me/today")).Data.GetProperty("items");
        var kept = items.EnumerateArray().Single(m => m.GetProperty("id").GetString() == live.GetProperty("id").GetString());
        Assert.False(kept.GetProperty("inProgress").GetBoolean());
        Assert.True(kept.GetProperty("durationSec").GetInt32() >= 60, kept.GetRawText());

        // An earlier meeting, logged from the same dialog (Already happened), 5 minutes.
        rig.Dialogs.Answer(Fill("Client call", "Vikram", mom: "Neha", past: true, minutes: 5));
        await rig.Ui.RunAsync(() => Tap(rig.Dashboard.MeetingTile));
        await rig.WaitSyncedAsync();
        items = (await server.GetAsync("meetings/me/today")).Data.GetProperty("items");
        var past = items.EnumerateArray().Single(m => m.GetProperty("mode").GetString() == "PAST");
        Assert.Equal("Neha", past.GetProperty("momSender").GetString());
        Assert.Equal(300, past.GetProperty("durationSec").GetInt32());
        await rig.Agent.RefreshWorkdayAsync();
        await E2EEnv.WaitFor(() => rig.Host.Day.Meetings.Count == 2, TimeSpan.FromSeconds(10), "both meetings in the agent's day");
        Assert.Equal(items.EnumerateArray().Select(m => m.GetProperty("id").GetString()).OrderBy(x => x),
            rig.Host.Day.Meetings.Select(m => m.Id).OrderBy(x => x));
        Assert.All(rig.Host.Day.Meetings, m => Assert.False(string.IsNullOrEmpty(m.MomSender)));
    }
}
