using RXVision.Agent.ViewModels.Dialogs;

namespace RXVision.Agent.Services;

/// <summary>Shows one dialog at a time and waits for the answer.</summary>
public interface IDialogService
{
    /// <summary>True when the person chose the primary button.</summary>
    Task<bool> ShowAsync(DialogViewModel dialog);
}

public static class DialogServiceExtensions
{
    public static Task<bool> ConfirmAsync(this IDialogService dialogs, string title, string message,
        string primary, string cancel = "Cancel", bool danger = false) =>
        dialogs.ShowAsync(new MessageDialogViewModel(title, message)
        {
            PrimaryText = primary,
            CancelText = cancel,
            IsDanger = danger,
        });

    public static Task AlertAsync(this IDialogService dialogs, string title, string message) =>
        dialogs.ShowAsync(new MessageDialogViewModel(title, message));
}
