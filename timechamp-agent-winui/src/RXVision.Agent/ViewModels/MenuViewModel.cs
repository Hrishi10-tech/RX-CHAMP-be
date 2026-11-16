using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;

namespace RXVision.Agent.ViewModels;

/// <summary>What the tray and button menus allow, for a state. Pure, so it is easy to test.</summary>
public sealed record MenuState(
    bool CanQuickBreak,
    bool CanNextBreak,
    bool CanBackToWork,
    bool CanEndDay,
    bool CanStartDay,
    bool CanSignOut,
    /// <summary>Quit is offered at all (Admins and Super Admins, with a key; SPEC 2.8).</summary>
    bool ShowQuit,
    string Status)
{
    public static MenuState For(AgentState state, string presenceStatus, bool onBreak, bool canQuit = false)
    {
        var running = state == AgentState.Running;
        var away = onBreak || presenceStatus is PresenceStatus.Break or PresenceStatus.Lunch;
        var meeting = presenceStatus == PresenceStatus.Meeting;
        return new MenuState(
            CanQuickBreak: running && !away && !meeting,
            CanNextBreak: running && !away && !meeting,
            CanBackToWork: running && (away || meeting),
            CanEndDay: running,
            CanStartDay: state is AgentState.DayEnded or AgentState.NotStarted,
            CanSignOut: state is AgentState.NeedsNotice or AgentState.NotStarted or AgentState.Running or AgentState.DayEnded or AgentState.Connecting,
            ShowQuit: canQuit,
            Status: StatusText(state, presenceStatus, onBreak));
    }

    public static string StatusText(AgentState state, string presenceStatus, bool onBreak) => state switch
    {
        AgentState.Running when presenceStatus == PresenceStatus.Lunch => "At lunch",
        AgentState.Running when onBreak || presenceStatus == PresenceStatus.Break => "On a break",
        AgentState.Running when presenceStatus == PresenceStatus.Meeting => "In a meeting",
        AgentState.Running => "Working",
        AgentState.NotStarted => "Day not started",
        AgentState.DayEnded => "Day ended",
        AgentState.NeedsNotice => "Not tracking yet",
        AgentState.Connecting => "Reconnecting",
        AgentState.SignIn => "Signed out",
        _ => "Starting",
    };
}

public sealed partial class MenuItemViewModel : ObservableObject
{
    private MenuItemViewModel(string header, Action? execute, bool separator)
    {
        Header = header;
        IsSeparator = separator;
        // Guarded here too: a menu may invoke a command without asking CanExecute first.
        Command = new RelayCommand(() => { if (IsEnabled && IsVisible && !IsSeparator) execute?.Invoke(); }, () => IsEnabled && IsVisible && !IsSeparator);
    }

    public MenuItemViewModel(string header, Action execute) : this(header, execute, false) { }

    public static MenuItemViewModel Separator() => new("-", null, true);

    public string Header { get; }
    public bool IsSeparator { get; }
    public IRelayCommand Command { get; }

    [ObservableProperty] private bool _isEnabled = true;
    /// <summary>Shown in the menu at all (Quit only for Admins and Super Admins).</summary>
    [ObservableProperty] private bool _isVisible = true;

    partial void OnIsEnabledChanged(bool value) => Command.NotifyCanExecuteChanged();
    partial void OnIsVisibleChanged(bool value) => Command.NotifyCanExecuteChanged();
}

/// <summary>
/// The one menu behind the tray (or menu-bar) icon and the button's right-click.
/// 4.0: Quick break and Next break in place of the per-kind items; Sign out asks
/// for an admin's key; Quit is gone for staff and managers (SPEC 2.8).
/// </summary>
public sealed partial class AgentMenuViewModel : ObservableObject
{
    public AgentMenuViewModel(
        Action open, Action quickBreak, Action nextBreak, Action backToWork,
        Action endDay, Action startDay, Action signOut, Action quit)
    {
        Open = new MenuItemViewModel("Open RX Vision", open);
        QuickBreak = new MenuItemViewModel("Quick break…", quickBreak);
        NextBreak = new MenuItemViewModel("Next break", nextBreak);
        BackToWork = new MenuItemViewModel("Back to work", backToWork);
        EndDay = new MenuItemViewModel("End Day", endDay);
        StartDay = new MenuItemViewModel("Start Day", startDay);
        SignOut = new MenuItemViewModel("Sign out…", signOut);
        Quit = new MenuItemViewModel("Quit RX Vision…", quit);
        Items = new[]
        {
            Open, MenuItemViewModel.Separator(),
            QuickBreak, NextBreak, BackToWork, MenuItemViewModel.Separator(),
            EndDay, StartDay, MenuItemViewModel.Separator(),
            SignOut, Quit,
        };
        Update(MenuState.For(AgentState.Starting, PresenceStatus.Working, false));
    }

    public MenuItemViewModel Open { get; }
    public MenuItemViewModel QuickBreak { get; }
    public MenuItemViewModel NextBreak { get; }
    public MenuItemViewModel BackToWork { get; }
    public MenuItemViewModel EndDay { get; }
    public MenuItemViewModel StartDay { get; }
    public MenuItemViewModel SignOut { get; }
    public MenuItemViewModel Quit { get; }
    public IReadOnlyList<MenuItemViewModel> Items { get; }

    [ObservableProperty] private string _toolTip = "RX Vision";

    public void Update(MenuState state)
    {
        QuickBreak.IsEnabled = state.CanQuickBreak;
        NextBreak.IsEnabled = state.CanNextBreak;
        BackToWork.IsEnabled = state.CanBackToWork;
        EndDay.IsEnabled = state.CanEndDay;
        StartDay.IsEnabled = state.CanStartDay;
        SignOut.IsEnabled = state.CanSignOut;
        Quit.IsVisible = state.ShowQuit;
        Quit.IsEnabled = state.ShowQuit;
        ToolTip = $"RX Vision: {state.Status}";
    }
}
