using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace RXVision.Agent.ViewModels;

public enum ToastKind
{
    Message,
    BreakDue,
    BreakDecision,
    Approval,
    Info,
    /// <summary>A reminder to start the day (good morning, at your desk).</summary>
    Day,
    /// <summary>A break was auto-skipped and needs a comment.</summary>
    AutoSkip,
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
    /// <summary>Stays up until dismissed or withdrawn (the ring).</summary>
    public bool Sticky { get; init; }
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
    public bool IsBreakDue => Kind is ToastKind.BreakDue or ToastKind.AutoSkip;
    public bool IsDecision => Kind is ToastKind.BreakDecision or ToastKind.Approval or ToastKind.Info;
    public bool IsDay => Kind == ToastKind.Day;
    public bool IsCue => Kind == ToastKind.Cue;
    public bool IsCard => Kind != ToastKind.Cue;
    /// <summary>The primary button is the filled one (Take it, Add comment, Start Day); else a soft one.</summary>
    public bool HasStrongPrimary => Kind is ToastKind.BreakDue or ToastKind.AutoSkip or ToastKind.Day;
    public bool IsRejected { get; init; }

    /// <summary>The primary button (e.g. "Take it").</summary>
    public Action? OnPrimary { get; set; }
    /// <summary>A click anywhere else on the card (and the secondary button, unless it has its own action): opens the dashboard.</summary>
    public Action? OnOpen { get; set; }
    /// <summary>The secondary button's own action (e.g. "Skip break"); null: it opens the dashboard.</summary>
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
        OnDismiss?.Invoke();
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
