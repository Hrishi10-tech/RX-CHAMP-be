using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Util;
using Xunit;

namespace RXVision.Agent.Core.Tests;

public class ApiClientTests
{
    private const string Base = "https://api.example.com/api/v1";

    private static (ApiClient api, FakeServer server, SessionStore sessions, DevPlatform platform) Make()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var sessions = new SessionStore(platform.Secrets);
        var server = new FakeServer();
        var api = new ApiClient(Base, new AgentIdentity("3.0.0", "dev", "dev-1"), sessions, new ServerClock(), NullLog.Instance, server);
        return (api, server, sessions, platform);
    }

    [Fact]
    public async Task Login_keeps_the_refresh_token_in_the_secret_store()
    {
        var (api, server, sessions, _) = Make();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie("rt-login")));

        var result = await api.LoginAsync("a@x.test", "pw");

        Assert.True(result.Ok);
        Assert.Equal("u-1", api.CurrentUser!.Id);
        var saved = sessions.Load();
        Assert.Equal("rt-login", saved!.RefreshToken);
        Assert.Equal(Base, saved.ApiBaseUrl);
    }

    [Fact]
    public async Task Wrong_password_is_rejected_with_a_clear_message()
    {
        var (api, server, _, _) = Make();
        server.Route("POST auth/login", (_, _) => FakeServer.Error(401, "INVALID_CREDENTIALS", "Invalid email or password"));
        var result = await api.LoginAsync("a@x.test", "bad");
        Assert.Equal(ApiOutcome.Rejected, result.Outcome);
        Assert.Equal("Wrong email or password.", result.Message);
    }

    [Fact]
    public async Task No_network_is_transient_not_a_rejection()
    {
        var (api, server, _, _) = Make();
        server.FailWith = _ => new HttpRequestException("no route");
        var result = await api.LoginAsync("a@x.test", "pw");
        Assert.Equal(ApiOutcome.Transient, result.Outcome);
    }

    [Theory]
    [InlineData(502)]
    [InlineData(503)]
    [InlineData(429)]
    public async Task Server_trouble_is_transient(int status)
    {
        var (api, server, _, _) = Make();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        await api.LoginAsync("a@x.test", "pw");
        server.Route("GET breaks/me/today", (_, _) => FakeServer.Html(status));
        var day = await api.GetBreakDayAsync();
        Assert.Equal(ApiOutcome.Transient, day.Outcome);
    }

    [Fact]
    public async Task A_captive_portal_200_page_is_transient()
    {
        var (api, server, _, _) = Make();
        server.Route("POST auth/login", (_, _) => FakeServer.Html(200, "<html>Sign in to Hotel WiFi</html>"));
        var result = await api.LoginAsync("a@x.test", "pw");
        Assert.Equal(ApiOutcome.Transient, result.Outcome);
    }

    [Fact]
    public async Task Concurrent_401s_share_one_refresh()
    {
        var (api, server, _, _) = Make();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie("rt-1")));
        await api.LoginAsync("a@x.test", "pw");

        var refreshed = false;
        server.Route("POST auth/refresh", (_, _) =>
        {
            Thread.Sleep(100);
            refreshed = true;
            return FakeServer.Ok(new { refreshed = true }, FakeServer.AccessCookie(), FakeServer.RefreshCookie("rt-2"));
        });
        server.Route("POST presence/heartbeat", (_, _) =>
            refreshed ? FakeServer.Ok(new { ok = true }) : FakeServer.Error(401, "UNAUTHORIZED", "Not signed in"));

        var results = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => api.HeartbeatAsync(false)));

        Assert.All(results, r => Assert.True(r.Ok));
        Assert.Equal(1, server.Count("POST auth/refresh"));
    }

    [Fact]
    public async Task A_refused_refresh_falls_back_to_the_enrollment_token()
    {
        var (api, server, _, _) = Make();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User("u-1"), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        await api.LoginAsync("a@x.test", "pw");
        api.EnrollmentToken = () => FakeServer.Jwt("u-1");

        var enrolled = false;
        server.Route("POST auth/refresh", (_, _) => FakeServer.Error(401, "UNAUTHORIZED", "Refresh token is no longer valid"));
        server.Route("POST auth/enroll", (_, _) => { enrolled = true; return FakeServer.Ok(FakeServer.User("u-1"), FakeServer.AccessCookie(), FakeServer.RefreshCookie("rt-new")); });
        server.Route("GET presence/me/current", (_, _) =>
            enrolled ? FakeServer.Ok(new { status = "WORKING" }) : FakeServer.Error(401, "UNAUTHORIZED", "Not signed in"));

        var current = await api.GetCurrentPresenceAsync();

        Assert.True(current.Ok);
        Assert.Equal(1, server.Count("POST auth/enroll"));
    }

    [Fact]
    public async Task Never_re_enrolls_as_someone_else()
    {
        var (api, server, _, _) = Make();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User("u-1"), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        await api.LoginAsync("a@x.test", "pw");
        api.EnrollmentToken = () => FakeServer.Jwt("u-OTHER");
        string? lost = null;
        api.SessionLost += r => lost = r;
        server.Route("POST auth/refresh", (_, _) => FakeServer.Error(401, "UNAUTHORIZED", "expired"));
        server.Route("GET presence/me/current", (_, _) => FakeServer.Error(401, "UNAUTHORIZED", "Not signed in"));

        var current = await api.GetCurrentPresenceAsync();

        Assert.Equal(ApiOutcome.Unauthorized, current.Outcome);
        Assert.Equal(0, server.Count("POST auth/enroll"));
        Assert.NotNull(lost);
    }

    [Fact]
    public async Task An_offline_refresh_keeps_the_session()
    {
        var (api, server, sessions, _) = Make();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        await api.LoginAsync("a@x.test", "pw");
        var lost = false;
        api.SessionLost += _ => lost = true;
        server.Route("GET presence/me/current", (_, _) => FakeServer.Error(401, "UNAUTHORIZED", "Not signed in"));
        server.FailWith = req => req.RequestUri!.AbsolutePath.EndsWith("auth/refresh") ? new HttpRequestException("wifi") : null;

        var current = await api.GetCurrentPresenceAsync();

        Assert.Equal(ApiOutcome.Transient, current.Outcome);
        Assert.False(lost);
        Assert.True(api.IsSignedIn);
        Assert.NotNull(sessions.Load());
    }

    [Fact]
    public async Task A_404_from_a_broken_deploy_on_refresh_keeps_the_session()
    {
        var (api, server, sessions, _) = Make();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        await api.LoginAsync("a@x.test", "pw");
        var lost = false;
        api.SessionLost += _ => lost = true;
        server.Route("GET presence/me/current", (_, _) => FakeServer.Error(401, "UNAUTHORIZED", "Not signed in"));
        server.Route("POST auth/refresh", (_, _) => FakeServer.Error(404, "NOT_FOUND", "Cannot POST /api/v1/auth/refresh"));

        var current = await api.GetCurrentPresenceAsync();

        Assert.Equal(ApiOutcome.Transient, current.Outcome);
        Assert.False(lost);
        Assert.True(api.IsSignedIn);
        Assert.NotNull(sessions.Load());
    }

    [Fact]
    public async Task A_locked_sign_in_says_so_instead_of_blaming_the_network()
    {
        var (api, server, _, _) = Make();
        server.Route("POST auth/login", (_, _) => FakeServer.Error(429, "TOO_MANY_ATTEMPTS", "Too many wrong passwords. Sign-in is paused for 15 minutes."));
        var result = await api.LoginAsync("a@x.test", "pw");
        Assert.Equal(ApiOutcome.Transient, result.Outcome);
        Assert.Equal("Too many wrong passwords. Sign-in is paused for 15 minutes.", result.Message);

        server.Route("POST auth/login", (_, _) => FakeServer.Error(404, "NOT_FOUND", "Cannot POST /api/v1/auth/login"));
        var broken = await api.LoginAsync("a@x.test", "pw");
        Assert.Equal(ApiOutcome.Transient, broken.Outcome);
    }

    [Fact]
    public async Task A_proxy_401_page_does_not_trigger_a_refresh()
    {
        var (api, server, _, _) = Make();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        await api.LoginAsync("a@x.test", "pw");
        server.Route("GET presence/me/current", (_, _) => FakeServer.Html(401));
        var current = await api.GetCurrentPresenceAsync();
        Assert.Equal(ApiOutcome.Transient, current.Outcome);
        Assert.Equal(0, server.Count("POST auth/refresh"));
    }

    [Fact]
    public async Task Restores_a_saved_session_by_refreshing()
    {
        var (api, server, _, _) = Make();
        server.Route("POST auth/refresh", (req, _) => FakeServer.Ok(new { refreshed = true }, FakeServer.AccessCookie(), FakeServer.RefreshCookie("rt-rotated")));
        var saved = new SavedSession { ApiBaseUrl = Base, RefreshToken = "rt-saved", UserId = "u-1", Email = "a@x.test", DisplayName = "Asha" };

        var result = await api.RestoreAsync(saved);

        Assert.True(result.Ok);
        Assert.Contains("refreshToken=rt-saved", server.Calls.Single(c => c.Path == "auth/refresh").Cookie);
    }

    [Fact]
    public async Task Reads_api_error_codes_and_details()
    {
        var (api, server, _, _) = Make();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        await api.LoginAsync("a@x.test", "pw");
        server.Route("POST breaks/start", (_, _) => FakeServer.Error(422, "REASON_REQUIRED", "Add a reason", new { timing = "LATE", minutesOff = 12, minChars = 10 }));

        var r = await api.StartBreakAsync("MORNING", null);

        Assert.Equal(ApiOutcome.Rejected, r.Outcome);
        Assert.Equal("REASON_REQUIRED", r.Code);
        Assert.Equal(12, r.DetailInt("minutesOff"));
        Assert.Equal("LATE", r.DetailString("timing"));
    }

    [Fact]
    public void Reads_jwt_claims_without_verifying()
    {
        Assert.Equal("u-9", ApiClient.JwtSubject(FakeServer.Jwt("u-9")));
        Assert.Null(ApiClient.JwtSubject("not-a-jwt"));
    }

    // ---- 4.0.1: presigned screenshot upload ------------------------------------------

    private const string S3Url = "https://rx-timechamp.s3.ap-south-1.amazonaws.com/";
    private static readonly CapturedImage Shot = new(new byte[] { 0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3 }, "image/jpeg", 10, 10);
    private static readonly DateTimeOffset ShotAt = new(2026, 11, 13, 5, 0, 0, TimeSpan.Zero);

    private static object Ticket() => new
    {
        key = "uploads/screenshots/u-1/2026-11-13/abc.jpg",
        url = S3Url,
        fields = new Dictionary<string, string> { ["key"] = "uploads/screenshots/u-1/2026-11-13/abc.jpg", ["Policy"] = "p", ["Content-Type"] = "image/jpeg" },
        maxBytes = 10 * 1024 * 1024,
        expiresIn = 300,
    };

    [Fact]
    public async Task Screenshot_goes_straight_to_S3_then_is_completed()
    {
        var (api, server, _, _) = Make();
        server.Route("POST screenshots/upload-url", (_, _) => FakeServer.Ok(Ticket()));
        server.Route("POST /", (_, _) => new HttpResponseMessage(System.Net.HttpStatusCode.NoContent));
        server.Route("POST screenshots/complete", (_, _) => FakeServer.Ok(new { id = "s-1" }));

        var result = await api.UploadScreenshotAsync(Shot, "AUTO", ShotAt);

        Assert.True(result.Ok);
        Assert.Equal(new[] { "POST screenshots/upload-url", "POST /", "POST screenshots/complete" }, server.Calls.Select(c => $"{c.Method} {c.Path}"));
        var s3 = server.Calls[1];
        Assert.Null(s3.Cookie); // no API cookies sent to S3
        // Policy fields come before the file; S3 ignores anything after it.
        Assert.True(s3.Body!.IndexOf("name=\"Policy\"", StringComparison.Ordinal) is var p && p >= 0 && p < s3.Body.IndexOf("name=\"file\"", StringComparison.Ordinal));
        Assert.Contains("uploads/screenshots/u-1/2026-11-13/abc.jpg", server.Calls[2].Body);
        Assert.Contains("2026-11-13T05:00:00.000Z", server.Calls[2].Body);
        Assert.Equal(0, server.Count("POST screenshots"));
    }

    [Fact]
    public async Task A_server_without_upload_url_is_a_refusal_and_nothing_else_is_sent()
    {
        var (api, server, _, _) = Make();

        var result = await api.UploadScreenshotAsync(Shot, "AUTO", ShotAt);

        Assert.Equal(ApiOutcome.Rejected, result.Outcome);
        Assert.Equal(404, result.Status);
        Assert.Equal(new[] { "POST screenshots/upload-url" }, server.Calls.Select(c => $"{c.Method} {c.Path}"));
    }

    [Fact]
    public async Task An_S3_refusal_is_transient_so_it_is_tried_again_with_a_new_link()
    {
        var (api, server, _, _) = Make();
        server.Route("POST screenshots/upload-url", (_, _) => FakeServer.Ok(Ticket()));
        server.Route("POST /", (_, _) => new HttpResponseMessage(System.Net.HttpStatusCode.Forbidden));

        var result = await api.UploadScreenshotAsync(Shot, "MANUAL", ShotAt);

        Assert.Equal(ApiOutcome.Transient, result.Outcome);
        Assert.Equal(0, server.Count("POST screenshots/complete"));
        Assert.Equal(0, server.Count("POST screenshots"));
    }

    [Fact]
    public async Task An_S3_network_failure_is_transient()
    {
        var (api, server, _, _) = Make();
        server.Route("POST screenshots/upload-url", (_, _) => FakeServer.Ok(Ticket()));
        server.FailWith = req => req.RequestUri!.Host.EndsWith("amazonaws.com") ? new HttpRequestException("no route") : null;

        var result = await api.UploadScreenshotAsync(Shot, "AUTO", ShotAt);

        Assert.Equal(ApiOutcome.Transient, result.Outcome);
        Assert.Equal(0, server.Count("POST screenshots/complete"));
        Assert.Equal(0, server.Count("POST screenshots"));
    }

    [Fact]
    public async Task A_shot_over_the_link_limit_is_refused_before_uploading()
    {
        var (api, server, _, _) = Make();
        server.Route("POST screenshots/upload-url", (_, _) => FakeServer.Ok(new
        {
            key = "uploads/screenshots/u-1/2026-11-13/abc.jpg",
            url = S3Url,
            fields = new Dictionary<string, string>(),
            maxBytes = 3,
            expiresIn = 300,
        }));

        var result = await api.UploadScreenshotAsync(Shot, "AUTO", ShotAt);

        Assert.Equal(ApiOutcome.Rejected, result.Outcome);
        Assert.Equal(413, result.Status);
        Assert.Equal(0, server.Count("POST /"));
    }

    [Theory]
    [InlineData(403, "AUTO_OFF")]
    [InlineData(409, "DAY_ENDED")]
    public async Task A_refusal_is_final_and_nothing_is_uploaded(int status, string code)
    {
        var (api, server, _, _) = Make();
        server.Route("POST screenshots/upload-url", (_, _) => FakeServer.Error(status, code, "no"));

        var result = await api.UploadScreenshotAsync(Shot, "AUTO", ShotAt);

        Assert.Equal(ApiOutcome.Rejected, result.Outcome);
        Assert.Equal(status, result.Status);
        Assert.Equal(0, server.Count("POST /"));
        Assert.Equal(0, server.Count("POST screenshots"));
    }

    [Fact]
    public async Task A_refusal_on_complete_is_returned_as_is()
    {
        var (api, server, _, _) = Make();
        server.Route("POST screenshots/upload-url", (_, _) => FakeServer.Ok(Ticket()));
        server.Route("POST /", (_, _) => new HttpResponseMessage(System.Net.HttpStatusCode.NoContent));
        server.Route("POST screenshots/complete", (_, _) => FakeServer.Error(413, "TOO_LARGE", "too big"));

        var result = await api.UploadScreenshotAsync(Shot, "AUTO", ShotAt);

        Assert.Equal(ApiOutcome.Rejected, result.Outcome);
        Assert.Equal(413, result.Status);
        Assert.Equal(0, server.Count("POST screenshots"));
    }
}
