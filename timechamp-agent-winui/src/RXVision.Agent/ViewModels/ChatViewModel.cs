using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

public sealed class ContactItem
{
    public ContactItem(ChatContact contact)
    {
        Contact = contact;
        var who = contact.Relation switch
        {
            "MANAGER" => "your manager",
            "REPORT" => "your team",
            _ => contact.Role switch { "SUPER_ADMIN" => "admin", "MANAGER" => "manager", _ => null },
        };
        Display = who is null ? contact.Name : $"{contact.Name} ({who})";
        Initials = Fmt.Initials(contact.Name);
    }

    public ChatContact Contact { get; }
    public string UserId => Contact.UserId;
    public string Name => Contact.Name;
    public string Display { get; }
    public string Initials { get; }
    public override string ToString() => Display;
}

public sealed class ChatMessageItem
{
    public ChatMessageItem(ChatMessage message, string stamp, string initials)
    {
        Id = message.Id;
        Body = message.Body;
        IsMine = message.Mine;
        CreatedAt = message.CreatedAt;
        Stamp = stamp;
        Initials = initials;
    }

    public string Id { get; }
    public string Body { get; }
    public bool IsMine { get; }
    public bool IsTheirs => !IsMine;
    public DateTimeOffset CreatedAt { get; }
    public string Stamp { get; }
    public string Initials { get; }
}

/// <summary>
/// Chat with your manager (or your staff). The conversation is loaded whenever
/// it comes on screen, which is also what marks it read; live messages are added
/// as they arrive; a message that fails to send stays in the box.
/// </summary>
public sealed partial class ChatViewModel : ObservableObject
{
    public const int MaxLength = 2000;

    private readonly IAgent _agent;
    private readonly ILog _log;
    private readonly HashSet<string> _ids = new();
    private int _loadVersion;
    private bool _syncingContacts;

    public ChatViewModel(IAgent agent, ILog log)
    {
        _agent = agent;
        _log = log;
        Messages.CollectionChanged += (_, _) => OnPropertyChanged(nameof(IsEmpty));
    }

    public ObservableCollection<ContactItem> Contacts { get; } = new();
    public ObservableCollection<ChatMessageItem> Messages { get; } = new();
    public int MaxChars => MaxLength;

    /// <summary>Raised after messages were added at the bottom (the view scrolls).</summary>
    public event Action? MessagesAdded;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HeaderText), nameof(HasContact))]
    [NotifyCanExecuteChangedFor(nameof(SendCommand))]
    private ContactItem? _selectedContact;

    [ObservableProperty] private bool _hasManyContacts;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CounterText), nameof(HasCounter))]
    [NotifyCanExecuteChangedFor(nameof(SendCommand))]
    private string _draft = "";

    [ObservableProperty] private string? _sendError;
    [ObservableProperty] private bool _isLoading;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SendCommand))]
    [NotifyPropertyChangedFor(nameof(CanType))]
    private bool _isSending;

    [ObservableProperty] private string _emptyText = "Loading messages...";

    public bool IsEmpty => Messages.Count == 0;
    public bool HasContact => SelectedContact is not null;
    public bool CanType => !IsSending;
    public string HeaderText => SelectedContact is { } c ? c.Name : "Messages";
    public bool HasCounter => CounterText is not null;
    public string? CounterText => Draft.Length >= MaxLength - 200 ? $"{Draft.Length} / {MaxLength}" : null;

    partial void OnDraftChanged(string value)
    {
        if (SendError is not null && value.Length > 0) SendError = null;
    }

    partial void OnSelectedContactChanged(ContactItem? value)
    {
        if (_syncingContacts) return;
        Messages.Clear();
        _ids.Clear();
        SendError = null;
        if (value is not null) _ = SafeAsync(LoadConversationAsync);
    }

    /// <summary>The chat came on screen: make sure there is someone to talk to, then load (and so read) the conversation.</summary>
    public async Task ActivateAsync()
    {
        var chat = _agent.Chat;
        if (chat is null)
        {
            EmptyText = "Messages aren't available right now. Try again in a moment.";
            return;
        }
        if (!chat.ContactsLoaded || chat.Contacts.Count == 0) await chat.LoadContactsAsync();
        SyncContacts(chat);
        if (SelectedContact is null)
        {
            EmptyText = chat.ContactsLoaded
                ? "No one to chat with yet. Your department's managers appear here once you're in a department."
                : "Messages appear when you're back online.";
            return;
        }
        await LoadConversationAsync();
    }

    private void SyncContacts(IChat chat)
    {
        var current = SelectedContact?.UserId;
        var list = chat.Contacts.Select(c => new ContactItem(c)).ToList();
        if (list.Select(c => c.UserId).SequenceEqual(Contacts.Select(c => c.UserId))) return;
        _syncingContacts = true;
        try
        {
            Contacts.Clear();
            foreach (var c in list) Contacts.Add(c);
            HasManyContacts = Contacts.Count > 1;
            var pick = Contacts.FirstOrDefault(c => c.UserId == current)
                ?? Contacts.FirstOrDefault(c => c.UserId == chat.DefaultContact?.UserId)
                ?? Contacts.FirstOrDefault();
            SelectedContact = pick;
        }
        finally
        {
            _syncingContacts = false;
        }
        if (SelectedContact?.UserId != current)
        {
            Messages.Clear();
            _ids.Clear();
        }
    }

    /// <summary>Shows the conversation with one person (a toast for someone else's message).</summary>
    public void Select(string userId)
    {
        var contact = Contacts.FirstOrDefault(c => c.UserId == userId);
        if (contact is not null && !ReferenceEquals(contact, SelectedContact)) SelectedContact = contact;
    }

    /// <summary>Reloads the conversation (which marks it read on the server).</summary>
    public async Task LoadConversationAsync()
    {
        var chat = _agent.Chat;
        var contact = SelectedContact;
        if (chat is null || contact is null) return;
        var version = ++_loadVersion;
        IsLoading = Messages.Count == 0;
        if (Messages.Count == 0) EmptyText = "Loading messages...";
        var list = await chat.LoadConversationAsync(contact.UserId);
        if (version != _loadVersion || !ReferenceEquals(contact, SelectedContact)) return;
        IsLoading = false;
        if (list is null)
        {
            if (Messages.Count == 0) EmptyText = "Messages appear when you're back online.";
            return;
        }
        var added = false;
        foreach (var m in list.OrderBy(m => m.CreatedAt)) added |= Add(m, notify: false);
        if (Messages.Count == 0) EmptyText = $"No messages yet. Say hello to {FirstName(contact.Name)}.";
        if (added) MessagesAdded?.Invoke();
    }

    /// <summary>A live message (socket). Shown when it belongs to the open conversation.</summary>
    public bool OnMessageReceived(ChatMessage message)
    {
        var contact = SelectedContact;
        if (contact is null) return false;
        if (message.FromUserId != contact.UserId && message.ToUserId != contact.UserId) return false;
        return Add(message, notify: true);
    }

    [RelayCommand(CanExecute = nameof(CanSend))]
    private async Task SendAsync()
    {
        var chat = _agent.Chat;
        var contact = SelectedContact;
        var text = Draft;
        if (chat is null || contact is null || string.IsNullOrWhiteSpace(text)) return;
        IsSending = true;
        SendError = null;
        try
        {
            var result = await chat.SendAsync(contact.UserId, text);
            if (result.Ok)
            {
                Draft = "";
                if (result.Data is { } sent)
                {
                    sent.Mine = true;
                    Add(sent, notify: true);
                }
                else
                {
                    await LoadConversationAsync();
                }
            }
            else
            {
                SendError = result.Transient
                    ? "Check your connection and try sending again."
                    : result.Message ?? "Try sending that again.";
            }
        }
        catch (Exception ex)
        {
            _log.Warn("ui", "chat send failed", ex);
            SendError = "Try sending that again.";
        }
        finally
        {
            IsSending = false;
        }
    }

    private bool CanSend() =>
        !IsSending && SelectedContact is not null && !string.IsNullOrWhiteSpace(Draft) && Draft.Trim().Length <= MaxLength;

    private bool Add(ChatMessage message, bool notify)
    {
        if (string.IsNullOrEmpty(message.Id) || !_ids.Add(message.Id)) return false;
        var initials = message.Mine ? "" : SelectedContact?.Initials ?? "?";
        // In the business time zone, like every other time on screen (SPEC 2.10).
        var item = new ChatMessageItem(message, Fmt.ChatStamp(_agent.BusinessLocal(message.CreatedAt), _agent.BusinessLocal(DateTimeOffset.UtcNow)), initials);
        // Keep the list in time order even if a live message beats the reload.
        var index = Messages.Count;
        while (index > 0 && Messages[index - 1].CreatedAt > item.CreatedAt) index--;
        Messages.Insert(index, item);
        if (notify) MessagesAdded?.Invoke();
        return true;
    }

    public void Reset()
    {
        _loadVersion++;
        _syncingContacts = true;
        try
        {
            Contacts.Clear();
            SelectedContact = null;
        }
        finally
        {
            _syncingContacts = false;
        }
        Messages.Clear();
        _ids.Clear();
        Draft = "";
        SendError = null;
        HasManyContacts = false;
        EmptyText = "Loading messages...";
    }

    private static string FirstName(string name) => name.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? name;

    private async Task SafeAsync(Func<Task> work)
    {
        try { await work(); }
        catch (Exception ex) { _log.Warn("ui", "chat load failed", ex); }
    }
}
