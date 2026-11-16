using System.Text.Json;
using RXVision.Agent.Core.Activity;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Util;
using Xunit;

namespace RXVision.Agent.Core.Tests;

public class ActivityQueueTests
{
    [Fact]
    public void Keeps_order_and_survives_a_restart_encrypted()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var q = new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance);
        q.Enqueue(new ActivityReport { At = "2026-10-13T05:00:00.000Z", Title = "Secret project" });
        q.Enqueue(new ActivityReport { At = "2026-10-13T05:01:00.000Z" });

        var file = Directory.GetFiles(platform.DataDir, "queue-*.bin").Single();
        Assert.DoesNotContain("Secret project", File.ReadAllText(file));

        var again = new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance);
        Assert.Equal(2, again.Count);
        Assert.Equal("2026-10-13T05:00:00.000Z", again.Peek()!.At);
    }

    [Fact]
    public void Never_lets_a_sample_go_behind_the_tail()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var q = new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance);
        q.Enqueue(new ActivityReport { At = "2026-10-13T05:05:00.000Z" });
        var late = new ActivityReport { At = "2026-10-13T05:00:00.000Z" };
        q.Enqueue(late);
        Assert.Equal("2026-10-13T05:05:00.000Z", late.At);
    }

    [Fact]
    public void Keeps_people_apart()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance).Enqueue(new ActivityReport { At = "2026-10-13T05:00:00.000Z" });
        Assert.Equal(0, new ActivityQueue(platform.Secrets, platform.DataDir, "u-2", NullLog.Instance).Count);
    }

    [Fact]
    public void Drops_the_oldest_beyond_the_cap()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var q = new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance, maxItems: 50);
        for (var i = 0; i < 55; i++)
            q.Enqueue(new ActivityReport { At = DateTimeOffset.UnixEpoch.AddMinutes(i).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") });
        Assert.Equal(50, q.Count);
        Assert.Equal("1970-01-01T00:05:00.000Z", q.Peek()!.At);
        Assert.Equal(50, new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance, maxItems: 50).Count);
    }

    /// <summary>
    /// 4.0: the server keeps offline backlog for 7 days and a replayed day counts as focus
    /// only what its samples cover, so a week offline at the fastest rate fits, and nothing
    /// is dropped for its age (3.x kept 1,000 samples, about 16 hours).
    /// </summary>
    [Fact]
    public void Keeps_a_week_of_samples_whatever_their_age()
    {
        Assert.True(ActivityQueue.MaxItems >= 7 * 24 * 3600 / 30, $"cap {ActivityQueue.MaxItems}");
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var q = new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance);
        var now = DateTimeOffset.UtcNow;
        string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        // Six and four days old (past the old 72-hour limit), then now; and one older than a week.
        var times = new[] { now.AddDays(-8), now.AddDays(-6), now.AddDays(-4), now.AddDays(-3).AddMinutes(-1), now }.Select(Iso).ToList();
        foreach (var at in times) q.Enqueue(new ActivityReport { At = at });

        var again = new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance);
        Assert.Equal(times.Count, again.Count);
        Assert.Equal(times[0], again.Peek()!.At);
        Assert.Equal(times[^1], again.LastAt);
    }

    [Fact]
    public void Removals_can_wait_for_one_save()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var q = new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance);
        for (var i = 0; i < 5; i++) q.Enqueue(new ActivityReport { At = $"2026-10-13T05:0{i}:00.000Z" });
        q.Remove(q.Peek()!, persist: false);
        q.Remove(q.Peek()!, persist: false);
        Assert.Equal(3, q.Count);
        Assert.Equal(5, new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance).Count);   // not written yet
        q.Persist();
        var again = new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance);
        Assert.Equal(3, again.Count);
        Assert.Equal("2026-10-13T05:02:00.000Z", again.Peek()!.At);
    }

    [Fact]
    public void Truncates_to_the_server_limits_without_splitting_characters()
    {
        var r = new ActivityReport { App = new string('a', 300), Title = new string('t', 499) + "\U0001F600", Url = "  " }.Truncated();
        Assert.Equal(200, r.App!.Length);
        Assert.True(r.Title!.Length <= 500);
        Assert.False(char.IsHighSurrogate(r.Title[^1]));
        Assert.Null(r.Url);
    }
}

public class ActivityTrackerTests
{
    private static (ActivityTracker tracker, FakeServer server, DevPlatform platform, ApiClient api) Make(Func<HttpRequestMessage, string?, HttpResponseMessage> report)
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var server = new FakeServer();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        server.Route("POST activity/report", report);
        var api = new ApiClient("https://api.example.com/api/v1", new AgentIdentity("3.0.0", "dev", "d"), new SessionStore(platform.Secrets), new ServerClock(), NullLog.Instance, server);
        api.LoginAsync("a@x.test", "pw").GetAwaiter().GetResult();
        var queue = new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance);
        var tracker = new ActivityTracker(api, platform, new AgentOptions().Normalised(), queue, NullLog.Instance);
        return (tracker, server, platform, api);
    }

    private static HttpResponseMessage Ack(bool shouldCapture = true, bool screenshots = true) =>
        FakeServer.Ok(new { activeSec = 60, workingBasisSec = 32400, remainingSec = 0, clockedOut = false, dayEnded = !shouldCapture, shouldCapture, screenshotsEnabled = screenshots });

    [Fact]
    public async Task Sends_a_live_sample_with_app_title_and_url()
    {
        var (tracker, server, platform, _) = Make((_, _) => Ack());
        platform.Front = new ForegroundInfo("Google Chrome", "Pull requests", "github.com");
        tracker.Start();
        await tracker.TickAsync();
        tracker.Stop();

        var body = server.Calls.First(c => c.Path == "activity/report").Body!;
        using var doc = JsonDocument.Parse(body);
        Assert.Equal("Google Chrome", doc.RootElement.GetProperty("app").GetString());
        Assert.Equal("github.com", doc.RootElement.GetProperty("url").GetString());
        Assert.False(doc.RootElement.GetProperty("idle").GetBoolean());
        Assert.Equal(0, tracker.Pending);
    }

    [Fact]
    public async Task Holds_samples_while_offline_and_sends_them_in_order_later()
    {
        var online = false;
        var (tracker, server, _, _) = Make((_, _) => online ? Ack() : FakeServer.Html(503));
        tracker.Start();
        await tracker.TickAsync();
        await Task.Delay(20);
        await tracker.TickAsync();
        Assert.Equal(2, tracker.Pending);

        online = true;
        await tracker.TickAsync();
        tracker.Stop();
        Assert.Equal(0, tracker.Pending);

        var sent = server.Calls.Where(c => c.Path == "activity/report").Skip(2).Select(c => JsonDocument.Parse(c.Body!).RootElement.GetProperty("at").GetString()).ToList();
        Assert.Equal(sent.OrderBy(x => x, StringComparer.Ordinal), sent);
        Assert.Equal(3, sent.Count);
    }

    [Fact]
    public async Task A_replaced_tracker_sends_nothing_more_and_its_successor_sends_each_sample_once()
    {
        var online = false;
        var (tracker, server, platform, api) = Make((_, _) => online ? Ack() : FakeServer.Html(503));
        tracker.Start();
        await tracker.TickAsync();
        await Task.Delay(20);
        await tracker.TickAsync();
        Assert.Equal(2, tracker.Pending);

        // The watchdog replaces the tracker; both share the person's queue.
        var queue = (ActivityQueue)typeof(ActivityTracker)
            .GetField("_queue", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!
            .GetValue(tracker)!;
        tracker.Retire();
        online = true;
        var before = server.Count("POST activity/report");
        Assert.False(await tracker.DrainAsync(10, CancellationToken.None));
        Assert.Equal(before, server.Count("POST activity/report"));

        var successor = new ActivityTracker(api, platform, new AgentOptions().Normalised(), queue, NullLog.Instance);
        successor.Start();
        Assert.True(await successor.DrainAsync(10, CancellationToken.None));
        successor.Stop();
        var sent = server.Calls.Where(c => c.Path == "activity/report").Skip(before)
            .Select(c => JsonDocument.Parse(c.Body!).RootElement.GetProperty("at").GetString()).ToList();
        Assert.Equal(2, sent.Count);
        Assert.Equal(sent.Distinct().Count(), sent.Count);
    }

    [Fact]
    public async Task A_flush_during_a_tick_waits_for_it_and_never_sends_a_sample_twice()
    {
        var gate = new TaskCompletionSource();
        var calls = 0;
        var (tracker, server, _, _) = Make((_, _) =>
        {
            if (Interlocked.Increment(ref calls) == 1) gate.Task.Wait(TimeSpan.FromSeconds(10));
            return Ack();
        });
        tracker.Start();
        var tick = Task.Run(() => tracker.TickAsync());   // its send waits at the server
        var until = DateTime.UtcNow.AddSeconds(5);
        while (server.Count("POST activity/report") == 0 && DateTime.UtcNow < until) await Task.Delay(10);

        // End Day's flush while that send is out: it waits for it rather than sending the same head again.
        var flush = Task.Run(() => tracker.FlushAsync(TimeSpan.FromSeconds(10)));
        await Task.Delay(300);
        Assert.Equal(1, server.Count("POST activity/report"));
        gate.SetResult();
        await Task.WhenAll(tick, flush);
        tracker.Stop();

        var sent = server.Calls.Where(c => c.Path == "activity/report")
            .Select(c => JsonDocument.Parse(c.Body!).RootElement.GetProperty("at").GetString()).ToList();
        Assert.Equal(sent.Distinct().Count(), sent.Count);
        Assert.Equal(0, tracker.Pending);
    }

    [Fact]
    public async Task Nothing_is_sent_while_sending_is_held()
    {
        var (tracker, server, _, _) = Make((_, _) => Ack());
        var may = false;
        tracker.MaySend = () => may;
        tracker.Start();
        await tracker.TickAsync();
        Assert.False(await tracker.FlushAsync(TimeSpan.FromSeconds(2)));
        Assert.Equal(0, server.Count("POST activity/report"));
        Assert.Equal(1, tracker.Pending);

        may = true;
        await Task.Delay(20);
        await tracker.TickAsync();
        tracker.Stop();
        Assert.Equal(2, server.Count("POST activity/report"));
        Assert.Equal(0, tracker.Pending);
    }

    [Fact]
    public async Task A_tick_in_progress_is_visible_to_the_watchdog()
    {
        var gate = new TaskCompletionSource();
        var (tracker, _, _, _) = Make((_, _) => { gate.Task.Wait(TimeSpan.FromSeconds(10)); return Ack(); });
        tracker.Start();
        Assert.Null(tracker.TickInProgressSince);
        // On a pool thread: the scripted server blocks, and the tick may reach it
        // without yielding, which would block this test's own thread instead.
        var tick = Task.Run(tracker.TickAsync);
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (tracker.TickInProgressSince is null && DateTime.UtcNow < deadline) await Task.Delay(20);
        await Task.Delay(100);
        Assert.NotNull(tracker.TickInProgressSince);
        gate.SetResult();
        await tick;
        tracker.Stop();
        Assert.Null(tracker.TickInProgressSince);
    }

    [Fact]
    public async Task Drops_a_sample_the_api_rejects_instead_of_blocking()
    {
        var first = true;
        var (tracker, _, _, _) = Make((_, _) =>
        {
            if (first) { first = false; return FakeServer.Error(400, "VALIDATION_ERROR", "title must be shorter"); }
            return Ack();
        });
        tracker.Start();
        await tracker.TickAsync();
        await tracker.TickAsync();
        tracker.Stop();
        Assert.Equal(0, tracker.Pending);
    }

    [Fact]
    public async Task A_hung_probe_does_not_stall_sampling()
    {
        var (tracker, server, platform, _) = Make((_, _) => Ack());
        platform.ProbeDelay = TimeSpan.FromSeconds(8);
        tracker.Start();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        await tracker.TickAsync();
        tracker.Stop();
        Assert.True(sw.Elapsed < TimeSpan.FromSeconds(7), $"took {sw.Elapsed}");
        Assert.Equal(1, server.Count("POST activity/report"));
    }

    [Fact]
    public async Task Locked_means_idle_with_no_app()
    {
        var (tracker, server, platform, _) = Make((_, _) => Ack());
        platform.SetLocked(true);
        tracker.Start();
        await tracker.TickAsync();
        tracker.Stop();
        var body = JsonDocument.Parse(server.Calls.Last(c => c.Path == "activity/report").Body!).RootElement;
        Assert.True(body.GetProperty("locked").GetBoolean());
        Assert.True(body.GetProperty("idle").GetBoolean());
        Assert.False(body.TryGetProperty("app", out _));
    }

    [Fact]
    public async Task Reports_sleep_as_a_locked_sample_before_the_live_one()
    {
        var (tracker, server, platform, _) = Make((_, _) => Ack());
        tracker.Start();
        platform.NextSleep = TimeSpan.FromMinutes(42);
        await tracker.TickAsync();
        tracker.Stop();
        var reports = server.Calls.Where(c => c.Path == "activity/report").Select(c => JsonDocument.Parse(c.Body!).RootElement).ToList();
        Assert.Equal(2, reports.Count);
        Assert.True(reports[0].GetProperty("locked").GetBoolean());
        Assert.True(string.CompareOrdinal(reports[0].GetProperty("at").GetString(), reports[1].GetProperty("at").GetString()) < 0);
    }

    /// <summary>
    /// A backlog drain writes the queue every few samples and when it stops: a restart after
    /// a drain that stopped half way sends only what was not sent yet, in order.
    /// </summary>
    [Fact]
    public async Task A_drain_that_stops_half_way_keeps_exactly_what_was_not_sent()
    {
        var sent = 0;
        var (tracker, server, platform, api) = Make((_, _) => ++sent <= 13 ? Ack() : FakeServer.Html(503));
        var queue = new ActivityQueue(platform.Secrets, platform.DataDir, "u-2", NullLog.Instance);
        for (var i = 0; i < 20; i++) queue.Enqueue(new ActivityReport { At = $"2026-10-13T05:{i:00}:00.000Z" });
        var drainer = new ActivityTracker(api, platform, new AgentOptions().Normalised(), queue, NullLog.Instance);
        Assert.False(await drainer.DrainAsync(30, CancellationToken.None));
        Assert.Equal(7, queue.Count);

        // A new run reads the file: the 13 sent are gone, the 7 left start where it stopped.
        var again = new ActivityQueue(platform.Secrets, platform.DataDir, "u-2", NullLog.Instance);
        Assert.Equal(7, again.Count);
        Assert.Equal("2026-10-13T05:13:00.000Z", again.Peek()!.At);
        var lastSample = File.ReadAllText(Path.Combine(platform.DataDir, "last-sample.txt")).Trim();
        Assert.Equal("2026-10-13T05:12:00.000Z", lastSample);
        _ = tracker;
        _ = server;
    }

    /// <summary>
    /// After an offline run the queue holds samples newer than the last one sent: the stretch
    /// the agent was not running starts after the newest of them, not on top of them.
    /// </summary>
    [Fact]
    public async Task Time_away_since_an_offline_run_starts_after_its_last_queued_sample()
    {
        var online = false;
        var (tracker, server, platform, api) = Make((_, _) => online ? Ack() : FakeServer.Html(503));
        var now = DateTimeOffset.UtcNow;
        string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        // The last sample that reached the server was 3 hours ago; the earlier run kept
        // sampling offline until 2 hours ago, then the machine was off.
        File.WriteAllText(Path.Combine(platform.DataDir, "last-sample.txt"), Iso(now.AddHours(-3)));
        var queue = new ActivityQueue(platform.Secrets, platform.DataDir, "u-3", NullLog.Instance);
        var offlineLast = Iso(now.AddHours(-2));
        queue.Enqueue(new ActivityReport { At = Iso(now.AddHours(-2.5)) });
        queue.Enqueue(new ActivityReport { At = offlineLast });

        var next = new ActivityTracker(api, platform, new AgentOptions().Normalised(), queue, NullLog.Instance);
        next.Start();
        online = true;
        await next.TickAsync();
        next.Stop();
        var sentAt = server.Calls.Where(c => c.Path == "activity/report")
            .Select(c => JsonDocument.Parse(c.Body!).RootElement).Select(r => (At: r.GetProperty("at").GetString()!, Locked: r.TryGetProperty("locked", out var l) && l.GetBoolean())).ToList();
        Assert.Equal(4, sentAt.Count);
        Assert.Equal(offlineLast, sentAt[1].At);
        Assert.True(sentAt[2].Locked, "the time the agent was not running reads as away");
        Assert.True(string.CompareOrdinal(sentAt[2].At, offlineLast) > 0, $"away marker {sentAt[2].At} must follow the last offline sample {offlineLast}");
        Assert.Equal(sentAt.Select(s => s.At).OrderBy(x => x, StringComparer.Ordinal), sentAt.Select(s => s.At));
        _ = tracker;
    }

    [Fact]
    public async Task Passes_the_ack_on()
    {
        var (tracker, _, _, _) = Make((_, _) => Ack(shouldCapture: false, screenshots: false));
        ActivityAck? seen = null;
        tracker.Acknowledged += a => seen = a;
        tracker.Start();
        await tracker.TickAsync();
        tracker.Stop();
        Assert.NotNull(seen);
        Assert.False(seen!.ShouldCapture);
        Assert.False(seen.ScreenshotsEnabled);
    }
}
