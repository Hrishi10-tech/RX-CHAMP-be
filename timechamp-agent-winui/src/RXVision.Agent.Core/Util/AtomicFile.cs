using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using RXVision.Agent.Core.Platform;

namespace RXVision.Agent.Core.Util;

/// <summary>
/// Writes go to a temp file first and are then moved over the target, so a crash
/// never leaves half a file. The move is retried briefly, because antivirus or the
/// search indexer can hold the target for a moment on Windows; the temp file never
/// outlives a failed write.
/// </summary>
public static class AtomicFile
{
    private const int Attempts = 5;

    /// <param name="durable">Flush the new contents to the disk before the move (fsync), so a power cut keeps them.</param>
    /// <param name="hidden">Mark the file hidden (and system on Windows) after the move.</param>
    public static void WriteAllBytes(string path, byte[] data, bool durable = false, bool hidden = false)
    {
        var dir = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(dir);
        var tmp = Path.Combine(dir, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(data, 0, data.Length);
                if (durable) stream.Flush(flushToDisk: true);
            }
            // A hidden or system target refuses to be replaced on some Windows versions.
            HiddenFile.PrepareOverwrite(path);
            for (var attempt = 1; ; attempt++)
            {
                try
                {
                    File.Move(tmp, path, overwrite: true);
                    break;
                }
                catch (Exception ex) when (attempt < Attempts && ex is IOException or UnauthorizedAccessException)
                {
                    Thread.Sleep(100 * attempt);
                }
            }
            if (hidden) HiddenFile.Hide(path);
        }
        finally
        {
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* best effort */ }
        }
    }
}

/// <summary>
/// The agent's data files are hidden from the person (4.0, SPEC 6 "Protection"):
/// hidden and system attributes on Windows, the hidden flag (chflags hidden, which
/// .NET sets for FileAttributes.Hidden) on macOS. Best effort: a file system that
/// cannot hide a file still keeps it, encrypted.
/// </summary>
public static class HiddenFile
{
    public static void Hide(string path)
    {
        try
        {
            if (!File.Exists(path)) return;
            var attributes = File.GetAttributes(path);
            var wanted = attributes | FileAttributes.Hidden;
            if (OperatingSystem.IsWindows()) wanted |= FileAttributes.System;
            if (wanted != attributes) File.SetAttributes(path, wanted);
        }
        catch
        {
            // Cosmetic protection only: the contents are encrypted either way.
        }
    }

    /// <summary>Takes hidden and system off a file about to be replaced (Windows refuses to overwrite them otherwise).</summary>
    public static void PrepareOverwrite(string path)
    {
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            if (!File.Exists(path)) return;
            var attributes = File.GetAttributes(path);
            var plain = attributes & ~(FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReadOnly);
            if (plain != attributes) File.SetAttributes(path, plain == 0 ? FileAttributes.Normal : plain);
        }
        catch
        {
            // The move reports it if it matters.
        }
    }

    /// <summary>Deletes a file even when it is hidden, system or read-only.</summary>
    public static void Delete(string path)
    {
        try
        {
            if (!File.Exists(path)) return;
            PrepareOverwrite(path);
            File.Delete(path);
        }
        catch
        {
            // Best effort.
        }
    }
}

/// <summary>
/// The key for the agent's encrypted files, kept in the OS secret store. Read once per
/// store and kept for the life of the process: a keychain prompt or a slow DPAPI read
/// per write would be costly, and a transient read failure in the middle of a day must
/// never replace the key (that would make everything written before it unreadable).
/// </summary>
internal static class FileKeys
{
    private const string KeyName = "file-key";
    private static readonly ConditionalWeakTable<ISecretStore, byte[]> s_keys = new();
    private static readonly object s_gate = new();

    /// <summary>The key, made and saved if the store has none.</summary>
    public static byte[] GetOrCreate(ISecretStore secrets)
    {
        lock (s_gate)
        {
            if (s_keys.TryGetValue(secrets, out var cached)) return cached;
            var key = secrets.Load(KeyName);
            if (key is not { Length: 32 })
            {
                key = RandomNumberGenerator.GetBytes(32);
                secrets.Save(KeyName, key);
            }
            s_keys.AddOrUpdate(secrets, key);
            return key;
        }
    }

    /// <summary>The key if one exists (never creates one: reading must not replace it).</summary>
    public static byte[]? Existing(ISecretStore secrets)
    {
        lock (s_gate)
        {
            if (s_keys.TryGetValue(secrets, out var cached)) return cached;
            var key = secrets.Load(KeyName);
            if (key is not { Length: 32 }) return null;
            s_keys.AddOrUpdate(secrets, key);
            return key;
        }
    }

    /// <summary>AES-256-GCM: [1 version][12 nonce][16 tag][cipher].</summary>
    public static byte[] Seal(byte[] key, byte[] plain)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var cipher = new byte[plain.Length];
        var tag = new byte[16];
        using (var gcm = new AesGcm(key, 16)) gcm.Encrypt(nonce, plain, cipher, tag);
        var blob = new byte[1 + 12 + 16 + cipher.Length];
        blob[0] = 1; // format version
        nonce.CopyTo(blob, 1);
        tag.CopyTo(blob, 13);
        cipher.CopyTo(blob, 29);
        return blob;
    }

    /// <summary>The plain bytes, or null when the blob is not ours, was altered, or the key is wrong.</summary>
    public static byte[]? Open(byte[] key, ReadOnlySpan<byte> blob)
    {
        try
        {
            if (blob.Length < 29 || blob[0] != 1) return null;
            var plain = new byte[blob.Length - 29];
            using var gcm = new AesGcm(key, 16);
            gcm.Decrypt(blob.Slice(1, 12), blob[29..], blob.Slice(13, 16), plain);
            return plain;
        }
        catch
        {
            return null;
        }
    }
}

/// <summary>
/// A file encrypted with AES-GCM under a random key kept in the OS secret store.
/// Used for things too big for the keychain but too personal for plain text,
/// such as queued activity samples (window titles are personal data).
/// </summary>
public sealed class ProtectedFile
{
    private readonly ISecretStore _secrets;
    private readonly string _path;
    private readonly bool _durable;
    private readonly bool _hidden;

    /// <param name="durable">fsync every write (the offline state: it must survive a power cut).</param>
    /// <param name="hidden">Keep the file hidden from the person (4.0).</param>
    public ProtectedFile(ISecretStore secrets, string path, bool durable = false, bool hidden = false)
    {
        _secrets = secrets;
        _path = path;
        _durable = durable;
        _hidden = hidden;
    }

    public string Path_ => _path;

    public void Write(byte[] plain)
    {
        var key = FileKeys.GetOrCreate(_secrets);
        AtomicFile.WriteAllBytes(_path, FileKeys.Seal(key, plain), _durable, _hidden);
    }

    /// <summary>
    /// The decrypted contents (null when missing or unreadable), or false when the key
    /// cannot be read now (the secret store did not answer in time): the file is then
    /// neither read nor to be overwritten.
    /// </summary>
    public bool TryRead(out byte[]? data)
    {
        data = null;
        try
        {
            if (File.Exists(_path)) FileKeys.Existing(_secrets);
        }
        catch (TimeoutException)
        {
            return false;
        }
        catch
        {
            // Read says what it can.
        }
        data = Read();
        return true;
    }

    /// <summary>The decrypted contents, or null when missing or unreadable (e.g. the key was lost).</summary>
    public byte[]? Read()
    {
        try
        {
            if (!File.Exists(_path)) return null;
            var blob = File.ReadAllBytes(_path);
            var key = FileKeys.Existing(_secrets);
            if (key is null) return null;
            return FileKeys.Open(key, blob);
        }
        catch
        {
            return null;
        }
    }

    public void Delete() => HiddenFile.Delete(_path);
}
