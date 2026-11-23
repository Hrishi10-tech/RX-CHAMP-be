using System.Collections.Concurrent;
using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;
using SocketIOClient;

namespace RXVision.Agent.Core.Realtime;

/// <summary>
/// One socket.io namespace (/chat, /screenshots, /notifications), kept connected
/// by a single loop: a fresh access token for each handshake (refreshed only when
/// close to expiry), a 20 second connect timeout, and jittered backoff from 2 s to
/// 60 s between attempts, so a server restart does not get every agent back in
/// the same second. Stop() ends the loop; Start() after Stop() starts a new one.
/// </summary>
public sealed class SocketChannel : IDisposable
{
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(20);

    private readonly ApiClient _api;
    private readonly string _namespace;
    private readonly ILog _log;
    private readonly ConcurrentDictionary<string, Action<JsonElement>> _handlers = new();
    private CancellationTokenSource? _cts;
    private TaskCompletionSource<bool>? _dropped;
    private SocketIOClient.SocketIO? _io;

    public SocketChannel(ApiClient api, string @namespace, ILog log)
    {
        _api = api;
        _namespace = @namespace.StartsWith('/') ? @namespace : "/" + @namespace;
        _log = log;
    }

    public bool Connected => _io?.Connected ?? false;

    /// <summary>Raised on connect (true) and disconnect (false). Background thread.</summary>
    public event Action<bool>? ConnectionChanged;

    /// <summary>Registers a handler for a server event (before Start).</summary>
    public void On(string eventName, Action<JsonElement> handler) => _handlers[eventName] = handler;

    public void Start()
    {
        if (_cts is not null) return;
        _cts = new CancellationTokenSource();
        var ct = _cts.Token;
        _ = Task.Run(() => LoopAsync(ct));
    }

    public void Stop()
    {
        var cts = Interlocked.Exchange(ref _cts, null);
        if (cts is null) return;
        cts.Cancel();
        _dropped?.TrySetResult(true);
        cts.Dispose();
    }

    /// <summary>Drop and reconnect now (after waking from sleep the socket is usually dead without knowing it).</summary>
    public void Reconnect() => _dropped?.TrySetResult(true);

    /// <summary>A connection that held this long counts as good: the next wait starts small again.</summary>
    internal static readonly TimeSpan StableAfter = TimeSpan.FromMinutes(1);

    private async Task LoopAsync(CancellationToken ct)
    {
        var backoff = new Backoff(TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(60));
        while (!ct.IsCancellationRequested)
        {
            var connected = false;
            try
            {
                connected = await ConnectOnceAsync(ct);
                if (connected)
                {
                    // Core review C-R05: the server accepts the handshake and only then checks the
                    // token and the account, and may drop at once (a database blip). The wait
                    // starts over only after a connection that held for a minute.
                    var upAt = SystemClock.Instance.Monotonic;
                    await _dropped!.Task.WaitAsync(ct);
                    if (SystemClock.Instance.Monotonic - upAt >= StableAfter) backoff.Reset();
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _log.Debug("socket", $"{_namespace}: {ex.GetType().Name} {ex.Message}");
            }
            finally
            {
                await DisposeSocketAsync();
                if (connected) ConnectionChanged?.Invoke(false);
            }

            try { await Task.Delay(backoff.Next(), ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task<bool> ConnectOnceAsync(CancellationToken ct)
    {
        if (!_api.IsSignedIn) return false;
        var token = await _api.GetFreshAccessTokenAsync(ct);
        if (string.IsNullOrEmpty(token)) return false;

        var io = new SocketIOClient.SocketIO(_api.Origin.TrimEnd('/') + _namespace, new SocketIOOptions
        {
            Reconnection = false,
            Auth = new Dictionary<string, string> { ["token"] = token },
            Transport = SocketIOClient.Transport.TransportProtocol.WebSocket,
            ConnectionTimeout = ConnectTimeout,
        });
        var dropped = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        _dropped = dropped;

        foreach (var (name, handler) in _handlers)
        {
            io.On(name, response =>
            {
                try { handler(response.GetValue<JsonElement>(0)); }
                catch (Exception ex) { _log.Debug("socket", $"{_namespace} {name}: bad frame ({ex.Message})"); }
            });
        }
        // The server says this before dropping a socket whose token or account is no good.
        io.On("unauthorized", _ => dropped.TrySetResult(true));
        io.OnDisconnected += (_, reason) => dropped.TrySetResult(true);

        _io = io;
        var connect = io.ConnectAsync();
        var finished = await Task.WhenAny(connect, Task.Delay(ConnectTimeout, ct));
        if (finished != connect || !io.Connected)
        {
            _ = connect.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);
            return false;
        }
        await connect;
        ConnectionChanged?.Invoke(true);
        return true;
    }

    private async Task DisposeSocketAsync()
    {
        var io = Interlocked.Exchange(ref _io, null);
        if (io is null) return;
        try
        {
            if (io.Connected) await io.DisconnectAsync().WaitAsync(TimeSpan.FromSeconds(3));
        }
        catch { }
        try { io.Dispose(); } catch { }
    }

    public void Dispose() => Stop();
}
