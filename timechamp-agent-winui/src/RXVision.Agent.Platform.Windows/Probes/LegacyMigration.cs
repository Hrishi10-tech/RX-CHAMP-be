using System.Runtime.Versioning;
using System.Text.Json;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Platform;

namespace RXVision.Agent.Platform.Windows.Probes;

/// <summary>
/// What the 2.x agent left behind, read once so an upgrade keeps the person signed
/// in. The 2.x session lived in <c>%APPDATA%\TimeChampAgent\session*.dat</c> (DPAPI,
/// no entropy, PascalCase JSON); its per-user enrollment is the sidecar in the old
/// install folder <c>%LOCALAPPDATA%\RXChampAgent</c>. Cleanup removes only the old
/// session files; the installer deals with the old install folder.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsLegacyMigration : ILegacyMigration
{
    private readonly string _sessionDir;
    private readonly string _installDir;
    private readonly Action<string>? _log;

    public WindowsLegacyMigration(Action<string>? log)
    {
        _sessionDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TimeChampAgent");
        _installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RXChampAgent");
        _log = log;
    }

    public LegacySession? TryReadSession()
    {
        try
        {
            if (!Directory.Exists(_sessionDir)) return null;
            var files = Directory.EnumerateFiles(_sessionDir, "session*.dat")
                .Select(p => new FileInfo(p))
                .OrderByDescending(f => f.LastWriteTimeUtc);
            foreach (var file in files)
            {
                var session = TryRead(file.FullName);
                if (session is not null) return session;
            }
            return null;
        }
        catch (Exception ex)
        {
            _log?.Invoke($"legacy: read session failed: {ex.Message}");
            return null;
        }
    }

    private LegacySession? TryRead(string path)
    {
        try
        {
            var decrypted = Dpapi.Unprotect(File.ReadAllBytes(path), entropy: null);
            using var doc = JsonDocument.Parse(decrypted);
            var root = doc.RootElement;
            string? Get(string name)
            {
                foreach (var p in root.EnumerateObject())
                    if (string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase) && p.Value.ValueKind == JsonValueKind.String)
                        return p.Value.GetString();
                return null;
            }
            var refreshToken = Get("RefreshToken");
            if (string.IsNullOrWhiteSpace(refreshToken)) return null;
            return new LegacySession(
                refreshToken,
                Get("UserId") ?? "",
                Get("Email") ?? "",
                Get("DisplayName") ?? "");
        }
        catch
        {
            // A file from another Windows account, or corrupt: try the next one.
            return null;
        }
    }

    public EnrollmentConfig? TryReadEnrollment()
    {
        try { return Enrollment.FromSidecar(_installDir); }
        catch (Exception ex) { _log?.Invoke($"legacy: read enrollment failed: {ex.Message}"); return null; }
    }

    public void Cleanup()
    {
        try
        {
            if (!Directory.Exists(_sessionDir)) return;
            foreach (var file in Directory.EnumerateFiles(_sessionDir, "session*.dat"))
            {
                try { File.Delete(file); } catch { /* best effort */ }
            }
        }
        catch (Exception ex)
        {
            _log?.Invoke($"legacy: cleanup failed: {ex.Message}");
        }
    }
}
