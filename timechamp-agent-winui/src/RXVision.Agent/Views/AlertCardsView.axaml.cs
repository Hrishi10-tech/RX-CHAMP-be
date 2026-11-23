using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.VisualTree;

namespace RXVision.Agent.Views;

/// <summary>The alerts on top of the panel, newest on top, their actions ready.</summary>
public partial class AlertCardsView : UserControl
{
    public AlertCardsView() => InitializeComponent();

    /// <summary>Keyboard focus on the top card's primary action. False when it has none.</summary>
    public bool FocusTopAction()
    {
        var first = Cards.ContainerFromIndex(0);
        var button = first?.GetVisualDescendants().OfType<Button>().FirstOrDefault(b => b.Name == "Primary" && b.IsVisible);
        return button?.Focus(NavigationMethod.Tab) == true;
    }
}
