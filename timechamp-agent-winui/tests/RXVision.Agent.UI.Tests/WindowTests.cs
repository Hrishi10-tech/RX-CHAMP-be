using Avalonia;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Controls;
using Avalonia.Threading;
using Avalonia.VisualTree;
using RXVision.Agent.ViewModels;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>Window behaviour that needs a (headless) window.</summary>
public class WindowTests
{
    private static void Settle()
    {
        for (var i = 0; i < 3; i++)
        {
            Dispatcher.UIThread.RunJobs();
            AvaloniaHeadlessPlatform.ForceRenderTimerTick();
        }
    }

    private static (BubbleWindow Window, Services.UiSettingsStore Store, string Dir) ShowBubble()
    {
        var dir = Path.Combine(Path.GetTempPath(), "rxv-ui-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var store = new Services.UiSettingsStore(dir, Core.Util.NullLog.Instance);
        var window = new IconRig(new FakeAgent("10:20")).Window(new Services.BubblePlacement(store));
        window.Show();
        Settle();
        return (window, store, dir);
    }

    [AvaloniaFact]
    public void Dragging_the_button_moves_it_and_saves_the_spot_without_opening_anything()
    {
        var (window, store, dir) = ShowBubble();
        var clicks = 0;
        var drags = 0;
        window.Clicked += () => clicks++;
        window.DragEnded += () => drags++;
        var before = window.Anchor;

        window.MouseMove(new Point(36, 36));
        window.MouseDown(new Point(36, 36), Avalonia.Input.MouseButton.Left);
        window.MouseMove(new Point(36, 12));
        window.MouseMove(new Point(22, -24));
        Settle();
        // The window has followed: the pointer is over the icon again.
        window.MouseUp(new Point(36, 36), Avalonia.Input.MouseButton.Left);
        Settle();

        Assert.Equal(0, clicks);
        Assert.Equal(1, drags);
        Assert.NotEqual(before, window.Anchor);
        Assert.True(window.Anchor.Y < before.Y);
        var saved = Assert.Single(store.Current.Bubble).Value;
        Assert.Equal(window.Anchor, new PixelPoint(saved.X, saved.Y));
        Assert.Contains(window.Anchor.X.ToString(), File.ReadAllText(Path.Combine(dir, "ui-settings.json")));

        // And it comes back there next time.
        var again = new Services.BubblePlacement(new Services.UiSettingsStore(dir, Core.Util.NullLog.Instance));
        Assert.Equal(window.Anchor, again.Load(window.Screens.All, window.Screens.Primary));
        window.Close();
    }

    [AvaloniaFact]
    public void A_click_on_the_button_is_a_click()
    {
        var (window, store, _) = ShowBubble();
        var clicks = 0;
        var drags = 0;
        window.Clicked += () => clicks++;
        window.DragEnded += () => drags++;
        var before = window.Anchor;
        window.MouseMove(new Point(36, 36));
        window.MouseDown(new Point(36, 36), Avalonia.Input.MouseButton.Left);
        window.MouseMove(new Point(37, 37));
        window.MouseUp(new Point(37, 37), Avalonia.Input.MouseButton.Left);
        Settle();
        Assert.Equal(1, clicks);
        Assert.Equal(0, drags);
        Assert.Equal(before, window.Anchor);
        Assert.Empty(store.Current.Bubble);
        window.Close();
    }

    [AvaloniaFact]
    public void The_toast_sits_beside_the_button_and_never_covers_it()
    {
        // Half way up the screen, where the card can centre on it.
        var dir = Path.Combine(Path.GetTempPath(), "rxv-ui-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var placement = new Services.BubblePlacement(new Services.UiSettingsStore(dir, Core.Util.NullLog.Instance));
        var bubble = new IconRig(new FakeAgent("10:59:30")).Window(placement);
        var screen = bubble.Screens.Primary!;
        placement.Save(screen, new PixelPoint(screen.WorkingArea.Right - 72, screen.WorkingArea.Y + screen.WorkingArea.Height / 2));
        bubble.Show();
        Settle();
        var footprint = bubble.Footprint;
        Assert.Equal(bubble.Position, footprint.Position);
        Assert.Equal(72, footprint.Width / bubble.DesktopScaling, 0);

        var toast = new ToastWindow
        {
            Animate = false,
            DataContext = new ToastViewModel(ToastKind.Message, "chat:m-1")
            {
                Heading = "New message", Title = "Maya Reddy", Stamp = "11:00",
                Body = "Can you join the 4 pm call?", PrimaryText = "View messages", SecondaryText = "Open RX Vision",
            },
        };
        toast.ShowBeside(footprint, bubble.Anchor);
        Settle();
        var scale = toast.DesktopScaling;
        var cardLeft = toast.Position.X + (int)Math.Round(12 * scale);
        var cardRight = toast.Position.X + (int)Math.Round((toast.Width - 12) * scale);
        Assert.True(cardRight <= footprint.X, $"card ends at {cardRight}, the button starts at {footprint.X}");
        Assert.True(cardLeft >= 0);
        var cardMiddle = toast.Position.Y + (int)Math.Round(toast.Bounds.Height * scale / 2);
        Assert.InRange(cardMiddle, bubble.Anchor.Y - 2, bubble.Anchor.Y + 2);
        toast.Close();
        bubble.Close();
    }

    [AvaloniaFact]
    public void Closing_the_dashboard_only_hides_it()
    {
        var agent = new FakeAgent("10:20");
        var vm = new DashboardViewModel(agent, new Services.BreakActions(agent, new FakeDialogs(), Core.Util.NullLog.Instance), Core.Util.NullLog.Instance);
        var window = new DashboardWindow { DataContext = vm };
        var hidden = false;
        window.VisibilityChanged += visible => hidden |= !visible;
        window.Show();
        window.Close();
        Assert.False(window.IsVisible);
        Assert.True(hidden);
        window.Show();
        Assert.True(window.IsVisible);
        window.AllowClose = true;
        window.Close();
    }

    [AvaloniaFact]
    public async Task Esc_cancels_and_closing_the_window_cancels_a_standalone_dialog()
    {
        var dialog = new ViewModels.Dialogs.MessageDialogViewModel("Quit RX Vision?", "m") { PrimaryText = "Quit", CancelText = "Keep running" };
        var window = new DialogWindow { DataContext = dialog };
        window.Show();
        Settle();
        window.KeyPress(Avalonia.Input.Key.Escape, Avalonia.Input.RawInputModifiers.None, Avalonia.Input.PhysicalKey.Escape, null);
        Settle();
        Assert.True(dialog.IsCompleted);
        Assert.False(await dialog.Completion);
        window.Close();
    }

    [AvaloniaFact]
    public async Task Enter_submits_the_reason_once_it_is_long_enough()
    {
        var dialog = new ViewModels.Dialogs.ReasonDialogViewModel("t", "m", 10);
        var window = new DialogWindow { DataContext = dialog };
        window.Show();
        Settle();
        window.KeyPress(Avalonia.Input.Key.Enter, Avalonia.Input.RawInputModifiers.None, Avalonia.Input.PhysicalKey.Enter, null);
        Settle();
        Assert.False(dialog.IsCompleted);
        dialog.Text = "On a customer call";
        Settle();
        window.KeyPress(Avalonia.Input.Key.Enter, Avalonia.Input.RawInputModifiers.None, Avalonia.Input.PhysicalKey.Enter, null);
        Settle();
        Assert.True(dialog.IsCompleted);
        Assert.True(await dialog.Completion);
        window.Close();
    }
    /// <summary>The End Day dialog over the dashboard at its default size (1080 x 700).</summary>
    private static async Task<(DashboardWindow Window, ScrollViewer Overlay, ScrollViewer List)> EndDayOver(int boxes)
    {
        var agent = new FakeAgent("18:32");
        var vm = new DashboardViewModel(agent, new Services.BreakActions(agent, new FakeDialogs(), Core.Util.NullLog.Instance), Core.Util.NullLog.Instance);
        vm.Refresh();
        var window = new DashboardWindow { DataContext = vm, Width = 1080, Height = 700 };
        window.Show();
        vm.Overlay = new ViewModels.Dialogs.EndDayDialogViewModel(EndDayFit.Items(boxes), "your manager", "Your manager");
        Settle();
        await Task.Yield();
        Settle();
        var list = window.GetVisualDescendants().OfType<ScrollViewer>().Single(s => s.Name == "CommentList");
        var overlay = list.GetVisualAncestors().OfType<ScrollViewer>().First();
        return (window, overlay, list);
    }

    [AvaloniaFact]
    public async Task Three_comment_boxes_fit_the_dashboard_at_its_default_size_without_scrolling()
    {
        var (window, overlay, list) = await EndDayOver(3);
        Assert.True(overlay.Extent.Height <= overlay.Viewport.Height + 0.5, $"the dialog scrolls: {overlay.Extent.Height:F0} in {overlay.Viewport.Height:F0}");
        Assert.True(list.Extent.Height <= list.Viewport.Height + 0.5, $"the list scrolls: {list.Extent.Height:F0} in {list.Viewport.Height:F0}");
        window.AllowClose = true;
        window.Close();
    }

    [AvaloniaFact]
    public async Task A_fourth_comment_box_scrolls_inside_the_list()
    {
        var (window, overlay, list) = await EndDayOver(4);
        Assert.True(overlay.Extent.Height <= overlay.Viewport.Height + 0.5, $"the dialog scrolls: {overlay.Extent.Height:F0} in {overlay.Viewport.Height:F0}");
        Assert.True(list.Extent.Height > list.Viewport.Height + 20, "four boxes scroll inside the list");
        window.AllowClose = true;
        window.Close();
    }
}

/// <summary>Skipped breaks for the End Day dialog, as the server lists them (lunch included).</summary>
public static class EndDayFit
{
    public static ViewModels.Dialogs.SkipCommentItemViewModel[] Items(int count) => new[]
    {
        new ViewModels.Dialogs.SkipCommentItemViewModel("morning-auto", "Morning break", "Auto-skipped at 12:00", 10, Services.BreakActions.SkipChips, kind: "MORNING"),
        new ViewModels.Dialogs.SkipCommentItemViewModel("lunch-auto", "Lunch break", "Auto-skipped at 14:00", 10, Services.BreakActions.SkipChips, kind: "LUNCH"),
        new ViewModels.Dialogs.SkipCommentItemViewModel("evening-auto", "Evening break", "Auto-skipped at 17:00", 10, Services.BreakActions.SkipChips, kind: "EVENING"),
        new ViewModels.Dialogs.SkipCommentItemViewModel("lunch-old", "Lunch break", "Auto-skipped at 14:00 on 12 Oct", 10, Services.BreakActions.SkipChips, kind: "LUNCH"),
    }.Take(count).ToArray();
}
