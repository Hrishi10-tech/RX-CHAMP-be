using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Platform.Mac.Native;

namespace RXVision.Agent.Platform.Mac;

/// <summary>
/// The frontmost app, its window title and (for a scriptable browser) the website
/// host. The app and title come from the CoreGraphics on-screen window list; the
/// title needs Screen Recording permission (null without it). The host comes from
/// a short AppleScript against the browser, run only when the browser is in front
/// and includeUrl is set, with a 3 s timeout, a 30 s per-(app,title) cache and a
/// 10 minute back-off per browser after an Automation denial.
/// </summary>
[SupportedOSPlatform("macos")]
internal sealed class MacForegroundProbe : IForegroundProbe
{
    private static readonly TimeSpan OsascriptTimeout = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan CacheTtl = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan BrowserBackoff = TimeSpan.FromMinutes(10);

    private readonly ILog _log;
    private readonly object _gate = new();
    private readonly Dictionary<string, (string? Host, DateTimeOffset At)> _hostCache = new();
    private readonly Dictionary<string, DateTimeOffset> _browserBackoff = new(StringComparer.OrdinalIgnoreCase);

    // Window-dictionary keys. The CoreGraphics constants' string values equal
    // their symbol names, so we build them directly and keep them for the process
    // lifetime (framework-constant-like; never released).
    private static readonly Lazy<IntPtr> KeyLayer = new(() => CoreFoundation.CreateString("kCGWindowLayer"));
    private static readonly Lazy<IntPtr> KeyOwnerName = new(() => CoreFoundation.CreateString("kCGWindowOwnerName"));
    private static readonly Lazy<IntPtr> KeyWindowName = new(() => CoreFoundation.CreateString("kCGWindowName"));
    private static readonly Lazy<IntPtr> KeyOwnerPid = new(() => CoreFoundation.CreateString("kCGWindowOwnerPID"));

    public MacForegroundProbe(ILog log) => _log = log;

    public ForegroundInfo Snapshot(bool includeUrl)
    {
        string? owner, title;
        try
        {
            (owner, title) = ReadFrontWindow();
        }
        catch (Exception ex)
        {
            _log.Warn("foreground", "window list read failed", ex);
            return ForegroundInfo.Empty;
        }

        if (string.IsNullOrWhiteSpace(owner)) return ForegroundInfo.Empty;
        var app = BrowserSupport.FriendlyApp(owner);

        string? host = null;
        if (includeUrl && BrowserSupport.TryGetBrowser(owner, out var kind, out var appName) && kind != BrowserKind.Firefox)
        {
            host = ResolveHost(owner!, appName, kind, title);
        }

        return new ForegroundInfo(app, title, host);
    }

    /// <summary>Owner name and window title of the frontmost normal (layer 0) window.</summary>
    private static (string? Owner, string? Title) ReadFrontWindow()
    {
        var list = CoreGraphics.CGWindowListCopyWindowInfo(
            CoreGraphics.WindowListOnScreenNoDesktop, CoreGraphics.NullWindowID);
        if (list == IntPtr.Zero) return (null, null);
        try
        {
            var count = CoreFoundation.CFArrayGetCount(list);
            for (nint i = 0; i < count; i++)
            {
                var dict = CoreFoundation.CFArrayGetValueAtIndex(list, i);
                if (dict == IntPtr.Zero) continue;

                var layer = CoreFoundation.NumberToManaged(CoreFoundation.CFDictionaryGetValue(dict, KeyLayer.Value));
                if (layer != 0) continue; // 0 == normal window layer == the frontmost app

                var owner = CoreFoundation.StringToManaged(CoreFoundation.CFDictionaryGetValue(dict, KeyOwnerName.Value));
                // kCGWindowName is present only with Screen Recording permission.
                var title = CoreFoundation.StringToManaged(CoreFoundation.CFDictionaryGetValue(dict, KeyWindowName.Value));
                return (owner, string.IsNullOrEmpty(title) ? null : title);
            }
            return (null, null);
        }
        finally
        {
            CoreFoundation.CFRelease(list); // we own the copied list
        }
    }

    private string? ResolveHost(string owner, string appName, BrowserKind kind, string? title)
    {
        var cacheKey = owner + "\u0001" + (title ?? "");
        var now = DateTimeOffset.UtcNow;

        lock (_gate)
        {
            if (_hostCache.TryGetValue(cacheKey, out var cached) && now - cached.At < CacheTtl)
                return cached.Host;
            if (_browserBackoff.TryGetValue(owner, out var until) && now < until)
                return null; // Automation was denied recently; do not prompt again yet
        }

        var script = BrowserSupport.AppleScriptFor(kind, appName);
        if (script is null) return null;

        var result = ProcessRunner.Run("/usr/bin/osascript", new[] { "-e", script }, OsascriptTimeout);
        if (result.TimedOut)
        {
            _log.Warn("foreground", $"osascript timed out for {owner}");
            return null;
        }
        if (!result.Ok)
        {
            // Non-zero exit is almost always an Automation consent denial (-1743) or
            // "application isn't running". Back off and stay quiet.
            lock (_gate) _browserBackoff[owner] = now + BrowserBackoff;
            _log.Info("foreground", $"osascript refused for {owner}; backing off 10 min");
            return null;
        }

        var host = BrowserSupport.HostFromUrl(result.StdOut);
        lock (_gate)
        {
            _hostCache[cacheKey] = (host, now);
            _browserBackoff.Remove(owner);
            if (_hostCache.Count > 256) _hostCache.Clear();
        }
        return host;
    }
}
