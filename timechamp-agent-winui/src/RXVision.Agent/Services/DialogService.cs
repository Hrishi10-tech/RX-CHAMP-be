using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using RXVision.Agent.Views;

namespace RXVision.Agent.Services;

/// <summary>
/// Shows dialogs over the dashboard when it is open (the dashboard waits behind a
/// scrim), or in a small window of their own when it is not. One at a time.
/// </summary>
public sealed class DialogService : IDialogService
{
    private readonly Func<DashboardViewModel> _dashboard;
    private readonly Func<bool> _dashboardVisible;
    private readonly SemaphoreSlim _one = new(1, 1);

    public DialogService(Func<DashboardViewModel> dashboard, Func<bool> dashboardVisible)
    {
        _dashboard = dashboard;
        _dashboardVisible = dashboardVisible;
    }

    public async Task<bool> ShowAsync(DialogViewModel dialog)
    {
        await _one.WaitAsync();
        try
        {
            if (_dashboardVisible())
            {
                var dashboard = _dashboard();
                dashboard.Overlay = dialog;
                try { return await dialog.Completion; }
                finally { if (ReferenceEquals(dashboard.Overlay, dialog)) dashboard.Overlay = null; }
            }

            var window = new DialogWindow { DataContext = dialog };
            window.Show();
            window.Activate();
            try { return await dialog.Completion; }
            finally { window.Close(); }
        }
        finally
        {
            _one.Release();
        }
    }
}
