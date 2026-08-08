using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace TimeChampAgent.Services;

/// <summary>
/// Talks to the Time Champ backend. Auth is cookie-based (the backend sets
/// httpOnly <c>accessToken</c> + <c>refreshToken</c> cookies on login), so we
/// drive an <see cref="HttpClient"/> backed by a <see cref="CookieContainer"/>,
/// exactly like a browser. On a 401 we transparently call /auth/refresh once
/// and retry. The refresh token is persisted (see <see cref="SessionStore"/>)
/// so the user only logs in once.
/// </summary>
public sealed class ApiClient
{
    private readonly AgentConfig _config;
    private readonly CookieContainer _cookies = new();
    private readonly HttpClient _http;
    private readonly Uri _baseUri;

    public PublicUser? CurrentUser { get; private set; }
    public bool IsAuthenticated => CurrentUser is not null;

    public ApiClient(AgentConfig config)
    {
        _config = config;
        _baseUri = new Uri(config.ApiBaseUrl.TrimEnd('/') + "/");
        var handler = new HttpClientHandler
        {
            CookieContainer = _cookies,
            UseCookies = true,
            AllowAutoRedirect = false,
        };
        _http = new HttpClient(handler) { BaseAddress = _baseUri, Timeout = TimeSpan.FromSeconds(20) };
    }

    // ---- Auth --------------------------------------------------------------

    /// <summary>Log in with email + password. Persists the session on success.</summary>
    public async Task<(bool ok, string? error)> LoginAsync(string email, string password, CancellationToken ct = default)
    {
        try
        {
            using var res = await _http.PostAsJsonAsync(
                "auth/login", new LoginRequest { Email = email, Password = password }, JsonOpts.Default, ct);

            if (res.StatusCode == HttpStatusCode.Unauthorized)
                return (false, "Wrong email or password.");
            if (!res.IsSuccessStatusCode)
                return (false, $"Sign-in failed ({(int)res.StatusCode}).");

            var body = await res.Content.ReadFromJsonAsync<Envelope<LoginResponse>>(JsonOpts.Default, ct);
            CurrentUser = body?.Data?.User;
            PersistSession();
            return (true, null);
        }
        catch (Exception ex)
        {
            return (false, $"Can't reach the server. {ex.Message}");
        }
    }

    /// <summary>Password-less sign-in using a baked-in enrollment token. Persists on success.</summary>
    public async Task<(bool ok, string? error)> EnrollAsync(string token, CancellationToken ct = default)
    {
        try
        {
            using var res = await _http.PostAsJsonAsync(
                "auth/enroll", new { token }, JsonOpts.Default, ct);

            if (!res.IsSuccessStatusCode)
                return (false, $"Enrollment failed ({(int)res.StatusCode}).");

            var body = await res.Content.ReadFromJsonAsync<Envelope<LoginResponse>>(JsonOpts.Default, ct);
            CurrentUser = body?.Data?.User;
            PersistSession();
            return (true, null);
        }
        catch (Exception ex)
        {
            return (false, $"Can't reach the server. {ex.Message}");
        }
    }

    /// <summary>Try to resume a saved session on startup. Returns true if still valid.</summary>
    public async Task<bool> TryRestoreSessionAsync(CancellationToken ct = default)
    {
        var saved = SessionStore.Load();
        if (saved is null || string.IsNullOrWhiteSpace(saved.RefreshToken)) return false;

        // Seed the refresh cookie (scoped to the /auth path, matching the backend).
        var authUri = new Uri(_baseUri, "auth/");
        _cookies.Add(authUri, new Cookie("refreshToken", saved.RefreshToken) { Path = authUri.AbsolutePath.TrimEnd('/') });

        if (!await RefreshAsync(ct)) return false;

        CurrentUser = new PublicUser
        {
            Id = saved.UserId,
            Email = saved.Email,
            FirstName = saved.DisplayName,
        };
        return true;
    }

    private async Task<bool> RefreshAsync(CancellationToken ct)
    {
        try
        {
            using var res = await _http.PostAsync("auth/refresh", content: null, ct);
            if (res.IsSuccessStatusCode)
            {
                PersistSession(); // refresh rotates the token — save the new one
                return true;
            }
        }
        catch { /* fall through */ }
        return false;
    }

    public async Task LogoutAsync(CancellationToken ct = default)
    {
        try { await _http.PostAsync("auth/logout", content: null, ct); } catch { }
        CurrentUser = null;
        SessionStore.Clear();
    }

    /// <summary>Server origin (scheme+host+port) — socket.io lives at the root, not under the API prefix.</summary>
    public string Origin => _baseUri.GetLeftPart(UriPartial.Authority);

    /// <summary>Current access-token cookie value (2-min TTL), used to authenticate the chat socket.</summary>
    public string? AccessToken => ReadCookie("accessToken", _baseUri);

    /// <summary>Rotate the session so a freshly-minted access token is available for a socket handshake.</summary>
    public Task<bool> RefreshSessionAsync(CancellationToken ct = default) => RefreshAsync(ct);

    // ---- Chat --------------------------------------------------------------

    public Task<List<ChatContact>?> GetContactsAsync(CancellationToken ct = default) =>
        SendJsonAsync<List<ChatContact>>(HttpMethod.Get, "chat/contacts", body: null, ct);

    public Task<List<ChatMessage>?> GetConversationAsync(string withUserId, int limit = 50, CancellationToken ct = default) =>
        SendJsonAsync<List<ChatMessage>>(HttpMethod.Get, $"chat/messages?withUserId={withUserId}&limit={limit}", body: null, ct);

    public Task<ChatMessage?> SendMessageAsync(string toUserId, string body, CancellationToken ct = default) =>
        SendJsonAsync<ChatMessage>(HttpMethod.Post, "chat/messages", new { toUserId, body }, ct);

    // ---- Screenshots -------------------------------------------------------

    /// <summary>Upload a captured screenshot (multipart). <paramref name="kind"/> is AUTO or MANUAL.</summary>
    public async Task<bool> UploadScreenshotAsync(byte[] png, string kind, CancellationToken ct = default)
    {
        try
        {
            using var res = await SendWithRefreshAsync(() =>
            {
                var form = new MultipartFormDataContent();
                var img = new ByteArrayContent(png);
                img.Headers.ContentType = new MediaTypeHeaderValue("image/png");
                form.Add(img, "file", $"screen-{DateTime.UtcNow:yyyyMMdd-HHmmss}.png");
                form.Add(new StringContent(kind), "kind");
                form.Add(new StringContent(DateTime.UtcNow.ToString("o")), "takenAt");
                return new HttpRequestMessage(HttpMethod.Post, "screenshots") { Content = form };
            }, ct);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    // ---- Presence ----------------------------------------------------------

    public Task<CurrentPresence?> StartAsync(string type, string? note, CancellationToken ct = default) =>
        SendJsonAsync<CurrentPresence>(HttpMethod.Post, "presence/start",
            new StartPresenceRequest { Type = type, Note = note }, ct);

    public Task<CurrentPresence?> EndAsync(CancellationToken ct = default) =>
        SendJsonAsync<CurrentPresence>(HttpMethod.Post, "presence/end", body: null, ct);

    public Task<CurrentPresence?> GetCurrentAsync(CancellationToken ct = default) =>
        SendJsonAsync<CurrentPresence>(HttpMethod.Get, "presence/me/current", body: null, ct);

    public Task<MyToday?> GetTodayAsync(CancellationToken ct = default) =>
        SendJsonAsync<MyToday>(HttpMethod.Get, "presence/me/today", body: null, ct);

    /// <summary>Online heartbeat. <paramref name="idle"/> lets the server discount idle time.</summary>
    public async Task HeartbeatAsync(bool idle, CancellationToken ct = default)
    {
        try
        {
            var payload = new Dictionary<string, object> { ["idle"] = idle };
            await SendWithRefreshAsync(() =>
            {
                var req = new HttpRequestMessage(HttpMethod.Post, "presence/heartbeat")
                {
                    Content = JsonContent.Create(payload, options: JsonOpts.Default),
                };
                return req;
            }, ct);
        }
        catch { /* heartbeats are best-effort */ }
    }

    // ---- Activity ----------------------------------------------------------

    /// <summary>Report the current foreground app/website + idle. Returns the day's
    /// progress plus the <c>shouldCapture</c> gate the agent uses for screenshots.</summary>
    public Task<ActivityAck?> ReportActivityAsync(ActivityReport report, CancellationToken ct = default) =>
        SendJsonAsync<ActivityAck>(HttpMethod.Post, "activity/report", report, ct);

    /// <summary>The signed-in user's activity rollup for today — active/idle seconds,
    /// the 9h basis, and the hourly split. Drives the dashboard Focus Score + bars.</summary>
    public Task<DailyActivity?> GetActivityTodayAsync(CancellationToken ct = default) =>
        SendJsonAsync<DailyActivity>(HttpMethod.Get, "activity/me/today", body: null, ct);

    /// <summary>Tell the server the user ended their working day ("End Day"). Idempotent —
    /// after this, tracking, screen captures and attendance all stop for the rest of the
    /// local day. Returns false when the server never got the message, so the caller can
    /// say so instead of silently pretending the day ended.</summary>
    public async Task<bool> EndDayAsync(CancellationToken ct = default)
    {
        try
        {
            using var res = await SendWithRefreshAsync(
                () => new HttpRequestMessage(HttpMethod.Post, "activity/end-day"), ct);
            return res.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Whether the signed-in user has already ended today's working day.
    /// Checked at startup so a restart can't resume a day that is already over.
    /// Unreachable server → false, i.e. behave as a normal working day.</summary>
    public async Task<bool> IsDayEndedAsync(CancellationToken ct = default)
    {
        var today = await GetActivityTodayAsync(ct);
        return today?.DayEnded ?? false;
    }

    // ---- Plumbing ----------------------------------------------------------

    private async Task<T?> SendJsonAsync<T>(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        try
        {
            using var res = await SendWithRefreshAsync(() =>
            {
                var req = new HttpRequestMessage(method, path);
                if (body is not null) req.Content = JsonContent.Create(body, options: JsonOpts.Default);
                return req;
            }, ct);

            if (!res.IsSuccessStatusCode) return default;
            var env = await res.Content.ReadFromJsonAsync<Envelope<T>>(JsonOpts.Default, ct);
            return env is not null ? env.Data : default;
        }
        catch
        {
            return default;
        }
    }

    /// <summary>Sends the request; on a single 401 refreshes the session and retries once.</summary>
    private async Task<HttpResponseMessage> SendWithRefreshAsync(Func<HttpRequestMessage> build, CancellationToken ct)
    {
        var res = await _http.SendAsync(build(), ct);
        if (res.StatusCode == HttpStatusCode.Unauthorized)
        {
            res.Dispose();
            if (await RefreshAsync(ct))
                res = await _http.SendAsync(build(), ct);
        }
        return res;
    }

    private void PersistSession()
    {
        var refresh = ReadCookie("refreshToken", new Uri(_baseUri, "auth/"));
        if (string.IsNullOrEmpty(refresh)) return;
        SessionStore.Save(new SavedSession
        {
            RefreshToken = refresh,
            UserId = CurrentUser?.Id ?? "",
            Email = CurrentUser?.Email ?? "",
            DisplayName = CurrentUser?.DisplayName ?? "",
        });
    }

    private string? ReadCookie(string name, Uri uri)
    {
        foreach (Cookie c in _cookies.GetCookies(uri))
            if (string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase))
                return c.Value;
        return null;
    }
}
