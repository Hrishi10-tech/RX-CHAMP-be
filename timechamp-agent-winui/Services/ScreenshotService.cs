using System.Timers;
using SocketIOClient;
using Timer = System.Timers.Timer;

namespace TimeChampAgent.Services;

/// <summary>
/// Captures the screen and uploads it to the backend (which stores it in S3):
///  • automatically every 5 minutes (kind = AUTO), and
///  • on demand when a manager clicks "capture", delivered over the <c>/screenshots</c>
///    socket.io channel as a <c>screenshot:capture</c> command (kind = MANUAL).
/// The agent never holds AWS credentials — it only talks to our API.
///
/// The two are independent. A manager or admin can switch a user's automatic
/// screenshots off (see <see cref="SetAutoEnabled"/>), which stops the 5-minute timer
/// but leaves the socket connected — so a manual capture still arrives and still
/// works. Nothing here affects activity tracking either way.
/// </summary>
public sealed class ScreenshotService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(5);

    private readonly ApiClient _api;
    private Timer? _timer;
    private SocketIOClient.SocketIO? _io;
    private volatile bool _run;

    /// <summary>The server's per-user switch for periodic capture. Assumed on until a
    /// report says otherwise, so a slow first ack doesn't miss the opening shot.</summary>
    private volatile bool _autoEnabled = true;

    public ScreenshotService(ApiClient api) => _api = api;

    public void Start()
    {
        if (_run) return;
        _run = true;

        if (_autoEnabled) StartAutoTimer();
        // The socket carries the manager's manual capture command, so it is connected
        // whether or not automatic capture is switched on for this user.
        _ = ConnectAsync();
    }

    /// <summary>
    /// Applies the server's screenshot switch for this user. Called on every activity
    /// report, so flipping the toggle in the dashboard takes effect within a minute.
    /// Only the periodic timer starts or stops — the socket, and therefore manual
    /// capture, is untouched.
    /// </summary>
    public void SetAutoEnabled(bool enabled)
    {
        if (_autoEnabled == enabled) return;
        _autoEnabled = enabled;
        if (!_run) return;

        if (enabled) StartAutoTimer();
        else StopAutoTimer();
    }

    private void StartAutoTimer()
    {
        if (_timer is not null) return;

        _timer = new Timer(Interval.TotalMilliseconds) { AutoReset = true };
        _timer.Elapsed += (_, _) => _ = CaptureAndUpload("AUTO");
        _timer.Start();

        _ = CaptureAndUpload("AUTO"); // one shot right away so there's something to show
    }

    private void StopAutoTimer()
    {
        _timer?.Stop();
        _timer?.Dispose();
        _timer = null;
    }

    public void Stop()
    {
        _run = false;
        StopAutoTimer();

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

    private async Task CaptureAndUpload(string kind)
    {
        if (!_run) return;
        try
        {
            var png = await Task.Run(ScreenCapture.CapturePng);
            if (png.Length > 0) await _api.UploadScreenshotAsync(png, kind);
        }
        catch { /* best-effort */ }
    }

    private async Task ConnectAsync()
    {
        if (!_run) return;
        try
        {
            await _api.RefreshSessionAsync();
            var token = _api.AccessToken;
            if (string.IsNullOrEmpty(token)) { ScheduleReconnect(); return; }

            var uri = _api.Origin.TrimEnd('/') + "/screenshots";
            var io = new SocketIOClient.SocketIO(uri, new SocketIOOptions
            {
                Reconnection = false,
                Auth = new Dictionary<string, string> { ["token"] = token! },
                Transport = SocketIOClient.Transport.TransportProtocol.WebSocket,
                ConnectionTimeout = TimeSpan.FromSeconds(10),
            });

            io.On("screenshot:capture", resp => { _ = CaptureAndUpload("MANUAL"); });
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
