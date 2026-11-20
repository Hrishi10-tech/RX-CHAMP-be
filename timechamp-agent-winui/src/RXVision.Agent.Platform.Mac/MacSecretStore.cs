using System.Runtime.Versioning;
using System.Text;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Platform.Mac.Native;

namespace RXVision.Agent.Platform.Mac;

/// <summary>
/// Secrets in the login Keychain as generic passwords (service com.rxvision.agent,
/// account = key), storing base64 of the bytes. Secrets never travel on a command
/// line. When the Keychain cannot be used (locked, no login session, interaction
/// not allowed) it falls back to a 0600 file in DataDir and logs it, so sign-in
/// still survives a restart on a headless or restricted session. A fallback file
/// only exists while it is the newest copy (a Keychain save deletes it), so it
/// wins on load.
///
/// Values are cached in memory after the first load or save: callers read some
/// keys constantly (the queue's file key on every sample), and each Keychain read
/// by a build the item's access list does not trust (every ad-hoc update) asks
/// the person for their password.
/// </summary>
[SupportedOSPlatform("macos")]
internal sealed class MacSecretStore : ISecretStore
{
    private const string Service = "com.rxvision.agent";
    private static readonly byte[] ServiceBytes = Encoding.UTF8.GetBytes(Service);

    private readonly string _dataDir;
    private readonly ILog _log;
    private readonly object _gate = new();
    private readonly Dictionary<string, byte[]> _cache = new(StringComparer.Ordinal);

    public MacSecretStore(string dataDir, ILog log)
    {
        _dataDir = dataDir;
        _log = log;
    }

    public void Save(string key, byte[] data)
    {
        if (string.IsNullOrEmpty(key) || data is null) return;
        var b64 = Encoding.ASCII.GetBytes(Convert.ToBase64String(data));
        lock (_gate)
        {
            // This process's view stays consistent even if neither store took it.
            _cache[key] = (byte[])data.Clone();
            if (TryKeychainSave(key, b64))
            {
                DeleteFile(key); // keep a single source of truth once the Keychain works
                return;
            }
            SaveFile(key, b64);
        }
    }

    public byte[]? Load(string key)
    {
        if (string.IsNullOrEmpty(key)) return null;
        lock (_gate)
        {
            if (_cache.TryGetValue(key, out var cached)) return (byte[])cached.Clone();

            // A fallback file is newer than any Keychain copy (a Keychain save deletes it).
            var file = LoadFile(key);
            var value = Decode(file);
            if (value is not null && file is not null)
            {
                // Security review S-06: a plaintext file must not outlive a Keychain that works.
                // Move it in (it is the newer value) and delete it; it stays only while the
                // Keychain still refuses.
                if (TryKeychainSave(key, file))
                {
                    DeleteFile(key);
                    _log.Info("secrets", $"moved '{key}' from the file fallback into the Keychain");
                }
            }
            if (value is null)
            {
                var (status, stored) = TryKeychainLoad(key);
                if (status == KeychainStatus.Ok) value = Decode(stored);
            }
            if (value is not null) _cache[key] = (byte[])value.Clone();
            return value;
        }
    }

    public void Delete(string key)
    {
        if (string.IsNullOrEmpty(key)) return;
        lock (_gate)
        {
            _cache.Remove(key);
            TryKeychainDelete(key);
            DeleteFile(key);
        }
    }

    // ---- Keychain ------------------------------------------------------------------

    private enum KeychainStatus { Ok, NotFound, Unavailable }

    private bool TryKeychainSave(string key, byte[] b64)
    {
        var account = Encoding.UTF8.GetBytes(key);
        try
        {
            // Item ref only: the old secret is not needed, and reading it could prompt.
            var find = Security.SecKeychainFindGenericPasswordItem(
                IntPtr.Zero,
                (uint)ServiceBytes.Length, ServiceBytes,
                (uint)account.Length, account,
                IntPtr.Zero, IntPtr.Zero, out var itemRef);

            if (find == Security.errSecSuccess)
            {
                try
                {
                    var modify = Security.SecKeychainItemModifyAttributesAndData(itemRef, IntPtr.Zero, (uint)b64.Length, b64);
                    if (modify == Security.errSecSuccess) return true;
                    _log.Warn("secrets", $"keychain update failed ({modify}); using file fallback");
                    return false;
                }
                finally
                {
                    if (itemRef != IntPtr.Zero) CoreFoundation.CFRelease(itemRef);
                }
            }

            if (find == Security.errSecItemNotFound)
            {
                var add = Security.SecKeychainAddGenericPassword(
                    IntPtr.Zero,
                    (uint)ServiceBytes.Length, ServiceBytes,
                    (uint)account.Length, account,
                    (uint)b64.Length, b64,
                    out var newItem);
                if (newItem != IntPtr.Zero) CoreFoundation.CFRelease(newItem);
                if (add == Security.errSecSuccess) return true;
                _log.Warn("secrets", $"keychain add failed ({add}); using file fallback");
                return false;
            }

            _log.Warn("secrets", $"keychain unavailable on save ({find}); using file fallback");
            return false;
        }
        catch (DllNotFoundException ex)
        {
            _log.Warn("secrets", "Security.framework not found; using file fallback", ex);
            return false;
        }
        catch (Exception ex)
        {
            _log.Warn("secrets", "keychain save threw; using file fallback", ex);
            return false;
        }
    }

    private (KeychainStatus Status, byte[]? Value) TryKeychainLoad(string key)
    {
        var account = Encoding.UTF8.GetBytes(key);
        try
        {
            var find = Security.SecKeychainFindGenericPassword(
                IntPtr.Zero,
                (uint)ServiceBytes.Length, ServiceBytes,
                (uint)account.Length, account,
                out var length, out var data, out var itemRef);

            if (find == Security.errSecItemNotFound) return (KeychainStatus.NotFound, null);
            if (find != Security.errSecSuccess)
            {
                _log.Warn("secrets", $"keychain unavailable on load ({find}); trying file fallback");
                return (KeychainStatus.Unavailable, null);
            }

            try
            {
                var buffer = new byte[length];
                if (length > 0 && data != IntPtr.Zero)
                    System.Runtime.InteropServices.Marshal.Copy(data, buffer, 0, (int)length);
                return (KeychainStatus.Ok, buffer);
            }
            finally
            {
                if (data != IntPtr.Zero) Security.SecKeychainItemFreeContent(IntPtr.Zero, data);
                if (itemRef != IntPtr.Zero) CoreFoundation.CFRelease(itemRef);
            }
        }
        catch (DllNotFoundException)
        {
            return (KeychainStatus.Unavailable, null);
        }
        catch (Exception ex)
        {
            _log.Warn("secrets", "keychain load threw; trying file fallback", ex);
            return (KeychainStatus.Unavailable, null);
        }
    }

    private void TryKeychainDelete(string key)
    {
        var account = Encoding.UTF8.GetBytes(key);
        try
        {
            var find = Security.SecKeychainFindGenericPasswordItem(
                IntPtr.Zero,
                (uint)ServiceBytes.Length, ServiceBytes,
                (uint)account.Length, account,
                IntPtr.Zero, IntPtr.Zero, out var itemRef);
            if (find != Security.errSecSuccess) return;
            try
            {
                var deleted = Security.SecKeychainItemDelete(itemRef);
                if (deleted != Security.errSecSuccess) _log.Warn("secrets", $"keychain delete failed ({deleted})");
            }
            finally
            {
                if (itemRef != IntPtr.Zero) CoreFoundation.CFRelease(itemRef);
            }
        }
        catch (Exception ex)
        {
            _log.Warn("secrets", "keychain delete threw", ex);
        }
    }

    // ---- File fallback (0600 in DataDir) --------------------------------------------

    private string FilePath(string key)
    {
        var safe = new string(key.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '_').ToArray());
        return Path.Combine(_dataDir, $"secret-{safe}.b64");
    }

    private void SaveFile(string key, byte[] b64)
    {
        try
        {
            Directory.CreateDirectory(_dataDir);
            var path = FilePath(key);
            var tmp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            // Created 0600, so the secret is never on disk with wider permissions.
            using (var fs = new FileStream(tmp, new FileStreamOptions
                   {
                       Mode = FileMode.CreateNew,
                       Access = FileAccess.Write,
                       UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
                   }))
            {
                fs.Write(b64);
            }
            TrySetOwnerOnly(tmp);
            File.Move(tmp, path, overwrite: true);
            TrySetOwnerOnly(path);
            _log.Warn("secrets", $"stored '{key}' in a 0600 file fallback (keychain unavailable)");
        }
        catch (Exception ex)
        {
            _log.Warn("secrets", $"file fallback save failed for '{key}'", ex);
        }
    }

    private byte[]? LoadFile(string key)
    {
        try
        {
            var path = FilePath(key);
            return File.Exists(path) ? File.ReadAllBytes(path) : null;
        }
        catch
        {
            return null;
        }
    }

    private void DeleteFile(string key)
    {
        try
        {
            var path = FilePath(key);
            if (File.Exists(path)) File.Delete(path);
        }
        catch { }
    }

    private static void TrySetOwnerOnly(string path)
    {
        try { File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite); }
        catch { }
    }

    private static byte[]? Decode(byte[]? b64)
    {
        if (b64 is null || b64.Length == 0) return null;
        try { return Convert.FromBase64String(Encoding.ASCII.GetString(b64)); }
        catch { return null; }
    }
}
