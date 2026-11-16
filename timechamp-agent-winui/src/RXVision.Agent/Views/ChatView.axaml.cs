using Avalonia.Controls;
using Avalonia.Threading;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Views;

/// <summary>Keeps the newest message in view.</summary>
public partial class ChatView : UserControl
{
    private ChatViewModel? _vm;

    public ChatView()
    {
        InitializeComponent();
        DataContextChanged += (_, _) =>
        {
            if (_vm is not null) _vm.MessagesAdded -= ScrollToEnd;
            _vm = DataContext as ChatViewModel;
            if (_vm is not null) _vm.MessagesAdded += ScrollToEnd;
        };
    }

    private void ScrollToEnd() =>
        Dispatcher.UIThread.Post(() => Scroller.ScrollToEnd(), DispatcherPriority.Background);
}
