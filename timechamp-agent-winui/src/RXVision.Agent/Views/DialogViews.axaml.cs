using Avalonia;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Threading;
using Avalonia.VisualTree;

namespace RXVision.Agent.Views;

/// <summary>Puts keyboard focus inside a dialog as it appears, so Enter and Esc work straight away.</summary>
internal static class DialogFocus
{
    public static void Focus(Control? target)
    {
        if (target is null) return;
        Dispatcher.UIThread.Post(() =>
        {
            target.Focus();
            if (target is TextBox box) box.CaretIndex = box.Text?.Length ?? 0;
        }, DispatcherPriority.Input);
    }
}

public partial class MessageDialogView : UserControl
{
    public MessageDialogView() => InitializeComponent();

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        var alt = DataContext is ViewModels.Dialogs.MessageDialogViewModel { HasAlt: true };
        DialogFocus.Focus(alt ? AltPrimary : Primary);
    }
}

public partial class ReasonDialogView : UserControl
{
    public ReasonDialogView()
    {
        InitializeComponent();
        // A quick reason fills the box; the caret goes back there to add to it
        // (a short one, like "Deadline", needs a few more words).
        ChipList.AddHandler(Button.ClickEvent, (_, _) => DialogFocus.Focus(ReasonBox), RoutingStrategies.Bubble, handledEventsToo: true);
    }

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        DialogFocus.Focus(ReasonBox);
    }
}

public partial class NoteDialogView : UserControl
{
    public NoteDialogView() => InitializeComponent();

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        DialogFocus.Focus(NoteBox);
    }
}

public partial class EndDayDialogView : UserControl
{
    public EndDayDialogView()
    {
        InitializeComponent();
        // A quick reason fills its card's box; the caret goes back there to add to it.
        AddHandler(Button.ClickEvent, (_, e) =>
        {
            var card = (e.Source as Visual)?.GetVisualAncestors().OfType<Border>().FirstOrDefault(b => b.Classes.Contains("commentcard"));
            var box = card?.GetVisualDescendants().OfType<TextBox>().FirstOrDefault();
            if (box is not null) DialogFocus.Focus(box);
        }, RoutingStrategies.Bubble, handledEventsToo: true);
    }

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        // The boxes are made by the list once it lays out: focus the first one then.
        Dispatcher.UIThread.Post(() =>
        {
            var first = this.GetVisualDescendants().OfType<TextBox>().FirstOrDefault();
            DialogFocus.Focus(first);
        }, DispatcherPriority.Loaded);
    }
}

public partial class MeetingDialogView : UserControl
{
    public MeetingDialogView() => InitializeComponent();

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        DialogFocus.Focus(AgendaBox);
    }
}

public partial class QuickBreakDialogView : UserControl
{
    public QuickBreakDialogView() => InitializeComponent();

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        DialogFocus.Focus(Primary);
    }
}

public partial class KeyDialogView : UserControl
{
    public KeyDialogView() => InitializeComponent();

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        DialogFocus.Focus(KeyBox);
    }
}

public partial class ProgressDialogView : UserControl
{
    public ProgressDialogView() => InitializeComponent();
}
