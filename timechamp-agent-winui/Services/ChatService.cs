using SocketIOClient;

namespace TimeChampAgent.Services;

/// <summary>
/// Live chat over the backend's socket.io <c>/chat</c> namespace. Connects to the
/// server root (socket.io is not under the API prefix), authenticating the handshake
/// with a freshly-rotated access token. Incoming <c>chat:message</c> events are raised
/// on <see cref="MessageReceived"/>. The socket only checks auth at handshake, so once
/// connected it survives access-token expiry; on any drop we refresh + reconnect.
/// </summary>
public sealed class ChatService
{
    private readonly ApiClient _api;
    private SocketIOClient.SocketIO? _io;
    private volatile bool _run;

    /// <summary>Raised (on a background thread) when a chat message arrives for this user.</summary>
    public event Action<ChatMessage>? MessageReceived;

    public bool IsConnected => _io?.Connected ?? false;

    public ChatService(ApiClient api) => _api = api;

    public void Start()
    {
        if (_run) return;
        _run = true;
        _ = ConnectAsync();
    }

    public void Stop()
    {
        _run = false;
        var io = _io;
        _io = null;
        if (io is not null)
        {
            _ = Task.Run(async () =>
            {
                try { await io.DisconnectAsync(); } catch { }
                io.Dispose();
            });
        }
    }

    private async Task ConnectAsync()
    {
        if (!_run) return;
        try
        {
            // A fresh access token (2-min TTL) guarantees the handshake authenticates.
            await _api.RefreshSessionAsync();
            var token = _api.AccessToken;
            if (string.IsNullOrEmpty(token)) { ScheduleReconnect(); return; }

            var uri = _api.Origin.TrimEnd('/') + "/chat";
            var io = new SocketIOClient.SocketIO(uri, new SocketIOOptions
            {
                Reconnection = false, // we manage reconnect so we can refresh the token first
                Auth = new Dictionary<string, string> { ["token"] = token! },
                Transport = SocketIOClient.Transport.TransportProtocol.WebSocket,
                ConnectionTimeout = TimeSpan.FromSeconds(10),
            });

            io.On("chat:message", resp =>
            {
                try
                {
                    var msg = resp.GetValue<ChatMessage>();
                    if (msg is not null) MessageReceived?.Invoke(msg);
                }
                catch { /* ignore malformed frames */ }
            });

            io.OnDisconnected += (_, _) => { if (_run) ScheduleReconnect(); };

            _io = io;
            await io.ConnectAsync();
        }
        catch
        {
            ScheduleReconnect();
        }
    }

    private void ScheduleReconnect()
    {
        if (!_run) return;
        _ = Task.Run(async () =>
        {
            await Task.Delay(5000);
            var old = _io;
            _io = null;
            if (old is not null) { try { old.Dispose(); } catch { } }
            await ConnectAsync();
        });
    }
}
