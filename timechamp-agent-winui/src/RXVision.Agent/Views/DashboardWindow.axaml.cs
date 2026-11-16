using Avalonia;
using Avalonia.Controls;

namespace RXVision.Agent.Views;

/// <summary>The main screen. Closing it only hides it: the agent keeps running.</summary>
public partial class DashboardWindow : Window
{
    public DashboardWindow() => InitializeComponent();

    /// <summary>Set while the app quits: then closing really closes.</summary>
    public bool AllowClose { get; set; }

    /// <summary>Raised when the window is shown (true) or hidden (false).</summary>
    public event Action<bool>? VisibilityChanged;

    protected override void OnClosing(WindowClosingEventArgs e)
    {
        if (!AllowClose && e.CloseReason is WindowCloseReason.WindowClosing or WindowCloseReason.Undefined)
        {
            e.Cancel = true;
            Hide();
        }
        base.OnClosing(e);
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == IsVisibleProperty) VisibilityChanged?.Invoke(change.GetNewValue<bool>());
    }
}
