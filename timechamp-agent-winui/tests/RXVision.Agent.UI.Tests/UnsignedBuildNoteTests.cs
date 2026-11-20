using Avalonia.Controls;
using Avalonia.Headless.XUnit;
using Avalonia.VisualTree;
using RXVision.Agent.Core.Util;
using RXVision.Agent.ViewModels;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// Audit F-01 (ported from 3.6): a build that does not check update signatures says so under its
/// version, where a staging or pilot build already names its servers (AG-2). The 4.0 agent shows
/// its version on the sign-in window.
/// </summary>
public class UnsignedBuildNoteTests
{
    private const string Note = "Updates are not signed in this build.";

    [Fact]
    public void A_build_that_checks_signatures_shows_its_version_alone()
    {
        var agent = new FakeAgent();
        Assert.Equal("Version 4.0.0", new SignInViewModel(agent, null, NullLog.Instance).VersionText);
    }

    [Fact]
    public void A_build_without_the_update_key_says_so_under_its_version()
    {
        var agent = new FakeAgent { UnsignedUpdatesNote = Note };
        Assert.Equal("Version 4.0.0\nUpdates are not signed in this build.", new SignInViewModel(agent, null, NullLog.Instance).VersionText);
    }

    [Fact]
    public void A_staging_build_without_the_key_shows_both()
    {
        var agent = new FakeAgent { BuiltForHosts = "staging.rxvision.shop", UnsignedUpdatesNote = Note };
        Assert.Equal("Version 4.0.0 · staging.rxvision.shop\nUpdates are not signed in this build.", new SignInViewModel(agent, null, NullLog.Instance).VersionText);
    }

    /// <summary>The line under the version, as drawn: two lines, none wider than the room it has.</summary>
    private static void AssertFits(Window window, string text, string shot)
    {
        var path = Shots.Save(window, shot);
        Assert.True(new FileInfo(path).Length > 5_000, $"{shot} looks empty");
        var line = Assert.Single(window.GetVisualDescendants().OfType<TextBlock>(), t => t.Text == text);
        Assert.True(line.IsEffectivelyVisible);
        Assert.Equal(2, line.TextLayout.TextLines.Count);
        Assert.True(line.TextLayout.WidthIncludingTrailingWhitespace <= line.Bounds.Width + 0.5,
            $"{shot}: the version line is {line.TextLayout.WidthIncludingTrailingWhitespace:F0} wide in {line.Bounds.Width:F0}");
    }

    [AvaloniaFact]
    public void The_note_fits_under_the_version_on_the_sign_in_window()
    {
        var agent = new FakeAgent { UnsignedUpdatesNote = Note };
        var vm = new SignInViewModel(agent, null, NullLog.Instance) { Email = "asha@timechamp.test" };
        var window = new SignInWindow { DataContext = vm };
        window.Show();
        AssertFits(window, vm.VersionText, "signin-unsigned-updates");
        window.AllowClose = true;
        window.Close();
    }
}
