using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Platform.Windows.Native;

namespace RXVision.Agent.Platform.Windows.Probes;

/// <summary>
/// Small secrets (the session, the queue key) protected with Windows DPAPI
/// (CurrentUser scope) via crypt32, so no extra package. One file per key under
/// DataDir (<c>secret-&lt;key&gt;.bin</c>), with per-key additional entropy, written
/// atomically through a temp file and a move (review #38; see <see cref="SecretFile"/>).
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsSecretStore : ISecretStore
{
    private readonly string _dataDir;
    private readonly Action<string>? _log;

    public WindowsSecretStore(string dataDir, Action<string>? log)
    {
        _dataDir = dataDir;
        _log = log;
    }

    public void Save(string key, byte[] data)
    {
        try
        {
            var blob = Dpapi.Protect(data, Entropy(key));
            SecretFile.Write(PathFor(key), blob);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"secrets: save '{key}' failed: {ex.Message}");
        }
    }

    public byte[]? Load(string key)
    {
        try
        {
            var path = PathFor(key);
            if (!File.Exists(path)) return null;
            return Dpapi.Unprotect(File.ReadAllBytes(path), Entropy(key));
        }
        catch (Exception ex)
        {
            _log?.Invoke($"secrets: load '{key}' failed: {ex.Message}");
            return null;
        }
    }

    public void Delete(string key)
    {
        try
        {
            var path = PathFor(key);
            if (File.Exists(path)) File.Delete(path);
        }
        catch (Exception ex)
        {
            _log?.Invoke($"secrets: delete '{key}' failed: {ex.Message}");
        }
    }

    private string PathFor(string key)
    {
        var safe = new string(key.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_').ToArray());
        if (safe.Length == 0) safe = "key";
        return Path.Combine(_dataDir, $"secret-{safe}.bin");
    }

    private static byte[] Entropy(string key) => SHA256.HashData(Encoding.UTF8.GetBytes("RXVision.secret/" + key));
}

/// <summary>
/// Writes a small file atomically: a temp file beside it, then a move over the target.
/// Unlike Core's AtomicFile, the move is retried for about a second, because on Windows
/// an antivirus scan, the search indexer or a backup agent can hold the target or the
/// fresh temp file for a moment, and a save lost here is a lost (already rotated)
/// refresh token: signed out at the next start. A failed write also removes its temp
/// file, so stray copies of a secret do not pile up beside it.
/// </summary>
internal static class SecretFile
{
    public static void Write(string path, byte[] data, int attempts = 5, Action<TimeSpan>? sleep = null)
    {
        sleep ??= Thread.Sleep;
        var dir = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(dir);
        var tmp = Path.Combine(dir, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllBytes(tmp, data);
            for (var attempt = 1; ; attempt++)
            {
                try
                {
                    File.Move(tmp, path, overwrite: true);
                    return;
                }
                catch (Exception ex) when (attempt < attempts && ex is (IOException or UnauthorizedAccessException))
                {
                    sleep(TimeSpan.FromMilliseconds(100 * attempt));
                }
            }
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* best effort */ }
        }
    }
}

/// <summary>DPAPI (CurrentUser) via crypt32, with optional additional entropy.</summary>
[SupportedOSPlatform("windows")]
internal static class Dpapi
{
    public static byte[] Protect(byte[] data, byte[]? entropy) => Transform(data, entropy, encrypt: true);
    public static byte[] Unprotect(byte[] data, byte[]? entropy) => Transform(data, entropy, encrypt: false);

    private static byte[] Transform(byte[] data, byte[]? entropy, bool encrypt)
    {
        var inBlob = new NativeMethods.DATA_BLOB();
        var outBlob = new NativeMethods.DATA_BLOB();
        var dataHandle = GCHandle.Alloc(data, GCHandleType.Pinned);
        var entropyHandle = default(GCHandle);
        var entropyPtr = IntPtr.Zero;
        try
        {
            inBlob.cbData = data.Length;
            inBlob.pbData = dataHandle.AddrOfPinnedObject();

            if (entropy is { Length: > 0 })
            {
                entropyHandle = GCHandle.Alloc(entropy, GCHandleType.Pinned);
                var entropyBlob = new NativeMethods.DATA_BLOB
                {
                    cbData = entropy.Length,
                    pbData = entropyHandle.AddrOfPinnedObject(),
                };
                entropyPtr = Marshal.AllocHGlobal(Marshal.SizeOf<NativeMethods.DATA_BLOB>());
                Marshal.StructureToPtr(entropyBlob, entropyPtr, false);
            }

            var ok = encrypt
                ? NativeMethods.CryptProtectData(ref inBlob, "RXVision", entropyPtr, IntPtr.Zero, IntPtr.Zero, NativeMethods.CRYPTPROTECT_UI_FORBIDDEN, ref outBlob)
                : NativeMethods.CryptUnprotectData(ref inBlob, IntPtr.Zero, entropyPtr, IntPtr.Zero, IntPtr.Zero, NativeMethods.CRYPTPROTECT_UI_FORBIDDEN, ref outBlob);
            if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), "DPAPI operation failed.");

            var result = new byte[outBlob.cbData];
            Marshal.Copy(outBlob.pbData, result, 0, outBlob.cbData);
            return result;
        }
        finally
        {
            if (dataHandle.IsAllocated) dataHandle.Free();
            if (entropyHandle.IsAllocated) entropyHandle.Free();
            if (entropyPtr != IntPtr.Zero) Marshal.FreeHGlobal(entropyPtr);
            if (outBlob.pbData != IntPtr.Zero) NativeMethods.LocalFree(outBlob.pbData);
        }
    }
}
