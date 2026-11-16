using System.Diagnostics;
using System.Globalization;
using RXVision.Agent.Core.Api;

namespace RXVision.Agent.E2E.Tests;

/// <summary>
/// Where the end-to-end tests run, and when they may. Opt-in, because they change data:
///
///   RXV_E2E_API=http://127.0.0.1:4500/api/v1     a 4.0 API, migrated and seeded (local or staging)
///   RXV_E2E_DB=postgresql://.../rxv_agent_e2e    optional: that API's database (local only), to
///                                                count rows the API does not list (duplicates)
///
/// Without RXV_E2E_API every test returns at once (and passes), so the normal test
/// runs never need a server. Production is refused. Shifts are built around the
/// current time, so the tests run between 03:00 and 18:30 business time (Asia/Kolkata).
/// </summary>
internal static class E2EEnv
{
    private static readonly string[] ProductionHosts = { "api.rxvision.shop" };

    /// <summary>The business time zone (Asia/Kolkata: no daylight saving).</summary>
    public static readonly TimeSpan BusinessOffset = TimeSpan.FromHours(5.5);

    public static string? Api => Environment.GetEnvironmentVariable("RXV_E2E_API") is { Length: > 0 } a ? a.TrimEnd('/') : null;

    public static string? Db => Environment.GetEnvironmentVariable("RXV_E2E_DB") is { Length: > 0 } d ? d : null;

    /// <summary>Why the tests cannot run now, or null when they can.</summary>
    public static string? SkipReason()
    {
        if (Api is null) return "skipped: set RXV_E2E_API (and RXV_E2E_DB) to run the end-to-end tests";
        if (!Uri.TryCreate(Api, UriKind.Absolute, out var uri)) return $"skipped: RXV_E2E_API is not a URL ({Api})";
        if (ProductionHosts.Contains(uri.Host, StringComparer.OrdinalIgnoreCase))
            return $"refused: {uri.Host} is production and these tests change data";
        var now = BusinessNow;
        var minute = now.Hour * 60 + now.Minute;
        if (minute < 3 * 60 || minute > 18 * 60 + 30)
            return $"skipped: it is {Clock12(now)} business time; run between 3:00 AM and 6:30 PM (shifts are built around now)";
        return null;
    }

    public static DateTimeOffset BusinessNow => DateTimeOffset.UtcNow.ToOffset(BusinessOffset);

    /// <summary>Today's business day (YYYY-MM-DD).</summary>
    public static string Today => BusinessNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>"HH:MM" in the business time zone (what a shift is written in).</summary>
    public static string Hm(DateTimeOffset t) => t.ToOffset(BusinessOffset).ToString("HH:mm", CultureInfo.InvariantCulture);

    /// <summary>"9:05 AM": how a person reads a time.</summary>
    public static string Clock12(DateTimeOffset t) => t.ToOffset(BusinessOffset).ToString("h:mm tt", CultureInfo.InvariantCulture);

    public static string Iso(DateTimeOffset t) => ApiClient.Iso(t);

    public static async Task WaitFor(Func<bool> condition, TimeSpan timeout, string what)
    {
        var until = DateTime.UtcNow + timeout;
        while (!condition())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException($"timed out waiting for {what}");
            await Task.Delay(100);
        }
    }

    public static async Task WaitFor(Func<Task<bool>> condition, TimeSpan timeout, string what)
    {
        var until = DateTime.UtcNow + timeout;
        while (!await condition())
        {
            if (DateTime.UtcNow > until) throw new TimeoutException($"timed out waiting for {what}");
            await Task.Delay(250);
        }
    }

    /// <summary>
    /// Runs SQL on <see cref="Db"/> with psql (tuples only) and returns what it prints.
    /// Local databases only; null when no database was given.
    /// </summary>
    public static async Task<string?> SqlAsync(string sql)
    {
        if (Db is not { } url) return null;
        var host = Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host : "";
        if (host is not ("localhost" or "127.0.0.1" or "::1" or "[::1]"))
            throw new InvalidOperationException("RXV_E2E_DB must point at a local database.");
        var psi = new ProcessStartInfo("psql") { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var arg in new[] { url, "-v", "ON_ERROR_STOP=1", "-q", "-At", "-c", sql }) psi.ArgumentList.Add(arg);
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("could not start psql");
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        await p.WaitForExitAsync();
        if (p.ExitCode != 0) throw new InvalidOperationException($"psql failed ({p.ExitCode}): {await stderr}");
        return (await stdout).Trim();
    }

    /// <summary>A count from SQL, or null without a database.</summary>
    public static async Task<int?> CountAsync(string sql) =>
        await SqlAsync(sql) is { } text ? int.Parse(text, CultureInfo.InvariantCulture) : null;
}
