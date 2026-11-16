using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Util;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>4.0: every time a person reads is "h:mm AM/PM" (SPEC 2.10); wire formats stay as they are.</summary>
public class Clock12Tests
{
    [Theory]
    [InlineData("09:05", "9:05 AM")]
    [InlineData("9:05", "9:05 AM")]
    [InlineData("00:00", "12:00 AM")]
    [InlineData("00:30", "12:30 AM")]
    [InlineData("12:00", "12:00 PM")]
    [InlineData("12:30", "12:30 PM")]
    [InlineData("13:00", "1:00 PM")]
    [InlineData("18:30", "6:30 PM")]
    [InlineData("23:59", "11:59 PM")]
    [InlineData("24:00", "12:00 AM")]
    [InlineData("07:45:30", "7:45 AM")]
    public void Server_hh_mm_reads_as_12_hour(string wire, string shown) => Assert.Equal(shown, Clock12.FromHm(wire));

    [Theory]
    [InlineData("")]
    [InlineData("soon")]
    [InlineData("25:00")]
    [InlineData("10:75")]
    [InlineData("-1:00")]
    public void Anything_else_is_left_as_it_came(string text) => Assert.Equal(text, Clock12.FromHm(text));

    [Fact]
    public void Instants_read_in_their_own_offset_with_AM_or_PM()
    {
        var ist = TimeSpan.FromHours(5.5);
        Assert.Equal("9:05 AM", Clock12.Format(new DateTimeOffset(2026, 10, 13, 9, 5, 0, ist)));
        Assert.Equal("12:30 PM", Clock12.Format(new DateTimeOffset(2026, 10, 13, 12, 30, 0, ist)));
        Assert.Equal("12:00 AM", Clock12.Format(new DateTimeOffset(2026, 10, 13, 0, 0, 0, ist)));
        Assert.Equal("11:59 PM", Clock12.Format(new DateTimeOffset(2026, 10, 13, 23, 59, 59, ist)));
        Assert.Equal("3:30 AM", Clock12.Format(new DateTimeOffset(2026, 10, 13, 9, 0, 0, ist).ToOffset(TimeSpan.Zero)));
        Assert.Equal("6:30 PM", Clock12.Format(TimeSpan.FromHours(18.5)));
        Assert.Equal("9:30 AM - 6:30 PM", Clock12.Range("09:30", "18:30"));
    }

    [Fact]
    public void The_break_panel_shows_slot_and_shift_times_in_12_hour()
    {
        var at = new DateTimeOffset(2026, 10, 13, 13, 0, 0, TimeSpan.FromHours(5.5)).ToUniversalTime();
        var day = new BreakDay
        {
            Date = "2026-10-13", Mode = "SCHEDULED", Workday = true,
            Shift = new ShiftInfo { Name = "General", Start = "09:30", End = "18:30" },
            Breaks =
            {
                new BreakSlot
                {
                    Kind = BreakKinds.Lunch, Label = "Lunch break", PresenceType = "LUNCH", DurationMin = 30,
                    ScheduledStart = at, ScheduledEnd = at.AddMinutes(30), WindowOpen = at.AddMinutes(-30), WindowClose = at.AddMinutes(60),
                    RingStart = at.AddMinutes(-1), RingEnd = at.AddMinutes(4),
                    Local = new BreakLocalTimes { Start = "13:00", End = "13:30", WindowOpen = "12:30", WindowClose = "14:00" },
                },
            },
        };
        var panel = BreakSchedule.Compute(day, at.AddHours(-2));
        Assert.Equal("9:30 AM - 6:30 PM", panel.ShiftHours);
        var slot = Assert.Single(panel.Slots);
        Assert.Equal("1:00 PM", slot.LocalStart);
        Assert.Equal("1:30 PM", slot.LocalEnd);
        Assert.Equal("12:30 PM", slot.LocalWindowOpen);
        Assert.Equal("2:00 PM", slot.LocalWindowClose);
        // Countdowns keep their minutes and seconds.
        Assert.Equal("15:00", BreakSchedule.FormatSigned(TimeSpan.FromMinutes(15)));
    }
}
