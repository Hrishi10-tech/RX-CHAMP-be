using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.Media;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Update;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// Every window in every state, rendered headless with the real styles and saved
/// as PNG (see <see cref="Shots.Dir"/>) for a person to check. Each also asserts
/// the window laid out and drew something.
/// </summary>
public class ScreenshotTests
{
    private static readonly IBrush Desktop = new LinearGradientBrush
    {
        StartPoint = new RelativePoint(0, 0, RelativeUnit.Relative),
        EndPoint = new RelativePoint(1, 1, RelativeUnit.Relative),
        GradientStops = { new GradientStop(Color.Parse("#2B3A55"), 0), new GradientStop(Color.Parse("#3E5579"), 1) },
    };

    private static FakeAgent Agent(string now, Action<FakeAgent>? setup = null)
    {
        var agent = new FakeAgent(now);
        agent.FakeChat.Conversation.AddRange(new[]
        {
            new ChatMessage { Id = "1", FromUserId = "m-1", ToUserId = "u-1", Body = "Morning Asha. Can you join the 4 pm call with the Pune team?", CreatedAt = Ist.At("09:41") },
            new ChatMessage { Id = "2", FromUserId = "u-1", ToUserId = "m-1", Body = "Yes, I'll be there.", Mine = true, CreatedAt = Ist.At("09:43") },
            new ChatMessage { Id = "3", FromUserId = "m-1", ToUserId = "u-1", Body = "Thanks!", CreatedAt = Ist.At("09:44") },
        });
        setup?.Invoke(agent);
        return agent;
    }

    private static async Task<(DashboardWindow Window, DashboardViewModel Vm)> Dashboard(FakeAgent agent, double width = 1080, double height = 700)
    {
        var vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), NullLog.Instance), NullLog.Instance);
        vm.Refresh();
        await vm.Chat.ActivateAsync();
        var window = new DashboardWindow { DataContext = vm, Width = width, Height = height };
        window.Show();
        vm.Refresh();
        return (window, vm);
    }

    private static async Task Shoot(string name, FakeAgent agent, Action<DashboardViewModel>? before = null, double width = 1080, double height = 700)
    {
        var (window, vm) = await Dashboard(agent, width, height);
        before?.Invoke(vm);
        var path = Shots.Save(window, name);
        Assert.True(new FileInfo(path).Length > 10_000, $"{name} looks empty");
        window.AllowClose = true;
        window.Close();
    }

    // ---- Dashboard ------------------------------------------------------------------------------

    [AvaloniaFact]
    public Task Dashboard_free_mode() => Shoot("dashboard-free", Agent("10:47", a => a.Day = Days.Free()));

    [AvaloniaFact]
    public Task Dashboard_upcoming() => Shoot("dashboard-upcoming", Agent("10:20"));

    [AvaloniaFact]
    public Task Dashboard_open_early() => Shoot("dashboard-open-early", Agent("10:47"));

    [AvaloniaFact]
    public Task Dashboard_due_ringing() => Shoot("dashboard-due-ringing", Agent("10:59:30"));

    [AvaloniaFact]
    public Task Dashboard_open_late() => Shoot("dashboard-open-late", Agent("11:42"));

    [AvaloniaFact]
    public Task Dashboard_on_break() => Shoot("dashboard-on-break", Agent("11:08:20", a =>
    {
        a.Day = Days.General().WithActive(Days.Running("MORNING", "11:01"));
        a.Presence = new CurrentPresence { Status = PresenceStatus.Break, Since = Ist.At("11:01") };
    }));

    [AvaloniaFact]
    public Task Dashboard_on_lunch_late() => Shoot("dashboard-on-lunch", Agent("13:20", a =>
    {
        a.Day = Days.General().WithRecord(Days.Taken("MORNING", "11:00", "11:14")).WithActive(Days.Running("LUNCH", "13:09", 30, "LATE", "PENDING"));
        a.Presence = new CurrentPresence { Status = PresenceStatus.Lunch, Since = Ist.At("13:09") };
    }));

    [AvaloniaFact]
    public Task Dashboard_overrun() => Shoot("dashboard-overrun", Agent("11:21:12", a =>
    {
        a.Day = Days.General().WithActive(Days.Running("MORNING", "11:01"));
        a.Presence = new CurrentPresence { Status = PresenceStatus.Break, Since = Ist.At("11:01") };
    }));

    [AvaloniaFact]
    public Task Dashboard_end_of_day_statuses() => Shoot("dashboard-taken-statuses", Agent("17:30", a =>
    {
        a.Day = Days.General()
            .WithRecord(Days.Taken("MORNING", "11:42", "12:01", "LATE", "APPROVED", note: "OK this time", by: "Maya Reddy"))
            .WithRecord(Days.Taken("LUNCH", "13:01", "13:31", duration: 30))
            .WithRecord(Days.Taken("EVENING", "15:44", "15:59", "EARLY", "PENDING"));
        a.Totals = new PresenceTotals { BreakSec = 34 * 60, LunchSec = 30 * 60, MeetingSec = 45 * 60, OnlineSec = 6 * 3600 + 50 * 60 };
    }));

    [AvaloniaFact]
    public Task Dashboard_skipped_unavailable_rejected() => Shoot("dashboard-skipped-unavailable-rejected", Agent("13:40", a =>
    {
        var day = Days.General().WithRecord(Days.Taken("LUNCH", "12:41", "13:20", "EARLY", "REJECTED", 30, "Please take lunch at 13:00 as planned", "Maya Reddy"));
        day.Breaks[0].WindowClose = Ist.At("15:00").ToUniversalTime();
        a.Day = day;
    }));

    [AvaloniaFact]
    public Task Dashboard_skipped() => Shoot("dashboard-skipped", Agent("12:10"));

    [AvaloniaFact]
    public Task Dashboard_meeting() => Shoot("dashboard-meeting", Agent("10:20", a =>
    {
        a.Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = Ist.At("10:02"), Note = "Sprint review with the design team" };
        a.LiveMeeting = new MeetingRecord
        {
            Id = "meet-1", Agenda = "Sprint review with the design team", StartedAt = Ist.At("10:02"), InProgress = true,
            Participants =
            {
                new MeetingParticipant("m-1", "Maya Reddy"), new MeetingParticipant("p-2", "Praveen Kumar"),
                new MeetingParticipant("k-3", "Kavya R"), new MeetingParticipant(null, "Vikram (Pune)"),
            },
        };
    }));

    [AvaloniaFact]
    public Task Dashboard_not_started() => Shoot("dashboard-not-started", Agent("08:55", a =>
    {
        a.State = AgentState.NotStarted;
        a.Workday = Days.NotStarted("08:55");
        a.Presence = new CurrentPresence { Status = PresenceStatus.NotStarted };
        a.Totals = new PresenceTotals();
    }));

    [AvaloniaFact]
    public Task Dashboard_not_started_minimum_size() => Shoot("dashboard-not-started-minimum", Agent("08:55", a =>
    {
        a.State = AgentState.NotStarted;
        a.Workday = Days.NotStarted("08:55");
        a.Presence = new CurrentPresence { Status = PresenceStatus.NotStarted };
        a.Totals = new PresenceTotals();
    }), width: 900, height: 600);

    [AvaloniaFact]
    public Task Dashboard_end_day_comments_small_laptop() => Shoot("dialog-end-day-comments-1366x768", Agent("18:32"), vm =>
    {
        var items = new[]
        {
            new SkipCommentItemViewModel("morning-auto", "Morning break", "Auto-skipped at 12:00", 10, BreakActions.SkipChips),
            new SkipCommentItemViewModel("evening-auto", "Evening break", "Auto-skipped at 17:00", 10, BreakActions.SkipChips),
            new SkipCommentItemViewModel("lunch-auto", "Lunch break", "Auto-skipped at 14:00 on 12 Oct", 10, BreakActions.SkipChips, kind: "LUNCH"),
        };
        vm.Overlay = new EndDayDialogViewModel(items, "your manager", "Your manager");
    }, width: 1040, height: 650);

    [AvaloniaFact]
    public Task Dashboard_end_day_three_comments_default_size() => Shoot("dialog-end-day-three-comments-1080x700", Agent("18:32"), vm =>
        vm.Overlay = new EndDayDialogViewModel(EndDayFit.Items(3), "your manager", "Your manager"));

    [AvaloniaFact]
    public Task Dashboard_not_started_offline() => Shoot("dashboard-not-started-offline", Agent("09:02", a =>
    {
        a.State = AgentState.NotStarted;
        a.Workday = Days.NotStarted("09:02");
        a.Presence = new CurrentPresence { Status = PresenceStatus.NotStarted };
        a.DayKnown = false;
        a.Online = false;
        a.LastSyncAt = null;
        a.Totals = new PresenceTotals();
    }));

    [AvaloniaFact]
    public Task Dashboard_auto_skipped_and_waiting() => Shoot("dashboard-auto-skipped-waiting", Agent("12:20", a =>
    {
        a.Day = Days.General().WithRecord(Days.Skip("MORNING", "12:00", auto: true));
        a.Workday = Days.Open(serverNow: "12:20", focusSec: 2 * 3600 + 41 * 60);
        a.Workday.Focus.PendingPlusSec = 30 * 60;
        a.Workday.Focus.PendingMinusSec = 15 * 60;
        a.Workday.SkipsNeedingComment.Add(Days.NeedsComment("MORNING", "12:00"));
        a.Approvals.AddRange(Waiting());
    }));

    [AvaloniaFact]
    public Task Dashboard_skipped_with_reason() => Shoot("dashboard-skipped-reason", Agent("13:40", a =>
    {
        a.Day = Days.General()
            .WithRecord(Days.Skip("MORNING", "11:02", auto: false, reason: "Client call until noon"))
            .WithRecord(Days.Taken("LUNCH", "13:01", "13:31", duration: 30));
        a.Approvals.AddRange(Waiting().Take(1));
    }));

    /// <summary>Items waiting for the manager, and one decided today.</summary>
    private static IEnumerable<ApprovalItem> Waiting() => new[]
    {
        new ApprovalItem
        {
            Type = "MEETING", Id = "m1", Category = "MEETING_PAST", Date = "2026-10-13", Title = "Meeting: Client call with Acme",
            Detail = "10:30 to 11:00 · 30 min", Effect = new ApprovalEffect { Mode = "PLUS", Minutes = 30, Text = "+30 min if approved" },
        },
        new ApprovalItem
        {
            Type = "BREAK", Id = "b1", Category = "BREAK_AUTO_SKIP", Date = "2026-10-13", Title = "Morning break auto-skipped",
            Detail = "Auto-skipped at 12:00", NeedsComment = true,
            Effect = new ApprovalEffect { Mode = "MINUS", Minutes = 15, Text = "\u221215 min if rejected" },
        },
        new ApprovalItem
        {
            Type = "BREAK", Id = "b0", Category = "BREAK_OVERRUN", Date = "2026-10-13", Title = "Back 6 min late from lunch",
            Detail = "13:00 to 13:36", Status = "APPROVED", DecidedAt = Ist.At("09:40").ToUniversalTime(), DecidedByName = "Maya Reddy",
            Effect = new ApprovalEffect { Mode = "PLUS", Minutes = 6, Text = "+6 min added" },
        },
    };

    [AvaloniaFact]
    public Task Dashboard_day_ended() => Shoot("dashboard-day-ended", Agent("18:40", a =>
    {
        a.State = AgentState.DayEnded;
        var day = Days.General().WithRecord(Days.Taken("MORNING", "11:00", "11:14")).WithRecord(Days.Taken("LUNCH", "13:00", "13:29", duration: 30));
        day.DayEnded = true;
        a.Day = day;
        a.Presence = new CurrentPresence { Status = PresenceStatus.DayEnded };
        var ended = Days.Open(serverNow: "18:31", focusSec: 7 * 3600 + 41 * 60, running: false);
        ended.State = WorkdayStates.Ended;
        ended.EndedAt = Ist.At("18:31").ToUniversalTime();
        a.Workday = ended;
    }));

    [AvaloniaFact]
    public Task Dashboard_offline_and_banners() => Shoot("dashboard-offline-banners", Agent("10:20", a =>
    {
        a.PendingActions = 3;
        a.Online = false;
        a.PendingUpdate = new UpdateOffer("3.1.0", 90_000_000, CanInstall: false);
        a.Platform = new NoScreenRecordingPlatform(a.Dev);
    }));

    [AvaloniaFact]
    public Task Dashboard_manager_chat_picker() => Shoot("dashboard-manager-chat", Agent("10:20", a =>
    {
        a.User = new PublicUser { Id = "m-1", Email = "manager@timechamp.test", FirstName = "Maya", LastName = "Reddy", Role = "MANAGER" };
        a.FakeChat.ContactList.Clear();
        a.FakeChat.ContactList.Add(new ChatContact { UserId = "u-1", Name = "Asha Kumar", Relation = "REPORT", Role = "USER" });
        a.FakeChat.ContactList.Add(new ChatContact { UserId = "u-2", Name = "Ravi Shah", Relation = "REPORT", Role = "USER" });
        a.FakeChat.Conversation.Clear();
    }));

    [AvaloniaFact]
    public Task Dashboard_small_laptop() => Shoot("dashboard-1366x768", Agent("11:42"), width: 1040, height: 650);

    [AvaloniaFact]
    public Task Dashboard_minimum_size() => Shoot("dashboard-minimum", Agent("10:59:30"), width: 900, height: 600);

    [AvaloniaFact]
    public Task Dashboard_reason_dialog() => Shoot("dialog-reason", Agent("11:42"), vm =>
    {
        var actions = new BreakActions(new FakeAgent("11:42"), new FakeDialogs(), NullLog.Instance);
        var panel = Core.Breaks.BreakSchedule.Compute(Days.General(), Ist.At("11:42"));
        var reason = actions.ReasonFor(panel.Slots[0], panel);
        reason.Text = "On a customer call until 11:40";
        vm.Overlay = reason;
    });

    [AvaloniaFact]
    public Task Dashboard_reason_dialog_empty() => Shoot("dialog-reason-empty", Agent("10:47"), vm =>
    {
        var actions = new BreakActions(new FakeAgent("10:47"), new FakeDialogs(), NullLog.Instance);
        var panel = Core.Breaks.BreakSchedule.Compute(Days.General(), Ist.At("10:47"));
        vm.Overlay = actions.ReasonFor(panel.Slots[0], panel);
    });

    [AvaloniaFact]
    public Task Dashboard_confirm_dialog() => Shoot("dialog-end-day", Agent("17:30"), vm =>
        vm.Overlay = new MessageDialogViewModel("End your working day?",
            "Your focus time stops now and today's day is saved as it is. If you need to, you can start your day again from here.")
        { PrimaryText = "End Day", CancelText = "Keep working", IsDanger = true });

    [AvaloniaFact]
    public Task Dashboard_meeting_dialog_now() => Shoot("dialog-meeting-now", Agent("10:20"), vm =>
    {
        var agent = new FakeAgent("10:20");
        var actions = new BreakActions(agent, new FakeDialogs(), NullLog.Instance);
        var dialog = new MeetingDialogViewModel(actions.MeetingContext()) { Agenda = "Sprint planning for the invoice release" };
        dialog.LoadSuggestionsAsync().GetAwaiter().GetResult();
        dialog.Suggestions.First(s => s.Label == "+ Maya Reddy").AddCommand.Execute(null);
        dialog.PersonQuery = "Vikram (Pune)";
        dialog.AddTypedCommand.Execute(null);
        vm.Overlay = dialog;
    }, height: 760);

    [AvaloniaFact]
    public Task Dashboard_meeting_dialog_past() => Shoot("dialog-meeting-past", Agent("12:20"), vm =>
    {
        var agent = new FakeAgent("12:20");
        var actions = new BreakActions(agent, new FakeDialogs(), NullLog.Instance);
        var dialog = new MeetingDialogViewModel(actions.MeetingContext()) { IsPast = true, Agenda = "Client call with Acme about the renewal" };
        dialog.LoadSuggestionsAsync().GetAwaiter().GetResult();
        dialog.Suggestions.First(s => s.Label == "+ Praveen Kumar").AddCommand.Execute(null);
        dialog.StartAt = dialog.StartOptions.First(o => o.Label == "10:45 AM");
        dialog.Durations.First(d => d.Minutes == 45).PickCommand.Execute(null);
        dialog.Error = actions.MeetingMessage("MEETING_OVERLAPS_BREAK", "", new MeetingClash
        {
            Kind = "BREAK", StartedAt = Ist.At("11:00").ToUniversalTime(), EndedAt = Ist.At("11:15").ToUniversalTime(),
        });
        vm.Overlay = dialog;
    }, height: 760);

    [AvaloniaFact]
    public Task Dashboard_end_break_late_dialog() => Shoot("dialog-end-break-late", Agent("11:31:12", a =>
    {
        a.Day = Days.General().WithActive(Days.Running("MORNING", "11:01"));
        a.Presence = new CurrentPresence { Status = PresenceStatus.Break, Since = Ist.At("11:01") };
    }), vm =>
    {
        var agent = new FakeAgent("11:31:12");
        agent.Day = Days.General().WithActive(Days.Running("MORNING", "11:01"));
        var actions = new BreakActions(agent, new FakeDialogs(), NullLog.Instance);
        vm.Overlay = actions.ConfirmEnd(agent.BreakPanel.Active!);
    });

    [AvaloniaFact]
    public Task Dashboard_start_dialog_with_skip() => Shoot("dialog-start-with-skip", Agent("10:59:30"), vm =>
    {
        var agent = new FakeAgent("10:59:30");
        var actions = new BreakActions(agent, new FakeDialogs(), NullLog.Instance);
        vm.Overlay = actions.ConfirmStart(agent.BreakPanel.Slots[0]);
    });

    [AvaloniaFact]
    public Task Dashboard_skip_dialog() => Shoot("dialog-skip", Agent("10:59:30"), vm =>
    {
        var agent = new FakeAgent("10:59:30");
        var actions = new BreakActions(agent, new FakeDialogs(), NullLog.Instance);
        var dialog = actions.SkipDialog(agent.BreakPanel.Slots[0], 10, offerBack: true);
        dialog.Chips[0].PickCommand.Execute(null);
        vm.Overlay = dialog;
    });

    [AvaloniaFact]
    public Task Dashboard_comment_dialog() => Shoot("dialog-comment", Agent("12:10", a => a.Day = Days.General().WithRecord(Days.Skip("MORNING", "12:00", auto: true))), vm =>
    {
        var actions = new BreakActions(new FakeAgent("12:10"), new FakeDialogs(), NullLog.Instance);
        vm.Overlay = actions.CommentDialog("Morning break", "closed 12:00", 10);
    });

    [AvaloniaFact]
    public Task Dashboard_end_day_comments_dialog() => Shoot("dialog-end-day-comments", Agent("18:32"), vm =>
    {
        var items = new[]
        {
            new SkipCommentItemViewModel("morning-auto", "Morning break", "Auto-skipped at 12:00", 10, BreakActions.SkipChips, "The client demo ran until 12:15"),
            new SkipCommentItemViewModel("evening-auto", "Evening break", "Auto-skipped at 17:00", 10, BreakActions.SkipChips, "Deadline"),
            new SkipCommentItemViewModel("lunch-auto", "Lunch break", "Auto-skipped at 14:00 on 12 Oct", 10, BreakActions.SkipChips),
        };
        vm.Overlay = new EndDayDialogViewModel(items, "your manager", "Your manager");
    }, height: 760);

    [AvaloniaFact]
    public Task Dashboard_overdue_dialog() => Shoot("dialog-approvals-overdue", Agent("18:32", a => a.User!.Role = "MANAGER"), vm =>
        vm.Overlay = new MessageDialogViewModel("Approvals are past 48 hours", "3 approvals are past 48 hours. Decide them in the portal to end your day.")
        { PrimaryText = "Open approvals", CancelText = "Close" });


    // ---- Sign-in and notice -----------------------------------------------------------------------

    private static string ShootWindow(Window window, string name)
    {
        window.Show();
        var path = Shots.Save(window, name);
        Assert.True(new FileInfo(path).Length > 5_000, $"{name} looks empty");
        return path;
    }

    [AvaloniaFact]
    public void Sign_in()
    {
        var vm = new SignInViewModel(new FakeAgent(), null, NullLog.Instance) { Email = "asha@timechamp.test" };
        var window = new SignInWindow { DataContext = vm };
        ShootWindow(window, "signin");
        vm.Error = "Wrong email or password.";
        vm.ShowAdvanced = true;
        Shots.Save(window, "signin-error-advanced");
        window.AllowClose = true;
        window.Close();
    }

    [AvaloniaFact]
    public void Sign_in_with_setup_code()
    {
        var vm = new SignInViewModel(new FakeAgent(), null, NullLog.Instance);
        vm.ToggleModeCommand.Execute(null);
        vm.SetupCode = "RXV1.eyJBcGlCYXNlVXJsIjoiaHR0cHM6Ly9hcGkucnh2aXNpb24uc2hvcC9hcGkvdjEiLCJFbnJvbGxtZW50VG9rZW4iOiJleUpoYkdjaU9pSklVekkxTmlKOS4uLiJ9";
        var window = new SignInWindow { DataContext = vm };
        ShootWindow(window, "signin-setup-code");
        window.AllowClose = true;
        window.Close();
    }

    [AvaloniaFact]
    public void Sign_in_reconnecting_and_session_lost()
    {
        var vm = new SignInViewModel(new FakeAgent(), null, NullLog.Instance);
        vm.Prepare(AgentState.Connecting);
        var window = new SignInWindow { DataContext = vm };
        ShootWindow(window, "signin-connecting");
        var lost = new SignInViewModel(new FakeAgent(), null, NullLog.Instance) { Email = "asha@timechamp.test" };
        lost.SetSessionLost("Your session has ended. Please sign in again.");
        window.DataContext = lost;
        Shots.Save(window, "signin-session-lost");
        window.AllowClose = true;
        window.Close();
    }

    [AvaloniaFact]
    public void Notice()
    {
        var window = new NoticeWindow { DataContext = new NoticeViewModel(new FakeAgent(), NullLog.Instance) };
        ShootWindow(window, "notice");
        window.AllowClose = true;
        window.Close();
    }

    [AvaloniaFact]
    public async Task Standalone_dialog()
    {
        // 4.0: only an Admin or Super Admin can quit, with a key (SPEC 2.8).
        var dialog = new KeyDialogViewModel("Quit RX Vision?",
            "Tracking stops until RX Vision is opened again. Enter a sign-out key from the portal to quit.", "Quit") { IsDanger = true };
        var window = new DialogWindow { DataContext = dialog };
        ShootWindow(window, "dialog-quit-key-standalone");
        window.Close();
        Assert.False(await dialog.Completion);
    }

    // ---- Toasts -------------------------------------------------------------------------------------

    private static void ShootToast(ToastViewModel toast, string name, int minBytes = 5_000)
    {
        var window = new ToastWindow { DataContext = toast, Animate = false };
        window.ShowBeside(new PixelRect(1690, 470, 88, 88), new PixelPoint(1734, 514));
        window.Background = Desktop;
        var path = Shots.Save(window, name);
        Assert.True(new FileInfo(path).Length > minBytes, $"{name} looks empty");
        window.Close();
    }

    [AvaloniaFact]
    public void Toast_message() => ShootToast(new ToastViewModel(ToastKind.Message, "chat:m-1")
    {
        Heading = "New message", Title = "Maya Reddy", Initials = "MR", Stamp = "15:42",
        Body = "Can you join the 4 pm call with the Pune team? We need your numbers for the quarterly review.",
        PrimaryText = "View messages",
    }, "toast-message");

    [AvaloniaFact]
    public void Toast_ring()
    {
        var agent = new FakeAgent("10:59:30");
        ShootToast(Toasts.Ring(agent, agent.Ring!, () => { }, () => { }, () => { }), "toast-ring");
    }

    [AvaloniaFact]
    public void Toast_auto_skipped()
    {
        var agent = new FakeAgent("12:02");
        ShootToast(Toasts.AutoSkipped(agent, Days.Skip("MORNING", "12:00", auto: true), () => { }, () => { }), "toast-auto-skipped");
    }

    [AvaloniaFact]
    public void Toast_good_morning()
    {
        var agent = new FakeAgent("08:55") { State = AgentState.NotStarted };
        ShootToast(Toasts.Nudge(agent, new AgentNudge(NudgeKind.Greeting, "2026-10-13"), () => { }, () => { }), "toast-good-morning");
    }

    [AvaloniaFact]
    public void Toast_at_your_desk()
    {
        var agent = new FakeAgent("09:12") { State = AgentState.NotStarted };
        ShootToast(Toasts.Nudge(agent, new AgentNudge(NudgeKind.AtDesk, "2026-10-13"), () => { }, () => { }), "toast-at-desk");
    }

    [AvaloniaFact]
    public void Toast_cue() => ShootToast(Toasts.Cue("Skipped and noted. Keep it steady."), "toast-cue", minBytes: 1_500);

    [AvaloniaFact]
    public void Toast_decision() => ShootToast(new ToastViewModel(ToastKind.BreakDecision, "note:1")
    {
        Heading = "Break update", Title = "Your morning break on 13 Oct was rejected", Stamp = "16:05",
        Body = "Maya Reddy: Please plan calls around breaks", IsRejected = true,
    }, "toast-decision");

    [AvaloniaFact]
    public void Toast_approval_request() => ShootToast(new ToastViewModel(ToastKind.Approval, "note:2")
    {
        Heading = "Approval needed", Title = "Asha Kumar started the morning break 12 min late", Stamp = "11:12",
        Body = "On a customer call until now",
    }, "toast-approval");

    // ---- The floating button ------------------------------------------------------------------------

    private static void ShootBubble(FakeAgent agent, string name, int unread = 0)
    {
        agent.ChatUnread = unread;
        var vm = new BubbleViewModel();
        vm.Update(agent);
        var window = new BubbleWindow { DataContext = vm };
        window.Show();
        window.Background = Desktop;
        var path = Shots.Save(window, name);
        Assert.True(new FileInfo(path).Length > 2_000);
        window.Close();
    }

    [AvaloniaFact]
    public void Bubble_working() => ShootBubble(Agent("10:20"), "bubble-working");

    [AvaloniaFact]
    public void Bubble_working_unread() => ShootBubble(Agent("10:20"), "bubble-unread", unread: 3);

    [AvaloniaFact]
    public void Bubble_ringing() => ShootBubble(Agent("10:59:30"), "bubble-ringing", unread: 1);

    [AvaloniaFact]
    public void Bubble_on_break() => ShootBubble(Agent("11:05", a => a.Day = Days.General().WithActive(Days.Running("MORNING", "11:00"))), "bubble-on-break");

    [AvaloniaFact]
    public void Bubble_overrun() => ShootBubble(Agent("11:20", a => a.Day = Days.General().WithActive(Days.Running("MORNING", "11:00"))), "bubble-overrun");

    [AvaloniaFact]
    public void Bubble_meeting() => ShootBubble(Agent("10:20", a => a.Presence = new CurrentPresence { Status = PresenceStatus.Meeting }), "bubble-meeting");

    [AvaloniaFact]
    public void Bubble_day_ended() => ShootBubble(Agent("18:40", a => a.State = AgentState.DayEnded), "bubble-day-ended");

    [AvaloniaFact]
    public void Bubble_not_started() => ShootBubble(Agent("08:55", a => a.State = AgentState.NotStarted), "bubble-not-started");
}
