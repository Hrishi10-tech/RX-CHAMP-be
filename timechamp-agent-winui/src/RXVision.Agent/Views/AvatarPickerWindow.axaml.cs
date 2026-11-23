using Avalonia;
using Avalonia.Controls;
using Avalonia.Threading;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Views;

/// <summary>
/// Choosing an avatar: a small frameless window beside the floating icon, with the panel's
/// frame and tokens. Everything it does is in <see cref="ViewModels.AvatarPickerViewModel"/>.
/// </summary>
public partial class AvatarPickerWindow : Window
{
    /// <summary>The grid's distance between rows.</summary>
    private const double RowPitch = 74;

    private AvatarPickerViewModel? _vm;

    public AvatarPickerWindow()
    {
        InitializeComponent();
        TransparencyLevelHint = new[] { WindowTransparencyLevel.Transparent };
        DataContextChanged += (_, _) => Attach(DataContext as AvatarPickerViewModel);
        Opened += (_, _) => ScrollToSelected();
    }

    private void Attach(AvatarPickerViewModel? vm)
    {
        if (_vm is not null) _vm.SetShown -= ScrollToSelected;
        _vm = vm;
        if (_vm is not null) _vm.SetShown += ScrollToSelected;
    }

    /// <summary>The selected avatar is never left under the fade: a row or two down shows one row above it.</summary>
    private void ScrollToSelected()
    {
        var row = _vm?.RowToShow ?? 0;
        Dispatcher.UIThread.Post(() => GridScroller.Offset = new Vector(0, Math.Max(0, row - 1) * RowPitch), DispatcherPriority.Background);
    }
}
