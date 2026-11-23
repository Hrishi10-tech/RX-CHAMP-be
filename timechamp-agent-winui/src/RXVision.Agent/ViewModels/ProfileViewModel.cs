using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>Profile: who is signed in; tapping the account opens the avatar page. For everyone, Staff included.</summary>
public sealed partial class ProfileViewModel : ObservableObject
{
    private readonly IAgent _agent;

    public ProfileViewModel(IAgent agent)
    {
        _agent = agent;
        _agent.Avatars.Changed += Refresh;
    }

    [ObservableProperty] private string _displayName = "";
    [ObservableProperty] private string _email = "";
    [ObservableProperty] private string? _avatarId;

    /// <summary>Set by the app: opens the picker.</summary>
    public Action? AvatarRequested { get; set; }

    [RelayCommand]
    private void OpenAvatar() => AvatarRequested?.Invoke();

    public void Refresh()
    {
        DisplayName = _agent.User?.DisplayName ?? _agent.Avatars.PersonName ?? "";
        Email = _agent.User?.Email ?? "";
        AvatarId = _agent.Avatars.ShownId;
    }
}
