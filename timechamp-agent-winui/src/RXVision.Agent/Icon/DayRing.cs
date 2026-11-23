namespace RXVision.Agent.Icon;

/// <summary>One break on the panel's ring.</summary>
/// <param name="Start">When its section begins: the actual start once taken or running, else the scheduled one.</param>
/// <param name="LengthMin">Its length; 0 for a break with no length, which draws no section.</param>
/// <param name="TakenFrom">When it was taken or began, or null while it waits.</param>
/// <param name="TakenTo">When it ended; null while it runs.</param>
/// <param name="Next">The next one to come: its section shows brighter.</param>
public sealed record DayRingBreak(DateTimeOffset Start, int LengthMin, DateTimeOffset? TakenFrom = null, DateTimeOffset? TakenTo = null, bool Next = false);

/// <summary>
/// The panel's ring as the shift's clock: the dot is the shift's start and a full turn its end.
/// Each break is a small section at its time, marked off by thin dark notches, so a break coming
/// up shows ahead of the fill. The fill runs green with work and amber through a break; amber past
/// a section's closing notch is a break run over. The floating icon keeps its focus ring
/// (AGENT.md section 1); this is the panel's only.
/// </summary>
/// <param name="WorkFrom">When the day started, or null before it does.</param>
/// <param name="WorkTo">When the day ended, or null while it runs.</param>
public sealed record DayRing(DateTimeOffset ShiftStart, DateTimeOffset ShiftEnd, DateTimeOffset Now,
    DateTimeOffset? WorkFrom, DateTimeOffset? WorkTo, IReadOnlyList<DayRingBreak> Breaks)
{
    /// <summary>The thin dark notch at each end of a section, in the icon's units (about 1.4 px on the panel).</summary>
    public const double Notch = 1.2;
    /// <summary>The ring's width here, half again the icon's, so the sections read at 64 px.</summary>
    public const double Stroke = IconGeometry.RingStroke * 1.5;
    public const double SectionOpacity = 0.24;
    public const double NextOpacity = 0.55;
    public const double TakenOpacity = 0.8;

    public enum Kind { Track, Section, NextSection, Work, Break, BreakNow }

    /// <summary>An arc to draw, in degrees clockwise from the dot.</summary>
    public readonly record struct Arc(Kind Kind, double From, double Length);

    public double Degrees(DateTimeOffset at)
    {
        var span = (ShiftEnd - ShiftStart).TotalMinutes;
        return span <= 0 ? 0 : Math.Clamp((at - ShiftStart).TotalMinutes / span, 0, 1) * 360;
    }

    /// <summary>Where the notches go, in degrees: each section's start and end. The fill runs under them.</summary>
    public IReadOnlyList<double> Notches() => Breaks.Where(b => b.LengthMin > 0)
        .SelectMany(b => new[] { Degrees(b.Start), Degrees(b.Start.AddMinutes(b.LengthMin)) }).ToList();

    /// <summary>Everything to draw, bottom to top; the notches go on top of all of it.</summary>
    public IReadOnlyList<Arc> Arcs()
    {
        var arcs = new List<Arc>();
        void Add(Kind kind, double from, double to)
        {
            if (to - from > 0.01) arcs.Add(new Arc(kind, from, to - from));
        }

        Add(Kind.Track, 0, 360);
        foreach (var b in Breaks.Where(b => b.LengthMin > 0))
            Add(b.Next ? Kind.NextSection : Kind.Section, Degrees(b.Start), Degrees(b.Start.AddMinutes(b.LengthMin)));

        if (WorkFrom is not { } from) return arcs;
        var end = WorkTo is { } to && to < Now ? to : Now;
        // Work is the day so far less the breaks in it.
        var breaks = Breaks.Where(b => b.TakenFrom is not null)
            .Select(b => (From: b.TakenFrom!.Value, To: b.TakenTo ?? end, Now: b.TakenTo is null))
            .OrderBy(b => b.From).ToList();
        var cursor = from;
        foreach (var b in breaks)
        {
            if (b.From > cursor) Add(Kind.Work, Degrees(cursor), Degrees(b.From < end ? b.From : end));
            if (b.To > cursor) cursor = b.To;
        }
        if (end > cursor) Add(Kind.Work, Degrees(cursor), Degrees(end));
        foreach (var b in breaks)
            Add(b.Now ? Kind.BreakNow : Kind.Break, Degrees(b.From), Degrees(b.To < end ? b.To : end));
        return arcs;
    }
}
