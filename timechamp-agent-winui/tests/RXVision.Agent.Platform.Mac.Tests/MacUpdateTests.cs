using System.Diagnostics;
using RXVision.Agent.Platform.Mac;
using Xunit;

namespace RXVision.Agent.Platform.Mac.Tests;

public class MacUpdateScriptTests
{
    private static string Script(int pid = 4321) => MacUpdateScript.Build(
        pid: pid,
        oldBundle: "/Applications/RX Vision.app",
        newBundle: "/Users/x/Library/Caches/RXVision/update-abc/RX Vision.app",
        logPath: "/Users/x/Library/Logs/RXVision/update.log",
        version: "3.1.0",
        startedFile: "/Users/x/Library/Application Support/RXVision/data/running-version.txt",
        workDir: "/Users/x/Library/Caches/RXVision/update-abc",
        zipPath: "/Users/x/Library/Caches/RXVision/rxvision-3.1.0.zip");

    [Fact]
    public void Build_waits_installs_relaunches_and_can_restore()
    {
        var script = Script();

        Assert.StartsWith("#!/bin/bash", script);
        Assert.Contains("PID=4321", script);
        // waits for the old process to exit before touching anything
        Assert.Contains("kill -0 \"$PID\"", script);
        // single-quoted paths survive the space in "RX Vision.app"
        Assert.Contains("OLD='/Applications/RX Vision.app'", script);
        Assert.Contains("BACKUP='/Applications/RX Vision.app.old-3.1.0'", script);
        Assert.Contains("STARTED='/Users/x/Library/Application Support/RXVision/data/running-version.txt'", script);
        // installs then relaunches minimized
        Assert.Contains("mv \"$NEW\" \"$OLD\"", script);
        Assert.Contains("'/usr/bin/open' -a \"$OLD\" --args --minimized", script);
        // restores the previous version if the install move fails
        Assert.Contains("mv \"$BACKUP\" \"$OLD\"", script);
    }

    [Fact]
    public void Build_never_moves_a_bundle_whose_process_is_still_running()
    {
        var script = Script(77);
        var waitLoop = script.IndexOf("kill -0 \"$PID\" 2>/dev/null || break", StringComparison.Ordinal);
        var forceStop = script.IndexOf("kill -9 \"$PID\"", StringComparison.Ordinal);
        var moveAside = script.IndexOf("mv \"$OLD\" \"$BACKUP\"", StringComparison.Ordinal);
        Assert.True(waitLoop >= 0 && forceStop > waitLoop && moveAside > forceStop,
            "the old process is waited for, then stopped, before its bundle is moved");
    }

    [Fact]
    public void Build_clears_a_stale_backup_and_relaunches_when_the_old_bundle_cannot_move()
    {
        var script = Script(77);
        // A backup left by an earlier failed run would otherwise swallow the bundle (mv into a dir).
        Assert.True(script.IndexOf("rm -rf \"$BACKUP\"", StringComparison.Ordinal)
                    < script.IndexOf("mv \"$OLD\" \"$BACKUP\"", StringComparison.Ordinal));
        // Could not move the old bundle aside: the old version is relaunched, not left closed.
        var asideLine = script.Split('\n').Single(l => l.Contains("mv \"$OLD\" \"$BACKUP\""));
        Assert.Contains("relaunch", asideLine);
        Assert.Contains("exit 1", asideLine);
    }

    [Fact]
    public void Build_keeps_the_backup_until_the_new_version_has_reported_and_stayed_up()
    {
        var script = Script();
        var relaunch = script.IndexOf("rm -f \"$STARTED\"\nrelaunch\n", StringComparison.Ordinal);
        var report = script.IndexOf("[ \"$(sed -n 1p \"$STARTED\")\" = \"$VERSION\" ]", StringComparison.Ordinal);
        var stayedUp = script.IndexOf($"sleep {MacUpdateScript.HealthySeconds}\n", StringComparison.Ordinal);
        var dropBackup = script.LastIndexOf("rm -rf \"$BACKUP\"", StringComparison.Ordinal);
        Assert.True(relaunch > 0 && report > relaunch && stayedUp > report && dropBackup > stayedUp,
            "the backup goes only after the new build reported its version and stayed up");
        Assert.Equal(20, MacUpdateScript.HealthySeconds);
    }

    [Theory]
    [InlineData("/plain/path", "'/plain/path'")]
    [InlineData("/has space/x", "'/has space/x'")]
    [InlineData("a'b", "'a'\\''b'")]
    public void Quote_wraps_and_escapes(string input, string expected)
        => Assert.Equal(expected, MacUpdateScript.Quote(input));
}

/// <summary>
/// Runs the real script with bash against bundles in a temp folder. "open" is a stub
/// that starts a stand-in for the app: it reports itself (version and process id, as
/// the agent does at start) and stays up, never reports, or reports and dies.
/// </summary>
[System.Runtime.Versioning.UnsupportedOSPlatform("windows")]
public sealed class MacUpdateScriptRunTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "rxv-mac-update-" + Guid.NewGuid().ToString("N"));
    private readonly List<int> _started = new();

    private string Old => Path.Combine(_root, "Applications", "RX Vision.app");
    private string Work => Path.Combine(_root, "Caches", "update-abc");
    private string New => Path.Combine(Work, "RX Vision.app");
    private string Zip => Path.Combine(_root, "Caches", "rxvision-3.1.0.zip");
    private string StartedFile => Path.Combine(_root, "data", "running-version.txt");
    private string OpenLog => Path.Combine(_root, "open.log");
    private string Backup => Old + ".old-3.1.0";

    public MacUpdateScriptRunTests()
    {
        Directory.CreateDirectory(Path.Combine(_root, "data"));
        Directory.CreateDirectory(Path.Combine(_root, "logs"));
    }

    private void Bundle(string path, string version, string mode)
    {
        Directory.CreateDirectory(Path.Combine(path, "Contents", "MacOS"));
        File.WriteAllText(Path.Combine(path, "Contents", "version"), version);
        File.WriteAllText(Path.Combine(path, "Contents", "mode"), mode);
    }

    private string OpenStub()
    {
        var stub = Path.Combine(_root, "open-stub.sh");
        File.WriteAllText(stub, $$"""
            #!/bin/bash
            B="$2"
            V="$(cat "$B/Contents/version")"
            M="$(cat "$B/Contents/mode")"
            echo "open $V" >> {{MacUpdateScript.Quote(OpenLog)}}
            case "$M" in
              good) sleep 60 >/dev/null 2>&1 & P=$!; echo "pid $P" >> {{MacUpdateScript.Quote(OpenLog)}}; printf '%s\n%s\n' "$V" "$P" > {{MacUpdateScript.Quote(StartedFile)}} ;;
              dies) bash -c 'exit 0' & P=$!; wait $P; printf '%s\n%s\n' "$V" "$P" > {{MacUpdateScript.Quote(StartedFile)}} ;;
              *) ;;
            esac
            """.Replace("\r\n", "\n"));
        File.SetUnixFileMode(stub, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return stub;
    }

    /// <summary>Runs the update the way the agent does (it has already exited: its pid is gone).</summary>
    private string Run(string newMode)
    {
        Bundle(Old, "3.0.9", "good");
        Bundle(New, "3.1.0", newMode);
        File.WriteAllText(Zip, "zip");
        File.WriteAllText(StartedFile, "3.0.9\n1\n");
        var exit = new ProcessStartInfo("/bin/bash") { UseShellExecute = false };
        exit.ArgumentList.Add("-c");
        exit.ArgumentList.Add("exit 0");
        using var gone = Process.Start(exit)!;
        gone.WaitForExit();
        var scriptPath = Path.Combine(_root, "Caches", "rxvision-update-x.sh");
        File.WriteAllText(scriptPath, MacUpdateScript.Build(gone.Id, Old, New, Path.Combine(_root, "logs", "update.log"), "3.1.0",
            StartedFile, Work, Zip, healthySeconds: 1, reportWithinSeconds: 2, open: OpenStub(), pkill: "true"));
        var bash = new ProcessStartInfo("/bin/bash") { UseShellExecute = false };
        bash.ArgumentList.Add(scriptPath);
        using var run = Process.Start(bash)!;
        Assert.True(run.WaitForExit(60_000), "the script finished");
        Assert.False(File.Exists(scriptPath), "the script removes itself");
        foreach (var line in File.Exists(OpenLog) ? File.ReadAllLines(OpenLog) : Array.Empty<string>())
            if (line.StartsWith("pid ") && int.TryParse(line[4..], out var pid)) _started.Add(pid);
        return File.ReadAllText(Path.Combine(_root, "logs", "update.log"));
    }

    private string[] Opened() => File.ReadAllLines(OpenLog).Where(l => l.StartsWith("open ")).ToArray();

    [Fact]
    public void A_new_version_that_reports_and_stays_up_is_kept_and_the_download_is_removed()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        var log = Run("good");

        Assert.Equal("3.1.0", File.ReadAllText(Path.Combine(Old, "Contents", "version")));
        Assert.False(Directory.Exists(Backup), "the backup goes once the new version is up: " + log);
        Assert.False(Directory.Exists(Work), "the unpack folder is removed");
        Assert.False(File.Exists(Zip), "the 100 MB zip is removed");
        Assert.Equal(new[] { "open 3.1.0" }, Opened());
    }

    [Fact]
    public void A_new_version_that_never_reports_is_replaced_by_the_previous_one()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        var log = Run("silent");

        Assert.Equal("3.0.9", File.ReadAllText(Path.Combine(Old, "Contents", "version")));
        Assert.False(Directory.Exists(Backup), log);
        Assert.Equal(new[] { "open 3.1.0", "open 3.0.9" }, Opened());
        Assert.Contains("did not report itself", log);
        Assert.False(Directory.Exists(Work));
        Assert.False(File.Exists(Zip));
    }

    [Fact]
    public void A_new_version_that_dies_after_reporting_is_replaced_by_the_previous_one()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS()) return;
        var log = Run("dies");

        Assert.Equal("3.0.9", File.ReadAllText(Path.Combine(Old, "Contents", "version")));
        Assert.Equal(new[] { "open 3.1.0", "open 3.0.9" }, Opened());
        Assert.Contains("stopped within 1 s", log);
        Assert.False(File.Exists(Zip));
    }

    public void Dispose()
    {
        foreach (var pid in _started)
        {
            try { Process.GetProcessById(pid).Kill(); } catch { }
        }
        try { Directory.Delete(_root, recursive: true); } catch { }
    }
}

public class MacUpdateFilesTests
{
    [Fact]
    public void Stale_downloads_unpack_folders_and_scripts_go_but_not_the_zip_being_installed()
    {
        var dir = Path.Combine(Path.GetTempPath(), "rxv-mac-cache-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            var keep = Path.Combine(dir, "rxvision-3.1.0.zip");
            File.WriteAllText(keep, "new");
            File.WriteAllText(Path.Combine(dir, "rxvision-3.0.9.zip"), "old");
            File.WriteAllText(Path.Combine(dir, "rxvision-update-1.sh"), "#!/bin/bash");
            Directory.CreateDirectory(Path.Combine(dir, "update-abc", "RX Vision.app"));
            Directory.CreateDirectory(Path.Combine(dir, "update-def"));
            File.WriteAllText(Path.Combine(dir, "other.txt"), "kept");

            MacUpdateFiles.DeleteStaleDownloads(dir, keep);

            Assert.Equal(new[] { "other.txt", "rxvision-3.1.0.zip" },
                Directory.EnumerateFileSystemEntries(dir).Select(p => Path.GetFileName(p) ?? "").OrderBy(n => n, StringComparer.Ordinal).ToArray());
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}

public class CleanVersionTests
{
    [Theory]
    [InlineData("v3.0.0", "3.0.0")]
    [InlineData("3.0.0", "3.0.0")]
    [InlineData("3.0.0-beta.1", "3.0.0")]
    [InlineData("3.0.0+build7", "3.0.0")]
    [InlineData("  V2.9.1  ", "2.9.1")]
    public void CleanVersion_normalises(string input, string expected)
        => Assert.Equal(expected, VersionText.Clean(input));
}
