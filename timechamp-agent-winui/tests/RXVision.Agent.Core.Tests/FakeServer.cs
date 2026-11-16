using System.Net;
using System.Text;
using System.Text.Json;
using RXVision.Agent.Core.Api;

namespace RXVision.Agent.Core.Tests;

/// <summary>A scripted HTTP transport: route by "METHOD path" to a responder.</summary>
public sealed class FakeServer : HttpMessageHandler
{
    private readonly List<(string Key, Func<HttpRequestMessage, string?, HttpResponseMessage> Respond)> _routes = new();
    private readonly List<(string Method, string Path, string? Body, string? Cookie)> _calls = new();
    public Func<HttpRequestMessage, Exception?> FailWith { get; set; } = _ => null;

    /// <summary>Every request so far, oldest first: a copy, safe to read while the agent keeps calling in the background.</summary>
    public List<(string Method, string Path, string? Body, string? Cookie)> Calls
    {
        get { lock (_calls) return _calls.ToList(); }
    }

    /// <summary>Answers "METHOD path" (a trailing * matches a prefix). Routing the same key again replaces it.</summary>
    public FakeServer Route(string methodAndPath, Func<HttpRequestMessage, string?, HttpResponseMessage> respond)
    {
        lock (_routes)
        {
            _routes.RemoveAll(r => r.Key == methodAndPath);
            _routes.Add((methodAndPath, respond));
        }
        return this;
    }

    private readonly List<(string Key, string? Body, string? EventId, string? EventAt, string? Seq)> _replays = new();

    /// <summary>Every request with its offline-replay headers (SPEC 6), oldest first.</summary>
    public List<(string Key, string? Body, string? EventId, string? EventAt, string? Seq)> Sent
    {
        get { lock (_calls) return _replays.ToList(); }
    }

    public int Count(string methodAndPath)
    {
        lock (_calls) return _calls.Count(c => $"{c.Method} {c.Path}" == methodAndPath);
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
        var path = request.RequestUri!.AbsolutePath.Replace("/api/v1/", "");
        var cookie = request.Headers.TryGetValues("Cookie", out var c) ? string.Join("; ", c) : null;
        string? Header(string name) => request.Headers.TryGetValues(name, out var v) ? string.Join(",", v) : null;
        lock (_calls)
        {
            _calls.Add((request.Method.Method, path, body, cookie));
            _replays.Add(($"{request.Method.Method} {path}", body, Header("X-Client-Event-Id"), Header("X-Event-At"), Header("X-Client-Seq")));
        }
        if (FailWith(request) is { } ex) throw ex;
        var key = $"{request.Method.Method} {path}";
        List<(string Key, Func<HttpRequestMessage, string?, HttpResponseMessage> Respond)> routes;
        lock (_routes) routes = _routes.ToList();
        foreach (var (k, respond) in routes)
            if (k == key || (k.EndsWith("*") && key.StartsWith(k[..^1]))) return respond(request, body);
        return Error(404, "NOT_FOUND", $"Cannot {key}");
    }

    public static HttpResponseMessage Ok(object? data, params string[] setCookies)
    {
        var res = new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(JsonSerializer.Serialize(new { success = true, data }, Json.Options), Encoding.UTF8, "application/json"),
        };
        foreach (var sc in setCookies) res.Headers.Add("Set-Cookie", sc);
        return res;
    }

    public static HttpResponseMessage Error(int status, string code, string message, object? details = null) => new((HttpStatusCode)status)
    {
        Content = new StringContent(JsonSerializer.Serialize(new
        {
            success = false,
            message,
            error = details is null ? (object)new { code, message } : new { code, message, details },
        }, Json.Options), Encoding.UTF8, "application/json"),
    };

    public static HttpResponseMessage Html(int status, string html = "<html>proxy</html>") => new((HttpStatusCode)status)
    {
        Content = new StringContent(html, Encoding.UTF8, "text/html"),
    };

    public static object User(string id = "u-1", string role = "USER") =>
        new { user = new { id, email = $"{id}@x.test", firstName = "Asha", lastName = "K", role, screenshotsEnabled = true } };

    public static string AccessCookie(string sub = "u-1", int expInSeconds = 900)
    {
        var header = B64("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        var payload = B64($"{{\"sub\":\"{sub}\",\"exp\":{DateTimeOffset.UtcNow.AddSeconds(expInSeconds).ToUnixTimeSeconds()}}}");
        return $"accessToken={header}.{payload}.sig; Path=/; HttpOnly";
    }

    public static string RefreshCookie(string value = "rt-1") => $"refreshToken={value}; Path=/api/v1/auth; HttpOnly";

    public static string Jwt(string sub) =>
        $"{B64("{\"alg\":\"HS256\"}")}.{B64($"{{\"sub\":\"{sub}\",\"typ\":\"enroll\"}}")}.sig";

    private static string B64(string s) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(s)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
