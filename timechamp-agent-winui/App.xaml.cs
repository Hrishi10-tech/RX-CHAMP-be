using System.Threading;
using CommunityToolkit.Mvvm.Input;
using H.NotifyIcon;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using TimeChampAgent.Helpers;
using TimeChampAgent.Services;
using TimeChampAgent.Views;

namespace TimeChampAgent;

public partial class App : Application
{
    private static Mutex? _singleInstance;

    public static AgentConfig Config { get; private set; } = new();
    public static ApiClient Api { get; private set; } = null!;
    public static ChatService Chat { get; private set; } = null!;
    public static ScreenshotService Shots { get; private set; } = null!;
    public static ActivityService Activity { get; private set; } = null!;

    public static App Instance { get; private set; } = null!;

    private DispatcherQueue _ui = null!;
    private TaskbarIcon? _tray;
    private DispatcherQueueTimer? _heartbeat;
    private MainWindow? _dashboard;
    private LoginWindow? _login;
    private FloatingButtonWindow? _bubble;
    private DispatcherQueueTimer? _bubbleWatch;
    private bool _dayEnded;
    /// <summary>Set once the session was lost, so every stalled loop reporting the same
    /// failure doesn't re-run the teardown.</summary>
    private bool _sessionLost;
    /// <summary>On a break / at lunch / in a meeting, as last set from a menu — used to
    /// colour the floating button before the dashboard has ever been opened.</summary>
    private bool _awayFromDesk;

    public App()
    {
        InitializeComponent();
        Instance = this;
        UnhandledException += (_, e) =>
        {
            Log("UNHANDLED: " + e.Message + "\n" + e.Exception);
            e.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log("DOMAIN: " + e.ExceptionObject);
        TaskScheduler.UnobservedTaskException += (_, e) => Log("TASK: " + e.Exception);
    }

    internal static void Log(string message)
    {
        try
        {
            var path = System.IO.Path.Combine(AppContext.BaseDirectory, "winui-crash.log");
            System.IO.File.AppendAllText(path, $"[{DateTime.Now:HH:mm:ss}] {message}\n\n");
        }
        catch { }
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        try { await LaunchAsync(); }
        catch (Exception ex) { Log("OnLaunched: " + ex); }
    }

    private async Task LaunchAsync()
    {
        // Single instance — a second launch just exits so we never double-track.
        _singleInstance = new Mutex(initiallyOwned: true, "TimeChampAgent.SingleInstance", out var isNew);
        if (!isNew) { Environment.Exit(0); return; }

        _ui = DispatcherQueue.GetForCurrentThread();

        Config = AgentConfig.Load();
        SessionStore.Configure(Config);
        Api = new ApiClient(Config);
        Api.SessionLost += OnSessionLost;
        Chat = new ChatService(Api);
        Chat.MessageReceived += OnChatMessage;
        Shots = new ScreenshotService(Api);
        Activity = new ActivityService(Api, Config);
        Activity.DayEnded += OnDayEnded;
        // A manager can switch a user's automatic screenshots off; the server tells us
        // on every report. Stops the 5-minute capture only — tracking and the manager's
        // manual capture both carry on.
        Activity.ScreenshotsEnabledChanged += (enabled) =>
            _ui.TryEnqueue(() => Shots.SetAutoEnabled(enabled));

        BuildTray();
        BuildHeartbeat(); // created stopped; started with the rest of tracking

        var startMinimized = Environment.GetCommandLineArgs().Contains("--minimized");
        var restored = await Api.TryRestoreSessionAsync();

        var freshlyEnrolled = false;
        if (!restored && !string.IsNullOrEmpty(Config.EnrollmentToken))
        {
            var (ok, _) = await Api.EnrollAsync(Config.EnrollmentToken!);
            restored = ok;
            freshlyEnrolled = ok;
            if (ok) StartupRegistration.Enable();
        }

        if (restored)
        {
            // Ask the server before starting anything. Without this a restart after
            // "End Day" re-arms tracking and fires one immediate screenshot before
            // the first report comes back and shuts it down again.
            _dayEnded = await Api.IsDayEndedAsync();
            Chat.Start();
            if (!_dayEnded) StartTracking();
            ShowBubble(); // stays up even when we start minimised — that's the point of it
            if (!startMinimized) ShowDashboard();
            if (freshlyEnrolled) await ShowDisclosureAsync();
        }
        else
        {
            ShowLogin();
        }
    }

    /// <summary>Starts everything that records the working day. Attendance included —
    /// after "End Day" nothing may keep counting, so the heartbeat lives here too.</summary>
    private void StartTracking()
    {
        Shots.Start();
        Activity.Start();
        _heartbeat?.Start();
    }

    private async Task ShowDisclosureAsync()
    {
        if (_dashboard?.Content?.XamlRoot is null) return;
        await Dialogs.NoticeAsync(_dashboard.Content.XamlRoot,
            "RX Vision — attendance & activity monitoring",
            "RX Vision is now active on this device.\n\n" +
            "Your employer uses it to record working hours, breaks, and lunch for attendance; " +
            "to log which applications and websites you use during work hours and your idle time; " +
            "and to take periodic screenshots of your screen (about every 5 minutes, and when a " +
            "manager requests one) for work monitoring.\n\n" +
            "Use the round button on the right of your screen to open it any time and see " +
            "your own totals. You can drag that button anywhere if it's in your way.");
    }

    // ---- Tray --------------------------------------------------------------

    private void BuildTray()
    {
        _tray = new TaskbarIcon
        {
            ToolTipText = "RX Vision",
            Icon = System.Drawing.SystemIcons.Application,
            LeftClickCommand = new RelayCommand(ShowDashboard),
        };

        var menu = new MenuFlyout();
        menu.Items.Add(NewItem("Open dashboard", ShowDashboard));
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(NewItem("Start break", () => _ = QuickStatus("BREAK")));
        menu.Items.Add(NewItem("Start lunch", () => _ = QuickStatus("LUNCH")));
        menu.Items.Add(NewItem("Back to working", () => _ = QuickEnd()));
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(NewItem("End day", () => _ = EndWorkingDayAsync(confirm: true)));
        menu.Items.Add(NewItem("Start day", () => _ = StartWorkingDayAsync()));
        menu.Items.Add(NewItem("Sign out", () => _ = SignOut()));
        menu.Items.Add(NewItem("Exit", ExitApp));
        _tray.ContextFlyout = menu;

        _tray.ForceCreate();
    }

    private static MenuFlyoutItem NewItem(string text, Action onClick)
    {
        var item = new MenuFlyoutItem { Text = text };
        item.Click += (_, _) => onClick();
        return item;
    }

    private async Task QuickStatus(string type)
    {
        if (!Api.IsAuthenticated) { ShowLogin(); return; }
        if (_dayEnded) return; // nothing more is recorded once the day is over
        await Api.StartAsync(type, null);
        _awayFromDesk = true;
        if (_dashboard is not null) await _dashboard.ViewModel.RefreshAsync();
        RefreshBubbleStatus();
    }

    private async Task QuickEnd()
    {
        if (!Api.IsAuthenticated || _dayEnded) return;
        await Api.EndAsync();
        _awayFromDesk = false;
        if (_dashboard is not null) await _dashboard.ViewModel.RefreshAsync();
        RefreshBubbleStatus();
    }

    // ---- Windows -----------------------------------------------------------

    public void ShowLogin()
    {
        _login ??= new LoginWindow();
        _login.Activate();
    }

    public void ShowDashboard()
    {
        if (!Api.IsAuthenticated) { ShowLogin(); return; }
        _dashboard ??= new MainWindow();
        _dashboard.ViewModel.DayEnded = _dayEnded;
        _dashboard.AppWindow.Show();
        _dashboard.Activate();
        _ = _dashboard.ViewModel.RefreshAsync();
    }

    // ---- Floating button ---------------------------------------------------

    /// <summary>
    /// Puts the round button on screen. Windows hides tray icons behind the overflow
    /// arrow, where people stop finding them — this is the way back into the agent
    /// that doesn't need explaining.
    /// </summary>
    private void ShowBubble()
    {
        if (_bubble is null)
        {
            var menu = new MenuFlyout();
            menu.Items.Add(NewItem("Open dashboard", ShowDashboard));
            menu.Items.Add(new MenuFlyoutSeparator());
            menu.Items.Add(NewItem("Start break", () => _ = QuickStatus("BREAK")));
            menu.Items.Add(NewItem("Start lunch", () => _ = QuickStatus("LUNCH")));
            menu.Items.Add(NewItem("Back to working", () => _ = QuickEnd()));
            menu.Items.Add(new MenuFlyoutSeparator());
            menu.Items.Add(NewItem("End day", () => _ = EndWorkingDayAsync(confirm: true)));
            menu.Items.Add(NewItem("Start day", () => _ = StartWorkingDayAsync()));

            _bubble = new FloatingButtonWindow(ToggleDashboard, menu);
            _bubble.Activate();
            StartBubbleWatch();
        }

        _bubble.ShowBubble();
        RefreshBubbleStatus();
    }

    private void HideBubble()
    {
        _bubbleWatch?.Stop();
        _bubble?.HideBubble();
    }

    /// <summary>Click the button: show the dashboard, or put it away if it's already up.</summary>
    private void ToggleDashboard()
    {
        if (_dashboard is not null && _dashboard.AppWindow.IsVisible)
        {
            _dashboard.ViewModel.StopClock();
            _dashboard.AppWindow.Hide();
            return;
        }
        ShowDashboard();
    }

    /// <summary>Keeps the ring's colour honest, and gets the button out of the way of
    /// anything running full-screen (a presentation, a shared screen, a video call).</summary>
    private void StartBubbleWatch()
    {
        _bubbleWatch = _ui.CreateTimer();
        _bubbleWatch.Interval = TimeSpan.FromSeconds(3);
        _bubbleWatch.Tick += (_, _) =>
        {
            if (_bubble is null) return;

            if (Native.IsFullScreenAppRunning())
            {
                if (_bubble.IsVisible) _bubble.HideBubble();
                return;
            }
            if (!_bubble.IsVisible && Api.IsAuthenticated) _bubble.ShowBubble();
            RefreshBubbleStatus();
        };
        _bubbleWatch.Start();
    }

    private void RefreshBubbleStatus()
    {
        if (_bubble is null) return;

        // The dashboard's view-model is the better source, but it only exists once the
        // window has been opened — and a break can be started from the button's menu
        // without ever opening it. Fall back to what we last did in that case.
        var vm = _dashboard?.ViewModel;
        var away = vm is not null
            ? vm.BreakActive || vm.LunchActive || vm.MeetingActive
            : _awayFromDesk;

        var status = !Api.IsAuthenticated || _dayEnded
            ? BubbleStatus.Idle
            : away
                ? BubbleStatus.Paused
                : BubbleStatus.Tracking;

        _bubble.SetStatus(status);
    }

    /// <summary>Called by the login window after a successful sign-in.</summary>
    public async void OnSignedIn()
    {
        _sessionLost = false;
        StartupRegistration.Enable();
        // Signing in again on a day already ended must not restart tracking.
        _dayEnded = await Api.IsDayEndedAsync();
        Chat.Start();
        if (!_dayEnded) StartTracking();
        _login?.Close();
        _login = null;
        ShowBubble();
        ShowDashboard();
    }

    public async Task SignOut()
    {
        Chat.Stop();
        Shots.Stop();
        Activity.Stop();
        _heartbeat?.Stop();
        await Api.LogoutAsync();
        StartupRegistration.Disable();
        _dashboard?.AppWindow.Hide();
        HideBubble();
        ShowLogin();
    }

    private void OnChatMessage(ChatMessage message) => _dashboard?.ViewModel.OnChatMessage(message);

    /// <summary>The session is gone and could not be renewed or re-enrolled. Stop the
    /// loops and ask for a sign-in — a tray icon that looks fine while nothing reaches
    /// the server is worse than an obvious prompt, because the manager's live board
    /// just shows the user as offline and nobody knows why.</summary>
    private void OnSessionLost()
    {
        _ui.TryEnqueue(() =>
        {
            if (_sessionLost || !Api.IsAuthenticated) return;
            _sessionLost = true;

            Chat.Stop();
            Shots.Stop();
            Activity.Stop();
            _heartbeat?.Stop();
            _dashboard?.AppWindow.Hide();
            HideBubble();
            ShowLogin();
        });
    }

    /// <summary>End the working day: activity, screen captures and attendance all stop
    /// for the rest of today, and today's totals become final.</summary>
    public async Task EndWorkingDayAsync(bool confirm = false)
    {
        if (!Api.IsAuthenticated || _dayEnded) return;

        var root = _dashboard?.Content?.XamlRoot;
        if (confirm)
        {
            if (_dashboard is null) ShowDashboard();
            root = _dashboard?.Content?.XamlRoot;
            if (root is null) return;
            var yes = await Dialogs.ConfirmAsync(root,
                "Your working day will end now. Activity tracking, screen captures and " +
                "attendance all stop, and today's hours are final. You can't restart " +
                "tracking until tomorrow.",
                title: "End your working day now?", ok: "End day", cancel: "Cancel");
            if (!yes) return;
        }

        // Only stop once the server has actually recorded it. Ending locally after a
        // failed call would hide the fact that the day is still open server-side.
        if (!await Api.EndDayAsync())
        {
            if (root is not null)
            {
                await Dialogs.NoticeAsync(root, "Couldn't end your day",
                    "We couldn't reach the server, so your day is still running. " +
                    "Check your connection and try again.");
            }
            return;
        }

        OnDayEnded();
    }

    private void OnDayEnded()
    {
        _ui.TryEnqueue(async () =>
        {
            if (_dayEnded) return;
            _dayEnded = true;
            Activity.Stop();
            Shots.Stop();
            _heartbeat?.Stop(); // attendance stops at the same instant
            if (_dashboard is not null)
            {
                _dashboard.ViewModel.DayEnded = true;
                await _dashboard.ViewModel.RefreshAsync();
            }
            RefreshBubbleStatus(); // ring goes grey — nothing is being recorded now
        });
    }

    /// <summary>Resume the working day after an End Day ("Start day"). Everything —
    /// activity, idle, screenshots and attendance — starts tracking again at once.</summary>
    public async Task StartWorkingDayAsync()
    {
        if (!Api.IsAuthenticated || !_dayEnded) return;

        // Only resume locally once the server has actually reopened the day.
        if (!await Api.StartDayAsync())
        {
            var root = _dashboard?.Content?.XamlRoot;
            if (root is not null)
            {
                await Dialogs.NoticeAsync(root, "Couldn't start your day",
                    "We couldn't reach the server, so tracking is still paused. " +
                    "Check your connection and try again.");
            }
            return;
        }

        _dayEnded = false;
        StartTracking(); // activity + screenshots + heartbeat, exactly like sign-in
        if (_dashboard is not null)
        {
            _dashboard.ViewModel.DayEnded = false;
            await _dashboard.ViewModel.RefreshAsync();
        }
        RefreshBubbleStatus();
    }

    private void ExitApp()
    {
        _heartbeat?.Stop();
        _bubbleWatch?.Stop();
        _bubble?.Close();
        _tray?.Dispose();
        Exit();
    }

    // ---- Heartbeat ---------------------------------------------------------

    private void BuildHeartbeat()
    {
        _heartbeat = _ui.CreateTimer();
        _heartbeat.Interval = TimeSpan.FromSeconds(Math.Max(15, Config.HeartbeatSeconds));
        _heartbeat.Tick += async (_, _) =>
        {
            if (!Api.IsAuthenticated || _dayEnded) return;
            // Locked counts as idle at once, so the online session closes at the lock
            // instead of one idle-threshold later.
            var idle = LockWatcher.IsLocked || IdleWatcher.IdleSeconds() >= Config.IdleThresholdSeconds;
            await Api.HeartbeatAsync(idle);
        };
    }
}
