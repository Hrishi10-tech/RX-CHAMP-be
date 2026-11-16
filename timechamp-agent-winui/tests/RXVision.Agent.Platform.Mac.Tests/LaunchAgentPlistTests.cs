using RXVision.Agent.Platform.Mac;
using Xunit;

namespace RXVision.Agent.Platform.Mac.Tests;

public class LaunchAgentPlistTests
{
    [Fact]
    public void Build_contains_the_required_launchd_keys()
    {
        var xml = LaunchAgentPlist.Build("/Applications/RX Vision.app/Contents/MacOS/RXVision");

        Assert.Contains("<string>com.rxvision.agent</string>", xml);
        Assert.Contains("<string>/Applications/RX Vision.app/Contents/MacOS/RXVision</string>", xml);
        Assert.Contains("<string>--minimized</string>", xml);

        // RunAtLoad true
        Assert.Matches(@"<key>RunAtLoad</key>\s*<true/>", xml);
        // KeepAlive { SuccessfulExit = false } : crash relaunches, Quit does not
        Assert.Matches(@"<key>KeepAlive</key>\s*<dict>\s*<key>SuccessfulExit</key>\s*<false/>", xml);
        Assert.Matches(@"<key>ProcessType</key>\s*<string>Interactive</string>", xml);
        Assert.Matches(@"<key>LimitLoadToSessionType</key>\s*<string>Aqua</string>", xml);
        // launchd must not kill the update script (same process group) when the app exits for an update.
        Assert.Matches(@"<key>AbandonProcessGroup</key>\s*<true/>", xml);
    }

    [Fact]
    public void Build_is_a_well_formed_plist()
    {
        var doc = System.Xml.Linq.XDocument.Parse(LaunchAgentPlist.Build("/Applications/RX Vision.app/Contents/MacOS/RXVision"));
        var keys = doc.Root!.Element("dict")!.Elements("key").Select(k => k.Value).ToList();
        Assert.Equal(keys.Distinct().Count(), keys.Count);
        Assert.Contains("AbandonProcessGroup", keys);
    }

    [Theory]
    [InlineData("/Applications/RX Vision.app/Contents/MacOS/RXVision", true)]
    [InlineData("/Users/a/Applications/RX Vision.app/Contents/MacOS/RXVision", true)]
    [InlineData("/private/var/folders/xy/abc/T/AppTranslocation/1A2B-3C4D/d/RX Vision.app/Contents/MacOS/RXVision", false)]
    [InlineData("RX Vision.app/Contents/MacOS/RXVision", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void IsStableProgramPath_rejects_translocated_and_relative_paths(string? path, bool expected)
        => Assert.Equal(expected, LaunchAgentPlist.IsStableProgramPath(path));

    [Fact]
    public void RunningPid_reads_the_pid_line_of_launchctl_print()
    {
        const string running =
            "gui/501/com.rxvision.agent = {\n" +
            "\tactive count = 1\n" +
            "\tpath = /Users/a/Library/LaunchAgents/com.rxvision.agent.plist\n" +
            "\tstate = running\n\n" +
            "\tprogram = /Applications/RX Vision.app/Contents/MacOS/RXVision\n" +
            "\targuments = {\n\t\t/Applications/RX Vision.app/Contents/MacOS/RXVision\n\t\t--minimized\n\t}\n\n" +
            "\tpid = 4242\n" +
            "\timmediate reason = speculative\n" +
            "}\n";
        Assert.Equal(4242, LaunchAgentPlist.RunningPid(running));
    }

    [Theory]
    [InlineData("gui/501/com.rxvision.agent = {\n\tstate = not running\n\tlast exit code = 0\n}\n")]
    [InlineData("Could not find service \"com.rxvision.agent\" in domain for port")]
    [InlineData("")]
    [InlineData(null)]
    public void RunningPid_is_null_when_the_job_is_not_running(string? output)
        => Assert.Null(LaunchAgentPlist.RunningPid(output));

    [Fact]
    public void Build_escapes_xml_special_characters_in_the_path()
    {
        var xml = LaunchAgentPlist.Build("/Users/a&b/RX <Vision>/RXVision");
        Assert.Contains("/Users/a&amp;b/RX &lt;Vision&gt;/RXVision", xml);
        Assert.DoesNotContain("<Vision>", xml);
    }

    [Theory]
    [InlineData("/Applications/RX Vision.app/Contents/MacOS/RXVision")]
    [InlineData("/Users/a&b/weird path/RXVision")]
    public void ReadProgramPath_roundtrips_the_executable(string exe)
    {
        var xml = LaunchAgentPlist.Build(exe);
        Assert.Equal(exe, LaunchAgentPlist.ReadProgramPath(xml));
    }

    [Fact]
    public void ReadProgramPath_returns_null_for_garbage()
        => Assert.Null(LaunchAgentPlist.ReadProgramPath("not a plist"));
}
