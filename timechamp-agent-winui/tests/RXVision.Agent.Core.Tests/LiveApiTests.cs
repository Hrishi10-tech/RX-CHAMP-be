using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Util;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.Core.Tests;

/// <summary>
/// The whole agent core against a real API (a migrated, seeded local backend).
/// Opt-in: RXV_IT_API=http://localhost:4001/api/v1 dotnet test (see Live/LiveEnv.cs).
/// Runs in the live collection, one live test at a time.
/// </summary>
[Collection(Live.LiveCollection.Name)]
public class LiveApiTests
{
    private readonly ITestOutputHelper _out;
    public LiveApiTests(ITestOutputHelper output) => _out = output;

    private static string? Api => Environment.GetEnvironmentVariable("RXV_IT_API");

    [Fact]
    public async Task Full_day_against_the_live_api()
    {
        if (Live.LiveEnv.SkipReason() is { } skip) { _out.WriteLine(skip); return; }

        // A shift built around now, assigned by the organisation's Admin to a new Staff member of
        // the seeded manager's department (new each run, so a second run on the same day starts clean).
        var admin = await Session("orgadmin@timechamp.test", "orgadmin123");
        using var people = await Live.LiveAdmin.SignInAsync("orgadmin@timechamp.test", "orgadmin123");
        var staff = await people.CreatePersonAsync("Agent", "Staff");
        var staffId = staff.Id;
        var tz = TimeZoneInfo.CreateCustomTimeZone("IST", TimeSpan.FromHours(5.5), "IST", "IST");
        string Hm(int minutes) => TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow.AddMinutes(minutes), tz).ToString("HH:mm");
        var name = $"Agent IT {Environment.TickCount64 % 100000}";
        var created = await admin.PostAsJsonAsync("shifts", new
        {
            name,
            start = Hm(-180),
            end = Hm(300),
            workDays = new[] { 1, 2, 3, 4, 5, 6, 7 },
            reasonMinChars = 10,
            breaks = new object[]
            {
                new { kind = "MORNING", enabled = true, startTime = Hm(-10), durationMin = 15, windowBeforeMin = 30, windowAfterMin = 60 },
                new { kind = "LUNCH", enabled = true, startTime = Hm(90), durationMin = 30, windowBeforeMin = 30, windowAfterMin = 60 },
                new { kind = "EVENING", enabled = true, startTime = Hm(180), durationMin = 15, windowBeforeMin = 30, windowAfterMin = 60 },
            },
        });
        Assert.Equal(HttpStatusCode.Created, created.StatusCode);
        var shiftId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("data").GetProperty("id").GetString();
        var today = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, tz).ToString("yyyy-MM-dd");
        var assigned = await admin.PutAsJsonAsync("shift-assignments/people", new { userIds = new[] { staffId }, shiftId, effectiveFrom = today });
        Assert.True(assigned.IsSuccessStatusCode, await assigned.Content.ReadAsStringAsync());

        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var log = new MemoryLog();
        var options = new AgentOptions { ApiBaseUrl = Api!, AutoUpdate = false }.Normalised();
        using var host = new AgentHost(new Live.NoCapturePlatform(platform), options, log);
        try
        {
            await host.StartAsync();
            Assert.Equal(AgentState.SignIn, host.State);

            Assert.Null(await host.SignInAsync(staff.Email, Live.LiveEnv.Password));
            Assert.Equal(AgentState.NeedsNotice, host.State);
            await host.AcknowledgeNoticeAsync();
            // 4.0: the state comes at once from what is known; the server's day follows in the background.
            await WaitFor(() => host.DayKnown && host.BreakPanel.Scheduled, TimeSpan.FromSeconds(20));
            // A day never starts by itself; Start Day opens it.
            if (host.State == AgentState.NotStarted) Assert.IsType<Workday.StartDayOutcome.Started>(await host.StartDayAsync());
            Assert.Equal(AgentState.Running, host.State);
            Assert.True(platform.AutostartOn);

            var panel = host.BreakPanel;
            Assert.True(panel.Scheduled);
            Assert.Equal(name, panel.ShiftName);
            var morning = panel.Slots.Single(s => s.Kind == "MORNING");
            Assert.Equal(SlotState.OpenLate, morning.State);
            Assert.True(morning.ReasonRequired);

            // Activity reaches the server.
            await WaitFor(() => host.LastSampleSent > DateTimeOffset.MinValue, TimeSpan.FromSeconds(15));

            // Late morning: a reason is required, then it starts and goes for approval.
            var first = await host.TakeBreakAsync("MORNING", null);
            Assert.IsType<StartOutcome.NeedsReason>(first);
            var started = await host.TakeBreakAsync("MORNING", "Finishing an escalation call");
            var ok = Assert.IsType<StartOutcome.Started>(started);
            Assert.Equal("PENDING", ok.Record!.ApprovalStatus);
            Assert.Equal(PresenceStatus.Break, host.Presence.Status);
            Assert.NotNull(host.BreakPanel.Active);
            Assert.Equal(SlotState.InProgress, host.BreakPanel.Slots.Single(s => s.Kind == "MORNING").State);

            // Realtime: a chat message, a break decision and a capture request all arrive by socket.
            var manager = await Session("manager@timechamp.test", "manager123");
            var chat = new TaskCompletionSource<ChatMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
            var decided = new TaskCompletionSource<NotificationItem>(TaskCreationOptions.RunContinuationsAsynchronously);
            host.ChatMessageReceived += m => chat.TrySetResult(m);
            host.NotificationReceived += n => { if (n.Type == "BREAK_DECIDED") decided.TrySetResult(n); };
            await Task.Delay(3000); // sockets connect in the background after sign-in
            var sent = await manager.PostAsJsonAsync("chat/messages", new { toUserId = staffId, body = "Can you join the 4 pm call?" });
            Assert.True(sent.IsSuccessStatusCode, await sent.Content.ReadAsStringAsync());
            Assert.Equal("Can you join the 4 pm call?", (await chat.Task.WaitAsync(TimeSpan.FromSeconds(15))).Body);
            var approved = await manager.PostAsJsonAsync($"breaks/approvals/{ok.Record!.Id}/approve", new { note = "Fine" });
            Assert.True(approved.IsSuccessStatusCode, await approved.Content.ReadAsStringAsync());
            Assert.Contains("approved", (await decided.Task.WaitAsync(TimeSpan.FromSeconds(15))).Title);
            // Screenshot capture requests are not exercised here: a capture uploads an image, and a
            // test API must never upload anything (the rules are covered against the fake server).
            var ended = await host.BackToWorkAsync();
            Assert.IsType<EndOutcome.Ended>(ended);
            Assert.Equal(PresenceStatus.Working, host.Presence.Status);
            Assert.Equal(SlotState.Taken, host.BreakPanel.Slots.Single(s => s.Kind == "MORNING").State);

            // Meetings (3.1): a live one with an agenda and people, ended with Meeting ended.
            Assert.IsType<Meetings.MeetingOutcome.Started>(await host.StartMeetingAsync("Sprint review", new[] { new MeetingParticipant(null, "Vikram, Pune") }, Live.LiveEnv.MomSender));
            Assert.Equal(PresenceStatus.Meeting, host.Presence.Status);
            Assert.IsType<EndOutcome.MeetingEnded>(await host.EndMeetingAsync());

            // End Day stops tracking; Start Day resumes it.
            Assert.IsType<Workday.EndDayOutcome.Ended>(await host.EndDayAsync());
            Assert.Equal(AgentState.DayEnded, host.State);
            var refused = await host.TakeBreakAsync("LUNCH", null);
            Assert.IsType<StartOutcome.Refused>(refused);
            Assert.IsType<Workday.StartDayOutcome.Started>(await host.StartDayAsync());
            Assert.Equal(AgentState.Running, host.State);

            // 4.0: Staff sign out with a key from their Admin; this computer's data goes with it.
            var key = (await people.SendAsync(HttpMethod.Post, "signout-keys", new { scope = "USERS", userIds = new[] { staffId } })).GetProperty("phrase").GetString()!;
            Assert.IsType<KeyOutcome.WrongKey>(await host.SignOutWithKeyAsync("not the key at all"));
            Assert.IsType<KeyOutcome.Accepted>(await host.SignOutWithKeyAsync(key));
            Assert.Equal(AgentState.SignIn, host.State);
            Assert.Empty(Directory.GetFiles(platform.DataDir, "queue-*.bin"));
            Assert.Empty(Directory.GetFiles(platform.DataDir, "journal-*.bin"));
            Assert.False(platform.AutostartOn);
        }
        finally
        {
            foreach (var line in log.Lines) _out.WriteLine(line);
            await admin.PutAsJsonAsync("shift-assignments/people", new { userIds = new[] { staffId }, shiftId = (string?)null, effectiveFrom = today });
            await admin.DeleteAsync($"shifts/{shiftId}");
        }
    }

    private static async Task WaitFor(Func<bool> condition, TimeSpan timeout)
    {
        var until = DateTime.UtcNow + timeout;
        while (!condition())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException("condition not met");
            await Task.Delay(200);
        }
    }

    private static async Task<HttpClient> Session(string email, string password)
    {
        var handler = new HttpClientHandler { CookieContainer = new CookieContainer() };
        var client = new HttpClient(handler) { BaseAddress = new Uri(Api!.TrimEnd('/') + "/") };
        var res = await client.PostAsJsonAsync("auth/login", new { email, password });
        res.EnsureSuccessStatusCode();
        return client;
    }
}
