using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace RXVision.Agent.ViewModels;

/// <summary>"!" when action is needed, "i" for information.</summary>
public enum AlertLevel { Info, Action }

/// <summary>
/// One alert's card on top of the panel (AGENT.md section 3): its words and its actions, ready.
/// It stays until it is acted on or stops being true; the badge only says it is new.
/// </summary>
public sealed partial class AlertCard : ObservableObject
{
    public AlertCard(string key, AlertLevel level, string title, string body = "")
    {
        Key = key;
        Level = level;
        _title = title;
        _body = body;
    }

    /// <summary>The same key replaces the card (a reminder that comes again).</summary>
    public string Key { get; }
    public AlertLevel Level { get; }
    public string Glyph => Level == AlertLevel.Action ? Icon.IconGlyphs.Action : Icon.IconGlyphs.Info;
    public bool IsAction => Level == AlertLevel.Action;

    [ObservableProperty] private string _title;
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasBody))]
    private string _body;

    public bool HasBody => !string.IsNullOrEmpty(Body);

    public string? PrimaryText { get; init; }
    public Func<Task>? OnPrimary { get; init; }
    /// <summary>The quiet action, as text, under the primary; outlined when it is as real an answer (End meeting).</summary>
    public string? SecondaryText { get; init; }
    public Func<Task>? OnSecondary { get; init; }
    public bool SecondaryIsOutlined { get; init; }

    public bool HasPrimary => PrimaryText is not null;
    public bool HasSecondary => SecondaryText is not null;
    public bool HasQuietSecondary => HasSecondary && !SecondaryIsOutlined;
    public bool HasOutlinedSecondary => HasSecondary && SecondaryIsOutlined;

    /// <summary>The person has opened the panel since it came: no badge for it.</summary>
    public bool Seen { get; set; }

    /// <summary>The panel draws this one as its own screen (AGENT.md section 5, A, C and E): the badge is here, the card is there.</summary>
    public bool DrawnByPanel { get; init; }

    /// <summary>Being read is all it asks: it leaves when the panel that showed it closes.</summary>
    public bool GoneWhenRead { get; init; }

    [RelayCommand]
    private Task Primary() => OnPrimary?.Invoke() ?? Task.CompletedTask;

    [RelayCommand]
    private Task Secondary() => OnSecondary?.Invoke() ?? Task.CompletedTask;
}
