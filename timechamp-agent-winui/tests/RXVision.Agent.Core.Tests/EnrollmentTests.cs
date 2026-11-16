using System.Text;
using RXVision.Agent.Core.Config;
using Xunit;

namespace RXVision.Agent.Core.Tests;

public class EnrollmentTests
{
    private static string Code(string json) =>
        "RXV1." + Convert.ToBase64String(Encoding.UTF8.GetBytes(json)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    [Fact]
    public void Reads_a_setup_code_from_the_portal()
    {
        var token = FakeServer.Jwt("u-9");
        var code = Code($"{{\"ApiBaseUrl\":\"https://api.example.com/api/v1/\",\"EnrollmentToken\":\"{token}\"}}");
        var cfg = Enrollment.FromSetupCode("  " + code + "\n", AgentOptions.DefaultApiBaseUrl);
        Assert.NotNull(cfg);
        Assert.Equal("https://api.example.com/api/v1", cfg!.ApiBaseUrl);
        Assert.Equal(token, cfg.EnrollmentToken);
    }

    [Fact]
    public void Accepts_a_bare_token_for_the_current_server()
    {
        var token = FakeServer.Jwt("u-9");
        var cfg = Enrollment.FromSetupCode(token, "https://api.example.com/api/v1");
        Assert.Equal("https://api.example.com/api/v1", cfg!.ApiBaseUrl);
    }

    [Theory]
    [InlineData("")]
    [InlineData("hello")]
    [InlineData("RXV1.!!!")]
    public void Rejects_garbage(string code)
    {
        Assert.Null(Enrollment.FromSetupCode(code, AgentOptions.DefaultApiBaseUrl));
    }

    [Fact]
    public void Refuses_plain_http_to_a_remote_server()
    {
        var code = Code("{\"ApiBaseUrl\":\"http://api.example.com/api/v1\",\"EnrollmentToken\":\"a.b.c\"}");
        Assert.Null(Enrollment.FromSetupCode(code, AgentOptions.DefaultApiBaseUrl));
        Assert.Equal("http://localhost:4000/api/v1", AgentOptions.NormaliseUrl("http://localhost:4000/api/v1/"));
        Assert.Null(AgentOptions.NormaliseUrl("ftp://x"));
    }

    [Fact]
    public void Reads_the_installer_sidecar()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        File.WriteAllText(Path.Combine(dir, "tc-enroll.json"), "{\"ApiBaseUrl\":\"https://api.example.com/api/v1\",\"EnrollmentToken\":\"t.o.k\"}");
        var cfg = Enrollment.FromSidecar(dir);
        Assert.Equal("t.o.k", cfg!.EnrollmentToken);
        Assert.Null(Enrollment.FromSidecar(Path.Combine(dir, "missing")));
    }

    [Fact]
    public void Options_clamp_unsafe_local_overrides()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        File.WriteAllText(Path.Combine(dir, "appsettings.json"), "{\"IdleThresholdSeconds\":86400,\"ActivitySeconds\":1,\"ApiBaseUrl\":\"not a url\"}");
        var o = AgentOptions.Load(dir);
        Assert.Equal(900, o.IdleThresholdSeconds);
        Assert.Equal(30, o.ActivitySeconds);
        Assert.Equal(AgentOptions.DefaultApiBaseUrl, o.ApiBaseUrl);
    }
}
