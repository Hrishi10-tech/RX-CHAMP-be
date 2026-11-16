using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Util;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>4.0 diagnostics: parallel connect (Happy Eyeballs) and network failures that say why.</summary>
public class HappyEyeballsTests
{
    private static readonly IPAddress V6 = IPAddress.Parse("2001:db8::1");
    private static readonly IPAddress V6b = IPAddress.Parse("2001:db8::2");
    private static readonly IPAddress V4 = IPAddress.Parse("192.0.2.1");
    private static readonly IPAddress V4b = IPAddress.Parse("192.0.2.2");

    private sealed class Script
    {
        public readonly Dictionary<IPAddress, Func<CancellationToken, Task<Stream>>> Behaviour = new();
        public readonly List<(IPAddress Address, TimeSpan At)> Started = new();
        public readonly List<IPAddress> Cancelled = new();
        public readonly Stopwatch Clock = Stopwatch.StartNew();

        public Task<Stream> Connect(IPAddress address, int port, CancellationToken ct)
        {
            lock (Started) Started.Add((address, Clock.Elapsed));
            ct.Register(() => { lock (Cancelled) Cancelled.Add(address); });
            return Behaviour[address](ct);
        }
    }

    private static Func<CancellationToken, Task<Stream>> Hangs() => async ct =>
    {
        await Task.Delay(Timeout.Infinite, ct);
        throw new InvalidOperationException("unreachable");
    };

    private static Func<CancellationToken, Task<Stream>> Succeeds(int afterMs, MemoryStream? stream = null) => async ct =>
    {
        await Task.Delay(afterMs, ct);
        return stream ?? new MemoryStream();
    };

    private static Func<CancellationToken, Task<Stream>> Fails(int afterMs) => async ct =>
    {
        await Task.Delay(afterMs, ct);
        throw new SocketException((int)SocketError.NetworkUnreachable);
    };

    private static HappyEyeballs Racer(Script script, IPAddress[] addresses, MemoryLog? log = null) =>
        new(log ?? new MemoryLog(), (_, _) => Task.FromResult(addresses), script.Connect, TimeSpan.FromMilliseconds(250));

    [Fact]
    public void Families_alternate_starting_with_the_resolvers_first()
    {
        Assert.Equal(new[] { V6, V4, V6b, V4b }, HappyEyeballs.Interleave(new[] { V6, V6b, V4, V4b }));
        Assert.Equal(new[] { V4, V6, V4b }, HappyEyeballs.Interleave(new[] { V4, V4b, V6 }));
        Assert.Equal(new[] { V4 }, HappyEyeballs.Interleave(new[] { V4, V4 }));
        Assert.Empty(HappyEyeballs.Interleave(Array.Empty<IPAddress>()));
    }

    [Fact]
    public async Task A_hanging_IPv6_route_loses_to_IPv4_started_250_ms_later()
    {
        var script = new Script();
        var winner = new MemoryStream();
        script.Behaviour[V6] = Hangs();
        script.Behaviour[V4] = Succeeds(20, winner);
        var log = new MemoryLog();

        var stream = await Racer(script, new[] { V6, V4 }, log).ConnectAsync("api.example", 443, CancellationToken.None);

        Assert.Same(winner, stream);
        Assert.Equal(new[] { V6, V4 }, script.Started.Select(s => s.Address));
        var gap = script.Started[1].At - script.Started[0].At;
        Assert.InRange(gap.TotalMilliseconds, 200, 2000);
        await HostHarness.WaitFor(() => { lock (script.Cancelled) return script.Cancelled.Contains(V6); });
        Assert.Contains(log.Lines, l => l.Contains("connected to api.example over IPv4 192.0.2.1"));
    }

    [Fact]
    public async Task A_fast_first_address_wins_without_starting_the_others()
    {
        var script = new Script();
        script.Behaviour[V6] = Succeeds(5);
        script.Behaviour[V4] = Succeeds(5);

        await Racer(script, new[] { V6, V4 }).ConnectAsync("api.example", 443, CancellationToken.None);

        Assert.Equal(new[] { V6 }, script.Started.Select(s => s.Address));
    }

    [Fact]
    public async Task A_failure_starts_the_next_address_at_once()
    {
        var script = new Script();
        script.Behaviour[V6] = Fails(10);
        script.Behaviour[V4] = Succeeds(10);

        var watch = Stopwatch.StartNew();
        await Racer(script, new[] { V6, V4 }).ConnectAsync("api.example", 443, CancellationToken.None);

        Assert.Equal(new[] { V6, V4 }, script.Started.Select(s => s.Address));
        Assert.True(script.Started[1].At - script.Started[0].At < TimeSpan.FromMilliseconds(200), "the next address waited for the stagger");
    }

    [Fact]
    public async Task All_failing_throws_and_logs_every_address()
    {
        var script = new Script();
        script.Behaviour[V6] = Fails(5);
        script.Behaviour[V4] = Fails(5);
        var log = new MemoryLog();

        await Assert.ThrowsAsync<SocketException>(() => Racer(script, new[] { V6, V4 }, log).ConnectAsync("api.example", 443, CancellationToken.None));

        var line = Assert.Single(log.Lines, l => l.Contains("could not connect to api.example:443"));
        Assert.Contains("IPv6 2001:db8::1: SocketException", line);
        Assert.Contains("IPv4 192.0.2.1: SocketException", line);
    }

    [Fact]
    public async Task A_late_loser_is_closed_when_it_finishes()
    {
        var script = new Script();
        var late = new TrackingStream();
        var release = new TaskCompletionSource();
        script.Behaviour[V6] = async _ => { await release.Task; return late; }; // ignores cancellation
        script.Behaviour[V4] = Succeeds(5);

        await Racer(script, new[] { V6, V4 }).ConnectAsync("api.example", 443, CancellationToken.None);
        release.SetResult();

        await HostHarness.WaitFor(() => late.Disposed);
    }

    [Fact]
    public async Task An_ip_literal_is_not_resolved()
    {
        var script = new Script();
        script.Behaviour[IPAddress.Loopback] = Succeeds(1);
        var racer = new HappyEyeballs(new MemoryLog(), (_, _) => throw new InvalidOperationException("resolved"), script.Connect);

        await racer.ConnectAsync("127.0.0.1", 4000, CancellationToken.None);

        Assert.Equal(IPAddress.Loopback, Assert.Single(script.Started).Address);
    }

    [Fact]
    public async Task Cancelling_cancels_every_attempt()
    {
        var script = new Script();
        script.Behaviour[V6] = Hangs();
        script.Behaviour[V4] = Hangs();
        using var cts = new CancellationTokenSource();
        var connect = Racer(script, new[] { V6, V4 }).ConnectAsync("api.example", 443, cts.Token);
        // Cancel once both attempts are running (a fixed timer raced the 250 ms head start
        // of the second attempt on a busy machine), then every one of them must stop.
        await HostHarness.WaitFor(() => { lock (script.Started) return script.Started.Count == 2; });
        cts.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => connect);
        await HostHarness.WaitFor(() => { lock (script.Cancelled) return script.Cancelled.Count == 2; });
    }

    private sealed class TrackingStream : MemoryStream
    {
        public volatile bool Disposed;
        protected override void Dispose(bool disposing)
        {
            Disposed = true;
            base.Dispose(disposing);
        }
    }
}

public class NetworkFailureLogTests
{
    [Fact]
    public async Task A_failed_request_is_logged_with_the_exception_its_inner_one_and_the_path()
    {
        var server = new FakeServer
        {
            FailWith = _ => new HttpRequestException("Connection refused (api.rxv.invalid:443)", new SocketException((int)SocketError.ConnectionRefused)),
        };
        var log = new MemoryLog();
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        using var api = new ApiClient("https://api.rxv.invalid/api/v1", new AgentIdentity("4.0.0", "dev", "d-1"), new SessionStore(platform.Secrets), new ServerClock(), log, server);

        var result = await api.LoginAsync("asha@x.test", "pw");

        Assert.Equal(ApiOutcome.Transient, result.Outcome);
        var line = Assert.Single(log.Lines, l => l.Contains("POST auth/login failed"));
        Assert.Contains("HttpRequestException: Connection refused (api.rxv.invalid:443)", line);
        Assert.Contains("<- SocketException:", line);
        Assert.Contains("ConnectionRefused", line);
    }

    [Fact]
    public async Task A_transient_status_is_logged_with_its_status()
    {
        var server = new FakeServer().Route("GET workday/me/today", (_, _) => FakeServer.Html(502));
        var log = new MemoryLog();
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        using var api = new ApiClient("https://api.rxv.invalid/api/v1", new AgentIdentity("4.0.0", "dev", "d-1"), new SessionStore(platform.Secrets), new ServerClock(), log, server);

        var result = await api.GetWorkdayTodayAsync();

        Assert.True(result.Transient);
        Assert.Contains(log.Lines, l => l.Contains("GET workday/me/today: HTTP 502"));
    }

    [Fact]
    public void Failures_are_described_down_to_the_socket()
    {
        var text = ApiClient.DescribeFailure(new HttpRequestException("Response status code does not indicate success", null, HttpStatusCode.BadGateway));
        Assert.Equal("HttpRequestException: Response status code does not indicate success (status 502)", text);
        var timeout = ApiClient.DescribeFailure(new TaskCanceledException("The request was canceled", new TimeoutException("A task was canceled")));
        Assert.Contains("TaskCanceledException: The request was canceled (timed out) <- TimeoutException", timeout);
    }

    [Fact]
    public void The_agent_says_it_is_4_0()
    {
        Assert.StartsWith("4.0.", RXVision.Agent.Core.Config.AgentOptions.AppVersion);
    }
}
