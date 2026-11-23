using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Platform.Mac.Native;

namespace RXVision.Agent.Platform.Mac;

/// <summary>
/// The call detectors' window read (AGENT.md section 6): the CoreGraphics window list the
/// foreground probe reads, keeping normal (layer 0) windows of the listed owners and reading a
/// title only for those. A title needs Screen Recording permission, as the foreground read's does:
/// without it no call is seen and Start meeting by hand still works. A browser's tabs come from a
/// short AppleScript, only while a call in that browser is tracked, with the same 3 s timeout and
/// 10 minute back-off after an Automation denial. Never throws.
/// </summary>
[SupportedOSPlatform("macos")]
internal sealed class MacCallWindowProbe : ICallWindowProbe
{
    private static readonly TimeSpan OsascriptTimeout = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan BrowserBackoff = TimeSpan.FromMinutes(10);
    private static readonly Lazy<IntPtr> KeyLayer = new(() => CoreFoundation.CreateString("kCGWindowLayer"));
    private static readonly Lazy<IntPtr> KeyOwnerName = new(() => CoreFoundation.CreateString("kCGWindowOwnerName"));
    private static readonly Lazy<IntPtr> KeyWindowName = new(() => CoreFoundation.CreateString("kCGWindowName"));

    private readonly ILog _log;
    private readonly object _gate = new();
    private readonly Dictionary<string, DateTimeOffset> _backoff = new(StringComparer.OrdinalIgnoreCase);

    public MacCallWindowProbe(ILog log) => _log = log;

    public IReadOnlyList<CallWindow> WindowsOf(IReadOnlyCollection<string> owners)
    {
        var wanted = new HashSet<string>(owners, StringComparer.OrdinalIgnoreCase);
        var found = new List<CallWindow>();
        try
        {
            var list = CoreGraphics.CGWindowListCopyWindowInfo(CoreGraphics.WindowListAllNoDesktop, CoreGraphics.NullWindowID);
            if (list == IntPtr.Zero) return found;
            try
            {
                var count = CoreFoundation.CFArrayGetCount(list);
                for (nint i = 0; i < count; i++)
                {
                    var dict = CoreFoundation.CFArrayGetValueAtIndex(list, i);
                    if (dict == IntPtr.Zero) continue;
                    if (CoreFoundation.NumberToManaged(CoreFoundation.CFDictionaryGetValue(dict, KeyLayer.Value)) != 0) continue;
                    var owner = CoreFoundation.StringToManaged(CoreFoundation.CFDictionaryGetValue(dict, KeyOwnerName.Value));
                    if (owner is null || !wanted.Contains(owner)) continue;
                    var title = CoreFoundation.StringToManaged(CoreFoundation.CFDictionaryGetValue(dict, KeyWindowName.Value));
                    if (!string.IsNullOrEmpty(title)) found.Add(new CallWindow(owner, title));
                }
            }
            finally
            {
                CoreFoundation.CFRelease(list);
            }
        }
        catch (Exception ex)
        {
            _log.Warn("meetings", "window list read failed", ex);
        }
        return found;
    }

    public IReadOnlyList<string> TabTitlesOf(string browserOwner)
    {
        if (!BrowserSupport.TryGetBrowser(browserOwner, out var kind, out var appName)) return Array.Empty<string>();
        var script = BrowserSupport.TabTitlesScriptFor(kind, appName);
        if (script is null) return Array.Empty<string>();
        lock (_gate)
        {
            if (_backoff.TryGetValue(browserOwner, out var until) && DateTimeOffset.UtcNow < until) return Array.Empty<string>();
        }
        var result = ProcessRunner.Run("/usr/bin/osascript", new[] { "-e", script }, OsascriptTimeout);
        if (result.Ok) return BrowserSupport.TabTitlesFrom(result.StdOut);
        if (!result.TimedOut)
        {
            lock (_gate) _backoff[browserOwner] = DateTimeOffset.UtcNow + BrowserBackoff;
            _log.Info("meetings", $"osascript refused for {browserOwner}; backing off 10 min");
        }
        return Array.Empty<string>();
    }
}
