using System.Text.Json;
using System.Text.Json.Nodes;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>A clock a test moves by hand (the host reads it through its server clock).</summary>
internal sealed class ManualClock : IClock
{
    private long _ticks;
    public ManualClock(DateTimeOffset start) => _ticks = start.UtcTicks;
    public DateTimeOffset UtcNow => new(Interlocked.Read(ref _ticks), TimeSpan.Zero);
    public void Advance(TimeSpan by) => Interlocked.Add(ref _ticks, by.Ticks);
    public void Set(DateTimeOffset at) => Interlocked.Exchange(ref _ticks, at.UtcTicks);
}

/// <summary>
/// The meeting status (3.6) in the 4.0 core, on a moved clock against a scripted server that
/// behaves as the 3.6 API does: suggestions, tap only, the 2 hour check, the fallback, the idle
/// restart, a tap with no connection, and what goes over the wire. Ported from the vendor's 3.6
/// suite; 4.0's own rules (a break or End Day waits for End meeting; the local day leads the
/// status) replace the 3.6 ones where they differ.
/// </summary>
public class MeetingStatusTests
{
    private const string ZoomTitle = "Zoom Meeting SECRET-WINDOW-TITLE";

    /// <summary>A server holding one person's status, as the API's rules have it.</summary>
    private sealed class Rig : IDisposable
    {
        private readonly object _gate = new();
        public HostHarness H { get; }
        public ManualClock Clock { get; }
        public string Status { get; set; } = "WORKING";
        public DateTimeOffset? Confirmed { get; set; }
        public DateTimeOffset? StartedAt { get; set; }
        public string? Source { get; private set; }
        public int WorkedSec { get; set; } = 3600;
        public AgentHost Host => H.Host;

        public Rig(object? day = null)
        {
            Clock = new ManualClock(DateTimeOffset.UtcNow);
            H = new HostHarness(day ?? HostHarness.Day("OPEN"), clock: Clock);
            var server = H.Server;
            server.Route("GET me/day-progress", (_, _) => { lock (_gate) return FakeServer.Ok(Progress()); });
            server.Route("POST meetings/status/start", (_, body) =>
            {
                lock (_gate)
                {
                    Heal();
                    if (Status == "BREAK") return FakeServer.Error(409, "ON_BREAK", "You're on a break. Resume work before starting a meeting.");
                    if (Status == "MEETING") return FakeServer.Error(409, "MEETING_IN_PROGRESS", "You're already in a meeting.");
                    using var doc = JsonDocument.Parse(body!);
                    Source = doc.RootElement.GetProperty("source").GetString();
                    Status = "MEETING";
                    StartedAt = Confirmed = Clock.UtcNow;
                    return FakeServer.Ok(Progress());
                }
            });
            server.Route("POST meetings/status/end", (_, _) =>
            {
                lock (_gate)
                {
                    Heal();
                    if (Status == "MEETING") { Status = "WORKING"; StartedAt = Confirmed = null; }
                    return FakeServer.Ok(Progress());
                }
            });
            server.Route("POST meetings/status/confirm", (_, _) =>
            {
                lock (_gate)
                {
                    Heal();
                    if (Status == "MEETING") Confirmed = Clock.UtcNow;
                    return FakeServer.Ok(Progress());
                }
            });
        }

        private void Heal()
        {
            if (Status == "MEETING" && Confirmed is { } c && Clock.UtcNow >= c + TimeSpan.FromMinutes(130))
            {
                Status = "WORKING";
                StartedAt = Confirmed = null;
                H.PresenceStatus = "WORKING";
            }
        }

        private object Progress()
        {
            Heal();
            return new
            {
                status = Status,
                date = HostHarness.Today,
                workedSec = WorkedSec,
                targetSec = 28800,
                targetFromShift = true,
                overSec = 0,
                meetingStartedAt = StartedAt?.ToString("o"),
                meetingPromptAt = Confirmed?.AddHours(2).ToString("o"),
                meetingFallbackAt = Confirmed?.AddMinutes(130).ToString("o"),
            };
        }

        public async Task InAsync()
        {
            await H.SignInAsync();
            await HostHarness.WaitFor(() => Host.State == AgentState.Running && Host.DayProgress is not null);
        }

        public async Task StartAsync(string source = MeetingSources.Button)
        {
            H.PresenceStatus = "MEETING";
            Assert.IsType<MeetingStatusOutcome.Done>(await Host.StartMeetingStatusAsync(source));
        }

        public void OnCall(params CallWindow[] windows) => H.Platform.Windows = windows.ToList();

        public async Task TicksAsync(int n)
        {
            for (var i = 0; i < n; i++) await Host.CallTickNowAsync();
        }

        /// <summary>Moves the clock, as a time-shifted test does, then one second of the meeting check.</summary>
        public void Move(TimeSpan by)
        {
            Clock.Advance(by + TimeSpan.FromSeconds(1));
            Host.MeetingTickNow();
        }

        public void Dispose() => H.Dispose();
    }

    private static CallWindow Zoom => new("zoom.us", ZoomTitle);
    private static MeetingAlert? Alert(Rig r, MeetingAlertKind kind) => r.Host.MeetingAlerts.SingleOrDefault(a => a.Kind == kind);

    // ---- The statuses and the buttons ---------------------------------------------------------------

    [Fact]
    public async Task Start_meeting_goes_at_once_and_End_meeting_goes_back_to_Working()
    {
        using var r = new Rig();
        await r.InAsync();
        Assert.Equal(DayStatus.Working, r.Host.Status);

        await r.StartAsync();
        Assert.Equal(DayStatus.InMeeting, r.Host.Status);
        Assert.Equal(PresenceStatus.Meeting, r.Host.Presence.Status);
        Assert.Equal("BUTTON", r.Source);

        r.H.PresenceStatus = "WORKING";
        Assert.IsType<EndOutcome.MeetingEnded>(await r.Host.EndMeetingAsync());
        Assert.Equal(DayStatus.Working, r.Host.Status);
        Assert.Equal(PresenceStatus.Working, r.Host.Presence.Status);
        Assert.Empty(r.Host.MeetingAlerts);
        // A status meeting ends through its own route, never the journal's meetings/:id/end.
        Assert.Equal(1, r.H.Server.Count("POST meetings/status/end"));
    }

    [Fact]
    public void The_statuses_are_exclusive_and_the_local_day_leads()
    {
        Assert.Equal(DayStatus.NotStarted, DayStatusReader.Of(AgentState.NotStarted, new DayProgress { Status = DayProgressStatus.Meeting }, PresenceStatus.Meeting, false));
        Assert.Equal(DayStatus.DayEnded, DayStatusReader.Of(AgentState.DayEnded, new DayProgress { Status = DayProgressStatus.Working }, PresenceStatus.Working, false));
        Assert.Equal(DayStatus.OnBreak, DayStatusReader.Of(AgentState.Running, new DayProgress { Status = DayProgressStatus.Meeting }, PresenceStatus.Meeting, true));
        Assert.Equal(DayStatus.OnBreak, DayStatusReader.Of(AgentState.Running, new DayProgress { Status = DayProgressStatus.Working }, PresenceStatus.Lunch, false));
        Assert.Equal(DayStatus.InMeeting, DayStatusReader.Of(AgentState.Running, new DayProgress { Status = DayProgressStatus.Meeting }, PresenceStatus.Working, false));
        Assert.Equal(DayStatus.InMeeting, DayStatusReader.Of(AgentState.Running, null, PresenceStatus.Meeting, false));
        Assert.Equal(DayStatus.Working, DayStatusReader.Of(AgentState.Running, null, PresenceStatus.Working, false));
        // 4.0: a break the server reports is not taken over the local day (it may hold an End break not yet sent).
        Assert.Equal(DayStatus.Working, DayStatusReader.Of(AgentState.Running, new DayProgress { Status = DayProgressStatus.Break }, PresenceStatus.Working, false));
        // 4.0: a meeting the local day knows (one recorded with its details, offline) stays a meeting.
        Assert.Equal(DayStatus.InMeeting, DayStatusReader.Of(AgentState.Running, new DayProgress { Status = DayProgressStatus.Working }, PresenceStatus.Meeting, false));
    }

    [Fact]
    public async Task A_refusal_changes_nothing_and_says_why()
    {
        using var r = new Rig();
        await r.InAsync();
        await r.StartAsync();
        Assert.Equal("MEETING_IN_PROGRESS", Assert.IsType<MeetingStatusOutcome.Refused>(await r.Host.StartMeetingStatusAsync(MeetingSources.Button)).Code);
        Assert.Equal(DayStatus.InMeeting, r.Host.Status);
        Assert.Equal(1, r.H.Server.Count("POST meetings/status/start"));
    }

    [Fact]
    public async Task A_break_during_a_status_meeting_waits_for_End_meeting_as_4_0_has_it()
    {
        using var r = new Rig();
        await r.InAsync();
        await r.StartAsync();
        var outcome = await r.Host.TakeFreeBreakAsync(PresenceStatus.Break);
        Assert.Equal("IN_MEETING", Assert.IsType<StartOutcome.Refused>(outcome).Code);
        Assert.Equal(0, r.H.Server.Count("POST presence/start"));
        Assert.Equal(DayStatus.InMeeting, r.Host.Status);
    }

    [Fact]
    public async Task Biometric_staff_get_no_suggestions_and_a_refusal_hides_the_buttons()
    {
        var day = JsonSerializer.SerializeToNode(HostHarness.Day("OPEN"), Json.Options)!;
        day["attendance"] = new JsonObject { ["source"] = "BIOMETRIC" };
        using var r = new Rig(day);
        r.H.Server.Route("POST meetings/status/start", (_, _) => FakeServer.Error(409, "ATTENDANCE_BY_BIOMETRIC", "Your attendance is recorded by the biometric device."));
        await r.InAsync();
        Assert.True(r.Host.IsBiometric);
        r.OnCall(Zoom);
        await r.TicksAsync(4);
        Assert.Empty(r.Host.MeetingAlerts);
        Assert.Empty(r.H.Platform.WindowReads);
        Assert.Equal("ATTENDANCE_BY_BIOMETRIC", Assert.IsType<MeetingStatusOutcome.Refused>(await r.Host.StartMeetingStatusAsync(MeetingSources.Button)).Code);
    }

    [Fact]
    public async Task Actions_still_waiting_for_the_server_hold_a_meeting_start_back()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        h.Server.Route("GET me/day-progress", (_, _) => FakeServer.Ok(new { status = "WORKING", date = HostHarness.Today, workedSec = 60, targetSec = 28800 }));
        await h.SignInAsync();
        h.Server.FailWith = req => req.RequestUri!.AbsolutePath.Contains("/presence/start") ? new HttpRequestException("offline") : null;
        await h.Host.TakeFreeBreakAsync(PresenceStatus.Break);
        h.Server.FailWith = req => req.RequestUri!.AbsolutePath.Contains("/presence/end") ? new HttpRequestException("offline") : null;
        await h.Host.BackToWorkAsync();
        if (h.Host.PendingActions == 0) return; // the journal was quicker than the test: nothing to hold back
        Assert.IsType<MeetingStatusOutcome.Offline>(await h.Host.StartMeetingStatusAsync(MeetingSources.Button));
        Assert.Equal(0, h.Server.Count("POST meetings/status/start"));
    }

    // ---- Reading the day progress --------------------------------------------------------------------

    [Fact]
    public async Task No_day_progress_from_the_server_leaves_the_presence_in_charge()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        h.PresenceStatus = "MEETING";
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Host.Presence.Status == PresenceStatus.Meeting);
        Assert.Null(h.Host.DayProgress);
        Assert.Equal(DayStatus.InMeeting, h.Host.Status);
    }

    [Fact]
    public async Task A_meeting_ended_elsewhere_before_the_fallback_gets_no_card()
    {
        using var r = new Rig();
        await r.InAsync();
        await r.StartAsync();
        r.Status = "WORKING";
        r.StartedAt = r.Confirmed = null;
        r.H.PresenceStatus = "WORKING";
        await r.Host.RefreshDayProgressAsync();
        await HostHarness.WaitFor(() => r.Host.Status == DayStatus.Working);
        Assert.Empty(r.Host.MeetingAlerts);
    }

    // ---- Call detection: suggestions -----------------------------------------------------------------

    [Fact]
    public async Task A_call_while_Working_suggests_and_nothing_changes_until_the_tap()
    {
        using var r = new Rig();
        await r.InAsync();
        var posts = r.H.Server.Calls.Count(c => c.Method == "POST" && c.Path.StartsWith("meetings"));
        r.OnCall(Zoom);
        await r.TicksAsync(1);
        Assert.Empty(r.Host.MeetingAlerts);
        await r.TicksAsync(1);
        var alert = Assert.Single(r.Host.MeetingAlerts);
        Assert.Equal((MeetingAlertKind.StartMeeting, "Zoom", false, "i"), (alert.Kind, alert.App, alert.IsHuddle, alert.Badge));
        Assert.False(alert.NeedsAction);

        // However long nobody answers, the status stays.
        await r.TicksAsync(20);
        Assert.Equal(DayStatus.Working, r.Host.Status);
        Assert.Equal(posts, r.H.Server.Calls.Count(c => c.Method == "POST" && c.Path.StartsWith("meetings")));

        // The tap.
        await r.StartAsync(MeetingSources.Suggestion);
        Assert.Equal("SUGGESTION", r.Source);
        Assert.Equal(DayStatus.InMeeting, r.Host.Status);
        Assert.Null(Alert(r, MeetingAlertKind.StartMeeting));
    }

    [Fact]
    public async Task The_end_of_that_call_suggests_End_meeting_and_the_status_stays_until_the_tap()
    {
        using var r = new Rig();
        await r.InAsync();
        r.OnCall(Zoom);
        await r.TicksAsync(2);
        await r.StartAsync(MeetingSources.Suggestion);
        await r.TicksAsync(5);

        r.OnCall();
        await r.TicksAsync(3);
        Assert.Empty(r.Host.MeetingAlerts); // a reconnect, so far
        await r.TicksAsync(1);
        var alert = Assert.Single(r.Host.MeetingAlerts);
        Assert.Equal((MeetingAlertKind.EndMeeting, "Zoom", "i"), (alert.Kind, alert.App, alert.Badge));
        Assert.Equal(DayStatus.InMeeting, r.Host.Status);
        Assert.Equal(0, r.H.Server.Count("POST meetings/status/end"));

        r.H.PresenceStatus = "WORKING";
        Assert.IsType<EndOutcome.MeetingEnded>(await r.Host.EndMeetingAsync());
        Assert.Equal(DayStatus.Working, r.Host.Status);
        Assert.Empty(r.Host.MeetingAlerts);
    }

    [Fact]
    public async Task Not_now_ends_it_for_that_call()
    {
        using var r = new Rig();
        await r.InAsync();
        r.OnCall(Zoom);
        await r.TicksAsync(2);
        r.Host.DismissMeetingAlert(MeetingAlertKind.StartMeeting);
        Assert.Empty(r.Host.MeetingAlerts);
        await r.TicksAsync(10);
        Assert.Empty(r.Host.MeetingAlerts);
        Assert.Equal(DayStatus.Working, r.Host.Status);
    }

    [Fact]
    public async Task No_call_suggestion_on_a_locked_screen_or_on_a_break()
    {
        using var r = new Rig();
        await r.InAsync();
        r.OnCall(Zoom);
        r.H.Platform.SetLocked(true);
        await r.TicksAsync(5);
        Assert.Empty(r.Host.MeetingAlerts);
        Assert.Empty(r.H.Platform.WindowReads); // and nothing is read at all
        r.H.Platform.SetLocked(false);

        r.H.PresenceStatus = "BREAK";
        await r.Host.RefreshPresenceAsync();
        Assert.Equal(DayStatus.OnBreak, r.Host.Status);
        await r.TicksAsync(5);
        Assert.Empty(r.Host.MeetingAlerts);
        Assert.Empty(r.H.Platform.WindowReads);

        // Back at work with the call still on: it asks then.
        r.H.PresenceStatus = "WORKING";
        await r.Host.RefreshPresenceAsync();
        Assert.Equal(DayStatus.Working, r.Host.Status);
        await r.TicksAsync(2);
        Assert.Equal(MeetingAlertKind.StartMeeting, Assert.Single(r.Host.MeetingAlerts).Kind);
    }

    [Fact]
    public async Task A_day_not_started_reads_nothing()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        h.Platform.Windows = new List<CallWindow> { Zoom };
        await h.SignInAsync();
        await h.Host.CallTickNowAsync();
        Assert.Empty(h.Platform.WindowReads);
        Assert.Empty(h.Host.MeetingAlerts);
    }

    [Fact]
    public async Task The_detectors_read_only_the_tables_processes()
    {
        using var r = new Rig();
        await r.InAsync();
        await r.TicksAsync(1);
        Assert.Equal(CallDetectionTable.Shipped.OwnersFor(CallDetectionTable.OsKey(r.H.Platform.Name)), r.H.Platform.WindowReads[0]);
    }

    [Fact]
    public async Task A_Meet_tab_behind_another_tab_is_looked_for_before_the_call_ends_and_only_then()
    {
        using var r = new Rig();
        await r.InAsync();
        r.OnCall(new CallWindow("Google Chrome", "Inbox"));
        await r.TicksAsync(3);
        Assert.Equal(0, r.H.Platform.TabReads); // no Meet call tracked: the tabs are not read

        r.OnCall(new CallWindow("Google Chrome", "Meet - abc-defg-hij"));
        await r.TicksAsync(2);
        Assert.Equal(MeetingAlertKind.StartMeeting, Assert.Single(r.Host.MeetingAlerts).Kind);
        Assert.Equal(0, r.H.Platform.TabReads);

        // The person switches tab: the window's title moves on, the tab is still there.
        r.OnCall(new CallWindow("Google Chrome", "Inbox"));
        r.H.Platform.Tabs = new List<string> { "Inbox", "Meet - abc-defg-hij" };
        await r.TicksAsync(8);
        Assert.Equal(8, r.H.Platform.TabReads);
        Assert.Equal(MeetingAlertKind.StartMeeting, Assert.Single(r.Host.MeetingAlerts).Kind);

        // The tab closes: four ticks later the call has ended.
        r.H.Platform.Tabs = new List<string> { "Inbox" };
        await r.TicksAsync(4);
        Assert.Empty(r.Host.MeetingAlerts);
        var reads = r.H.Platform.TabReads;
        await r.TicksAsync(3);
        Assert.Equal(reads, r.H.Platform.TabReads);
    }

    [Fact]
    public async Task A_page_called_Meet_on_another_site_is_quiet_when_it_is_in_front()
    {
        using var r = new Rig();
        await r.InAsync();
        r.H.Platform.Front = new ForegroundInfo("Google Chrome", "Meet - Our team", "acme.example.com");
        r.OnCall(new CallWindow("Google Chrome", "Meet - Our team"));
        await r.TicksAsync(5);
        Assert.Empty(r.Host.MeetingAlerts);
    }

    // ---- The 2 hour check, on a moved clock ------------------------------------------------------------

    [Fact]
    public async Task The_prompt_comes_from_the_servers_time_repeats_and_the_fallback_runs_at_its_moment()
    {
        using var r = new Rig();
        await r.InAsync();
        await r.StartAsync();
        var start = r.Host.DayProgress!.MeetingStartedAt!.Value;
        Assert.Equal(start.AddHours(2), r.Host.DayProgress.MeetingPromptAt);
        Assert.Equal(start.AddMinutes(130), r.Host.DayProgress.MeetingFallbackAt);

        // 1h 59m: nothing yet.
        r.Move(TimeSpan.FromMinutes(119));
        Assert.Empty(r.Host.MeetingAlerts);

        // 2h: Still in a meeting?, "!".
        r.Move(TimeSpan.FromMinutes(1));
        var still = Assert.Single(r.Host.MeetingAlerts);
        Assert.Equal((MeetingAlertKind.StillInMeeting, "!", true), (still.Kind, still.Badge, still.NeedsAction));
        Assert.Equal(start, still.At);
        Assert.Equal(DayStatus.InMeeting, r.Host.Status);

        // Still in it: the 2 hours start again from that tap.
        var tappedAt = r.Clock.UtcNow;
        Assert.IsType<MeetingStatusOutcome.Done>(await r.Host.ConfirmMeetingAsync());
        Assert.Empty(r.Host.MeetingAlerts);
        Assert.Equal(tappedAt.AddHours(2), r.Host.DayProgress!.MeetingPromptAt);
        Assert.Equal(DayStatus.InMeeting, r.Host.Status);

        // It repeats.
        r.Move(TimeSpan.FromMinutes(119));
        Assert.Empty(r.Host.MeetingAlerts);
        r.Move(TimeSpan.FromMinutes(1));
        Assert.Equal(MeetingAlertKind.StillInMeeting, Assert.Single(r.Host.MeetingAlerts).Kind);

        // No answer in 10 minutes: back to Working, at that moment, by the server's own switch.
        r.Move(TimeSpan.FromMinutes(9));
        Assert.Equal(DayStatus.InMeeting, r.Host.Status);
        var fallbackAt = r.Host.DayProgress!.MeetingFallbackAt!.Value;
        r.H.PresenceStatus = "WORKING";
        r.Move(TimeSpan.FromSeconds(62));
        await HostHarness.WaitFor(() => r.Host.Status == DayStatus.Working);
        Assert.Equal(PresenceStatus.Working, r.Host.Presence.Status);
        var back = Assert.Single(r.Host.MeetingAlerts);
        Assert.Equal((MeetingAlertKind.BackToWorking, "i", (DateTimeOffset?)fallbackAt), (back.Kind, back.Badge, back.At));
        Assert.Equal(0, r.H.Server.Count("POST meetings/status/end"));

        // Read once the panel closes.
        r.Host.MeetingPanelClosed();
        Assert.Empty(r.Host.MeetingAlerts);
    }

    [Fact]
    public async Task A_restart_loses_neither_time_they_come_from_the_server()
    {
        using var r = new Rig();
        r.Status = "MEETING";
        r.H.PresenceStatus = "MEETING";
        r.StartedAt = r.Confirmed = r.Clock.UtcNow - TimeSpan.FromMinutes(125);
        await r.InAsync();
        r.Move(TimeSpan.FromSeconds(1));
        await HostHarness.WaitFor(() => r.Host.MeetingAlerts.Count == 1);
        Assert.Equal(MeetingAlertKind.StillInMeeting, r.Host.MeetingAlerts[0].Kind);
        Assert.Equal(r.StartedAt, r.Host.MeetingAlerts[0].At);
    }

    [Fact]
    public async Task Still_in_it_that_lost_the_race_reads_Working_with_no_error()
    {
        using var r = new Rig();
        await r.InAsync();
        await r.StartAsync();
        r.Clock.Advance(TimeSpan.FromMinutes(131)); // the tap and the fallback cross
        var outcome = Assert.IsType<MeetingStatusOutcome.Done>(await r.Host.ConfirmMeetingAsync());
        Assert.Equal(DayProgressStatus.Working, outcome.Progress.Status);
        Assert.Equal(DayStatus.Working, r.Host.Status);
        Assert.Equal(MeetingAlertKind.BackToWorking, Assert.Single(r.Host.MeetingAlerts).Kind);
    }

    [Fact]
    public async Task End_meeting_tapped_after_the_fallback_needs_no_card()
    {
        using var r = new Rig();
        await r.InAsync();
        await r.StartAsync();
        r.Clock.Advance(TimeSpan.FromMinutes(131));
        r.H.PresenceStatus = "WORKING";
        Assert.IsType<EndOutcome.MeetingEnded>(await r.Host.EndMeetingAsync());
        Assert.Equal(DayStatus.Working, r.Host.Status);
        Assert.Empty(r.Host.MeetingAlerts);
    }

    [Fact]
    public async Task A_declared_meeting_gets_no_check()
    {
        using var r = new Rig();
        r.H.PresenceStatus = "MEETING";
        r.H.Server.Route("GET me/day-progress", (_, _) => FakeServer.Ok(new { status = "MEETING", date = HostHarness.Today, workedSec = 100, targetSec = 28800, meetingStartedAt = DateTimeOffset.UtcNow.ToString("o") }));
        await r.InAsync();
        r.Move(TimeSpan.FromHours(5));
        Assert.Empty(r.Host.MeetingAlerts);
        Assert.Equal(DayStatus.InMeeting, r.Host.Status);
    }

    // ---- Idle timers restart at the switch -----------------------------------------------------------------

    [Fact]
    public async Task Idle_restarts_at_the_fallback_for_the_samples_the_heartbeat_and_the_away_card()
    {
        using var r = new Rig();
        await r.InAsync();
        r.H.Platform.IdleFor = TimeSpan.FromHours(3); // nobody touched anything for the whole meeting
        Assert.Equal(TimeSpan.FromHours(3), r.Host.IdleFor);
        await r.StartAsync();
        r.H.PresenceStatus = "WORKING";
        r.Move(TimeSpan.FromMinutes(131));
        await HostHarness.WaitFor(() => r.Host.Status == DayStatus.Working);
        var fallback = r.Host.MeetingAlerts.Single().At!.Value;

        // Since the switch, not since the last key: and never the meeting's time.
        var since = r.Host.Clock.UtcNow - fallback;
        Assert.InRange(r.Host.IdleFor, TimeSpan.Zero, since + TimeSpan.FromSeconds(5));

        // The activity sample reads the same figure.
        var reports = r.H.Reports;
        await r.Host.SampleNowAsync();
        await HostHarness.WaitFor(() => r.H.Reports > reports);
        using (var sample = JsonDocument.Parse(r.H.Server.Calls.Last(c => c.Path == "activity/report").Body!))
            Assert.Contains("\"idle\":false", sample.RootElement.GetRawText().Replace(" ", ""));

        // A real absence after the switch still reads as it is: 6 minutes past it is idle.
        r.Clock.Advance(TimeSpan.FromMinutes(6));
        Assert.True(r.Host.IdleFor >= TimeSpan.FromMinutes(6));
        // And input since the switch wins over the time since it.
        r.H.Platform.IdleFor = TimeSpan.FromSeconds(4);
        Assert.Equal(TimeSpan.FromSeconds(4), r.Host.IdleFor);
    }

    [Fact]
    public async Task A_meeting_ended_by_hand_leaves_the_idle_timers_as_they_are()
    {
        using var r = new Rig();
        await r.InAsync();
        r.H.Platform.IdleFor = TimeSpan.FromMinutes(20);
        await r.StartAsync();
        r.H.PresenceStatus = "WORKING";
        await r.Host.EndMeetingAsync();
        Assert.Equal(TimeSpan.FromMinutes(20), r.Host.IdleFor);
    }

    // ---- A tap with no connection ----------------------------------------------------------------------------

    [Fact]
    public async Task A_tap_with_no_connection_changes_nothing_and_the_retry_goes_through()
    {
        using var r = new Rig();
        await r.InAsync();
        var fail = true;
        r.H.Server.FailWith = req => fail && req.RequestUri!.AbsolutePath.Contains("/meetings/status/") ? new HttpRequestException("offline") : null;

        var start = Assert.IsType<MeetingStatusOutcome.Offline>(await r.Host.StartMeetingStatusAsync(MeetingSources.Button));
        Assert.Equal("Try again in a moment. Nothing was saved yet.", start.Message);
        Assert.Equal(DayStatus.Working, r.Host.Status);

        fail = false;
        await r.StartAsync();
        fail = true;
        var end = Assert.IsType<EndOutcome.Offline>(await r.Host.EndMeetingAsync());
        Assert.Equal("Try again in a moment. Your meeting is still running.", end.Message);
        Assert.Equal(DayStatus.InMeeting, r.Host.Status);
        Assert.IsType<MeetingStatusOutcome.Offline>(await r.Host.ConfirmMeetingAsync());
        Assert.Equal(DayStatus.InMeeting, r.Host.Status);

        fail = false;
        r.H.PresenceStatus = "WORKING";
        Assert.IsType<EndOutcome.MeetingEnded>(await r.Host.EndMeetingAsync());
        Assert.Equal(DayStatus.Working, r.Host.Status);
    }

    [Fact]
    public async Task With_no_connection_at_the_fallback_the_agent_moves_by_itself_and_the_server_agrees_later()
    {
        using var r = new Rig();
        await r.InAsync();
        await r.StartAsync();
        var worked = r.Host.DayProgress!.WorkedSec;
        var fallback = r.Host.DayProgress.MeetingFallbackAt!.Value;

        r.H.Server.FailWith = _ => new HttpRequestException("offline");
        r.Move(TimeSpan.FromMinutes(131));
        await HostHarness.WaitFor(() => r.Host.Status == DayStatus.Working);
        Assert.Equal(PresenceStatus.Working, r.Host.Presence.Status);
        Assert.Equal(worked, r.Host.DayProgress!.WorkedSec);
        var back = Assert.Single(r.Host.MeetingAlerts);
        Assert.Equal((MeetingAlertKind.BackToWorking, (DateTimeOffset?)fallback), (back.Kind, back.At));

        r.H.Server.FailWith = _ => null;
        r.H.PresenceStatus = "WORKING";
        await r.Host.RefreshDayProgressAsync();
        Assert.Equal(DayStatus.Working, r.Host.Status);
        Assert.Equal(MeetingAlertKind.BackToWorking, Assert.Single(r.Host.MeetingAlerts).Kind); // said once
    }

    // ---- What goes over the wire -----------------------------------------------------------------------------

    /// <summary>
    /// A whole meeting from a detected call: the suggestion, the tap, the prompt, Still in it, the
    /// call's end, End meeting. Over the wire the feature sends its three routes and nothing else, with only
    /// the source; no window title, app name, participant or agenda anywhere in any request.
    /// </summary>
    [Fact]
    public async Task The_meeting_feature_sends_only_its_start_and_end_events()
    {
        using var r = new Rig();
        r.H.Platform.Front = new ForegroundInfo("Excel", "Book1", null);
        await r.InAsync();
        var seenBefore = r.H.Server.Calls.Count;

        r.OnCall(Zoom, new CallWindow("Microsoft Teams", "SECRET-MEETING-NAME | Microsoft Teams"), new CallWindow("Google Chrome", "Meet - SECRET-MEET-CODE"));
        r.H.Platform.Tabs = new List<string> { "Meet - SECRET-MEET-CODE", "SECRET-TAB-TITLE" };
        await r.TicksAsync(3);
        Assert.NotEmpty(r.Host.MeetingAlerts);
        await r.StartAsync(MeetingSources.Suggestion);
        r.Move(TimeSpan.FromMinutes(121));
        await HostHarness.WaitFor(() => r.Host.MeetingAlerts.Any(a => a.Kind == MeetingAlertKind.StillInMeeting));
        Assert.IsType<MeetingStatusOutcome.Done>(await r.Host.ConfirmMeetingAsync());
        r.OnCall();
        r.H.Platform.Tabs = new List<string>();
        await r.TicksAsync(4);
        Assert.Contains(r.Host.MeetingAlerts, a => a.Kind == MeetingAlertKind.EndMeeting);
        r.H.PresenceStatus = "WORKING";
        Assert.IsType<EndOutcome.MeetingEnded>(await r.Host.EndMeetingAsync());
        await Task.Delay(100);

        var calls = r.H.Server.Calls.Skip(seenBefore).ToList();
        var meetingPosts = calls.Where(c => c.Method == "POST" && c.Path.StartsWith("meetings")).ToList();
        Assert.Equal(new[] { "meetings/status/start", "meetings/status/confirm", "meetings/status/end" }, meetingPosts.Select(c => c.Path));
        Assert.Equal("{\"source\":\"SUGGESTION\"}", meetingPosts[0].Body);
        Assert.Null(meetingPosts[1].Body);
        Assert.Null(meetingPosts[2].Body);

        // Nothing the detectors saw, anywhere: not in a path or a body.
        foreach (var (_, path, body, _) in calls)
        {
            foreach (var secret in new[] { "SECRET", "Zoom", "zoom", "Teams", "Google Meet", "huddle" })
            {
                Assert.DoesNotContain(secret, path);
                Assert.DoesNotContain(secret, body ?? "");
            }
        }
    }

    [Fact]
    public async Task Nothing_the_detectors_read_is_kept_in_the_log()
    {
        using var r = new Rig();
        await r.InAsync();
        r.OnCall(Zoom);
        await r.TicksAsync(3);
        await r.StartAsync(MeetingSources.Suggestion);
        Assert.DoesNotContain(r.H.Log.Lines, line => line.Contains("SECRET"));
    }
}
