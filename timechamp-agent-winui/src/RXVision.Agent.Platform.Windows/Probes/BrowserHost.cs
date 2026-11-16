using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Interop.UIAutomationClient;

namespace RXVision.Agent.Platform.Windows.Probes;

/// <summary>
/// Reads the current website host from a browser's address bar via UI Automation,
/// host only (never the path or query) and never a text field inside the page.
///
/// Addresses the 2.x defects (review #22): one shared CUIAutomation8 with a
/// connection and transaction timeout so a hung browser cannot block; the omnibox is
/// found inside the toolbar with FindFirst (not FindAll over the whole tree, which
/// forced Chrome into accessibility mode for the session and leaked COM wrappers);
/// every COM object is released in a finally; and the host is cached per window
/// and title for 30 s. Never throws.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class BrowserHost
{
    // UI Automation property and control-type ids (UIAutomationClient.h).
    private const int UIA_ControlTypePropertyId = 30003;
    private const int UIA_ValueValuePropertyId = 30045;
    private const int UIA_EditControlTypeId = 50004;
    private const int UIA_ToolBarControlTypeId = 50021;

    private const uint ConnectionTimeoutMs = 2000;
    private const uint TransactionTimeoutMs = 5000;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromSeconds(30);

    /// <summary>How many elements, from the first toolbar on along its siblings, are
    /// searched for the address bar (see <see cref="ReadAddressValue"/>).</summary>
    private const int MaxToolbarSiblings = 5;

    private static readonly HashSet<string> Browsers = new(StringComparer.OrdinalIgnoreCase)
    {
        "chrome", "msedge", "brave", "opera", "vivaldi", "firefox", "chromium",
    };

    private readonly Action<string>? _log;
    private readonly object _gate = new();
    private IUIAutomation2? _automation;
    private bool _automationTried;
    private readonly ConcurrentDictionary<(IntPtr hWnd, string? title), (string? host, DateTime at)> _cache = new();

    public BrowserHost(Action<string>? log) => _log = log;

    public static bool IsBrowser(string? processName) =>
        !string.IsNullOrEmpty(processName) && Browsers.Contains(processName);

    /// <summary>
    /// The shared UI Automation object, created on first use. That is on the thread-pool
    /// (MTA) thread Core probes from, not in the constructor, which runs on the UI's STA
    /// thread: created there, the object would belong to the UI thread's apartment, so
    /// every call from the probe could be marshalled onto the UI thread and freeze it while
    /// a browser is slow to answer. Microsoft's guidance is to make UI Automation calls
    /// from an MTA thread that owns no windows.
    /// </summary>
    private IUIAutomation2? Automation()
    {
        lock (_gate)
        {
            if (_automationTried) return _automation;
            if (Thread.CurrentThread.GetApartmentState() == ApartmentState.STA) return null; // wait for a probe thread
            _automationTried = true;
            _automation = TryCreateAutomation();
            return _automation;
        }
    }

    private IUIAutomation2? TryCreateAutomation()
    {
        try
        {
            var automation = (IUIAutomation2)new CUIAutomation8Class();
            automation.ConnectionTimeout = ConnectionTimeoutMs;
            automation.TransactionTimeout = TransactionTimeoutMs;
            return automation;
        }
        catch (Exception ex)
        {
            _log?.Invoke($"browser: UI Automation unavailable: {ex.Message}");
            return null;
        }
    }

    /// <summary>The host in the foreground browser's address bar, or null.</summary>
    public string? HostFor(IntPtr hWnd, string? processName, string? title)
    {
        if (hWnd == IntPtr.Zero || !IsBrowser(processName)) return null;
        var automation = Automation();
        if (automation is null) return null;

        // Keyed by the title too: switching tabs keeps the window but changes its title,
        // and the host must follow the tab rather than linger from the previous one.
        var key = (hWnd, title);
        if (_cache.TryGetValue(key, out var hit) && DateTime.UtcNow - hit.at < CacheTtl)
            return hit.host;

        string? host = null;
        try
        {
            host = HostNormalizer.Normalize(ReadAddressValue(automation, hWnd));
        }
        catch (Exception ex)
        {
            _log?.Invoke($"browser: read failed: {ex.Message}");
        }

        // Cache even a null result, so a non-matching window is not re-probed every tick.
        _cache[key] = (host, DateTime.UtcNow);
        if (_cache.Count > 256) PruneCache();
        return host;
    }

    private static string? ReadAddressValue(IUIAutomation2 automation, IntPtr hWnd)
    {
        // Every COM object obtained here, released in the finally.
        var owned = new List<object>();
        T? Own<T>(T? comObject) where T : class
        {
            if (comObject is not null) owned.Add(comObject);
            return comObject;
        }

        try
        {
            var root = Own(automation.ElementFromHandle(hWnd));
            if (root is null) return null;

            // The omnibox lives inside the browser's toolbar. Finding the toolbar first
            // and reading the single Edit within it keeps the search off the page, so a
            // form field in the page can never be mistaken for the address.
            var toolbarCondition = Own(automation.CreatePropertyCondition(UIA_ControlTypePropertyId, UIA_ToolBarControlTypeId))!;
            var editCondition = Own(automation.CreatePropertyCondition(UIA_ControlTypePropertyId, UIA_EditControlTypeId))!;
            var cacheRequest = Own(automation.CreateCacheRequest())!;
            cacheRequest.AutomationElementMode = AutomationElementMode.AutomationElementMode_None;
            cacheRequest.AddProperty(UIA_ValueValuePropertyId);

            var element = Own(root.FindFirst(TreeScope.TreeScope_Subtree, toolbarCondition));

            // Chromium browsers put the omnibox in the first toolbar. Firefox puts its
            // tab strip ("Browser tabs") first and the address bar in the next toolbar
            // ("Navigation"), so the first toolbar's next few siblings are tried too:
            // only those that are toolbars themselves, so the walk never enters the page.
            IUIAutomationTreeWalker? walker = null;
            for (var i = 0; element is not null && i < MaxToolbarSiblings; i++)
            {
                if (i == 0 || element.CurrentControlType == UIA_ToolBarControlTypeId)
                {
                    var edit = Own(element.FindFirstBuildCache(TreeScope.TreeScope_Subtree, editCondition, cacheRequest));
                    if (edit is not null) return edit.GetCachedPropertyValue(UIA_ValueValuePropertyId) as string;
                }
                walker ??= Own(automation.ControlViewWalker);
                element = Own(walker!.GetNextSiblingElement(element));
            }
            return null;
        }
        finally
        {
            foreach (var comObject in owned) Release(comObject);
        }
    }

    private void PruneCache()
    {
        var cutoff = DateTime.UtcNow - CacheTtl;
        foreach (var kv in _cache)
            if (kv.Value.at < cutoff) _cache.TryRemove(kv.Key, out _);
        // If everything is still fresh, drop the lot rather than grow unbounded.
        if (_cache.Count > 256) _cache.Clear();
    }

    private static void Release(object? comObject)
    {
        try
        {
            if (comObject is not null && Marshal.IsComObject(comObject)) Marshal.ReleaseComObject(comObject);
        }
        catch { /* releasing must never throw out of a probe */ }
    }
}
