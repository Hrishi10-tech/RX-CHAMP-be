using Avalonia.Controls;

namespace RXVision.Agent.Views;

/// <summary>
/// The away pop-up: on top, shown without taking the keyboard (the person clicks
/// into it), and it can't be closed away: only an answer (or End Day) ends it.
/// </summary>
public partial class AwayWindow : Window
{
    public AwayWindow() => InitializeComponent();

    /// <summary>Set when the answer is in, or the app quits: then closing really closes.</summary>
    public bool AllowClose { get; set; }

    protected override void OnClosing(WindowClosingEventArgs e)
    {
        if (!AllowClose && e.CloseReason is WindowCloseReason.WindowClosing or WindowCloseReason.Undefined) e.Cancel = true;
        base.OnClosing(e);
    }
}
