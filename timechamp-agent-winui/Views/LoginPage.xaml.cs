using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using TimeChampAgent.ViewModels;
using Windows.System;

namespace TimeChampAgent.Views;

public sealed partial class LoginPage : Page
{
    public LoginViewModel ViewModel { get; }

    public LoginPage()
    {
        ViewModel = new LoginViewModel(App.Api) { SignedIn = () => App.Instance.OnSignedIn() };
        InitializeComponent();
    }

    private void OnPasswordKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        e.Handled = true;
        if (ViewModel.SignInCommand.CanExecute(null)) ViewModel.SignInCommand.Execute(null);
    }
}
