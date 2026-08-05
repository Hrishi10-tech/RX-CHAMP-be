using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace TimeChampAgent.Helpers;

/// <summary>ContentDialog-based replacements for WPF's MessageBox / InputBox.</summary>
public static class Dialogs
{
    public static async Task<bool> ConfirmAsync(XamlRoot root, string body,
        string title = "Change Status", string ok = "Confirm", string cancel = "Cancel")
    {
        var dialog = new ContentDialog
        {
            Title = title,
            Content = body,
            PrimaryButtonText = ok,
            CloseButtonText = cancel,
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = root,
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    public static async Task NoticeAsync(XamlRoot root, string title, string body, string ok = "OK")
    {
        var dialog = new ContentDialog
        {
            Title = title,
            Content = new TextBlock { Text = body, TextWrapping = TextWrapping.Wrap },
            CloseButtonText = ok,
            XamlRoot = root,
        };
        await dialog.ShowAsync();
    }

    /// <summary>Prompt for a line of text. Returns the text, or null if cancelled/empty.</summary>
    public static async Task<string?> PromptAsync(XamlRoot root, string message, string title = "Start meeting")
    {
        var box = new TextBox { PlaceholderText = message, AcceptsReturn = false };
        var dialog = new ContentDialog
        {
            Title = title,
            Content = new StackPanel
            {
                Spacing = 8,
                Children =
                {
                    new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap },
                    box,
                },
            },
            PrimaryButtonText = "Start",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = root,
        };
        var result = await dialog.ShowAsync();
        return result == ContentDialogResult.Primary ? box.Text : null;
    }
}
