using System.Text.Json;
using System.Text.RegularExpressions;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Offline;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.E2E.Tests;

/// <summary>
/// Sign in, Start Day and the dashboard against the real server (scenario 1), the 4.0
/// User-Agent (scenario 8), and every server behaviour the agent relies on.
/// </summary>
public sealed class DayTests : E2ETest
{
    public DayTests(E2EFixture env, ITestOutputHelper output) : base(env, output) { }

    private static readonly Regex Time12 = new(@"\b\d{1,2}:\d{2} (AM|PM)\b");

    /// <summary>
    /// The person's row on the portal's Team page once it shows <paramref name="version"/>. The
    /// server keeps the Team list for 15 seconds, so a person just added (or just signed in)
    /// shows within that; asked again until then.
    /// </summary>
    private async Task<JsonElement> TeamRowAsync(Person person, string version)
    {
        var until = DateTime.UtcNow.AddSeconds(25);
        while (true)
        {
            var team = await Env.Admin.MustAsync(HttpMethod.Get, $"team?view=all&q={Uri.EscapeDataString(person.Email)}");
            var rows = team.GetProperty("people").EnumerateArray().Where(p => p.GetProperty("id").GetString() == person.Id).ToList();
            if (rows.Count == 1 && rows[0].TryGetProperty("agentVersion", out var v) && v.ValueKind == JsonValueKind.String && v.GetString() == version)
                return rows[0];
            Assert.True(DateTime.UtcNow < until, $"the Team page did not list {person.FirstName} with agent {version} within 25 s: {team.GetRawText()}");
            await Task.Delay(1000);
        }
    }

    [Fact]
    public async Task Sign_in_and_Start_Day_show_what_the_server_has()
    {
        if (Skipped()) return;
        var rig = await AgentForAsync("Asha", "Iyer");
        var server = await ServerViewAsync(rig.Person);

        // Signed in, the day not started: the agent shows the server's day.
        Assert.Equal(AgentState.NotStarted, rig.Host.State);
        var before = Read<WorkdayToday>((await server.GetAsync("workday/me/today")).Data);
        Assert.Equal(WorkdayStates.NotStarted, before.State);
        Assert.Equal(before.State, rig.Host.Workday!.State);
        Assert.Equal(before.Date, rig.Host.Workday.Date);
        await rig.Ui.Run(rig.Dashboard.Refresh);
        Assert.True(rig.Dashboard.IsNotStarted);
        Assert.Null(rig.Dashboard.DayStartedText);

        // Start Day from the dashboard: at once, then on the server with its time.
        var pressed = DateTimeOffset.UtcNow;
        await rig.Ui.RunAsync(() => rig.Dashboard.StartDayCommand.ExecuteAsync(null));
        Assert.Equal(AgentState.Running, rig.Host.State);
        await rig.WaitSyncedAsync();
        await rig.Agent.RefreshWorkdayAsync();

        var todayAnswer = await server.GetAsync("workday/me/today");
        var raw = todayAnswer.Data;
        var w = Read<WorkdayToday>(raw);
        var mine = rig.Host.Workday!;
        Assert.Equal(WorkdayStates.Open, w.State);
        Assert.Equal(w.State, mine.State);
        Near(pressed, w.StartedAt, 5, "the server's Start Day time");
        Assert.Equal(w.StartedAt, mine.StartedAt);
        Assert.Equal(w.Shift?.Id, mine.Shift?.Id);

        // 4.0 fields of GET /workday/me/today the agent reads.
        foreach (var name in new[] { "config", "allowance", "targetSec", "isWorkingDay", "dayLabel", "away" })
            Assert.True(raw.TryGetProperty(name, out _), $"workday/me/today has no {name}");
        Assert.True(raw.GetProperty("config").TryGetProperty("idle", out _), "workday/me/today has no config.idle");
        Assert.Equal(w.TargetSec, mine.TargetSec);
        Assert.True(w.TargetSec > 0, "a working day has a target");
        Assert.Equal(w.IsWorkingDay, mine.IsWorkingDay);
        Assert.True(mine.IsWorkingDay);
        Assert.Equal(w.DayLabel, mine.DayLabel);
        Assert.NotNull(mine.Allowance);
        Assert.Equal(w.Allowance!.TotalSec, mine.Allowance!.TotalSec);
        Assert.Equal(w.Allowance.ScheduledSec, mine.Allowance.ScheduledSec);
        Assert.Equal(w.Allowance.BufferSec, mine.Allowance.BufferSec);
        Assert.Equal((20 + 40 + 20) * 60, mine.Allowance.ScheduledSec);
        Assert.NotNull(mine.Away);
        Assert.Equal(0, mine.Away!.PendingSec);
        Assert.NotNull(mine.Config);
        Assert.Equal(new[] { 5, 10, 15 }, mine.Config!.QuickBreakMinutes);
        Assert.Equal(w.Config!.BreakBufferMin, mine.Config.BreakBufferMin);
        // The department's away reasons (the Admin added HARDWARE and a custom one); tracking off.
        Assert.False(mine.Config.Idle.Enabled);
        Assert.Equal(2, mine.Config.Idle.Minutes);
        Assert.Equal(w.Config.Idle.Reasons.Select(r => r.Key), mine.Config.Idle.Reasons.Select(r => r.Key));
        Assert.Contains(mine.Config.Idle.Reasons, r => r.Key == "HARDWARE" && r.Kind == "HARDWARE");
        Assert.Contains(mine.Config.Idle.Reasons, r => r.Key == E2EFixture.CustomReasonKey && r.Kind == "CUSTOM" && r.Label == E2EFixture.CustomReasonLabel);
        Assert.Equal(rig.Host.IdleConfig!.Reasons.Count, mine.Config.Idle.Reasons.Count);

        // GET /breaks/me/today as the agent has it.
        var breaksRaw = (await server.GetAsync("breaks/me/today")).Data;
        foreach (var name in new[] { "activeBreak", "pausedBreak", "quick", "breaks" })
            Assert.True(breaksRaw.TryGetProperty(name, out _), $"breaks/me/today has no {name}");
        foreach (var slot in breaksRaw.GetProperty("breaks").EnumerateArray())
        {
            Assert.True(slot.TryGetProperty("state", out _), "a slot has no state");
            Assert.True(slot.TryGetProperty("segments", out _), "a slot has no segments");
        }
        var b = Read<BreakDay>(breaksRaw);
        var myBreaks = rig.Host.BreakDay!;
        Assert.Equal(b.Date, myBreaks.Date);
        Assert.Equal("SCHEDULED", myBreaks.Mode);
        Assert.Equal(b.Breaks.Select(s => (s.Kind, s.WindowOpen, s.WindowClose)), myBreaks.Breaks.Select(s => (s.Kind, s.WindowOpen, s.WindowClose)));
        Assert.Null(myBreaks.ActiveBreak);
        Assert.Null(myBreaks.PausedBreak);
        Assert.Empty(myBreaks.Quick);

        // The dashboard: started at (12-hour), the tiles, the allowance.
        await rig.Ui.Run(rig.Dashboard.Refresh);
        Assert.True(rig.Dashboard.IsRunning);
        Assert.Equal($"Day started {E2EEnv.Clock12(w.StartedAt!.Value)}", rig.Dashboard.DayStartedText);
        Assert.Matches(Time12, rig.Dashboard.DayStartedText!);
        Assert.True(rig.Dashboard.ShowTiles);
        Assert.True(rig.Dashboard.QuickTile.CanClick, "Quick break can be taken");
        Assert.True(rig.Dashboard.MeetingTile.CanClick, "a meeting can start");
        Say($"dashboard: {rig.Dashboard.StatusText} · {rig.Dashboard.DayStartedText} · sync {rig.Dashboard.SyncText}");

        // 4.0 focus fields: paid time (focus + paid breaks); a live day has no unverified time.
        var focusRaw = raw.GetProperty("focus");
        foreach (var name in new[] { "paidSec", "unverifiedSec", "paidBreakSec", "unpaidBreakSec" })
            Assert.True(focusRaw.TryGetProperty(name, out _), $"workday/me/today focus has no {name}");
        Assert.Equal(0, w.Focus.UnverifiedSec);
        Assert.Equal(w.Focus.FocusSec + w.Focus.PaidBreakSec, w.Focus.PaidSec);
        Assert.True(rig.Dashboard.Today.HasPaidTime);
        Assert.False(rig.Dashboard.Today.HasUnverified);
        Assert.Equal(Services.Fmt.Focus(rig.Host.FocusSec + rig.Host.Allowance.PaidUsedSec), rig.Dashboard.Today.PaidTimeText);
        Assert.StartsWith("Paid breaks 0 m of ", rig.Dashboard.Today.AllowanceText);

        // The portal's Team page shows the version this agent's session named (its User-Agent).
        Assert.Equal("4.0.0", (await TeamRowAsync(rig.Person, "4.0.0")).GetProperty("agentVersion").GetString());

        // Scenario 8: every call said it is a 4.0 agent; the action carried its event headers.
        var calls = rig.Http.Calls;
        Assert.NotEmpty(calls);
        Assert.All(calls, c => Assert.Equal(AgentUserAgent, c.UserAgent));
        var start = Assert.Single(calls, c => c.Method == "POST" && c.Path.EndsWith("/activity/start-day", StringComparison.Ordinal));
        Assert.Equal(200, start.Status);
        Assert.True(Guid.TryParse(start.EventId, out _), "X-Client-Event-Id is a uuid");
        Assert.NotNull(start.EventAt);
        Assert.Equal("1", start.Seq);
    }

    [Fact]
    public async Task The_server_treats_the_agents_User_Agent_as_a_4_0_agent()
    {
        if (Skipped()) return;
        var rig = await AgentForAsync("Ravi", "Kumar");
        Assert.IsType<StartDayOutcome.Started>(await rig.Agent.StartDayAsync());
        await rig.WaitSyncedAsync();

        // The agent's own client (the identity the app builds), so the header is the app's.
        var platform = new E2EPlatform(Directory.CreateTempSubdirectory("rxv-e2e-ua-").FullName);
        using var api = new ApiClient(E2EEnv.Api!, new AgentIdentity(AgentOptions.AppVersion, platform.Name, Guid.NewGuid().ToString()),
            new SessionStore(platform.Secrets), new ServerClock(), rig.Log);
        Assert.Equal("4.0.0", AgentOptions.AppVersion);
        Assert.True((await api.LoginAsync(rig.Person.Email, rig.Person.Password)).Ok);

        // A 3.x agent may start a meeting without a minutes sender; a 4.0 agent may not.
        var meeting = await api.StartMeetingAsync("Standup", new[] { new MeetingParticipant(null, "Neha") }, momSender: null);
        Assert.Equal(ApiOutcome.Rejected, meeting.Outcome);
        Assert.Equal(422, meeting.Status);
        Assert.Equal("MOM_SENDER_REQUIRED", meeting.Code);

        // The portal's Team page shows the agent version the server took from the session's User-Agent.
        var row = await TeamRowAsync(rig.Person, "4.0.0");
        Say($"team row: {row.GetRawText()}");
        Assert.Equal("4.0.0", row.GetProperty("agentVersion").GetString());

        // A 3.1 client on the same server is not asked (the difference is only the User-Agent).
        using var old = await Portal.SignInAsync(rig.Person.Email, rig.Person.Password, "RXVisionAgent/3.1.0 (windows)");
        var oldMeeting = await old.PostAsync("meetings/start", new { agenda = "Old agent sync", participants = Array.Empty<object>() });
        Assert.True(oldMeeting.Ok, $"3.1 meeting without MoM: {oldMeeting}");
        var oldId = oldMeeting.Data.GetProperty("meeting").GetProperty("id").GetString();
        await old.PostAsync($"meetings/{oldId}/end");
    }

    /// <summary>
    /// The answers the agent's sender and day model depend on (SPEC 5.6), as a 4.0 agent
    /// sends them (X-Client-Event-Id, X-Event-At, X-Client-Seq): the id of what each action
    /// created, read the way <see cref="EventRequests.CreatedId"/> reads it, and the GETs
    /// showing the action at once.
    /// </summary>
    [Fact]
    public async Task Server_behaviour_the_agent_relies_on()
    {
        if (Skipped()) return;
        var person = await PortalSetup.CreateStaffAsync(Env.Admin, "Meera", "Nair", E2EFixture.EngineeringId);
        await PortalSetup.ShiftAsync(Env.Admin, "Meera", PortalSetup.LunchOpen, person.Id);
        await Env.AwayOnAsync(person);
        await E2EFixture.StartDayEarlierAsync(person, TimeSpan.FromMinutes(30));
        var device = await ServerViewAsync(person);
        var seq = 100;
        Task<Answer> Send(string path, object body) => device.PostAsync(path, body, new Dictionary<string, string>
        {
            ["X-Client-Event-Id"] = Guid.NewGuid().ToString(),
            ["X-Event-At"] = E2EEnv.Iso(DateTimeOffset.UtcNow),
            ["X-Client-Seq"] = (++seq).ToString(System.Globalization.CultureInfo.InvariantCulture),
        });
        async Task<JsonElement> Breaks() => (await device.GetAsync("breaks/me/today")).Data;

        // Quick break: record.id, and GET shows it running at once.
        var quick = await Send("breaks/quick/start", new { plannedMin = 10 });
        Assert.True(quick.Ok, $"quick/start with X-Client-Seq: {quick}");
        var quickId = EventRequests.CreatedId(quick.Data);
        Assert.Equal(quick.Data.GetProperty("record").GetProperty("id").GetString(), quickId);
        var day = await Breaks();
        Assert.Equal(quickId, day.GetProperty("activeBreak").GetProperty("id").GetString());
        Assert.Equal("QUICK", day.GetProperty("active").GetProperty("kind").GetString());
        Assert.Contains(day.GetProperty("quick").EnumerateArray(), q => q.GetProperty("id").GetString() == quickId);
        Assert.Equal(409, (await Send("breaks/quick/start", new { plannedMin = 5 })).Status);
        var notPausable = await Send($"breaks/{quickId}/pause", new { });
        Assert.Equal((409, "NOT_PAUSABLE"), (notPausable.Status, notPausable.Code));
        Assert.True((await Send("breaks/end", new { })).Ok);
        Assert.Equal(JsonValueKind.Null, (await Breaks()).GetProperty("activeBreak").ValueKind);

        // Scheduled break: record.id; pause and resume answer the record at the top level.
        var lunch = await Send("breaks/start", new { kind = "LUNCH" });
        Assert.True(lunch.Ok, $"breaks/start: {lunch}");
        var lunchId = EventRequests.CreatedId(lunch.Data);
        Assert.Equal(lunch.Data.GetProperty("record").GetProperty("id").GetString(), lunchId);
        var onBreak = await Send("breaks/quick/start", new { plannedMin = 5 });
        Assert.Equal((409, "ON_BREAK"), (onBreak.Status, onBreak.Code));
        var paused = await Send($"breaks/{lunchId}/pause", new { });
        Assert.True(paused.Ok, $"pause: {paused}");
        Assert.Equal(lunchId, EventRequests.CreatedId(paused.Data));
        Assert.Equal("PAUSED", paused.Data.GetProperty("state").GetString());
        day = await Breaks();
        Assert.Equal(lunchId, day.GetProperty("pausedBreak").GetProperty("id").GetString());
        var slot = day.GetProperty("breaks").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "LUNCH");
        Assert.Equal("PAUSED", slot.GetProperty("state").GetString());
        Assert.Equal(1, slot.GetProperty("segments").GetArrayLength());
        var resumed = await Send($"breaks/{lunchId}/resume", new { });
        Assert.True(resumed.Ok, $"resume: {resumed}");
        Assert.Equal(lunchId, EventRequests.CreatedId(resumed.Data));
        Assert.Equal(2, (await Breaks()).GetProperty("breaks").EnumerateArray().Single(s => s.GetProperty("kind").GetString() == "LUNCH").GetProperty("segments").GetArrayLength());
        Assert.True((await Send("breaks/end", new { })).Ok);

        // Meetings: meeting.id from start and from past; the minutes sender is kept.
        var live = await Send("meetings/start", new { agenda = "Design review", participants = new[] { new { name = "Neha" } }, momSender = "Neha" });
        Assert.True(live.Ok, $"meetings/start: {live}");
        var liveId = EventRequests.CreatedId(live.Data);
        Assert.Equal(live.Data.GetProperty("meeting").GetProperty("id").GetString(), liveId);
        var inMeeting = await Send("breaks/quick/start", new { plannedMin = 5 });
        Assert.Equal((409, "IN_MEETING"), (inMeeting.Status, inMeeting.Code));
        var meetings = (await device.GetAsync("meetings/me/today")).Data.GetProperty("items");
        Assert.Contains(meetings.EnumerateArray(), m => m.GetProperty("id").GetString() == liveId && m.GetProperty("momSender").GetString() == "Neha");
        await Send($"meetings/{liveId}/end", new { });
        var past = await Send("meetings/past", new
        {
            startedAt = E2EEnv.Iso(DateTimeOffset.UtcNow.AddMinutes(-25)),
            durationMin = 5,
            agenda = "Client call",
            participants = new[] { new { name = "Client" } },
            momSender = "Meera",
        });
        Assert.True(past.Ok, $"meetings/past: {past}");
        var pastId = EventRequests.CreatedId(past.Data);
        Assert.Equal(past.Data.GetProperty("meeting").GetProperty("id").GetString(), pastId);
        meetings = (await device.GetAsync("meetings/me/today")).Data.GetProperty("items");
        Assert.Contains(meetings.EnumerateArray(), m => m.GetProperty("id").GetString() == pastId);

        // Away: away.id for a reason, break.id for "Took a break".
        var away = await Send("away", new { startedAt = E2EEnv.Iso(DateTimeOffset.UtcNow.AddMinutes(-3)), reasonKey = "HARDWARE", comment = "Soldering the probe board" });
        Assert.True(away.Ok, $"away HARDWARE: {away}");
        Assert.Equal(away.Data.GetProperty("away").GetProperty("id").GetString(), EventRequests.CreatedId(away.Data));
        Assert.Equal("PENDING", away.Data.GetProperty("away").GetProperty("status").GetString());
        var today = (await device.GetAsync("workday/me/today")).Data;
        Assert.True(today.GetProperty("away").GetProperty("pendingSec").GetInt32() >= 0);
        await Task.Delay(1500);
        var awayBreak = await Send("away", new { startedAt = E2EEnv.Iso(DateTimeOffset.UtcNow.AddSeconds(-1)), reasonKey = "BREAK" });
        Assert.True(awayBreak.Ok, $"away BREAK: {awayBreak}");
        var awayBreakId = EventRequests.CreatedId(awayBreak.Data);
        Assert.Equal(awayBreak.Data.GetProperty("break").GetProperty("id").GetString(), awayBreakId);
        Assert.Equal(awayBreakId, (await Breaks()).GetProperty("activeBreak").GetProperty("id").GetString());
        Assert.True((await Send("breaks/end", new { })).Ok);
    }
}
