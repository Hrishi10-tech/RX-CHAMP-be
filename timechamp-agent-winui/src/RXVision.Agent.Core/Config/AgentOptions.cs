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

    public string ApiBaseUrl { get; set; } = BuiltInApiBaseUrl;
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

    /// <summary>
    /// Security review S-02: the API hosts a release build may talk to. A setup code, the sidecar,
    /// the Advanced server field, <c>RXV_API</c>, appsettings.json and a saved session are all
    /// held to this list, so no message or file can point the agent at another server. Debug
    /// builds (tests, local runs) take any https host and this machine. A new production host
    /// needs a new build.
    /// </summary>
#if DEBUG
    public static readonly IReadOnlyCollection<string>? AllowedApiHosts = null;
#else
    public static readonly IReadOnlyCollection<string>? AllowedApiHosts = BuiltInHosts;
#endif

    /// <summary>The production host: the only one a build allows unless it was made for others on purpose.</summary>
    public const string ProductionApiHost = "api.rxvision.shop";

    /// <summary>
    /// Review AG-2: the hosts this build was made for, from the build property
    /// <c>RxvAllowedApiHosts</c> (comma separated; build-windows.sh and build-mac.sh take
    /// <c>--api-hosts</c>). Not set: production alone. A staging or pilot build is therefore made on
    /// purpose, says so in its build output and shows its hosts in Profile; no file, message or
    /// environment variable on a PC can widen the list.
    /// </summary>
    public static IReadOnlyList<string> BuiltInHosts { get; } = ParseHosts(
        typeof(AgentOptions).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "RxvAllowedApiHosts")?.Value);

    /// <summary>True when this build talks to production alone.</summary>
    public static bool BuiltForProductionOnly =>
        BuiltInHosts.Count == 1 && string.Equals(BuiltInHosts[0], ProductionApiHost, StringComparison.OrdinalIgnoreCase);

    /// <summary>Where a fresh install signs in: the first built-in host.</summary>
    public static string BuiltInApiBaseUrl => BuiltForProductionOnly ? DefaultApiBaseUrl : $"https://{BuiltInHosts[0]}/api/v1";

    /// <summary>
    /// Audit F-01: whether this build carries the owner's update-signing public key, from the
    /// build (assembly metadata <c>RxvUpdateSigning</c>: "signed" when
    /// <c>Update/update-public-key.pem</c> was in the source, else "unsigned"). A release build
    /// without the key does not build unless it was asked for on purpose with the build property
    /// <c>RxvAllowUnsignedUpdates</c> (build-windows.sh and build-mac.sh take
    /// <c>--unsigned-updates</c>); such a build says so beside its version
    /// (<see cref="Update.UpdateSignature.UnsignedBuildNote"/>) and is never published. Nothing on a
    /// PC can change it.
    /// </summary>
    public static bool BuiltWithSignedUpdates { get; } = ParseUpdateSigning(
        typeof(AgentOptions).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(a => a.Key == "RxvUpdateSigning")?.Value);

    /// <summary>Only the exact word counts: a missing or unknown value reads as not signed.</summary>
    internal static bool ParseUpdateSigning(string? raw) =>
        string.Equals(raw?.Trim(), "signed", StringComparison.OrdinalIgnoreCase);

    /// <summary>Host names only: lower case, no scheme, path, port, wildcard or address. Nothing valid: production.</summary>
    internal static IReadOnlyList<string> ParseHosts(string? raw)
    {
        var hosts = (raw ?? "")
            .Split(new[] { ',', ';', ' ' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(h => h.ToLowerInvariant())
            .Where(h => Uri.CheckHostName(h) == UriHostNameType.Dns && h.Contains('.') && !h.Contains('*'))
            .Distinct()
            .ToArray();
        return hosts.Length > 0 ? hosts : new[] { ProductionApiHost };
    }

    /// <summary>
    /// Security review S-04: in a release build the staff member can write appsettings.json, so the
    /// keys that set how much is recorded, whether updates come, and http are never taken from it.
    /// </summary>
#if DEBUG
    internal const bool LocalFileLocked = false;
#else
    internal const bool LocalFileLocked = true;
#endif

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
                if (parsed is not null) options = FromLocalFile(parsed, LocalFileLocked);
            }
        }
        catch
        {
            // A broken file falls back to the defaults.
        }
        return options.Normalised();
    }

    /// <summary>What a local file may set: with <paramref name="locked"/>, the timing of checks only.</summary>
    internal static AgentOptions FromLocalFile(AgentOptions file, bool locked)
    {
        if (!locked) return file;
        var safe = new AgentOptions
        {
            ActivitySeconds = file.ActivitySeconds,
            UpdateCheckMinutes = file.UpdateCheckMinutes,
        };
        return safe;
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
    public static string? NormaliseUrl(string? raw, bool allowInsecure = false) =>
        NormaliseUrl(raw, allowInsecure, AllowedApiHosts);

    /// <summary>As above, held to <paramref name="allowedHosts"/> when one is given (release builds).</summary>
    internal static string? NormaliseUrl(string? raw, bool allowInsecure, IReadOnlyCollection<string>? allowedHosts)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var uri)) return null;
        if (allowedHosts is not null)
        {
            // Release: https to a listed host only; no http, no other server, not even this machine.
            if (uri.Scheme != Uri.UriSchemeHttps || !allowedHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase)) return null;
            return uri.ToString().TrimEnd('/');
        }
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
