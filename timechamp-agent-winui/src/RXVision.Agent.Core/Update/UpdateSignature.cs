using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace RXVision.Agent.Core.Update;

/// <summary>
/// Security review S-01: an update is trusted only if it carries a signature made with the
/// owner's offline key, so neither the API nor its storage can push code on their own.
///
/// The publish step appends a trailer to the installer (Windows .exe) or zip (macOS):
/// <c>[payload][signature][version][u16 version length][u16 signature length]["RXVSIG01"]</c>.
/// The signature is ECDSA P-256 with SHA-256 (DER, as <c>openssl dgst -sha256 -sign</c> writes it)
/// over the text <c>RXVSIG01\n{platform}\n{version}\n{sha256 of payload, lower hex}</c>, so a
/// signed build cannot be relabelled as another version or moved to the other platform.
///
/// On macOS the trailer is the zip's comment: the signing step sets the end record's comment
/// length (the payload's last two bytes) to the trailer's length, so the zip stays valid for
/// ditto and older agents. Those two bytes are read as zero for the hash and in the copy.
///
/// The public key is built in from <c>Update/update-public-key.pem</c> when that file exists at
/// build time. Without it, updates work as before (checksum from the API only) and the log says so.
/// Audit F-01: a release build without the file no longer builds unless it was asked for on
/// purpose (build property <c>RxvAllowUnsignedUpdates</c>), and then it says so beside its version.
/// </summary>
public static class UpdateSignature
{
    public const string Magic = "RXVSIG01";
    private const int MaxSignature = 256;
    private const int MaxVersion = 64;

    private static readonly Lazy<string?> BuiltInKey = new(() =>
    {
        try
        {
            using var stream = typeof(UpdateSignature).Assembly.GetManifestResourceStream("RXVision.Agent.Core.Update.update-public-key.pem");
            if (stream is null) return null;
            using var reader = new StreamReader(stream, Encoding.ASCII);
            var pem = reader.ReadToEnd().Trim();
            return pem.Length > 0 ? pem : null;
        }
        catch
        {
            return null;
        }
    });

    /// <summary>Tests: called between closing the verified copy and opening it again (review AG-1).</summary>
    internal static Action<string>? AfterVerifiedClosed { get; set; }

    /// <summary>The owner's public key this build trusts, or null when update signing is not set up.</summary>
    public static string? PublicKeyPem => BuiltInKey.Value;

    /// <summary>What a build that does not check update signatures shows beside its version (audit F-01).</summary>
    public const string UnsignedBuildNoteText = "Updates are not signed in this build.";

    /// <summary>
    /// <see cref="UnsignedBuildNoteText"/> when this build does not check update signatures, else
    /// null. Both the fact baked in at build time and the key actually found must say signed.
    /// </summary>
    public static string? UnsignedBuildNote => NoteFor(Config.AgentOptions.BuiltWithSignedUpdates, PublicKeyPem);

    internal static string? NoteFor(bool builtSigned, string? publicKeyPem) =>
        builtSigned && publicKeyPem is not null ? null : UnsignedBuildNoteText;

    /// <summary>The exact text that is signed.</summary>
    public static byte[] Message(string platform, string version, byte[] payloadSha256) =>
        Encoding.UTF8.GetBytes($"{Magic}\n{platform}\n{version}\n{Convert.ToHexString(payloadSha256).ToLowerInvariant()}");

    /// <summary>
    /// Checks the signed file at <paramref name="signedPath"/> and writes the payload without its
    /// trailer to <paramref name="verifiedPath"/>. Returns the verified copy opened for reading with
    /// no write or delete sharing (security review S-08): keep it open until the installer has
    /// started, so nothing can swap the file in between. Null, with <paramref name="problem"/>, when
    /// the file is not signed by <paramref name="publicKeyPem"/> for this platform and version.
    /// </summary>
    public static FileStream? VerifyAndStrip(string signedPath, string verifiedPath, string platform, string version, string publicKeyPem, out string? problem)
    {
        problem = null;
        try
        {
            using var signed = new FileStream(signedPath, FileMode.Open, FileAccess.Read, FileShare.Read);
            var magic = Encoding.ASCII.GetBytes(Magic);
            if (signed.Length < magic.Length + 4) { problem = "not signed"; return null; }
            var tail = new byte[magic.Length + 4];
            signed.Seek(-tail.Length, SeekOrigin.End);
            signed.ReadExactly(tail);
            if (!tail.AsSpan(4).SequenceEqual(magic)) { problem = "not signed"; return null; }
            var versionLength = BitConverter.ToUInt16(tail, 0);
            var signatureLength = BitConverter.ToUInt16(tail, 2);
            if (versionLength is 0 or > MaxVersion || signatureLength is 0 or > MaxSignature) { problem = "a damaged signature"; return null; }
            var trailerLength = (long)signatureLength + versionLength + tail.Length;
            var payloadLength = signed.Length - trailerLength;
            if (payloadLength <= 0) { problem = "a damaged signature"; return null; }

            var signature = new byte[signatureLength];
            var versionBytes = new byte[versionLength];
            signed.Seek(payloadLength, SeekOrigin.Begin);
            signed.ReadExactly(signature);
            signed.ReadExactly(versionBytes);
            var signedVersion = Encoding.UTF8.GetString(versionBytes);
            if (!string.Equals(signedVersion, version, StringComparison.Ordinal)) { problem = $"signed as {signedVersion}, offered as {version}"; return null; }

            // The payload is copied to the verified file while it is hashed, so what is checked is
            // exactly what is launched.
            Directory.CreateDirectory(Path.GetDirectoryName(verifiedPath)!);
            var verified = new FileStream(verifiedPath, FileMode.Create, FileAccess.ReadWrite, FileShare.None);
            try
            {
                signed.Seek(0, SeekOrigin.Begin);
                using var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var buffer = new byte[81920];
                var left = payloadLength;
                while (left > 0)
                {
                    var read = signed.Read(buffer, 0, (int)Math.Min(buffer.Length, left));
                    if (read <= 0) throw new EndOfStreamException();
                    left -= read;
                    if (left == 0 && platform == "mac" && read >= 2)
                    {
                        // The zip comment length back to none: the zip exactly as it was signed.
                        buffer[read - 2] = 0;
                        buffer[read - 1] = 0;
                    }
                    sha.AppendData(buffer, 0, read);
                    verified.Write(buffer, 0, read);
                }
                verified.Flush(true);
                using var key = ECDsa.Create();
                key.ImportFromPem(publicKeyPem);
                var payloadHash = sha.GetHashAndReset();
                var message = Message(platform, version, payloadHash);
                if (!key.VerifyData(message, signature, HashAlgorithmName.SHA256, DSASignatureFormat.Rfc3279DerSequence))
                {
                    problem = "a signature that does not match the owner's key";
                    verified.Dispose();
                    TryDelete(verifiedPath);
                    return null;
                }
                verified.Dispose();
                AfterVerifiedClosed?.Invoke(verifiedPath);
                // Read-only from here to the launch: nobody may write or delete it meanwhile. The
                // installer cannot run a file this process holds open for writing, so the copy is
                // closed and opened again; for that instant nothing held it. What is launched is
                // therefore hashed once more through the handle that stays open (review AG-1).
                var held = new FileStream(verifiedPath, FileMode.Open, FileAccess.Read, FileShare.Read);
                try
                {
                    using var again = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                    int n;
                    while ((n = held.Read(buffer, 0, buffer.Length)) > 0) again.AppendData(buffer, 0, n);
                    if (held.Length != payloadLength || !CryptographicOperations.FixedTimeEquals(again.GetHashAndReset(), payloadHash))
                    {
                        problem = "a file that changed after it was checked";
                        held.Dispose();
                        TryDelete(verifiedPath);
                        return null;
                    }
                    held.Seek(0, SeekOrigin.Begin);
                    return held;
                }
                catch
                {
                    held.Dispose();
                    throw;
                }
            }
            catch
            {
                verified.Dispose();
                TryDelete(verifiedPath);
                throw;
            }
        }
        catch (Exception ex)
        {
            problem = $"an unreadable file ({ex.GetType().Name})";
            return null;
        }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }
}
