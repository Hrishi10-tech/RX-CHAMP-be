using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Approvals;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using Xunit;

namespace RXVision.Agent.Core.Tests.Live;

/// <summary>
/// The live tests run the agent's own API layer (and the whole AgentHost) against a
/// real, migrated and seeded RX Vision API. They are opt-in and change data, so they
/// run only against a local or staging server you can wipe:
///
///   RXV_IT_API=http://localhost:4001/api/v1                          the API under test
///   RXV_IT_DB=postgresql://rxv:rxv@localhost:5432/rxvision_test      optional: the same API's
///       database (localhost only), for what no API can do (an approval made overdue)
///
/// They build shifts around the current time, so they run between 03:05 and 19:00
/// business time (Asia/Kolkata). Every person and shift is new per run, so a run
/// never depends on an earlier one; start from a freshly seeded database anyway.
/// </summary>
internal static class LiveEnv
{
    public const string Password = "Rx-Vision-31!";
    /// <summary>The seeded organisation's department (4.0); its manager is the seeded manager.</summary>
    public const string Engineering = "00000000-0000-0000-0000-0000000000e1";
    /// <summary>Who mails the minutes of the tests' meetings (required from 4.0 agents).</summary>
    public const string MomSender = "Team lead";
    private static readonly string[] ProductionHosts = { "api.rxvision.shop" };

    /// <summary>The business timezone (Asia/Kolkata has no daylight saving).</summary>
    public static readonly TimeSpan BusinessOffset = TimeSpan.FromHours(5.5);

    public static string? Api => Environment.GetEnvironmentVariable("RXV_IT_API") is { Length: > 0 } a ? a.TrimEnd('/') : null;

    /// <summary>The database behind <see cref="Api"/>, or null (then the tests that need it say so and stop).</summary>
    public static string? Db => Environment.GetEnvironmentVariable("RXV_IT_DB") is { Length: > 0 } d ? d : null;

    /// <summary>Why the live tests cannot run now, or null when they can.</summary>
    public static string? SkipReason()
    {
        if (Api is null) return "skipped: set RXV_IT_API (and RXV_IT_DB) to run the live tests";
        if (!Uri.TryCreate(Api, UriKind.Absolute, out var uri)) return $"skipped: RXV_IT_API is not a URL ({Api})";
        if (ProductionHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase))
            return $"refused: {uri.Host} is production and these tests change data";
        var now = BusinessNow;
        var minute = now.Hour * 60 + now.Minute;
        if (minute < 3 * 60 + 5 || minute > 19 * 60)
            return $"skipped: it is {now:HH:mm} business time; run between 03:05 and 19:00 (shifts are built around now)";
        return null;
    }

    public static DateTimeOffset BusinessNow => DateTimeOffset.UtcNow.ToOffset(BusinessOffset);

    /// <summary>Today's business day key (YYYY-MM-DD).</summary>
    public static string Today => BusinessNow.ToString("yyyy-MM-dd");

    /// <summary>"HH:MM" in the business timezone.</summary>
    public static string Hm(DateTimeOffset t) => t.ToOffset(BusinessOffset).ToString("HH:mm");

    /// <summary>The instant a shift's "HH:MM" on today's date stands for (what the server computes).</summary>
    public static DateTimeOffset AtHm(DateTimeOffset t)
    {
        var local = t.ToOffset(BusinessOffset);
        return new DateTimeOffset(local.Year, local.Month, local.Day, local.Hour, local.Minute, 0, BusinessOffset);
    }

    public static string Iso(DateTimeOffset t) => ApiClient.Iso(t);

    /// <summary>Waits until <paramref name="until"/> (wall clock), logging what it waits for.</summary>
    public static async Task WaitUntil(DateTimeOffset until, Action<string>? say = null, string? why = null)
    {
        var left = until - DateTimeOffset.UtcNow;
        if (left <= TimeSpan.Zero) return;
        say?.Invoke($"waiting {left.TotalSeconds:F0} s{(why is null ? "" : " " + why)}");
        await Task.Delay(left);
    }

    public static async Task WaitFor(Func<bool> condition, TimeSpan timeout, string what)
    {
        var until = DateTime.UtcNow + timeout;
        while (!condition())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException($"timed out waiting for {what}");
            await Task.Delay(100);
        }
    }

    /// <summary>
    /// Runs SQL on <see cref="Db"/> with psql and returns what it prints (tuples only).
    /// Local databases only: anything else is refused.
    /// </summary>
    public static async Task<string> SqlAsync(string sql)
    {
        var url = Db ?? throw new InvalidOperationException("RXV_IT_DB is not set");
        var host = Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host : "";
        if (host is not ("localhost" or "127.0.0.1" or "::1" or "[::1]"))
            throw new InvalidOperationException("RXV_IT_DB must point at a local database (localhost): these tests change data directly.");
        var psi = new ProcessStartInfo("psql")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        // -q: no command tags ("UPDATE 1"), only the rows.
        foreach (var arg in new[] { url, "-v", "ON_ERROR_STOP=1", "-q", "-At", "-c", sql }) psi.ArgumentList.Add(arg);
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("could not start psql");
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        await p.WaitForExitAsync();
        if (p.ExitCode != 0) throw new InvalidOperationException($"psql failed ({p.ExitCode}): {await stderr}");
        return (await stdout).Trim();
    }
}

/// <summary>A person made for one test (a fresh account, so runs never collide).</summary>
public sealed record LivePerson(string Id, string Email, string FirstName, string LastName)
{
    public string Name => $"{FirstName} {LastName}";
}

/// <summary>One scheduled break of a test shift, in minutes from the shift's base time.</summary>
public sealed record LiveBreak(string Kind, int AtMin, int DurationMin, int BeforeMin, int AfterMin);

/// <summary>
/// The organisation Admin's session (4.0), for what the portal does around the agent: people,
/// shifts and assignments, settings and decisions. Plain HTTP with cookies, like the portal.
/// </summary>
public sealed class LiveAdmin : IDisposable
{
    private readonly HttpClient _http;
    private readonly string _run = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString("x");
    private int _seq;

    private LiveAdmin(HttpClient http) => _http = http;

    public string Id { get; private set; } = "";
    public string Name { get; private set; } = "";

    public static async Task<LiveAdmin> SignInAsync(string email, string password)
    {
        var http = new HttpClient(new HttpClientHandler { CookieContainer = new CookieContainer() })
        {
            BaseAddress = new Uri(LiveEnv.Api + "/"),
            Timeout = TimeSpan.FromSeconds(30),
        };
        var admin = new LiveAdmin(http);
        var me = await admin.SendAsync(HttpMethod.Post, "auth/login", new { email, password });
        admin.Id = me.GetProperty("user").GetProperty("id").GetString()!;
        admin.Name = me.GetProperty("user").GetProperty("name").GetString()!;
        return admin;
    }

    /// <summary>A request that must succeed; returns the envelope's data. Waits out the rate limit.</summary>
    public async Task<JsonElement> SendAsync(HttpMethod method, string path, object? body = null)
    {
        var (status, json) = await TrySendAsync(method, path, body);
        if (status is < 200 or >= 300) throw new InvalidOperationException($"{method} {path} -> {status}: {json}");
        return json.GetProperty("data");
    }

    /// <summary>A request whose status the caller checks; returns the whole JSON answer.</summary>
    public async Task<(int Status, JsonElement Json)> TrySendAsync(HttpMethod method, string path, object? body = null)
    {
        for (var attempt = 0; ; attempt++)
        {
            using var req = new HttpRequestMessage(method, path);
            if (body is not null) req.Content = JsonContent.Create(body, body.GetType());
            using var res = await _http.SendAsync(req);
            var text = await res.Content.ReadAsStringAsync();
            if ((int)res.StatusCode == 429 && attempt < 3)
            {
                var wait = res.Headers.RetryAfter?.Delta ?? TimeSpan.FromSeconds(20);
                await Task.Delay(wait > TimeSpan.FromSeconds(60) ? TimeSpan.FromSeconds(60) : wait + TimeSpan.FromSeconds(1));
                continue;
            }
            JsonElement json;
            try { json = JsonDocument.Parse(text.Length == 0 ? "{}" : text).RootElement.Clone(); }
            catch (JsonException) { json = JsonDocument.Parse(JsonSerializer.Serialize(new { raw = text })).RootElement.Clone(); }
            return ((int)res.StatusCode, json);
        }
    }

    public async Task<string> UserIdAsync(string email)
    {
        var list = await SendAsync(HttpMethod.Get, $"users?search={Uri.EscapeDataString(email)}");
        return list.EnumerateArray().First(u => u.GetProperty("email").GetString() == email).GetProperty("id").GetString()!;
    }

    /// <summary>
    /// A new person (fresh email per run) in <paramref name="departmentId"/> (4.0: approvals go
    /// to the department's managers; a manager manages it). Staff by default.
    /// </summary>
    public async Task<LivePerson> CreatePersonAsync(string first, string last, string role = "USER", string departmentId = LiveEnv.Engineering)
    {
        var email = $"{first.ToLowerInvariant()}.{last.ToLowerInvariant()}.{_run}.{Interlocked.Increment(ref _seq)}@agent-it.test";
        object body = role == "MANAGER"
            ? new { firstName = first, lastName = last, email, password = LiveEnv.Password, role, departmentIds = new[] { departmentId } }
            : new { firstName = first, lastName = last, email, password = LiveEnv.Password, role, departmentId };
        var data = await SendAsync(HttpMethod.Post, "users", body);
        var created = data.GetProperty("created").EnumerateArray().Single();
        return new LivePerson(created.GetProperty("id").GetString()!, email, first, last);
    }

    /// <summary>A new department of the organisation; returns its id.</summary>
    public async Task<string> CreateDepartmentAsync(string name)
    {
        var data = await SendAsync(HttpMethod.Post, "departments", new { name = $"{name} {_run}.{Interlocked.Increment(ref _seq)}" });
        return data.GetProperty("id").GetString()!;
    }

    /// <summary>A shift from base-120 to base+180 minutes with the given breaks; returns its id.</summary>
    public async Task<string> CreateShiftAsync(string label, DateTimeOffset at, IEnumerable<LiveBreak> breaks,
        int overrunGraceMin = 3, int ringLeadMin = 1, int ringDurationMin = 5, int[]? workDays = null)
    {
        var data = await SendAsync(HttpMethod.Post, "shifts", new
        {
            name = $"Agent IT {label} {_run}.{Interlocked.Increment(ref _seq)}",
            start = LiveEnv.Hm(at.AddMinutes(-120)),
            end = LiveEnv.Hm(at.AddMinutes(180)),
            workDays = workDays ?? new[] { 1, 2, 3, 4, 5, 6, 7 },
            ringLeadMin,
            ringDurationMin,
            reasonOnEarly = true,
            reasonOnLate = true,
            reasonMinChars = 10,
            overrunReason = true,
            overrunGraceMin,
            breaks = breaks.Select(b => new
            {
                kind = b.Kind,
                enabled = true,
                startTime = LiveEnv.Hm(at.AddMinutes(b.AtMin)),
                durationMin = b.DurationMin,
                windowBeforeMin = b.BeforeMin,
                windowAfterMin = b.AfterMin,
            }).ToArray(),
        });
        return data.GetProperty("id").GetString()!;
    }

    public async Task AssignAsync(string shiftId, params string[] userIds)
    {
        var data = await SendAsync(HttpMethod.Put, "shift-assignments/people", new { userIds, shiftId, effectiveFrom = LiveEnv.Today });
        Assert.Equal(userIds.Length, data.GetProperty("assigned").GetArrayLength());
    }

    /// <summary>POST /approvals/:type/:id/approve as the Super Admin; returns the ApprovalItemView.</summary>
    public Task<JsonElement> ApproveAsync(string type, string id, string? note = null) =>
        SendAsync(HttpMethod.Post, $"approvals/{type}/{id}/approve", new { note });

    public void Dispose() => _http.Dispose();
}

/// <summary>
/// One person's agent, minus the UI and the host: the agent's real ApiClient (with
/// the 3.1 User-Agent) and the services the host uses, so every answer goes
/// through the agent's own models and outcome types.
/// </summary>
public sealed class LiveAgent : IDisposable
{
    private readonly List<BreakRecord> _autoSkips = new();

    private LiveAgent(LivePerson person)
    {
        Person = person;
        var platform = new DevPlatform(Directory.CreateTempSubdirectory("rxv-live-").FullName);
        Api = new ApiClient(LiveEnv.Api!, new AgentIdentity(AgentOptions.AppVersion, platform.Name, Guid.NewGuid().ToString()),
            new SessionStore(platform.Secrets), Clock, Log);
        Workday = new WorkdayService(Api, Log);
        Breaks = new BreakService(Api, Clock, Log);
        Meetings = new MeetingService(Api, Log);
        Approvals = new ApprovalService(Api, Log);
        Breaks.AutoSkipped += r => { lock (_autoSkips) _autoSkips.Add(r); };
    }

    public LivePerson Person { get; }
    public ServerClock Clock { get; } = new();
    public MemoryLog Log { get; } = new();
    public ApiClient Api { get; }
    public WorkdayService Workday { get; }
    public BreakService Breaks { get; }
    public MeetingService Meetings { get; }
    public ApprovalService Approvals { get; }
    public PublicUser User => Api.CurrentUser!;
    public AuthResult? SignIn { get; private set; }

    /// <summary>Auto-skips the break service announced (once each).</summary>
    public IReadOnlyList<BreakRecord> AutoSkips { get { lock (_autoSkips) return _autoSkips.ToList(); } }

    public static async Task<LiveAgent> SignInAsync(LivePerson person, string password = LiveEnv.Password)
    {
        var agent = new LiveAgent(person);
        for (var attempt = 0; ; attempt++)
        {
            agent.SignIn = await agent.Api.LoginAsync(person.Email, password);
            // Sign-in is limited per address; a burst of tests can meet the limit.
            if (agent.SignIn.Ok || agent.SignIn.Code is not ("RATE_LIMITED" or "TOO_MANY_ATTEMPTS") || attempt >= 3) break;
            await Task.Delay(TimeSpan.FromSeconds(20));
        }
        Assert.True(agent.SignIn.Ok, $"sign-in as {person.Email}: {agent.SignIn.Outcome} {agent.SignIn.Message}");
        return agent;
    }

    /// <summary>GET /workday/me/today, which must answer.</summary>
    public async Task<WorkdayToday> DayAsync()
    {
        var r = await Api.GetWorkdayTodayAsync();
        Assert.True(r.Ok, $"GET workday/me/today: {r}");
        return r.Data!;
    }

    /// <summary>GET /breaks/me/today through the break service (which keeps it), which must answer.</summary>
    public async Task<BreakDay> BreakDayAsync()
    {
        Assert.True(await Breaks.RefreshAsync(), "GET breaks/me/today failed");
        return Breaks.Day!;
    }

    /// <summary>One activity sample as the tracker sends it; returns the server's ack.</summary>
    public async Task<ActivityAck> ReportAsync(bool idle = false)
    {
        var r = await Api.ReportActivityAsync(new ActivityReport
        {
            At = LiveEnv.Iso(DateTimeOffset.UtcNow),
            Idle = idle,
            App = "Microsoft Excel",
            Title = "Claims October.xlsx",
        }.Truncated());
        Assert.True(r.Ok, $"POST activity/report: {r}");
        return r.Data!;
    }

    /// <summary>Start Day; a press "made" <paramref name="minutesBack"/> minutes ago is sent as a retry with that time.</summary>
    public async Task<StartDayOutcome.Started> StartDayAsync(double minutesBack = 0)
    {
        var now = DateTimeOffset.UtcNow;
        var outcome = await Workday.StartAsync(minutesBack > 0 ? now.AddMinutes(-minutesBack) : null, now);
        return Assert.IsType<StartDayOutcome.Started>(outcome);
    }

    /// <summary>A live meeting, with who mails the minutes (4.0 agents must say).</summary>
    public Task<MeetingOutcome> StartMeetingAsync(string agenda, IReadOnlyList<MeetingParticipant> participants) =>
        Meetings.StartAsync(agenda, participants, LiveEnv.MomSender);

    /// <summary>An earlier meeting, with who mails the minutes (4.0 agents must say).</summary>
    public Task<MeetingOutcome> LogPastMeetingAsync(DateTimeOffset startedAt, int durationMin, string agenda, IReadOnlyList<MeetingParticipant> participants) =>
        Meetings.LogPastAsync(startedAt, durationMin, agenda, participants, LiveEnv.MomSender);

    /// <summary>GET /approvals/me through the approval service; returns the caller's items.</summary>
    public async Task<IReadOnlyList<ApprovalItem>> MineAsync()
    {
        Assert.True(await Approvals.RefreshAsync(), "GET approvals/me failed");
        return Approvals.Mine;
    }

    public void Dispose() => Api.Dispose();
}

/// <summary>
/// The dev platform whose screen is never captured: an agent signed in against a test API
/// would otherwise take its automatic screenshots and upload them, and a test API must never
/// upload anything.
/// </summary>
public sealed class NoCapturePlatform : RXVision.Agent.Core.Platform.IPlatform, RXVision.Agent.Core.Platform.IScreenCapture
{
    private readonly DevPlatform _dev;
    public NoCapturePlatform(DevPlatform dev) => _dev = dev;
    public string Name => _dev.Name;
    public string UpdateChannel => _dev.UpdateChannel;
    public RXVision.Agent.Core.Platform.IPaths Paths => _dev.Paths;
    public RXVision.Agent.Core.Platform.IIdleProbe Idle => _dev.Idle;
    public RXVision.Agent.Core.Platform.ILockProbe Lock => _dev.Lock;
    public RXVision.Agent.Core.Platform.ISleepClock SleepClock => _dev.SleepClock;
    public RXVision.Agent.Core.Platform.IForegroundProbe Foreground => _dev.Foreground;
    public RXVision.Agent.Core.Platform.ICallWindowProbe CallWindows => _dev.CallWindows;
    public RXVision.Agent.Core.Platform.IScreenCapture Screen => this;
    public RXVision.Agent.Core.Platform.ISecretStore Secrets => _dev.Secrets;
    public RXVision.Agent.Core.Platform.IAutostart Autostart => _dev.Autostart;
    public RXVision.Agent.Core.Platform.IPermissions Permissions => _dev.Permissions;
    public RXVision.Agent.Core.Platform.ISoundPlayer Sound => _dev.Sound;
    public RXVision.Agent.Core.Platform.IScreenInfo ScreenInfo => _dev.ScreenInfo;
    public RXVision.Agent.Core.Platform.IUpdateInstaller Updater => _dev.Updater;
    public RXVision.Agent.Core.Platform.IShell Shell => _dev.Shell;
    public RXVision.Agent.Core.Platform.ILegacyMigration Legacy => _dev.Legacy;
    public RXVision.Agent.Core.Platform.CapturedImage? Capture(int maxLongSide, int quality) => null;
}
