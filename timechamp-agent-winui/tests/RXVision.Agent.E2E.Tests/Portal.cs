using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Xunit;

namespace RXVision.Agent.E2E.Tests;

/// <summary>An answer from the API: the status and the whole JSON body.</summary>
public sealed record Answer(int Status, JsonElement Json)
{
    public JsonElement Data => Json.TryGetProperty("data", out var d) ? d : default;
    public string? Code => Json.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.Object && e.TryGetProperty("code", out var c) ? c.GetString() : null;
    public bool Ok => Status is >= 200 and < 300;
    public override string ToString() => $"{Status} {Json.GetRawText()[..Math.Min(600, Json.GetRawText().Length)]}";
}

/// <summary>
/// Someone using the API directly with cookies, as the portal does (Admin, Manager), or a
/// second device of the person under test (to read what the server has, independently of
/// the agent). Waits out the API's rate limit.
/// </summary>
public sealed class Portal : IDisposable
{
    private readonly HttpClient _http;

    private Portal(HttpClient http) => _http = http;

    public string Id { get; private set; } = "";
    public string Name { get; private set; } = "";

    /// <param name="userAgent">The User-Agent to send (a 4.0 agent's for reads that depend on it); none: the portal.</param>
    public static async Task<Portal> SignInAsync(string email, string password, string? userAgent = null)
    {
        var http = new HttpClient(new HttpClientHandler { CookieContainer = new CookieContainer(), UseCookies = true })
        {
            BaseAddress = new Uri(E2EEnv.Api + "/"),
            Timeout = TimeSpan.FromSeconds(30),
        };
        if (userAgent is not null) http.DefaultRequestHeaders.UserAgent.ParseAdd(userAgent);
        var portal = new Portal(http);
        var me = await portal.SendAsync(HttpMethod.Post, "auth/login", new { email, password });
        Assert.True(me.Ok, $"sign-in as {email}: {me}");
        var user = me.Data.GetProperty("user");
        portal.Id = user.GetProperty("id").GetString()!;
        portal.Name = user.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
        return portal;
    }

    public async Task<Answer> SendAsync(HttpMethod method, string path, object? body = null, IDictionary<string, string>? headers = null)
    {
        for (var attempt = 0; ; attempt++)
        {
            using var req = new HttpRequestMessage(method, path);
            if (body is not null) req.Content = JsonContent.Create(body, body.GetType());
            foreach (var (k, v) in headers ?? new Dictionary<string, string>()) req.Headers.TryAddWithoutValidation(k, v);
            using var res = await _http.SendAsync(req);
            var text = await res.Content.ReadAsStringAsync();
            if ((int)res.StatusCode == 429 && attempt < 3 && !path.StartsWith("agent/", StringComparison.Ordinal))
            {
                var wait = res.Headers.RetryAfter?.Delta ?? TimeSpan.FromSeconds(15);
                await Task.Delay(wait > TimeSpan.FromSeconds(60) ? TimeSpan.FromSeconds(60) : wait + TimeSpan.FromSeconds(1));
                continue;
            }
            JsonElement json;
            try { json = JsonDocument.Parse(text.Length == 0 ? "{}" : text).RootElement.Clone(); }
            catch (JsonException) { json = JsonDocument.Parse(JsonSerializer.Serialize(new { raw = text })).RootElement.Clone(); }
            return new Answer((int)res.StatusCode, json);
        }
    }

    public Task<Answer> GetAsync(string path) => SendAsync(HttpMethod.Get, path);
    public Task<Answer> PostAsync(string path, object? body = null, IDictionary<string, string>? headers = null) => SendAsync(HttpMethod.Post, path, body ?? new { }, headers);
    public Task<Answer> PutAsync(string path, object body) => SendAsync(HttpMethod.Put, path, body);
    public Task<Answer> PatchAsync(string path, object body) => SendAsync(HttpMethod.Patch, path, body);
    public Task<Answer> DeleteAsync(string path) => SendAsync(HttpMethod.Delete, path);

    /// <summary>A call that must succeed; returns its data.</summary>
    public async Task<JsonElement> MustAsync(HttpMethod method, string path, object? body = null)
    {
        var a = await SendAsync(method, path, body);
        Assert.True(a.Ok, $"{method} {path}: {a}");
        return a.Data;
    }

    public void Dispose() => _http.Dispose();
}

/// <summary>A person made for one test.</summary>
public sealed record Person(string Id, string Email, string Password, string FirstName, string LastName)
{
    public string Name => $"{FirstName} {LastName}";
}

/// <summary>One scheduled break of a test shift, in minutes from now.</summary>
public sealed record ShiftBreak(string Kind, int AtMin, int DurationMin, int BeforeMin, int AfterMin);

/// <summary>What the Admin does in the portal around the agent: people, shifts, settings, keys.</summary>
public static class PortalSetup
{
    public const string Password = "Rx-Vision-40!";
    private static readonly string Run = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString("x");
    private static int _seq;

    /// <summary>A new person (fresh email) in <paramref name="departmentId"/>.</summary>
    public static async Task<Person> CreateStaffAsync(Portal admin, string first, string last, string departmentId, string role = "USER")
    {
        var email = $"{first.ToLowerInvariant()}.{last.ToLowerInvariant()}.{Run}.{Interlocked.Increment(ref _seq)}@agent-e2e.test";
        var data = await admin.MustAsync(HttpMethod.Post, "users",
            new { firstName = first, lastName = last, email, password = Password, role, departmentId });
        var id = data.GetProperty("created").EnumerateArray().Single().GetProperty("id").GetString()!;
        return new Person(id, email, Password, first, last);
    }

    /// <summary>A shift from now-120 to now+300 minutes with these breaks, assigned to the people from today.</summary>
    public static Task<string> ShiftAsync(Portal admin, string label, IEnumerable<ShiftBreak> breaks, params string[] userIds) =>
        ShiftAsync(admin, label, breaks, ringDurationMin: 5, userIds);

    public static async Task<string> ShiftAsync(Portal admin, string label, IEnumerable<ShiftBreak> breaks, int ringDurationMin, params string[] userIds)
    {
        var at = DateTimeOffset.UtcNow;
        var shift = await admin.MustAsync(HttpMethod.Post, "shifts", new
        {
            name = $"E2E {label} {Run}.{Interlocked.Increment(ref _seq)}",
            start = E2EEnv.Hm(at.AddMinutes(-120)),
            end = E2EEnv.Hm(at.AddMinutes(300)),
            workDays = new[] { 1, 2, 3, 4, 5, 6, 7 },
            ringLeadMin = 1,
            ringDurationMin,
            reasonOnEarly = false,
            reasonOnLate = false,
            reasonMinChars = 10,
            overrunReason = true,
            overrunGraceMin = 3,
            breaks = breaks.Select(b => new
            {
                kind = b.Kind,
                enabled = true,
                startTime = E2EEnv.Hm(at.AddMinutes(b.AtMin)),
                durationMin = b.DurationMin,
                windowBeforeMin = b.BeforeMin,
                windowAfterMin = b.AfterMin,
            }).ToArray(),
        });
        var id = shift.GetProperty("id").GetString()!;
        if (userIds.Length > 0)
        {
            var assigned = await admin.MustAsync(HttpMethod.Put, "shift-assignments/people", new { userIds, shiftId = id, effectiveFrom = E2EEnv.Today });
            Assert.Equal(userIds.Length, assigned.GetProperty("assigned").GetArrayLength());
        }
        return id;
    }

    /// <summary>Morning closed, lunch open now (an hour and a half of window), evening later.</summary>
    public static readonly ShiftBreak[] LunchOpen =
    {
        new("MORNING", -60, 20, 10, 10),
        new("LUNCH", 0, 40, 30, 60),
        new("EVENING", 180, 20, 10, 10),
    };
}
