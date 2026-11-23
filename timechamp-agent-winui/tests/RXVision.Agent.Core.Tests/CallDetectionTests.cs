using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Platform;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>
/// What each detector looks for, per app and OS, against the shipped data file: real looking
/// titles and process names that must match, and the near misses that must stay quiet.
/// </summary>
public class CallDetectionTests
{
    private const string Win = CallDetectionTable.Windows;
    private const string Mac = CallDetectionTable.Mac;
    private static readonly CallDetectionTable Table = CallDetectionTable.Shipped;

    private static string? Seen(string os, string owner, string? title, string? cls = null, ForegroundInfo? front = null) =>
        Table.Match(os, new[] { new CallWindow(owner, title, cls) }, front).SingleOrDefault()?.Id;

    // ---- Microsoft Teams ------------------------------------------------------------------------

    [Theory]
    [InlineData(Win, "ms-teams", "Meeting with Asha | Microsoft Teams")]
    [InlineData(Win, "ms-teams", "Call with Asha | Microsoft Teams")]
    [InlineData(Win, "Teams", "Meeting in \"General\" | Microsoft Teams")]
    [InlineData(Win, "ms-teams", "Weekly sync | Microsoft Teams")]
    [InlineData(Mac, "Microsoft Teams", "Meeting with Asha | Microsoft Teams")]
    [InlineData(Mac, "MSTeams", "Weekly sync | Microsoft Teams")]
    [InlineData(Mac, "Microsoft Teams classic", "CALL WITH ASHA | MICROSOFT TEAMS")]
    public void Teams_on_a_call(string os, string owner, string title) => Assert.Equal("teams", Seen(os, owner, title));

    [Theory]
    [InlineData(Win, "ms-teams", "Chat | Asha Kumar | Microsoft Teams")]
    [InlineData(Win, "ms-teams", "Activity | Microsoft Teams")]
    [InlineData(Win, "ms-teams", "Teams | General | Engineering | Microsoft Teams")]
    [InlineData(Win, "Teams", "Calendar | Calendar | Microsoft Teams")]
    [InlineData(Win, "ms-teams", "Calls | Microsoft Teams")]
    [InlineData(Win, "ms-teams", "OneDrive | Microsoft Teams")]
    [InlineData(Win, "ms-teams", "Files | Microsoft Teams")]
    [InlineData(Win, "ms-teams", "Apps | Microsoft Teams")]
    [InlineData(Win, "ms-teams", "Copilot | Microsoft Teams")]
    [InlineData(Win, "ms-teams", "Microsoft Teams")]
    [InlineData(Mac, "Microsoft Teams", "Chat | Asha Kumar | Microsoft Teams")]
    [InlineData(Mac, "MSTeams", "Calls | Microsoft Teams")]
    [InlineData(Mac, "Microsoft Teams", "Microsoft Teams")]
    [InlineData(Mac, "Microsoft Teams", null)]
    public void Teams_chat_and_pages_are_no_call(string os, string owner, string? title) => Assert.Null(Seen(os, owner, title));

    [Fact]
    public void A_browser_tab_about_Teams_is_not_the_Teams_row()
    {
        Assert.Null(Seen(Win, "chrome", "Weekly sync | Microsoft Teams - Google Chrome"));
        Assert.Null(Seen(Mac, "Google Chrome", "Weekly sync | Microsoft Teams"));
    }

    // ---- Zoom ------------------------------------------------------------------------------------

    [Theory]
    [InlineData(Win, "Zoom", "Zoom Meeting", null)]
    [InlineData(Win, "Zoom", "Zoom Webinar", null)]
    [InlineData(Win, "Zoom", "Zoom Meeting 40-Minutes", null)]
    [InlineData(Win, "Zoom", "Zoom", "ZPContentViewWndClass")]
    [InlineData(Win, "Zoom", "Zoom Workplace", "ConfMultiTabContentWndClass")]
    [InlineData(Mac, "zoom.us", "Zoom Meeting", null)]
    [InlineData(Mac, "zoom.us", "ZOOM WEBINAR", null)]
    public void Zoom_on_a_call(string os, string owner, string title, string? cls) => Assert.Equal("zoom", Seen(os, owner, title, cls));

    [Theory]
    [InlineData(Win, "Zoom", "Zoom Workplace", "ZPPTMainFrmWndClassEx")]
    [InlineData(Win, "Zoom", "Zoom", null)]
    [InlineData(Win, "Zoom", "Settings", null)]
    [InlineData(Win, "Zoom", "Zoom Meetings", null)]
    [InlineData(Mac, "zoom.us", "Zoom Workplace", null)]
    [InlineData(Mac, "zoom.us", "Zoom", null)]
    [InlineData(Mac, "zoom.us", "Zoom Meetings", null)]
    public void A_Zoom_window_with_no_meeting_is_no_call(string os, string owner, string title, string? cls) => Assert.Null(Seen(os, owner, title, cls));

    [Fact]
    public void Another_app_with_Zoom_in_its_title_is_no_call()
    {
        Assert.Null(Seen(Win, "chrome", "Zoom Meeting - Google Chrome"));
        Assert.Null(Seen(Win, "notepad", "Zoom Meeting"));
        Assert.Null(Seen(Mac, "Notes", "Zoom Meeting"));
    }

    [Fact]
    public void The_macOS_owner_name_does_not_stand_for_the_Windows_process()
    {
        Assert.Null(Seen(Win, "zoom.us", "Zoom Meeting"));
        Assert.Null(Seen(Mac, "Zoom", "Zoom Meeting"));
    }

    // ---- Google Meet -----------------------------------------------------------------------------

    [Theory]
    [InlineData(Win, "chrome", "Meet - abc-defg-hij - Google Chrome")]
    [InlineData(Win, "chrome", "Meet - Weekly sync - Google Chrome - Asha")]
    [InlineData(Win, "chrome", "Meet \u2013 abc-defg-hij - Audio playing - Google Chrome")]
    [InlineData(Win, "msedge", "Meet - abc-defg-hij - Microsoft\u200b Edge")]
    [InlineData(Win, "firefox", "Meet - abc-defg-hij \u2014 Mozilla Firefox")]
    [InlineData(Win, "brave", "Meet - abc-defg-hij - Brave")]
    [InlineData(Win, "opera", "Meet - abc-defg-hij - Opera")]
    [InlineData(Win, "vivaldi", "Meet - abc-defg-hij - Vivaldi")]
    [InlineData(Win, "chromium", "Meet - abc-defg-hij - Chromium")]
    [InlineData(Mac, "Google Chrome", "Meet - abc-defg-hij")]
    [InlineData(Mac, "Microsoft Edge", "Meet - abc-defg-hij")]
    [InlineData(Mac, "Brave Browser", "Meet - Weekly sync")]
    [InlineData(Mac, "Safari", "Meet - abc-defg-hij")]
    [InlineData(Mac, "Firefox", "Meet \u2013 abc-defg-hij")]
    [InlineData(Mac, "Vivaldi", "Meet - abc-defg-hij")]
    [InlineData(Mac, "Opera", "Meet - abc-defg-hij")]
    [InlineData(Mac, "Chromium", "meet - abc-defg-hij")]
    public void Google_Meet_on_a_call(string os, string owner, string title) => Assert.Equal("meet", Seen(os, owner, title));

    [Theory]
    [InlineData(Win, "chrome", "Google Meet - Google Chrome")]            // the landing page
    [InlineData(Win, "chrome", "Meet - Google Chrome")]                   // a tab just named Meet
    [InlineData(Win, "msedge", "Meet - Microsoft\u200b Edge")]
    [InlineData(Win, "firefox", "Meet \u2014 Mozilla Firefox")]
    [InlineData(Win, "chrome", "Meet")]
    [InlineData(Win, "chrome", "Meet the team - Acme - Google Chrome")]
    [InlineData(Win, "chrome", "How to use Google Meet - YouTube - Google Chrome")]
    [InlineData(Win, "chrome", "Meeting notes - Google Docs - Google Chrome")]
    [InlineData(Mac, "Google Chrome", "Google Meet")]
    [InlineData(Mac, "Safari", "Meet")]
    [InlineData(Mac, "Safari", "Meet the team")]
    [InlineData(Mac, "Firefox", "Meeting notes")]
    public void A_browser_tab_named_Meet_is_no_call(string os, string owner, string title) => Assert.Null(Seen(os, owner, title));

    [Fact]
    public void When_the_foreground_read_names_the_host_it_decides()
    {
        var title = "Meet - Our team - Google Chrome";
        Assert.Equal("meet", Seen(Win, "chrome", title));
        Assert.Equal("meet", Seen(Win, "chrome", title, front: new ForegroundInfo("Google Chrome", title, "meet.google.com")));
        Assert.Null(Seen(Win, "chrome", title, front: new ForegroundInfo("Google Chrome", title, "acme.example.com")));
        // Another window in front says nothing about this one.
        Assert.Equal("meet", Seen(Win, "chrome", title, front: new ForegroundInfo("Excel", "Book1", null)));
        Assert.Equal("meet", Seen(Win, "chrome", title, front: new ForegroundInfo("Google Chrome", "Inbox - Google Chrome", "mail.example.com")));
        // The bare title on the right host is still the landing page.
        Assert.Null(Seen(Mac, "Google Chrome", "Google Meet", front: new ForegroundInfo("Google Chrome", "Google Meet", "meet.google.com")));
    }

    [Fact]
    public void A_call_tab_behind_another_tab_still_counts_only_with_its_title()
    {
        Assert.True(Table.TabHoldsCall("meet", new[] { "Inbox", "Meet - abc-defg-hij" }));
        Assert.True(Table.TabHoldsCall("meet", new[] { "Meet \u2013 abc-defg-hij - Camera and microphone recording" }));
        Assert.False(Table.TabHoldsCall("meet", new[] { "Inbox", "Google Meet", "Meet", "Meet the team" }));
        Assert.False(Table.TabHoldsCall("meet", Array.Empty<string>()));
    }

    [Fact]
    public void Teams_and_Zoom_in_a_browser_are_not_detected_in_this_release()
    {
        Assert.Null(Seen(Win, "chrome", "Meeting with Asha | Microsoft Teams - Google Chrome"));
        Assert.Null(Seen(Mac, "Safari", "Zoom Meeting"));
    }

    // ---- Slack huddle ------------------------------------------------------------------------------

    [Theory]
    [InlineData(Win, "slack", "Huddle: #general - Acme - Slack")]
    [InlineData(Win, "slack", "Huddle with Asha Kumar - Acme - Slack")]
    [InlineData(Mac, "Slack", "Huddle: #general - Acme")]
    [InlineData(Mac, "Slack", "huddle")]
    public void Slack_in_a_huddle(string os, string owner, string title) => Assert.Equal("slack", Seen(os, owner, title));

    [Theory]
    [InlineData(Win, "slack", "huddle-notes (Channel) - Acme - Slack")]
    [InlineData(Win, "slack", "huddle (Channel)")]
    [InlineData(Win, "slack", "huddle-team (Private Channel) - Acme - Slack")]
    [InlineData(Win, "slack", "Huddle Bot (DM) - Acme - Slack")]
    [InlineData(Win, "slack", "general (Channel) - Acme - Slack")]
    [InlineData(Win, "slack", "Slack")]
    [InlineData(Win, "slack", "Huddles are great in Threads") ]
    [InlineData(Mac, "Slack", "huddle-notes (Channel) - Acme")]
    [InlineData(Mac, "Slack", "Asha Kumar (DM) - Acme")]
    public void Slack_with_no_huddle_is_no_call(string os, string owner, string title) => Assert.Null(Seen(os, owner, title));

    [Fact]
    public void A_title_saying_huddle_in_another_app_is_no_call()
    {
        Assert.Null(Seen(Win, "chrome", "Huddle: #general - Google Chrome"));
        Assert.Null(Seen(Mac, "Notes", "Huddle: #general"));
    }

    // ---- The table ---------------------------------------------------------------------------------

    [Fact]
    public void The_window_read_is_limited_to_the_tables_processes_on_each_OS()
    {
        Assert.Equal(new[] { "ms-teams", "Teams", "Zoom", "chrome", "msedge", "brave", "opera", "vivaldi", "firefox", "chromium", "slack" }, Table.OwnersFor(Win));
        Assert.Equal(new[] { "Microsoft Teams", "MSTeams", "Microsoft Teams classic", "zoom.us", "Google Chrome", "Microsoft Edge", "Brave Browser", "Safari", "Firefox", "Vivaldi", "Opera", "Chromium", "Slack" }, Table.OwnersFor(Mac));
    }

    [Fact]
    public void Each_row_says_its_name_and_a_huddle_says_so()
    {
        var calls = Table.Match(Mac, new[]
        {
            new CallWindow("Microsoft Teams", "Weekly sync | Microsoft Teams"),
            new CallWindow("zoom.us", "Zoom Meeting"),
            new CallWindow("Safari", "Meet - abc-defg-hij"),
            new CallWindow("Slack", "Huddle: #general"),
        });
        Assert.Equal(new[] { ("teams", "Teams", false), ("zoom", "Zoom", false), ("meet", "Google Meet", false), ("slack", "Slack", true) }, calls.Select(c => (c.Id, c.App, c.IsHuddle)));
        Assert.Equal("Safari", calls.Single(c => c.Id == "meet").BrowserOwner);
        Assert.Null(calls.Single(c => c.Id == "zoom").BrowserOwner);
    }

    [Fact]
    public void Only_Windows_reads_the_Windows_row()
    {
        Assert.Equal(Win, CallDetectionTable.OsKey("windows"));
        Assert.Equal(Mac, CallDetectionTable.OsKey("mac"));
        Assert.Equal(Mac, CallDetectionTable.OsKey("dev"));
    }
}
