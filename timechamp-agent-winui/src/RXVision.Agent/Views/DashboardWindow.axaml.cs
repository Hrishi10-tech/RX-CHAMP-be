using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;

namespace RXVision.Agent.Views;

/// <summary>The panel. Closing it only hides it: the agent keeps running.</summary>
public partial class DashboardWindow : Window
{
    public DashboardWindow()
    {
        InitializeComponent();
        CloseButton.Click += (_, _) => Close();
    }

    /// <summary>Keyboard focus on the top screen's primary action, so it is ready as the panel opens: the break's own, then the other cards.</summary>
    public void FocusNewestCard()
    {
        foreach (var button in new[] { ResumeNow, CommentNow, TakeBreakNow, ResumeWork })
        {
            if (!button.IsEffectivelyVisible) continue;
            DialogFocus.Focus(button);
            return;
        }
        AlertCards.FocusTopAction();
    }

    /// <summary>Set while the app quits: then closing really closes.</summary>
    public bool AllowClose { get; set; }

    /// <summary>Raised when the window is shown (true) or hidden (false).</summary>
    public event Action<bool>? VisibilityChanged;

    /// <summary>The cards, for the tests.</summary>
    internal AlertCardsView AlertCardsForTests => AlertCards;

    /// <summary>The same, once a new card has laid out.</summary>
    public void FocusTopAlert() => Dispatcher.UIThread.Post(FocusNewestCard, DispatcherPriority.Loaded);

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
