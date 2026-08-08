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
    private bool _dayEnded;

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
        Chat = new ChatService(Api);
        Chat.MessageReceived += OnChatMessage;
        Shots = new ScreenshotService(Api);
        Activity = new ActivityService(Api, Config);
        Activity.DayEnded += OnDayEnded;

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
            "RX Champ — attendance & activity monitoring",
            "RX Champ is now active on this device.\n\n" +
            "Your employer uses it to record working hours, breaks, and lunch for attendance; " +
            "to log which applications and websites you use during work hours and your idle time; " +
            "and to take periodic screenshots of your screen (about every 5 minutes, and when a " +
            "manager requests one) for work monitoring.\n\n" +
            "It runs from the system tray — you can open it any time to see your own totals.");
    }

    // ---- Tray --------------------------------------------------------------

    private void BuildTray()
    {
        _tray = new TaskbarIcon
        {
            ToolTipText = "RX Champ Agent",
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
        if (_dashboard is not null) await _dashboard.ViewModel.RefreshAsync();
    }

    private async Task QuickEnd()
    {
        if (!Api.IsAuthenticated || _dayEnded) return;
        await Api.EndAsync();
        if (_dashboard is not null) await _dashboard.ViewModel.RefreshAsync();
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

    /// <summary>Called by the login window after a successful sign-in.</summary>
    public async void OnSignedIn()
    {
        StartupRegistration.Enable();
        // Signing in again on a day already ended must not restart tracking.
        _dayEnded = await Api.IsDayEndedAsync();
        Chat.Start();
        if (!_dayEnded) StartTracking();
        _login?.Close();
        _login = null;
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
        ShowLogin();
    }

    private void OnChatMessage(ChatMessage message) => _dashboard?.ViewModel.OnChatMessage(message);

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
        });
    }

    private void ExitApp()
    {
        _heartbeat?.Stop();
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
