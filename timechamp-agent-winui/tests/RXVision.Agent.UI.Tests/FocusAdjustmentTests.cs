using RXVision.Agent.ViewModels;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>3.3: focus time a Super Manager changed by hand shows as its own pill under Today.</summary>
public class FocusAdjustmentTests
{
    [Theory]
    [InlineData(1800, "+30 min adjusted")]
    [InlineData(-900, "−15 min adjusted")]
    [InlineData(20, "+1 min adjusted")]
    public void An_adjustment_reads_as_minutes(int seconds, string expected) =>
        Assert.Equal(expected + " by the Super Manager", TodayViewModel.AdjustedLine(seconds));

    [Fact]
    public void No_adjustment_shows_nothing() =>
        Assert.Null(TodayViewModel.AdjustedLine(0));

    [Fact]
    public void The_pill_follows_the_focus_update()
    {
        var today = new TodayViewModel();
        today.UpdateFocus(3600, "Running", null, 0, 0, 27000, adjustedSec: 1800);
        Assert.True(today.HasAdjusted);
        Assert.Equal("+30 min adjusted by the Super Manager", today.AdjustedText);

        today.UpdateFocus(3600, "Running", null, 0, 0, 27000);
        Assert.False(today.HasAdjusted);
    }
}
