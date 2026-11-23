namespace RXVision.Agent.Icon;

/// <summary>
/// A break as the panel's ring draws it. The break's length always takes a quarter of the ring,
/// so a 15 minute break and a 45 minute lunch read the same way: full section, break used up;
/// fill past the section's closing gap, break run over. A break with no length fills at the
/// lunch's pace, with nothing to run past.
/// </summary>
/// <param name="LengthMin">The break's length in minutes; null for a break with no length.</param>
/// <param name="ElapsedMin">Minutes since it began.</param>
public sealed record BreakSpan(double? LengthMin, double ElapsedMin)
{
    /// <summary>The break's section on the ring, in degrees.</summary>
    public const double Section = 90;
    /// <summary>The small gaps that open and close the section, in degrees: about 5 px on the panel's ring.</summary>
    public const double Gap = 6;
    /// <summary>The ring's width on a break, half again the icon's, so the gaps read at 116 px.</summary>
    public const double Stroke = IconGeometry.RingStroke * 1.5;
    /// <summary>A break with no length: degrees a minute, the pace of a 45 minute lunch.</summary>
    public const double NoLengthPace = Section / 45;
    public const double HeldOpacity = 0.42;
    public const double SectionOpacity = 0.16;

    /// <summary>Where each piece goes, in degrees clockwise from the dot.</summary>
    public readonly record struct Pieces(double Held, double SectionStart, double SectionLength, double Fill, double OverStart, double Over);

    /// <summary>
    /// Lays the break after the held arc. When the day's arc leaves too little room, the held arc
    /// gives way (the number beside the ring still says the time); a very long run over stops a
    /// gap short of the dot.
    /// </summary>
    public Pieces Layout(double heldDegrees)
    {
        var held = Math.Clamp(heldDegrees, 0, 360);
        var room = 360 - Gap;
        var elapsed = Math.Max(0, ElapsedMin);
        if (LengthMin is not { } length || length <= 0)
        {
            var grown = Math.Min(elapsed * NoLengthPace, room - Gap);
            var from = Math.Min(held, room - Gap - grown);
            return new Pieces(from, from + Gap, 0, grown, 0, 0);
        }
        var used = elapsed / length * Section;
        var over = Math.Max(0, used - Section);
        var needed = Gap + Section + Gap + over;
        if (needed > room)
        {
            over = Math.Max(0, room - Gap - Section - Gap);
            needed = room;
        }
        var start = Math.Min(held, room - needed);
        var sectionStart = start + Gap;
        return new Pieces(start, sectionStart, Section, Math.Min(used, Section), sectionStart + Section + Gap, over);
    }
}
