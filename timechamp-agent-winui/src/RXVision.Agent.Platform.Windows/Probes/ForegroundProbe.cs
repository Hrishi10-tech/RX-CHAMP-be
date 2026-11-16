using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Platform.Windows.Native;

namespace RXVision.Agent.Platform.Windows.Probes;

/// <summary>
/// What is in front: the app's display name (the exe's FileDescription), the window
/// title and, for a browser, the website host. Never throws (Core calls this with a
/// timeout and falls back to app-only). The app name is cached per process so the
/// exe's version info is not re-read every sample (review #28); the cache is keyed by
/// process id and validated by start time so a recycled id never returns a stale name.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsForegroundProbe : IForegroundProbe
{
    private readonly BrowserHost _browser;
    private readonly ConcurrentDictionary<int, CachedApp> _appCache = new();

    public WindowsForegroundProbe(Action<string>? log) => _browser = new BrowserHost(log);

    private readonly record struct CachedApp(long StartStamp, string? App, string? ProcessName);

    public ForegroundInfo Snapshot(bool includeUrl)
    {
        try
        {
            var hWnd = NativeMethods.GetForegroundWindow();
            if (hWnd == IntPtr.Zero) return ForegroundInfo.Empty;

            var title = NativeMethods.ForegroundTitle(hWnd);

            NativeMethods.GetWindowThreadProcessId(hWnd, out var pid);
            string? app = null, processName = null;
            if (pid != 0) (app, processName) = DescribeProcess((int)pid);

            string? host = null;
            if (includeUrl && BrowserHost.IsBrowser(processName))
                host = _browser.HostFor(hWnd, processName, title);

            return new ForegroundInfo(app, title, host);
        }
        catch
        {
            return ForegroundInfo.Empty;
        }
    }

    private (string? app, string? processName) DescribeProcess(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            var processName = process.ProcessName;
            long startStamp;
            try { startStamp = process.StartTime.ToUniversalTime().Ticks; }
            catch { startStamp = 0; }

            if (_appCache.TryGetValue(pid, out var cached) && cached.StartStamp == startStamp)
                return (cached.App, cached.ProcessName);

            var app = SafeFileDescription(process) ?? AppName.Prettify(processName);
            if (_appCache.Count > 256) _appCache.Clear();
            _appCache[pid] = new CachedApp(startStamp, app, processName);
            return (app, processName);
        }
        catch
        {
            // The process may have exited between reading the handle and querying it.
            return (null, null);
        }
    }

    private static string? SafeFileDescription(Process process)
    {
        try
        {
            var description = process.MainModule?.FileVersionInfo.FileDescription;
            return string.IsNullOrWhiteSpace(description) ? null : description;
        }
        catch
        {
            return null;
        }
    }
}
