using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;

namespace RXVision.Agent.Views;

/// <summary>The main screen. Closing it only hides it: the agent keeps running.</summary>
public partial class DashboardWindow : Window
{
    public DashboardWindow() => InitializeComponent();

    /// <summary>Set while the app quits: then closing really closes.</summary>
    public bool AllowClose { get; set; }

    /// <summary>Raised when the window is shown (true) or hidden (false).</summary>
    public event Action<bool>? VisibilityChanged;

    /// <summary>The cards, for the tests.</summary>
    internal AlertCardsView AlertCardsForTests => AlertCards;

    /// <summary>Keyboard focus on the top alert's primary action, once its card has laid out.</summary>
    public void FocusTopAlert() => Dispatcher.UIThread.Post(() => AlertCards.FocusTopAction(), DispatcherPriority.Loaded);

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
