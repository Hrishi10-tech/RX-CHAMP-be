using System.Globalization;

namespace RXVision.Agent.Services;

/// <summary>Formatting shared by every screen: 12-hour clock ("9:05 AM"), short durations, plain words.</summary>
public static class Fmt
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>A server "HH:MM" (a shift's start or end) as "9:30 AM".</summary>
    public static string Hm12(string? hm) => Core.Util.Clock12.FromHm(hm);

    /// <summary>"0m", "15m", "1h 05m", to the nearest minute (so a 36-second break reads "1m", as its row does).</summary>
    public static string Duration(int seconds)
    {
        var minutes = RoundMinutes(seconds);
        return minutes >= 60 ? $"{minutes / 60}h {minutes % 60:00}m" : $"{minutes}m";
    }

    /// <summary>"2h 00m", hours always shown, whole minutes down: how long a meeting has run (C-628).</summary>
    public static string HoursMinutes(TimeSpan elapsed)
    {
        var minutes = (int)Math.Max(0, Math.Floor(elapsed.TotalMinutes));
        return $"{minutes / 60}h {minutes % 60:00}m";
    }

    /// <summary>Like <see cref="Duration"/>, but some time never reads "0m": under a minute is "1m".</summary>
    public static string SomeDuration(int seconds) => Duration(seconds > 0 ? Math.Max(seconds, 60) : 0);

    /// <summary>"0 m", "25 m", "1 h 05 m" (the allowance line), to the nearest minute.</summary>
    public static string Spaced(int seconds)
    {
        var minutes = RoundMinutes(seconds);
        return minutes >= 60 ? $"{minutes / 60} h {minutes % 60:00} m" : $"{minutes} m";
    }

    /// <summary>Seconds to whole minutes, half a minute and up rounding up.</summary>
    public static int RoundMinutes(int seconds) =>
        (int)Math.Round(Math.Max(0, seconds) / 60.0, MidpointRounding.AwayFromZero);

    /// <summary>"4m 05s" for a running session, "1h 02m" past an hour.</summary>
    public static string Running(TimeSpan elapsed)
    {
        if (elapsed < TimeSpan.Zero) elapsed = TimeSpan.Zero;
        return elapsed.TotalHours >= 1
            ? $"{(int)elapsed.TotalHours}h {elapsed.Minutes:00}m"
            : $"{(int)elapsed.TotalMinutes}m {elapsed.Seconds:00}s";
    }

    /// <summary>A running timer: "12:04", "1:02:03" past an hour.</summary>
    public static string Clock(TimeSpan elapsed) => Core.Breaks.BreakSchedule.Format(elapsed);

    /// <summary>"1 min", "12 min".</summary>
    public static string Minutes(int minutes) => $"{minutes} min";

    /// <summary>
    /// A finished break's length or overrun, counted like a timer (whole minutes,
    /// rounded down) exactly as the portal shows it: "under 1 min", "19 min",
    /// "1 h 5 min". So the agent and the portal never disagree about a record.
    /// </summary>
    public static string Timer(int seconds)
    {
        if (seconds <= 0) return "0 min";
        if (seconds < 60) return "under 1 min";
        var minutes = seconds / 60;
        if (minutes < 60) return $"{minutes} min";
        return minutes % 60 == 0 ? $"{minutes / 60} h" : $"{minutes / 60} h {minutes % 60} min";
    }

    /// <summary>The minus sign people read ("−15 min"), never a hyphen.</summary>
    public const string Minus = "−";

    /// <summary>"+15 min".</summary>
    public static string PlusMinutes(int minutes) => $"+{Math.Max(0, minutes)} min";

    /// <summary>"−15 min".</summary>
    public static string MinusMinutes(int minutes) => $"{Minus}{Math.Max(0, minutes)} min";

    /// <summary>Seconds to the minutes an approval line shows: rounded, and at least 1 when there is any time at all.</summary>
    public static int EffectMinutes(int seconds) => seconds <= 0 ? 0 : Math.Max(1, RoundMinutes(seconds));

    /// <summary>
    /// Focus time: "45m", "4h 05m". Whole minutes rounded down, so it never shows a
    /// minute that has not been worked yet.
    /// </summary>
    public static string Focus(int seconds)
    {
        var minutes = Math.Max(0, seconds) / 60;
        return minutes >= 60 ? $"{minutes / 60}h {minutes % 60:00}m" : $"{minutes}m";
    }

    /// <summary>The ring's time: "0h 00m", "5h 12m". Whole minutes rounded down, as <see cref="Focus"/>.</summary>
    public static string HoursMinutes(int seconds)
    {
        var minutes = Math.Max(0, seconds) / 60;
        return $"{minutes / 60}h {minutes % 60:00}m";
    }

    /// <summary>"Tue 13 Oct" from the server's "2026-10-13"; the text as it came when it is not a date.</summary>
    public static string DayLabel(string? isoDate) =>
        DateTime.TryParseExact(isoDate, "yyyy-MM-dd", Inv, DateTimeStyles.None, out var d) ? d.ToString("ddd d MMM", Inv) : isoDate ?? "";

    /// <summary>A length in hours for "8h day": "8h", "7h 30m".</summary>
    public static string Hours(int seconds)
    {
        var minutes = RoundMinutes(seconds);
        if (minutes < 60) return $"{minutes}m";
        return minutes % 60 == 0 ? $"{minutes / 60}h" : $"{minutes / 60}h {minutes % 60:00}m";
    }

    /// <summary>"Good morning" before noon, "Good afternoon" before 5 PM, then "Good evening".</summary>
    /// <param name="hour">The hour of the day (0 to 23) in the business time zone.</param>
    public static string Greeting(int hour) =>
        hour is < 0 or > 23 ? "Good morning" : hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

    /// <summary>The greeting for an instant already at the business time zone's offset.</summary>
    public static string Greeting(DateTimeOffset businessLocal) => Greeting(businessLocal.Hour);

    /// <summary>"Asha" from "Asha Kumar"; the email's name part when that is all there is.</summary>
    public static string FirstName(string? name)
    {
        var text = (name ?? "").Trim();
        if (text.Length == 0) return "";
        if (text.Contains('@')) text = text[..text.IndexOf('@')];
        var first = text.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? text;
        return first.Length == 0 ? "" : char.ToUpperInvariant(first[0]) + first[1..];
    }

    /// <summary>"1 approval", "3 approvals".</summary>
    public static string Count(int count, string one, string many) => count == 1 ? $"1 {one}" : $"{count} {many}";

    /// <summary>Days of leave as a number: "10.5", "12", "−1".</summary>
    public static string Days(double days)
    {
        var text = Math.Abs(days).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
        return days < 0 ? Minus + text : text;
    }

    /// <summary>"1 day", "2.5 days".</summary>
    public static string DaysWord(double days) => $"{Days(days)} {(Math.Abs(days) == 1 ? "day" : "days")}";

    /// <summary>"Morning break" becomes "morning break" in the middle of a sentence.</summary>
    public static string Lower(string label) =>
        string.IsNullOrEmpty(label) ? label : char.ToLowerInvariant(label[0]) + label[1..];

    /// <summary>
    /// A chat timestamp: "2:05 PM" today, "12 Oct, 2:05 PM" before. Both instants already at
    /// the zone to show (the business time zone: <see cref="IAgent.BusinessLocal"/>).
    /// </summary>
    public static string ChatStamp(DateTimeOffset at, DateTimeOffset now) =>
        at.Date == now.ToOffset(at.Offset).Date
            ? Core.Util.Clock12.Format(at)
            : at.ToString("d MMM, ", Inv) + Core.Util.Clock12.Format(at);
}
