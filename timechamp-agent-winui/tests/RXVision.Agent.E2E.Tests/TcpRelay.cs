using System.Net;
using System.Net.Sockets;

namespace RXVision.Agent.E2E.Tests;

/// <summary>
/// The network between the agent and the API: a TCP relay on a local port that forwards
/// to the API. <see cref="GoOffline"/> closes the port (connections are refused, open ones
/// are cut), <see cref="GoOnline"/> opens the same port again. The API itself keeps
/// running for everyone else; only this agent loses its connection.
/// </summary>
public sealed class TcpRelay : IDisposable
{
    private readonly string _targetHost;
    private readonly int _targetPort;
    private readonly object _gate = new();
    private readonly List<TcpClient> _open = new();
    private TcpListener? _listener;
    private CancellationTokenSource? _cts;

    public TcpRelay(Uri target)
    {
        _targetHost = target.Host;
        _targetPort = target.Port;
        // A free port, kept for the relay's life.
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        Port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        GoOnline();
    }

    public int Port { get; }
    public bool IsOnline { get { lock (_gate) return _listener is not null; } }

    /// <summary>The API's base URL through the relay (same path as <paramref name="api"/>).</summary>
    public string Url(string api)
    {
        var u = new UriBuilder(api) { Host = "127.0.0.1", Port = Port };
        return u.Uri.ToString().TrimEnd('/');
    }

    public void GoOnline()
    {
        lock (_gate)
        {
            if (_listener is not null) return;
            var listener = new TcpListener(IPAddress.Loopback, Port);
            listener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            listener.Start();
            _listener = listener;
            _cts = new CancellationTokenSource();
            var ct = _cts.Token;
            _ = Task.Run(() => AcceptLoop(listener, ct));
        }
    }

    /// <summary>The port closes and every open connection is cut, as when the network drops.</summary>
    public void GoOffline()
    {
        lock (_gate)
        {
            _cts?.Cancel();
            _cts = null;
            _listener?.Stop();
            _listener = null;
            foreach (var c in _open)
            {
                try { c.Client.LingerState = new LingerOption(true, 0); c.Close(); } catch { }
            }
            _open.Clear();
        }
    }

    private async Task AcceptLoop(TcpListener listener, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TcpClient inbound;
            try { inbound = await listener.AcceptTcpClientAsync(ct); }
            catch { return; }
            _ = Task.Run(() => Pipe(inbound, ct));
        }
    }

    private async Task Pipe(TcpClient inbound, CancellationToken ct)
    {
        using var outbound = new TcpClient();
        lock (_gate)
        {
            if (ct.IsCancellationRequested) { inbound.Close(); return; }
            _open.Add(inbound);
            _open.Add(outbound);
        }
        try
        {
            await outbound.ConnectAsync(_targetHost, _targetPort, ct);
            using var a = inbound.GetStream();
            using var b = outbound.GetStream();
            var up = a.CopyToAsync(b, ct);
            var down = b.CopyToAsync(a, ct);
            await Task.WhenAny(up, down);
        }
        catch { }
        finally
        {
            lock (_gate)
            {
                _open.Remove(inbound);
                _open.Remove(outbound);
            }
            try { inbound.Close(); } catch { }
        }
    }

    public void Dispose() => GoOffline();
}
