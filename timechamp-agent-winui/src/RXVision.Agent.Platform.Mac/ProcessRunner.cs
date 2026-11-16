using System.Diagnostics;

namespace RXVision.Agent.Platform.Mac;

internal readonly record struct RunResult(int ExitCode, string StdOut, string StdErr, bool TimedOut)
{
    internal bool Ok => !TimedOut && ExitCode == 0;
}

/// <summary>
/// Runs a macOS helper binary (osascript, screencapture, open, afplay, ditto,
/// xattr, launchctl, plutil) with a hard timeout, killing the whole process tree
/// if it overruns. Also a fire-and-forget launcher for things we never wait on
/// (the chime, the update swap script). Never throws: failures come back as a
/// non-zero/timed-out result.
/// </summary>
internal static class ProcessRunner
{
    internal static RunResult Run(string fileName, IReadOnlyList<string> args, TimeSpan timeout)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);

            using var p = new Process { StartInfo = psi };
            if (!p.Start()) return new RunResult(-1, "", "failed to start", false);

            // Read both streams concurrently so a full pipe buffer cannot deadlock us.
            var outTask = p.StandardOutput.ReadToEndAsync();
            var errTask = p.StandardError.ReadToEndAsync();

            if (!p.WaitForExit((int)Math.Clamp(timeout.TotalMilliseconds, 0, int.MaxValue)))
            {
                try { p.Kill(entireProcessTree: true); } catch { }
                try { p.WaitForExit(2000); } catch { }
                return new RunResult(-1, Safe(outTask), Safe(errTask), true);
            }
            // The process has exited; WaitForExit() with no timeout flushes the streams.
            try { p.WaitForExit(); } catch { }
            return new RunResult(p.ExitCode, Safe(outTask), Safe(errTask), false);
        }
        catch (Exception ex)
        {
            return new RunResult(-1, "", ex.Message, false);
        }
    }

    /// <summary>Starts a process and returns immediately; the child outlives this call.</summary>
    internal static bool Launch(string fileName, IReadOnlyList<string> args, string? stdoutLog = null)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = stdoutLog is not null,
                RedirectStandardError = stdoutLog is not null,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            var p = Process.Start(psi);
            return p is not null;
        }
        catch
        {
            return false;
        }
    }

    private static string Safe(Task<string> t)
    {
        try { return t.GetAwaiter().GetResult() ?? ""; } catch { return ""; }
    }
}
