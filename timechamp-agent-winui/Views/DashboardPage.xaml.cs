using System.Collections.Specialized;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using TimeChampAgent.Helpers;
using TimeChampAgent.ViewModels;
using Windows.Foundation;
using Windows.System;

namespace TimeChampAgent.Views;

public sealed partial class DashboardPage : Page
{
    public DashboardViewModel ViewModel { get; }
    private bool _started;

    public DashboardPage()
    {
        ViewModel = new DashboardViewModel(App.Api);
        InitializeComponent();

        ViewModel.SignOutRequested = () => App.Instance.SignOut();
        ViewModel.EndDayRequested = () => App.Instance.EndWorkingDayAsync(confirm: true);

        ViewModel.Messages.CollectionChanged += OnMessagesChanged;

        Loaded += (_, _) =>
        {
            ViewModel.ConfirmAsync = body => Dialogs.ConfirmAsync(XamlRoot, body);
            ViewModel.PromptAsync = msg => Dialogs.PromptAsync(XamlRoot, msg);
        };
    }

    /// <summary>Called by the host window when the dashboard becomes visible.</summary>
    public async void OnShown()
    {
        ViewModel.StartClock();
        if (_started) { await ViewModel.RefreshAsync(); return; }
        _started = true;
        await ViewModel.LoadChatAsync();
        await ViewModel.RefreshAsync();
    }

    private void OnMessagesChanged(object? sender, NotifyCollectionChangedEventArgs e) =>
        DispatcherQueue.TryEnqueue(() => ChatScroll.ChangeView(null, ChatScroll.ScrollableHeight, null));
    private void OnBreakTapped(object sender, TappedRoutedEventArgs e) => ViewModel.BreakCommand.Execute(null);
    private void OnLunchTapped(object sender, TappedRoutedEventArgs e) => ViewModel.LunchCommand.Execute(null);
    private void OnFocusTapped(object sender, TappedRoutedEventArgs e) => ViewModel.FocusWorkCommand.Execute(null);
    private void OnMeetingTapped(object sender, TappedRoutedEventArgs e) => ViewModel.MeetingCommand.Execute(null);

    private void OnChatKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        e.Handled = true;
        if (ViewModel.SendChatCommand.CanExecute(null)) ViewModel.SendChatCommand.Execute(null);
    }
}
