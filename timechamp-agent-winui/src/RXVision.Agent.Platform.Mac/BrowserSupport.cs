namespace RXVision.Agent.Platform.Mac;

/// <summary>Which browser family an app belongs to, for address-bar scripting.</summary>
internal enum BrowserKind
{
    None,
    Safari,
    /// <summary>Chrome and every Chromium cousin: URL of active tab of front window.</summary>
    Chromium,
    /// <summary>Firefox: not scriptable for the URL. We never try.</summary>
    Firefox,
}

/// <summary>
/// Pure, OS-free helpers for the foreground probe: mapping macOS process "owner"
/// names to friendly app names, recognising browsers, building the AppleScript to
/// read the address bar, and reducing a URL to a bare host. All deterministic and
/// unit-tested on any OS (no P/Invoke, no process launches).
/// </summary>
internal static class BrowserSupport
{
    /// <summary>Owner (process) name -> a cleaner display name. Pass-through when not listed.</summary>
    private static readonly Dictionary<string, string> FriendlyNames = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Code"] = "Visual Studio Code",
        ["Code - Insiders"] = "Visual Studio Code - Insiders",
        ["com.apple.finder"] = "Finder",
        ["Finder"] = "Finder",
        ["Electron"] = "Electron",
        ["iTerm2"] = "iTerm",
        ["Terminal"] = "Terminal",
        ["Preview"] = "Preview",
        ["Music"] = "Music",
        ["Google Chrome"] = "Google Chrome",
        ["Google Chrome Canary"] = "Google Chrome Canary",
        ["Microsoft Edge"] = "Microsoft Edge",
        ["Brave Browser"] = "Brave",
        ["Mozilla Firefox"] = "Firefox",
        ["firefox"] = "Firefox",
    };

    /// <summary>
    /// Owner name -> (browser family, the AppleScript application name to "tell").
    /// The application name is the one the browser registers under, which is what
    /// <c>tell application "..."</c> needs.
    /// </summary>
    private static readonly Dictionary<string, (BrowserKind Kind, string AppName)> Browsers = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Safari"] = (BrowserKind.Safari, "Safari"),
        ["Safari Technology Preview"] = (BrowserKind.Safari, "Safari Technology Preview"),
        ["Google Chrome"] = (BrowserKind.Chromium, "Google Chrome"),
        ["Google Chrome Canary"] = (BrowserKind.Chromium, "Google Chrome Canary"),
        ["Chromium"] = (BrowserKind.Chromium, "Chromium"),
        ["Microsoft Edge"] = (BrowserKind.Chromium, "Microsoft Edge"),
        ["Microsoft Edge Beta"] = (BrowserKind.Chromium, "Microsoft Edge Beta"),
        ["Brave Browser"] = (BrowserKind.Chromium, "Brave Browser"),
        ["Brave Browser Beta"] = (BrowserKind.Chromium, "Brave Browser Beta"),
        ["Arc"] = (BrowserKind.Chromium, "Arc"),
        ["Vivaldi"] = (BrowserKind.Chromium, "Vivaldi"),
        ["Opera"] = (BrowserKind.Chromium, "Opera"),
        ["Mozilla Firefox"] = (BrowserKind.Firefox, "Firefox"),
        ["firefox"] = (BrowserKind.Firefox, "Firefox"),
        ["Firefox"] = (BrowserKind.Firefox, "Firefox"),
    };

    internal static string? FriendlyApp(string? owner)
    {
        if (string.IsNullOrWhiteSpace(owner)) return owner;
        var trimmed = owner.Trim();
        return FriendlyNames.TryGetValue(trimmed, out var friendly) ? friendly : trimmed;
    }

    internal static bool TryGetBrowser(string? owner, out BrowserKind kind, out string appName)
    {
        kind = BrowserKind.None;
        appName = "";
        if (string.IsNullOrWhiteSpace(owner)) return false;
        if (!Browsers.TryGetValue(owner.Trim(), out var entry)) return false;
        kind = entry.Kind;
        appName = entry.AppName;
        return true;
    }

    /// <summary>
    /// The AppleScript to read the current address, or null for a browser we do
    /// not script (Firefox). Safari exposes the front document; Chromium browsers
    /// expose the active tab of the front window. Guarded by "is running": a bare
    /// `tell application` LAUNCHES the app, so a browser quit between the window
    /// read and this script would otherwise reopen by itself.
    /// </summary>
    internal static string? AppleScriptFor(BrowserKind kind, string appName)
    {
        // Embedding the app name inside an AppleScript string: block the only two
        // characters that could break out of the quoted literal.
        if (appName.Contains('"') || appName.Contains('\\')) return null;
        var guard = $"if application \"{appName}\" is running then ";
        return kind switch
        {
            BrowserKind.Safari => guard + $"tell application \"{appName}\" to get URL of front document",
            BrowserKind.Chromium => guard + $"tell application \"{appName}\" to get URL of active tab of front window",
            _ => null,
        };
    }

    /// <summary>
    /// Reduces osascript output (a URL, or a blank/error line) to a bare lowercase
    /// host, or null. Only http/https produce a host; app and internal schemes
    /// (chrome://, about:, file://, blank) return null so nothing private leaks.
    /// </summary>
    internal static string? HostFromUrl(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var text = raw.Trim();
        // osascript may echo "missing value" when there is no front tab.
        if (text.Equals("missing value", StringComparison.OrdinalIgnoreCase)) return null;

        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri)) return null;
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return null;
        var host = uri.Host;
        if (string.IsNullOrEmpty(host)) return null;
        host = host.ToLowerInvariant();
        if (host.StartsWith("www.", StringComparison.Ordinal) && host.Length > 4) host = host[4..];
        return host;
    }
}
