using System.Net;
using System.Security.Cryptography;
using System.Text;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Update;
using RXVision.Agent.Core.Util;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>
/// Audit F-01: a build without the owner's update key cannot be made by accident, says what it is,
/// and still takes the first signed build.
/// </summary>
public class UpdateKeyGuardTests
{
    private const string Base = "https://api.example.com/api/v1";

    /// <summary>The agent folder of this checkout (where Directory.Build.props is).</summary>
    internal static string AgentRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Directory.Build.props"))) dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    /// <summary>The one place the owner's public key goes.</summary>
    internal static string KeyFileInSource() =>
        Path.Combine(AgentRoot(), "src", "RXVision.Agent.Core", "Update", "update-public-key.pem");

    // ---- The fact baked into the build ----------------------------------------------------------

    [Fact]
    public void The_build_fact_and_the_built_in_key_agree_with_the_key_file_in_the_source()
    {
        var keyInSource = File.Exists(KeyFileInSource());
        Assert.Equal(keyInSource, AgentOptions.BuiltWithSignedUpdates);
        Assert.Equal(keyInSource, UpdateSignature.PublicKeyPem is not null);
        Assert.Equal(keyInSource ? null : UpdateSignature.UnsignedBuildNoteText, UpdateSignature.UnsignedBuildNote);
        if (UpdateSignature.PublicKeyPem is { } pem)
        {
            // A key that is there must be one the check can use: a P-256 public key, and only that.
            Assert.DoesNotContain("PRIVATE", pem);
            using var key = ECDsa.Create();
            key.ImportFromPem(pem);
            Assert.Equal(256, key.KeySize);
        }
    }

    [Theory]
    [InlineData("signed")]
    [InlineData(" Signed ")]
    [InlineData("SIGNED")]
    public void A_build_made_with_the_key_reads_as_signed(string raw)
    {
        Assert.True(AgentOptions.ParseUpdateSigning(raw));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData("unsigned")]
    [InlineData("true")]
    [InlineData("yes")]
    [InlineData("signed, unsigned")]
    [InlineData("not signed")]
    public void Anything_else_reads_as_not_signed(string? raw)
    {
        Assert.False(AgentOptions.ParseUpdateSigning(raw));
    }

    [Fact]
    public void The_note_beside_the_version_shows_unless_the_build_and_the_key_both_say_signed()
    {
        Assert.Equal("Updates are not signed in this build.", UpdateSignature.UnsignedBuildNoteText);
        Assert.Null(UpdateSignature.NoteFor(builtSigned: true, publicKeyPem: "-----BEGIN PUBLIC KEY-----"));
        Assert.Equal(UpdateSignature.UnsignedBuildNoteText, UpdateSignature.NoteFor(builtSigned: false, publicKeyPem: null));
        Assert.Equal(UpdateSignature.UnsignedBuildNoteText, UpdateSignature.NoteFor(builtSigned: true, publicKeyPem: null));
        Assert.Equal(UpdateSignature.UnsignedBuildNoteText, UpdateSignature.NoteFor(builtSigned: false, publicKeyPem: "-----BEGIN PUBLIC KEY-----"));
    }

    // ---- The guard stays in the project and the scripts -----------------------------------------

    [Fact]
    public void The_project_stops_any_build_but_Debug_that_has_no_key_unless_it_was_asked_for()
    {
        // The guard itself is proven by building (see build/signing/README.md); this keeps it from
        // being dropped from the project without a test noticing.
        var project = File.ReadAllText(Path.Combine(AgentRoot(), "src", "RXVision.Agent.Core", "RXVision.Agent.Core.csproj"));
        Assert.Contains("<Target Name=\"RxvRequireUpdatePublicKey\" BeforeTargets=\"BeforeBuild;CoreCompile\"", project);
        Assert.Contains("'$(Configuration)' != 'Debug' And '$(DesignTimeBuild)' != 'true' And !Exists('$(RxvUpdatePublicKeyFile)')", project);
        Assert.Contains("<Error Condition=\"'$(RxvAllowUnsignedUpdates)' != 'true'\" Code=\"RXV0001\"", project);
        Assert.Contains("<AssemblyMetadata Include=\"RxvUpdateSigning\" Value=\"$(RxvUpdateSigning)\" />", project);
        // Neither the key's place nor the fact can be handed in from the command line.
        Assert.Contains("TreatAsLocalProperty=\"RxvUpdatePublicKeyFile;RxvUpdateSigning\"", project);
    }

    [Theory]
    [InlineData("build-windows.sh")]
    [InlineData("build-mac.sh")]
    public void The_build_scripts_stop_without_the_key_unless_told_unsigned_updates(string script)
    {
        var text = File.ReadAllText(Path.Combine(AgentRoot(), "build", script));
        Assert.Contains("--unsigned-updates)", text);
        Assert.Contains("-p:RxvAllowUnsignedUpdates=true", text);
        Assert.Contains("src/RXVision.Agent.Core/Update/update-public-key.pem", text);
        Assert.Contains("build/signing/make-update-key.sh", text);
    }

    [Theory]
    [InlineData("publish-windows.sh")]
    [InlineData("publish-mac.sh")]
    public void The_publish_scripts_never_take_unsigned_updates(string script)
    {
        var text = File.ReadAllText(Path.Combine(AgentRoot(), "build", script));
        Assert.Contains("--unsigned-updates)", text);
        Assert.Contains("an unsigned build is never published", text);
        // And they never hand the allowance on to the build.
        Assert.DoesNotContain("RxvAllowUnsignedUpdates", text);
        Assert.DoesNotContain("BUILD_ARGS+=(\"--unsigned-updates\")", text);
    }

    // ---- What a build without the key does with an update ---------------------------------------

    /// <summary>The dev platform as a Windows PC that can replace itself; the "installer" only records what it was given.</summary>
    private sealed class InstallerPlatform : IPlatform, IUpdateInstaller
    {
        private readonly DevPlatform _dev;
        public InstallerPlatform(DevPlatform dev) => _dev = dev;
        public string? Version { get; private set; }
        public byte[]? Bytes { get; private set; }
        public string Name => "windows";
        public string UpdateChannel => "windows";
        public IPaths Paths => _dev.Paths;
        public IIdleProbe Idle => _dev.Idle;
        public ILockProbe Lock => _dev.Lock;
        public ISleepClock SleepClock => _dev.SleepClock;
        public IForegroundProbe Foreground => _dev.Foreground;
        public ICallWindowProbe CallWindows => _dev.CallWindows;
        public ISoundPlayer Sound => _dev.Sound;
        public IScreenCapture Screen => _dev.Screen;
        public ISecretStore Secrets => _dev.Secrets;
        public IAutostart Autostart => _dev.Autostart;
        public IPermissions Permissions => _dev.Permissions;
        public IScreenInfo ScreenInfo => _dev.ScreenInfo;
        public IUpdateInstaller Updater => this;
        public IShell Shell => _dev.Shell;
        public ILegacyMigration Legacy => _dev.Legacy;
        public bool CanSelfUpdate => true;

        public bool Launch(string verifiedFile, string version)
        {
            // Read through a shared handle: the service holds the checked copy open until here.
            using var file = new FileStream(verifiedFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            Bytes = new byte[file.Length];
            file.ReadExactly(Bytes);
            Version = version;
            return true;
        }
    }

    private static async Task<(UpdateService updates, FakeServer server, InstallerPlatform platform, MemoryLog log)> SignedIn()
    {
        var platform = new InstallerPlatform(new DevPlatform(Directory.CreateTempSubdirectory().FullName));
        var server = new FakeServer();
        server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        var api = new ApiClient(Base, new AgentIdentity("3.0.0", "windows", "pc-1"), new SessionStore(platform.Secrets), new ServerClock(), NullLog.Instance, server);
        Assert.True((await api.LoginAsync("a@x.test", "pw")).Ok);
        var log = new MemoryLog();
        var updates = new UpdateService(api, platform, new AgentOptions().Normalised(), log, "3.0.0");
        return (updates, server, platform, log);
    }

    private static void Serve(FakeServer server, byte[] bytes)
    {
        server.Route("GET agent/version", (_, _) => FakeServer.Ok(new
        {
            version = "3.1.0",
            fileName = "RXChampAgent.exe",
            available = true,
            sizeBytes = bytes.Length,
            sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
            platform = "windows",
        }));
        server.Route("GET agent/download", (_, _) => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) });
    }

    /// <summary>The trailer exactly as build/signing/sign-update.sh writes it.</summary>
    private static byte[] Signed(byte[] payload, ECDsa key, string version)
    {
        var signature = key.SignData(UpdateSignature.Message("windows", version, SHA256.HashData(payload)), HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
        var versionBytes = Encoding.UTF8.GetBytes(version);
        return payload.Concat(signature).Concat(versionBytes)
            .Concat(BitConverter.GetBytes((ushort)versionBytes.Length)).Concat(BitConverter.GetBytes((ushort)signature.Length))
            .Concat(Encoding.ASCII.GetBytes(UpdateSignature.Magic)).ToArray();
    }

    private const string Warning = "Warn update: update signing is not set up in this build; trusting the server's checksum";

    /// <summary>
    /// Kept on purpose: the agents already on people's machines have no key, and this is how they
    /// move to the first signed build (build/signing/README.md, "The first signed release").
    /// </summary>
    [Fact]
    public async Task A_build_without_the_key_still_takes_the_first_signed_build_and_says_so_in_the_log()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var (updates, server, platform, log) = await SignedIn();
        updates.TrustedKey = null;
        var signed = Signed(RandomNumberGenerator.GetBytes(4096), key, "3.1.0");
        Serve(server, signed);

        Assert.True(await updates.CheckAsync());

        Assert.Equal("3.1.0", platform.Version);
        Assert.Equal(signed, platform.Bytes);   // the file as served: the installer ignores the trailer
        Assert.Contains(Warning, log.Lines);
    }

    /// <summary>The control: the same build with the key in it takes only what the owner signed.</summary>
    [Fact]
    public async Task A_build_with_the_key_installs_only_what_the_owner_signed()
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var other = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var payload = RandomNumberGenerator.GetBytes(4096);

        var (updates, server, platform, log) = await SignedIn();
        updates.TrustedKey = key.ExportSubjectPublicKeyInfoPem();
        Serve(server, payload);
        Assert.False(await updates.CheckAsync());
        Assert.Null(platform.Bytes);
        Assert.Contains(log.Lines, l => l.Contains("3.1.0: refused: not signed"));

        (updates, server, platform, log) = await SignedIn();
        updates.TrustedKey = key.ExportSubjectPublicKeyInfoPem();
        Serve(server, Signed(payload, other, "3.1.0"));
        Assert.False(await updates.CheckAsync());
        Assert.Null(platform.Bytes);

        (updates, server, platform, log) = await SignedIn();
        updates.TrustedKey = key.ExportSubjectPublicKeyInfoPem();
        Serve(server, Signed(payload, key, "3.1.0"));
        Assert.True(await updates.CheckAsync());
        Assert.Equal(payload, platform.Bytes);   // the checked copy, without its signature
        Assert.DoesNotContain(Warning, log.Lines);
    }

    [Fact]
    public async Task A_service_trusts_exactly_the_key_this_build_carries()
    {
        var (updates, _, _, _) = await SignedIn();
        Assert.Equal(UpdateSignature.PublicKeyPem, updates.TrustedKey);
    }
}
