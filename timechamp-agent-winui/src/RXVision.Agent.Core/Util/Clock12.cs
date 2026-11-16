using System.Globalization;

namespace RXVision.Agent.Core.Util;

/// <summary>
/// Times as people read them (4.0, SPEC 2.10): "9:05 AM", "12:30 PM". Wire formats
/// stay ISO, and shift times on the wire stay "HH:MM" 24-hour: they are turned into
/// 12-hour text here, only for display. Invariant culture (the app runs with
/// invariant globalization), so AM and PM never depend on the machine.
/// </summary>
public static class Clock12
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>The display format: hour without a leading zero, minutes, AM or PM.</summary>
    public const string Pattern = "h:mm tt";

    /// <summary>"9:05 AM" for the clock time of <paramref name="instant"/> in its own offset.</summary>
    public static string Format(DateTimeOffset instant) => instant.ToString(Pattern, Inv);

    /// <summary>"9:05 AM" for a time of day.</summary>
    public static string Format(TimeSpan timeOfDay)
    {
        var t = timeOfDay;
        if (t < TimeSpan.Zero || t >= TimeSpan.FromDays(1)) t = TimeSpan.FromTicks(((t.Ticks % TimeSpan.TicksPerDay) + TimeSpan.TicksPerDay) % TimeSpan.TicksPerDay);
        return DateTime.Today.Add(t).ToString(Pattern, Inv);
    }

    /// <summary>
    /// A server "HH:MM" (or "H:MM", "HH:MM:SS") 24-hour string as "9:05 AM". Anything
    /// that is not such a time comes back as it was (never an exception on screen).
    /// </summary>
    public static string FromHm(string? hm)
    {
        if (string.IsNullOrWhiteSpace(hm)) return hm ?? "";
        var text = hm.Trim();
        if (TryParseHm(text, out var t)) return Format(t);
        return text;
    }

    /// <summary>Reads "HH:MM" or "HH:MM:SS" (24-hour; "24:00" is midnight).</summary>
    public static bool TryParseHm(string? hm, out TimeSpan time)
    {
        time = default;
        if (string.IsNullOrWhiteSpace(hm)) return false;
        var parts = hm.Trim().Split(':');
        if (parts.Length is < 2 or > 3) return false;
        if (!int.TryParse(parts[0], NumberStyles.None, Inv, out var h) || !int.TryParse(parts[1], NumberStyles.None, Inv, out var m)) return false;
        var s = 0;
        if (parts.Length == 3 && !int.TryParse(parts[2], NumberStyles.None, Inv, out s)) return false;
        if (h is < 0 or > 24 || m is < 0 or > 59 || s is < 0 or > 59 || (h == 24 && (m > 0 || s > 0))) return false;
        time = new TimeSpan(h % 24, m, s);
        return true;
    }

    /// <summary>"9:30 AM - 6:30 PM" from a shift's "09:30" and "18:30".</summary>
    public static string Range(string? start, string? end) => $"{FromHm(start)} - {FromHm(end)}";
}
