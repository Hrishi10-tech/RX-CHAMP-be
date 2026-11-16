using RXVision.Agent.Platform.Mac;
using Xunit;

namespace RXVision.Agent.Platform.Mac.Tests;

public class BrowserSupportTests
{
    [Theory]
    [InlineData("Code", "Visual Studio Code")]
    [InlineData("iTerm2", "iTerm")]
    [InlineData("Google Chrome", "Google Chrome")]
    [InlineData("Some Random App", "Some Random App")] // pass-through
    public void FriendlyApp_maps_known_and_passes_through_unknown(string owner, string expected)
        => Assert.Equal(expected, BrowserSupport.FriendlyApp(owner));

    [Fact]
    public void FriendlyApp_handles_null_and_whitespace()
    {
        Assert.Null(BrowserSupport.FriendlyApp(null));
        Assert.Equal("  ", BrowserSupport.FriendlyApp("  "));
    }

    // BrowserKind is internal, so it cannot appear in a public xUnit signature;
    // the expected family is passed by name and mapped here.
    [Theory]
    [InlineData("Safari", "Safari", "Safari")]
    [InlineData("Google Chrome", "Chromium", "Google Chrome")]
    [InlineData("Microsoft Edge", "Chromium", "Microsoft Edge")]
    [InlineData("Brave Browser", "Chromium", "Brave Browser")]
    [InlineData("Arc", "Chromium", "Arc")]
    [InlineData("Vivaldi", "Chromium", "Vivaldi")]
    [InlineData("Opera", "Chromium", "Opera")]
    [InlineData("Mozilla Firefox", "Firefox", "Firefox")]
    public void TryGetBrowser_recognises_browsers(string owner, string kind, string appName)
    {
        Assert.True(BrowserSupport.TryGetBrowser(owner, out var k, out var app));
        Assert.Equal(kind, k.ToString());
        Assert.Equal(appName, app);
    }

    [Theory]
    [InlineData("Finder")]
    [InlineData("Visual Studio Code")]
    [InlineData(null)]
    public void TryGetBrowser_rejects_non_browsers(string? owner)
        => Assert.False(BrowserSupport.TryGetBrowser(owner, out _, out _));

    [Fact]
    public void AppleScript_shapes_per_family()
    {
        Assert.Equal("if application \"Safari\" is running then tell application \"Safari\" to get URL of front document",
            BrowserSupport.AppleScriptFor(BrowserKind.Safari, "Safari"));
        Assert.Equal("if application \"Google Chrome\" is running then tell application \"Google Chrome\" to get URL of active tab of front window",
            BrowserSupport.AppleScriptFor(BrowserKind.Chromium, "Google Chrome"));
        Assert.Null(BrowserSupport.AppleScriptFor(BrowserKind.Firefox, "Firefox"));
    }

    [Fact]
    public void AppleScript_never_launches_a_browser_that_has_quit()
    {
        // A bare `tell application` starts the app; every script must check it runs first.
        foreach (var (kind, app) in new[] { (BrowserKind.Safari, "Safari"), (BrowserKind.Chromium, "Arc") })
            Assert.StartsWith($"if application \"{app}\" is running then tell application \"{app}\"",
                BrowserSupport.AppleScriptFor(kind, app));
    }

    [Fact]
    public void HostFromUrl_is_null_for_the_empty_output_of_a_browser_that_is_not_running()
        => Assert.Null(BrowserSupport.HostFromUrl("\n"));

    [Theory]
    [InlineData("Evil\" do shell script \"rm")]
    [InlineData("back\\slash")]
    public void AppleScript_refuses_names_that_could_break_the_quoting(string appName)
        => Assert.Null(BrowserSupport.AppleScriptFor(BrowserKind.Chromium, appName));

    [Theory]
    [InlineData("https://www.example.com/path?x=1#y", "example.com")]
    [InlineData("http://sub.example.co.uk/", "sub.example.co.uk")]
    [InlineData("HTTPS://WWW.Example.COM", "example.com")]
    [InlineData("https://news.ycombinator.com", "news.ycombinator.com")]
    public void HostFromUrl_returns_bare_lowercase_host(string url, string expected)
        => Assert.Equal(expected, BrowserSupport.HostFromUrl(url));

    [Theory]
    [InlineData("chrome://newtab")]
    [InlineData("about:blank")]
    [InlineData("file:///Users/x/secret.pdf")]
    [InlineData("missing value")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not a url")]
    public void HostFromUrl_drops_non_web_and_junk(string? url)
        => Assert.Null(BrowserSupport.HostFromUrl(url));
}
