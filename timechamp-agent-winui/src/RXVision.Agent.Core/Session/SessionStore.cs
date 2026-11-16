using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Platform;

namespace RXVision.Agent.Core.Session;

public sealed class SavedSession
{
    public string ApiBaseUrl { get; set; } = "";
    public string RefreshToken { get; set; } = "";
    public string UserId { get; set; } = "";
    public string Email { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public string? Role { get; set; }
    public bool ScreenshotsEnabled { get; set; } = true;
}

/// <summary>
/// The saved session and enrollment, kept in the OS secret store (DPAPI on
/// Windows, the Keychain on macOS), never in a plain file.
/// </summary>
public sealed class SessionStore
{
    private const string SessionKey = "session";
    private const string EnrollmentKey = "enrollment";
    private readonly ISecretStore _secrets;

    public SessionStore(ISecretStore secrets) => _secrets = secrets;

    public SavedSession? Load() => TryLoad(out var session) ? session : null;

    /// <summary>
    /// The saved session, telling "none" (true, null) from "the store did not answer
    /// in time" (false: a Keychain prompt not answered yet). A store that failed in
    /// any other way, or held something unreadable, counts as none.
    /// </summary>
    public bool TryLoad(out SavedSession? session)
    {
        session = null;
        byte[]? bytes;
        try
        {
            bytes = _secrets.Load(SessionKey);
        }
        catch (TimeoutException)
        {
            return false;
        }
        catch
        {
            return true;
        }
        try
        {
            var s = bytes is null ? null : JsonSerializer.Deserialize<SavedSession>(bytes, Json.Options);
            session = string.IsNullOrWhiteSpace(s?.RefreshToken) ? null : s;
        }
        catch
        {
            session = null;
        }
        return true;
    }

    public void Save(SavedSession session)
    {
        try { _secrets.Save(SessionKey, JsonSerializer.SerializeToUtf8Bytes(session, Json.Options)); }
        catch { /* the user signs in again next launch */ }
    }

    public void Clear()
    {
        try { _secrets.Delete(SessionKey); } catch { }
    }

    public EnrollmentConfig? LoadEnrollment() => TryLoadEnrollment(out var enrollment) ? enrollment : null;

    /// <summary>
    /// The kept enrollment, telling "none" (true, null) from "the store did not answer
    /// in time" (false), so a slow read is never taken for an empty store and filled
    /// from an older source.
    /// </summary>
    public bool TryLoadEnrollment(out EnrollmentConfig? enrollment)
    {
        enrollment = null;
        byte[]? bytes;
        try
        {
            bytes = _secrets.Load(EnrollmentKey);
        }
        catch (TimeoutException)
        {
            return false;
        }
        catch
        {
            return true;   // a store that failed outright holds nothing usable
        }
        try
        {
            enrollment = bytes is null ? null : JsonSerializer.Deserialize<EnrollmentConfig>(bytes, Json.Options);
        }
        catch
        {
            enrollment = null;   // unreadable: as good as none
        }
        return true;
    }

    /// <returns>Whether the store took it (false: it did not answer, or failed).</returns>
    public bool SaveEnrollment(EnrollmentConfig enrollment)
    {
        try
        {
            _secrets.Save(EnrollmentKey, JsonSerializer.SerializeToUtf8Bytes(enrollment, Json.Options));
            return true;
        }
        catch
        {
            return false;
        }
    }

    public void ClearEnrollment()
    {
        try { _secrets.Delete(EnrollmentKey); } catch { }
    }
}
