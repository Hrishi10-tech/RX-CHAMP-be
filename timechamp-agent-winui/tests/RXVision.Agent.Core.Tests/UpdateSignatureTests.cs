using System.Security.Cryptography;
using System.Text;
using RXVision.Agent.Core.Update;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>Security review S-01 and S-08: only an update signed with the owner's key runs, and what runs is the checked copy.</summary>
public class UpdateSignatureTests
{
    private static readonly string Dir = Directory.CreateTempSubdirectory().FullName;

    private static (string Pem, ECDsa Key) NewKey()
    {
        var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        return (key.ExportSubjectPublicKeyInfoPem(), key);
    }

    /// <summary>The trailer exactly as build/signing/sign-update.sh writes it.</summary>
    private static string Signed(byte[] payload, ECDsa key, string platform, string version)
    {
        var message = UpdateSignature.Message(platform, version, SHA256.HashData(payload));
        var signature = key.SignData(message, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence);
        var versionBytes = Encoding.UTF8.GetBytes(version);
        var path = Path.Combine(Dir, Guid.NewGuid().ToString("N") + ".bin");
        using var file = File.Create(path);
        file.Write(payload);
        file.Write(signature);
        file.Write(versionBytes);
        file.Write(BitConverter.GetBytes((ushort)versionBytes.Length));
        file.Write(BitConverter.GetBytes((ushort)signature.Length));
        file.Write(Encoding.ASCII.GetBytes(UpdateSignature.Magic));
        return path;
    }

    private static string Out() => Path.Combine(Dir, Guid.NewGuid().ToString("N") + ".verified");

    [Fact]
    public void A_signed_update_is_accepted_and_the_launched_copy_is_exactly_the_payload()
    {
        var (pem, key) = NewKey();
        var payload = RandomNumberGenerator.GetBytes(200_000);
        var verified = Out();
        using (var held = UpdateSignature.VerifyAndStrip(Signed(payload, key, "windows", "3.6.1"), verified, "windows", "3.6.1", pem, out var problem))
        {
            Assert.NotNull(held);
            Assert.Null(problem);
            // Held open with no write sharing: on Windows nothing can swap it before the installer
            // starts (S-08). macOS and Linux treat sharing as advisory, so it is checked there only.
            if (OperatingSystem.IsWindows())
                Assert.Throws<IOException>(() => new FileStream(verified, FileMode.Open, FileAccess.Write, FileShare.ReadWrite).Dispose());
        }
        Assert.Equal(payload, File.ReadAllBytes(verified));
    }

    [Fact]
    public void A_copy_swapped_between_the_check_and_the_launch_is_refused()
    {
        // Review AG-1: the verified copy is closed and opened again before launch. Whatever is
        // put there in that instant is caught, because the held handle is hashed once more.
        var (pem, key) = NewKey();
        var payload = RandomNumberGenerator.GetBytes(50_000);
        var verified = Out();
        UpdateSignature.AfterVerifiedClosed = path =>
        {
            if (path != verified) return;
            var other = (byte[])payload.Clone();
            other[1234] ^= 0x01;
            File.WriteAllBytes(path, other);
        };
        try
        {
            var held = UpdateSignature.VerifyAndStrip(Signed(payload, key, "windows", "3.6.1"), verified, "windows", "3.6.1", pem, out var problem);
            Assert.Null(held);
            Assert.Equal("a file that changed after it was checked", problem);
            Assert.False(File.Exists(verified));
        }
        finally
        {
            UpdateSignature.AfterVerifiedClosed = null;
        }
    }

    [Fact]
    public void The_held_copy_reads_from_its_start()
    {
        var (pem, key) = NewKey();
        var payload = RandomNumberGenerator.GetBytes(10_000);
        using var held = UpdateSignature.VerifyAndStrip(Signed(payload, key, "windows", "3.6.1"), Out(), "windows", "3.6.1", pem, out _);
        Assert.NotNull(held);
        Assert.Equal(0, held!.Position);
    }

    [Fact]
    public void A_file_changed_after_signing_is_refused_and_nothing_is_left_to_launch()
    {
        var (pem, key) = NewKey();
        var path = Signed(RandomNumberGenerator.GetBytes(10_000), key, "windows", "3.6.1");
        var bytes = File.ReadAllBytes(path);
        bytes[100] ^= 0xFF;
        File.WriteAllBytes(path, bytes);
        var verified = Out();
        Assert.Null(UpdateSignature.VerifyAndStrip(path, verified, "windows", "3.6.1", pem, out var problem));
        Assert.Contains("does not match", problem);
        Assert.False(File.Exists(verified));
    }

    [Theory]
    [InlineData("windows", "9.9.9")]   // an old build relabelled as a new version
    [InlineData("mac", "3.6.1")]       // the Mac build offered to Windows
    public void A_signed_build_cannot_be_relabelled(string offeredPlatform, string offeredVersion)
    {
        var (pem, key) = NewKey();
        var path = Signed(RandomNumberGenerator.GetBytes(10_000), key, "windows", "3.6.1");
        Assert.Null(UpdateSignature.VerifyAndStrip(path, Out(), offeredPlatform, offeredVersion, pem, out _));
    }

    [Fact]
    public void A_signature_from_another_key_and_an_unsigned_file_are_refused()
    {
        var (pem, _) = NewKey();
        var (_, other) = NewKey();
        Assert.Null(UpdateSignature.VerifyAndStrip(Signed(new byte[5000], other, "mac", "3.6.1"), Out(), "mac", "3.6.1", pem, out _));
        var unsigned = Path.Combine(Dir, "plain.bin");
        File.WriteAllBytes(unsigned, new byte[5000]);
        Assert.Null(UpdateSignature.VerifyAndStrip(unsigned, Out(), "mac", "3.6.1", pem, out var problem));
        Assert.Equal("not signed", problem);
    }

    /// <summary>The owner's tool and the agent agree: a file signed by build/signing/sign-update.sh (OpenSSL).</summary>
    [Fact]
    public void A_file_signed_by_the_openssl_script_verifies()
    {
        var fixtures = Path.Combine(AppContext.BaseDirectory, "Fixtures", "update-signing");
        var pem = File.ReadAllText(Path.Combine(fixtures, "test-only-public-key.pem"));
        var verified = Out();
        using (var held = UpdateSignature.VerifyAndStrip(Path.Combine(fixtures, "openssl-signed.bin"), verified, "windows", "3.6.1", pem, out var problem))
            Assert.True(held is not null, problem);
        Assert.Equal(File.ReadAllBytes(Path.Combine(fixtures, "payload.bin")), File.ReadAllBytes(verified));
    }

    /// <summary>On macOS the signature is the zip's comment: the zip stays valid, and the checked copy is the zip as built.</summary>
    [Fact]
    public void A_mac_zip_signed_by_the_openssl_script_verifies_and_comes_back_unchanged()
    {
        var fixtures = Path.Combine(AppContext.BaseDirectory, "Fixtures", "update-signing");
        var pem = File.ReadAllText(Path.Combine(fixtures, "test-only-public-key-mac.pem"));
        var signed = Path.Combine(fixtures, "openssl-signed-mac.zip");
        using (var zip = System.IO.Compression.ZipFile.OpenRead(signed))
            Assert.Single(zip.Entries);   // still a valid zip with its signature inside
        var verified = Out();
        using (var held = UpdateSignature.VerifyAndStrip(signed, verified, "mac", "3.6.1", pem, out var problem))
            Assert.True(held is not null, problem);
        Assert.Equal(File.ReadAllBytes(Path.Combine(fixtures, "mac-payload.zip")), File.ReadAllBytes(verified));
    }

    [Fact]
    public void This_build_has_no_owner_key_yet_so_updates_work_as_before()
    {
        // Until the owner adds Update/update-public-key.pem, a build trusts the server's checksum,
        // and since audit F-01 it says so: the fact baked in at build time reads as not signed and
        // the note goes beside the version. The day the key file is in the source the same checks
        // turn round, so this test (and its name) is then ready to be retired.
        if (File.Exists(UpdateKeyGuardTests.KeyFileInSource()))
        {
            Assert.NotNull(UpdateSignature.PublicKeyPem);
            Assert.True(RXVision.Agent.Core.Config.AgentOptions.BuiltWithSignedUpdates);
            Assert.Null(UpdateSignature.UnsignedBuildNote);
            return;
        }
        Assert.Null(UpdateSignature.PublicKeyPem);
        Assert.False(RXVision.Agent.Core.Config.AgentOptions.BuiltWithSignedUpdates);
        Assert.Equal("Updates are not signed in this build.", UpdateSignature.UnsignedBuildNote);
    }
}
