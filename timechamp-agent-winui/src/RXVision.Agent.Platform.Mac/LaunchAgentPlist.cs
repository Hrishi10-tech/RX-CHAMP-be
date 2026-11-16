using System.Security;

namespace RXVision.Agent.Platform.Mac;

/// <summary>
/// Builds the launchd user-agent plist that starts the app at login. Pure and
/// unit-tested: the probe writes whatever this returns.
///
///  - RunAtLoad starts it at each login;
///  - KeepAlive { SuccessfulExit = false } relaunches it after a crash but NOT
///    after a clean Quit (so "Quit" means quit until next login);
///  - ProcessType Interactive and LimitLoadToSessionType Aqua keep it a normal
///    windowed app in the user's GUI session, never a background daemon;
///  - AbandonProcessGroup true: when the job exits, launchd would otherwise kill
///    every process left in its process group, which includes the self-update
///    swap script the app starts just before it quits for an update.
/// </summary>
internal static class LaunchAgentPlist
{
    internal const string Label = "com.rxvision.agent";
    internal const string FileName = "com.rxvision.agent.plist";

    internal static string Build(string executablePath, string argument = "--minimized")
    {
        var exe = SecurityElement.Escape(executablePath);
        var arg = SecurityElement.Escape(argument);
        return
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
            "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n" +
            "<plist version=\"1.0\">\n" +
            "<dict>\n" +
            "    <key>Label</key>\n" +
            $"    <string>{Label}</string>\n" +
            "    <key>ProgramArguments</key>\n" +
            "    <array>\n" +
            $"        <string>{exe}</string>\n" +
            $"        <string>{arg}</string>\n" +
            "    </array>\n" +
            "    <key>RunAtLoad</key>\n" +
            "    <true/>\n" +
            "    <key>KeepAlive</key>\n" +
            "    <dict>\n" +
            "        <key>SuccessfulExit</key>\n" +
            "        <false/>\n" +
            "    </dict>\n" +
            "    <key>ProcessType</key>\n" +
            "    <string>Interactive</string>\n" +
            "    <key>LimitLoadToSessionType</key>\n" +
            "    <string>Aqua</string>\n" +
            "    <key>AbandonProcessGroup</key>\n" +
            "    <true/>\n" +
            "</dict>\n" +
            "</plist>\n";
    }

    /// <summary>
    /// False for a path that must not go into the login item: empty, relative, or
    /// inside App Translocation (an app opened from Downloads without being moved
    /// runs from a random read-only mount that is gone after logout).
    /// </summary>
    internal static bool IsStableProgramPath(string? path) =>
        !string.IsNullOrWhiteSpace(path)
        && path.StartsWith('/')
        && !path.Contains("/AppTranslocation/", StringComparison.Ordinal);

    /// <summary>
    /// The "pid = N" line of `launchctl print gui/UID/LABEL` (present only while the
    /// job's process runs), or null.
    /// </summary>
    internal static int? RunningPid(string? launchctlPrint)
    {
        if (string.IsNullOrEmpty(launchctlPrint)) return null;
        foreach (var raw in launchctlPrint.Split('\n'))
        {
            var line = raw.Trim();
            if (!line.StartsWith("pid = ", StringComparison.Ordinal)) continue;
            if (int.TryParse(line.AsSpan(6).Trim(), System.Globalization.NumberStyles.None,
                    System.Globalization.CultureInfo.InvariantCulture, out var pid) && pid > 0)
                return pid;
        }
        return null;
    }

    /// <summary>Reads back the first ProgramArguments entry (the executable path) from a plist, or null.</summary>
    internal static string? ReadProgramPath(string plistXml)
    {
        if (string.IsNullOrEmpty(plistXml)) return null;
        var key = plistXml.IndexOf("<key>ProgramArguments</key>", StringComparison.Ordinal);
        if (key < 0) return null;
        var arrayStart = plistXml.IndexOf("<array>", key, StringComparison.Ordinal);
        if (arrayStart < 0) return null;
        var firstOpen = plistXml.IndexOf("<string>", arrayStart, StringComparison.Ordinal);
        if (firstOpen < 0) return null;
        firstOpen += "<string>".Length;
        var firstClose = plistXml.IndexOf("</string>", firstOpen, StringComparison.Ordinal);
        if (firstClose < 0) return null;
        var value = plistXml[firstOpen..firstClose];
        return System.Net.WebUtility.HtmlDecode(value);
    }
}
