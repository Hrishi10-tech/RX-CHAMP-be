namespace RXVision.Agent.Platform.Windows.Probes;

/// <summary>
/// Pure logic behind the Windows probes, kept free of any OS call so it can be unit
/// tested on any machine. The probes feed these the raw numbers and strings they
/// read from Win32.
/// </summary>
internal static class IdleMath
{
    /// <summary>
    /// Time since the last input, from two 32-bit tick counts (the value in
    /// <c>LASTINPUTINFO.dwTime</c> and the current <c>GetTickCount()</c>). Unsigned
    /// subtraction makes the 49.7-day wraparound come out right: when the counter has
    /// wrapped past the last-input stamp, <c>now - last</c> still yields the real gap.
    ///
    /// Windows documents that the stamp is not guaranteed to be incremental (the raw
    /// input thread runs apart from the desktop thread, and SendInput may supply its own
    /// time stamp), so it can land ahead of now. The unsigned gap then comes out near
    /// 49.7 days and would read as idle while someone is typing, so a gap of more than
    /// half the counter's range is read as a stamp from the future: input just now.
    /// </summary>
    public static TimeSpan Idle(uint lastInputTick, uint nowTick)
    {
        var deltaMs = unchecked(nowTick - lastInputTick);
        if (deltaMs > int.MaxValue) return TimeSpan.Zero;
        return TimeSpan.FromMilliseconds(deltaMs);
    }
}

internal static class SleepMath
{
    /// <summary>Gaps shorter than this are not reported: the samples either side already cover them.</summary>
    public static readonly TimeSpan MinReportable = TimeSpan.FromMinutes(1);

    /// <summary>
    /// How long the machine slept between two readings, or null when it did not (or
    /// not for a reportable minute). Sleep is the wall-time delta (which keeps running
    /// while suspended) minus the unbiased-interrupt delta (which does not). Both
    /// sources are monotonic, so this is immune to wall-clock changes: an NTP step or
    /// a manual clock change moves neither.
    /// </summary>
    /// <param name="prevWallMs">Previous <c>Environment.TickCount64</c> (ms).</param>
    /// <param name="prevUnbiased100ns">Previous <c>QueryUnbiasedInterruptTime</c> (100 ns units).</param>
    public static TimeSpan? Slept(long prevWallMs, ulong prevUnbiased100ns, long nowWallMs, ulong nowUnbiased100ns)
    {
        // Both counters only advance; a backwards step means a bad reading, not sleep.
        if (nowWallMs < prevWallMs || nowUnbiased100ns < prevUnbiased100ns) return null;
        var wall = TimeSpan.FromMilliseconds(nowWallMs - prevWallMs);
        var awake = TimeSpan.FromTicks((long)(nowUnbiased100ns - prevUnbiased100ns)); // 1 tick == 100 ns
        var slept = wall - awake;
        return slept >= MinReportable ? slept : null;
    }
}

internal static class HostNormalizer
{
    /// <summary>
    /// Turns an address-bar string into a bare host ("github.com"), or null. Returns
    /// the host only, never the path or query, so monitoring stays proportionate. A
    /// search term typed into the omnibox (spaces, no dot) is rejected rather than
    /// recorded as a site.
    /// </summary>
    public static string? Normalize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var text = raw.Trim();

        // A query typed into the omnibox, not a URL.
        if (text.Contains(' ') && !text.Contains('.')) return null;

        var candidate = text.Contains("://") ? text : "http://" + text;
        try
        {
            if (!Uri.TryCreate(candidate, UriKind.Absolute, out var uri)) return null;
            var host = uri.Host;
            if (string.IsNullOrEmpty(host)) return null;
            return host.StartsWith("www.", StringComparison.OrdinalIgnoreCase) ? host[4..] : host;
        }
        catch
        {
            return null;
        }
    }
}

/// <summary>
/// Which version this machine last handed to the installer, and when (the text of
/// update-attempt.txt: the version, then the time as round-trip UTC). The agent is only
/// offered a version it is not running, so being offered the same one again soon after
/// means it did not land: its build would not start here and was rolled back, or the
/// release is labelled with a higher version than the build inside. Running the
/// installer again would loop (download, swap, roll back, relaunch, and the relaunched
/// agent checks again a minute later), so the same version is held back for a day.
/// </summary>
internal static class UpdateAttempt
{
    public const string FileName = "update-attempt.txt";
    public static readonly TimeSpan RetryAfter = TimeSpan.FromHours(24);

    public static string Record(string version, DateTimeOffset at) =>
        version.Trim() + "\n" + at.UtcDateTime.ToString("O", System.Globalization.CultureInfo.InvariantCulture) + "\n";

    /// <summary>True when <paramref name="record"/> says this version was handed to the installer less than a day ago.</summary>
    public static bool RecentlyTried(string? record, string version, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(record) || string.IsNullOrWhiteSpace(version)) return false;
        var lines = record.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (lines.Length < 2 || !string.Equals(lines[0], version.Trim(), StringComparison.OrdinalIgnoreCase)) return false;
        if (!DateTimeOffset.TryParse(lines[1], System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.RoundtripKind, out var at)) return false;
        var age = now - at;
        return age >= TimeSpan.Zero && age < RetryAfter;
    }
}

internal static class AppName
{
    /// <summary>
    /// A readable app name from a process name when no file description is available:
    /// "chrome" becomes "Chrome". Used as the fallback; the real name comes from the
    /// exe's FileDescription.
    /// </summary>
    public static string? Prettify(string? processName)
    {
        if (string.IsNullOrWhiteSpace(processName)) return null;
        return char.ToUpperInvariant(processName[0]) + processName[1..];
    }
}
