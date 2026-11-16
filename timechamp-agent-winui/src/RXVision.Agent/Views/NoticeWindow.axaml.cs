using Avalonia.Controls;
using Avalonia.Threading;

namespace RXVision.Agent.Views;

/// <summary>The monitoring notice. Closing it only hides it; it comes back until acknowledged.</summary>
public partial class NoticeWindow : Window
{
    public NoticeWindow()
    {
        InitializeComponent();
        Opened += (_, _) => Dispatcher.UIThread.Post(() => Acknowledge.Focus(), DispatcherPriority.Input);
    }

    public bool AllowClose { get; set; }

    protected override void OnClosing(WindowClosingEventArgs e)
    {
        if (!AllowClose && e.CloseReason is WindowCloseReason.WindowClosing or WindowCloseReason.Undefined)
        {
            e.Cancel = true;
            Hide();
        }
        base.OnClosing(e);
    }
}
