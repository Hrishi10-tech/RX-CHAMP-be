using Avalonia.Headless.XUnit;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// Paid time and offline evidence (SPEC 2.4): "Paid time" (focus + paid breaks) beside the
/// paid-break line in Today and in History (month and each day); "Offline, no activity data"
/// only when there is some, with what it means.
/// </summary>
public class PaidTimeTests
{
    private const string Why = "Time recorded offline counts once the app's activity data for it arrives";

    private static (DashboardViewModel Vm, FakeAgent Agent) Dashboard(string now, Action<FakeAgent>? setup = null)
    {
        var agent = new FakeAgent(now);
        setup?.Invoke(agent);
        var vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), NullLog.Instance);
        vm.Refresh();
        return (vm, agent);
    }

    /// <summary>A morning break of 14 min and a 35 min lunch (30 scheduled): 49 min of paid breaks.</summary>
    private static void TwoBreaks(FakeAgent a) =>
        a.Day = Days.General()
            .WithRecord(Days.Taken("MORNING", "11:00", "11:14"))
            .WithRecord(Days.Taken("LUNCH", "13:00", "13:35", duration: 30));

    [Fact]
    public void Today_paid_time_is_focus_plus_the_paid_breaks_beside_it()
    {
        var (vm, agent) = Dashboard("15:00", a =>
        {
            TwoBreaks(a);
            a.FocusOverride = 4 * 3600 + 10 * 60 + 40;
        });
        Assert.Equal("Paid breaks 49 m of 1 h 10 m · unpaid 0 m", vm.Today.AllowanceText);
        Assert.Equal("4h 10m", vm.Today.FocusText);
        Assert.True(vm.Today.HasPaidTime);
        Assert.Equal("4h 59m", vm.Today.PaidTimeText);   // 4 h 10 m 40 s + 49 m, whole minutes down like focus
        Assert.False(vm.Today.HasUnverified);
        Assert.Null(vm.Today.UnverifiedText);

        // It ticks with focus time.
        agent.FocusOverride += 2 * 60;
        vm.Refresh();
        Assert.Equal("5h 01m", vm.Today.PaidTimeText);
    }

    [Fact]
    public void Unpaid_break_time_is_not_paid_time()
    {
        var (vm, agent) = Dashboard("15:00", a =>
        {
            TwoBreaks(a);
            a.FocusOverride = 3 * 3600;
        });
        // A 15 min quick break: 5 min of the buffer is left, the other 10 are unpaid.
        agent.Day!.Quick.Add(new QuickBreakView
        {
            Id = "q-1", StartedAt = Ist.At("14:00").ToUniversalTime(), EndedAt = Ist.At("14:15").ToUniversalTime(), PlannedMin = 15, TakenSec = 15 * 60,
        });
        vm.Refresh();
        Assert.Equal("Paid breaks 54 m of 1 h 10 m · unpaid 10 m", vm.Today.AllowanceText);
        Assert.Equal("3h 54m", vm.Today.PaidTimeText);
    }

    [Fact]
    public void No_paid_time_before_start_day_and_the_days_after_end_day()
    {
        var (vm, agent) = Dashboard("08:55", a =>
        {
            a.State = AgentState.NotStarted;
            a.Workday = Days.NotStarted();
            a.Workday.Focus.UnverifiedSec = 600;   // never shown before the day starts
        });
        Assert.False(vm.Today.HasPaidTime);
        Assert.False(vm.Today.HasUnverified);

        agent.State = AgentState.DayEnded;
        agent.Workday = Days.Open(serverNow: "18:40", focusSec: 7 * 3600 + 20 * 60, running: false);
        agent.Workday.State = WorkdayStates.Ended;
        agent.Workday.EndedAt = Ist.At("18:40").ToUniversalTime();
        agent.SetNow("18:45");
        TwoBreaks(agent);
        vm.Refresh();
        Assert.Equal("7h 20m", vm.Today.FocusText);
        Assert.Equal("8h 09m", vm.Today.PaidTimeText);
    }

    [Fact]
    public void Offline_time_with_no_activity_data_shows_only_when_there_is_some_and_says_why()
    {
        var (vm, agent) = Dashboard("15:00", a => a.Workday!.Focus.UnverifiedSec = 2 * 3600 + 5 * 60 + 10);
        Assert.True(vm.Today.HasUnverified);
        Assert.Equal("2h 05m", vm.Today.UnverifiedText);
        Assert.Equal(Why, TodayViewModel.UnverifiedNote);

        // A few seconds never read "0m".
        agent.Workday!.Focus.UnverifiedSec = 20;
        vm.Refresh();
        Assert.Equal("1m", vm.Today.UnverifiedText);

        // The samples arrived: the day read again has none, and the line goes.
        agent.Workday.Focus.UnverifiedSec = 0;
        vm.Refresh();
        Assert.False(vm.Today.HasUnverified);
        Assert.Null(vm.Today.UnverifiedText);
    }

    private static HistoryViewModel History(HistoryMonth month)
    {
        var agent = new FakeAgent("10:45") { HistoryFor = m => m == "2026-10" ? (month, true) : (null, false) };
        var vm = new HistoryViewModel(agent, NullLog.Instance);
        vm.OpenAsync().GetAwaiter().GetResult();
        return vm;
    }

    [Fact]
    public void History_month_shows_paid_time_and_no_offline_figure_when_there_is_none()
    {
        var month = Months.October();
        var vm = History(month);
        var paid = vm.Chips.Single(c => c.Label == "Paid time");
        Assert.Equal(Fmt.Focus(month.FocusSec + month.PaidBreakSec), paid.Value);
        Assert.Equal(new[] { "Working days", "Worked", "Paid time", "Paid breaks" }, vm.Chips.Take(4).Select(c => c.Label));
        Assert.False(vm.HasUnverified);
        Assert.Null(vm.UnverifiedText);
        Assert.Null(vm.UnverifiedNote);
        Assert.All(vm.Days, d => Assert.Null(d.UnverifiedText));
    }

    [Fact]
    public void History_month_with_offline_time_shows_it_under_the_totals_with_why()
    {
        var vm = History(Months.October(offline: true));
        Assert.True(vm.HasUnverified);
        Assert.Equal("2h 10m", vm.UnverifiedText);
        Assert.Equal(Why, vm.UnverifiedNote);
        Assert.Equal(7, vm.Chips.Count);   // the summary chips are the same; the figure has its own line

        var twelfth = vm.Days.Single(d => d.Date == "2026-10-12");
        Assert.Equal("Offline, no activity data 2h 10m", twelfth.UnverifiedText);
        Assert.Equal(Why + ".", twelfth.UnverifiedToolTip);
        Assert.Equal("Paid time 7h 00m", twelfth.PaidText);   // 5 h 50 m focus + 70 m paid breaks
        Assert.Null(vm.Days.Single(d => d.Date == "2026-10-10").UnverifiedText);

        // The samples arrive and the month is read again: the figure and its note go.
        vm.Show(Months.October());
        Assert.False(vm.HasUnverified);
        Assert.Null(vm.UnverifiedText);
        Assert.Null(vm.UnverifiedNote);
    }

    [Fact]
    public void Each_day_says_its_paid_time()
    {
        var vm = History(Months.October());
        Assert.Equal("Paid time 9h 10m", vm.Days.Single(d => d.Date == "2026-10-12").PaidText);   // 8 h focus + 70 m paid breaks
        Assert.Equal("Paid time 1h 00m", vm.Days.Single(d => d.Date == "2026-10-13").PaidText);   // today so far
        Assert.Null(vm.Days.Single(d => d.Date == "2026-10-02").PaidText);                         // a holiday: no time at all
        Assert.Null(vm.Days.Single(d => d.Date == "2026-10-11").PaidText);                         // a Sunday
    }

    [Fact]
    public void Paid_time_from_a_server_that_does_not_send_it_is_focus_plus_paid_breaks()
    {
        var month = Months.October();
        month.PaidSec = null;
        foreach (var d in month.Days) d.PaidSec = null;
        var vm = History(month);
        Assert.Equal(Fmt.Focus(month.FocusSec + month.PaidBreakSec), vm.Chips.Single(c => c.Label == "Paid time").Value);
        Assert.Equal("Paid time 9h 10m", vm.Days.Single(d => d.Date == "2026-10-12").PaidText);

        // The server's own figure wins when it sends one.
        var day = new HistoryDay { Date = "2026-10-12", Status = DayStatuses.Full, FocusSec = 3600, PaidBreakSec = 600, PaidSec = 3000, StartedAt = Ist.At("09:00") };
        Assert.Equal("Paid time 50m", new HistoryDayViewModel(day, _ => "", "2026-10-13").PaidText);
    }

    [Fact]
    public void Some_time_never_reads_zero()
    {
        Assert.Equal("0m", Fmt.SomeDuration(0));
        Assert.Equal("1m", Fmt.SomeDuration(1));
        Assert.Equal("1m", Fmt.SomeDuration(89));
        Assert.Equal("2m", Fmt.SomeDuration(90));
        Assert.Equal("1h 20m", Fmt.SomeDuration(80 * 60));
    }
}

/// <summary>Headless screenshots of the paid-time and offline-evidence screens (see <see cref="Shots.Dir"/>).</summary>
public class PaidTimeScreenshots
{
    private static async Task Shoot(string name, FakeAgent agent, Func<DashboardViewModel, Task>? before = null, double width = 1080, double height = 700)
    {
        var vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), NullLog.Instance);
        vm.Refresh();
        await vm.Chat.ActivateAsync();
        var window = new DashboardWindow { DataContext = vm, Width = width, Height = height };
        window.Show();
        vm.Refresh();
        if (before is not null) await before(vm);
        DashboardHarness.Settle();
        var path = Shots.Save(window, name);
        Assert.True(new FileInfo(path).Length > 10_000, $"{name} looks empty");
        window.AllowClose = true;
        window.Close();
    }

    private static FakeAgent Agent(string now, Action<FakeAgent>? setup = null)
    {
        var agent = new FakeAgent(now);
        agent.Workday!.TargetSec = 7 * 3600 + 30 * 60;
        setup?.Invoke(agent);
        return agent;
    }

    /// <summary>15:10: the morning break and lunch taken, focus ticking; paid time beside the paid breaks.</summary>
    private static void Afternoon(FakeAgent a)
    {
        a.Day = Days.General()
            .WithRecord(Days.Taken("MORNING", "11:00", "11:14"))
            .WithRecord(Days.Taken("LUNCH", "13:00", "13:35", duration: 30));
        a.Workday = Days.Open(serverNow: "15:10", focusSec: 4 * 3600 + 52 * 60);
        a.Workday.TargetSec = 7 * 3600 + 30 * 60;
        a.Totals = new PresenceTotals { BreakSec = 14 * 60, LunchSec = 35 * 60, MeetingSec = 30 * 60 };
    }

    [AvaloniaFact]
    public Task Today_with_paid_time() => Shoot("41-dashboard-paid-time", Agent("15:10", Afternoon));

    [AvaloniaFact]
    public Task Today_after_an_offline_morning() => Shoot("41-dashboard-offline-no-activity", Agent("15:10", a =>
    {
        Afternoon(a);
        // The morning was replayed from the journal; its activity data has not reached the server yet.
        a.Workday!.Focus.FocusSec = 2 * 3600 + 7 * 60;
        a.Workday.Focus.UnverifiedSec = 2 * 3600 + 45 * 60;
    }));

    [AvaloniaFact]
    public Task Today_after_an_offline_morning_minimum_size() => Shoot("41-dashboard-offline-no-activity-900x600", Agent("15:10", a =>
    {
        Afternoon(a);
        a.Workday!.Focus.FocusSec = 2 * 3600 + 7 * 60;
        a.Workday.Focus.UnverifiedSec = 2 * 3600 + 45 * 60;
    }), width: 900, height: 600);

    [AvaloniaFact]
    public Task Day_ended_with_paid_time() => Shoot("41-dashboard-day-ended-paid-time", Agent("18:40", a =>
    {
        Afternoon(a);
        a.State = AgentState.DayEnded;
        a.Workday!.State = WorkdayStates.Ended;
        a.Workday.EndedAt = Ist.At("18:35").ToUniversalTime();
        a.Workday.Focus.FocusSec = 7 * 3600 + 41 * 60;
        a.Workday.Focus.Running = false;
        a.Workday.ServerNow = Ist.At("18:40").ToUniversalTime();
    }));

    [AvaloniaFact]
    public Task History_with_paid_time() => Shoot("41-history-paid-time", Agent("10:47", a => a.HistoryFor = _ => (Months.October(), true)),
        vm => vm.ShowHistoryCommand.ExecuteAsync(null));

    [AvaloniaFact]
    public Task History_with_offline_time() => Shoot("41-history-offline-no-activity", Agent("10:47", a => a.HistoryFor = _ => (Months.October(offline: true), true)),
        vm => vm.ShowHistoryCommand.ExecuteAsync(null));

    [AvaloniaFact]
    public Task History_with_offline_time_minimum_size() => Shoot("41-history-offline-no-activity-900x600",
        Agent("10:47", a => a.HistoryFor = _ => (Months.October(offline: true), true)),
        vm => vm.ShowHistoryCommand.ExecuteAsync(null), width: 900, height: 600);

    /// <summary>The whole guide, with the paid time and offline lines (sections 5 and 9).</summary>
    [AvaloniaFact]
    public Task Instructions() => Shoot("41-instructions", Agent("10:47"),
        vm => { vm.ShowInstructionsCommand.Execute(null); return Task.CompletedTask; }, height: 1500);
}
