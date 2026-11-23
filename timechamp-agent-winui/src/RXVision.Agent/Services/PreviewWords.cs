using System.Globalization;
using Avalonia.Media;
using RXVision.Agent.Core.Workday;

namespace RXVision.Agent.Services;

/// <summary>The status the avatar's live preview shows.</summary>
public enum PreviewStatus { NotStarted, Working, Meeting, OnBreak, BreakExtended, DayEnded }

/// <summary>How the preview draws a status and today's ring (AGENT.md section 1, States).</summary>
public sealed record PreviewLook(PreviewStatus Status, Color Dot, bool HollowDot, Color? Ring, double RingOpacity, double Sweep, string? Badge)
{
    public static readonly Color Green = Color.Parse("#34D27A");
    public static readonly Color Teal = Color.Parse("#6FC9B6");
    public static readonly Color Purple = Color.Parse("#A78BFA");
    public static readonly Color Amber = Color.Parse("#F2A93B");
    public static readonly Color Neutral = Color.Parse("#8A93A3");

    public static readonly PreviewLook Unknown = For(PreviewStatus.NotStarted, 0, PreviewWords.DefaultTargetSec);

    public static PreviewLook For(PreviewStatus status, int workedSec, int targetSec)
    {
        var target = targetSec > 0 ? targetSec : PreviewWords.DefaultTargetSec;
        var sweep = Math.Clamp(workedSec / (double)target, 0, 1);
        var reached = workedSec >= target;
        return status switch
        {
            PreviewStatus.Working => new PreviewLook(status, Green, false, reached ? Green : Teal, reached ? 0.95 : 0.90, sweep, null),
            PreviewStatus.Meeting => new PreviewLook(status, Purple, false, Purple, 0.90, sweep, null),
            PreviewStatus.OnBreak => new PreviewLook(status, Amber, false, reached ? Green : Teal, 0.36, sweep, null),
            PreviewStatus.BreakExtended => new PreviewLook(status, Amber, false, reached ? Green : Teal, 0.36, sweep, "!"),
            PreviewStatus.DayEnded => new PreviewLook(status, Neutral, true, Teal, 0.30, sweep, null),
            _ => new PreviewLook(status, Neutral, true, null, 0, 0, null),
        };
    }
}

/// <summary>The words under the preview, the same as the hover label's, in the deck's format (C-579 to C-584, C-001).</summary>
public static class PreviewWords
{
    /// <summary>A full circle when nothing says otherwise (D-21).</summary>
    public const int DefaultTargetSec = 8 * 3600;

    /// <summary>The status from the server's answer. At or past a break's end, the break is extended.</summary>
    public static PreviewStatus StatusOf(string status, DateTimeOffset? breakEndsAt, DateTimeOffset now) => status switch
    {
        DayProgressStatus.Working => PreviewStatus.Working,
        DayProgressStatus.Meeting => PreviewStatus.Meeting,
        DayProgressStatus.Break => breakEndsAt is { } ends && now >= ends ? PreviewStatus.BreakExtended : PreviewStatus.OnBreak,
        DayProgressStatus.Ended => PreviewStatus.DayEnded,
        _ => PreviewStatus.NotStarted,
    };

    /// <param name="sameDay">False once the date has moved on from an ended day: no "today".</param>
    public static string Label(PreviewStatus status, int workedSec, int targetSec, bool sameDay, TimeSpan extendedBy)
    {
        var target = targetSec > 0 ? targetSec : DefaultTargetSec;
        var word = status switch
        {
            PreviewStatus.Working => "Working",
            PreviewStatus.Meeting => "In a meeting",
            PreviewStatus.OnBreak => "On break",
            _ => "Not started",
        };
        switch (status)
        {
            case PreviewStatus.BreakExtended:
                return $"Break extended · {Timer(extendedBy)}";
            case PreviewStatus.DayEnded:
                return sameDay ? $"Day ended · {Worked(workedSec)} today" : $"Day ended · {Worked(workedSec)}";
            case PreviewStatus.NotStarted:
                return $"{word} · {Worked(workedSec)} of {Target(target)}";
            default:
                var over = workedSec - target;
                return over >= 60 ? $"{word} · {OverTarget(over)}" : $"{word} · {Worked(workedSec)} of {Target(target)}";
        }
    }

    /// <summary>"5h 12m", "3h 05m", "0h 00m".</summary>
    public static string Worked(int seconds)
    {
        var minutes = Math.Max(0, seconds) / 60;
        return $"{minutes / 60}h {minutes % 60:00}m";
    }

    /// <summary>"8h", or "7h 30m" for a shift that expects that.</summary>
    public static string Target(int seconds)
    {
        var minutes = seconds / 60;
        return minutes % 60 == 0 ? $"{minutes / 60}h" : $"{minutes / 60}h {minutes % 60:00}m";
    }

    /// <summary>"+15 min over target", "+1h 05m over target".</summary>
    public static string OverTarget(int seconds)
    {
        var minutes = seconds / 60;
        return minutes < 60 ? $"+{minutes} min over target" : $"+{minutes / 60}h {minutes % 60:00}m over target";
    }

    /// <summary>"04:32", then "1:04:32" past an hour.</summary>
    public static string Timer(TimeSpan span)
    {
        var total = span < TimeSpan.Zero ? TimeSpan.Zero : span;
        return total.TotalHours >= 1
            ? string.Create(CultureInfo.InvariantCulture, $"{(int)total.TotalHours}:{total.Minutes:00}:{total.Seconds:00}")
            : string.Create(CultureInfo.InvariantCulture, $"{total.Minutes:00}:{total.Seconds:00}");
    }
}
