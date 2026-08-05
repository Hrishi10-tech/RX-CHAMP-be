using Interop.UIAutomationClient;

namespace TimeChampAgent.Services;

/// <summary>
/// Best-effort extraction of the current website <b>host</b> (never the full
/// path/query — monitoring stays proportionate) from a browser's address bar,
/// via UI Automation. Returns null for non-browsers or when the bar can't be
/// read. Runs off the UI thread; every call is wrapped in try/catch because UI
/// Automation can throw on windows that are closing or elevated.
///
/// WinUI has no <c>System.Windows.Automation</c>, so this uses the UI Automation
/// COM API (<c>CUIAutomation</c>) directly.
/// </summary>
public static class BrowserUrl
{
    // UI Automation property / control-type ids (from UIAutomationClient.h).
    private const int UIA_ControlTypePropertyId = 30003;
    private const int UIA_ValueValuePropertyId = 30045;
    private const int UIA_EditControlTypeId = 50004;

    // Process names (lower-case, no ".exe") whose address bar we try to read.
    private static readonly HashSet<string> Browsers = new(StringComparer.OrdinalIgnoreCase)
    {
        "chrome", "msedge", "brave", "opera", "vivaldi", "firefox", "chromium",
    };

    // One shared automation object (creating it per call is expensive).
    private static readonly IUIAutomation? Automation = TryCreate();

    private static IUIAutomation? TryCreate()
    {
        try { return (IUIAutomation)new CUIAutomationClass(); }
        catch { return null; }
    }

    public static bool IsBrowser(string? processName) =>
        !string.IsNullOrEmpty(processName) && Browsers.Contains(processName);

    /// <summary>The host shown in the foreground browser's address bar, or null.</summary>
    public static string? HostFor(IntPtr hWnd, string? processName)
    {
        if (hWnd == IntPtr.Zero || !IsBrowser(processName) || Automation is null) return null;
        try
        {
            var root = Automation.ElementFromHandle(hWnd);
            if (root is null) return null;

            var raw = ReadAddressValue(root);
            return NormalizeHost(raw);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Find the address/omnibox edit control and read its value.</summary>
    private static string? ReadAddressValue(IUIAutomationElement root)
    {
        var editCondition = Automation!.CreatePropertyCondition(
            UIA_ControlTypePropertyId, UIA_EditControlTypeId);

        // The omnibox is usually the first Edit control exposing a value.
        var edits = root.FindAll(TreeScope.TreeScope_Descendants, editCondition);
        if (edits is null) return null;

        for (var i = 0; i < edits.Length; i++)
        {
            try
            {
                var edit = edits.GetElement(i);
                var value = edit.GetCurrentPropertyValue(UIA_ValueValuePropertyId) as string;
                if (!string.IsNullOrWhiteSpace(value)) return value;
            }
            catch { /* try the next edit */ }
        }
        return null;
    }

    /// <summary>Turn an address-bar string into a bare host, e.g. "github.com".</summary>
    private static string? NormalizeHost(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var text = raw.Trim();

        // Ignore search terms typed into the omnibox (no dot, has spaces).
        if (text.Contains(' ') && !text.Contains('.')) return null;

        var candidate = text.Contains("://") ? text : "http://" + text;
        try
        {
            var host = new Uri(candidate).Host;
            if (string.IsNullOrEmpty(host)) return null;
            return host.StartsWith("www.", StringComparison.OrdinalIgnoreCase) ? host[4..] : host;
        }
        catch
        {
            return null;
        }
    }
}
