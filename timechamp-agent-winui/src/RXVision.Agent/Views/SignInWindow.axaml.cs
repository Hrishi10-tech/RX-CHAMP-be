using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Threading;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Views;

/// <summary>Sign-in. Closing it only hides it; the tray icon brings it back.</summary>
public partial class SignInWindow : Window
{
    public SignInWindow()
    {
        InitializeComponent();
        Opened += (_, _) => FocusFirstField();
        Activated += (_, _) => FocusFirstField();
    }

    public bool AllowClose { get; set; }

    private void FocusFirstField() => Dispatcher.UIThread.Post(() =>
    {
        if (DataContext is not SignInViewModel vm || !vm.ShowForm) return;
        if (FocusManager?.GetFocusedElement() is TextBox) return;
        TextBox target = vm.UseCode ? CodeBox : string.IsNullOrWhiteSpace(vm.Email) ? EmailBox : PasswordBox;
        target.Focus();
    }, DispatcherPriority.Input);

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (!e.Handled && e.Key == Key.Escape)
        {
            Hide();
            e.Handled = true;
        }
    }

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
