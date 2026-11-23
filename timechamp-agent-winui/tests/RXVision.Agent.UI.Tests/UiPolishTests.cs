using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.VisualTree;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>The 3.6 UI review (Nov 2026): what changed on screen, held.</summary>
public class UiPolishTests
{
    private static FakeAgent EndedDay()
    {
        var a = new FakeAgent("18:40") { State = AgentState.DayEnded };
        var day = Days.General().WithRecord(Days.Taken("MORNING", "11:00", "11:14"));
        day.DayEnded = true;
        a.Day = day;
        a.Presence = new CurrentPresence { Status = PresenceStatus.DayEnded };
        var ended = Days.Open(serverNow: "18:31", focusSec: 7 * 3600, running: false);
        ended.State = WorkdayStates.Ended;
        ended.EndedAt = Ist.At("18:31").ToUniversalTime();
        a.Workday = ended;
        return a;
    }

    [AvaloniaFact]
    public void The_monitoring_notice_reads_at_13_px_or_more()
    {
        // G7 (UI review, 18 Nov): the consent body was hand-set to 12.5 px; it now uses the body style.
        var notice = new NoticeWindow { DataContext = new NoticeViewModel(new FakeAgent(), NullLog.Instance) };
        notice.Show();
        var texts = notice.GetVisualDescendants().OfType<TextBlock>()
            .Where(t => !string.IsNullOrWhiteSpace(t.Text) && t.IsEffectivelyVisible && t.Text != "Before you start")
            .ToList();
        Assert.NotEmpty(texts);
        Assert.All(texts, t => Assert.True(t.FontSize >= 13, $"\"{t.Text}\" is {t.FontSize} px"));
        notice.AllowClose = true;
        notice.Close();
    }

    [AvaloniaFact]
    public void With_data_handling_on_the_notice_starts_with_the_section_9_sentence()
    {
        var off = new NoticeViewModel(new FakeAgent(), NullLog.Instance);
        Assert.Null(off.DataHandlingSentence);
        var agent = new FakeAgent();
        agent.FlagsOn.Add("dataHandling");
        var on = new NoticeViewModel(agent, NullLog.Instance);
        Assert.Equal("RxVision records activity, periodic captures and file-transfer events on this work device for attendance, payroll and data security.", on.DataHandlingSentence);
    }

    [AvaloniaFact]
    public void After_the_day_ends_Start_day_is_outlined_so_a_restart_is_never_the_obvious_tap()
    {
        var ui = new DashboardHarness(EndedDay());
        var restart = ui.Button("Start day");
        Assert.Contains("secondary", restart.Classes);
        Assert.DoesNotContain("primary", restart.Classes);
    }

    [AvaloniaFact]
    public void The_Profile_tab_ends_with_the_shift_and_the_version()
    {
        var ui = new DashboardHarness(new FakeAgent("10:20"));
        ui.Click("Profile");
        Assert.True(ui.Shows("RX Vision 4.0.0"));
        Assert.True(ui.Shows(ui.Vm.ShiftText));
        // 4.0: sign out needs a key; the avatar row (D-85) comes with the avatars stream.
        Assert.True(ui.HasButton("Sign out"));
    }

    [AvaloniaFact]
    public void The_leave_preview_is_a_card_that_shows_only_once_the_server_answers()
    {
        var answer = new TaskCompletionSource<ApiResult<LeavePreview>>();
        var context = new LeaveDialogContext(LeavePageTests.Leave().Policy, new DateTime(2026, 10, 13), new[] { "Unwell" },
            new HashSet<DateTime>(), _ => answer.Task, (_, _) => Task.CompletedTask);
        var dialog = new LeaveDialogViewModel(context) { Reason = "Unwell" };
        Assert.False(dialog.HasPreviewLines);

        answer.SetResult(ApiResult<LeavePreview>.Success(new LeavePreview
        {
            Ok = true, DaysLabel = "1 day", WaitingFor = "Maya Reddy",
            Balance = new LeavePreviewBalance { Label = "CL/SL", BeforeDays = 10.5, AfterDays = 9.5 },
        }));
        DashboardHarness.Settle();
        Assert.True(dialog.HasPreviewLines);
        Assert.Equal(new[] { "Charges 1 day of CL/SL", "Left after: 9.5 (now 10.5)", "Goes to Maya Reddy for approval" }, dialog.PreviewLines);
    }
}
