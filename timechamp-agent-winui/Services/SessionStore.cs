using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace TimeChampAgent.Services;

public sealed class SavedSession
{
    public string RefreshToken { get; set; } = "";
    public string UserId { get; set; } = "";
    public string Email { get; set; } = "";
    public string DisplayName { get; set; } = "";
}

/// <summary>
/// Persists the login session under %APPDATA%\TimeChampAgent\.
/// The blob is encrypted at rest with Windows DPAPI (CurrentUser scope) so it
/// can only be decrypted by the same Windows account on the same machine.
/// DPAPI is reached via P/Invoke to crypt32.dll to avoid any NuGet dependency.
///
/// The file name is <b>scoped per build</b> (see <see cref="Configure"/>): a
/// per-user download carries a distinct enrollment token, so each such build
/// gets its own <c>session-{hash}.dat</c> and they never overwrite or resume
/// one another. Manual-login builds (no embedded token) use plain
/// <c>session.dat</c>. Without this, every build shared one file and the first
/// signed-in identity would leak into every other build on the machine.
/// </summary>
public static class SessionStore
{
    private static string _fileName = "session.dat";

    private static string Dir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TimeChampAgent");
    private static string FilePath => Path.Combine(Dir, _fileName);

    /// <summary>
    /// Bind the session file to this build's identity. Call once at startup,
    /// before any Load/Save. A per-user build (with an enrollment token) is
    /// scoped by (server + token); everything else keeps the default file.
    /// </summary>
    public static void Configure(AgentConfig config)
    {
        if (string.IsNullOrWhiteSpace(config.EnrollmentToken)) return;

        var material = $"{config.ApiBaseUrl}|{config.EnrollmentToken}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(material));
        var suffix = Convert.ToHexString(hash, 0, 8).ToLowerInvariant();
        _fileName = $"session-{suffix}.dat";
    }

    public static void Save(SavedSession session)
    {
        try
        {
            Directory.CreateDirectory(Dir);
            var json = JsonSerializer.SerializeToUtf8Bytes(session, JsonOpts.Default);
            var encrypted = Dpapi.Protect(json);
            File.WriteAllBytes(FilePath, encrypted);
        }
        catch { /* non-fatal: user just logs in again next launch */ }
    }

    public static SavedSession? Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            var decrypted = Dpapi.Unprotect(File.ReadAllBytes(FilePath));
            return JsonSerializer.Deserialize<SavedSession>(decrypted, JsonOpts.Default);
        }
        catch
        {
            return null;
        }
    }

    public static void Clear()
    {
        try { if (File.Exists(FilePath)) File.Delete(FilePath); } catch { }
    }
}

/// <summary>Minimal DPAPI wrapper (CurrentUser scope) via crypt32.dll.</summary>
internal static class Dpapi
{
    [StructLayout(LayoutKind.Sequential)]
    private struct DATA_BLOB
    {
        public int cbData;
        public IntPtr pbData;
    }

    private const int CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool CryptProtectData(
        ref DATA_BLOB pDataIn, string? szDataDescr, IntPtr pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern bool CryptUnprotectData(
        ref DATA_BLOB pDataIn, StringBuilder? ppszDataDescr, IntPtr pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);

    public static byte[] Protect(byte[] data) => Run(data, encrypt: true);
    public static byte[] Unprotect(byte[] data) => Run(data, encrypt: false);

    private static byte[] Run(byte[] data, bool encrypt)
    {
        var input = new DATA_BLOB();
        var output = new DATA_BLOB();
        var handle = GCHandle.Alloc(data, GCHandleType.Pinned);
        try
        {
            input.cbData = data.Length;
            input.pbData = handle.AddrOfPinnedObject();

            var ok = encrypt
                ? CryptProtectData(ref input, "TimeChampAgent", IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref output)
                : CryptUnprotectData(ref input, null, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref output);
            if (!ok) throw new InvalidOperationException("DPAPI operation failed.");

            var result = new byte[output.cbData];
            Marshal.Copy(output.pbData, result, 0, output.cbData);
            return result;
        }
        finally
        {
            if (handle.IsAllocated) handle.Free();
            if (output.pbData != IntPtr.Zero) LocalFree(output.pbData);
        }
    }
}
