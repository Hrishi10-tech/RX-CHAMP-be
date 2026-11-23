using RXVision.Agent.Core;
using RXVision.Agent.Services;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>4.1 shared computer: the shift-end card and its answers.</summary>
public class ShiftHandoverToastTests
{
    [Fact]
    public void The_card_asks_about_the_next_shift_and_says_when_they_will_be_signed_out()
    {
        var agent = new FakeAgent();
        var end = agent.Now.AddMinutes(15);
        var yes = 0;
        var no = 0;
        var card = Toasts.ShiftQuestion(agent, new ShiftQuestion(end, end, Last: false), () => yes++, () => no++, () => { });

        // 3.6: no sticky toasts any more; the question still lasts its minute.
        Assert.Equal(TimeSpan.FromMinutes(1), card.Lifetime);
        Assert.True(card.KeepOnOpen);
        Assert.Contains("Are you extending your shift?", card.Title);
        Assert.Contains(agent.BusinessTime(end), card.Title);
        Assert.Contains("signed out at " + agent.BusinessTime(end), card.Body);
        Assert.Equal("Yes", card.PrimaryText);
        Assert.Equal("No", card.SecondaryText);
        card.OnPrimary!();
        card.OnSecondary!();
        Assert.Equal((1, 1), (yes, no));
    }

    [Fact]
    public void The_answers_are_said_back_in_one_line()
    {
        var agent = new FakeAgent();
        var end = agent.Now.AddMinutes(5);
        Assert.Contains("Tap End day when you finish", Toasts.ShiftAnswer(agent, true, end));
        Assert.Equal($"You'll be signed out at {agent.BusinessTime(end)}.", Toasts.ShiftAnswer(agent, false, end));
    }
}
