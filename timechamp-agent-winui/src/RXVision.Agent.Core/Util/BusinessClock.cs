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
        if (!string.IsNullOrWhiteSpace(zone))
        {
            try { return TimeZoneInfo.FindSystemTimeZoneById(zone).GetUtcOffset(at); }
            catch { /* unknown on this machine (e.g. invariant globalization on Windows) */ }
        }
        return TimeZoneInfo.Local.GetUtcOffset(at);
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
