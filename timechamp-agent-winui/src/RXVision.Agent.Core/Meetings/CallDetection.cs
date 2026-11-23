using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Platform;

namespace RXVision.Agent.Core.Meetings;

/// <summary>A call one row of the table saw. The row, never the title: nothing about the window is kept.</summary>
public sealed record DetectedCall(string Id, string App, bool IsHuddle, string? BrowserOwner = null);

/// <summary>One row of <c>call-detection.json</c>: what a call on one app looks like, per OS.</summary>
internal sealed class CallRow
{
    public string Id { get; set; } = "";
    /// <summary>The name in "You look to be on a {app} call."</summary>
    public string App { get; set; } = "";
    public bool Huddle { get; set; }
    /// <summary>A website: the title carries the browser's name, and a tab can hide it.</summary>
    public bool Browser { get; set; }
    public List<string> Hosts { get; set; } = new();
    public Dictionary<string, List<string>> Owners { get; set; } = new();
    public List<string> Titles { get; set; } = new();
    public List<string> NotTitles { get; set; } = new();
    public List<string> WindowClasses { get; set; } = new();
}

internal sealed class CallTableFile
{
    public int Version { get; set; }
    public string BrowserSuffix { get; set; } = "";
    public List<CallRow> Calls { get; set; } = new();
}

/// <summary>
/// The table of what each detector looks for (AGENT.md section 6): a data file, not code,
/// because client titles change between versions. Matching is case-insensitive.
/// </summary>
public sealed class CallDetectionTable
{
    public const string Windows = "windows";
    public const string Mac = "mac";
    private const string Resource = "RXVision.Agent.Core.Meetings.call-detection.json";
    private static readonly TimeSpan RegexLimit = TimeSpan.FromMilliseconds(250);
    private const RegexOptions Options = RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;

    private readonly List<CompiledRow> _rows;
    private readonly Regex _browserSuffix;

    private CallDetectionTable(CallTableFile file)
    {
        _browserSuffix = new Regex(file.BrowserSuffix, Options, RegexLimit);
        _rows = file.Calls.Select(r => new CompiledRow(r)).ToList();
    }

    /// <summary>The table the app ships with.</summary>
    public static CallDetectionTable Shipped { get; } = Load();

    private static CallDetectionTable Load()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(Resource)
            ?? throw new InvalidOperationException($"{Resource} is not in the build");
        return new CallDetectionTable(JsonSerializer.Deserialize<CallTableFile>(stream, Json.Options)
            ?? throw new InvalidOperationException($"{Resource} is empty"));
    }

    /// <summary>The table's key for a platform name: the Windows row or the macOS row.</summary>
    public static string OsKey(string platformName) => platformName == Windows ? Windows : Mac;

    /// <summary>The process names (Windows) or window owners (macOS) whose windows may be read: no others.</summary>
    public IReadOnlyCollection<string> OwnersFor(string os) =>
        _rows.SelectMany(r => r.Row.Owners.TryGetValue(os, out var names) ? names : new List<string>())
            .Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    /// <summary>
    /// The calls these windows show, one per row. <paramref name="foreground"/> is the existing
    /// foreground sample: when the browser window in front names its host, a page on another
    /// site is not a call, whatever it calls itself.
    /// </summary>
    public IReadOnlyList<DetectedCall> Match(string os, IEnumerable<CallWindow> windows, ForegroundInfo? foreground = null)
    {
        var list = windows as IReadOnlyCollection<CallWindow> ?? windows.ToList();
        var found = new List<DetectedCall>();
        foreach (var row in _rows)
        {
            var hit = list.FirstOrDefault(w => IsCall(row, os, w, foreground));
            if (hit is not null) found.Add(new DetectedCall(row.Row.Id, row.Row.App, row.Row.Huddle, row.Row.Browser ? hit.Owner : null));
        }
        return found;
    }

    /// <summary>A browser's tab titles still hold this row's call: the tab is open behind another one.</summary>
    public bool TabHoldsCall(string callId, IEnumerable<string> tabTitles)
    {
        var row = _rows.FirstOrDefault(r => r.Row.Id == callId);
        return row is not null && tabTitles.Any(t => TitleMatches(row, PagePart(row, t)));
    }

    private bool IsCall(CompiledRow row, string os, CallWindow window, ForegroundInfo? foreground)
    {
        if (!row.Row.Owners.TryGetValue(os, out var owners)) return false;
        if (!owners.Contains(window.Owner, StringComparer.OrdinalIgnoreCase)) return false;
        if (window.ClassName is { Length: > 0 } cls && row.Row.WindowClasses.Contains(cls, StringComparer.OrdinalIgnoreCase)) return true;
        if (string.IsNullOrWhiteSpace(window.Title)) return false;
        var title = window.Title.Trim();
        if (!TitleMatches(row, PagePart(row, title))) return false;
        if (row.Row.Browser && foreground is { Url: { Length: > 0 } host, Title: { } front } && string.Equals(front.Trim(), title, StringComparison.Ordinal))
            return row.Row.Hosts.Contains(host, StringComparer.OrdinalIgnoreCase);
        return true;
    }

    /// <summary>The page part of a browser's title: "Meet - abc - Google Chrome" reads "Meet - abc", "Meet - Google Chrome" reads "Meet".</summary>
    private string PagePart(CompiledRow row, string title) =>
        row.Row.Browser ? _browserSuffix.Replace(title, "", 1) : title;

    private static bool TitleMatches(CompiledRow row, string title)
    {
        try
        {
            return row.Titles.Any(t => t.IsMatch(title)) && !row.NotTitles.Any(t => t.IsMatch(title));
        }
        catch (RegexMatchTimeoutException)
        {
            return false;
        }
    }

    private sealed class CompiledRow
    {
        public CompiledRow(CallRow row)
        {
            Row = row;
            Titles = row.Titles.Select(t => new Regex(t, Options, RegexLimit)).ToList();
            NotTitles = row.NotTitles.Select(t => new Regex(t, Options, RegexLimit)).ToList();
        }

        public CallRow Row { get; }
        public List<Regex> Titles { get; }
        public List<Regex> NotTitles { get; }
    }
}
