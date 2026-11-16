using System.Net;
using System.Net.Sockets;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Api;

/// <summary>
/// Parallel connect (Happy Eyeballs, RFC 8305 in its simple form; 4.0 SPEC section 6).
/// Resolves every address of the host, then races connections: the first attempt
/// starts at once, each next one 250 ms later or as soon as the one before it fails,
/// alternating IPv6 and IPv4. The first connection that succeeds wins; the others
/// are cancelled (and closed if they finish anyway). A Mac whose IPv6 route was
/// broken could not sign in at all before this: the OS tried IPv6 for the whole
/// connect timeout.
/// </summary>
public sealed class HappyEyeballs
{
    /// <summary>How long an attempt gets before the next address is tried alongside it.</summary>
    public static readonly TimeSpan Stagger = TimeSpan.FromMilliseconds(250);

    private readonly Func<string, CancellationToken, Task<IPAddress[]>> _resolve;
    private readonly Func<IPAddress, int, CancellationToken, Task<Stream>> _connect;
    private readonly ILog _log;
    private readonly TimeSpan _stagger;

    /// <param name="resolve">Tests: a fake resolver (else DNS).</param>
    /// <param name="connect">Tests: a fake connector (else a TCP socket).</param>
    public HappyEyeballs(ILog log,
        Func<string, CancellationToken, Task<IPAddress[]>>? resolve = null,
        Func<IPAddress, int, CancellationToken, Task<Stream>>? connect = null,
        TimeSpan? stagger = null)
    {
        _log = log;
        _resolve = resolve ?? ResolveAsync;
        _connect = connect ?? ConnectSocketAsync;
        _stagger = stagger ?? Stagger;
    }

    /// <summary>For <see cref="SocketsHttpHandler.ConnectCallback"/>.</summary>
    public ValueTask<Stream> ConnectAsync(SocketsHttpConnectionContext context, CancellationToken ct) =>
        new(ConnectAsync(context.DnsEndPoint.Host, context.DnsEndPoint.Port, ct));

    public async Task<Stream> ConnectAsync(string host, int port, CancellationToken ct)
    {
        IPAddress[] addresses;
        if (IPAddress.TryParse(host, out var literal))
        {
            addresses = new[] { literal };
        }
        else
        {
            try
            {
                addresses = await _resolve(host, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                _log.Warn("net", $"could not resolve {host}: {ex.GetType().Name}: {ex.Message}");
                throw;
            }
        }
        var order = Interleave(addresses);
        if (order.Count == 0)
        {
            _log.Warn("net", $"{host} resolved to no addresses");
            throw new SocketException((int)SocketError.HostNotFound);
        }
        return await RaceAsync(host, port, order, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// The connection order: the resolver's first address's family first, then the
    /// other family, alternating (v6, v4, v6, v4...), each family in the resolver's order.
    /// </summary>
    public static IReadOnlyList<IPAddress> Interleave(IEnumerable<IPAddress> addresses)
    {
        var list = addresses.Where(a => a.AddressFamily is AddressFamily.InterNetwork or AddressFamily.InterNetworkV6)
            .Distinct().ToList();
        if (list.Count == 0) return list;
        var first = list[0].AddressFamily;
        var a = new Queue<IPAddress>(list.Where(x => x.AddressFamily == first));
        var b = new Queue<IPAddress>(list.Where(x => x.AddressFamily != first));
        var order = new List<IPAddress>(list.Count);
        while (a.Count > 0 || b.Count > 0)
        {
            if (a.Count > 0) order.Add(a.Dequeue());
            if (b.Count > 0) order.Add(b.Dequeue());
        }
        return order;
    }

    private async Task<Stream> RaceAsync(string host, int port, IReadOnlyList<IPAddress> order, CancellationToken ct)
    {
        using var all = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var running = new List<(IPAddress Address, Task<Stream> Attempt)>();
        var errors = new List<string>();
        Exception? lastError = null;
        var next = 0;

        void StartNext()
        {
            var address = order[next++];
            running.Add((address, _connect(address, port, all.Token)));
        }

        StartNext();
        try
        {
            while (running.Count > 0)
            {
                var attempts = running.Select(r => (Task)r.Attempt).ToList();
                Task? timer = null;
                if (next < order.Count)
                {
                    timer = Task.Delay(_stagger, all.Token);
                    attempts.Add(timer);
                }
                var done = await Task.WhenAny(attempts).ConfigureAwait(false);
                ct.ThrowIfCancellationRequested();
                if (ReferenceEquals(done, timer))
                {
                    // This one is slow: start the next address beside it.
                    StartNext();
                    continue;
                }
                var finished = running.First(r => ReferenceEquals(r.Attempt, done));
                running.Remove(finished);
                if (finished.Attempt.Status == TaskStatus.RanToCompletion)
                {
                    var stream = finished.Attempt.Result;
                    if (errors.Count > 0 || running.Count > 0)
                        _log.Info("net", $"connected to {host} over {Describe(finished.Address)} ({errors.Count} other address(es) failed, {running.Count} cancelled)");
                    all.Cancel();
                    CloseLosers(running);
                    return stream;
                }
                lastError = finished.Attempt.Exception?.GetBaseException() ?? new OperationCanceledException();
                errors.Add($"{Describe(finished.Address)}: {lastError.GetType().Name}: {lastError.Message}");
                // A failure starts the next address at once rather than after the stagger.
                if (next < order.Count) StartNext();
            }
        }
        catch
        {
            all.Cancel();
            CloseLosers(running);
            throw;
        }

        _log.Warn("net", $"could not connect to {host}:{port}: {string.Join("; ", errors)}");
        throw lastError is SocketException or IOException
            ? lastError
            : new SocketException((int)SocketError.ConnectionRefused);
    }

    /// <summary>Attempts that lost the race: their streams are closed whenever they finish.</summary>
    private static void CloseLosers(IEnumerable<(IPAddress Address, Task<Stream> Attempt)> losers)
    {
        foreach (var (_, attempt) in losers)
        {
            _ = attempt.ContinueWith(t =>
            {
                if (t.Status == TaskStatus.RanToCompletion)
                {
                    try { t.Result.Dispose(); } catch { /* already gone */ }
                }
                else
                {
                    _ = t.Exception; // observed
                }
            }, TaskScheduler.Default);
        }
    }

    private static string Describe(IPAddress address) =>
        address.AddressFamily == AddressFamily.InterNetworkV6 ? $"IPv6 {address}" : $"IPv4 {address}";

    private static Task<IPAddress[]> ResolveAsync(string host, CancellationToken ct) =>
        Dns.GetHostAddressesAsync(host, AddressFamily.Unspecified, ct);

    private static async Task<Stream> ConnectSocketAsync(IPAddress address, int port, CancellationToken ct)
    {
        var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(new IPEndPoint(address, port), ct).ConfigureAwait(false);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }
}
