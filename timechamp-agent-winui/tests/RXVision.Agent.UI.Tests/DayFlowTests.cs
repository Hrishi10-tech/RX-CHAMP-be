using Avalonia;
using Avalonia.Automation;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.Threading;
using Avalonia.VisualTree;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// The real dashboard window, headless, with the real dialog service: every flow
/// is driven by mouse clicks and typing on what is on screen, as a person would.
/// The agent is scripted (<see cref="FakeAgent"/>); <see cref="DashboardHarness.Refresh"/>
/// stands in for the app's once-a-second refresh.
/// </summary>
public sealed class DashboardHarness
{
    public DashboardHarness(FakeAgent agent, double height = 760)
    {
        Agent = agent;
        DashboardViewModel? vm = null;
        var dialogs = new DialogService(() => vm!, () => true);
        Actions = new BreakActions(agent, dialogs, NullLog.Instance);
        Actions.Cue += Cues.Add;
        vm = new DashboardViewModel(agent, Actions, NullLog.Instance);
        Vm = vm;
        Window = new DashboardWindow { DataContext = vm, Width = 1080, Height = height };
        Window.Show();
        Refresh();
    }

    public FakeAgent Agent { get; }
    public BreakActions Actions { get; }

    /// <summary>The alerts feeding this window's cards.</summary>
    public DayAlerts Alerts() => _dayAlerts ??= new DayAlerts(Agent, Vm.Alerts, Actions, _ => { });
    private DayAlerts? _dayAlerts;

    public DashboardViewModel Vm { get; }
    public DashboardWindow Window { get; }
    public List<string> Cues { get; } = new();

    /// <summary>The app refreshes the dashboard every second and on every change.</summary>
    public void Refresh()
    {
        Vm.Refresh();
        Settle();
    }

    public void At(string hm)
    {
        Agent.SetNow(hm);
        Refresh();
    }

    public static void Settle()
    {
        for (var i = 0; i < 8; i++)
        {
            Dispatcher.UIThread.RunJobs();
            AvaloniaHeadlessPlatform.ForceRenderTimerTick();
        }
    }

    public T Dialog<T>() where T : DialogViewModel => Assert.IsType<T>(Vm.Overlay);

    public bool HasDialog => Vm.Overlay is not null;

    // ---- What is on screen ------------------------------------------------------------------

    private static IEnumerable<T> Visible<T>(TopLevel top) where T : Control =>
        top.GetVisualDescendants().OfType<T>().Where(c => c.IsEffectivelyVisible);

    private static string? TextOf(Button button) =>
        button.Content as string
        ?? button.GetVisualDescendants().OfType<TextBlock>().Select(t => t.Text).FirstOrDefault(t => !string.IsNullOrEmpty(t));

    /// <summary>The one visible button reading <paramref name="text"/> (its content, or its first line).</summary>
    public static Button ButtonIn(TopLevel top, string text)
    {
        var found = Visible<Button>(top)
            .Where(b => TextOf(b) == text || AutomationProperties.GetName(b) == text)
            .ToList();
        // The same words behind an open dialog (End break on the panel and in the dialog): the one that can be clicked.
        if (found.Count > 1) found = found.Where(b => b.IsEffectivelyEnabled).ToList();
        Assert.True(found.Count == 1, $"expected one button \"{text}\", found {found.Count}");
        return found[0];
    }

    public Button Button(string text) => ButtonIn(Window, text);

    public bool HasButton(string text) =>
        Visible<Button>(Window).Any(b => TextOf(b) == text || AutomationProperties.GetName(b) == text);

    /// <summary>Some visible text on the window reads exactly this.</summary>
    public bool Shows(string text) => Visible<TextBlock>(Window).Any(t => t.Text == text);

    public TextBox Box(string name) =>
        Visible<TextBox>(Window).Single(t => t.Name == name || AutomationProperties.GetName(t) == name);

    /// <summary>The boxes that can be typed in now (with a dialog open, only the dialog's).</summary>
    public IReadOnlyList<TextBox> Boxes() => Visible<TextBox>(Window).Where(t => t.IsEffectivelyEnabled).ToList();

    // ---- Doing things -----------------------------------------------------------------------

    /// <summary>A left click in the middle of the button, through the window's own input (so it must be on top and enabled).</summary>
    public static void ClickOn(TopLevel top, Button button)
    {
        Assert.True(button.IsEffectivelyEnabled, $"\"{TextOf(button)}\" is disabled");
        var middle = button.TranslatePoint(new Point(button.Bounds.Width / 2, button.Bounds.Height / 2), top)
                     ?? throw new InvalidOperationException("the button is not on the window");
        top.MouseDown(middle, MouseButton.Left);
        top.MouseUp(middle, MouseButton.Left);
        Settle();
    }

    public void Click(string text) => ClickOn(Window, Button(text));

    public void Click(Button button) => ClickOn(Window, button);

    /// <summary>Puts the caret in the box and types, key by key as text input.</summary>
    public void Type(TextBox box, string text)
    {
        box.Focus();
        Settle();
        Window.KeyTextInput(text);
        Settle();
    }

    /// <summary>Types where the caret is now.</summary>
    public void TypeHere(string text)
    {
        Window.KeyTextInput(text);
        Settle();
    }

    public void Press(Key key)
    {
        Window.KeyPress(key, RawInputModifiers.None, PhysicalKey.None, null);
        Window.KeyRelease(key, RawInputModifiers.None, PhysicalKey.None, null);
        Settle();
    }

    public void Close()
    {
        Vm.Overlay?.Cancel();
        Settle();
        Window.AllowClose = true;
        Window.Close();
    }
}

/// <summary>Start Day, End Day and the focus panel, on the window.</summary>
public class DayFlowTests
{
    private static FakeAgent NotStarted(string now) => new(now)
    {
        State = AgentState.NotStarted,
        Workday = Days.NotStarted(now),
        Presence = new CurrentPresence { Status = PresenceStatus.NotStarted },
        Totals = new PresenceTotals(),
    };

    [AvaloniaFact]
    public void Start_the_day()
    {
        var agent = NotStarted("08:55");
        agent.StartDayOutcomes.Enqueue(new StartDayOutcome.Started(Days.Open(startedAt: "08:56", serverNow: "08:56", focusSec: 0), false));
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("YOUR DAY HASN'T STARTED"));
        Assert.True(ui.Shows("Good morning, Asha."));
        Assert.True(ui.Shows("General shift · 9:30 AM to 6:30 PM"));
        Assert.True(ui.Shows("Not started · nothing recorded"));
        Assert.False(ui.HasButton("END DAY"));
        Assert.False(ui.HasButton("Quick break"));

        agent.SetNow("08:56");
        ui.Click("Start Day");
        Assert.Equal(1, agent.StartDayCalls);
        Assert.False(ui.HasDialog);

        ui.Refresh();
        Assert.False(ui.Shows("YOUR DAY HASN'T STARTED"));
        Assert.True(ui.HasButton("Quick break"));
        Assert.True(ui.HasButton("Next break"));
        Assert.True(ui.HasButton("END DAY"));
        Assert.True(ui.Shows("Day started 8:56 AM"));
        Assert.True(ui.Shows("Counting"));

        // Focus time ticks from the server's number.
        ui.At("09:41:10");
        Assert.True(ui.Shows("45m"));
        ui.Close();
    }

    [AvaloniaFact]
    public void Start_the_day_from_the_good_morning_card()
    {
        var agent = NotStarted("08:55");
        var ui = new DashboardHarness(agent);
        ui.Alerts().OnNudge(new AgentNudge(NudgeKind.Greeting, "2026-10-13"));
        DashboardHarness.Settle();
        ui.Click("Start day");
        Assert.Equal(1, agent.StartDayCalls);
        Assert.Equal(AgentState.Running, agent.State);
        ui.Alerts().Sync();
        Assert.Empty(ui.Vm.Alerts.Cards);
        ui.Close();
    }

    [AvaloniaFact]
    public void Start_the_day_offline_starts_at_once_and_says_it_is_waiting()
    {
        // SPEC 6: no "can't reach RX Vision" dialog; the day runs and the header says what waits.
        var agent = NotStarted("09:01");
        agent.Online = false;
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("Offline · synced 10:44 AM"));
        ui.Click("Start Day");
        Assert.False(ui.HasDialog);
        agent.PendingActions = 1;
        ui.Refresh();
        Assert.Equal(AgentState.Running, agent.State);
        Assert.True(ui.Shows("Offline · 1 action waiting"));
        Assert.True(ui.HasButton("END DAY"));

        agent.Online = true;
        agent.PendingActions = 0;
        agent.LastSyncAt = Ist.At("09:03");
        agent.LastSampleSent = Ist.At("08:30");
        ui.At("09:03");
        Assert.True(ui.Shows("Online · synced 9:03 AM"));
        ui.Close();
    }

    [AvaloniaFact]
    public void Focus_ticks_while_working_and_pauses_on_a_break()
    {
        var agent = new FakeAgent("10:45") { Workday = Days.Open(serverNow: "10:24", focusSec: 3600) };
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("1h 21m"));
        Assert.True(ui.Shows("Counting"));
        Assert.True(ui.Shows("Day started 9:24 AM"));
        Assert.False(ui.Shows("Activity")); // no activity score anywhere

        ui.At("10:46:30");
        Assert.True(ui.Shows("1h 22m"));

        // A break from 10:47: the number stops there.
        agent.Day = Days.General().WithActive(Days.Running("MORNING", "10:47"));
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Break, Since = Ist.At("10:47") };
        ui.At("10:55");
        Assert.True(ui.Shows("1h 23m"));
        Assert.True(ui.Shows("Paused · on a break"));
        Assert.True(ui.Shows("Back by 11:02 AM. Your focus time is paused. Pause it if you need to step back in."));
        ui.At("11:01");
        Assert.True(ui.Shows("1h 23m"));

        // Back at 11:01: the server's new number ticks again.
        agent.Day = Days.General().WithRecord(Days.Taken("MORNING", "10:47", "11:01"));
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Working, Since = Ist.At("11:01") };
        agent.Workday = Days.Open(serverNow: "11:01", focusSec: 83 * 60);
        ui.At("11:10");
        Assert.True(ui.Shows("1h 32m"));
        Assert.True(ui.Shows("Counting"));
        ui.Close();
    }

    [AvaloniaFact]
    public void End_Day_with_three_comments()
    {
        var agent = new FakeAgent("18:32");
        agent.Workday!.SkipsNeedingComment.AddRange(new[]
        {
            Days.NeedsComment("MORNING", "12:00"),
            Days.NeedsComment("EVENING", "17:00"),
            Days.NeedsComment("LUNCH", "14:00", date: "2026-10-12"),
        });
        var ui = new DashboardHarness(agent, height: 800);
        ui.Click("END DAY");
        var dialog = ui.Dialog<EndDayDialogViewModel>();
        Assert.True(ui.Shows("Before you end the day"));
        Assert.True(ui.Shows("3 skipped breaks need a comment. Each goes to your manager with your comment."));
        Assert.True(ui.Shows("Auto-skipped at 2:00 PM on 12 Oct"));
        var endDay = ui.Button("End Day");
        Assert.False(endDay.IsEffectivelyEnabled);

        var boxes = ui.Boxes();
        Assert.Equal(3, boxes.Count);
        ui.Type(boxes[0], "The client demo ran until 12:15");
        Assert.False(endDay.IsEffectivelyEnabled);
        ui.Click(ui.ButtonsReading("Deadline").ElementAt(1)); // the second break's quick reason
        Assert.Equal("Deadline", dialog.Items[1].Text);
        Assert.False(dialog.Items[1].CountOk); // 8 characters: a few more words are needed
        ui.TypeHere(" for the invoice release"); // the caret went back to that box
        Assert.Equal("Deadline for the invoice release", dialog.Items[1].Text);
        Assert.False(endDay.IsEffectivelyEnabled);
        ui.Type(boxes[2], "Too short");
        Assert.False(endDay.IsEffectivelyEnabled);
        ui.Type(boxes[2], ", lunch with the client ran over");
        Assert.True(endDay.IsEffectivelyEnabled);

        ui.Click(endDay);
        Assert.False(ui.HasDialog);
        var sent = Assert.Single(agent.EndDayCalls)!;
        Assert.Equal(new[]
        {
            ("morning-auto", "The client demo ran until 12:15"),
            ("evening-auto", "Deadline for the invoice release"),
            ("lunch-auto", "Too short, lunch with the client ran over"),
        }, sent.Select(c => (c.BreakId, c.Comment)));

        ui.Refresh();
        Assert.True(ui.Shows("Your day ended at 6:32 PM."));
        Assert.True(ui.Shows("Day ended · nothing recorded"));
        Assert.False(ui.HasButton("END DAY"));
        Assert.True(ui.HasButton("Start Day"));
        ui.Close();
    }

    [AvaloniaFact]
    public void End_Day_blocked_by_overdue_approvals()
    {
        var agent = new FakeAgent("18:32");
        agent.User!.Role = "MANAGER";
        agent.EndDayOutcomes.Enqueue(new EndDayOutcome.ApprovalsOverdue(3, Ist.At("10:00").AddDays(-3), "x"));
        agent.EndDayOutcomes.Enqueue(new EndDayOutcome.ApprovalsOverdue(3, Ist.At("10:00").AddDays(-3), "x"));
        var ui = new DashboardHarness(agent);

        ui.Click("END DAY");
        Assert.True(ui.Shows("End your working day?"));
        ui.Click("End Day");
        Assert.True(ui.Shows("Approvals are past 48 hours"));
        Assert.True(ui.Shows("3 approvals are past 48 hours. Decide them in the portal to end your day."));
        ui.Click("Open approvals");
        Assert.False(ui.HasDialog);
        Assert.Equal("https://app.rxvision.shop/dashboard/approvals", Assert.Single(agent.Dev.OpenedUrls));

        // The day is still running; Close leaves it so.
        ui.Refresh();
        Assert.True(ui.HasButton("END DAY"));
        ui.Click("END DAY");
        ui.Click("End Day");
        ui.Click("Close");
        Assert.False(ui.HasDialog);
        Assert.Single(agent.Dev.OpenedUrls);
        Assert.Equal(AgentState.Running, agent.State);
        ui.Close();
    }

    [AvaloniaFact]
    public void Waiting_for_your_manager()
    {
        var agent = new FakeAgent("12:20");
        agent.Approvals.Add(new ApprovalItem
        {
            Type = "MEETING", Id = "m1", Category = "MEETING_PAST", Title = "Meeting: Client call with Acme", Detail = "10:30 to 11:00",
            Effect = new ApprovalEffect { Mode = "PLUS", Minutes = 30, Text = "+30 min if approved" },
        });
        agent.Approvals.Add(new ApprovalItem
        {
            Type = "BREAK", Id = "b1", Category = "BREAK_SKIP", Title = "Morning break skipped", Detail = "Skipped at 11:02",
            Effect = new ApprovalEffect { Mode = "MINUS", Minutes = 15, Text = "−15 min if rejected" },
        });
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("Waiting for your manager"));
        Assert.True(ui.Shows("Meeting: Client call with Acme"));
        Assert.True(ui.Shows("+30 min if approved"));
        Assert.True(ui.Shows("−15 min if rejected"));

        // The manager approves the meeting: it shows the decision for today.
        var meeting = agent.Approvals[0];
        meeting.Status = "APPROVED";
        meeting.DecidedAt = Ist.At("12:25").ToUniversalTime();
        meeting.DecidedByName = "Maya Reddy";
        meeting.Effect = new ApprovalEffect { Mode = "PLUS", Minutes = 30, Text = "+30 min added" };
        ui.At("12:26");
        Assert.True(ui.Shows("Approved · +30 min added"));
        Assert.False(ui.Shows("+30 min if approved"));

        // Nothing waiting: no card.
        agent.Approvals.Clear();
        ui.Refresh();
        Assert.False(ui.Shows("Waiting for your manager"));
        ui.Close();
    }
}

/// <summary>Breaks on the window: the ring, skipping, auto-skips and coming back late.</summary>
public class BreakFlowTests
{
    [AvaloniaFact]
    public void Ring_then_skip_with_a_reason()
    {
        var agent = new FakeAgent("10:59:30");
        var ui = new DashboardHarness(agent);
        ui.Alerts().Sync();
        DashboardHarness.Settle();
        ui.Click("Skip this break");

        var skip = ui.Dialog<ReasonDialogViewModel>();
        Assert.True(ui.Shows("Skip morning break?"));
        Assert.True(ui.Shows("Your focus time keeps running. If your manager rejects the skip, the 15 min come off it."));
        Assert.True(ui.Shows("Required. 10 characters or more."));
        Assert.False(ui.Button("Skip break").IsEffectivelyEnabled);
        ui.Click("Client call");
        Assert.Equal("Client call", ui.Box("ReasonBox").Text);
        Assert.True(skip.CountOk);
        ui.Click("Skip break");

        Assert.False(ui.HasDialog);
        Assert.Equal(("MORNING", (string?)"Client call"), Assert.Single(agent.SkipCalls));
        Assert.Equal(new[] { "Skipped and noted. Keep it steady." }, ui.Cues);

        // The server's day now has the skip: the row says so, with the reason.
        agent.Day = Days.General().WithRecord(Days.Skip("MORNING", "10:59", auto: false, reason: "Client call"));
        ui.Refresh();
        Assert.True(ui.Shows("Skipped"));
        Assert.True(ui.Shows("Skipped at 10:59 AM · focus time kept counting"));
        Assert.True(ui.Shows("“Client call”"));
        ui.Close();
    }

    [AvaloniaFact]
    public void Take_a_break_offers_skip_and_back_returns()
    {
        var agent = new FakeAgent("10:59:30");
        var ui = new DashboardHarness(agent);
        ui.Click("Next break");
        Assert.True(ui.Shows("Start morning break?"));
        Assert.True(ui.Shows("15 min. Back by 11:14 AM. Your focus time pauses until you tap End break."));

        ui.Click("Skip break");
        Assert.True(ui.Shows("Skip morning break?"));
        ui.Click("Back");
        Assert.True(ui.Shows("Start morning break?"));

        ui.Click("Skip break");
        ui.Click("Deadline");
        Assert.True(ui.Shows("2 more characters"));
        Assert.False(ui.Button("Skip break").IsEffectivelyEnabled);
        ui.TypeHere(" for the invoice release"); // the caret went back to the box
        Assert.True(ui.Shows("Looks good"));
        ui.Click("Skip break");
        Assert.False(ui.HasDialog);
        Assert.Equal(("MORNING", (string?)"Deadline for the invoice release"), Assert.Single(agent.SkipCalls));
        Assert.Empty(agent.TakeCalls);
        ui.Close();
    }

    [AvaloniaFact]
    public void Super_admins_skip_with_no_dialog()
    {
        var agent = new FakeAgent("10:59:30");
        agent.User!.Role = "SUPER_ADMIN";
        var ui = new DashboardHarness(agent);
        ui.Click("Next break");
        ui.Click("Skip break");
        Assert.False(ui.HasDialog);
        Assert.Equal(("MORNING", (string?)null), Assert.Single(agent.SkipCalls));
        ui.Close();
    }

    [AvaloniaFact]
    public void Auto_skip_then_comment()
    {
        var record = Days.Skip("MORNING", "12:00", auto: true);
        var agent = new FakeAgent("12:10") { Day = Days.General().WithRecord(record) };
        agent.Workday!.SkipsNeedingComment.Add(Days.NeedsComment("MORNING", "12:00"));
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("Auto-skipped"));
        Assert.True(ui.Shows("Auto-skipped at 12:00 PM · add a comment"));

        // The card's Add comment opens the same dialog; Esc closes it and sends nothing.
        ui.Alerts().OnAutoSkipped(record);
        var card = Assert.Single(ui.Vm.Alerts.Cards);
        Assert.Equal("Morning break skipped for you.", card.Title);
        card.PrimaryCommand.Execute(null);
        DashboardHarness.Settle();
        Assert.True(ui.Shows("Add a comment"));
        ui.Press(Key.Escape);
        Assert.False(ui.HasDialog);
        Assert.Empty(agent.CommentCalls);
        ui.Vm.Alerts.Clear(card.Key);
        DashboardHarness.Settle();

        // The row's Add comment.
        ui.Click("Add comment");
        Assert.True(ui.Shows("Morning break · closed 12:00 PM"));
        ui.Type(ui.Box("ReasonBox"), "The client demo ran until 12:15");
        ui.Click("Send comment");
        Assert.False(ui.HasDialog);
        Assert.Equal(("morning-auto", "The client demo ran until 12:15"), Assert.Single(agent.CommentCalls));

        // Commented: no button any more, the comment shows.
        var commented = Days.Skip("MORNING", "12:00", auto: true, reason: "The client demo ran until 12:15");
        commented.NeedsComment = false;
        agent.Day = Days.General().WithRecord(commented);
        agent.Workday.SkipsNeedingComment.Clear();
        ui.Refresh();
        Assert.False(ui.HasButton("Add comment"));
        Assert.True(ui.Shows("“The client demo ran until 12:15”"));
        ui.Close();
    }

    private static FakeAgent OnBreakSince(string now, string since)
    {
        var agent = new FakeAgent(now) { Day = Days.General().WithActive(Days.Running("MORNING", since)) };
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Break, Since = Ist.At(since) };
        return agent;
    }

    [AvaloniaFact]
    public void End_break_late_asks_first_and_says_how_far_over()
    {
        // 4.0: no "ask your manager to count the minutes" step; the buffer takes them (SPEC 2.3).
        var agent = OnBreakSince("11:19", "11:00");
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("−04:00"));
        Assert.True(ui.Shows("Over by 4 min"));
        ui.Click("End break");
        Assert.True(ui.Shows("End your morning break now?"));
        Assert.True(ui.Shows("You're 4 min over. Minutes over come out of your paid buffer first."));
        ui.Click("End break");
        Assert.False(ui.HasDialog);
        Assert.Equal(1, agent.BackToWorkCalls);
        Assert.Empty(ui.Cues); // never a cue after a late return
        ui.Close();
    }

    [AvaloniaFact]
    public void End_break_is_always_confirmed_and_can_be_called_off()
    {
        var agent = OnBreakSince("11:03", "11:00");
        var ui = new DashboardHarness(agent);
        ui.Click("End break");
        Assert.True(ui.Shows("End your morning break now?"));
        Assert.True(ui.Shows("You have 12 min left."));
        ui.Click("Stay on break");
        Assert.False(ui.HasDialog);
        Assert.Equal(0, agent.BackToWorkCalls);
        ui.Close();
    }

    [AvaloniaFact]
    public void Pause_then_resume_from_the_row()
    {
        var agent = OnBreakSince("11:05", "11:00");
        var ui = new DashboardHarness(agent);
        Assert.True(ui.HasButton("Pause break"));
        ui.Click("Pause break");
        Assert.Equal(1, agent.PauseCalls);
        Assert.False(ui.HasDialog);

        // The agent's day now has it paused: the tiles are back, the row offers Resume and End.
        var paused = Days.Running("MORNING", "11:00");
        paused.InProgress = false;
        paused.State = BreakStates.Paused;
        paused.Segments.Add(new BreakSegment { StartedAt = Ist.At("11:00").ToUniversalTime(), EndedAt = Ist.At("11:05").ToUniversalTime() });
        agent.Day = Days.General().WithRecord(paused);
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Working };
        ui.At("11:20");
        Assert.True(ui.Shows("Paused · tap to resume by 12:00 PM"));
        Assert.True(ui.Shows("Taken 5 min, 10 min left · resume by 12:00 PM"));
        ui.Click("Resume break");
        Assert.Equal(1, agent.ResumeCalls);

        // The tile resumes it too; End break on the row asks first.
        ui.Click("Next break");
        Assert.Equal(2, agent.ResumeCalls);
        ui.Click("End break");
        Assert.True(ui.Shows("End your morning break now?"));
        Assert.True(ui.Shows("It is paused with 10 min left. Ending it now means you can't resume it."));
        ui.Click("Keep it paused");
        Assert.Equal(0, agent.BackToWorkCalls);
        ui.Close();
    }

    [AvaloniaFact]
    public void Back_early_shows_the_quiet_line()
    {
        var agent = OnBreakSince("11:09", "11:00");
        agent.EndOutcomes.Enqueue(new EndOutcome.Ended(Days.Taken("MORNING", "11:00", "11:09")));
        var ui = new DashboardHarness(agent);
        ui.Click("End break");
        Assert.True(ui.Shows("You have 6 min left."));
        ui.Click("End break");
        Assert.False(ui.HasDialog);
        Assert.Equal(new[] { "Back early. Nice rhythm." }, ui.Cues);

        var cue = new ToastWindow { DataContext = Toasts.Cue(ui.Cues[0]), Animate = false };
        cue.ShowBeside(new PixelRect(1690, 470, 88, 88), new PixelPoint(1734, 514));
        DashboardHarness.Settle();
        Assert.Contains(cue.GetVisualDescendants().OfType<TextBlock>(), t => t.IsEffectivelyVisible && t.Text == "Back early. Nice rhythm.");
        Assert.DoesNotContain(cue.GetVisualDescendants().OfType<Button>(), b => b.IsEffectivelyVisible);
        cue.Close();
        ui.Close();
    }
}

/// <summary>Meetings on the window: now, earlier today, a refusal, and End meeting.</summary>
public class MeetingFlowTests
{
    [AvaloniaFact]
    public void Meeting_now_then_ended()
    {
        var agent = new FakeAgent("10:20");
        var ui = new DashboardHarness(agent);
        ui.Click("Meeting with details, or an earlier one");
        var dialog = ui.Dialog<MeetingDialogViewModel>();
        Assert.True(ui.Shows("Start a meeting"));
        Assert.False(dialog.SubmitCommand.CanExecute(null)); // the tile reads Start meeting too (3.6)

        ui.Type(ui.Box("AgendaBox"), "Sprint planning for the invoice release");
        ui.Click("+ Maya Reddy");
        ui.Type(ui.Box("Add people or type a name"), "Vikram (Pune)");
        ui.Press(Key.Enter);
        Assert.Equal(new[] { "Maya Reddy", "Vikram (Pune)" }, dialog.Chosen.Select(c => c.Name));
        Assert.True(ui.Shows("Vikram (Pune)"));
        Assert.False(dialog.SubmitCommand.CanExecute(null)); // who mails the minutes is required
        ui.Click("Me (Asha)");
        ui.Click("Start meeting");

        Assert.False(ui.HasDialog);
        var (agenda, people, mom) = Assert.Single(agent.MeetingCalls);
        Assert.Equal("Asha Kumar", mom);
        Assert.Equal("Sprint planning for the invoice release", agenda);
        Assert.Equal(new[] { "m-1", null }, people.Select(p => p.Id));

        ui.At("10:32");
        Assert.True(ui.Shows("IN A MEETING"));
        Assert.True(ui.Shows("12:00"));
        Assert.True(ui.Shows("Maya Reddy, Vikram (Pune)"));
        Assert.True(ui.Shows("Counting · in a meeting"));
        Assert.True(ui.Shows("Minutes: Asha Kumar"));
        Assert.False(ui.HasButton("Quick break"));

        ui.Click("End meeting");
        Assert.Equal(1, agent.EndMeetingCalls);
        ui.Refresh();
        Assert.False(ui.Shows("IN A MEETING"));
        Assert.True(ui.HasButton("Start meeting"));
        ui.Close();
    }

    [AvaloniaFact]
    public void Meeting_that_already_happened_and_the_servers_refusal()
    {
        var agent = new FakeAgent("12:20");
        agent.MeetingOutcomes.Enqueue(new MeetingOutcome.Invalid("MEETING_OVERLAPS_BREAK", "Overlaps a break.", new MeetingClash
        {
            Kind = "BREAK", StartedAt = Ist.At("11:00").ToUniversalTime(), EndedAt = Ist.At("11:15").ToUniversalTime(),
        }));
        var ui = new DashboardHarness(agent, height: 820);
        ui.Click("Meeting with details, or an earlier one");
        ui.Click("Already happened");
        var dialog = ui.Dialog<MeetingDialogViewModel>();
        Assert.True(ui.Shows("Log an earlier meeting"));
        Assert.True(ui.Shows("Who was in it?"));

        var started = ui.Window.GetVisualDescendants().OfType<ComboBox>().Single(c => c.IsEffectivelyVisible);
        started.SelectedItem = dialog.StartOptions.First(o => o.Label == "10:45 AM");
        ui.Click("45 min");
        ui.Type(ui.Box("AgendaBox"), "Client call with Acme");
        ui.Type(ui.Box("MomBox"), "Priya");
        Assert.True(ui.Shows("10:45 AM to 11:30 AM · 45 min"));
        ui.Click("Log meeting");

        // Refused: the dialog comes back with the reason and what was filled in.
        var again = ui.Dialog<MeetingDialogViewModel>();
        Assert.NotSame(dialog, again);
        Assert.True(ui.Shows("That overlaps your break from 11:00 AM to 11:15 AM. Pick another time."));
        Assert.True(again.IsPast);
        Assert.Equal("Client call with Acme", again.Agenda);

        var startedAgain = ui.Window.GetVisualDescendants().OfType<ComboBox>().Single(c => c.IsEffectivelyVisible);
        startedAgain.SelectedItem = again.StartOptions.First(o => o.Label == "10:15 AM");
        ui.Click("Log meeting");
        Assert.False(ui.HasDialog);
        Assert.Equal(2, agent.PastMeetingCalls.Count);
        Assert.Equal((Ist.At("10:15"), 45, "Client call with Acme"),
            (agent.PastMeetingCalls[1].StartedAt, agent.PastMeetingCalls[1].Minutes, agent.PastMeetingCalls[1].Agenda));
        Assert.Empty(agent.MeetingCalls);
        ui.Close();
    }
}

internal static class HarnessExtensions
{
    /// <summary>Every visible button reading this text, top to bottom.</summary>
    public static IEnumerable<Button> ButtonsReading(this DashboardHarness ui, string text) =>
        ui.Window.GetVisualDescendants().OfType<Button>()
            .Where(b => b.IsEffectivelyVisible && (b.Content as string == text))
            .OrderBy(b => b.TranslatePoint(new Point(0, 0), ui.Window)?.Y ?? 0);
}
