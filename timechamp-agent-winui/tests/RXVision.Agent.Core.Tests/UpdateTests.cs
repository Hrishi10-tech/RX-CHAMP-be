using System.Net;
using System.Security.Cryptography;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Update;
using RXVision.Agent.Core.Util;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>The by-hand update download (an app that cannot replace itself, e.g. macOS without write access).</summary>
public class UpdateTests
{
    private const string Base = "https://api.example.com/api/v1";

    [Theory]
    [InlineData("RXVision-mac.zip", "3.1.0", "mac", "mac", "RXVision-mac-3.1.0.zip")]
    [InlineData("RXChampAgent.exe", "v3.1.0", "windows", "windows", "RXChampAgent-3.1.0.exe")]
    [InlineData("RXVision-mac-intel.zip", "3.1.0+abc", "mac-x64", "mac", "RXVision-mac-intel-3.1.0.zip")]
    [InlineData("../../evil.sh", "3.1.0", "mac", "mac", "evil-3.1.0.zip")]
    [InlineData("", "3.1.0", "mac-x64", "mac", "RXVision-mac-x64-3.1.0.zip")]
    [InlineData(null, "3.1.0", "windows", "windows", "RXVision-windows-3.1.0.exe")]
    [InlineData("RX Vision \"new\".zip", "3.1.0", "mac", "mac", "RXVisionnew-3.1.0.zip")]
    public void Manual_file_name_is_versioned_and_safe(string? server, string version, string channel, string platform, string expected)
    {
        Assert.Equal(expected, UpdateService.ManualFileName(server, version, channel, platform));
    }

    private static async Task<(UpdateService updates, FakeServer server, string folder)> SignedIn()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var sessions = new SessionStore(platform.Secrets);
        var server = new FakeServer();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        var api = new ApiClient(Base, new AgentIdentity("3.0.0", "dev", "dev-1"), sessions, new ServerClock(), NullLog.Instance, server);
        Assert.True((await api.LoginAsync("a@x.test", "pw")).Ok);
        var folder = Directory.CreateTempSubdirectory().FullName;
        var updates = new UpdateService(api, platform, new AgentOptions().Normalised(), NullLog.Instance, "3.0.0", folder);
        return (updates, server, folder);
    }

    private static void Serve(FakeServer server, byte[] bytes, string sha)
    {
        server.Route("GET agent/version", (_, _) => FakeServer.Ok(new
        {
            version = "3.1.0",
            fileName = "RXVision-mac.zip",
            available = true,
            sizeBytes = bytes.Length,
            sha256 = sha,
            platform = "windows",
        }));
        server.Route("GET agent/download", (_, _) => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) });
    }

    [Fact]
    public async Task Saves_a_verified_build_to_the_downloads_folder()
    {
        var (updates, server, folder) = await SignedIn();
        var bytes = RandomNumberGenerator.GetBytes(4096);
        Serve(server, bytes, Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant());

        var result = await updates.DownloadForManualInstallAsync();

        Assert.Null(result.Error);
        Assert.Equal(Path.Combine(folder, "RXVision-mac-3.1.0.zip"), result.Path);
        Assert.Equal(bytes, File.ReadAllBytes(result.Path!));
        Assert.Single(Directory.GetFiles(folder));
    }

    [Fact]
    public async Task A_build_that_fails_the_checksum_is_deleted_not_kept()
    {
        var (updates, server, folder) = await SignedIn();
        var bytes = RandomNumberGenerator.GetBytes(4096);
        Serve(server, bytes, new string('0', 64));

        var result = await updates.DownloadForManualInstallAsync();

        Assert.Null(result.Path);
        Assert.Contains("didn't match", result.Error);
        Assert.Empty(Directory.GetFiles(folder));
    }

    [Fact]
    public async Task Nothing_published_says_so()
    {
        var (updates, server, folder) = await SignedIn();
        server.Route("GET agent/version", (_, _) => FakeServer.Ok(new { version = "", fileName = "", available = false, sizeBytes = 0, sha256 = "" }));

        var result = await updates.DownloadForManualInstallAsync();

        Assert.Null(result.Path);
        Assert.Contains("isn't available", result.Error);
        Assert.Equal(0, server.Count("GET agent/download"));
        Assert.Empty(Directory.GetFiles(folder));
    }

    // ---- What failed survives a restart (the app exits to install) -----------------------

    private static async Task<(ApiClient api, FakeServer server, DevPlatform platform)> SignedInApi()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        var sessions = new SessionStore(platform.Secrets);
        var server = new FakeServer();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        server.Route("GET agent/version", (_, _) => FakeServer.Ok(new { version = "3.1.0", fileName = "RXVision-mac.zip", available = true, sizeBytes = 10, sha256 = new string('a', 64) }));
        var api = new ApiClient(Base, new AgentIdentity("3.0.0", "dev", "dev-1"), sessions, new ServerClock(), NullLog.Instance, server);
        Assert.True((await api.LoginAsync("a@x.test", "pw")).Ok);
        return (api, server, platform);
    }

    private static void WriteState(DevPlatform platform, string json) =>
        File.WriteAllText(Path.Combine(platform.Paths.DataDir, UpdateService.StateFileName), json);

    [Fact]
    public async Task A_version_that_did_not_take_is_not_offered_again_for_a_day()
    {
        var (api, server, platform) = await SignedInApi();
        // The last run handed 3.1.0 to the installer, yet 3.0.0 is what started.
        WriteState(platform, "{\"attemptVersion\":\"3.1.0\",\"attemptAt\":\"" + DateTimeOffset.UtcNow.AddMinutes(-3).ToString("o") + "\"}");
        var updates = new UpdateService(api, platform, new AgentOptions().Normalised(), NullLog.Instance, "3.0.0");
        var offered = 0;
        updates.Available += _ => offered++;

        Assert.NotNull(updates.BlockedUntil("3.1.0"));
        Assert.InRange(updates.BlockedUntil("3.1.0")!.Value, DateTimeOffset.UtcNow.AddHours(23), DateTimeOffset.UtcNow.AddHours(25));
        Assert.False(await updates.CheckAsync());
        Assert.Equal(0, offered);
        Assert.Equal(0, server.Count("GET agent/download"));

        // And it is still refused after another restart.
        var again = new UpdateService(api, platform, new AgentOptions().Normalised(), NullLog.Instance, "3.0.0");
        Assert.NotNull(again.BlockedUntil("3.1.0"));
    }

    [Fact]
    public async Task A_version_that_took_clears_its_record()
    {
        var (api, _, platform) = await SignedInApi();
        WriteState(platform, "{\"attemptVersion\":\"3.1.0\",\"attemptAt\":\"" + DateTimeOffset.UtcNow.AddMinutes(-3).ToString("o") + "\"}");
        var updates = new UpdateService(api, platform, new AgentOptions().Normalised(), NullLog.Instance, "3.1.0");
        Assert.Null(updates.BlockedUntil("3.1.0"));
        var state = File.ReadAllText(Path.Combine(platform.Paths.DataDir, UpdateService.StateFileName));
        Assert.DoesNotContain("3.1.0", state);
    }

    [Fact]
    public async Task A_broken_state_file_starts_fresh()
    {
        var (api, _, platform) = await SignedInApi();
        WriteState(platform, "{not json");
        var updates = new UpdateService(api, platform, new AgentOptions().Normalised(), NullLog.Instance, "3.0.0");
        var offered = 0;
        updates.Available += _ => offered++;
        Assert.Null(updates.BlockedUntil("3.1.0"));
        await updates.CheckAsync();
        // The dev platform cannot replace itself, so a fresh check offers it by hand.
        Assert.Equal(1, offered);
    }
}
