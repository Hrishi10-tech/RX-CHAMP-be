using System.Text;
using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Offline;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Util;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>The journal on disk (SPEC 6): durable, encrypted, in order, and safe against a crash mid-write.</summary>
public class JournalTests
{
    private static (Journal Journal, DevPlatform Platform, string Path) New()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var path = Path.Combine(platform.DataDir, "journal-test.bin");
        var journal = new Journal(platform.Secrets, path, NullLog.Instance);
        Assert.True(journal.Load());
        return (journal, platform, path);
    }

    private static Journal Reopen(DevPlatform platform, string path)
    {
        var journal = new Journal(platform.Secrets, path, NullLog.Instance);
        Assert.True(journal.Load());
        return journal;
    }

    private static JournalEvent Event(string kind, int seq, string? comment = null) => new()
    {
        Kind = kind,
        At = DateTimeOffset.UtcNow.AddMinutes(seq),
        Seq = seq,
        Payload = new EventPayload { BreakKind = "MORNING", Comment = comment },
    };

    [Fact]
    public void Every_action_is_on_disk_in_order_and_unreadable_without_the_key()
    {
        var (journal, platform, path) = New();
        var events = new[] { Event(EventKinds.StartDay, 1), Event(EventKinds.BreakSkip, 2, "Client call about the invoice"), Event(EventKinds.EndDay, 3) };
        foreach (var e in events) Assert.True(journal.Append(e));

        // A new process (the crash, the restart) reads the same actions back.
        var again = Reopen(platform, path);
        Assert.Equal(events.Select(e => e.Id), again.Pending.Select(e => e.Id));
        Assert.Equal(new[] { 1L, 2L, 3L }, again.Pending.Select(e => (long)e.Seq));
        Assert.Equal("Client call about the invoice", again.Pending[1].Payload.Comment);

        var raw = Encoding.UTF8.GetString(File.ReadAllBytes(path));
        Assert.DoesNotContain("Client call", raw);
        Assert.DoesNotContain("START_DAY", raw);
    }

    [Fact]
    public void A_crash_in_the_middle_of_a_write_keeps_every_action_before_it()
    {
        var (journal, platform, path) = New();
        var first = Event(EventKinds.StartDay, 1);
        var second = Event(EventKinds.BreakQuick, 2);
        journal.Append(first);
        journal.Append(second);
        journal.Append(Event(EventKinds.BreakEnd, 3));

        // The last record is cut short, as a power cut during the write leaves it.
        var bytes = File.ReadAllBytes(path);
        File.WriteAllBytes(path, bytes[..^7]);

        var again = Reopen(platform, path);
        Assert.Equal(new[] { first.Id, second.Id }, again.Pending.Select(e => e.Id));

        // The torn tail is gone from the file: what comes next reads back cleanly.
        var third = Event(EventKinds.BreakEnd, 4);
        again.Append(third);
        Assert.Equal(new[] { first.Id, second.Id, third.Id }, Reopen(platform, path).Pending.Select(e => e.Id));
    }

    [Fact]
    public void A_half_written_length_at_the_end_is_ignored()
    {
        var (journal, platform, path) = New();
        var only = Event(EventKinds.StartDay, 1);
        journal.Append(only);
        using (var stream = new FileStream(path, FileMode.Append)) stream.Write(new byte[] { 0x2A, 0x00 });
        Assert.Equal(new[] { only.Id }, Reopen(platform, path).Pending.Select(e => e.Id));
    }

    [Fact]
    public void Done_actions_leave_the_journal_and_an_empty_journal_leaves_no_file()
    {
        var (journal, platform, path) = New();
        var a = Event(EventKinds.StartDay, 1);
        var b = Event(EventKinds.BreakQuick, 2);
        journal.Append(a);
        journal.Append(b);
        journal.Remove(a.Id);
        Assert.Equal(new[] { b.Id }, Reopen(platform, path).Pending.Select(e => e.Id));
        journal.Remove(b.Id);
        Assert.False(File.Exists(path));
        Assert.Empty(Reopen(platform, path).Pending);
    }

    [Fact]
    public void Many_acknowledgements_are_compacted_away()
    {
        var (journal, platform, path) = New();
        var keep = Event(EventKinds.EndDay, 999);
        journal.Append(keep);
        for (var i = 0; i < 80; i++)
        {
            var e = Event(EventKinds.BreakQuick, i);
            journal.Append(e);
            journal.Remove(e.Id);
        }
        Assert.Equal(new[] { keep.Id }, Reopen(platform, path).Pending.Select(e => e.Id));
        // 161 records written; compacted down to the one left plus what came after the last rewrite.
        Assert.True(new FileInfo(path).Length < 12_000, $"rewritten with only what is left ({new FileInfo(path).Length} bytes)");
    }
}

/// <summary>Replaying the journal (SPEC 6): one at a time, oldest first, each with its own id and time.</summary>
public class ReplayTests
{
    [Theory]
    // What the 4.0 server answers (seen end to end against it).
    [InlineData("""{"record":{"id":"q-1","kind":"QUICK"},"presence":{"status":"BREAK"}}""", "q-1")]
    [InlineData("""{"meeting":{"id":"m-1","momSender":"Neha"},"presence":{"status":"MEETING"}}""", "m-1")]
    [InlineData("""{"kind":"BREAK","break":{"id":"b-1","kind":"QUICK"},"presence":{"status":"BREAK"}}""", "b-1")]
    [InlineData("""{"kind":"AWAY","away":{"id":"a-1","status":"PENDING"}}""", "a-1")]
    [InlineData("""{"id":"l-1","kind":"LUNCH","state":"PAUSED"}""", "l-1")]
    // What SPEC 5.6 names for an away answer.
    [InlineData("""{"kind":"AWAY","event":{"id":"e-1"}}""", "e-1")]
    [InlineData("""{"ended":true,"record":null}""", null)]
    public void The_created_id_is_read_from_every_answer_shape(string json, string? id)
    {
        using var doc = JsonDocument.Parse(json);
        Assert.Equal(id, EventRequests.CreatedId(doc.RootElement));
    }

    /// <summary>
    /// Seen end to end: once the server took a quick break or a meeting, the day shows the
    /// server's id at once (before the day is read again), so anything handed that id (a
    /// pause, the portal, a second device) names the same thing the server has.
    /// </summary>
    [Fact]
    public async Task What_the_server_took_shows_with_the_servers_id_before_the_day_is_read_again()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        h.Server.Route("POST breaks/quick/start", (_, _) => FakeServer.Ok(new { record = QuickRecord("q-server", DateTimeOffset.UtcNow, 5) }));
        h.Server.Route("POST breaks/end", (_, _) => FakeServer.Ok(new { ended = true }));
        h.Server.Route("POST meetings/start", (_, _) => FakeServer.Ok(new { meeting = new { id = "m-server", mode = "LIVE", agenda = "Sync", startedAt = DateTimeOffset.UtcNow.ToString("o"), inProgress = true } }));
        h.Server.Route("POST meetings/past", (_, _) => FakeServer.Ok(new { meeting = new { id = "p-server", mode = "PAST" } }));
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Host.BreakDay is not null && h.Host.State == AgentState.Running);
        // The day is not read again meanwhile (its answers are refused, with the server still
        // there: a 5xx would read as offline, where the local result stands at once): only the
        // actions' answers count.
        h.Server.Route("GET breaks/me/today", (_, _) => FakeServer.Error(409, "BUSY", "Try again."));
        h.Server.Route("GET meetings/me/today", (_, _) => FakeServer.Error(409, "BUSY", "Try again."));

        var quick = Assert.IsType<ActionOutcome.Done>(await h.Host.QuickBreakAsync(5));
        Assert.Equal("q-server", quick.Record?.Id);
        Assert.Equal("q-server", h.Host.BreakPanel.Active?.Id);
        Assert.IsType<EndOutcome.Ended>(await h.Host.BackToWorkAsync());
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(10)));

        var started = Assert.IsType<MeetingOutcome.Started>(await h.Host.StartMeetingAsync("Sync", Array.Empty<MeetingParticipant>(), "Ravi"));
        Assert.Equal("m-server", started.Meeting?.Id);
        Assert.Equal("m-server", h.Host.LiveMeeting?.Id);
        var logged = Assert.IsType<MeetingOutcome.Logged>(await h.Host.LogPastMeetingAsync(DateTimeOffset.UtcNow.AddMinutes(-100), 10, "Earlier",
            Array.Empty<MeetingParticipant>(), "Ravi"));
        Assert.Equal("p-server", logged.Meeting?.Id);
    }

    private static object QuickRecord(string id, DateTimeOffset at, int planned) =>
        new { id, kind = "QUICK", label = "Quick break", presenceType = "BREAK", startedAt = at.ToString("o"), inProgress = true, plannedMin = planned, state = "ACTIVE" };

    [Fact]
    public async Task Offline_actions_replay_in_order_with_their_ids_and_times_and_a_retry_repeats_the_same_id()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        var quickCount = 0;
        var failNextQuick = true;
        h.Server.Route("POST breaks/quick/start", (req, _) =>
        {
            // The first quick break reaches the server, is stored, and the answer is lost on the way back.
            if (failNextQuick)
            {
                failNextQuick = false;
                return FakeServer.Html(502);
            }
            quickCount++;
            return FakeServer.Ok(new { record = QuickRecord("q-" + quickCount, DateTimeOffset.UtcNow, 5) });
        });
        h.Server.Route("POST breaks/end", (_, _) => FakeServer.Ok(new { ended = true }));
        await h.SignInAsync();

        // Offline: three actions, shown at once, kept in order.
        h.Server.FailWith = _ => new HttpRequestException("no network");
        h.Host.ImmediateWait = TimeSpan.Zero;
        Assert.IsType<ActionOutcome.Done>(await h.Host.QuickBreakAsync(5));
        Assert.True(h.Host.BreakPanel.Active!.IsQuick);
        await Task.Delay(20);
        Assert.IsType<EndOutcome.Ended>(await h.Host.BackToWorkAsync());
        Assert.Null(h.Host.BreakPanel.Active);
        await Task.Delay(20);
        Assert.IsType<ActionOutcome.Done>(await h.Host.QuickBreakAsync(10));
        Assert.Equal(3, h.Host.PendingActions);
        Assert.False(h.Host.Online);

        // Back online: everything goes, oldest first; the lost answer is retried with the same id.
        var offlineTries = h.Server.Sent.Count;
        h.Server.FailWith = _ => null;
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(20)));
        var replayed = h.Server.Sent.Skip(offlineTries).Where(x => x.EventId is not null).ToList();
        Assert.Equal(new[] { "POST breaks/quick/start", "POST breaks/quick/start", "POST breaks/end", "POST breaks/quick/start" },
            replayed.Select(x => x.Key));
        Assert.Equal(replayed[0].EventId, replayed[1].EventId);              // the retry: the same action
        Assert.Equal(3, replayed.Select(x => x.EventId).Distinct().Count()); // three actions in all
        var times = replayed.Skip(1).Select(x => DateTimeOffset.Parse(x.EventAt!)).ToList();
        Assert.Equal(times.OrderBy(t => t), times);                          // each with the time it happened
        Assert.True(times[0] < times[1] && times[1] < times[2]);
        var seqs = replayed.Skip(1).Select(x => long.Parse(x.Seq!)).ToList();
        Assert.Equal(seqs.OrderBy(s => s), seqs);
        using (var body = JsonDocument.Parse(replayed[^1].Body!))
            Assert.Equal(10, body.RootElement.GetProperty("plannedMin").GetInt32());
        Assert.Equal(0, h.Host.PendingActions);
    }

    [Fact]
    public async Task A_refusal_is_dropped_and_said_once_and_what_came_after_still_goes()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        h.Server.Route("POST breaks/quick/start", (_, _) => FakeServer.Error(409, "ON_BREAK", "You're already on a break."));
        h.Server.Route("POST meetings/past", (_, _) => FakeServer.Ok(new { meeting = new { id = "p-1", mode = "PAST" } }));
        h.Server.Route("POST breaks/end", (_, _) => FakeServer.Ok(new { ended = true }));
        var told = new List<string>();
        h.Host.ActionRefused += m => { lock (told) told.Add(m); };
        await h.SignInAsync();

        h.Server.FailWith = _ => new HttpRequestException("no network");
        h.Host.ImmediateWait = TimeSpan.Zero;
        await h.Host.QuickBreakAsync(5);
        await h.Host.BackToWorkAsync();   // acts on the quick break the server will refuse
        Assert.IsType<MeetingOutcome.Logged>(await h.Host.LogPastMeetingAsync(DateTimeOffset.UtcNow.AddMinutes(-30), 10, "Stand-up",
            Array.Empty<MeetingParticipant>(), "Ravi"));
        Assert.Equal(3, h.Host.PendingActions);

        h.Server.FailWith = _ => null;
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(20)));
        Assert.Equal(1, h.Server.Count("POST meetings/past"));
        Assert.Equal(0, h.Server.Count("POST breaks/end"));   // never sent: what it ended was never taken
        await HostHarness.WaitFor(() => { lock (told) return told.Count >= 2; });
        lock (told) Assert.Contains(told, m => m.Contains("You're already on a break."));
    }

    [Fact]
    public async Task Samples_wait_for_the_actions_before_them()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        h.Server.Route("POST breaks/quick/start", (_, _) => FakeServer.Ok(new { record = QuickRecord("q-1", DateTimeOffset.UtcNow, 5) }));
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Reports > 0);

        h.Server.FailWith = req => req.RequestUri!.AbsolutePath.EndsWith("breaks/quick/start") ? new HttpRequestException("no network") : null;
        h.Host.ImmediateWait = TimeSpan.Zero;
        await h.Host.QuickBreakAsync(5);
        var reports = h.Reports;
        await h.Host.SampleNowAsync();
        await h.Host.DrainSamplesNowAsync();
        Assert.Equal(reports, h.Reports);   // an action waits: the sample does not overtake it

        h.Server.FailWith = _ => null;
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(20)));
        await h.Host.SampleNowAsync();   // the next minute's tick sends what waited, then its own
        await HostHarness.WaitFor(() => h.Reports > reports);
    }
}

/// <summary>The away pop-up's rules and its flow through the agent (SPEC 2.5).</summary>
public class AwayTests
{
    private static readonly IdleConfig On = new() { Enabled = true, Minutes = 5 };

    [Fact]
    public void Opens_after_the_set_minutes_only_when_on_and_free()
    {
        var now = DateTimeOffset.UtcNow;
        Assert.True(AwayRule.ShouldOpen(On, onBreak: false, inMeeting: false, now.AddMinutes(-5), now));
        Assert.False(AwayRule.ShouldOpen(On, false, false, now.AddMinutes(-4), now));
        Assert.False(AwayRule.ShouldOpen(On, onBreak: true, false, now.AddMinutes(-30), now));
        Assert.False(AwayRule.ShouldOpen(On, false, inMeeting: true, now.AddMinutes(-30), now));
        Assert.False(AwayRule.ShouldOpen(new IdleConfig { Enabled = false, Minutes = 5 }, false, false, now.AddHours(-1), now));
        Assert.False(AwayRule.ShouldOpen(null, false, false, now.AddHours(-1), now));
        // Below 2 minutes is treated as 2.
        Assert.False(AwayRule.ShouldOpen(new IdleConfig { Enabled = true, Minutes = 0 }, false, false, now.AddSeconds(-90), now));
    }

    [Fact]
    public void A_locked_screen_keeps_counting_from_the_last_input()
    {
        var now = DateTimeOffset.UtcNow;
        var last = now.AddMinutes(-10);
        Assert.Equal(last, AwayRule.LastActive(last, now, TimeSpan.Zero, locked: true));
        Assert.Equal(now.AddSeconds(-3), AwayRule.LastActive(last, now, TimeSpan.FromSeconds(3), locked: false));
        Assert.Equal(last, AwayRule.LastActive(last, now, TimeSpan.FromMinutes(20), locked: false)); // never backwards
    }

    [Fact]
    public void The_away_start_never_reaches_before_the_session_or_the_last_break()
    {
        var now = DateTimeOffset.UtcNow;
        var day = new WorkdayToday { State = WorkdayStates.Open, StartedAt = now.AddMinutes(-30), Sessions = { new WorkSessionView { StartedAt = now.AddMinutes(-30) } } };
        Assert.Equal(now.AddMinutes(-30), AwayRule.BoundStart(now.AddHours(-2), day, null));
        var breaks = new BreakDay { Quick = { new QuickBreakView { Id = "q", StartedAt = now.AddMinutes(-20), EndedAt = now.AddMinutes(-12) } } };
        Assert.Equal(now.AddMinutes(-12), AwayRule.BoundStart(now.AddMinutes(-25), day, breaks));
        // Nor before the end of the last meeting (as the server bounds it; seen end to end).
        var meetings = new List<MeetingRecord>
        {
            new() { Id = "m", Mode = MeetingModes.Live, StartedAt = now.AddMinutes(-11), EndedAt = now.AddMinutes(-4) },
            new() { Id = "p", Mode = MeetingModes.Past, StartedAt = now.AddMinutes(-29), EndedAt = now.AddMinutes(-1) },
        };
        Assert.Equal(now.AddMinutes(-4), AwayRule.BoundStart(now.AddMinutes(-25), day, breaks, meetings));
        Assert.Equal(now.AddMinutes(-2), AwayRule.BoundStart(now.AddMinutes(-2), day, breaks, meetings));
    }

    [Theory]
    [InlineData(AwayKinds.Thinking, "ok", "Add what you were thinking about (3 to 200 characters).")]
    [InlineData(AwayKinds.Hardware, "", "Add what you worked on (3 to 200 characters).")]
    [InlineData(AwayKinds.Custom, "Site visit", null)]
    [InlineData(AwayKinds.Break, null, null)]
    public void Each_reason_asks_for_its_fields(string kind, string? comment, string? problem) =>
        Assert.Equal(problem, AwayRule.Problem(kind, new AwayAnswer("K", comment))?.Message);

    [Fact]
    public void A_short_meeting_needs_people_a_summary_and_who_mails_the_minutes()
    {
        var people = new[] { new MeetingParticipant(null, "Ravi") };
        Assert.Equal("participants", AwayRule.Problem(AwayKinds.Meeting, new AwayAnswer("M", "Stand-up", Array.Empty<MeetingParticipant>(), "Asha"))!.Fields[0]);
        Assert.Equal("comment", AwayRule.Problem(AwayKinds.Meeting, new AwayAnswer("M", "x", people, "Asha"))!.Fields[0]);
        Assert.Equal("momSender", AwayRule.Problem(AwayKinds.Meeting, new AwayAnswer("M", "Stand-up", people, "A"))!.Fields[0]);
        Assert.Null(AwayRule.Problem(AwayKinds.Meeting, new AwayAnswer("M", "Stand-up", people, "Asha")));
    }

    private static HostHarness Harness() => new(HostHarness.Day("OPEN", config: new
    {
        idle = new { enabled = true, minutes = 5, reasons = new[]
        {
            new { key = "BREAK", label = "Took a break", kind = "BREAK", fields = Array.Empty<string>() },
            new { key = "THINKING", label = "Thinking", kind = "THINKING", fields = new[] { "comment" } },
            new { key = "MEETING", label = "Short meeting", kind = "MEETING", fields = new[] { "participants", "comment", "momSender" } },
        } },
        quickBreakMinutes = new[] { 5, 10, 15 },
        breakBufferMin = 10,
    }));

    [Fact]
    public async Task No_input_for_the_set_minutes_opens_it_and_the_answer_goes_with_the_away_start()
    {
        using var h = Harness();
        h.Server.Route("POST away", (_, _) => FakeServer.Ok(new { @event = new { id = "a-1", status = "PENDING" } }));
        var changes = 0;
        h.Host.AwayChanged += () => Interlocked.Increment(ref changes);
        await h.SignInAsync();
        Assert.True(h.Host.IdleConfig!.Enabled);

        h.Host.SetLastActiveForTests(DateTimeOffset.UtcNow.AddHours(-1));
        h.Platform.IdleFor = TimeSpan.FromMinutes(4);
        h.Host.AwayTick();
        Assert.Null(h.Host.AwaySince);
        // Later: no input for six minutes now.
        h.Host.SetLastActiveForTests(DateTimeOffset.UtcNow.AddHours(-1));
        h.Platform.IdleFor = TimeSpan.FromMinutes(6);
        h.Host.AwayTick();
        var since = h.Host.AwaySince!.Value;
        Assert.InRange((DateTimeOffset.UtcNow - since).TotalMinutes, 5.9, 6.2);
        Assert.True(changes >= 1);
        // Away time is not focus time while the question is open.
        var focus = h.Host.FocusSec;
        await Task.Delay(1100);
        Assert.Equal(focus, h.Host.FocusSec);

        Assert.IsType<AwayOutcome.Invalid>(await h.Host.AnswerAwayAsync(new AwayAnswer("THINKING", "ok")));
        Assert.NotNull(h.Host.AwaySince);
        Assert.IsType<AwayOutcome.Recorded>(await h.Host.AnswerAwayAsync(new AwayAnswer("THINKING", "Planning the release checklist")));
        Assert.Null(h.Host.AwaySince);
        await h.Host.SyncNowAsync(TimeSpan.FromSeconds(10));
        using var body = JsonDocument.Parse(h.Server.Sent.Last(x => x.Key == "POST away").Body!);
        Assert.Equal("THINKING", body.RootElement.GetProperty("reasonKey").GetString());
        Assert.Equal("Planning the release checklist", body.RootElement.GetProperty("comment").GetString());
        Assert.InRange((DateTimeOffset.Parse(body.RootElement.GetProperty("startedAt").GetString()!) - since).Duration().TotalSeconds, 0, 1);
    }

    /// <summary>
    /// Seen end to end: an answer sent a few seconds late (a network blip) is timed by the
    /// server when it arrives, so the next stretch, which starts where the person answered,
    /// overlaps it by those seconds (409 AWAY_OVERLAP). The answer then starts where the
    /// server's earlier stretch ends, instead of leaving the pop-up stuck on an error.
    /// </summary>
    [Fact]
    public async Task An_answer_overlapping_the_tail_of_the_servers_earlier_away_starts_after_it()
    {
        using var h = Harness();
        var since = DateTimeOffset.UtcNow.AddMinutes(-6);
        var earlierEnd = since.AddSeconds(14);
        var tries = 0;
        h.Server.Route("POST away", (req, body) =>
        {
            if (Interlocked.Increment(ref tries) == 1)
                return FakeServer.Error(409, "AWAY_OVERLAP", "That time overlaps away time already recorded.",
                    new { existing = new { id = "a-0", startedAt = since.AddMinutes(-4).ToString("o"), endedAt = earlierEnd.ToString("o"), status = "PENDING" } });
            return FakeServer.Ok(new { kind = "AWAY", away = new { id = "a-1", status = "PENDING" } });
        });
        await h.SignInAsync();
        h.Host.SetLastActiveForTests(since);
        h.Platform.IdleFor = TimeSpan.FromMinutes(6);
        h.Host.AwayTick();
        Assert.NotNull(h.Host.AwaySince);

        Assert.IsType<AwayOutcome.Recorded>(await h.Host.AnswerAwayAsync(new AwayAnswer("THINKING", "Rack cabling in the lab")));
        Assert.Null(h.Host.AwaySince);
        Assert.Equal(0, await h.Host.SyncNowAsync(TimeSpan.FromSeconds(10)));
        var sent = h.Server.Sent.Where(x => x.Key == "POST away").ToList();
        Assert.Equal(2, sent.Count);
        Assert.NotEqual(sent[0].EventId, sent[1].EventId);
        using var retry = JsonDocument.Parse(sent[1].Body!);
        Assert.Equal(earlierEnd, DateTimeOffset.Parse(retry.RootElement.GetProperty("startedAt").GetString()!), TimeSpan.FromMilliseconds(1));
        Assert.Equal("Rack cabling in the lab", retry.RootElement.GetProperty("comment").GetString());
    }

    [Fact]
    public async Task A_real_overlap_is_still_refused()
    {
        using var h = Harness();
        var since = DateTimeOffset.UtcNow.AddMinutes(-6);
        h.Server.Route("POST away", (_, _) => FakeServer.Error(409, "AWAY_OVERLAP", "That time overlaps away time already recorded.",
            new { existing = new { id = "a-0", startedAt = since.AddMinutes(1).ToString("o"), endedAt = since.AddMinutes(2).ToString("o") } }));
        await h.SignInAsync();
        h.Host.SetLastActiveForTests(since);
        h.Platform.IdleFor = TimeSpan.FromMinutes(6);
        h.Host.AwayTick();
        var refused = Assert.IsType<AwayOutcome.Refused>(await h.Host.AnswerAwayAsync(new AwayAnswer("THINKING", "Rack cabling in the lab")));
        Assert.Contains("overlaps", refused.Message);
        Assert.InRange((h.Host.AwaySince!.Value - since).TotalSeconds, 0, 1);   // asked again, with the same start
        Assert.Single(h.Server.Sent, x => x.Key == "POST away");
    }

    [Fact]
    public async Task Took_a_break_becomes_a_quick_break_from_the_away_start()
    {
        using var h = Harness();
        // The server opens the quick break from the away start, and its day shows it from then on.
        h.Server.Route("POST away", (_, body) =>
        {
            using var doc = JsonDocument.Parse(body!);
            var from = doc.RootElement.GetProperty("startedAt").GetString()!;
            var record = new { id = "q-9", kind = "QUICK", label = "Away break", presenceType = "BREAK", startedAt = from, inProgress = true, state = "ACTIVE" };
            h.Breaks = () => new
            {
                date = HostHarness.Today, mode = "FREE", workday = true, activeBreak = record,
                quick = new[] { new { id = "q-9", startedAt = from } },
            };
            return FakeServer.Ok(new { record });
        });
        await h.SignInAsync();
        h.Host.SetLastActiveForTests(DateTimeOffset.UtcNow.AddHours(-1));
        h.Platform.IdleFor = TimeSpan.FromMinutes(8);
        h.Host.AwayTick();
        var since = h.Host.AwaySince!.Value;

        Assert.IsType<AwayOutcome.OnBreak>(await h.Host.AnswerAwayAsync(new AwayAnswer("BREAK")));
        var active = h.Host.BreakPanel.Active!;
        Assert.True(active.IsQuick);
        Assert.False(active.CanPause);
        Assert.InRange((active.StartedAt - since).Duration().TotalMilliseconds, 0, 1);   // the wire keeps milliseconds
        Assert.Null(active.DurationMin);   // no planned length: it counts up
        Assert.Equal(PresenceStatus.Break, h.Host.Presence.Status);
        // On a break: the pop-up does not open again however long there is no input.
        h.Host.AwayTick();
        Assert.Null(h.Host.AwaySince);
    }

    [Fact]
    public async Task End_Day_with_the_pop_up_open_records_the_time_as_unexplained_first()
    {
        using var h = Harness();
        h.Server.Route("POST away/unexplained", (_, _) => FakeServer.Ok(new { @event = new { id = "u-1", status = "UNEXPLAINED" } }));
        h.Server.Route("POST activity/end-day", (_, _) =>
        {
            h.Workday = () => FakeServer.Ok(HostHarness.Day("ENDED"));
            return FakeServer.Ok(new { ok = true, date = HostHarness.Today, endedAt = DateTimeOffset.UtcNow.ToString("o") });
        });
        await h.SignInAsync();
        h.Host.SetLastActiveForTests(DateTimeOffset.UtcNow.AddHours(-1));
        h.Platform.IdleFor = TimeSpan.FromMinutes(7);
        h.Host.AwayTick();
        var since = h.Host.AwaySince!.Value;

        Assert.IsType<Workday.EndDayOutcome.Ended>(await h.Host.EndDayAsync());
        Assert.Null(h.Host.AwaySince);
        await h.Host.SyncNowAsync(TimeSpan.FromSeconds(10));
        var keys = h.Server.Sent.Where(x => x.EventId is not null).Select(x => x.Key).ToList();
        Assert.Equal(new[] { "POST away/unexplained", "POST activity/end-day" }, keys);
        using var body = JsonDocument.Parse(h.Server.Sent.Single(x => x.Key == "POST away/unexplained").Body!);
        Assert.InRange((DateTimeOffset.Parse(body.RootElement.GetProperty("startedAt").GetString()!) - since).Duration().TotalSeconds, 0, 1);
        Assert.True(body.RootElement.TryGetProperty("endedAt", out _));
    }

    [Fact]
    public async Task Off_by_default_nothing_is_asked()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        await h.SignInAsync();
        h.Host.SetLastActiveForTests(DateTimeOffset.UtcNow.AddHours(-2));
        h.Platform.IdleFor = TimeSpan.FromHours(1);
        h.Host.AwayTick();
        Assert.Null(h.Host.AwaySince);
    }
}

/// <summary>Sign-out and an admin's quit with a key (SPEC 2.8).</summary>
public class SignOutKeyTests
{
    [Fact]
    public async Task Sign_out_sends_everything_first_and_needs_the_internet()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        h.Server.Route("POST breaks/quick/start", (_, _) => FakeServer.Ok(new { record = new { id = "q-1", kind = "QUICK" } }));
        h.Server.Route("POST agent/sign-out", (_, _) => FakeServer.Ok(new { ok = true }));
        await h.SignInAsync();
        h.Server.FailWith = _ => new HttpRequestException("no network");
        h.Host.ImmediateWait = TimeSpan.Zero;
        await h.Host.QuickBreakAsync(5);

        var notSynced = Assert.IsType<Core.KeyOutcome.NotSynced>(await h.Host.SignOutWithKeyAsync("amber orbit cedar river lamp 42"));
        Assert.Equal(1, notSynced.Actions);
        Assert.Contains("offline", notSynced.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, h.Server.Count("POST agent/sign-out"));
        Assert.Equal(AgentState.Running, h.Host.State);
        Assert.Equal(1, h.Host.PendingActions);   // nothing lost
    }

    [Fact]
    public async Task A_wrong_key_then_too_many_tries_then_the_right_key_signs_out()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        var tries = 0;
        h.Server.Route("POST agent/sign-out", (_, body) =>
        {
            tries++;
            using var doc = JsonDocument.Parse(body!);
            var key = doc.RootElement.GetProperty("key").GetString();
            if (tries == 2) return FakeServer.Error(429, "TOO_MANY_REQUESTS", "Too many tries. Wait 10 minutes.");
            return key == "amber orbit cedar river lamp 42"
                ? FakeServer.Ok(new { ok = true })
                : FakeServer.Error(403, "SIGNOUT_KEY_INVALID", "That key isn't valid for you.");
        });
        await h.SignInAsync();

        Assert.IsType<Core.KeyOutcome.WrongKey>(await h.Host.SignOutWithKeyAsync("amber orbit cedar river lamp 41"));
        Assert.IsType<Core.KeyOutcome.TooManyTries>(await h.Host.SignOutWithKeyAsync("amber orbit cedar river lamp 41"));
        Assert.Equal(AgentState.Running, h.Host.State);
        Assert.NotNull(h.Host.User);
        string[] Files() => Directory.GetFiles(h.Platform.DataDir).Select(Path.GetFileName)
            .Where(n => n!.StartsWith("journal-") || n.StartsWith("state-") || n.StartsWith("queue-")).ToArray()!;
        await HostHarness.WaitFor(() => Files().Any(n => n.StartsWith("state-")));

        Assert.IsType<Core.KeyOutcome.Accepted>(await h.Host.SignOutWithKeyAsync("  Amber ORBIT cedar  river lamp 42 "));
        using (var sent = JsonDocument.Parse(h.Server.Sent.Last(x => x.Key == "POST agent/sign-out").Body!))
            Assert.Equal("amber orbit cedar river lamp 42", sent.RootElement.GetProperty("key").GetString());
        Assert.Equal(AgentState.SignIn, h.Host.State);
        Assert.Null(h.Host.User);
        // This computer keeps nothing of the person (seen end to end: the day's state file came back).
        Assert.Empty(Files());
    }

    [Fact]
    public async Task An_admins_quit_is_checked_with_a_key()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"), role: "ADMIN");
        h.Server.Route("POST agent/quit-check", (_, body) => body!.Contains("lamp 42")
            ? FakeServer.Ok(new { ok = true })
            : FakeServer.Error(403, "SIGNOUT_KEY_INVALID", "That key isn't valid for you."));
        await h.SignInAsync();
        Assert.IsType<Core.KeyOutcome.WrongKey>(await h.Host.QuitCheckAsync("amber orbit cedar river lamp 41"));
        Assert.IsType<Core.KeyOutcome.Accepted>(await h.Host.QuitCheckAsync("amber orbit cedar river lamp 42"));
        Assert.Equal(AgentState.Running, h.Host.State);   // a quit check signs nobody out
    }
}
