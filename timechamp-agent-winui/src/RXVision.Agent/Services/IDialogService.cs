using RXVision.Agent.ViewModels.Dialogs;

namespace RXVision.Agent.Services;

/// <summary>Shows one dialog at a time and waits for the answer.</summary>
public interface IDialogService
{
    /// <summary>True when the person chose the primary button.</summary>
    Task<bool> ShowAsync(DialogViewModel dialog);

    /// <summary>
    /// Brings the question waiting for an answer in front, if there is one. A tap while a
    /// question is open shows it again, rather than doing nothing (a Mac may hide it behind other apps).
    /// </summary>
    void BringForward() { }
}

public static class DialogServiceExtensions
{
    public static Task<bool> ConfirmAsync(this IDialogService dialogs, string title, string message,
        string primary, string cancel = "Cancel") =>
        dialogs.ShowAsync(new MessageDialogViewModel(title, message)
        {
            PrimaryText = primary,
            CancelText = cancel,
        });

    public static Task AlertAsync(this IDialogService dialogs, string title, string message) =>
        dialogs.ShowAsync(new MessageDialogViewModel(title, message));
}
