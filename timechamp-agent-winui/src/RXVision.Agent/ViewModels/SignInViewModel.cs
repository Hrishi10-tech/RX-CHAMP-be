using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>
/// Sign-in: email and password, or a setup code from the portal; an advanced
/// server field; the reconnecting state; and why a session was lost.
/// </summary>
public sealed partial class SignInViewModel : ObservableObject
{
    private readonly IAgent _agent;
    private readonly UiSettingsStore? _settings;
    private readonly ILog _log;

    public SignInViewModel(IAgent agent, UiSettingsStore? settings, ILog log)
    {
        _agent = agent;
        _settings = settings;
        _log = log;
        _email = settings?.Current.LastEmail ?? "";
        _server = agent.ApiBaseUrl;
    }

    /// <summary>As the foot of the Profile tab: the version, other servers than production (AG-2), unsigned updates (F-01).</summary>
    public string VersionText =>
        (_agent.BuiltForHosts is { } hosts ? $"Version {_agent.Version} · {hosts}" : $"Version {_agent.Version}")
        + (_agent.UnsignedUpdatesNote is { } note ? "\n" + note : "");

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SignInCommand))]
    private string _email = "";

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SignInCommand))]
    private string _password = "";

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(ConnectCommand))]
    private string _setupCode = "";

    [ObservableProperty] private string _server = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(UseEmail), nameof(Subtitle))]
    private bool _useCode;

    [ObservableProperty] private bool _showAdvanced;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SignInCommand), nameof(ConnectCommand))]
    private bool _isBusy;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    private string? _error;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasSessionLost))]
    private string? _sessionLostReason;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowForm), nameof(ShowConnecting))]
    private bool _isConnecting;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowForm), nameof(ShowConnecting))]
    private bool _signInAnyway;

    public bool UseEmail => !UseCode;
    public bool HasError => !string.IsNullOrEmpty(Error);
    public bool HasSessionLost => !string.IsNullOrEmpty(SessionLostReason);
    public bool ShowConnecting => IsConnecting && !SignInAnyway;
    public bool ShowForm => !ShowConnecting;
    public string Subtitle => UseCode
        ? "Paste the setup code from the RX Vision portal."
        : "Sign in with the details your manager sent you.";

    /// <summary>Called before the window is shown, so it matches the agent's state.</summary>
    public void Prepare(AgentState state)
    {
        IsConnecting = state == AgentState.Connecting;
        if (!IsConnecting) SignInAnyway = false;
        if (string.IsNullOrWhiteSpace(Server) || !ShowAdvanced) Server = _agent.ApiBaseUrl;
    }

    // An old error goes away as soon as they start fixing what they typed.
    partial void OnEmailChanged(string value) => ClearErrorOnEdit();
    partial void OnPasswordChanged(string value) => ClearErrorOnEdit();
    partial void OnSetupCodeChanged(string value) => ClearErrorOnEdit();

    private void ClearErrorOnEdit()
    {
        if (!IsBusy) Error = null;
    }

    public void SetSessionLost(string reason)
    {
        var text = string.IsNullOrWhiteSpace(reason) ? "your session ended" : reason.Trim().TrimEnd('.');
        SessionLostReason = $"You were signed out: {char.ToLowerInvariant(text[0])}{text[1..]}.";
    }

    [RelayCommand(CanExecute = nameof(CanSignIn))]
    private async Task SignInAsync()
    {
        IsBusy = true;
        Error = null;
        try
        {
            var current = _agent.ApiBaseUrl.TrimEnd('/');
            var server = Server?.Trim();
            var serverArg = string.IsNullOrEmpty(server) || string.Equals(server.TrimEnd('/'), current, StringComparison.OrdinalIgnoreCase)
                ? null
                : server;
            var error = await _agent.SignInAsync(Email.Trim(), Password, serverArg);
            if (error is null)
            {
                Password = "";
                SessionLostReason = null;
                SignInAnyway = false;
                if (_settings is not null)
                {
                    _settings.Current.LastEmail = Email.Trim();
                    _settings.Save();
                }
            }
            else
            {
                Error = error;
            }
        }
        catch (Exception ex)
        {
            _log.Error("ui", "sign-in failed", ex);
            Error = "Sign-in didn't work. Try again in a moment.";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private bool CanSignIn() => !IsBusy && !string.IsNullOrWhiteSpace(Email) && !string.IsNullOrEmpty(Password);

    [RelayCommand(CanExecute = nameof(CanConnect))]
    private async Task ConnectAsync()
    {
        IsBusy = true;
        Error = null;
        try
        {
            var error = await _agent.SignInWithCodeAsync(SetupCode);
            if (error is null)
            {
                SetupCode = "";
                SessionLostReason = null;
                SignInAnyway = false;
            }
            else
            {
                Error = error;
            }
        }
        catch (Exception ex)
        {
            _log.Error("ui", "setup code sign-in failed", ex);
            Error = "That didn't work. Try again in a moment.";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private bool CanConnect() => !IsBusy && !string.IsNullOrWhiteSpace(SetupCode);

    [RelayCommand]
    private void ToggleMode()
    {
        UseCode = !UseCode;
        Error = null;
    }

    [RelayCommand]
    private void ToggleAdvanced() => ShowAdvanced = !ShowAdvanced;

    [RelayCommand]
    private void ShowSignInForm() => SignInAnyway = true;
}
