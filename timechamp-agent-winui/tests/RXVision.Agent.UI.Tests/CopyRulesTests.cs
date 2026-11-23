using System.Text.RegularExpressions;
using Avalonia.Controls;
using Avalonia.VisualTree;
using RXVision.Agent.Icon;
using RXVision.Agent.Services;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// Brief 1.5, as a check a string can fail: calm, sentence case, no exclamation marks, no capitals
/// for emphasis, none of the words the brief names. Used on the source and on what a window shows.
/// </summary>
internal static class CopyRules
{
    private static readonly Regex Banned = new(@"\b(violations?|warnings?|late|overdue|failed|idle)\b", RegexOptions.IgnoreCase);
    private static readonly Regex Shouting = new(@"\b[A-Z]{3,}\b");
    private static readonly Regex Word = new(@"[\p{L}'][\p{L}'\-]*");

    /// <summary>What may keep its capital inside a sentence: names, and the buttons a sentence points at.</summary>
    private static readonly HashSet<string> Names = new(StringComparer.Ordinal)
    {
        "RX", "Vision", "AM", "PM", "Zoom", "Teams", "Google", "Meet", "Slack", "Microsoft", "Windows", "Applications", "Downloads",
        "Finder", "Explorer", "Settings", "Super", "Manager", "Admin", "CL", "SL", "I", "Set",
        "Start", "End", "Resume", "Take", "Skip", "Log", "Count", "Ask", "Leave", "Stay", "Add", "Keep", "Save", "Reset", "Back", "Quit",
        "Today", "Messages", "Profile", "Me", "Working",
        // 4.0's own places a sentence points at: Next break, History, Today's breaks, "Offline, no activity data".
        "Next", "History", "Today's", "Offline", "I'm",
    };

    /// <summary>Every rule the words break; none for clean words.</summary>
    public static IEnumerable<string> Problems(string text) => InData(text).Concat(TitleCased(text).Select(c => $"title case, \"{c}\""));

    /// <summary>The rules that hold on a window too, where people's names and their own words also show.</summary>
    public static IEnumerable<string> InData(string text)
    {
        if (text.Contains('!')) yield return "an exclamation mark";
        if (text.Contains('—')) yield return "a long dash";
        foreach (Match m in Banned.Matches(text)) yield return $"the word \"{m.Value}\"";
        foreach (Match m in Shouting.Matches(text)) yield return $"capitals for emphasis, \"{m.Value}\"";
    }

    /// <summary>A capital inside a sentence that no name explains.</summary>
    private static IEnumerable<string> TitleCased(string text)
    {
        var starts = new HashSet<int> { 0, text.Length - text.TrimStart().Length };
        foreach (Match m in Regex.Matches(text, @"(?:[.?:;·(]|\{\})\s*")) starts.Add(m.Index + m.Length);
        foreach (Match m in Word.Matches(text))
        {
            if (m.Index == 0 || starts.Contains(m.Index)) continue;
            if (char.IsUpper(m.Value[0]) && !Names.Contains(m.Value)) yield return m.Value;
        }
    }
}

public class CopyRulesTests
{
    private static string Root()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "RXVision.Agent.sln"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("the repository was not found");
    }

    private static readonly Regex Attribute = new(@"\b(Text|Content|Header|Watermark|Title|ToolTip\.Tip|AutomationProperties\.Name)=""([^""{][^""]*)""");
    private static readonly Regex Literal = new(@"(?:\$@|@\$|\$|@)?""((?:[^""\\\n]|\\.)*)""");
    /// <summary>Lines whose strings no person reads: logs, exceptions, codes and platform calls.</summary>
    private static readonly Regex NotForPeople = new(
        @"_log\.|\bLog\.|log\.(Info|Warn|Error|Debug)|throw new|Fail\(|nameof\(|Color\.Parse|StartsWith|EndsWith|\bcase ""|== ""|!= ""|\bis ""|\bor ""|Path\.|Environment\.|GetEnvironmentVariable|ToString\(""|ParseExact|Regex|Uri\(|PresenceStatus|ArgumentException|Icon\.[A-Z]|FontFamily|avares:|fonts:|Dispatcher|StringComparison");

    /// <summary>The views and view models, and what they show from the services and the core.</summary>
    private static IEnumerable<string> Sources()
    {
        var root = Root();
        var app = Path.Combine(root, "src/RXVision.Agent");
        foreach (var dir in new[] { "Views", "ViewModels" })
            foreach (var file in Directory.EnumerateFiles(Path.Combine(app, dir), "*", SearchOption.AllDirectories))
                if (Path.GetExtension(file) is ".axaml" or ".cs") yield return file;
        foreach (var name in new[]
                 {
                     "AppController.cs", "Icon/DayMeter.cs", "Services/BreakActions.cs", "Services/BreakAlerts.cs", "Services/DayAlerts.cs",
                     "Services/MeetingAlerts.cs", "Services/Toasts.cs", "Services/ToastService.cs", "Services/Fmt.cs",
                 })
            yield return Path.Combine(app, name);
        var core = Path.Combine(root, "src/RXVision.Agent.Core");
        foreach (var name in new[]
                 {
                     "Api/ApiResult.cs", "Breaks/BreakService.cs", "Meetings/MeetingService.cs", "Workday/WorkdayService.cs", "Update/UpdateService.cs",
                 })
            yield return Path.Combine(core, name);
    }

    /// <summary>Every string in a file a person could read, with its line.</summary>
    internal static IEnumerable<(int Line, string Text)> StringsIn(string file)
    {
        var text = File.ReadAllText(file);
        if (file.EndsWith(".axaml", StringComparison.Ordinal))
        {
            text = Regex.Replace(text, @"<!--.*?-->", m => new string('\n', m.Value.Count(c => c == '\n')), RegexOptions.Singleline);
            foreach (Match m in Attribute.Matches(text)) yield return (text[..m.Index].Count(c => c == '\n') + 1, m.Groups[2].Value);
            yield break;
        }
        var number = 0;
        foreach (var line in text.Split('\n'))
        {
            number++;
            var code = line.TrimStart();
            if (code.StartsWith("//", StringComparison.Ordinal) || code.StartsWith('[') || NotForPeople.IsMatch(line)) continue;
            foreach (Match m in Literal.Matches(line))
            {
                var value = m.Groups[1].Value;
                // Placeholders, inner ones first: an expression can hold braces of its own.
                for (var before = ""; before != value;)
                {
                    before = value;
                    value = Regex.Replace(value, @"\{[^{}]+\}", "\u0001");
                }
                value = value.Replace("\u0001", "{}");
                if (value.Contains(' ') || Regex.IsMatch(value, @"^[A-Z][a-z]")) yield return (number, value);
            }
        }
    }

    [Theory]
    [InlineData("BREAK TIME EXCEEDED!")]
    [InlineData("You are idle")]
    [InlineData("Your break is overdue")]
    [InlineData("You started late")]
    [InlineData("Sign-in failed.")]
    [InlineData("Attendance warning")]
    [InlineData("A violation was logged")]
    [InlineData("Well done!")]
    [InlineData("Take A Break")]
    public void The_scan_catches_what_the_brief_rules_out(string words) => Assert.NotEmpty(CopyRules.Problems(words));

    [Theory]
    [InlineData("Break extended · 04:32")]
    [InlineData("You've been away 10 min. Resume when ready.")]
    [InlineData("Skip this break? Your next one is at 4:30 PM.")]
    [InlineData("Resume work")]
    [InlineData("Break ends in 2 min")]
    [InlineData("Tap Resume work first, then start the next one.")]
    [InlineData("A later break was already taken today, so this one can't start.")]
    public void The_scan_passes_the_briefs_own_words(string words) => Assert.Empty(CopyRules.Problems(words));

    [Fact]
    public void Every_string_in_the_views_and_view_models_follows_the_rules()
    {
        var found = new List<string>();
        var scanned = 0;
        foreach (var file in Sources())
        {
            foreach (var (line, text) in StringsIn(file))
            {
                scanned++;
                foreach (var problem in CopyRules.Problems(text)) found.Add($"{Path.GetFileName(file)}:{line}: {problem}: {text}");
            }
        }
        Assert.True(scanned > 400, $"only {scanned} strings scanned");
        Assert.True(found.Count == 0, string.Join("\n", found));
    }

    [Fact]
    public void The_five_table_rows_read_exactly()
    {
        var extended = new DayReading(IconStatus.BreakExtended, 3 * 3600, 8 * 3600, new TimeSpan(0, 4, 32));
        Assert.Equal("Break extended · 04:32", extended.Label);

        var all = string.Join("\n", Sources().Where(f => f.EndsWith(".cs", StringComparison.Ordinal) || f.EndsWith(".axaml", StringComparison.Ordinal)).Select(File.ReadAllText));
        // 4.0 keeps its away window (it asks for a reason), so 3.6's away card line is not here.
        Assert.Contains("\"Skip this break?\"", all);
        Assert.Contains("Your next one is at {", all);
        Assert.Contains("\"Resume work\"", all);
        Assert.Contains("\"Break ends in 2 min\"", all);
    }

    [Fact]
    public void None_of_the_old_words_is_left()
    {
        // "End break" stays in 4.0: a paused break's row offers Resume and End break.
        var all = Sources().SelectMany(StringsIn).Select(s => s.Text).ToHashSet();
        foreach (var old in new[] { "BREAK TIME EXCEEDED!", "You are idle", "Are you sure you want to skip?", "Break ending soon!", "Start Day", "End Day", "Back to work", "Meeting ended" })
            Assert.DoesNotContain(old, all);
    }

    /// <summary>What a window shows now, for the sweeps of every state.</summary>
    internal static void CheckShown(Avalonia.Controls.TopLevel top, string state)
    {
        var shown = top.GetVisualDescendants().OfType<Control>().Where(c => c.IsEffectivelyVisible);
        var words = shown.OfType<TextBlock>().Select(t => t.Text)
            .Concat(shown.OfType<TextBox>().Select(t => t.Watermark))
            .Where(t => !string.IsNullOrWhiteSpace(t) && t != "!")
            .Select(t => t!);
        var problems = words.SelectMany(w => CopyRules.InData(w).Select(p => $"{p}: {w}")).ToList();
        Assert.True(problems.Count == 0, $"{state}: {string.Join("; ", problems)}");
    }
}
