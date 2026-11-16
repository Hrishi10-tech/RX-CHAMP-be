using Avalonia.Controls;
using RXVision.Agent.ViewModels.Dialogs;

namespace RXVision.Agent.Views;

/// <summary>A dialog on its own, for when the dashboard is closed (e.g. Quit from the tray).</summary>
public partial class DialogWindow : Window
{
    public DialogWindow() => InitializeComponent();

    protected override void OnClosed(EventArgs e)
    {
        // Closing the window is the same as Cancel.
        (DataContext as DialogViewModel)?.Cancel();
        base.OnClosed(e);
    }
}
