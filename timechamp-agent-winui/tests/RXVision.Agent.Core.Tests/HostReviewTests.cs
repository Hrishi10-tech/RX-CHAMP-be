using RXVision.Agent.Core.Workday;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>The 3.6 core review items on the 4.0 host: C-R04, C-R06, C-R07 and C-R11.</summary>
public class HostReviewTests
{
    /// <summary>
    /// Core review C-R06: socket events are not replayed, so a reconnect reads the day again;
    /// a day not started here also gets the day check that notices it started elsewhere.
    /// </summary>
    [Fact]
    public async Task A_socket_reconnect_reads_the_day_again()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        h.Server.Route("GET me/day-progress", (_, _) => FakeServer.Ok(new { status = "NOT_STARTED", date = HostHarness.Today, workedSec = 0, targetSec = 28800 }));
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Host.State == AgentState.NotStarted);
        var progress = h.Server.Count("GET me/day-progress");
        var days = h.Server.Count("GET workday/me/today");

        h.Host.Notifications!.RaiseConnected();

        await HostHarness.WaitFor(() => h.Server.Count("GET me/day-progress") > progress && h.Server.Count("GET workday/me/today") > days);
    }

    /// <summary>
    /// Core review C-R11 (AGENT.md section 9): a person whose day is already open (started on the
    /// phone) signs in on a new device: the day is tracked at once and the notice waits on top.
    /// </summary>
    [Fact]
    public async Task An_open_day_keeps_recording_while_the_notice_waits()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        File.Delete(Path.Combine(h.Platform.DataDir, "notice-u1.txt"));
        await h.SignInAsync();

        Assert.Equal(AgentState.Running, h.Host.State);
        Assert.True(h.Host.NoticePending);

        await h.Host.AcknowledgeNoticeAsync();
        Assert.False(h.Host.NoticePending);
        Assert.Equal(AgentState.Running, h.Host.State);
    }

    [Fact]
    public async Task A_day_not_started_waits_for_the_notice_and_Start_day_waits_too()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        File.Delete(Path.Combine(h.Platform.DataDir, "notice-u1.txt"));
        await h.SignInAsync();

        Assert.Equal(AgentState.NeedsNotice, h.Host.State);
        Assert.True(h.Host.NoticePending);
        Assert.IsType<StartDayOutcome.Refused>(await h.Host.StartDayAsync());
        Assert.Equal(0, h.Server.Count("POST activity/start-day"));
    }

    /// <summary>Core review C-R04: the release flags are read at sign-in; off until the server says on.</summary>
    [Fact]
    public async Task The_release_flags_are_read_at_sign_in()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        Assert.False(h.Host.Features.On("dataHandling"));
        h.Server.Route("GET features", (_, _) => FakeServer.Ok(new { flags = new { dataHandling = true, messaging = false, agentCalmUi = false } }));
        await h.SignInAsync();

        Assert.Equal(1, h.Server.Count("GET features"));
        Assert.True(h.Host.Features.On("dataHandling"));
        Assert.False(h.Host.Features.On("messaging"));
    }

    /// <summary>An API without the flags (older 4.0 servers answer 404): every flag reads off and sign-in carries on.</summary>
    [Fact]
    public async Task No_flags_from_the_server_reads_every_flag_off()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Host.State == AgentState.Running);
        Assert.False(h.Host.Features.On("dataHandling"));
    }

    /// <summary>An API without the 3.6 status routes: no day progress, and the 4.0 day decides alone.</summary>
    [Fact]
    public async Task No_day_progress_route_leaves_the_4_0_day_in_charge()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Host.State == AgentState.Running);
        Assert.Null(h.Host.DayProgress);
        Assert.Equal(DayStatus.Working, h.Host.Status);
    }
}
