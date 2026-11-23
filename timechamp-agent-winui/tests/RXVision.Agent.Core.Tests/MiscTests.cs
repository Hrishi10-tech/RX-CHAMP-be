using RXVision.Agent.Core.Activity;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Update;
using RXVision.Agent.Core.Util;
using Xunit;

namespace RXVision.Agent.Core.Tests;

public class MiscTests
{
    [Theory]
    [InlineData("3.0.1", "3.0.0", true)]
    [InlineData("3.0.0", "3.0.0", false)]
    [InlineData("v3.1.0", "3.0.9", true)]
    [InlineData("2.9.1", "3.0.0", false)]
    [InlineData("", "3.0.0", false)]
    [InlineData("3.0.0-beta", "2.9.1", true)]
    public void Compares_versions(string offered, string current, bool newer)
    {
        Assert.Equal(newer, UpdateService.IsNewer(offered, current));
    }

    [Fact]
    public void Backoff_grows_with_jitter_and_resets()
    {
        var b = new Backoff(TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(60), new Random(1));
        var delays = Enumerable.Range(0, 10).Select(_ => b.Next()).ToList();
        Assert.All(delays, d => Assert.InRange(d.TotalSeconds, 2, 60));
        Assert.True(delays.Skip(5).Max() > delays.Take(2).Max());
        b.Reset();
        Assert.InRange(b.Next().TotalSeconds, 2, 4);
    }

    [Fact]
    public void The_first_retry_is_already_spread_so_a_fleet_never_retries_in_step()
    {
        // Core review C-R05: attempt 0 used to be exactly the minimum, with no jitter at all.
        var firsts = Enumerable.Range(0, 20).Select(i => new Backoff(TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(60), new Random(i)).Next().TotalSeconds).ToList();
        Assert.All(firsts, d => Assert.InRange(d, 2, 4));
        Assert.True(firsts.Distinct().Count() > 10);
    }

    [Fact]
    public void Server_clock_learns_the_offset_and_smooths_jitter()
    {
        var local = new FixedClock(new DateTimeOffset(2026, 10, 13, 5, 0, 0, TimeSpan.Zero));
        var clock = new ServerClock(local);
        clock.Observe(local.UtcNow.AddMinutes(3), local.UtcNow, local.UtcNow);
        Assert.Equal(TimeSpan.FromMinutes(3), clock.Offset);
        clock.Observe(local.UtcNow.AddMinutes(3).AddSeconds(4), local.UtcNow, local.UtcNow);
        Assert.Equal(TimeSpan.FromMinutes(3).Add(TimeSpan.FromSeconds(1)), clock.Offset);
        Assert.Equal(local.UtcNow + clock.Offset, clock.UtcNow);
    }

    private sealed class FixedClock : IClock
    {
        public FixedClock(DateTimeOffset now) => UtcNow = now;
        public DateTimeOffset UtcNow { get; }
    }
}

/// <summary>The secret store with a time limit: late answers, failing fast, and the sample queue's key.</summary>
public class TimeBoundSecretStoreTests
{
    private sealed class GatedStore : RXVision.Agent.Core.Platform.ISecretStore
    {
        public readonly Dictionary<string, byte[]> Data = new();
        public ManualResetEventSlim Gate = new(true);
        public int Calls;
        public byte[]? Load(string key) { Interlocked.Increment(ref Calls); Gate.Wait(TimeSpan.FromSeconds(30)); lock (Data) return Data.TryGetValue(key, out var v) ? v : null; }
        public void Save(string key, byte[] data) { Interlocked.Increment(ref Calls); Gate.Wait(TimeSpan.FromSeconds(30)); lock (Data) Data[key] = data; }
        public void Delete(string key) { Interlocked.Increment(ref Calls); Gate.Wait(TimeSpan.FromSeconds(30)); lock (Data) Data.Remove(key); }
    }

    /// <summary>
    /// Seen end to end: at sign-in on a two-core machine the thread pool was busy for 20 to 30
    /// seconds, a store call queued on it ran over its limit, and every secret call then failed
    /// (the day, the journal and the queue could not be written). Calls run on their own thread.
    /// </summary>
    [Fact]
    public async Task A_busy_thread_pool_never_makes_a_quick_store_run_over()
    {
        var inner = new GatedStore();
        var store = new RXVision.Agent.Core.Platform.TimeBoundSecretStore(inner, TimeSpan.FromSeconds(1), NullLog.Instance);
        ThreadPool.GetMinThreads(out var workers, out _);
        using var release = new ManualResetEventSlim(false);
        var busy = Enumerable.Range(0, workers * 4 + 16).Select(_ => Task.Run(() => release.Wait(TimeSpan.FromSeconds(4)))).ToList();
        try
        {
            var watch = System.Diagnostics.Stopwatch.StartNew();
            store.Save("session", new byte[] { 1, 2 });
            Assert.Equal(new byte[] { 1, 2 }, store.Load("session"));
            Assert.False(store.Unanswered);
            Assert.InRange(watch.ElapsedMilliseconds, 0, 900);
        }
        finally
        {
            release.Set();
            await Task.WhenAll(busy).WaitAsync(TimeSpan.FromSeconds(10));
        }
    }

    [Fact]
    public async Task A_late_read_fails_later_calls_at_once_then_hands_its_answer_to_the_next_read()
    {
        var inner = new GatedStore();
        inner.Data["session"] = new byte[] { 7 };
        var store = new RXVision.Agent.Core.Platform.TimeBoundSecretStore(inner, TimeSpan.FromMilliseconds(200), NullLog.Instance);
        var answered = new TaskCompletionSource();
        store.Answered += () => answered.TrySetResult();

        inner.Gate.Reset();   // a prompt nobody has answered yet
        Assert.ThrowsAny<TimeoutException>(() => store.Load("session"));
        Assert.True(store.Unanswered);
        var watch = System.Diagnostics.Stopwatch.StartNew();
        Assert.ThrowsAny<TimeoutException>(() => store.Load("file-key"));   // fails at once, not queued behind it
        Assert.Throws<RXVision.Agent.Core.Platform.SecretStoreTimeoutException>(() => store.Save("x", new byte[] { 1 }));
        Assert.InRange(watch.ElapsedMilliseconds, 0, 150);
        // The first read is still out (its thread may not have reached the store yet on a busy machine).
        SpinWait.SpinUntil(() => inner.Calls == 1, TimeSpan.FromSeconds(5));
        Assert.Equal(1, inner.Calls);

        inner.Gate.Set();   // answered
        await answered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(store.Unanswered);
        Assert.Equal(new byte[] { 7 }, store.Load("session"));   // the late answer, not a second prompt
        Assert.Equal(1, inner.Calls);
        Assert.Null(store.Load("file-key"));                      // and the store answers again
    }

    [Fact]
    public async Task The_sample_queue_never_replaces_its_key_or_its_file_because_the_store_was_slow()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        var inner = new GatedStore();
        // The first run's store answers (a generous limit: a busy test machine is not a slow Keychain).
        var store = new RXVision.Agent.Core.Platform.TimeBoundSecretStore(inner, TimeSpan.FromSeconds(10), NullLog.Instance);
        var first = new ActivityQueue(store, dir, "u-1", NullLog.Instance);
        first.Enqueue(new ActivityReport { At = "2026-10-14T03:00:00.000Z", Kind = "live" });
        first.Enqueue(new ActivityReport { At = "2026-10-14T03:01:00.000Z", Kind = "live" });
        var key = inner.Data["file-key"].ToArray();
        var file = Path.Combine(dir, "queue-u1.bin");
        var saved = File.ReadAllBytes(file);

        // The next run: the Keychain prompts and nobody answers for a while.
        inner.Gate.Reset();
        var slow = new RXVision.Agent.Core.Platform.TimeBoundSecretStore(inner, TimeSpan.FromMilliseconds(200), NullLog.Instance);
        var answered = new TaskCompletionSource();
        slow.Answered += () => answered.TrySetResult();
        var queue = new ActivityQueue(slow, dir, "u-1", NullLog.Instance);
        Assert.Equal(0, queue.Count);
        queue.Enqueue(new ActivityReport { At = "2026-10-14T09:00:00.000Z", Kind = "live" });
        Assert.Equal(saved, File.ReadAllBytes(file));          // not overwritten unread
        Assert.Equal(key, inner.Data["file-key"]);             // no new key

        inner.Gate.Set();
        await answered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        queue.Enqueue(new ActivityReport { At = "2026-10-14T09:01:00.000Z", Kind = "live" });
        Assert.Equal(4, queue.Count);                          // the earlier run's two first
        Assert.Equal("2026-10-14T03:00:00.000Z", queue.Peek()!.At);
        Assert.Equal(key, inner.Data["file-key"]);
        Assert.Equal(4, new ActivityQueue(slow, dir, "u-1", NullLog.Instance).Count);
    }
}

/// <summary>Security review S-02 and S-04, as a release build applies them.</summary>
public class ReleaseOptionsTests
{
    private static readonly string[] Release = { "api.rxvision.shop" };

    [Theory]
    [InlineData("https://api.rxvision.shop/api/v1", "https://api.rxvision.shop/api/v1")]
    [InlineData("https://API.rxvision.shop/api/v1/", "https://api.rxvision.shop/api/v1")]
    [InlineData("https://rxvision-support.example/api/v1", null)]
    [InlineData("http://api.rxvision.shop/api/v1", null)]
    [InlineData("http://localhost:4000/api/v1", null)]
    [InlineData("https://api.rxvision.shop.evil.example/api/v1", null)]
    public void A_release_build_talks_only_to_its_own_server(string raw, string? expected) =>
        Assert.Equal(expected, RXVision.Agent.Core.Config.AgentOptions.NormaliseUrl(raw, allowInsecure: true, Release));

    [Fact]
    public void A_setup_code_for_another_server_is_refused_by_the_same_rule()
    {
        var json = "{\"ApiBaseUrl\":\"https://rxvision-support.example/api/v1\",\"EnrollmentToken\":\"x\"}";
        var code = "RXV1." + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        Assert.Null(RXVision.Agent.Core.Config.AgentOptions.NormaliseUrl("https://rxvision-support.example/api/v1", false, Release));
        // Debug builds (this test run) still accept it, so tests and local runs keep working.
        Assert.NotNull(RXVision.Agent.Core.Config.Enrollment.FromSetupCode(code, "https://api.rxvision.shop/api/v1"));
    }

    [Fact]
    public void A_release_build_takes_only_check_timings_from_the_local_file()
    {
        var file = new RXVision.Agent.Core.Config.AgentOptions
        {
            ApiBaseUrl = "https://elsewhere.example/api/v1", ScreenshotMinutes = 60, IdleThresholdSeconds = 900,
            HeartbeatSeconds = 300, AutoUpdate = false, AllowInsecureHttp = true, ActivitySeconds = 90, UpdateCheckMinutes = 30,
        };
        var used = RXVision.Agent.Core.Config.AgentOptions.FromLocalFile(file, locked: true);
        var defaults = new RXVision.Agent.Core.Config.AgentOptions();
        Assert.Equal(defaults.ApiBaseUrl, used.ApiBaseUrl);
        Assert.Equal(defaults.ScreenshotMinutes, used.ScreenshotMinutes);
        Assert.Equal(defaults.IdleThresholdSeconds, used.IdleThresholdSeconds);
        Assert.Equal(defaults.HeartbeatSeconds, used.HeartbeatSeconds);
        Assert.True(used.AutoUpdate);
        Assert.False(used.AllowInsecureHttp);
        Assert.Equal(90, used.ActivitySeconds);
        Assert.Equal(30, used.UpdateCheckMinutes);
    }
}

/// <summary>Review AG-2: the hosts a build may talk to come from the build, never from the PC.</summary>
public class BuiltInHostsTests
{
    [Fact]
    public void With_nothing_set_a_build_talks_to_production_alone()
    {
        Assert.Equal(new[] { "api.rxvision.shop" }, RXVision.Agent.Core.Config.AgentOptions.ParseHosts(null));
        Assert.Equal(new[] { "api.rxvision.shop" }, RXVision.Agent.Core.Config.AgentOptions.ParseHosts("  "));
        Assert.True(RXVision.Agent.Core.Config.AgentOptions.BuiltForProductionOnly);
        Assert.Equal(RXVision.Agent.Core.Config.AgentOptions.DefaultApiBaseUrl, RXVision.Agent.Core.Config.AgentOptions.BuiltInApiBaseUrl);
    }

    [Fact]
    public void A_build_made_for_staging_lists_exactly_the_hosts_it_was_given()
    {
        Assert.Equal(
            new[] { "staging.rxvision.shop", "api.rxvision.shop" },
            RXVision.Agent.Core.Config.AgentOptions.ParseHosts("Staging.rxvision.shop, api.rxvision.shop;staging.rxvision.shop"));
    }

    [Theory]
    [InlineData("https://evil.example/api")]
    [InlineData("*.rxvision.shop")]
    [InlineData("10.0.0.5")]
    [InlineData("localhost")]
    [InlineData("api.rxvision.shop:8443")]
    public void What_is_not_a_plain_host_name_is_never_allowed(string raw)
    {
        Assert.Equal(new[] { "api.rxvision.shop" }, RXVision.Agent.Core.Config.AgentOptions.ParseHosts(raw));
    }
}

/// <summary>
/// Core review C-R03: the Windows build cannot read IANA zone ids (invariant globalization), so
/// a day without break slots must still be in the business zone, never the PC's own.
/// </summary>
public class BusinessZoneTests
{
    // A machine that knows only Windows zone names, as Windows does without ICU.
    private static TimeZoneInfo WindowsOnly(string id) =>
        id.Contains('/') ? throw new TimeZoneNotFoundException(id) : TimeZoneInfo.CreateCustomTimeZone(id, TimeSpan.FromHours(-6), id, id);

    [Fact]
    public void India_is_five_and_a_half_hours_ahead_without_a_zone_database()
    {
        var at = new DateTimeOffset(2026, 11, 18, 3, 0, 0, TimeSpan.Zero);
        Assert.Equal(new TimeSpan(5, 30, 0), RXVision.Agent.Core.Util.BusinessClock.ZoneOffset("Asia/Kolkata", at, WindowsOnly));
    }

    [Fact]
    public void A_summer_time_zone_goes_through_its_Windows_name()
    {
        var at = new DateTimeOffset(2026, 11, 18, 3, 0, 0, TimeSpan.Zero);
        Assert.Equal(TimeSpan.FromHours(-6), RXVision.Agent.Core.Util.BusinessClock.ZoneOffset("America/Chicago", at, WindowsOnly));
    }

    [Fact]
    public void An_unknown_zone_says_so_and_the_machine_zone_is_the_last_resort()
    {
        var at = new DateTimeOffset(2026, 11, 18, 3, 0, 0, TimeSpan.Zero);
        Assert.Null(RXVision.Agent.Core.Util.BusinessClock.ZoneOffset("Mars/Olympus", at, WindowsOnly));
    }
}
