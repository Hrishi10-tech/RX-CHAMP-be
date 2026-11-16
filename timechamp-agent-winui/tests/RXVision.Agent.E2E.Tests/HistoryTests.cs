using System.Globalization;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Services;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.E2E.Tests;

/// <summary>History for the month (scenario 5): the server's numbers, and a calendar change shown live.</summary>
public sealed class HistoryTests : E2ETest
{
    public HistoryTests(E2EFixture env, ITestOutputHelper output) : base(env, output) { }

    [Fact]
    public async Task History_shows_the_servers_month_and_follows_a_calendar_change_live()
    {
        if (Skipped()) return;
        var rig = await AgentForAsync("Pooja", "Shah", beforeSignIn: p => E2EFixture.StartDayEarlierAsync(p, TimeSpan.FromMinutes(30)));
        var server = await ServerViewAsync(rig.Person);
        var month = E2EEnv.Today[..7];

        // What the agent reads is what the server has.
        var (mine, fresh) = await rig.Agent.GetHistoryAsync(month);
        Assert.True(fresh, "History came from the server");
        var theirs = Read<HistoryMonth>((await server.GetAsync($"workday/me/history?month={month}")).Data);
        Assert.NotNull(mine);
        Assert.Equal(theirs.Month, mine!.Month);
        Assert.Equal(theirs.TargetSec, mine.TargetSec);
        Assert.Equal(theirs.WorkingDays, mine.WorkingDays);
        Assert.InRange(mine.FocusSec, theirs.FocusSec - 10, theirs.FocusSec + 10);
        Assert.True(mine.FocusSec > 25 * 60, $"half an hour of focus, got {mine.FocusSec} s");
        var today = mine.Days.Single(d => d.Date == E2EEnv.Today);
        var theirToday = theirs.Days.Single(d => d.Date == E2EEnv.Today);
        Assert.Equal(DayStatuses.InProgress, today.Status);
        Assert.Equal(theirToday.TargetSec, today.TargetSec);
        Assert.Equal(theirToday.StartedAt, today.StartedAt);
        Assert.Equal(theirs.Days.Select(d => (d.Date, d.IsWorkingDay)), mine.Days.Select(d => (d.Date, d.IsWorkingDay)));
        // 4.0: paid time (focus + paid breaks) for the month and each day; a live day has no offline time.
        Assert.NotNull(theirs.PaidSec);
        Assert.Equal(theirs.FocusSec + theirs.PaidBreakSec, theirs.PaidSec);
        Assert.NotNull(theirToday.PaidSec);
        Assert.Equal(theirToday.FocusSec + theirToday.PaidBreakSec, theirToday.PaidSec);
        Assert.Equal(0, theirs.UnverifiedSec);
        Assert.Equal(0, theirToday.UnverifiedSec);
        Assert.InRange(mine.Paid, theirs.Paid - 10, theirs.Paid + 10);

        // The History page: focus against the month's target, in the person's words.
        await rig.Ui.RunAsync(() => rig.Dashboard.ShowHistoryCommand.ExecuteAsync(null));
        var page = rig.Dashboard.History;
        Assert.True(page.HasData, page.Problem);
        Assert.Equal($"of {Fmt.Hours(theirs.TargetSec)}", page.TargetText);
        Assert.Equal(theirs.WorkingDays.ToString(CultureInfo.InvariantCulture), page.Chips.Single(c => c.Label == "Working days").Value);
        var row = page.Days.First();
        Assert.True(row.IsToday);
        Assert.Matches(@"^\d+h \d{2}m$|^\d+m$", page.Chips.Single(c => c.Label == "Paid time").Value);
        Assert.StartsWith("Paid time ", row.PaidText);
        Assert.Null(row.UnverifiedText);
        Assert.False(page.HasUnverified);
        Say($"History: {page.FocusText} {page.TargetText} · {page.TrackText} · today {row.Times} · {row.FocusText} of {row.TargetText}");
        Assert.Matches(@"\d{1,2}:\d{2} (AM|PM)", row.Times!);

        // The Admin makes a later working day of this month a holiday: the page follows by itself.
        var calendar = (await Env.Admin.GetAsync($"calendar?year={month[..4]}")).Data;
        var holiday = NextWorkingDayThisMonth(theirs);
        if (holiday is null)
        {
            Say("no later working day this month: the calendar change is not checked today");
            return;
        }
        Say($"making {holiday} a holiday (calendar answered {calendar.ValueKind})");
        var historyEvents = rig.Events.Count(e => e.EndsWith(":history", StringComparison.Ordinal));
        try
        {
            var set = await Env.Admin.PutAsync($"calendar/days/{holiday}", new { isWorking = false, label = "E2E holiday" });
            Assert.True(set.Ok, set.ToString());
            await E2EEnv.WaitFor(() => rig.Events.Count(e => e.EndsWith(":history", StringComparison.Ordinal)) > historyEvents,
                TimeSpan.FromSeconds(20), "the agent told of the calendar change (config:changed)");
            await E2EEnv.WaitFor(() => page.Chips.Single(c => c.Label == "Working days").Value == (theirs.WorkingDays - 1).ToString(CultureInfo.InvariantCulture),
                TimeSpan.FromSeconds(20), "History showing one working day less");
            var after = Read<HistoryMonth>((await server.GetAsync($"workday/me/history?month={month}")).Data);
            Assert.Equal(theirs.WorkingDays - 1, after.WorkingDays);
            Assert.Equal($"of {Fmt.Hours(after.TargetSec)}", page.TargetText);
            Assert.True(after.TargetSec < theirs.TargetSec, $"target {after.TargetSec} after, {theirs.TargetSec} before");
            var flipped = after.Days.Single(d => d.Date == holiday);
            Assert.False(flipped.IsWorkingDay);
            Assert.Equal("E2E holiday", flipped.Label);
            Say($"after the holiday: {page.TargetText}, working days {page.Chips.Single(c => c.Label == "Working days").Value}");
        }
        finally
        {
            await Env.Admin.DeleteAsync($"calendar/days/{holiday}");
        }
        await E2EEnv.WaitFor(() => page.Chips.Single(c => c.Label == "Working days").Value == theirs.WorkingDays.ToString(CultureInfo.InvariantCulture),
            TimeSpan.FromSeconds(20), "History back to the week pattern");
    }

    /// <summary>A working day after today in this month, or null.</summary>
    private static string? NextWorkingDayThisMonth(HistoryMonth h) =>
        h.Days.Where(d => d.IsWorkingDay && string.CompareOrdinal(d.Date, E2EEnv.Today) > 0).Select(d => d.Date).FirstOrDefault();
}
