using System.Globalization;
using RXVision.Agent.Core.Api;

namespace RXVision.Agent.Core.Util;

/// <summary>
/// The business time zone (the one the schedule's times are in), worked out from the
/// day itself so it is right on any machine and needs no time-zone database: a slot's
/// local "HH:MM" start against its instant. A day without slots falls back to the zone
/// by name (from the break day or the work day), then to this machine's zone.
/// </summary>
public static class BusinessClock
{
    public static TimeSpan Offset(BreakDay? breaks, WorkdayToday? workday, DateTimeOffset at)
    {
        if (breaks is not null)
        {
            foreach (var slot in breaks.Breaks)
            {
                if (!Clock12.TryParseHm(slot.Local.Start, out var local) || slot.ScheduledStart == default) continue;
                var diff = local - slot.ScheduledStart.UtcDateTime.TimeOfDay;
                while (diff <= TimeSpan.FromHours(-12)) diff += TimeSpan.FromHours(24);
                while (diff > TimeSpan.FromHours(14)) diff -= TimeSpan.FromHours(24);
                var quarters = Math.Round(diff.TotalMinutes / 15);
                return TimeSpan.FromMinutes(quarters * 15);
            }
        }
        var zone = !string.IsNullOrWhiteSpace(breaks?.Timezone) ? breaks!.Timezone : workday?.Timezone;
        if (!string.IsNullOrWhiteSpace(zone) && ZoneOffset(zone!, at) is { } offset) return offset;
        return TimeZoneInfo.Local.GetUtcOffset(at);
    }

    // Core review C-R03: the Windows build runs with invariant globalization, so the machine
    // cannot turn an IANA id ("Asia/Kolkata") into its own zone and the lookup throws. These
    // zones never change their clocks, so their offset is known without a database.
    private static readonly Dictionary<string, TimeSpan> FixedZones = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Asia/Kolkata"] = new(5, 30, 0), ["Asia/Calcutta"] = new(5, 30, 0), ["Asia/Colombo"] = new(5, 30, 0),
        ["Asia/Kathmandu"] = new(5, 45, 0), ["Asia/Dhaka"] = new(6, 0, 0), ["Asia/Karachi"] = new(5, 0, 0),
        ["Asia/Dubai"] = new(4, 0, 0), ["Asia/Singapore"] = new(8, 0, 0), ["Asia/Manila"] = new(8, 0, 0),
        ["Asia/Shanghai"] = new(8, 0, 0), ["Asia/Tokyo"] = new(9, 0, 0), ["Pacific/Honolulu"] = new(-10, 0, 0),
        ["UTC"] = TimeSpan.Zero, ["Etc/UTC"] = TimeSpan.Zero, ["GMT"] = TimeSpan.Zero,
    };

    // Zones with summer time: the Windows name, which the Windows database knows without ICU.
    private static readonly Dictionary<string, string> WindowsNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["America/New_York"] = "Eastern Standard Time", ["America/Chicago"] = "Central Standard Time",
        ["America/Denver"] = "Mountain Standard Time", ["America/Los_Angeles"] = "Pacific Standard Time",
        ["Europe/London"] = "GMT Standard Time", ["Europe/Berlin"] = "W. Europe Standard Time",
        ["Europe/Paris"] = "Romance Standard Time", ["Australia/Sydney"] = "AUS Eastern Standard Time",
    };

    /// <summary>
    /// The zone's offset at <paramref name="at"/>, or null when nothing here knows the zone.
    /// <paramref name="find"/> is the machine's zone database (tests pass a Windows-like one).
    /// </summary>
    internal static TimeSpan? ZoneOffset(string zone, DateTimeOffset at, Func<string, TimeZoneInfo>? find = null)
    {
        find ??= TimeZoneInfo.FindSystemTimeZoneById;
        try { return find(zone).GetUtcOffset(at); }
        catch { /* unknown on this machine (invariant globalization on Windows) */ }
        if (FixedZones.TryGetValue(zone, out var fixedOffset)) return fixedOffset;
        if (WindowsNames.TryGetValue(zone, out var windows))
        {
            try { return find(windows).GetUtcOffset(at); }
            catch { /* not a Windows machine either */ }
        }
        return null;
    }

    /// <summary>"yyyy-MM-dd" of an instant in the business time zone.</summary>
    public static string Date(DateTimeOffset at, TimeSpan offset) =>
        at.ToOffset(offset).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>Whole days from one "yyyy-MM-dd" to another (0 when either is not a date).</summary>
    public static int DaysBetween(string? from, string? to)
    {
        if (!DateTime.TryParseExact(from, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var a)) return 0;
        if (!DateTime.TryParseExact(to, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var b)) return 0;
        return (int)Math.Round((b - a).TotalDays);
    }
}
