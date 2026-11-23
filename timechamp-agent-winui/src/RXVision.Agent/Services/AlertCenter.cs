using System.Collections.ObjectModel;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Services;

/// <summary>
/// The alerts in one place, for the icon's badge and the panel's cards. Cards read "!" before "i",
/// then newest first. One badge at a time: "!" over "i". Opening the panel clears the badge; a card
/// stays until it is acted on or stops being true. Anything that wants the person's attention,
/// whatever its source, raises a card here. UI thread only.
/// </summary>
public sealed class AlertCenter
{
    public ObservableCollection<AlertCard> Cards { get; } = new();

    public bool PanelOpen { get; private set; }

    /// <summary>A card came that the person has not seen: the badge pops and the motion runs.</summary>
    public event Action? Arrived;

    /// <summary>The cards or the badge changed.</summary>
    public event Action? Changed;

    /// <summary>The level of the badge to show, or null for none.</summary>
    public AlertLevel? Badge
    {
        get
        {
            var unseen = Cards.Where(c => !c.Seen).ToList();
            if (unseen.Count == 0) return null;
            return unseen.Any(c => c.Level == AlertLevel.Action) ? AlertLevel.Action : AlertLevel.Info;
        }
    }

    public AlertCard? Find(string key) => Cards.FirstOrDefault(c => c.Key == key);

    public bool Has(string key) => Find(key) is not null;

    /// <summary>Puts the card on top of its level. If the panel is open it goes there with no badge and no motion.</summary>
    public void Raise(AlertCard card)
    {
        if (Find(card.Key) is { } old) Cards.Remove(old);
        card.Seen = PanelOpen;
        var at = card.Level == AlertLevel.Action ? 0 : Cards.Count(c => c.Level == AlertLevel.Action);
        Cards.Insert(at, card);
        Changed?.Invoke();
        if (!card.Seen) Arrived?.Invoke();
    }

    /// <summary>It was acted on, or stopped being true.</summary>
    public void Clear(string key)
    {
        if (Find(key) is not { } card) return;
        Cards.Remove(card);
        Changed?.Invoke();
    }

    public void ClearAll()
    {
        if (Cards.Count == 0) return;
        Cards.Clear();
        Changed?.Invoke();
    }

    /// <summary>The panel opened: everything on it is seen, so the badge goes.</summary>
    public void Opened()
    {
        PanelOpen = true;
        foreach (var card in Cards) card.Seen = true;
        Changed?.Invoke();
    }

    /// <summary>The panel closed: what only needed reading has been read.</summary>
    public void Closed()
    {
        PanelOpen = false;
        foreach (var card in Cards.Where(c => c.GoneWhenRead && c.Seen).ToList()) Cards.Remove(card);
        Changed?.Invoke();
    }
}
