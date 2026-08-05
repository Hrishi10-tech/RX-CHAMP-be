using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using TimeChampAgent.Services;

namespace TimeChampAgent.ViewModels;

/// <summary>Sign-in screen. Raises <see cref="SignedIn"/> on success.</summary>
public partial class LoginViewModel : ObservableObject
{
    private readonly ApiClient _api;

    public LoginViewModel(ApiClient api) => _api = api;

    /// <summary>Set by the view/app: called after a successful sign-in.</summary>
    public Action? SignedIn { get; set; }

    [ObservableProperty] private string _email = "";
    [ObservableProperty] private string _password = "";
    [ObservableProperty] private string _errorText = "";
    [ObservableProperty] private bool _hasError;
    [ObservableProperty] private bool _busy;
    [ObservableProperty] private string _signInLabel = "Sign in";

    [RelayCommand]
    private async Task SignIn()
    {
        HasError = false;
        if (string.IsNullOrWhiteSpace(Email) || string.IsNullOrWhiteSpace(Password))
        {
            ShowError("Enter your email and password.");
            return;
        }

        SetBusy(true);
        var (ok, error) = await _api.LoginAsync(Email.Trim(), Password);
        SetBusy(false);

        if (!ok) { ShowError(error ?? "Sign-in failed."); return; }
        SignedIn?.Invoke();
    }

    private void SetBusy(bool busy)
    {
        Busy = busy;
        SignInLabel = busy ? "Signing in…" : "Sign in";
    }

    private void ShowError(string message)
    {
        ErrorText = message;
        HasError = true;
    }
}
