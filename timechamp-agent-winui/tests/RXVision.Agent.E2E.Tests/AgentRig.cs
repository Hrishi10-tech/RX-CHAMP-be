using System.Collections.Concurrent;
using System.Net;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.E2E.Tests;

/// <summary>A log with times, kept in memory and written to the test's output at the end.</summary>
public sealed class TestLog : ILog
{
    private readonly string _who;

    public TestLog(string who)
    {
        _who = who;
        // The thread pool when it is backed up (a dedicated thread: it must not need the pool itself).
        var watch = new Thread(() =>
        {
            while (!_done)
            {
                Thread.Sleep(500);
                var pending = ThreadPool.PendingWorkItemCount;
                if (pending > 4) Lines.Enqueue($"{DateTimeOffset.UtcNow:HH:mm:ss.fff} [{_who}] pool: {ThreadPool.ThreadCount} threads, {pending} work items waiting");
            }
        }) { IsBackground = true, Name = "pool watch" };
        watch.Start();
    }

    private volatile bool _done;
    public void Stop() => _done = true;
    public ConcurrentQueue<string> Lines { get; } = new();

    public void Write(LogLevel level, string area, string message, Exception? error = null) =>
        Lines.Enqueue($"{DateTimeOffset.UtcNow:HH:mm:ss.fff} [{_who}] {level} {area}: {message}{(error is null ? "" : " | " + error.GetType().Name + ": " + error.Message)}");

    public void DumpTo(ITestOutputHelper output)
    {
        foreach (var line in Lines) output.WriteLine(line);
    }
}

/// <summary>One call the agent made: when, what, the answer's status and the headers that matter here.</summary>
public sealed record Call(DateTimeOffset At, string Method, string Path, int Status, string? UserAgent, string? EventId, string? EventAt, string? Seq,
    string? Body = null);

/// <summary>The agent's transport with a record of every call.</summary>
public sealed class RecordingHandler : DelegatingHandler
{
    private readonly ConcurrentQueue<Call> _calls = new();

    public RecordingHandler() : base(new SocketsHttpHandler
    {
        UseCookies = false,
        AllowAutoRedirect = false,
        AutomaticDecompression = DecompressionMethods.All,
        PooledConnectionLifetime = TimeSpan.FromMinutes(10),
        ConnectTimeout = TimeSpan.FromSeconds(5),
    })
    { }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        string? H(string name) => request.Headers.TryGetValues(name, out var v) ? string.Join(",", v) : null;
        var ua = request.Headers.UserAgent.ToString();
        var path = request.RequestUri?.AbsolutePath ?? "";
        // Samples and actions keep their body (what was sent is what the tests compare).
        string? body = null;
        if (request.Content is not null && (path.EndsWith("/activity/report", StringComparison.Ordinal) || H("X-Client-Event-Id") is not null))
        {
            await request.Content.LoadIntoBufferAsync();
            body = await request.Content.ReadAsStringAsync(cancellationToken);
        }
        try
        {
            var response = await base.SendAsync(request, cancellationToken);
            _calls.Enqueue(new Call(DateTimeOffset.UtcNow, request.Method.Method, path, (int)response.StatusCode,
                ua, H("X-Client-Event-Id"), H("X-Event-At"), H("X-Client-Seq"), body));
            return response;
        }
        catch
        {
            _calls.Enqueue(new Call(DateTimeOffset.UtcNow, request.Method.Method, path, 0,
                ua, H("X-Client-Event-Id"), H("X-Event-At"), H("X-Client-Seq"), body));
            throw;
        }
    }

    public IReadOnlyList<Call> Calls => _calls.ToList();

    public int Count(string method, string pathEnd, int? status = null) =>
        _calls.Count(c => c.Method == method && c.Path.EndsWith(pathEnd, StringComparison.Ordinal) && (status is null || c.Status == status));
}

/// <summary>Answers dialogs from a script; records what was shown.</summary>
public sealed class ScriptedDialogs : IDialogService
{
    private readonly ConcurrentQueue<Func<DialogViewModel, Task<bool>>> _answers = new();
    public ConcurrentQueue<DialogViewModel> Shown { get; } = new();

    public ScriptedDialogs Answer(Func<DialogViewModel, bool> answer)
    {
        _answers.Enqueue(d => Task.FromResult(answer(d)));
        return this;
    }

    /// <summary>Leaves the dialog open until the flow closes it (a progress dialog).</summary>
    public ScriptedDialogs Wait()
    {
        _answers.Enqueue(d => d.Completion);
        return this;
    }

    public Task<bool> ShowAsync(DialogViewModel dialog)
    {
        Shown.Enqueue(dialog);
        return _answers.TryDequeue(out var answer) ? answer(dialog) : Task.FromResult(false);
    }

    public T? Last<T>() where T : DialogViewModel => Shown.OfType<T>().LastOrDefault();
}

/// <summary>
/// One person's agent as the app builds it (AgentHost behind the AgentFacade, the dashboard,
/// History and the break actions), talking to the API through a <see cref="TcpRelay"/> so the
/// test can take its network away. <see cref="RestartAsync"/> throws the whole agent away and
/// starts a new one from what it left on disk, as a new process would.
/// </summary>
public sealed class AgentRig : IAsyncDisposable
{
    private readonly string _root;
    private int _generation;

    private AgentRig(Person person, string root, TcpRelay relay)
    {
        Person = person;
        _root = root;
        Relay = relay;
        Log = new TestLog(person.FirstName);
    }

    public Person Person { get; }
    public TcpRelay Relay { get; }
    public TestLog Log { get; }
    public UiThread Ui { get; private set; } = null!;
    public E2EPlatform Platform { get; private set; } = null!;
    public RecordingHandler Http { get; private set; } = null!;
    public AgentHost Host { get; private set; } = null!;
    public AgentFacade Agent { get; private set; } = null!;
    public ScriptedDialogs Dialogs { get; private set; } = null!;
    public BreakActions Actions { get; private set; } = null!;
    public DashboardViewModel Dashboard { get; private set; } = null!;
    public ConcurrentQueue<string> Events { get; } = new();
    public string DataDir => Path.Combine(_root, "data");

    /// <summary>A new agent for <paramref name="person"/> in its own folder (nothing signed in yet).</summary>
    public static async Task<AgentRig> CreateAsync(Person person)
    {
        var root = Directory.CreateTempSubdirectory("rxv-e2e-").FullName;
        var relay = new TcpRelay(new Uri(E2EEnv.Api!));
        var rig = new AgentRig(person, root, relay);
        await rig.BuildAsync();
        return rig;
    }

    private async Task BuildAsync()
    {
        var gen = ++_generation;
        Ui = new UiThread();
        Platform = new E2EPlatform(_root);
        // Someone at the keyboard (input just now) until a test says otherwise.
        Platform.Dev.IdleFor = TimeSpan.Zero;
        Http = new RecordingHandler();
        // Samples every 30 seconds (the fastest the agent allows), so a few minutes give several.
        var options = new AgentOptions { ApiBaseUrl = Relay.Url(E2EEnv.Api!), AutoUpdate = false, ActivitySeconds = 30 }.Normalised();
        Host = new AgentHost(Platform, options, Log, Http);
        Host.StateChanged += s => Events.Enqueue($"{gen}:state:{s}");
        Host.HistoryChanged += () => Events.Enqueue($"{gen}:history");
        Host.AwayChanged += () => Events.Enqueue($"{gen}:away");
        Host.ActionRefused += m => Events.Enqueue($"{gen}:refused:{m}");
        Host.NotificationReceived += n => Events.Enqueue($"{gen}:notification:{n.Type}");
        Agent = new AgentFacade(Host, Ui, Log);
        Dialogs = new ScriptedDialogs();
        Actions = new BreakActions(Agent, Dialogs, Log);
        Dashboard = await Ui.Run(() => new DashboardViewModel(Agent, Actions, Log));
        // As the app wires them (AppController).
        Agent.PresenceChanged += _ => Dashboard.Refresh();
        Agent.BreaksChanged += Dashboard.Refresh;
        Agent.WorkdayChanged += Dashboard.Refresh;
        Agent.MeetingsChanged += Dashboard.Refresh;
        Agent.ApprovalsChanged += Dashboard.Refresh;
        Agent.HistoryChanged += Dashboard.OnHistoryChanged;
        await Host.StartAsync();
    }

    /// <summary>Signs in with the person's password and accepts the monitoring notice.</summary>
    public async Task SignInAsync()
    {
        string? error = null;
        for (var attempt = 0; attempt < 4; attempt++)
        {
            error = await Agent.SignInAsync(Person.Email, Person.Password, null);
            if (error is null || !error.Contains("Too many", StringComparison.OrdinalIgnoreCase)) break;
            await Task.Delay(TimeSpan.FromSeconds(20));
        }
        Assert.Null(error);
        await Agent.AcknowledgeNoticeAsync();
        await E2EEnv.WaitFor(() => Host.DayKnown, TimeSpan.FromSeconds(20), "the day from the server");
    }

    /// <summary>Waits until the sender has nothing left (or fails).</summary>
    public Task WaitSyncedAsync(TimeSpan? timeout = null) =>
        E2EEnv.WaitFor(() => Host.PendingActions == 0, timeout ?? TimeSpan.FromSeconds(30), $"the journal to empty ({Host.PendingActions} waiting)");

    /// <summary>
    /// The agent is gone (the process ended) and a new one starts from its folder;
    /// <paramref name="whileStopped"/> runs in between (a test changing the files).
    /// </summary>
    public async Task RestartAsync(Action? whileStopped = null)
    {
        Host.Shutdown();
        Agent.Dispose();
        Ui.Dispose();
        await Task.Delay(200);
        whileStopped?.Invoke();
        await BuildAsync();
    }

    /// <summary>Nobody touches the keyboard or mouse from now on (the OS reports an hour without input).</summary>
    public void NoInput() => Platform.Dev.IdleFor = TimeSpan.FromHours(1);

    /// <summary>Someone is at the keyboard again.</summary>
    public void Input() => Platform.Dev.IdleFor = TimeSpan.Zero;

    /// <summary>The away pop-up opens as if nothing was typed since <paramref name="lastInput"/>.</summary>
    public void AwayFrom(DateTimeOffset lastInput)
    {
        NoInput();
        Host.SetLastActiveForTests(lastInput);
        Host.AwayTick();
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (Host.State is not (AgentState.SignIn or AgentState.Starting)) await Host.SignOutAsync();
        }
        catch { }
        try { Agent.Dispose(); } catch { }
        Ui.Dispose();
        Relay.Dispose();
        Log.Stop();
        try { Directory.Delete(_root, recursive: true); } catch { }
    }
}
