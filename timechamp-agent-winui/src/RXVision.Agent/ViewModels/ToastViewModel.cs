using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace RXVision.Agent.ViewModels;

public enum ToastKind
{
    Message,
    Info,
    /// <summary>One quiet line for a few seconds (after a skip or an early return). No buttons, no sound.</summary>
    Cue,
}

/// <summary>The card that slides in beside the floating button.</summary>
public sealed partial class ToastViewModel : ObservableObject
{
    public ToastViewModel(ToastKind kind, string key)
    {
        Kind = kind;
        Key = key;
    }

    public ToastKind Kind { get; }
    /// <summary>Toasts with the same key replace each other (a burst of messages is one card).</summary>
    public string Key { get; }
    /// <summary>When the toast service took it (on its own clock): how long it has waited to be shown.</summary>
    public DateTimeOffset QueuedAt { get; internal set; }
    /// <summary>Clicking the card opens RX Vision but leaves the card up (a question that needs a button).</summary>
    public bool KeepOnOpen { get; init; }
    public TimeSpan Lifetime { get; init; } = TimeSpan.FromSeconds(9);
    /// <summary>Dropped if it could not be shown within this long (a cue is only worth it at once).</summary>
    public TimeSpan? MaxWait { get; init; }

    [ObservableProperty] private string _heading = "";
    [ObservableProperty] private string _title = "";
    [ObservableProperty] private string _stamp = "";
    [ObservableProperty] private string _body = "";
    [ObservableProperty] private int _count = 1;
    public string Initials { get; init; } = "";
    public string PrimaryText { get; init; } = "Open RX Vision";
    /// <summary>A second, quieter button (null: none).</summary>
    public string? SecondaryText { get; init; }
    public bool HasSecondary => SecondaryText is not null;

    public bool IsMessage => Kind == ToastKind.Message;
    public bool IsInfo => Kind == ToastKind.Info;
    public bool IsCue => Kind == ToastKind.Cue;
    public bool IsCard => Kind != ToastKind.Cue;

    /// <summary>The primary button.</summary>
    public Action? OnPrimary { get; set; }
    /// <summary>A click anywhere else on the card (and the secondary button, unless it has its own action): opens the dashboard.</summary>
    public Action? OnOpen { get; set; }
    /// <summary>The secondary button's own action; null: it opens the dashboard.</summary>
    public Action? OnSecondary { get; set; }
    /// <summary>Set by the toast service: closes this card.</summary>
    public Action? OnDismiss { get; set; }

    [RelayCommand]
    private void Primary()
    {
        OnDismiss?.Invoke();
        (OnPrimary ?? OnOpen)?.Invoke();
    }

    [RelayCommand]
    private void Open()
    {
        if (!KeepOnOpen) OnDismiss?.Invoke();
        OnOpen?.Invoke();
    }

    [RelayCommand]
    private void Secondary()
    {
        OnDismiss?.Invoke();
        (OnSecondary ?? OnOpen)?.Invoke();
    }

    [RelayCommand]
    private void Dismiss() => OnDismiss?.Invoke();
}
