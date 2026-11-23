using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;

namespace RXVision.Agent.Core.Api;

/// <summary>Who is calling: sent on every request so the server can tell agents apart.</summary>
public sealed record AgentIdentity(string Version, string Platform, string DeviceId);

/// <summary>Outcome of a sign-in attempt.</summary>
public sealed record AuthResult(ApiOutcome Outcome, PublicUser? User, string? Message, string? Code = null)
{
    public bool Ok => Outcome == ApiOutcome.Ok;
}

/// <summary>
/// Talks to the RX Vision API.
///
/// Auth is cookie based, exactly like the portal: sign-in sets an access cookie
/// (minutes) and a refresh cookie (days). A 401 triggers one shared refresh; a
/// refresh the server refuses falls back to the enrollment token, and only when
/// both are refused by the API itself is the session declared lost. Anything
/// that is not a real answer from the API (no network, timeouts, a proxy page,
/// 5xx, 429) is Transient and never signs anyone out.
/// </summary>
public sealed class ApiClient : IDisposable
{
    private readonly HttpClient _http;
    private readonly HttpClient _bulk;
    private readonly HttpClient _s3;
    private readonly CookieHandler _cookies;
    private readonly SessionStore _sessions;
    private readonly ILog _log;
    private readonly ServerClock _clock;
    private readonly Uri _base;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);
    private long _generation;
    private int _sessionLostRaised;

    /// <summary>The enrollment token to fall back on (per-user downloads and setup codes).</summary>
    public Func<string?> EnrollmentToken { get; set; } = () => null;

    private PublicUser? _currentUser;
    public PublicUser? CurrentUser
    {
        get => Volatile.Read(ref _currentUser);
        private set => Volatile.Write(ref _currentUser, value);
    }
    public bool IsSignedIn => CurrentUser is not null;
    public Uri BaseUri => _base;
    public string Origin => _base.GetLeftPart(UriPartial.Authority);

    /// <summary>Raised once when the API refuses both the refresh token and the enrollment token.</summary>
    public event Action<string>? SessionLost;

    private long _reachedTicks;
    private long _unreachableTicks;

    /// <summary>When the API last answered (any real answer, a refusal included); MinValue: never.</summary>
    public DateTimeOffset LastReachedAt => Ticks(Interlocked.Read(ref _reachedTicks));
    /// <summary>When a call last got no usable answer (no network, timeout, 5xx); MinValue: never.</summary>
    public DateTimeOffset LastUnreachableAt => Ticks(Interlocked.Read(ref _unreachableTicks));
    /// <summary>The last call reached the API (false before any call, and after a failed one).</summary>
    public bool Reachable => Interlocked.Read(ref _reachedTicks) > Interlocked.Read(ref _unreachableTicks);

    private static DateTimeOffset Ticks(long ticks) => ticks == 0 ? DateTimeOffset.MinValue : new DateTimeOffset(ticks, TimeSpan.Zero);

    private void NoteContact(ApiOutcome outcome)
    {
        var now = DateTimeOffset.UtcNow.UtcTicks;
        if (outcome == ApiOutcome.Transient) Interlocked.Exchange(ref _unreachableTicks, now);
        else Interlocked.Exchange(ref _reachedTicks, now);
    }

    /// <summary>Raised after every successful sign-in, enrollment or restore.</summary>
    public event Action<PublicUser>? SignedIn;

    public ApiClient(
        string apiBaseUrl,
        AgentIdentity identity,
        SessionStore sessions,
        ServerClock clock,
        ILog log,
        HttpMessageHandler? innerHandler = null)
    {
        _base = new Uri(apiBaseUrl.TrimEnd('/') + "/");
        _sessions = sessions;
        _clock = clock;
        _log = log;

        var inner = innerHandler ?? new SocketsHttpHandler
        {
            UseCookies = false,
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.All,
            // Re-resolve DNS and drop stale connections now and then.
            PooledConnectionLifetime = TimeSpan.FromMinutes(10),
            ConnectTimeout = TimeSpan.FromSeconds(15),
            // 4.0: IPv4 and IPv6 raced (250 ms stagger), so a broken route on one never
            // stalls sign-in for the whole connect timeout.
            ConnectCallback = new HappyEyeballs(log).ConnectAsync,
        };
        _cookies = new CookieHandler(inner);
        _http = new HttpClient(_cookies, disposeHandler: false) { BaseAddress = _base, Timeout = TimeSpan.FromSeconds(25) };
        // Downloads (agent updates, ~100 MB) get their own budget; callers cancel them.
        _bulk = new HttpClient(_cookies, disposeHandler: false) { BaseAddress = _base, Timeout = Timeout.InfiniteTimeSpan };
        // 4.0.1: presigned S3 uploads. No cookie jar and none of the agent headers: the
        // presigned policy is the only credential S3 needs, and our cookies are not S3's.
        _s3 = new HttpClient(inner, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan };

        foreach (var client in new[] { _http, _bulk })
        {
            client.DefaultRequestHeaders.UserAgent.ParseAdd($"RXVisionAgent/{identity.Version} ({identity.Platform})");
            client.DefaultRequestHeaders.Add("X-Agent-Version", identity.Version);
            client.DefaultRequestHeaders.Add("X-Agent-Platform", identity.Platform);
            client.DefaultRequestHeaders.Add("X-Device-Id", identity.DeviceId);
            client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        }
    }

    // ---- Sign-in ----------------------------------------------------------------

    public Task<AuthResult> LoginAsync(string email, string password, CancellationToken ct = default) =>
        AuthenticateAsync("auth/login", new { email = email.Trim(), password }, ct);

    public Task<AuthResult> EnrollAsync(string token, CancellationToken ct = default) =>
        AuthenticateAsync("auth/enroll", new { token = token.Trim() }, ct);

    private async Task<AuthResult> AuthenticateAsync(string path, object body, CancellationToken ct)
    {
        var result = await SendAsync<AuthResponse>(() => Json_(HttpMethod.Post, path, body), retryOn401: false, ct);
        if (result.Ok && result.Data?.User is { } user)
        {
            OnAuthenticated(user);
            return new AuthResult(ApiOutcome.Ok, user, null);
        }
        if (result.Ok) return new AuthResult(ApiOutcome.Transient, null, "The server's answer was not understood.");
        // Only a real answer about these credentials is final (bad input, wrong password
        // or token, blocked account). Any other refusal, such as a 404 or 405 from a
        // broken deploy, means the server is not working right now: keep trying.
        var final = result.Outcome == ApiOutcome.Rejected && IsFinalAuthRefusal(result.Status, allowBadRequest: true);
        var message = result.Status == 429
            ? result.Code == "TOO_MANY_ATTEMPTS" && result.Message is { Length: > 0 } paused ? paused : "Too many sign-in attempts. Wait a minute and try again."
            : !final
                ? "Can't reach RX Vision. Check your connection; we'll keep trying."
                : result.Status == 401 && path.EndsWith("login") ? "Wrong email or password."
                : result.Message ?? "Sign-in was refused.";
        return new AuthResult(final ? ApiOutcome.Rejected : ApiOutcome.Transient, null, message, result.Code);
    }

    /// <summary>The statuses with which the API ends a session or refuses credentials for good.</summary>
    internal static bool IsFinalAuthRefusal(int status, bool allowBadRequest) =>
        status is 401 or 403 || (allowBadRequest && status == 400);

    /// <summary>
    /// 4.0: resumes a saved session without the server. The person is signed in at
    /// once, as the session last said; the refresh token is used (and rotated) by the
    /// first call that needs it. A token the server no longer takes ends the session
    /// then (<see cref="SessionLost"/>), with everything recorded meanwhile kept on disk.
    /// </summary>
    public PublicUser RestoreOffline(SavedSession saved)
    {
        SeedRefreshCookie(saved.RefreshToken);
        var user = new PublicUser
        {
            Id = saved.UserId,
            Email = saved.Email,
            FirstName = saved.DisplayName,
            Role = saved.Role,
            ScreenshotsEnabled = saved.ScreenshotsEnabled,
            AvatarId = saved.AvatarId,
        };
        CurrentUser = user;
        Volatile.Write(ref _avatarId, user.AvatarId);
        Interlocked.Exchange(ref _sessionLostRaised, 0);
        SignedIn?.Invoke(user);
        return user;
    }

    /// <summary>
    /// Resumes a saved session. Ok: signed in. Rejected: the saved token is dead
    /// (fall back to enrollment or the sign-in screen). Transient: try again later.
    /// </summary>
    public async Task<AuthResult> RestoreAsync(SavedSession saved, CancellationToken ct = default)
    {
        SeedRefreshCookie(saved.RefreshToken);
        var refreshed = await PostRefreshAsync(ct);
        if (refreshed.Outcome != ApiOutcome.Ok) return new AuthResult(refreshed.Outcome, null, refreshed.Message);

        var user = new PublicUser
        {
            Id = saved.UserId,
            Email = saved.Email,
            FirstName = saved.DisplayName,
            Role = saved.Role,
            ScreenshotsEnabled = saved.ScreenshotsEnabled,
            AvatarId = saved.AvatarId,
        };
        OnAuthenticated(user);
        return new AuthResult(ApiOutcome.Ok, user, null);
    }

    /// <summary>
    /// Reads the signed-in person from the server (GET /users/{id}: role, name,
    /// screenshot setting) and keeps it with the saved session. A session saved by
    /// 2.9.1 carries no role, and a role can change while the agent runs; without
    /// this a manager restored from such a session is treated as staff until they
    /// sign in again. Without an answer, what is known stays.
    /// </summary>
    /// <returns>The person as the server has them, or null when nothing changed here.</returns>
    public async Task<PublicUser?> RefreshCurrentUserAsync(CancellationToken ct = default)
    {
        var user = CurrentUser;
        if (user is null || string.IsNullOrEmpty(user.Id)) return null;
        var result = await SendJsonAsync<PublicUser>(HttpMethod.Get, "users/" + Uri.EscapeDataString(user.Id), null, ct);
        if (!result.Ok || result.Data is not { } fresh || fresh.Id != user.Id) return null;
        if (string.IsNullOrEmpty(fresh.Email)) fresh.Email = user.Email;
        // Signed out, or in again, meanwhile: that session is not this answer's to change.
        if (!ReferenceEquals(Interlocked.CompareExchange(ref _currentUser, fresh, user), user)) return null;
        Persist();
        return fresh;
    }

    public async Task LogoutAsync(CancellationToken ct = default)
    {
        try
        {
            using var res = await _http.PostAsync("auth/logout", content: null, ct);
        }
        catch (Exception ex)
        {
            // Signing out locally must work offline too.
            LogNetworkFailure("POST", "auth/logout", ex);
        }
        CurrentUser = null;
        _sessions.Clear();
        _cookies.Clear();
    }

    /// <summary>Forget the session locally (after it was lost); keeps nothing usable.</summary>
    public void DropSession()
    {
        CurrentUser = null;
        _sessions.Clear();
        _cookies.Clear();
    }

    private void OnAuthenticated(PublicUser user)
    {
        CurrentUser = user;
        Volatile.Write(ref _avatarId, user.AvatarId);
        Interlocked.Exchange(ref _sessionLostRaised, 0);
        Persist();
        SignedIn?.Invoke(user);
    }

    /// <summary>Saves the current session again (after the secret store refused a save while it was not answering).</summary>
    public void PersistSession() => Persist();

    private void Persist()
    {
        var refresh = _cookies.Get(new Uri(_base, "auth/"), "refreshToken");
        if (string.IsNullOrEmpty(refresh) || CurrentUser is null) return;
        _sessions.Save(new SavedSession
        {
            ApiBaseUrl = _base.ToString().TrimEnd('/'),
            RefreshToken = refresh,
            UserId = CurrentUser.Id,
            Email = CurrentUser.Email,
            DisplayName = CurrentUser.DisplayName,
            Role = CurrentUser.Role,
            ScreenshotsEnabled = CurrentUser.ScreenshotsEnabled,
            AvatarId = Volatile.Read(ref _avatarId),
        });
    }

    private string? _avatarId;

    /// <summary>Keeps the avatar's ID with the saved session, so the next start can draw it before any answer.</summary>
    public void RememberAvatar(string? avatarId)
    {
        if (Interlocked.Exchange(ref _avatarId, avatarId) != avatarId) Persist();
    }

    private void SeedRefreshCookie(string refreshToken)
    {
        var authUri = new Uri(_base, "auth/");
        _cookies.Set(authUri, new Cookie("refreshToken", refreshToken, authUri.AbsolutePath.TrimEnd('/')));
    }

    // ---- Refresh ----------------------------------------------------------------

    /// <summary>
    /// Renews the session, one call at a time across the whole agent. Everything
    /// shares one cookie jar, so when the access token expires every loop gets a
    /// 401 in the same second; only the first refreshes, the rest reuse its token.
    /// </summary>
    public async Task<ApiOutcome> RefreshAsync(CancellationToken ct = default)
    {
        var seen = Interlocked.Read(ref _generation);
        await _refreshGate.WaitAsync(ct);
        try
        {
            if (Interlocked.Read(ref _generation) != seen) return ApiOutcome.Ok;

            var refreshed = await PostRefreshAsync(ct);
            if (refreshed.Ok)
            {
                Interlocked.Increment(ref _generation);
                Persist();
                return ApiOutcome.Ok;
            }
            if (refreshed.Transient) return ApiOutcome.Transient;

            // The refresh token was refused. The enrollment token, if this build has
            // one for this same person, can sign us back in without anyone typing.
            var token = EnrollmentToken();
            if (!string.IsNullOrWhiteSpace(token) && TokenBelongsToCurrentUser(token))
            {
                var enrolled = await AuthenticateAsync("auth/enroll", new { token }, ct);
                if (enrolled.Ok)
                {
                    Interlocked.Increment(ref _generation);
                    return ApiOutcome.Ok;
                }
                if (enrolled.Outcome == ApiOutcome.Transient) return ApiOutcome.Transient;
            }

            RaiseSessionLost(refreshed.Message ?? "Your session has ended. Please sign in again.");
            return ApiOutcome.Unauthorized;
        }
        finally
        {
            _refreshGate.Release();
        }
    }

    private async Task<ApiResult<object>> PostRefreshAsync(CancellationToken ct)
    {
        try
        {
            using var res = await _http.PostAsync("auth/refresh", content: null, ct);
            var result = await ResultReader.ReadAsync<object>(res, ct);
            NoteContact(result.Outcome);
            // Refresh answers 401 (token dead) or 403 (account blocked) with the API's
            // JSON error, and only those end the session. Any other refusal (a 404 or
            // 405 after a broken deploy) must never sign the whole fleet out.
            if (result.Outcome == ApiOutcome.Rejected && !IsFinalAuthRefusal(result.Status, allowBadRequest: false))
                return ApiResult<object>.TransientFailure(result.Message ?? "The server is not available right now.", result.Status);
            return result;
        }
        catch (Exception ex) when (IsNetwork(ex, ct))
        {
            NoteContact(ApiOutcome.Transient);
            LogNetworkFailure("POST", "auth/refresh", ex);
            return ApiResult<object>.TransientFailure("Can't reach the server.");
        }
    }

    private bool TokenBelongsToCurrentUser(string token)
    {
        if (CurrentUser is null) return true;
        var sub = JwtSubject(token);
        return sub is null || sub == CurrentUser.Id;
    }

    internal static string? JwtSubject(string token) => JwtClaim(token, "sub");

    internal static string? JwtClaim(string token, string name)
    {
        try
        {
            var parts = token.Split('.');
            if (parts.Length != 3) return null;
            var b64 = parts[1].Replace('-', '+').Replace('_', '/');
            b64 = b64.PadRight(b64.Length + (4 - b64.Length % 4) % 4, '=');
            using var doc = JsonDocument.Parse(Convert.FromBase64String(b64));
            return doc.RootElement.TryGetProperty(name, out var v)
                ? v.ValueKind == JsonValueKind.Number ? v.GetRawText() : v.GetString()
                : null;
        }
        catch
        {
            return null;
        }
    }

    private void RaiseSessionLost(string reason)
    {
        if (Interlocked.Exchange(ref _sessionLostRaised, 1) == 1) return;
        _log.Warn("auth", $"session lost: {reason}");
        SessionLost?.Invoke(reason);
    }

    // ---- Sockets --------------------------------------------------------------------

    /// <summary>The access token for a socket handshake, refreshed first when it expires within a minute.</summary>
    public async Task<string?> GetFreshAccessTokenAsync(CancellationToken ct = default)
    {
        var token = _cookies.Get(_base, "accessToken");
        if (token is not null && JwtClaim(token, "exp") is { } expRaw && long.TryParse(expRaw, out var exp))
        {
            var expires = DateTimeOffset.FromUnixTimeSeconds(exp);
            if (expires - DateTimeOffset.UtcNow > TimeSpan.FromSeconds(60)) return token;
        }
        if (await RefreshAsync(ct) != ApiOutcome.Ok) return null;
        return _cookies.Get(_base, "accessToken");
    }

    // ---- Presence ---------------------------------------------------------------------

    public Task<ApiResult<CurrentPresence>> StartPresenceAsync(string type, string? note, CancellationToken ct = default) =>
        SendJsonAsync<CurrentPresence>(HttpMethod.Post, "presence/start", new { type, note = string.IsNullOrWhiteSpace(note) ? null : note.Trim() }, ct);

    public Task<ApiResult<CurrentPresence>> EndPresenceAsync(CancellationToken ct = default) =>
        SendJsonAsync<CurrentPresence>(HttpMethod.Post, "presence/end", new { }, ct);

    public Task<ApiResult<CurrentPresence>> GetCurrentPresenceAsync(CancellationToken ct = default) =>
        SendJsonAsync<CurrentPresence>(HttpMethod.Get, "presence/me/current", null, ct);

    public Task<ApiResult<PresenceToday>> GetPresenceTodayAsync(CancellationToken ct = default) =>
        SendJsonAsync<PresenceToday>(HttpMethod.Get, "presence/me/today", null, ct);

    public Task<ApiResult<object>> HeartbeatAsync(bool idle, CancellationToken ct = default) =>
        SendJsonAsync<object>(HttpMethod.Post, "presence/heartbeat", new { idle }, ct);

    // ---- Avatars and the ring (3.6) -------------------------------------------------------

    public Task<ApiResult<MyAvatar>> GetMyAvatarAsync(CancellationToken ct = default) =>
        SendJsonAsync<MyAvatar>(HttpMethod.Get, "me/avatar", null, ct);

    /// <summary>PUT /me/avatar: an ID from the manifest, nothing else. The server keeps only the ID.</summary>
    public Task<ApiResult<MyAvatar>> SetMyAvatarAsync(string avatarId, CancellationToken ct = default) =>
        SendJsonAsync<MyAvatar>(HttpMethod.Put, "me/avatar", new { avatarId }, ct);

    public Task<ApiResult<MyAvatar>> ResetMyAvatarAsync(CancellationToken ct = default) =>
        SendJsonAsync<MyAvatar>(HttpMethod.Delete, "me/avatar", null, ct);

    // ---- Activity ---------------------------------------------------------------------

    public Task<ApiResult<ActivityAck>> ReportActivityAsync(ActivityReport report, CancellationToken ct = default) =>
        SendJsonAsync<ActivityAck>(HttpMethod.Post, "activity/report", report, ct);

    public Task<ApiResult<DailyActivity>> GetActivityTodayAsync(CancellationToken ct = default) =>
        SendJsonAsync<DailyActivity>(HttpMethod.Get, "activity/me/today", null, ct);

    // ---- The working day (3.1) ---------------------------------------------------------

    /// <summary>GET /workday/me/today. Also corrects the server clock from its serverNow.</summary>
    public async Task<ApiResult<WorkdayToday>> GetWorkdayTodayAsync(CancellationToken ct = default)
    {
        var sent = DateTimeOffset.UtcNow;
        var result = await SendJsonAsync<WorkdayToday>(HttpMethod.Get, "workday/me/today", null, ct);
        if (result.Ok && result.Data is { ServerNow: var serverNow } && serverNow != default)
            _clock.Observe(serverNow, sent, DateTimeOffset.UtcNow);
        return result;
    }

    /// <summary>
    /// POST /activity/start-day. <paramref name="startedAt"/> is when Start Day was
    /// pressed, sent only on a retry (the server takes it when it is within the last
    /// 10 minutes and not in the future, else uses its own now).
    /// </summary>
    public Task<ApiResult<StartDayResult>> StartDayAsync(DateTimeOffset? startedAt = null, CancellationToken ct = default, string? lateReason = null) =>
        SendJsonAsync<StartDayResult>(HttpMethod.Post, "activity/start-day",
            new StartDayRequest
            {
                StartedAt = startedAt is { } at ? Iso(at) : null,
                LateReason = string.IsNullOrWhiteSpace(lateReason) ? null : ReasonText.Clean(lateReason),
            }, ct);

    /// <summary>POST /activity/end-day, with a comment for each skipped break that needs one.</summary>
    public Task<ApiResult<EndDayResult>> EndDayAsync(IReadOnlyList<SkipComment>? comments = null, CancellationToken ct = default) =>
        SendJsonAsync<EndDayResult>(HttpMethod.Post, "activity/end-day", new EndDayRequest
        {
            Comments = comments is { Count: > 0 }
                ? comments.Select(c => new SkipComment(c.BreakId, ReasonText.Clean(c.Comment))).ToList()
                : null,
        }, ct);

    // ---- Scheduled breaks ---------------------------------------------------------------

    public async Task<ApiResult<BreakDay>> GetBreakDayAsync(CancellationToken ct = default)
    {
        var sent = DateTimeOffset.UtcNow;
        var result = await SendJsonAsync<BreakDay>(HttpMethod.Get, "breaks/me/today", null, ct);
        if (result.Ok && result.Data is { ServerNow: var serverNow } && serverNow != default)
            _clock.Observe(serverNow, sent, DateTimeOffset.UtcNow);
        return result;
    }

    public Task<ApiResult<StartBreakResult>> StartBreakAsync(string kind, string? reason, CancellationToken ct = default) =>
        SendJsonAsync<StartBreakResult>(HttpMethod.Post, "breaks/start",
            new StartBreakRequest { Kind = kind, Reason = OrNull(ReasonText.Clean(reason)) }, ct);

    /// <summary>
    /// Back to work. <paramref name="askToCount"/>: true asks the approver to count the
    /// minutes over (needs the reason), false leaves them out, null says nothing (as
    /// before 3.1).
    /// </summary>
    public Task<ApiResult<EndBreakResult>> EndBreakAsync(string? overrunReason, bool? askToCount = null, CancellationToken ct = default) =>
        SendJsonAsync<EndBreakResult>(HttpMethod.Post, "breaks/end", new EndBreakRequest
        {
            OverrunReason = OrNull(ReasonText.Clean(overrunReason)),
            AskToCount = askToCount,
        }, ct);

    /// <summary>POST /breaks/skip: skips a scheduled break while its window is open.</summary>
    public Task<ApiResult<BreakRecordResult>> SkipBreakAsync(string kind, string? reason, CancellationToken ct = default) =>
        SendJsonAsync<BreakRecordResult>(HttpMethod.Post, "breaks/skip",
            new SkipBreakRequest { Kind = kind, Reason = OrNull(ReasonText.Clean(reason)) }, ct);

    /// <summary>POST /breaks/:id/comment: the one comment a skip with no reason takes.</summary>
    public Task<ApiResult<BreakRecordResult>> CommentBreakAsync(string breakId, string comment, CancellationToken ct = default) =>
        SendJsonAsync<BreakRecordResult>(HttpMethod.Post, $"breaks/{Uri.EscapeDataString(breakId)}/comment",
            new BreakCommentRequest { Comment = ReasonText.Clean(comment) }, ct);

    public Task<ApiResult<BreakHistory>> GetBreakHistoryAsync(int days = 14, CancellationToken ct = default) =>
        SendJsonAsync<BreakHistory>(HttpMethod.Get, $"breaks/me/history?days={Math.Clamp(days, 1, 31)}", null, ct);

    // ---- The status and the ring (3.6) -----------------------------------------------------

    /// <summary>GET /me/day-progress: the status, the ring and the meeting check's two times.</summary>
    public Task<ApiResult<DayProgress>> GetDayProgressAsync(CancellationToken ct = default) =>
        SendJsonAsync<DayProgress>(HttpMethod.Get, "me/day-progress", null, ct);

    /// <summary>GET /features: the release flags, read at sign-in and hourly (core review C-R04).</summary>
    public Task<ApiResult<FeatureFlags>> GetFeaturesAsync(CancellationToken ct = default) =>
        SendJsonAsync<FeatureFlags>(HttpMethod.Get, "features", null, ct);

    /// <summary>POST /meetings/status/start. <paramref name="source"/> is the only field: nothing else travels (D-20).</summary>
    public Task<ApiResult<DayProgress>> StartMeetingStatusAsync(string source, CancellationToken ct = default) =>
        SendJsonAsync<DayProgress>(HttpMethod.Post, "meetings/status/start", new { source }, ct);

    /// <summary>POST /meetings/status/end: no body. Ends whichever meeting runs; safe to repeat.</summary>
    public Task<ApiResult<DayProgress>> EndMeetingStatusAsync(CancellationToken ct = default) =>
        SendJsonAsync<DayProgress>(HttpMethod.Post, "meetings/status/end", null, ct);

    /// <summary>POST /meetings/status/confirm: no body. Still in it: the 2 hours start again from now.</summary>
    public Task<ApiResult<DayProgress>> ConfirmMeetingStatusAsync(CancellationToken ct = default) =>
        SendJsonAsync<DayProgress>(HttpMethod.Post, "meetings/status/confirm", null, ct);

    // ---- Meetings (3.1) -----------------------------------------------------------------

    /// <summary>Most people in a meeting, and the longest a name may be (the server's limits).</summary>
    public const int MaxParticipants = 30;
    public const int MaxParticipantName = 80;
    public const int MaxAgenda = 300;

    /// <summary>POST /meetings/start: a live meeting from now.</summary>
    public Task<ApiResult<StartMeetingResult>> StartMeetingAsync(string agenda, IReadOnlyList<MeetingParticipant> participants, string? momSender = null, CancellationToken ct = default) =>
        SendJsonAsync<StartMeetingResult>(HttpMethod.Post, "meetings/start",
            new StartMeetingRequest { Agenda = ReasonText.Clean(agenda), Participants = CleanParticipants(participants), MomSender = CleanName(momSender) }, ct);

    /// <summary>The longest a minutes-of-meeting sender's name may be (SPEC 2.9).</summary>
    public const int MaxMomSender = 80;

    /// <summary>A name as the server keeps it (cleaned, at most 80 characters), or null for none.</summary>
    internal static string? CleanName(string? name)
    {
        var clean = ReasonText.Clean(name);
        if (clean.Length == 0) return null;
        return clean.Length > MaxMomSender ? clean[..MaxMomSender] : clean;
    }

    /// <summary>POST /meetings/:id/end. Idempotent; a meeting under a minute comes back discarded.</summary>
    public Task<ApiResult<EndMeetingResult>> EndMeetingAsync(string meetingId, CancellationToken ct = default) =>
        SendJsonAsync<EndMeetingResult>(HttpMethod.Post, $"meetings/{Uri.EscapeDataString(meetingId)}/end", new { }, ct);

    /// <summary>POST /meetings/past: a meeting that already happened today.</summary>
    public Task<ApiResult<MeetingResult>> LogPastMeetingAsync(DateTimeOffset startedAt, int durationMin, string agenda,
        IReadOnlyList<MeetingParticipant> participants, string? momSender = null, CancellationToken ct = default) =>
        SendJsonAsync<MeetingResult>(HttpMethod.Post, "meetings/past", new PastMeetingRequest
        {
            StartedAt = Iso(startedAt),
            DurationMin = durationMin,
            Agenda = ReasonText.Clean(agenda),
            Participants = CleanParticipants(participants),
            MomSender = CleanName(momSender),
        }, ct);

    public Task<ApiResult<MeetingList>> GetMeetingsTodayAsync(CancellationToken ct = default) =>
        SendJsonAsync<MeetingList>(HttpMethod.Get, "meetings/me/today", null, ct);

    /// <summary>GET /meetings/participants?q=: active people in the company whose name matches (max 50).</summary>
    public Task<ApiResult<ParticipantList>> SearchParticipantsAsync(string? query, CancellationToken ct = default) =>
        SendJsonAsync<ParticipantList>(HttpMethod.Get, $"meetings/participants?q={Uri.EscapeDataString((query ?? "").Trim())}", null, ct);

    /// <summary>Trimmed, non-empty names of at most 80 characters, no more than 30 people.</summary>
    internal static List<MeetingParticipant> CleanParticipants(IReadOnlyList<MeetingParticipant>? participants)
    {
        var clean = new List<MeetingParticipant>();
        foreach (var p in participants ?? Array.Empty<MeetingParticipant>())
        {
            var name = ReasonText.Clean(p?.Name);
            if (name.Length == 0) continue;
            if (name.Length > MaxParticipantName) name = name[..MaxParticipantName];
            clean.Add(new MeetingParticipant(string.IsNullOrWhiteSpace(p!.Id) ? null : p.Id, name));
            if (clean.Count == MaxParticipants) break;
        }
        return clean;
    }

    // ---- Approvals (3.1) ----------------------------------------------------------------

    /// <summary>GET /approvals/me: the caller's own items from the last <paramref name="days"/> days, pending first.</summary>
    public Task<ApiResult<ApprovalList>> GetMyApprovalsAsync(int days = 7, CancellationToken ct = default) =>
        SendJsonAsync<ApprovalList>(HttpMethod.Get, $"approvals/me?days={Math.Clamp(days, 1, 31)}", null, ct);

    // ---- Screenshots --------------------------------------------------------------------

    /// <summary>
    /// 4.0.1: the image goes straight to S3 through a presigned POST the server hands
    /// out (POST screenshots/upload-url, then POST screenshots/complete), so the API
    /// never carries the bytes and the agent never holds AWS credentials. There is no
    /// other way in. A refusal (403 switched off, 409 day ended, 413, 400) is final
    /// and returned as is; an S3 upload that fails is Transient, so the caller tries
    /// again with a fresh link.
    /// </summary>
    public async Task<ApiResult<object>> UploadScreenshotAsync(CapturedImage image, string kind, DateTimeOffset takenAt, CancellationToken ct = default)
    {
        var at = Iso(takenAt);
        var ticket = await SendJsonAsync<UploadTicket>(HttpMethod.Post, "screenshots/upload-url",
            new { kind, contentType = image.ContentType, takenAt = at }, ct);
        if (!ticket.Ok) return ticket.As<object>();
        var t = ticket.Data;
        if (t is null || string.IsNullOrEmpty(t.Url) || string.IsNullOrEmpty(t.Key))
            return ApiResult<object>.TransientFailure("The server's upload link was not understood.", ticket.Status);
        if (t.MaxBytes > 0 && image.Bytes.Length > t.MaxBytes)
            return new ApiResult<object> { Outcome = ApiOutcome.Rejected, Status = 413, Code = "TOO_LARGE", Message = $"The screenshot is larger than {t.MaxBytes} bytes." };

        if (!await PostToS3Async(t, image, takenAt, ct))
            return ApiResult<object>.TransientFailure("The upload to storage failed.");

        return await SendJsonAsync<object>(HttpMethod.Post, "screenshots/complete", new { key = t.Key, kind, takenAt = at }, ct);
    }

    /// <summary>Multipart POST to S3: the policy fields first, the file last (S3 ignores fields after it).</summary>
    private async Task<bool> PostToS3Async(UploadTicket ticket, CapturedImage image, DateTimeOffset takenAt, CancellationToken ct)
    {
        try
        {
            // Names quoted by hand: .NET leaves simple names bare, which S3's form parser
            // does not always accept.
            static ContentDispositionHeaderValue Part(string name, string? fileName = null) =>
                new("form-data") { Name = $"\"{name}\"", FileName = fileName is null ? null : $"\"{fileName}\"" };

            using var form = new MultipartFormDataContent();
            foreach (var (name, value) in ticket.Fields)
            {
                var field = new StringContent(value);
                field.Headers.ContentType = null;
                field.Headers.ContentDisposition = Part(name);
                form.Add(field);
            }
            var file = new ByteArrayContent(image.Bytes);
            file.Headers.ContentType = new MediaTypeHeaderValue(image.ContentType);
            var ext = image.ContentType == "image/png" ? "png" : "jpg";
            file.Headers.ContentDisposition = Part("file", $"screen-{takenAt.UtcDateTime:yyyyMMdd-HHmmss}.{ext}");
            form.Add(file);

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(90));
            using var req = new HttpRequestMessage(HttpMethod.Post, ticket.Url) { Content = form };
            using var res = await _s3.SendAsync(req, timeoutCts.Token);
            if (res.IsSuccessStatusCode) return true;
            _log.Warn("screenshots", $"S3 upload refused (HTTP {(int)res.StatusCode})");
            return false;
        }
        catch (Exception ex) when (IsNetwork(ex, ct))
        {
            _log.Warn("screenshots", $"S3 upload failed: {DescribeFailure(ex)}");
            return false;
        }
    }

    // ---- Chat ----------------------------------------------------------------------------

    public Task<ApiResult<List<ChatContact>>> GetChatContactsAsync(CancellationToken ct = default) =>
        SendJsonAsync<List<ChatContact>>(HttpMethod.Get, "chat/contacts", null, ct);

    public Task<ApiResult<List<ChatMessage>>> GetConversationAsync(string withUserId, int limit = 50, CancellationToken ct = default) =>
        SendJsonAsync<List<ChatMessage>>(HttpMethod.Get, $"chat/messages?withUserId={Uri.EscapeDataString(withUserId)}&limit={limit}", null, ct);

    public Task<ApiResult<ChatMessage>> SendChatMessageAsync(string toUserId, string body, CancellationToken ct = default) =>
        SendJsonAsync<ChatMessage>(HttpMethod.Post, "chat/messages", new { toUserId, body }, ct);

    public Task<ApiResult<UnreadCount>> GetChatUnreadAsync(CancellationToken ct = default) =>
        SendJsonAsync<UnreadCount>(HttpMethod.Get, "chat/unread", null, ct);

    // ---- Notifications -------------------------------------------------------------------

    public Task<ApiResult<List<NotificationItem>>> GetNotificationsAsync(bool unreadOnly, int limit = 20, CancellationToken ct = default) =>
        SendJsonAsync<List<NotificationItem>>(HttpMethod.Get, $"notifications?limit={limit}{(unreadOnly ? "&unreadOnly=true" : "")}", null, ct);

    public Task<ApiResult<object>> MarkNotificationReadAsync(string id, CancellationToken ct = default) =>
        SendJsonAsync<object>(HttpMethod.Post, $"notifications/{Uri.EscapeDataString(id)}/read", new { }, ct);

    // ---- Updates ---------------------------------------------------------------------------

    public Task<ApiResult<AgentVersionInfo>> GetAgentVersionAsync(string channel, CancellationToken ct = default) =>
        SendJsonAsync<AgentVersionInfo>(HttpMethod.Get, $"agent/version?platform={Uri.EscapeDataString(channel)}", null, ct);

    /// <summary>
    /// Downloads the generic build for <paramref name="channel"/> to <paramref name="destPath"/>
    /// and returns its SHA-256 (lowercase hex), or null on any failure. The partial
    /// file is deleted on failure.
    /// </summary>
    public async Task<string?> DownloadAgentAsync(string channel, string destPath, CancellationToken ct)
    {
        try
        {
            HttpResponseMessage res = await SendRawAsync(_bulk, () => new HttpRequestMessage(HttpMethod.Get, $"agent/download?platform={Uri.EscapeDataString(channel)}"), ct, HttpCompletionOption.ResponseHeadersRead);
            using (res)
            {
                if (!res.IsSuccessStatusCode) return null;
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                await using (var src = await res.Content.ReadAsStreamAsync(ct))
                await using (var dst = File.Create(destPath))
                {
                    var buffer = new byte[81920];
                    int read;
                    while ((read = await src.ReadAsync(buffer, ct)) > 0)
                    {
                        hash.AppendData(buffer, 0, read);
                        await dst.WriteAsync(buffer.AsMemory(0, read), ct);
                    }
                }
                return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            }
        }
        catch (Exception ex)
        {
            _log.Warn("update", "download failed", ex);
            try { if (File.Exists(destPath)) File.Delete(destPath); } catch { }
            return null;
        }
    }

    // ---- 4.0: offline replay, history, sign-out keys -------------------------------------------

    /// <summary>
    /// One journalled action (SPEC 6): sent with X-Client-Event-Id (the event's uuid,
    /// which makes a repeat idempotent on the server), X-Event-At (when the person did
    /// it, on the server's clock) and X-Client-Seq (this device's running number for
    /// its actions: a gap or a restart from 1 shows the server the agent's data was reset).
    /// </summary>
    public Task<ApiResult<JsonElement>> SendEventAsync(HttpMethod method, string path, object? body, string clientEventId,
        DateTimeOffset eventAt, long seq, CancellationToken ct = default) =>
        SendAsync<JsonElement>(() =>
        {
            var request = Json_(method, path, body ?? new { });
            request.Headers.TryAddWithoutValidation("X-Client-Event-Id", clientEventId);
            request.Headers.TryAddWithoutValidation("X-Event-At", Iso(eventAt));
            request.Headers.TryAddWithoutValidation("X-Client-Seq", seq.ToString(System.Globalization.CultureInfo.InvariantCulture));
            return request;
        }, retryOn401: true, ct);

    /// <summary>GET /workday/me/history?month=YYYY-MM: the month's days, meetings and away entries (SPEC 5.6).</summary>
    public Task<ApiResult<HistoryMonth>> GetHistoryAsync(string month, CancellationToken ct = default) =>
        SendJsonAsync<HistoryMonth>(HttpMethod.Get, $"workday/me/history?month={Uri.EscapeDataString(month)}", null, ct);

    /// <summary>POST /agent/sign-out {key}: 200 signs this device out; 403 SIGNOUT_KEY_INVALID; 429 too many tries.</summary>
    public Task<ApiResult<JsonElement>> SignOutWithKeyAsync(string key, CancellationToken ct = default) =>
        SendJsonAsync<JsonElement>(HttpMethod.Post, "agent/sign-out", new SignOutKeyRequest { Key = NormaliseKey(key) }, ct);

    // ---- 4.1 shared computer -----------------------------------------------------------

    /// <summary>POST /workday/me/extend: the person is taking the next shift (idempotent).</summary>
    public Task<ApiResult<JsonElement>> ExtendShiftAsync(CancellationToken ct = default) =>
        SendJsonAsync<JsonElement>(HttpMethod.Post, "workday/me/extend", new { }, ct);

    /// <summary>POST /activity/shift-end-day: ends the day at the shift end, without End Day's questions.</summary>
    public Task<ApiResult<JsonElement>> EndDayAtShiftEndAsync(CancellationToken ct = default) =>
        SendJsonAsync<JsonElement>(HttpMethod.Post, "activity/shift-end-day", new { }, ct);

    /// <summary>POST /agent/auto-sign-out: signs out with no key once the day is over (shared computer).</summary>
    public Task<ApiResult<JsonElement>> AutoSignOutAsync(CancellationToken ct = default) =>
        SendJsonAsync<JsonElement>(HttpMethod.Post, "agent/auto-sign-out", new { }, ct);

    /// <summary>POST /agent/quit-check {key}: 200 lets an Admin or Super Admin quit; 403 not.</summary>
    public Task<ApiResult<JsonElement>> QuitCheckAsync(string key, CancellationToken ct = default) =>
        SendJsonAsync<JsonElement>(HttpMethod.Post, "agent/quit-check", new SignOutKeyRequest { Key = NormaliseKey(key) }, ct);

    // ---- The staff pages (3.2 to 3.5) -----------------------------------------------------

    /// <summary>POST /workday/me/late-reason: the note for today's late start, made without one (another PC, an older agent).</summary>
    public Task<ApiResult<JsonElement>> AddLateReasonAsync(string reason, CancellationToken ct = default) =>
        SendJsonAsync<JsonElement>(HttpMethod.Post, "workday/me/late-reason", new LateReasonRequest { Reason = ReasonText.Clean(reason) }, ct);

    /// <summary>GET /workday/guide: the Instructions page with the organisation's numbers.</summary>
    public Task<ApiResult<StaffGuide>> GetGuideAsync(CancellationToken ct = default) =>
        SendJsonAsync<StaffGuide>(HttpMethod.Get, "workday/guide", null, ct);

    /// <summary>GET /calendar/people/:userId/year?year=: the person's own year (4.0, with 3.5's department and person weeks).</summary>
    public Task<ApiResult<PersonYear>> GetPersonYearAsync(string userId, int year, CancellationToken ct = default) =>
        SendJsonAsync<PersonYear>(HttpMethod.Get,
            $"calendar/people/{Uri.EscapeDataString(userId)}/year?year={year.ToString(System.Globalization.CultureInfo.InvariantCulture)}", null, ct);

    /// <summary>GET /leave/me: balances, comp off, requests and the policy (3.4, 3.5).</summary>
    public Task<ApiResult<MyLeave>> GetMyLeaveAsync(CancellationToken ct = default) =>
        SendJsonAsync<MyLeave>(HttpMethod.Get, "leave/me", null, ct);

    /// <summary>POST /leave/preview: what a request would charge, or the first thing that stops it. Nothing is made.</summary>
    public Task<ApiResult<LeavePreview>> PreviewLeaveAsync(LeaveRequestBody body, CancellationToken ct = default) =>
        SendJsonAsync<LeavePreview>(HttpMethod.Post, "leave/preview", body, ct);

    /// <summary>POST /leave/requests: apply for leave.</summary>
    public Task<ApiResult<LeaveRequest>> RequestLeaveAsync(LeaveRequestBody body, CancellationToken ct = default) =>
        SendJsonAsync<LeaveRequest>(HttpMethod.Post, "leave/requests", body, ct);

    /// <summary>POST /leave/requests/:id/cancel: a pending request, or approved leave not yet begun.</summary>
    public Task<ApiResult<LeaveRequest>> CancelLeaveAsync(string requestId, CancellationToken ct = default) =>
        SendJsonAsync<LeaveRequest>(HttpMethod.Post, $"leave/requests/{Uri.EscapeDataString(requestId)}/cancel", new { }, ct);

    /// <summary>A key as typed or pasted: words in lower case, one space between them.</summary>
    public static string NormaliseKey(string? key) =>
        string.Join(' ', (key ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).ToLowerInvariant();

    // ---- Plumbing -------------------------------------------------------------------------

    /// <summary>Null for nothing to say (the server reads a missing reason, not an empty one).</summary>
    private static string? OrNull(string text) => text.Length == 0 ? null : text;

    /// <summary>An instant as the API takes it: ISO-8601 UTC with milliseconds.</summary>
    internal static string Iso(DateTimeOffset t) =>
        t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);

    private static HttpRequestMessage Json_(HttpMethod method, string path, object? body)
    {
        var req = new HttpRequestMessage(method, path);
        if (body is not null) req.Content = JsonContent.Create(body, body.GetType(), options: Json.Options);
        return req;
    }

    private Task<ApiResult<T>> SendJsonAsync<T>(HttpMethod method, string path, object? body, CancellationToken ct) =>
        SendAsync<T>(() => Json_(method, path, body), retryOn401: true, ct);

    private async Task<ApiResult<T>> SendAsync<T>(Func<HttpRequestMessage> build, bool retryOn401, CancellationToken ct, TimeSpan? timeout = null)
    {
        var method = "?";
        var path = "?";
        HttpRequestMessage Build()
        {
            var request = build();
            method = request.Method.Method;
            path = request.RequestUri?.OriginalString ?? "?";
            return request;
        }
        try
        {
            using var timeoutCts = timeout is null ? null : CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts?.CancelAfter(timeout!.Value);
            var token = timeoutCts?.Token ?? ct;

            var res = await (timeout is null ? _http : _bulk).SendAsync(Build(), token);
            if (retryOn401 && res.StatusCode == HttpStatusCode.Unauthorized)
            {
                var body = await res.Content.ReadAsStringAsync(token);
                res.Dispose();
                if (!ReadsAsApiError(body))
                {
                    _log.Warn("net", $"{method} {path}: HTTP 401 that is not the API's (a proxy?); treated as no connection");
                    return ApiResult<T>.TransientFailure("Unexpected 401 from the network.", 401);
                }

                var refreshed = await RefreshAsync(ct);
                if (refreshed == ApiOutcome.Transient) return ApiResult<T>.TransientFailure("Can't reach the server to renew the session.");
                if (refreshed != ApiOutcome.Ok) return new ApiResult<T> { Outcome = ApiOutcome.Unauthorized, Status = 401, Message = "Signed out." };
                res = await (timeout is null ? _http : _bulk).SendAsync(Build(), token);
            }
            using (res)
            {
                var result = await ResultReader.ReadAsync<T>(res, token);
                NoteContact(result.Outcome);
                if (result.Transient)
                    _log.Warn("net", $"{method} {path}: HTTP {result.Status}, no usable answer ({result.Code ?? "no code"}: {result.Message})");
                return result;
            }
        }
        catch (Exception ex) when (IsNetwork(ex, ct))
        {
            NoteContact(ApiOutcome.Transient);
            LogNetworkFailure(method, path, ex);
            return ApiResult<T>.TransientFailure("Can't reach the server.");
        }
    }

    /// <summary>
    /// 4.0: every transient network failure is logged with what failed and why (the
    /// exception's type and message, the inner one's, and the HTTP status when there
    /// was one). A Mac that could not sign in left an empty log before this.
    /// </summary>
    private void LogNetworkFailure(string method, string path, Exception ex) =>
        _log.Warn("net", $"{method} {path} failed: {DescribeFailure(ex)}");

    /// <summary>"HttpRequestException: ... (status 502) <- SocketException: Connection refused".</summary>
    public static string DescribeFailure(Exception ex)
    {
        var parts = new List<string>();
        var current = ex;
        for (var depth = 0; current is not null && depth < 4; depth++, current = current.InnerException)
        {
            var text = $"{current.GetType().Name}: {current.Message}";
            if (current is HttpRequestException { StatusCode: { } status }) text += $" (status {(int)status})";
            if (current is System.Net.Sockets.SocketException socket) text += $" (socket error {socket.SocketErrorCode})";
            if (current is TaskCanceledException or OperationCanceledException && depth == 0 && current.InnerException is TimeoutException)
                text += " (timed out)";
            parts.Add(text);
        }
        return string.Join(" <- ", parts);
    }

    private async Task<HttpResponseMessage> SendRawAsync(HttpClient client, Func<HttpRequestMessage> build, CancellationToken ct, HttpCompletionOption option)
    {
        var res = await client.SendAsync(build(), option, ct);
        if (res.StatusCode != HttpStatusCode.Unauthorized) return res;
        res.Dispose();
        if (await RefreshAsync(ct) != ApiOutcome.Ok) return new HttpResponseMessage(HttpStatusCode.Unauthorized);
        return await client.SendAsync(build(), option, ct);
    }

    private static bool ReadsAsApiError(string body) => ResultReader.IsJsonApiError(HttpStatusCode.Unauthorized, body);

    private static bool IsNetwork(Exception ex, CancellationToken ct) =>
        ex is HttpRequestException or IOException or TimeoutException
        || (ex is TaskCanceledException or OperationCanceledException && !ct.IsCancellationRequested);

    public void Dispose()
    {
        _http.Dispose();
        _bulk.Dispose();
        _s3.Dispose();
        _cookies.Dispose();
    }
}

/// <summary>A cookie jar in front of any handler (so tests can use a fake transport).</summary>
internal sealed class CookieHandler : DelegatingHandler
{
    private CookieContainer _jar = new();
    private readonly object _gate = new();

    public CookieHandler(HttpMessageHandler inner) : base(inner) { }

    public string? Get(Uri uri, string name)
    {
        lock (_gate)
        {
            foreach (Cookie c in _jar.GetCookies(uri))
                if (string.Equals(c.Name, name, StringComparison.Ordinal) && !c.Expired) return c.Value;
        }
        return null;
    }

    public void Set(Uri uri, Cookie cookie)
    {
        lock (_gate) _jar.Add(uri, cookie);
    }

    public void Clear()
    {
        lock (_gate) _jar = new CookieContainer();
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var uri = request.RequestUri!.IsAbsoluteUri ? request.RequestUri : new Uri(new Uri("http://localhost"), request.RequestUri);
        string header;
        lock (_gate) header = _jar.GetCookieHeader(uri);
        if (header.Length > 0) request.Headers.TryAddWithoutValidation("Cookie", header);

        var response = await base.SendAsync(request, cancellationToken);
        if (response.Headers.TryGetValues("Set-Cookie", out var values))
        {
            lock (_gate)
            {
                foreach (var v in values)
                {
                    try { _jar.SetCookies(uri, v); }
                    catch (CookieException) { /* a malformed cookie is not worth failing the call */ }
                }
            }
        }
        return response;
    }
}
