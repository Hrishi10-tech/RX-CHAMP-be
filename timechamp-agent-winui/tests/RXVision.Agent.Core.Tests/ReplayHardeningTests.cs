using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using RXVision.Agent.Core.Activity;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>
/// The 4.0 server's answers to replayed actions after the second audit: final refusals about the
/// day itself (said once each, then the day read again), End Day's list of the auto-skips it would
/// make (answered by exactly their ids, also for an End Day done offline), and the per-person
/// limit on samples (paced, 429 honoured, nothing dropped).
/// </summary>
public class ReplayHardeningTests
{
    private static object Skip(string id, string kind) => new
    {
        id, date = HostHarness.Today, kind, label = kind == "LUNCH" ? "Lunch break" : kind == "MORNING" ? "Morning break" : "Evening break",
        outcome = "AUTO_SKIPPED", skippedAt = DateTimeOffset.UtcNow.AddHours(-1).ToString("o"), minChars = 10,
    };

    /// <summary>The lunch auto-skip End Day will make, with the id the server says it will get (it does not exist yet).</summary>
    private const string Planned = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    [Theory]
    [InlineData(409, "DAY_ENDED", "Your working day has already ended. Press Start Day to resume.", "Your day had already ended by then.")]
    [InlineData(409, "DAY_NOT_STARTED", "Your day has not started. Press Start Day first.", "Your day wasn't running then.")]
    [InlineData(409, "MONTH_LOCKED", "2026-10 is locked for payroll.", "That day's month is closed for payroll; ask your Admin.")]
    [InlineData(422, "EVENT_TIME_INVALID", "The action is more than 7 days old.", "The action is more than 7 days old.")]
    public async Task A_refusal_about_the_day_is_said_once_for_all_its_actions_and_the_day_read_again(int status, string code, string serverSays, string said)
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        // A plain break and its end on a day the server no longer has open (presence start and end
        // replay at their own time), and a meeting logged that day: all refused the same way.
        h.Server.Route("POST presence/start", (_, _) => FakeServer.Error(status, code, serverSays));
        h.Server.Route("POST presence/end", (_, _) => FakeServer.Error(status, code, serverSays));
        h.Server.Route("POST meetings/past", (_, _) => FakeServer.Error(status, code, serverSays));
        var told = new List<string>();
        h.Host.ActionRefused += m => { lock (told) told.Add(m); };
        await h.SignInAsync();

        h.Server.FailWith = _ => new HttpRequestException("no network");
        h.Host.ImmediateWait = TimeSpan.Zero;
        Assert.IsType<StartOutcome.Started>(await h.Host.TakeFreeBreakAsync(PresenceStatus.Break));
        await Task.Delay(20);
        await h.Host.BackToWorkAsync();
        Assert.IsType<MeetingOutcome.Logged>(await h.Host.LogPastMeetingAsync(DateTimeOffset.UtcNow.AddMinutes(-30), 10, "Stand-up",
            Array.Empty<MeetingParticipant>(), "Ravi"));
        Assert.Equal(3, h.Host.PendingActions);

        var reads = h.Server.Count("GET workday/me/today");
        var tries = h.Server.Count("POST presence/start");   // the offline tries never reached it
        h.Server.FailWith = _ => null;
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(20)));
        await Task.Delay(300);
        Assert.Equal(tries + 1, h.Server.Count("POST presence/start"));   // final: never sent again
        await HostHarness.WaitFor(() => { lock (told) return told.Count >= 1; });
        await HostHarness.WaitFor(() => h.Server.Count("GET workday/me/today") > reads);   // the day read again
        await Task.Delay(300);
        lock (told)
        {
            var notice = Assert.Single(told);
            Assert.StartsWith("Starting your break on ", notice);
            Assert.EndsWith(" couldn't be saved. " + said, notice);
        }
    }

    [Fact]
    public async Task End_Day_answers_the_servers_list_by_its_ids_auto_skips_it_will_make_included()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN", skips: new[] { Skip("b-1", "MORNING") }));
        var bodies = new List<string>();
        h.Server.Route("POST activity/end-day", (_, body) =>
        {
            lock (bodies) bodies.Add(body ?? "{}");
            using var doc = JsonDocument.Parse(body ?? "{}");
            var ids = doc.RootElement.TryGetProperty("comments", out var c) ? c.EnumerateArray().Select(x => x.GetProperty("breakId").GetString()).ToHashSet() : new HashSet<string?>();
            if (ids.Contains("b-1") && ids.Contains(Planned))
            {
                h.Workday = () => FakeServer.Ok(HostHarness.Day("ENDED"));
                return FakeServer.Ok(new { ok = true, date = HostHarness.Today, endedAt = DateTimeOffset.UtcNow.ToString("o"), workday = HostHarness.Day("ENDED") });
            }
            // Judged before anything is written: the skip waiting, and the lunch auto-skip this End Day would make.
            return FakeServer.Error(409, "SKIP_COMMENTS_REQUIRED", "Add a comment to each of your 2 skipped breaks before you end the day.",
                new { breaks = new[] { Skip("b-1", "MORNING"), Skip(Planned, "LUNCH") } });
        });
        await h.SignInAsync();

        var asked = Assert.IsType<EndDayOutcome.CommentsRequired>(await h.Host.EndDayAsync(new[] { new SkipComment("b-1", "Client call all morning") }));
        Assert.Equal(new[] { "b-1", Planned }, asked.Breaks.Select(b => b.Id));
        Assert.Equal(AgentState.Running, h.Host.State);
        // Not looked up anywhere first: the day the agent has knows nothing of it.
        Assert.DoesNotContain(h.Host.Workday!.SkipsNeedingComment, s => s.Id == Planned);

        var comments = asked.Breaks.Select(b => new SkipComment(b.Id, $"Client call during the {b.Label}")).ToList();
        Assert.IsType<EndDayOutcome.Ended>(await h.Host.EndDayAsync(comments));
        using var last = JsonDocument.Parse(bodies[^1]);
        Assert.Equal(new[] { "b-1", Planned }, last.RootElement.GetProperty("comments").EnumerateArray().Select(c => c.GetProperty("breakId").GetString()));
        Assert.Equal(AgentState.DayEnded, h.Host.State);
    }

    [Fact]
    public async Task An_End_Day_done_offline_and_refused_for_comments_is_held_then_ends_the_day_at_its_time()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        h.Server.Route("POST activity/end-day", (_, body) =>
        {
            using var doc = JsonDocument.Parse(body ?? "{}");
            if (doc.RootElement.TryGetProperty("comments", out var c) && c.ValueKind == JsonValueKind.Array
                && c.EnumerateArray().Any(x => x.GetProperty("breakId").GetString() == Planned))
            {
                h.Workday = () => FakeServer.Ok(HostHarness.Day("ENDED"));
                return FakeServer.Ok(new { ok = true, date = HostHarness.Today, endedAt = DateTimeOffset.UtcNow.ToString("o") });
            }
            return FakeServer.Error(409, "SKIP_COMMENTS_REQUIRED", "Add a comment to your skipped break before you end the day.",
                new { breaks = new[] { Skip(Planned, "LUNCH") } });
        });
        var told = new List<string>();
        var held = new List<HeldEndDay>();
        h.Host.ActionRefused += m => { lock (told) told.Add(m); };
        h.Host.EndDayHeld += x => { lock (held) held.Add(x); };
        await h.SignInAsync();

        // Offline: End Day stands at once.
        h.Server.FailWith = _ => new HttpRequestException("no network");
        h.Host.ImmediateWait = TimeSpan.Zero;
        Assert.IsType<EndDayOutcome.Ended>(await h.Host.EndDayAsync());
        Assert.Equal(AgentState.DayEnded, h.Host.State);
        await HostHarness.WaitFor(() => h.Server.Sent.Any(x => x.Key == "POST activity/end-day"));   // tried, no network
        var endedAt = h.Server.Sent.Last(x => x.Key == "POST activity/end-day").EventAt;

        // Back: the server wants a comment for the lunch auto-skip End Day would make. The End Day
        // is held (no plain notice: the comments are asked for), and the day, open on the server, runs.
        await Task.Delay(1100);
        h.Server.FailWith = _ => null;
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(20)));
        await HostHarness.WaitFor(() => { lock (held) return held.Count == 1; });
        var waiting = h.Host.HeldEndDay;
        Assert.NotNull(waiting);
        Assert.Equal(Planned, Assert.Single(waiting!.Breaks).Id);
        Assert.Equal(endedAt, ApiClient.Iso(waiting.At));
        await HostHarness.WaitFor(() => h.Host.State == AgentState.Running);
        lock (told) Assert.Empty(told);

        // The comment: End Day again at the time the person ended the day, keyed by that id.
        var outcome = await h.Host.EndDayAsync(new[] { new SkipComment(Planned, "Client call ran through lunch") }, waiting.At);
        Assert.IsType<EndDayOutcome.Ended>(outcome);
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(20)));
        var again = h.Server.Sent.Last(x => x.Key == "POST activity/end-day");
        Assert.Equal(endedAt, again.EventAt);
        using (var body = JsonDocument.Parse(again.Body!))
        {
            var c = Assert.Single(body.RootElement.GetProperty("comments").EnumerateArray());
            Assert.Equal(Planned, c.GetProperty("breakId").GetString());
            Assert.Equal("Client call ran through lunch", c.GetProperty("comment").GetString());
        }
        Assert.Null(h.Host.HeldEndDay);
        Assert.Equal(AgentState.DayEnded, h.Host.State);
    }

    [Fact]
    public async Task A_held_End_Day_is_dropped_when_the_day_goes_on()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        h.Server.Route("POST activity/end-day", (_, _) => FakeServer.Error(409, "SKIP_COMMENTS_REQUIRED", "Add a comment.",
            new { breaks = new[] { Skip(Planned, "LUNCH") } }));
        h.Server.Route("POST breaks/quick/start", (_, _) => FakeServer.Ok(new
        {
            record = new { id = "q-1", kind = "QUICK", label = "Quick break", presenceType = "BREAK", plannedMin = 5, startedAt = DateTimeOffset.UtcNow.ToString("o"), inProgress = true, state = "ACTIVE" },
        }));
        await h.SignInAsync();
        h.Server.FailWith = _ => new HttpRequestException("no network");
        h.Host.ImmediateWait = TimeSpan.Zero;
        await h.Host.EndDayAsync();
        h.Server.FailWith = _ => null;
        await h.Host.SyncNowAsync(TimeSpan.FromSeconds(20));
        await HostHarness.WaitFor(() => h.Host.HeldEndDay is not null && h.Host.State == AgentState.Running);

        // A quick break after it: the person kept working, so that End Day is not what they want.
        await h.Host.QuickBreakAsync(5);
        Assert.Null(h.Host.HeldEndDay);
    }

    // ---- Samples under the per-person limit -------------------------------------------------

    private static string Iso(DateTimeOffset t) => t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private static HttpResponseMessage TooMany(int retryAfterSec)
    {
        var res = new HttpResponseMessage((HttpStatusCode)429)
        {
            Content = new StringContent("""{"success":false,"message":"Too many requests","error":{"code":"RATE_LIMITED","message":"Too many requests"}}""",
                Encoding.UTF8, "application/json"),
        };
        res.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(retryAfterSec));
        return res;
    }

    private static (ActivityTracker Tracker, ActivityQueue Queue, FakeServer Server, Func<DateTimeOffset> Now, Action<TimeSpan> Advance) Backlog(
        int samples, Func<int, HttpResponseMessage?>? answer = null)
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var server = new FakeServer();
        var calls = 0;
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        server.Route("POST activity/report", (_, _) =>
            answer?.Invoke(Interlocked.Increment(ref calls)) ?? FakeServer.Ok(new { activeSec = 60, shouldCapture = true, screenshotsEnabled = true }));
        var api = new ApiClient("https://api.example.com/api/v1", new AgentIdentity("4.0.0", "dev", "d"), new SessionStore(platform.Secrets), new ServerClock(), NullLog.Instance, server);
        api.LoginAsync("a@x.test", "pw").GetAwaiter().GetResult();
        var queue = new ActivityQueue(platform.Secrets, platform.DataDir, "u-1", NullLog.Instance);
        var now = DateTimeOffset.UtcNow;
        queue.Pacer.Clock = () => now;
        var start = now.AddDays(-6);
        for (var i = 0; i < samples; i++) queue.Enqueue(new ActivityReport { At = Iso(start.AddMinutes(i)), App = "Code" });
        return (new ActivityTracker(api, platform, new AgentOptions().Normalised(), queue, NullLog.Instance), queue, server, () => now, by => now += by);
    }

    [Fact]
    public async Task A_long_backlog_goes_at_the_servers_pace_oldest_first_and_none_is_dropped()
    {
        const int samples = 1050;
        var (tracker, queue, server, _, advance) = Backlog(samples);
        var perMinute = new List<int>();
        var minutes = 0;
        while (queue.Count > 0)
        {
            var before = server.Count("POST activity/report");
            // Every drain there is in a minute (a tick, the timer, the batch after the journal, a flush) shares the pace.
            await tracker.DrainAsync(ActivityTracker.DrainPerTick, CancellationToken.None);
            await tracker.DrainAsync(ActivityTracker.DrainPerTick, CancellationToken.None);
            await tracker.FlushAsync(TimeSpan.FromSeconds(5));
            perMinute.Add(server.Count("POST activity/report") - before);
            advance(TimeSpan.FromMinutes(1));
            Assert.True(++minutes < 30, "the backlog never drained");
        }
        Assert.All(perMinute, n => Assert.InRange(n, 0, SendPacer.PerMinute));
        Assert.Equal(samples, server.Count("POST activity/report"));   // each sent once: none dropped, none twice
        Assert.Equal((int)Math.Ceiling(samples / (double)SendPacer.PerMinute), minutes);
        var sent = server.Calls.Where(c => c.Path == "activity/report").Select(c => JsonDocument.Parse(c.Body!).RootElement.GetProperty("at").GetString()).ToList();
        Assert.Equal(sent.OrderBy(x => x, StringComparer.Ordinal), sent);
        // A whole week at one a minute (10,080) goes in about 101 minutes at this pace, well inside the
        // server's 7 days, and under its 120 a minute per person.
        Assert.True(SendPacer.PerMinute < 120);
        Assert.True(Math.Ceiling(7 * 24 * 60 / (double)SendPacer.PerMinute) <= 101);
    }

    [Fact]
    public async Task Too_many_waits_as_the_server_says_and_keeps_the_sample()
    {
        var (tracker, queue, server, now, advance) = Backlog(12, n => n == 5 ? TooMany(30) : null);
        Assert.False(await tracker.DrainAsync(ActivityTracker.DrainPerTick, CancellationToken.None));
        Assert.Equal(5, server.Count("POST activity/report"));
        Assert.Equal(8, queue.Count);   // four sent; the refused one is still first in line
        Assert.Equal(now() + TimeSpan.FromSeconds(30), queue.Pacer.NextAllowed);

        // Within the wait nothing is asked.
        advance(TimeSpan.FromSeconds(20));
        Assert.False(await tracker.DrainAsync(ActivityTracker.DrainPerTick, CancellationToken.None));
        Assert.Equal(5, server.Count("POST activity/report"));

        // After it, the rest goes, starting with the one that was turned away.
        advance(TimeSpan.FromSeconds(11));
        Assert.True(await tracker.DrainAsync(ActivityTracker.DrainPerTick, CancellationToken.None));
        var ats = server.Calls.Where(c => c.Path == "activity/report").Select(c => JsonDocument.Parse(c.Body!).RootElement.GetProperty("at").GetString()).ToList();
        Assert.Equal(ats[4], ats[5]);
        Assert.Equal(13, ats.Count);
        Assert.Equal(12, ats.Distinct().Count());
    }

    [Fact]
    public async Task Retry_After_is_read_in_seconds_or_as_a_date()
    {
        var seconds = await ResultReader.ReadAsync<JsonElement>(TooMany(45), CancellationToken.None);
        Assert.Equal((ApiOutcome.Transient, 429, (TimeSpan?)TimeSpan.FromSeconds(45)), (seconds.Outcome, seconds.Status, seconds.RetryAfter));
        var dated = TooMany(1);
        dated.Headers.RetryAfter = new RetryConditionHeaderValue(DateTimeOffset.UtcNow.AddMinutes(2));
        var at = (await ResultReader.ReadAsync<JsonElement>(dated, CancellationToken.None)).RetryAfter;
        Assert.NotNull(at);
        Assert.InRange(at!.Value.TotalSeconds, 110, 121);
        Assert.Null((await ResultReader.ReadAsync<JsonElement>(FakeServer.Error(409, "ON_BREAK", "x"), CancellationToken.None)).RetryAfter);

        // The pacer: a pause with no wait named is a minute.
        var pacer = new SendPacer();
        var now = DateTimeOffset.UtcNow;
        pacer.Clock = () => now;
        pacer.Pause(null);
        Assert.Equal(now + SendPacer.DefaultPause, pacer.NextAllowed);
        Assert.False(pacer.TryTake());
    }
}
