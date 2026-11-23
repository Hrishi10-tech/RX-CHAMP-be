using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Realtime;

/// <summary>
/// Chat with the people in your line (your manager, and your staff if you have
/// any). Messages are keyed by sender, so a message from anyone lands in the
/// right conversation and the unread count stays honest.
/// </summary>
public sealed class ChatService
{
    public const int MaxBody = 2000;

    private readonly ApiClient _api;
    private readonly SocketChannel _socket;
    private readonly ILog _log;
    private List<ChatContact> _contacts = new();
    private int _unread;

    public ChatService(ApiClient api, SocketChannel socket, ILog log)
    {
        _api = api;
        _socket = socket;
        _log = log;
        _socket.On("chat:message", e =>
        {
            var message = Payload.As<ChatMessage>(e);
            if (message is null || message.Mine) return;
            MessageReceived?.Invoke(message);
        });
    }

    public IReadOnlyList<ChatContact> Contacts => _contacts;
    public bool ContactsLoaded { get; private set; }
    public int Unread => _unread;

    /// <summary>A message from someone else arrived (background thread).</summary>
    public event Action<ChatMessage>? MessageReceived;
    public event Action<int>? UnreadChanged;

    public void Start() => _socket.Start();
    public void Stop() => _socket.Stop();
    public void Reconnect() => _socket.Reconnect();

    /// <summary>The person to open by default: your manager, else your first report.</summary>
    public ChatContact? DefaultContact =>
        _contacts.FirstOrDefault(c => c.Relation == "MANAGER")
        ?? _contacts.FirstOrDefault(c => c.Role is "MANAGER" or "SUPER_ADMIN")
        ?? _contacts.FirstOrDefault();

    public string NameOf(string userId) =>
        _contacts.FirstOrDefault(c => c.UserId == userId)?.Name ?? "Someone";

    /// <summary>A contact's avatar changed (the socket's avatar:changed).</summary>
    public void SetAvatar(string userId, string? avatarId)
    {
        if (_contacts.FirstOrDefault(c => c.UserId == userId) is { } contact) contact.AvatarId = avatarId;
    }

    public async Task<bool> LoadContactsAsync(CancellationToken ct = default)
    {
        var result = await _api.GetChatContactsAsync(ct);
        if (!result.Ok || result.Data is null) return false;
        _contacts = result.Data;
        ContactsLoaded = true;
        return true;
    }

    /// <summary>The conversation, oldest first. Reading it marks the other side's messages read.</summary>
    public async Task<IReadOnlyList<ChatMessage>?> LoadConversationAsync(string contactId, CancellationToken ct = default)
    {
        var result = await _api.GetConversationAsync(contactId, 50, ct);
        if (!result.Ok) return null;
        await RefreshUnreadAsync(ct);
        return result.Data ?? new List<ChatMessage>();
    }

    public async Task<ApiResult<ChatMessage>> SendAsync(string contactId, string body, CancellationToken ct = default)
    {
        var text = (body ?? "").Trim();
        if (text.Length == 0) return new ApiResult<ChatMessage> { Outcome = ApiOutcome.Rejected, Message = "Type a message first." };
        if (text.Length > MaxBody) return new ApiResult<ChatMessage> { Outcome = ApiOutcome.Rejected, Message = $"Messages can be up to {MaxBody} characters." };
        return await _api.SendChatMessageAsync(contactId, text, ct);
    }

    public async Task RefreshUnreadAsync(CancellationToken ct = default)
    {
        var result = await _api.GetChatUnreadAsync(ct);
        if (!result.Ok || result.Data is null) return;
        SetUnread(result.Data.Count);
    }

    public void BumpUnread() => SetUnread(_unread + 1);

    private void SetUnread(int count)
    {
        count = Math.Max(0, count);
        if (Interlocked.Exchange(ref _unread, count) != count) UnreadChanged?.Invoke(count);
    }

    public void Reset()
    {
        _contacts = new();
        ContactsLoaded = false;
        SetUnread(0);
    }
}
