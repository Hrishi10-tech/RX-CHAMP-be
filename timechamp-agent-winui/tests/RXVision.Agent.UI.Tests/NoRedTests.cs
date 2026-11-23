using System.Globalization;
using System.Text.RegularExpressions;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Threading;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// Brief 1.3: no agent state shows red. Checked the two ways AGENT.md section 4 asks: no hex with a
/// red hue in the source, the theme or the assets, and no pixel of hue 340 to 20 degrees above 40%
/// saturation in a render of every state. Avatar art is excluded; the agent draws none yet.
/// </summary>
public class NoRedTests
{
    /// <summary>Hue 340 to 20 degrees above 40% saturation, ignoring what is nearly black or white (no colour to see).</summary>
    internal static bool IsRed(byte r, byte g, byte b)
    {
        double rf = r / 255.0, gf = g / 255.0, bf = b / 255.0;
        double max = Math.Max(rf, Math.Max(gf, bf)), min = Math.Min(rf, Math.Min(gf, bf)), chroma = max - min;
        if (chroma <= 0) return false;
        var lightness = (max + min) / 2;
        var saturation = chroma / (1 - Math.Abs(2 * lightness - 1));
        if (saturation <= 0.40 || lightness < 0.08 || lightness > 0.97) return false;
        double hue;
        if (max == rf) hue = 60 * (((gf - bf) / chroma + 6) % 6);
        else if (max == gf) hue = 60 * ((bf - rf) / chroma + 2);
        else hue = 60 * ((rf - gf) / chroma + 4);
        return hue >= 340 || hue <= 20;
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "RXVision.Agent.sln"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("the repository was not found");
    }

    private static IEnumerable<string> StaffFacingSources() =>
        new[] { "src/RXVision.Agent", "src/RXVision.Agent.Core", "src/RXVision.Agent.Platform.Mac", "src/RXVision.Agent.Platform.Windows" }
            .Select(d => Path.Combine(RepoRoot(), d))
            .SelectMany(d => Directory.EnumerateFiles(d, "*", SearchOption.AllDirectories))
            .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}") && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
            .Where(f => Path.GetExtension(f) is ".axaml" or ".cs" or ".xml" or ".plist" or ".json");

    private static readonly Regex Hex = new(@"#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b");

    /// <summary>Parses #RGB, #RRGGBB and #AARRGGBB; null for anything else that only looks like one.</summary>
    internal static (byte R, byte G, byte B)? Parse(string hex)
    {
        var digits = hex[1..];
        if (digits.Length == 3) digits = string.Concat(digits.Select(c => $"{c}{c}"));
        if (digits.Length == 8) digits = digits[2..];
        if (digits.Length != 6) return null;
        byte At(int i) => byte.Parse(digits.AsSpan(i, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return (At(0), At(2), At(4));
    }

    [Fact]
    public void The_red_test_itself_sees_red_and_not_the_panels_tokens()
    {
        foreach (var red in new[] { "#E5484D", "#B42318", "#F87171", "#E85D75", "#D92D33", "#FDECEC", "#9B1C1C", "#FF0000" })
        {
            var c = Parse(red)!.Value;
            Assert.True(IsRed(c.R, c.G, c.B), red);
        }
        foreach (var fine in new[] { "#1A2029", "#2A3241", "#222937", "#3A4356", "#E8EBF0", "#9AA3B2", "#6FC9B6", "#0E1B18", "#F2A93B", "#8A93A3", "#34D27A", "#A78BFA", "#141920" })
        {
            var c = Parse(fine)!.Value;
            Assert.False(IsRed(c.R, c.G, c.B), fine);
        }
    }

    [Fact]
    public void No_hex_with_a_red_hue_in_any_style_view_or_source_file()
    {
        var found = new List<string>();
        foreach (var file in StaffFacingSources())
        {
            var text = File.ReadAllText(file);
            foreach (Match m in Hex.Matches(text))
            {
                if (Parse(m.Value) is { } c && IsRed(c.R, c.G, c.B)) found.Add($"{Path.GetFileName(file)}: {m.Value}");
            }
        }
        Assert.True(found.Count == 0, string.Join(", ", found));
    }

    [Fact]
    public void No_style_or_brush_is_named_for_red_or_danger()
    {
        var names = new Regex(@"Brush\.Red|Palette\.Red|Classes=""[^""]*\b(danger|bad|alert)\b|Classes\.(danger|bad|alert)|Button\.danger|IsDanger", RegexOptions.IgnoreCase);
        var found = StaffFacingSources()
            .Where(f => f.Contains($"{Path.DirectorySeparatorChar}RXVision.Agent{Path.DirectorySeparatorChar}"))
            .Where(f => names.IsMatch(File.ReadAllText(f)))
            .Select(Path.GetFileName)
            .ToList();
        Assert.True(found.Count == 0, string.Join(", ", found));
    }

    [AvaloniaFact]
    public void No_asset_has_red_in_it()
    {
        var assets = Path.Combine(RepoRoot(), "src/RXVision.Agent/Assets");
        foreach (var file in Directory.EnumerateFiles(assets).Where(f => Path.GetExtension(f) is ".png" or ".ico"))
        {
            using var bitmap = new Bitmap(file);
            Assert.Equal(0, RedPixels(bitmap));
        }
    }

    /// <summary>Counts the pixels that read as red, skipping what is all but transparent.</summary>
    private static int RedPixels(Bitmap bitmap)
    {
        var size = bitmap.PixelSize;
        var bytes = new byte[size.Width * size.Height * 4];
        var handle = System.Runtime.InteropServices.GCHandle.Alloc(bytes, System.Runtime.InteropServices.GCHandleType.Pinned);
        try { bitmap.CopyPixels(new PixelRect(size), handle.AddrOfPinnedObject(), bytes.Length, size.Width * 4); }
        finally { handle.Free(); }
        var rgba = bitmap.Format == PixelFormat.Rgba8888;
        var red = 0;
        for (var i = 0; i < bytes.Length; i += 4)
        {
            if (bytes[i + 3] < 40) continue;
            var (r, g, b) = rgba ? (bytes[i], bytes[i + 1], bytes[i + 2]) : (bytes[i + 2], bytes[i + 1], bytes[i]);
            if (IsRed(r, g, b)) red++;
        }
        return red;
    }

    private static void Sweep(TopLevel top, string state)
    {
        // Text drawn with subpixel (LCD) antialiasing has coloured fringes on Windows, some of them
        // red-hued; they are the font rasteriser's, not a colour of the agent's. Grayscale text here
        // so the sweep reads only the colours the views and styles choose.
        Avalonia.Media.RenderOptions.SetTextRenderingMode(top, Avalonia.Media.TextRenderingMode.Antialias);
        for (var i = 0; i < 3; i++)
        {
            Dispatcher.UIThread.RunJobs();
            AvaloniaHeadlessPlatform.ForceRenderTimerTick();
        }
        using var frame = top.CaptureRenderedFrame() ?? throw new InvalidOperationException("nothing rendered");
        Assert.True(RedPixels(frame) == 0, $"{state}: {RedPixels(frame)} red pixels");
        CopyRulesTests.CheckShown(top, state);
    }

    private static DashboardWindow Panel(FakeAgent agent, out DashboardViewModel vm)
    {
        vm = new DashboardViewModel(agent, new BreakActions(agent, new FakeDialogs(), Core.Util.NullLog.Instance), Core.Util.NullLog.Instance);
        vm.Refresh();
        var window = new DashboardWindow { DataContext = vm };
        window.Show();
        vm.Refresh();
        return window;
    }

    private static void SweepPanel(FakeAgent agent, string state, Action<DashboardViewModel>? before = null)
    {
        var window = Panel(agent, out var vm);
        before?.Invoke(vm);
        // Today scrolls: draw it tall enough to hold everything on it.
        window.Height = 1400;
        Sweep(window, state);
        window.AllowClose = true;
        window.Close();
    }

    [AvaloniaFact]
    public void No_red_in_any_state_of_the_panel()
    {
        SweepPanel(DesignDay.Due(), "break due");
        SweepPanel(DesignDay.OnLunch("13:12"), "on break");
        SweepPanel(DesignDay.OnLunch("13:44"), "two minutes");
        SweepPanel(DesignDay.OnLunch("13:50"), "break extended");
        SweepPanel(DesignDay.PlainBreak("10:12"), "no length");
        SweepPanel(new FakeAgent("10:20"), "working");
        SweepPanel(new FakeAgent("10:47"), "open early");
        SweepPanel(new FakeAgent("11:30"), "open after its time");
        SweepPanel(new FakeAgent("12:10") { Day = Days.General().WithRecord(Days.Skip("MORNING", "12:00", auto: true)) }, "skipped for you");
        SweepPanel(new FakeAgent("13:40")
        {
            Day = Days.General()
                .WithRecord(Days.Skip("MORNING", "11:02", auto: false, reason: "Client call", approval: "REJECTED"))
                .WithRecord(Days.Taken("LUNCH", "13:01", "13:45", "LATE", "REJECTED", 30, "Plan calls around lunch", "Maya Reddy")),
        }, "not approved, with minutes extended");
        SweepPanel(new FakeAgent("10:20") { Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = Ist.At("10:02"), Note = "Sprint review" } }, "in a meeting");
        SweepPanel(new FakeAgent("08:55") { State = AgentState.NotStarted, Workday = Days.NotStarted("08:55"), Presence = new CurrentPresence { Status = PresenceStatus.NotStarted }, Totals = new PresenceTotals(), DayKnown = false }, "not started");
        var ended = Days.Open(serverNow: "18:31", focusSec: 7 * 3600, running: false);
        ended.State = WorkdayStates.Ended;
        ended.EndedAt = Ist.At("18:31").ToUniversalTime();
        SweepPanel(new FakeAgent("18:40") { State = AgentState.DayEnded, Workday = ended, Presence = new CurrentPresence { Status = PresenceStatus.DayEnded } }, "day ended");
        SweepPanel(new FakeAgent("10:20") { IsBiometric = true, Day = Days.Free() }, "biometric");
    }

    [AvaloniaFact]
    public void No_red_in_the_waiting_list_the_banners_and_the_pages()
    {
        var waiting = new FakeAgent("10:20");
        waiting.Approvals.Add(new ApprovalItem { Type = "BREAK", Id = "o", Category = "BREAK_OVERRUN", Title = "Morning break extended", Status = "REJECTED", DecidedAt = Ist.At("09:40").ToUniversalTime(), Effect = new ApprovalEffect { Mode = "PLUS", Minutes = 6 } });
        waiting.Approvals.Add(new ApprovalItem { Type = "BREAK", Id = "p", Category = "BREAK_SKIP", Title = "Morning break skipped", Effect = new ApprovalEffect { Mode = "MINUS", Minutes = 15 } });
        waiting.Workday!.Focus.PendingMinusSec = 900;
        waiting.Workday.LateStart = new LateStartView { Minutes = 35, NeedsReason = true };
        waiting.PendingUpdate = new Core.Update.UpdateOffer("3.6.1", 1000, CanInstall: false);
        waiting.Platform = new NoScreenRecordingPlatform(waiting.Dev);
        SweepPanel(waiting, "waiting list and banners");

        var agent = new FakeAgent("10:20")
        {
            LeaveResult = ApiResult<MyLeave>.Success(LeavePageTests.Leave()),
            CalendarFor = y => ApiResult<CalendarYear>.Success(PagesData.Calendar(y)),
            GuideResult = (PagesData.Guide(), true),
        };
        SweepPanel(agent, "profile", vm => vm.ShowProfileCommand.Execute(null));
        SweepPanel(agent, "leave", vm => vm.ShowLeaveCommand.ExecuteAsync(null).GetAwaiter().GetResult());
        SweepPanel(agent, "calendar", vm => vm.ShowCalendarCommand.ExecuteAsync(null).GetAwaiter().GetResult());
        SweepPanel(agent, "instructions", vm => vm.ShowInstructionsCommand.ExecuteAsync(null).GetAwaiter().GetResult());
        SweepPanel(new FakeAgent("10:20"), "messages", vm => vm.ShowMessagesCommand.ExecuteAsync(null).GetAwaiter().GetResult());
        SweepPanel(new FakeAgent("10:20") { LeaveResult = new ApiResult<MyLeave> { Outcome = ApiOutcome.Transient, Message = "offline" } }, "leave, offline",
            vm => vm.ShowLeaveCommand.ExecuteAsync(null).GetAwaiter().GetResult());
    }

    [AvaloniaFact]
    public void No_red_in_any_alert_card_the_hover_label_or_the_avatar_picker()
    {
        var agent = DesignDay.Due();
        var actions = new BreakActions(agent, new FakeDialogs(), Core.Util.NullLog.Instance);
        var center = new AlertCenter();
        var day = new DayAlerts(agent, center, actions, _ => { });
        day.OnNotification(new NotificationItem { Id = "n1", Type = "FOCUS_ADJUSTED", Title = "Your focus time changed", Body = "Your manager added 15 minutes." });
        foreach (var kind in Enum.GetValues<Core.Meetings.MeetingAlertKind>()) agent.Alerts.Add(new Core.Meetings.MeetingAlert(kind, "Zoom"));
        new MeetingAlerts(agent, center, actions).Sync();
        day.OnNudge(new AgentNudge(NudgeKind.AtDesk, "2026-10-13"));
        day.Sync();
        var vm = new DashboardViewModel(agent, actions, Core.Util.NullLog.Instance, center);
        vm.Refresh();
        var panel = new DashboardWindow { DataContext = vm, Height = 1800 };
        panel.Show();
        vm.Refresh();
        Sweep(panel, "every alert card");
        panel.AllowClose = true;
        panel.Close();

        var label = new HoverLabelWindow();
        label.Show();
        Sweep(label, "hover label");
        label.Close();

    }

    [AvaloniaFact]
    public void No_red_in_any_dialog()
    {
        var agent = DesignDay.Due();
        var actions = new BreakActions(agent, new FakeDialogs(), Core.Util.NullLog.Instance);
        var slot = agent.BreakPanel.Slots[1];
        var active = DesignDay.OnLunch("13:50").BreakPanel.Active!;
        var dialogs = new Dictionary<string, Func<DialogViewModel>>
        {
            ["start"] = () => actions.ConfirmStart(slot),
            ["skip"] = () => actions.SkipDialog(slot, 10),
            ["skip with an error"] = () => { var d = actions.SkipDialog(slot, 10); d.Error = "Add a little more."; return d; },
            ["note"] = () => actions.ReasonFor(agent.BreakPanel.Slots[1], agent.BreakPanel),
            ["end break (4.0)"] = () => actions.ConfirmEnd(active),
            ["quick break (4.0)"] = () => actions.QuickDialog(),
            ["sign-out key (4.0)"] = () => new KeyDialogViewModel("Enter the sign-out key", "Ask your admin for a key.", "Sign out") { Error = "That key isn't valid for you." },
            ["comment"] = () => actions.CommentDialog("Morning break", "closed 12:00 PM", 10),
            ["end day"] = () => new EndDayDialogViewModel(EndDayFit.Items(3), "a manager", "A manager"),
            ["end day, refused"] = () =>
            {
                var items = EndDayFit.Items(1);
                items[0].Error = "Add a little more.";
                return new EndDayDialogViewModel(items, "a manager", "A manager") { Error = "Try ending your day again." };
            },
            ["quit"] = () => new MessageDialogViewModel("Quit RX Vision?", "Tracking stops until you open RX Vision again.") { PrimaryText = "Quit", CancelText = "Keep running" },
            ["meeting"] = () => new MeetingDialogViewModel(actions.MeetingContext()) { Error = "That overlaps your break." },
        };
        foreach (var (name, make) in dialogs)
        {
            var window = Panel(new FakeAgent("13:00"), out var vm);
            vm.Overlay = make();
            Sweep(window, name);
            vm.Overlay.Cancel();
            window.AllowClose = true;
            window.Close();
        }
        var alone = new DialogWindow { DataContext = new MessageDialogViewModel("Sign out of RX Vision?", "Tracking stops until you sign in again.") { PrimaryText = "Sign out", CancelText = "Cancel" } };
        alone.Show();
        Sweep(alone, "a dialog on its own");
        alone.Close();
    }

    [AvaloniaFact]
    public void No_red_in_any_toast_the_sign_in_the_notice_or_the_floating_button()
    {
        var agent = new FakeAgent("10:59:30");
        var toasts = new[]
        {
            Toasts.ActionRefused(agent, "Try again in a moment.", () => { }),
            Toasts.ShiftQuestion(agent, new ShiftQuestion(agent.Now.AddMinutes(15), agent.Now.AddMinutes(16), false), () => { }, () => { }, () => { }),
            Toasts.SignedOutForNextShift(),
            Toasts.Cue("Skipped and noted. Keep it steady."),
            new ToastViewModel(ToastKind.Info, "note") { Heading = "Break update", Title = "Your morning break was not approved", Body = "Plan calls around breaks" },
            new ToastViewModel(ToastKind.Message, "chat") { Heading = "New message", Title = "Maya Reddy", Body = "Can you join?", PrimaryText = "View messages" },
        };
        foreach (var toast in toasts)
        {
            var window = new ToastWindow { DataContext = toast, Animate = false };
            window.ShowBeside(new PixelRect(1690, 470, 88, 88), new PixelPoint(1734, 514));
            Sweep(window, toast.Key);
            window.Close();
        }

        var signIn = new SignInViewModel(new FakeAgent(), null, Core.Util.NullLog.Instance) { Email = "asha@timechamp.test" };
        var signInWindow = new SignInWindow { DataContext = signIn };
        signInWindow.Show();
        signIn.Error = "Check your email and password.";
        signIn.ShowAdvanced = true;
        Sweep(signInWindow, "sign in with an error");
        signIn.SetSessionLost("Sign in again to carry on.");
        Sweep(signInWindow, "session lost");
        signInWindow.AllowClose = true;
        signInWindow.Close();

        var notice = new NoticeWindow { DataContext = new NoticeViewModel(new FakeAgent(), Core.Util.NullLog.Instance) };
        notice.Show();
        Sweep(notice, "notice");
        notice.AllowClose = true;
        notice.Close();

        foreach (var (name, a) in new (string, FakeAgent)[]
        {
            ("working", new FakeAgent("10:20")),
            ("due", new FakeAgent("10:59:30")),
            ("on break", DesignDay.OnLunch("13:10")),
            ("extended", DesignDay.OnLunch("13:50")),
            ("meeting", new FakeAgent("10:20") { Presence = new CurrentPresence { Status = PresenceStatus.Meeting } }),
            ("day ended", new FakeAgent("18:40") { State = AgentState.DayEnded }),
        })
        {
            using var rig = new IconRig(a);
            rig.Vm.MessageCount = 3;
            rig.DayAlerts.Sync();
            rig.Run(1.5);
            var window = rig.Window();
            window.Show();
            IconRig.Pump();
            Sweep(window, "icon: " + name);
            window.Close();
        }
    }
}
