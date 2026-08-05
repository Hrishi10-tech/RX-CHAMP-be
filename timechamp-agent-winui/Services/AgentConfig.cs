using System.IO;
using System.Text;
using System.Text.Json;

namespace TimeChampAgent.Services;

/// <summary>
/// Runtime configuration. Base values come from appsettings.json next to the exe;
/// a per-user download additionally has an <see cref="EmbeddedConfig"/> appended to
/// the exe file itself, which overrides the server URL and carries the one-time
/// enrollment token so the agent can sign in without the user typing anything.
/// </summary>
public sealed class AgentConfig
{
    public string ApiBaseUrl { get; init; } = "http://localhost:4000/api/v1";
    public int HeartbeatSeconds { get; init; } = 60;
    public int IdleThresholdSeconds { get; init; } = 300;
    /// <summary>How often the foreground app/website is sampled and reported.</summary>
    public int ActivitySeconds { get; init; } = 60;

    /// <summary>Present only for pre-configured (per-user) downloads.</summary>
    public string? EnrollmentToken { get; init; }

    public static AgentConfig Load()
    {
        var fromFile = LoadFile();
        // Per-user config comes from a sidecar tc-enroll.json (used by the ZIP download)
        // and falls back to the exe trailer (used by the legacy single-exe download).
        var embedded = EmbeddedConfig.TryReadSidecar() ?? EmbeddedConfig.TryRead();
        if (embedded is null) return fromFile;

        // Baked per-user config wins for the server URL + brings the enrollment token.
        return new AgentConfig
        {
            ApiBaseUrl = string.IsNullOrWhiteSpace(embedded.ApiBaseUrl) ? fromFile.ApiBaseUrl : embedded.ApiBaseUrl!,
            HeartbeatSeconds = fromFile.HeartbeatSeconds,
            IdleThresholdSeconds = fromFile.IdleThresholdSeconds,
            ActivitySeconds = fromFile.ActivitySeconds,
            EnrollmentToken = embedded.EnrollmentToken,
        };
    }

    private static AgentConfig LoadFile()
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "appsettings.json");
            if (File.Exists(path))
            {
                var cfg = JsonSerializer.Deserialize<AgentConfig>(File.ReadAllText(path), JsonOpts.Default);
                if (cfg is not null && !string.IsNullOrWhiteSpace(cfg.ApiBaseUrl))
                    return cfg;
            }
        }
        catch
        {
            // Ignore and fall through to defaults.
        }
        return new AgentConfig();
    }
}

/// <summary>Config appended to the exe by the server for per-user downloads.</summary>
public sealed class EmbeddedConfig
{
    public string? ApiBaseUrl { get; set; }
    public string? EnrollmentToken { get; set; }

    // Trailer layout at the very end of the file:
    //   [configJson (N bytes UTF-8)][N as uint32 little-endian (4 bytes)][magic (8 bytes)]
    private static readonly byte[] Magic = Encoding.ASCII.GetBytes("TCAGCFG1");

    /// <summary>Name of the per-user config file dropped next to the exe by the ZIP download.</summary>
    private const string SidecarName = "tc-enroll.json";

    /// <summary>Reads per-user config from <c>tc-enroll.json</c> beside the exe (ZIP download).
    /// Returns null when the file is absent (a plain build) or unreadable.</summary>
    public static EmbeddedConfig? TryReadSidecar()
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, SidecarName);
            if (!File.Exists(path)) return null;
            var cfg = JsonSerializer.Deserialize<EmbeddedConfig>(File.ReadAllText(path), JsonOpts.Default);
            return string.IsNullOrWhiteSpace(cfg?.EnrollmentToken) ? null : cfg;
        }
        catch
        {
            return null;
        }
    }

    public static EmbeddedConfig? TryRead()
    {
        try
        {
            var exe = Environment.ProcessPath;
            if (string.IsNullOrEmpty(exe) || !File.Exists(exe)) return null;

            using var fs = File.Open(exe, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            if (fs.Length < Magic.Length + 4) return null;

            // Check the magic at the end.
            var magic = new byte[Magic.Length];
            fs.Seek(-Magic.Length, SeekOrigin.End);
            fs.ReadExactly(magic);
            for (var i = 0; i < Magic.Length; i++)
                if (magic[i] != Magic[i]) return null;

            // Length of the JSON blob.
            var lenBytes = new byte[4];
            fs.Seek(-(Magic.Length + 4), SeekOrigin.End);
            fs.ReadExactly(lenBytes);
            var len = BitConverter.ToUInt32(lenBytes, 0);
            if (len == 0 || len > 64 * 1024 || len > fs.Length) return null;

            // The JSON blob itself.
            var json = new byte[len];
            fs.Seek(-(Magic.Length + 4 + (long)len), SeekOrigin.End);
            fs.ReadExactly(json);

            return JsonSerializer.Deserialize<EmbeddedConfig>(json, JsonOpts.Default);
        }
        catch
        {
            return null;
        }
    }
}
