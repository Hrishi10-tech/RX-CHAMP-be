using Avalonia.Controls;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using RXVision.Agent.Views;

namespace RXVision.Agent.Services;

/// <summary>
/// Shows dialogs over the dashboard when it is open (the dashboard waits behind a
/// scrim), or in a small window of their own when it is not. One at a time, and
/// always in front: on a Mac the agent is a menu-bar app that is rarely the active
/// one, so a question left behind other windows would leave every later tap waiting.
/// </summary>
public sealed class DialogService : IDialogService
{
    private readonly Func<DashboardViewModel> _dashboard;
    private readonly Func<bool> _bringDashboardForward;
    private readonly SemaphoreSlim _one = new(1, 1);

    // The question on screen now: in the dashboard (no window) or in its own window.
    private DialogViewModel? _current;
    private Window? _currentWindow;

    /// <param name="dashboard">The dashboard's view model.</param>
    /// <param name="bringDashboardForward">
    /// When the dashboard is open: brings it in front and returns true. False when it is closed.
    /// </param>
    public DialogService(Func<DashboardViewModel> dashboard, Func<bool> bringDashboardForward)
    {
        _dashboard = dashboard;
        _bringDashboardForward = bringDashboardForward;
    }

    public async Task<bool> ShowAsync(DialogViewModel dialog)
    {
        await _one.WaitAsync();
        try
        {
            if (_bringDashboardForward())
            {
                var dashboard = _dashboard();
                dashboard.Overlay = dialog;
                _current = dialog;
                try { return await dialog.Completion; }
                finally
                {
                    _current = null;
                    if (ReferenceEquals(dashboard.Overlay, dialog)) dashboard.Overlay = null;
                }
            }

            var window = new DialogWindow { DataContext = dialog };
            _current = dialog;
            _currentWindow = window;
            window.Show();
            window.Activate();
            try { return await dialog.Completion; }
            finally
            {
                _current = null;
                _currentWindow = null;
                window.Close();
            }
        }
        finally
        {
            _one.Release();
        }
    }

    /// <summary>The question waiting for an answer comes in front (its own window, or the dashboard it sits in).</summary>
    public void BringForward()
    {
        if (_current is null) return;
        if (_currentWindow is { } window)
        {
            if (!window.IsVisible) window.Show();
            window.Activate();
            return;
        }
        _bringDashboardForward();
    }
}
