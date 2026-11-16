using System.Reflection;
using System.Text;
using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Platform;

namespace RXVision.Agent.Core.Config;

/// <summary>
/// Runtime settings. Defaults are compiled in; <c>appsettings.json</c> beside the
/// app may override them, but only within safe ranges (a local file must not be
/// able to switch tracking off, e.g. with a one-day idle threshold).
/// </summary>
public sealed class AgentOptions
{
    /// <summary>The production API. Per-user downloads and setup codes carry their own.</summary>
    public const string DefaultApiBaseUrl = "https://api.rxvision.shop/api/v1";

    public string ApiBaseUrl { get; set; } = DefaultApiBaseUrl;
    public int HeartbeatSeconds { get; set; } = 60;
    public int IdleThresholdSeconds { get; set; } = 300;
    public int ActivitySeconds { get; set; } = 60;
    public int ScreenshotMinutes { get; set; } = 5;
    public bool AutoUpdate { get; set; } = true;
    public int UpdateCheckMinutes { get; set; } = 15;
    /// <summary>Allow http:// to a non-local server (development only).</summary>
    public bool AllowInsecureHttp { get; set; }

    public static string AppVersion =>
        typeof(AgentOptions).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion?.Split('+')[0]
        ?? typeof(AgentOptions).Assembly.GetName().Version?.ToString(3)
        ?? "0.0.0";

    /// <summary>Loads appsettings.json from <paramref name="appDir"/> and clamps every value.</summary>
    public static AgentOptions Load(string appDir)
    {
        var options = new AgentOptions();
        try
        {
            var path = Path.Combine(appDir, "appsettings.json");
            if (File.Exists(path))
            {
                var parsed = JsonSerializer.Deserialize<AgentOptions>(File.ReadAllText(path), Json.Options);
                if (parsed is not null) options = parsed;
            }
        }
        catch
        {
            // A broken file falls back to the defaults.
        }
        return options.Normalised();
    }

    public AgentOptions Normalised()
    {
        HeartbeatSeconds = Math.Clamp(HeartbeatSeconds, 30, 300);
        IdleThresholdSeconds = Math.Clamp(IdleThresholdSeconds, 60, 900);
        ActivitySeconds = Math.Clamp(ActivitySeconds, 30, 120);
        ScreenshotMinutes = Math.Clamp(ScreenshotMinutes, 1, 60);
        UpdateCheckMinutes = Math.Clamp(UpdateCheckMinutes, 5, 240);
        ApiBaseUrl = NormaliseUrl(ApiBaseUrl) ?? DefaultApiBaseUrl;
        return this;
    }

    /// <summary>
    /// A usable API base URL, or null. Only https is accepted, except for a
    /// server on this machine (development), so passwords and screenshots never
    /// travel in clear text.
    /// </summary>
    public static string? NormaliseUrl(string? raw, bool allowInsecure = false)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var uri)) return null;
        var local = uri.IsLoopback || uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase);
        if (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && (local || allowInsecure))) return null;
        return uri.ToString().TrimEnd('/');
    }
}

/// <summary>Reads per-user enrollment from the places a download can leave it.</summary>
public static class Enrollment
{
    public const string SidecarName = "tc-enroll.json";
    /// <summary>
    /// The 2.x enrollment the Windows installer carried across beside the app (once, on
    /// the first upgrade from 2.9.1). Not a new enrollment: the agent reads it only when
    /// it has none of its own, and only once.
    /// </summary>
    public const string LegacySidecarName = "tc-enroll.legacy.json";
    private const string SetupCodePrefix = "RXV1.";

    /// <summary>tc-enroll.json beside the app (written by the Windows installer from a per-user download).</summary>
    public static EnrollmentConfig? FromSidecar(string dir, string name = SidecarName)
    {
        try
        {
            var path = Path.Combine(dir, name);
            if (!File.Exists(path)) return null;
            return Parse(File.ReadAllText(path));
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// A setup code from the portal: "RXV1." + base64url(JSON {ApiBaseUrl, EnrollmentToken}).
    /// A bare enrollment token (a JWT) is accepted too, with the current server.
    /// </summary>
    public static EnrollmentConfig? FromSetupCode(string? code, string currentApiBaseUrl)
    {
        if (string.IsNullOrWhiteSpace(code)) return null;
        var text = new string(code.Where(c => !char.IsWhiteSpace(c)).ToArray());
        if (text.StartsWith(SetupCodePrefix, StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                var b64 = text[SetupCodePrefix.Length..].Replace('-', '+').Replace('_', '/');
                b64 = b64.PadRight(b64.Length + (4 - b64.Length % 4) % 4, '=');
                return Parse(Encoding.UTF8.GetString(Convert.FromBase64String(b64)));
            }
            catch
            {
                return null;
            }
        }
        // A raw JWT: three base64url parts.
        if (text.Count(c => c == '.') == 2 && text.Length > 40)
        {
            return new EnrollmentConfig(currentApiBaseUrl, text);
        }
        return null;
    }

    private static EnrollmentConfig? Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        string? Get(string name)
        {
            foreach (var p in root.EnumerateObject())
                if (string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase) && p.Value.ValueKind == JsonValueKind.String)
                    return p.Value.GetString();
            return null;
        }
        var token = Get("EnrollmentToken");
        var url = AgentOptions.NormaliseUrl(Get("ApiBaseUrl"));
        if (string.IsNullOrWhiteSpace(token) || url is null) return null;
        return new EnrollmentConfig(url, token.Trim());
    }
}
