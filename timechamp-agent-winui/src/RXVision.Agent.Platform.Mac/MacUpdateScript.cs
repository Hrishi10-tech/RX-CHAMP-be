namespace RXVision.Agent.Platform.Mac;

/// <summary>
/// Builds the detached shell script that swaps the app bundle after the agent
/// exits. Pure and unit-tested. It waits for the old process to go (killing it if
/// it is still there after 5 minutes, so its bundle is never moved from under it),
/// moves the old bundle aside, moves the new one into its place and relaunches.
/// The backup is kept until the new build has reported itself (its version and
/// process id, in <c>running-version.txt</c>) and stayed up for 20 seconds; a build
/// that never reports, reports another version, or dies within that time is stopped
/// and the previous bundle is put back and relaunched. Every failure path relaunches
/// whichever version is in place, so the agent never stays down. The downloaded zip
/// and the folder it was unpacked into are removed at the end, whatever happened.
/// Paths are single-quoted so spaces ("RX Vision.app") are safe.
/// </summary>
internal static class MacUpdateScript
{
    /// <summary>How long the new build must stay up before the backup is deleted.</summary>
    internal const int HealthySeconds = 20;
    /// <summary>How long the new build has to report itself after it is opened.</summary>
    internal const int ReportWithinSeconds = 60;

    /// <summary>POSIX single-quote: wrap in ' ', and close/escape/reopen any embedded '.</summary>
    internal static string Quote(string value) => "'" + value.Replace("'", "'\\''") + "'";

    /// <param name="pid">The running agent, which exits for the swap.</param>
    /// <param name="oldBundle">The installed bundle (.../RX Vision.app).</param>
    /// <param name="newBundle">The verified new bundle, unpacked in <paramref name="workDir"/>.</param>
    /// <param name="logPath">Where the script writes what it did.</param>
    /// <param name="version">The new build's version ("3.1.0"), also the backup's suffix.</param>
    /// <param name="startedFile">The file a starting agent writes its version and process id to.</param>
    /// <param name="workDir">The update-&lt;guid&gt; folder the zip was unpacked into (removed at the end).</param>
    /// <param name="zipPath">The verified download (removed at the end).</param>
    /// <param name="healthySeconds">Tests only: how long the new build must stay up.</param>
    /// <param name="reportWithinSeconds">Tests only: how long the new build has to report itself.</param>
    /// <param name="open">Tests only: the command that launches a bundle.</param>
    /// <param name="pkill">Tests only: the command that stops whatever runs from a bundle.</param>
    internal static string Build(int pid, string oldBundle, string newBundle, string logPath, string version,
        string startedFile, string workDir, string zipPath,
        int healthySeconds = HealthySeconds, int reportWithinSeconds = ReportWithinSeconds,
        string open = "/usr/bin/open", string pkill = "/usr/bin/pkill")
    {
        return
            "#!/bin/bash\n" +
            "set -u\n" +
            $"OLD={Quote(oldBundle)}\n" +
            $"NEW={Quote(newBundle)}\n" +
            $"BACKUP={Quote(oldBundle + ".old-" + version)}\n" +
            $"LOG={Quote(logPath)}\n" +
            $"STARTED={Quote(startedFile)}\n" +
            $"WORK={Quote(workDir)}\n" +
            $"ZIP={Quote(zipPath)}\n" +
            $"VERSION={Quote(version)}\n" +
            $"PID={pid}\n" +
            "exec >>\"$LOG\" 2>&1\n" +
            "cleanup() { rm -rf \"$WORK\"; rm -f \"$ZIP\"; rm -f \"$0\"; }\n" +
            $"relaunch() {{ {Quote(open)} -a \"$OLD\" --args --minimized; }}\n" +
            "echo \"[rxvision-update] $(date) waiting for pid $PID\"\n" +
            "for i in $(seq 1 600); do kill -0 \"$PID\" 2>/dev/null || break; sleep 0.5; done\n" +
            "if kill -0 \"$PID\" 2>/dev/null; then\n" +
            "  echo \"[rxvision-update] pid $PID still running; stopping it\"\n" +
            "  kill -9 \"$PID\" 2>/dev/null\n" +
            "fi\n" +
            "sleep 1\n" +
            "rm -rf \"$BACKUP\"\n" +
            "if [ -d \"$OLD\" ]; then\n" +
            "  mv \"$OLD\" \"$BACKUP\" || { echo \"[rxvision-update] could not move old bundle aside\"; relaunch; cleanup; exit 1; }\n" +
            "fi\n" +
            "if ! mv \"$NEW\" \"$OLD\"; then\n" +
            "  echo \"[rxvision-update] install move failed; restoring previous version\"\n" +
            "  rm -rf \"$OLD\"\n" +
            "  mv \"$BACKUP\" \"$OLD\"\n" +
            "  relaunch\n" +
            "  cleanup\n" +
            "  exit 1\n" +
            "fi\n" +
            "echo \"[rxvision-update] installed $VERSION; relaunching\"\n" +
            "rm -f \"$STARTED\"\n" +
            "relaunch\n" +
            // The new build reports itself: line 1 its version, line 2 its process id.
            "NEWPID=\"\"\n" +
            $"for i in $(seq 1 {reportWithinSeconds * 2}); do\n" +
            "  if [ -f \"$STARTED\" ] && [ \"$(sed -n 1p \"$STARTED\")\" = \"$VERSION\" ]; then\n" +
            "    NEWPID=\"$(sed -n 2p \"$STARTED\")\"\n" +
            "    break\n" +
            "  fi\n" +
            "  sleep 0.5\n" +
            "done\n" +
            "HEALTHY=0\n" +
            "case \"$NEWPID\" in\n" +
            "  ''|*[!0-9]*) echo \"[rxvision-update] the new version did not report itself\" ;;\n" +
            "  *)\n" +
            $"    sleep {healthySeconds}\n" +
            "    if kill -0 \"$NEWPID\" 2>/dev/null; then HEALTHY=1; else echo \"[rxvision-update] the new version stopped within " + healthySeconds + " s\"; fi\n" +
            "    ;;\n" +
            "esac\n" +
            "if [ \"$HEALTHY\" = 1 ]; then\n" +
            "  rm -rf \"$BACKUP\"\n" +
            "  echo \"[rxvision-update] done\"\n" +
            "elif [ -d \"$BACKUP\" ]; then\n" +
            "  echo \"[rxvision-update] restoring the previous version\"\n" +
            "  case \"$NEWPID\" in ''|*[!0-9]*) ;; *) kill -9 \"$NEWPID\" 2>/dev/null ;; esac\n" +
            $"  {Quote(pkill)} -9 -f \"$OLD/Contents/MacOS/\" 2>/dev/null\n" +
            "  sleep 1\n" +
            "  rm -rf \"$OLD\"\n" +
            "  mv \"$BACKUP\" \"$OLD\"\n" +
            "  relaunch\n" +
            "fi\n" +
            "cleanup\n";
    }
}

/// <summary>The files an update leaves in the cache folder (pure file work, tested on any OS).</summary>
internal static class MacUpdateFiles
{
    /// <summary>
    /// Every update leaves files in the cache folder unless its script finished: the
    /// verified zip (about 100 MB), the folder it was unpacked into, and the script.
    /// Only those (rxvision-*.zip, update-*, rxvision-update-*.sh) in this folder, never
    /// the zip about to be installed.
    /// </summary>
    internal static void DeleteStaleDownloads(string tempDir, string keep)
    {
        try
        {
            var current = Path.GetFullPath(keep);
            foreach (var zip in Directory.EnumerateFiles(tempDir, "rxvision-*.zip"))
            {
                if (string.Equals(Path.GetFullPath(zip), current, StringComparison.Ordinal)) continue;
                try { File.Delete(zip); } catch { }
            }
            foreach (var script in Directory.EnumerateFiles(tempDir, "rxvision-update-*.sh"))
            {
                try { File.Delete(script); } catch { }
            }
            foreach (var dir in Directory.EnumerateDirectories(tempDir, "update-*"))
            {
                try { Directory.Delete(dir, recursive: true); } catch { }
            }
        }
        catch
        {
            // Best effort: a cache folder that cannot be listed costs disk space, not the update.
        }
    }
}
