using System.Collections.Concurrent;
using System.Net;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using Xunit;

namespace RXVision.Agent.Core.Tests.Live;

/// <summary>Every live test runs in this one collection: one test at a time, one setup for all.</summary>
[CollectionDefinition(Name)]
public sealed class LiveCollection : ICollectionFixture<LiveFixture>
{
    public const string Name = "Live API";
}

/// <summary>
/// What the live tests share: the Super Admin's session, the seeded manager, and the
/// scenarios that have to wait for the clock (a break that runs over, a meeting over
/// a minute, an owed lunch). Those start here, together, as soon as the collection
/// starts, so the run waits about a minute once instead of once per scenario; each
/// test then awaits its own scenario and checks it.
/// </summary>
public sealed class LiveFixture : IAsyncLifetime
{
    /// <summary>Why the live tests do not run (null: they run).</summary>
    public string? Skip { get; private set; }
    public LiveAdmin Admin { get; private set; } = null!;
    /// <summary>The seeded manager (manager@timechamp.test), who staff report to.</summary>
    public string ManagerId { get; private set; } = "";
    public string ManagerName { get; private set; } = "";

    public Task<BackLateRun> AskToCount { get; private set; } = Task.FromException<BackLateRun>(new InvalidOperationException("not started"));
    public Task<BackLateRun> LeaveOut { get; private set; } = Task.FromException<BackLateRun>(new InvalidOperationException("not started"));
    public Task<MeetingRun> Meetings { get; private set; } = Task.FromException<MeetingRun>(new InvalidOperationException("not started"));
    public Task<HostRun> HostDay { get; private set; } = Task.FromException<HostRun>(new InvalidOperationException("not started"));

    private readonly List<IDisposable> _owned = new();

    public async Task InitializeAsync()
    {
        Skip = LiveEnv.SkipReason();
        if (Skip is not null) return;
        Admin = await LiveAdmin.SignInAsync("orgadmin@timechamp.test", "orgadmin123");
        ManagerId = await Admin.UserIdAsync("manager@timechamp.test");
        ManagerName = "Maya Reddy";

        // The timed scenarios. Each is a task; a failure surfaces in the test that awaits it.
        var t = DateTimeOffset.UtcNow;
        var overrunShift = await Admin.CreateShiftAsync("Overrun", t, new[]
        {
            new LiveBreak("MORNING", -1, 1, 5, 30),
            new LiveBreak("LUNCH", 60, 30, 20, 30),
            new LiveBreak("EVENING", 150, 15, 30, 20),
        }, overrunGraceMin: 0);
        AskToCount = BeginBackLateAsync(overrunShift, "Farhan", "Qureshi");
        LeaveOut = BeginBackLateAsync(overrunShift, "Sneha", "Pillai");
        Meetings = BeginMeetingsAsync();
        HostDay = BeginHostDayAsync();
        // Let the starts settle before the first test runs (they are quick).
        try { await Task.WhenAll(AskToCount, LeaveOut, Meetings, HostDay).WaitAsync(TimeSpan.FromSeconds(60)); }
        catch { /* each test reports its own scenario's failure */ }
    }

    public async Task DisposeAsync()
    {
        foreach (var task in new Task[] { AskToCount, LeaveOut, Meetings, HostDay })
        {
            try { await task; } catch { }
        }
        if (HostDay.IsCompletedSuccessfully) await HostDay.Result.DisposeAsync();
        lock (_owned)
        {
            foreach (var d in _owned) d.Dispose();
        }
        (Admin as IDisposable)?.Dispose();   // null when the setup stopped before signing in
    }

    // ---- Back late from a break ---------------------------------------------------------

    /// <summary>A person on a one-minute morning break (shift grace 0), started now.</summary>
    public sealed record BackLateRun(LiveAgent Agent, BreakRecord Break, DateTimeOffset StartedAt, WorkdayToday DayBefore);

    private async Task<BackLateRun> BeginBackLateAsync(string shiftId, string first, string last)
    {
        var person = await Admin.CreatePersonAsync(first, last);
        await Admin.AssignAsync(shiftId, person.Id);
        var agent = await LiveAgent.SignInAsync(person);
        lock (_owned) _owned.Add(agent);
        await agent.StartDayAsync();
        var before = await agent.DayAsync();
        var started = Assert.IsType<StartOutcome.Started>(await agent.Breaks.StartAsync(BreakKinds.Morning, null));
        Assert.NotNull(started.Record);
        return new BackLateRun(agent, started.Record!, started.Record!.StartedAt, before);
    }

    // ---- Meetings ------------------------------------------------------------------------

    /// <summary>
    /// A person whose day started 9 minutes ago (Start Day dated back), with one
    /// meeting logged, a short break taken and a live meeting running since <see cref="LiveSince"/>.
    /// </summary>
    public sealed record MeetingRun(
        LiveAgent Agent,
        WorkdayToday Day,
        MeetingOutcome Logged,
        MeetingOutcome OverlapsMeeting,
        MeetingOutcome QuickStarted,
        MeetingOutcome SecondWhileLive,
        WorkdayToday DayInMeeting,
        EndOutcome QuickEnded,
        IReadOnlyList<MeetingRecord> AfterQuick,
        BreakRecord Break,
        MeetingOutcome WhileOnBreak,
        MeetingOutcome Live,
        DateTimeOffset LiveSince,
        IReadOnlyList<ParticipantOption>? FoundManager,
        IReadOnlyList<ParticipantOption>? FoundAnyone);

    private async Task<MeetingRun> BeginMeetingsAsync()
    {
        var t = DateTimeOffset.UtcNow;
        var shift = await Admin.CreateShiftAsync("Meetings", t, new[]
        {
            new LiveBreak("MORNING", -1, 15, 5, 30),
            new LiveBreak("LUNCH", 70, 30, 20, 30),
            new LiveBreak("EVENING", 150, 15, 30, 20),
        });
        var person = await Admin.CreatePersonAsync("Kavya", "Raman");
        await Admin.AssignAsync(shift, person.Id);
        var agent = await LiveAgent.SignInAsync(person);
        lock (_owned) _owned.Add(agent);

        var started = await agent.StartDayAsync(minutesBack: 9);
        var day = started.Workday!;
        var s = day.Sessions.Single().StartedAt;

        var foundManager = await agent.Meetings.SearchAsync("Maya");
        var foundAnyone = await agent.Meetings.SearchAsync("");
        // An earlier meeting inside the day, then one that overlaps it.
        var logged = await agent.LogPastMeetingAsync(s.AddMinutes(1), 5, "  Client   sync  ", new[] { new MeetingParticipant(null, " Asha (client) ") });
        var overlaps = await agent.LogPastMeetingAsync(s.AddMinutes(2), 5, "Overlap", Array.Empty<MeetingParticipant>());

        // A live meeting ended within a minute is not kept.
        var quick = await agent.StartMeetingAsync("Quick sync", new[] { new MeetingParticipant(null, "Asha") });
        var second = await agent.StartMeetingAsync("Another one", Array.Empty<MeetingParticipant>());
        var inMeeting = await agent.DayAsync();
        var quickEnded = await agent.Meetings.EndAsync();
        await agent.Meetings.RefreshAsync();
        var afterQuick = agent.Meetings.Today;

        // A short break (on time), during which a meeting cannot start.
        var brk = Assert.IsType<StartOutcome.Started>(await agent.Breaks.StartAsync(BreakKinds.Morning, null));
        var whileOnBreak = await agent.StartMeetingAsync("During the break", Array.Empty<MeetingParticipant>());
        await Task.Delay(1500);
        var back = Assert.IsType<EndOutcome.Ended>(await agent.Breaks.EndAsync(null));

        // The meeting that runs over a minute.
        var live = await agent.StartMeetingAsync(" Sprint review ", new[]
        {
            new MeetingParticipant(ManagerId, ManagerName),
            new MeetingParticipant(null, "Vikram, Pune"),
        });
        var liveSince = (live as MeetingOutcome.Started)?.Meeting?.StartedAt ?? DateTimeOffset.UtcNow;
        return new MeetingRun(agent, day, logged, overlaps, quick, second, inMeeting, quickEnded, afterQuick,
            back.Record ?? brk.Record!, whileOnBreak, live, liveSince, foundManager, foundAnyone);
    }

    // ---- The whole agent (AgentHost) -------------------------------------------------------

    /// <summary>The real AgentHost for one person, signed in on a new day, started, a break skipped.</summary>
    public sealed class HostRun : IAsyncDisposable
    {
        public required LivePerson Person { get; init; }
        public required AgentHost Host { get; init; }
        public required DevPlatform Platform { get; init; }
        public required RecordingHandler Http { get; init; }
        public required MemoryLog Log { get; init; }
        public required ConcurrentQueue<AgentNudge> Nudges { get; init; }
        public required ConcurrentQueue<BreakRecord> AutoSkips { get; init; }
        /// <summary>The lunch's scheduled start: the session covers it once it passes, so End Day owes it.</summary>
        public required DateTimeOffset LunchAt { get; init; }

        // What the start phase saw (checked by the test).
        public AgentState AfterSignIn { get; set; }
        public AgentState AfterNotice { get; set; }
        public WorkdayToday? DayAtSignIn { get; set; }
        public string? PresenceAtSignIn { get; set; }
        public int TrackingCallsWhileNotStarted { get; set; } = -1;
        public StartOutcome? BreakWhileNotStarted { get; set; }
        public SkipOutcome? SkipWhileNotStarted { get; set; }
        public EndDayOutcome? EndWhileNotStarted { get; set; }
        public BreakPanel? PanelAtSignIn { get; set; }
        public StartDayOutcome? StartDay { get; set; }
        public AgentState AfterStartDay { get; set; }
        public DateTimeOffset FirstSampleSent { get; set; }
        public SkipOutcome? SkipLunch { get; set; }
        public SkipOutcome? SkipMorning { get; set; }
        public BreakPanel? PanelAfterSkip { get; set; }

        public async ValueTask DisposeAsync()
        {
            try { if (Host.State != AgentState.SignIn) await Host.SignOutAsync(); } catch { }
            Host.Dispose();
        }
    }

    private async Task<HostRun> BeginHostDayAsync()
    {
        // Lunch (owed once the session covers its start) starts at the next minute that
        // leaves at least half a minute to sign in, start the day and skip the morning.
        var t = DateTimeOffset.UtcNow;
        var lunchAt = LiveEnv.AtHm(t).AddMinutes(t.ToOffset(LiveEnv.BusinessOffset).Second <= 25 ? 1 : 2);
        var minutesToLunch = (int)Math.Round((lunchAt - LiveEnv.AtHm(t)).TotalMinutes);
        var shift = await Admin.CreateShiftAsync("Host", t, new[]
        {
            // Morning: open now and until lunch starts; lunch: opens at its start; evening: far off.
            new LiveBreak("MORNING", minutesToLunch - 2, 10, 1, 2),
            new LiveBreak("LUNCH", minutesToLunch, 30, 0, 20),
            new LiveBreak("EVENING", minutesToLunch + 60, 15, 20, 20),
        }, ringLeadMin: 0, ringDurationMin: 1);
        var person = await Admin.CreatePersonAsync("Arjun", "Mehta");
        await Admin.AssignAsync(shift, person.Id);

        var platform = new DevPlatform(Directory.CreateTempSubdirectory("rxv-live-host-").FullName);
        var http = new RecordingHandler();
        var log = new MemoryLog();
        var host = new AgentHost(new NoCapturePlatform(platform), new AgentOptions { ApiBaseUrl = LiveEnv.Api!, AutoUpdate = false }.Normalised(), log, http);
        var run = new HostRun
        {
            Person = person, Host = host, Platform = platform, Http = http, Log = log,
            Nudges = new ConcurrentQueue<AgentNudge>(), AutoSkips = new ConcurrentQueue<BreakRecord>(), LunchAt = lunchAt,
        };
        host.Nudge += n => run.Nudges.Enqueue(n);
        host.BreakAutoSkipped += r => run.AutoSkips.Enqueue(r);

        await host.StartAsync();
        var error = await host.SignInAsync(person.Email, LiveEnv.Password);
        Assert.Null(error);
        run.AfterSignIn = host.State;
        await host.AcknowledgeNoticeAsync();
        run.AfterNotice = host.State;
        // 4.0: the state comes at once from what is known; the server's day follows in the background.
        await LiveEnv.WaitFor(() => host.DayKnown && host.BreakPanel.Scheduled, TimeSpan.FromSeconds(20), "the server's day and breaks");
        run.DayAtSignIn = host.Workday;
        run.PresenceAtSignIn = host.Presence.Status;
        run.PanelAtSignIn = host.BreakPanel;

        // Not started: nothing may be recorded. Tracking would send a sample within seconds.
        await Task.Delay(TimeSpan.FromSeconds(6));
        run.TrackingCallsWhileNotStarted = http.Count("POST", "/activity/report") + http.Count("POST", "/presence/heartbeat") + http.Count("POST", "/screenshots");
        run.BreakWhileNotStarted = await host.TakeBreakAsync(BreakKinds.Morning, null);
        run.SkipWhileNotStarted = await host.SkipBreakAsync(BreakKinds.Morning, "Client escalation call");
        run.EndWhileNotStarted = await host.EndDayAsync();

        run.StartDay = await host.StartDayAsync();
        run.AfterStartDay = host.State;
        await LiveEnv.WaitFor(() => host.LastSampleSent > DateTimeOffset.MinValue, TimeSpan.FromSeconds(20), "the first activity sample");
        run.FirstSampleSent = host.LastSampleSent;

        run.SkipLunch = await host.SkipBreakAsync(BreakKinds.Lunch, "Client escalation call");
        run.SkipMorning = await host.SkipBreakAsync(BreakKinds.Morning, "  Client   escalation call ");
        run.PanelAfterSkip = host.BreakPanel;
        return run;
    }
}

/// <summary>The agent's HTTP transport with a record of every call (to prove what was, and was not, sent).</summary>
public sealed class RecordingHandler : DelegatingHandler
{
    private readonly ConcurrentQueue<(DateTimeOffset At, string Method, string Path, int Status)> _calls = new();

    public RecordingHandler() : base(new SocketsHttpHandler
    {
        // As ApiClient sets up its own transport.
        UseCookies = false,
        AllowAutoRedirect = false,
        AutomaticDecompression = DecompressionMethods.All,
        PooledConnectionLifetime = TimeSpan.FromMinutes(10),
        ConnectTimeout = TimeSpan.FromSeconds(15),
    })
    { }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var response = await base.SendAsync(request, cancellationToken);
        _calls.Enqueue((DateTimeOffset.UtcNow, request.Method.Method, request.RequestUri?.AbsolutePath ?? "", (int)response.StatusCode));
        return response;
    }

    /// <summary>Calls of <paramref name="method"/> whose path ends with <paramref name="pathEnd"/>, since <paramref name="since"/>.</summary>
    public int Count(string method, string pathEnd, DateTimeOffset? since = null) =>
        _calls.Count(c => c.Method == method && c.Path.EndsWith(pathEnd, StringComparison.Ordinal) && (since is null || c.At >= since));

    public IEnumerable<string> Calls => _calls.Select(c => $"{c.At:HH:mm:ss.fff} {c.Method} {c.Path} {c.Status}");
}
