using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Platform;
using Avalonia.Threading;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Icon;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.Views;

namespace RXVision.Agent;

/// <summary>
/// The app's lifecycle: which windows are up for each agent state, the tray and
/// button menus, toasts, the one-second clock, and a clean exit. Everything the
/// agent reports arrives here on the UI thread (see <see cref="AgentFacade"/>).
/// </summary>
public sealed class AppController : IDisposable
{
    private readonly IClassicDesktopStyleApplicationLifetime _desktop;
    private readonly StartupContext _startup;
    private readonly ILog _log;
    private readonly AgentFacade _agent;
    private readonly UiSettingsStore _settings;
    private readonly DialogService _dialogs;
    private readonly BreakActions _actions;
    private readonly AgentMenuViewModel _menu;
    private readonly AlertCenter _alerts;
    private readonly DayMeter _meter;
    private readonly DayAlerts _dayAlerts;
    private readonly BubbleViewModel _bubbleVm;
    private readonly DashboardViewModel _dashboardVm;
    private readonly SignInViewModel _signInVm;
    private readonly NoticeViewModel _noticeVm;
    private readonly ToastService _toasts;
    private readonly DispatcherTimer _clock;

    private DashboardWindow? _dashboard;
    private SignInWindow? _signIn;
    private NoticeWindow? _notice;
    private BubbleWindow? _bubble;
    private ToastWindow? _toastWindow;
    private TrayIcon? _tray;

    private AgentState _shownState = AgentState.Starting;
    private bool _openDashboardOnSession;
    private bool _quitting;
    private bool _fullScreen;
    private Task<bool>? _fullScreenProbe;
    private long _ticks;

    public AppController(IClassicDesktopStyleApplicationLifetime desktop, StartupContext startup)
    {
        _desktop = desktop;
        _startup = startup;
        _log = startup.Log;
        _agent = new AgentFacade(startup.Host, new AvaloniaDispatcher(), _log);
        _settings = new UiSettingsStore(startup.Platform.Paths.DataDir, _log);

        // The dialogs show over the dashboard's view model, whose commands need the
        // actions, which need the dialogs: the dialog service reads it when needed.
        _dialogs = new DialogService(() => _dashboardVm!, () => _dashboard?.IsVisible == true);
        _actions = new BreakActions(_agent, _dialogs, _log);
        // 3.6: one alert centre for the icon's badge and the panel's cards; one day meter for the
        // ring, the hover label and the panel's progress lines.
        _alerts = new AlertCenter();
        _meter = new DayMeter(_agent, _settings);
        _dayAlerts = new DayAlerts(_agent, _alerts, _actions, OpenUrl);
        _dashboardVm = new DashboardViewModel(_agent, _actions, _log, _alerts, _meter)
        {
            SignOutRequested = () => _actions.SignOutAsync(),
            QuitRequested = () => _actions.QuitAsync(QuitNowAsync),
        };

        _menu = new AgentMenuViewModel(
            open: ShowMain,
            quickBreak: () => RunFromMenu(() => { ShowDashboard(); return _actions.QuickBreakAsync(); }),
            nextBreak: () => RunFromMenu(() => { ShowDashboard(); return _actions.NextBreakAsync(); }),
            backToWork: () => RunFromMenu(() => _actions.BackToWorkAsync()),
            endDay: () => RunFromMenu(() => { ShowDashboard(); return _actions.EndDayAsync(); }),
            startDay: () => RunFromMenu(() => _actions.StartDayAsync()),
            signOut: () => RunFromMenu(() => { ShowDashboard(); return _actions.SignOutAsync(); }),
            quit: () => RunFromMenu(() => { ShowDashboard(); return _actions.QuitAsync(QuitNowAsync); }));

        _bubbleVm = new BubbleViewModel(_agent, _meter, _alerts, new AvaloniaDispatcher(), _menu);
        _signInVm = new SignInViewModel(_agent, _settings, _log);
        _noticeVm = new NoticeViewModel(_agent, _log);
        _toasts = new ToastService(new ToastPresenter(this));
        _openDashboardOnSession = !startup.StartMinimized;

        _clock = new DispatcherTimer(TimeSpan.FromSeconds(1), DispatcherPriority.Background, (_, _) => Tick());
    }

    // ---- Start and stop ----------------------------------------------------------------------

    public void Start()
    {
        _agent.StateChanged += ApplyState;
        _agent.PresenceChanged += _ => Refresh();
        _agent.BreaksChanged += Refresh;
        _agent.WorkdayChanged += Refresh;
        _agent.DayProgressChanged += Refresh;
        _agent.MeetingAlertsChanged += Refresh;
        // C-R11: a day already running keeps running while the notice waits on top.
        _agent.NoticePendingChanged += () =>
        {
            if (!IsDayState(_agent.State)) return;
            if (_agent.NoticePending) ShowNotice();
            else HideNotice();
        };
        _agent.MeetingsChanged += Refresh;
        _agent.ApprovalsChanged += Refresh;
        // The ring, a break skipped for the person and the Start day nudge are alert cards (3.6): no sound, no toast.
        _agent.RingChanged += _ => Refresh();
        _agent.BreakAutoSkipped += _dayAlerts.OnAutoSkipped;
        _agent.Nudge += _dayAlerts.OnNudge;
        _agent.ActionRefused += OnActionRefused;
        _agent.EndDayHeld += OnEndDayHeld;
        _agent.AwayChanged += UpdateAway;
        _agent.HistoryChanged += _dashboardVm.OnHistoryChanged;
        _agent.LeaveChanged += _dashboardVm.OnLeaveChanged;
        _actions.Cue += OnCue;
        _agent.ChatMessageReceived += m => _ = OnChatMessageAsync(m);
        // 4.0 kept the manager chat's unread count on the button: the icon shows it under any alert.
        _agent.ChatUnreadChanged += n => _bubbleVm.MessageCount = n;
        _agent.NotificationReceived += OnNotification;
        _agent.UpdateAvailable += _ => Refresh();
        _agent.ExitRequested += OnExitRequested;
        _agent.SignedOutUnexpectedly += OnSignedOutUnexpectedly;
        _agent.ShiftEndQuestion += OnShiftEndQuestion;
        _agent.SignedOutForNextShift += OnSignedOutForNextShift;

        if (_startup.Instance is { } instance)
        {
            // Opening the app again (a second launch) shows this one.
            instance.Activated += _ => Dispatcher.UIThread.Post(ShowMain);
        }
        _desktop.ShutdownRequested += (_, _) => StopAgent();

        BuildTray();
        _clock.Start();
        ApplyState(_agent.State);
        _ = StartAgentAsync();
    }

    private async Task StartAgentAsync()
    {
        try
        {
            await _agent.StartAsync();
        }
        catch (Exception ex)
        {
            _log.Error("ui", "the agent failed to start", ex);
            _signInVm.Error = "Try signing in, or quit and open RX Vision again.";
            ShowSignIn();
        }
    }

    private void StopAgent()
    {
        if (_quitting) return;
        _quitting = true;
        _clock.Stop();
        _bubbleVm.Dispose();
        try { _agent.Shutdown(); }
        catch (Exception ex) { _log.Warn("ui", "agent shutdown failed", ex); }
    }

    /// <summary>An Admin's or Super Admin's quit, after the key was taken (SPEC 2.8). Tracking stops.</summary>
    private Task QuitNowAsync()
    {
        _log.Info("ui", "quit with a key");
        Dispatcher.UIThread.Post(Exit);
        return Task.CompletedTask;
    }

    private void Exit()
    {
        StopAgent();
        foreach (var w in new Window?[] { _dashboard, _signIn, _notice, _bubble, _toastWindow, _awayWindow })
        {
            if (w is null) continue;
            if (w is DashboardWindow d) d.AllowClose = true;
            if (w is SignInWindow s) s.AllowClose = true;
            if (w is NoticeWindow n) n.AllowClose = true;
            if (w is AwayWindow a) a.AllowClose = true;
            try { w.Close(); } catch { }
        }
        try { _tray?.Dispose(); } catch { }
        _desktop.Shutdown();
    }

    private void OnExitRequested()
    {
        // An update is installing: get out of its way, now.
        _log.Info("ui", "exiting for an update");
        Exit();
    }

    // ---- State -> windows -----------------------------------------------------------------------

    private void ApplyState(AgentState state)
    {
        var previous = _shownState;
        _shownState = state;
        UpdateMenu();
        _dayAlerts.Sync();
        _bubbleVm.Update();
        switch (state)
        {
            case AgentState.Starting:
                break;
            case AgentState.SignIn:
                HideBubble();
                HideDashboard();
                HideNotice();
                CloseAway();
                _toasts.Clear();
                _dayAlerts.Reset();
                _bubbleVm.Reset();
                _bubbleVm.MessageCount = 0;
                _dashboardVm.Reset();
                _openDashboardOnSession = true;
                ShowSignIn();
                break;
            case AgentState.Connecting:
                // Quietly retrying: tray only. The sign-in window, if open, says so.
                HideBubble();
                HideDashboard();
                HideNotice();
                _signInVm.Prepare(state);
                break;
            case AgentState.NeedsNotice:
                HideSignIn();
                HideBubble();
                HideDashboard();
                _openDashboardOnSession = true;
                ShowNotice();
                break;
            case AgentState.NotStarted:
            case AgentState.Running:
            case AgentState.DayEnded:
                HideSignIn();
                // A day already running keeps running while the notice waits on top (C-R11).
                if (_agent.NoticePending) ShowNotice();
                else HideNotice();
                ShowBubble();
                if (!IsDayState(previous))
                {
                    if (_openDashboardOnSession) ShowDashboard();
                    _openDashboardOnSession = false;
                }
                // The Start day and skipped-break cards clear themselves (DayAlerts.Sync).
                Refresh();
                break;
        }
    }

    private static bool IsDayState(AgentState state) =>
        state is AgentState.NotStarted or AgentState.Running or AgentState.DayEnded;

    /// <summary>The tray's "Open RX Vision", a tray click, or a second launch.</summary>
    private void ShowMain()
    {
        switch (_agent.State)
        {
            case AgentState.NotStarted:
            case AgentState.Running:
            case AgentState.DayEnded:
                ShowDashboard();
                break;
            case AgentState.NeedsNotice:
                ShowNotice();
                break;
            default:
                ShowSignIn();
                break;
        }
    }

    /// <summary>
    /// The alerts and the icon follow the agent. The meeting cards come through the alert centre
    /// like every other card: a badge on the icon until the panel opens, never a window (3.6).
    /// </summary>
    private void Refresh()
    {
        _dayAlerts.Sync();
        _bubbleVm.Update();
        UpdateMenu();
        if (_dashboard?.IsVisible == true) _dashboardVm.Refresh();
    }

    private void UpdateMenu()
    {
        var panel = _agent.BreakPanel;
        _menu.Update(MenuState.For(_agent.State, _agent.Presence.Status, panel.Active is not null, _actions.CanQuit, _agent.IsBiometric));
    }

    // ---- The clock --------------------------------------------------------------------------

    private void Tick()
    {
        try
        {
            _ticks++;
            _dayAlerts.Sync();
            _bubbleVm.Update();
            UpdateMenu();
            _toasts.Tick();
            if (_dashboard?.IsVisible == true) _dashboardVm.Refresh();
            UpdateAway();
            if (_ticks % 3 == 0) _ = CheckFullScreenAsync();
            if (_ticks % 60 == 0 && _dashboard?.IsVisible == true) _ = RefreshDataAsync();
        }
        catch (Exception ex)
        {
            _log.Error("ui", "tick failed", ex);
        }
    }

    /// <summary>The day's numbers from the server (every minute while the dashboard is up).</summary>
    private async Task RefreshDataAsync()
    {
        try
        {
            await Task.WhenAll(_agent.RefreshPresenceAsync(), _agent.RefreshWorkdayAsync());
            if (_dashboard?.IsVisible == true) _dashboardVm.Refresh();
        }
        catch (Exception ex)
        {
            _log.Warn("ui", "refresh failed", ex);
        }
    }

    /// <summary>Hides the button and holds toasts while a full-screen app is in front. The probe runs off the UI thread with a timeout.</summary>
    private async Task CheckFullScreenAsync()
    {
        if (_fullScreenProbe is { IsCompleted: false }) return;
        var probe = Task.Run(() => _agent.Platform.ScreenInfo.IsFullScreenAppInFront());
        _fullScreenProbe = probe;
        bool full;
        try { full = await probe.WaitAsync(TimeSpan.FromSeconds(2)); }
        catch { full = false; }
        if (full == _fullScreen) return;
        _fullScreen = full;
        _toasts.SetSuppressed(full);
        if (full)
        {
            _bubble?.Hide();
            _bubbleVm.SetShown(false);
        }
        else
        {
            ShowBubble();
        }
    }

    // ---- Windows ------------------------------------------------------------------------------

    private void ShowDashboard()
    {
        if (!IsDayState(_agent.State))
        {
            ShowMain();
            return;
        }
        var window = _dashboard ??= CreateDashboard();
        if (!window.IsVisible)
        {
            PlacePanel(window);
            // It opens on Today, with the newest card on top.
            _dashboardVm.ShowDashboardCommand.Execute(null);
            window.Show();
        }
        window.Activate();
        OnDashboardShown();
        window.FocusNewestCard();
    }

    /// <summary>Beside the icon, bottoms aligned (see <see cref="PanelPlacement"/>).</summary>
    private void PlacePanel(DashboardWindow window)
    {
        var (_, centre) = ToastAnchor(window);
        var screen = BubblePlacement.ScreenFor(centre, window.Screens.All) ?? window.Screens.Primary ?? window.Screens.All.FirstOrDefault();
        if (screen is null) return;
        window.Position = PanelPlacement.Place(centre, screen.WorkingArea, screen.Scaling);
    }

    private DashboardWindow CreateDashboard()
    {
        var window = new DashboardWindow { DataContext = _dashboardVm };
        window.VisibilityChanged += visible =>
        {
            if (visible) return;
            _dashboardVm.Overlay?.Cancel();
            _dashboardVm.IsOnScreen = false;
            _bubbleVm.SetPanelOpen(false);
            _agent.MeetingPanelClosed();
        };
        window.Activated += (_, _) =>
        {
            _dashboardVm.IsOnScreen = true;
            if (_agent.ChatUnread > 0 && _dashboardVm.IsMessagesTab) _ = SafeAsync(_dashboardVm.Chat.LoadConversationAsync);
        };
        window.Deactivated += (_, _) => _dashboardVm.IsOnScreen = false;
        return window;
    }

    private void OnDashboardShown()
    {
        // Opening clears the badge; the newest card is on top with its action ready.
        _dayAlerts.Sync();
        _bubbleVm.SetPanelOpen(true);
        if (_alerts.Cards.Count > 0)
        {
            _dashboardVm.ShowDashboardCommand.Execute(null);
            _dashboard?.FocusTopAlert();
        }
        _toasts.Withdraw(ToastKind.Message);
        _dashboardVm.Refresh();
        _ = RefreshDataAsync();
    }

    private void HideDashboard()
    {
        if (_dashboard?.IsVisible == true) _dashboard.Hide();
    }

    private void ToggleDashboard()
    {
        if (_dashboard is { IsVisible: true, IsActive: true }) _dashboard.Hide();
        else ShowDashboard();
    }

    private void ShowSignIn()
    {
        var window = _signIn ??= new SignInWindow { DataContext = _signInVm };
        _signInVm.Prepare(_agent.State);
        if (_agent.SignInNotice is { } notice)
        {
            // AG-2: a saved server this build may not use. Said once, in the sign-in window.
            _signInVm.Error = notice;
            _agent.SignInNoticeShown();
        }
        if (!window.IsVisible) window.Show();
        window.Activate();
    }

    private void HideSignIn()
    {
        if (_signIn?.IsVisible == true) _signIn.Hide();
    }

    private void ShowNotice()
    {
        var window = _notice ??= new NoticeWindow { DataContext = _noticeVm };
        if (!window.IsVisible) window.Show();
        window.Activate();
    }

    private void HideNotice()
    {
        if (_notice?.IsVisible == true) _notice.Hide();
    }

    private void ShowBubble()
    {
        if (_fullScreen || _quitting || !IsDayState(_agent.State)) return;
        if (_bubble is null)
        {
            _bubble = new BubbleWindow { DataContext = _bubbleVm };
            _bubble.UsePlacement(new BubblePlacement(_settings));
            _bubble.Clicked += ToggleDashboard;
            _bubble.DragEnded += () =>
            {
                if (_dashboard is { IsVisible: true } panel) PlacePanel(panel);
                if (_toastWindow is not { IsVisible: true } toast) return;
                var (avoid, centre) = ToastAnchor(toast);
                toast.MoveBeside(avoid, centre);
            };
        }
        _bubble.ShowQuietly();
        _bubbleVm.SetShown(true);
    }

    private void HideBubble()
    {
        if (_bubble?.IsVisible == true) _bubble.Hide();
        _bubbleVm.SetShown(false);
    }

    // ---- Events from the agent ----------------------------------------------------------------

    /// <summary>4.1 shared computer: "Are you taking the next shift?" (a sticky card until answered).</summary>
    private void OnShiftEndQuestion(ShiftQuestion q)
    {
        if (_agent.State != AgentState.Running) return;
        _toasts.Show(Toasts.ShiftQuestion(_agent, q,
            yes: () =>
            {
                _toasts.Show(Toasts.Cue(Toasts.ShiftAnswer(_agent, true, q.Deadline)));
                _ = _agent.ContinueShiftAsync();
            },
            no: () =>
            {
                _agent.DeclineShift();
                _toasts.Show(Toasts.Cue(Toasts.ShiftAnswer(_agent, false, q.Deadline)));
            },
            open: ShowDashboard));
    }

    /// <summary>4.1 shared computer: signed out for the next person; the sign-in screen is up.</summary>
    private void OnSignedOutForNextShift()
    {
        _toasts.Show(Toasts.SignedOutForNextShift());
        Refresh();
    }

    /// <summary>An action sent later was refused by RX Vision: said once (SPEC 6).</summary>
    private void OnActionRefused(string message)
    {
        _toasts.Show(Toasts.ActionRefused(_agent, message, ShowDashboard));
        Refresh();
    }

    /// <summary>An End Day done offline waits for comments: an "!" card; End Day (or the dashboard's banner) adds them.</summary>
    private void OnEndDayHeld(HeldEndDay held)
    {
        _dayAlerts.OnEndDayHeld(held);
        Refresh();
    }

    // ---- The away pop-up (SPEC 2.5, 8.4) ----------------------------------------------------

    private AwayWindow? _awayWindow;
    private AwayViewModel? _awayVm;

    /// <summary>
    /// Opens the pop-up when the agent says the person is away, keeps it counting,
    /// and closes it once it is answered. With a full-screen app in front it waits
    /// until input returns, so a presentation or a game is never covered mid-way.
    /// </summary>
    private void UpdateAway()
    {
        if (_quitting) return;
        try
        {
            if (_awayVm is { } vm)
            {
                vm.Refresh();
                if (vm.IsDone) CloseAway();
                return;
            }
            if (_agent.AwaySince is null || _agent.State != AgentState.Running) return;
            if (_fullScreen && IdleNow() > TimeSpan.FromSeconds(5)) return;
            _awayVm = new AwayViewModel(_agent, _log);
            _awayWindow = new AwayWindow { DataContext = _awayVm };
            _awayWindow.Show();
            _log.Info("ui", "away pop-up shown");
        }
        catch (Exception ex)
        {
            _log.Warn("ui", "away pop-up failed", ex);
        }
    }

    private TimeSpan IdleNow()
    {
        try { return _agent.Platform.Idle.IdleTime(); }
        catch { return TimeSpan.Zero; }
    }

    private void CloseAway()
    {
        var window = _awayWindow;
        _awayWindow = null;
        _awayVm = null;
        if (window is null) return;
        window.AllowClose = true;
        try { window.Close(); } catch { }
    }

    /// <summary>One quiet line beside the button for 5 seconds (after a skip or an early return).</summary>
    private void OnCue(string line) => _toasts.Show(Toasts.Cue(line));

    private async Task OnChatMessageAsync(ChatMessage message)
    {
        try
        {
            var shown = _dashboardVm.Chat.OnMessageReceived(message);
            if (shown && _dashboardVm.IsMessagesTab && _dashboard is { IsVisible: true, IsActive: true })
            {
                // Being read as it arrives: reloading marks it read.
                await _dashboardVm.Chat.LoadConversationAsync();
                return;
            }
            var chat = _agent.Chat;
            chat?.BumpUnread();
            _bubbleVm.MessageCount = _agent.ChatUnread;
            if (chat is not null && !chat.ContactsLoaded) await chat.LoadContactsAsync();
            var sender = chat?.NameOf(message.FromUserId) ?? "Someone";
            if (sender == "Someone") sender = "A manager";
            _toasts.Show(new ToastViewModel(ToastKind.Message, "chat:" + message.FromUserId)
            {
                Heading = "New message",
                Title = sender,
                Initials = Fmt.Initials(sender),
                Stamp = _agent.BusinessTime(message.CreatedAt == default ? DateTimeOffset.UtcNow : message.CreatedAt),
                Body = message.Body,
                PrimaryText = "View messages",
                OnOpen = () =>
                {
                    ShowDashboard();
                    RunFromMenu(() => _dashboardVm.ShowMessagesCommand.ExecuteAsync(null));
                    _dashboardVm.Chat.Select(message.FromUserId);
                },
            });
        }
        catch (Exception ex)
        {
            _log.Warn("ui", "chat message handling failed", ex);
        }
    }

    /// <summary>A notification (leave, comp off, work from home, late start, approvals, ...): an "i" card (3.6).</summary>
    private void OnNotification(NotificationItem item)
    {
        _dayAlerts.OnNotification(item);
        Refresh();
    }

    private void OpenUrl(string url)
    {
        try { _agent.Platform.Shell.OpenUrl(url); }
        catch (Exception ex) { _log.Warn("ui", "could not open the portal", ex); }
    }

    private void OnSignedOutUnexpectedly(string reason)
    {
        _signInVm.SetSessionLost(reason);
        ShowSignIn();
    }

    // ---- Tray ---------------------------------------------------------------------------------

    private void BuildTray()
    {
        try
        {
            var menu = new NativeMenu();
            foreach (var item in _menu.Items)
            {
                if (item.IsSeparator)
                {
                    menu.Add(new NativeMenuItemSeparator());
                    continue;
                }
                var native = new NativeMenuItem(item.Header) { IsEnabled = item.IsEnabled };
                native.Click += (_, _) => { if (item.IsEnabled) item.Command.Execute(null); };
                item.PropertyChanged += (_, e) =>
                {
                    if (e.PropertyName == nameof(MenuItemViewModel.IsEnabled)) native.IsEnabled = item.IsEnabled;
                    // Quit (admins only): in the menu or out of it, at the end where it belongs.
                    if (e.PropertyName == nameof(MenuItemViewModel.IsVisible))
                    {
                        if (item.IsVisible && !menu.Items.Contains(native)) menu.Add(native);
                        else if (!item.IsVisible) menu.Items.Remove(native);
                    }
                };
                if (item.IsVisible) menu.Add(native);
            }

            _tray = new TrayIcon
            {
                Icon = TrayImage(),
                ToolTipText = _menu.ToolTip,
                Menu = menu,
                IsVisible = true,
            };
            if (OperatingSystem.IsMacOS()) MacOSProperties.SetIsTemplateIcon(_tray, true);
            _tray.Clicked += (_, _) => ShowMain();
            _menu.PropertyChanged += (_, e) =>
            {
                if (e.PropertyName == nameof(AgentMenuViewModel.ToolTip) && _tray is not null) _tray.ToolTipText = _menu.ToolTip;
            };
            if (Application.Current is { } app) TrayIcon.SetIcons(app, new TrayIcons { _tray });
        }
        catch (Exception ex)
        {
            // No tray on this desktop: the floating button and windows still work.
            _log.Warn("ui", "tray icon unavailable", ex);
        }
    }

    private static WindowIcon TrayImage()
    {
        var name = OperatingSystem.IsWindows() ? "tray.ico" : OperatingSystem.IsMacOS() ? "tray-template.png" : "tray.png";
        using var stream = AssetLoader.Open(new Uri($"avares://RXVision/Assets/{name}"));
        return new WindowIcon(stream);
    }

    // ---- Helpers ------------------------------------------------------------------------------

    /// <summary>Runs an action started from a menu, toast or button: never throws, always logs.</summary>
    private void RunFromMenu(Func<Task> action)
    {
        _bubbleVm.Interaction();
        _ = SafeAsync(action);
    }

    private async Task SafeAsync(Func<Task> action)
    {
        try { await action(); }
        catch (Exception ex) { _log.Error("ui", "action failed", ex); }
    }

    public void Dispose()
    {
        _clock.Stop();
        try { _tray?.Dispose(); } catch { }
    }

    /// <summary>Puts toasts in the toast window, beside the button.</summary>
    private sealed class ToastPresenter : IToastPresenter
    {
        private readonly AppController _app;

        public ToastPresenter(AppController app) => _app = app;

        public void Show(ToastViewModel toast)
        {
            var window = _app._toastWindow;
            if (window is null)
            {
                window = new ToastWindow();
                window.HoverChanged += hovered => _app._toasts.SetHovered(hovered);
                _app._toastWindow = window;
            }
            window.DataContext = toast;
            var (avoid, centre) = _app.ToastAnchor(window);
            window.ShowBeside(avoid, centre);
        }

        public void Hide() => _app._toastWindow?.Hide();
    }

    /// <summary>The icon's window and centre, or where they would be while the icon is hidden.</summary>
    private (PixelRect Avoid, PixelPoint Centre) ToastAnchor(Window reference)
    {
        if (_bubble is { IsVisible: true }) return (_bubble.Footprint, _bubble.Anchor);
        var screens = reference.Screens;
        var anchor = new BubblePlacement(_settings).Load(screens.All, screens.Primary);
        var scale = BubblePlacement.ScreenFor(anchor, screens.All)?.Scaling ?? 1;
        var r = (int)Math.Round(IconGeometry.Canvas / 2 * scale);
        return (new PixelRect(anchor.X - r, anchor.Y - r, r * 2, r * 2), anchor);
    }

}

/// <summary>Avalonia's UI thread.</summary>
public sealed class AvaloniaDispatcher : IUiDispatcher
{
    public void Post(Action action) => Dispatcher.UIThread.Post(action);
}
