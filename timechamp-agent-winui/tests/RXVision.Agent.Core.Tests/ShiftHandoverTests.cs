using RXVision.Agent.Core.Workday;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>4.1 shared computer: the shift-end question and the automatic sign-out.</summary>
public class ShiftHandoverTests
{
    private static readonly DateTimeOffset End = new(2026, 11, 16, 8, 30, 0, TimeSpan.Zero); // 2:00 PM IST
    private static DateTimeOffset At(int minutesFromEnd) => End.AddMinutes(minutesFromEnd);

    private static HandoverStep Step(ShiftHandover h, int minutesFromEnd, bool shared = true, bool extended = false, bool running = true) =>
        h.Next(At(minutesFromEnd), shared, End, extended, running);

    [Fact]
    public void Asks_15_and_5_minutes_before_then_signs_out_at_the_shift_end_without_an_answer()
    {
        var h = new ShiftHandover();
        Assert.Equal(HandoverStep.None, Step(h, -16));
        Assert.Equal(HandoverStep.Ask, Step(h, -15));
        Assert.Equal(HandoverStep.None, Step(h, -10));
        Assert.Equal(HandoverStep.AskLast, Step(h, -5));
        Assert.Equal(HandoverStep.None, Step(h, -1));
        Assert.Equal(End, h.Deadline);
        Assert.Equal(HandoverStep.SignOut, Step(h, 0));
        // Still due until it has happened (offline: tried again).
        Assert.Equal(HandoverStep.SignOut, Step(h, 1));
    }

    [Fact]
    public void Yes_stops_the_questions_and_the_sign_out_for_the_day()
    {
        var h = new ShiftHandover();
        Assert.Equal(HandoverStep.Ask, Step(h, -15));
        h.Continue();
        Assert.Equal(HandoverStep.None, Step(h, -5));
        Assert.Equal(HandoverStep.None, Step(h, 0));
        Assert.Equal(HandoverStep.None, Step(h, 240));
    }

    [Fact]
    public void A_day_the_server_knows_is_extended_is_never_asked_about()
    {
        var h = new ShiftHandover();
        Assert.Equal(HandoverStep.None, Step(h, -15, extended: true));
        Assert.Equal(HandoverStep.None, Step(h, 0, extended: true));
    }

    [Fact]
    public void No_waits_quietly_for_the_shift_end()
    {
        var h = new ShiftHandover();
        Assert.Equal(HandoverStep.Ask, Step(h, -15));
        h.Decline();
        Assert.Equal(HandoverStep.None, Step(h, -5));
        Assert.Equal(HandoverStep.SignOut, Step(h, 0));
    }

    [Fact]
    public void Never_signs_out_without_asking_first()
    {
        // The computer was off for both questions: it asks at the shift end, then gives five minutes.
        var h = new ShiftHandover();
        Assert.Equal(HandoverStep.AskLast, Step(h, 2));
        Assert.Equal(At(7), h.Deadline);
        Assert.Equal(HandoverStep.None, Step(h, 6));
        Assert.Equal(HandoverStep.SignOut, Step(h, 7));
    }

    [Fact]
    public void Nothing_happens_when_the_department_does_not_share_a_computer_or_there_is_no_shift()
    {
        var h = new ShiftHandover();
        Assert.Equal(HandoverStep.None, Step(h, -15, shared: false));
        Assert.Equal(HandoverStep.None, Step(h, 0, shared: false));
        Assert.Equal(HandoverStep.None, h.Next(At(0), true, null, false, true));
    }

    [Fact]
    public void Ending_the_day_on_a_shared_computer_signs_out_even_though_the_day_is_no_longer_running()
    {
        var h = new ShiftHandover();
        Assert.Equal(HandoverStep.None, Step(h, -60, running: false));
        h.SignOutNow();
        Assert.Equal(HandoverStep.SignOut, Step(h, -60, running: false));
        h.Reset();
        Assert.Equal(HandoverStep.None, Step(h, -60, running: false));
    }

    [Fact]
    public void A_new_shift_end_starts_over()
    {
        var h = new ShiftHandover();
        Assert.Equal(HandoverStep.Ask, Step(h, -15));
        h.Continue();
        var tomorrow = End.AddDays(1);
        Assert.Equal(HandoverStep.Ask, h.Next(tomorrow.AddMinutes(-15), true, tomorrow, false, true));
    }
}
