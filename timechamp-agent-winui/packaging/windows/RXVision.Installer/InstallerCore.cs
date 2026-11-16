namespace RXVision.Installer;

// The install logic, kept free of any Windows-only API (System.IO only, plus the
// small interfaces below) so the swap and rollback paths can be unit tested on
// Linux with temp directories. Program.cs wires the real Windows implementations.

/// <summary>Stops and starts agent processes.</summary>
public interface IProcessControl
{
    /// <summary>Stops every running process with one of these names and waits for it to exit.</summary>
    void StopAgents(IEnumerable<string> processNames);

    /// <summary>Starts an exe. Returns a handle to check on it, or null when it did not start.</summary>
    IAgentProcess? Start(string exePath, string? arguments, string workingDir);
}

public interface IAgentProcess
{
    bool IsRunning { get; }
}

/// <summary>The HKCU Run values the installer sets, deletes and reads.</summary>
public interface IRunKeyStore
{
    void Set(string name, string value);
    void Delete(string name);
    string? Get(string name);
}

/// <summary>The embedded payload (the published Avalonia app, RXVision.exe at the zip root).</summary>
public interface IPayloadSource
{
    /// <summary>SHA-256 of the payload bytes, used as the build stamp (review #9).</summary>
    string Sha256();
    /// <summary>Extracts the payload into <paramref name="destDir"/>. Throws on failure.</summary>
    void ExtractTo(string destDir);
}

public interface IInstallLog
{
    void Line(string message);
}

/// <summary>Shows the user an error. A no-op for a silent update.</summary>
public interface IMessageBox
{
    void Error(string message);
}

/// <summary>A sleep, injected so tests do not actually wait.</summary>
public interface IWaiter
{
    void Wait(TimeSpan duration);
}

public sealed record InstallPaths(string InstallRoot, string LegacyInstallDir)
{
    public string AppDir => Path.Combine(InstallRoot, "app");
    public string AppNewDir => Path.Combine(InstallRoot, "app.new");
    public string AppPreviousDir => Path.Combine(InstallRoot, "app.previous");
    /// <summary>The agent's own data folder (%LOCALAPPDATA%\RXVision\data).</summary>
    public string DataDir => Path.Combine(InstallRoot, "data");
}

public sealed record InstallOptions
{
    public bool Update { get; init; }
    public bool Minimized { get; init; }
    public byte[]? EnrollTrailerJson { get; init; }
    public TimeSpan ConfirmDelay { get; init; } = TimeSpan.FromSeconds(15);
    public string Version { get; init; } = "";
}

public sealed record InstallResult(bool Success, bool RolledBack, string? Error);

/// <summary>
/// Installs RX Vision Agent 3.x side by side and switches to it atomically, keeping
/// the previous build to roll back to. The machine is never left without a working
/// agent: a new build that fails to start is rolled back to the previous v3 install,
/// or failing that to the 2.x agent.
/// </summary>
public sealed class InstallerCore
{
    public const string AgentExeName = "RXVision.exe";
    public const string LegacyAgentExeName = "TimeChampAgent.exe";
    public const string AgentProcessName = "RXVision";
    public const string LegacyProcessName = "TimeChampAgent";
    public const string RunValueName = "RXVision";
    public const string LegacyRunValueName = "TimeChampAgent";
    public const string EnrollFileName = "tc-enroll.json";
    /// <summary>The 2.x enrollment carried beside the app: the agent reads it only without an enrollment of its own, once.</summary>
    public const string LegacyEnrollFileName = "tc-enroll.legacy.json";
    /// <summary>In the install root: the 2.x enrollment was carried across once and never is again.</summary>
    public const string LegacyCarriedMarker = ".legacy-enrollment-carried";
    /// <summary>In the agent's data folder: the agent has done its one 2.x enrollment step.</summary>
    public const string AgentLegacyDoneMarker = "legacy-enrollment.done";
    private const string StampFileName = ".build-stamp";

    // Folder moves and deletes are retried: on Windows an antivirus scan or the search
    // indexer often holds a freshly written file for a moment, which fails the rename.
    private const int FsAttempts = 10;
    private static readonly TimeSpan FsRetryDelay = TimeSpan.FromMilliseconds(500);

    private readonly InstallPaths _paths;
    private readonly InstallOptions _opts;
    private readonly IPayloadSource _payload;
    private readonly IProcessControl _procs;
    private readonly IRunKeyStore _runKey;
    private readonly IInstallLog _log;
    private readonly IMessageBox _messageBox;
    private readonly IWaiter _waiter;

    public InstallerCore(InstallPaths paths, InstallOptions opts, IPayloadSource payload,
        IProcessControl procs, IRunKeyStore runKey, IInstallLog log, IMessageBox messageBox, IWaiter waiter)
    {
        _paths = paths;
        _opts = opts;
        _payload = payload;
        _procs = procs;
        _runKey = runKey;
        _log = log;
        _messageBox = messageBox;
        _waiter = waiter;
    }

    public InstallResult Run()
    {
        _log.Line($"RX Vision Installer {_opts.Version} starting (update={_opts.Update}, minimized={_opts.Minimized})");

        // Read the payload before touching anything: an installer without a usable
        // payload must leave the running agent alone, not stop it and then fail.
        string payloadSha;
        try
        {
            payloadSha = _payload.Sha256();
        }
        catch (Exception ex)
        {
            _log.Line($"payload unreadable; nothing was changed: {ex.GetType().Name}: {ex.Message}");
            const string damaged = "This installer is damaged. Download it again.";
            MaybeError(damaged);
            return new InstallResult(false, false, damaged);
        }

        var swapped = false;
        try
        {
            Directory.CreateDirectory(_paths.InstallRoot);

            // Stop any running agent (v3 and 2.x) so files are free and the relaunch is clean.
            _procs.StopAgents(new[] { AgentProcessName, LegacyProcessName });

            var identical = File.Exists(Path.Combine(_paths.AppDir, AgentExeName)) &&
                            ReadStamp(_paths.AppDir) == payloadSha;

            if (identical)
            {
                _log.Line("payload is identical to the installed build; skipping extraction");
            }
            else if (TryExtractAndSwap(payloadSha))
            {
                swapped = true;
            }
            else
            {
                // Extraction, verification or the swap failed and app\ is as it was:
                // the existing install (if any) is untouched. Relaunch it.
                return RollBack("The agent files could not be installed.", appFailed: false);
            }

            WriteEnrollment();

            var agentExe = Path.Combine(_paths.AppDir, AgentExeName);
            _runKey.Set(RunValueName, $"\"{agentExe}\" --minimized");

            var handle = LaunchAgent(agentExe);
            if (handle is not null)
            {
                _waiter.Wait(_opts.ConfirmDelay);
                if (handle.IsRunning)
                {
                    _log.Line("agent is running; finishing up");
                    _runKey.Delete(LegacyRunValueName);
                    BestEffortDeleteLegacyInstall();
                    return new InstallResult(true, false, null);
                }
                _log.Line("agent exited within the confirmation window; rolling back");
            }
            else
            {
                _log.Line("agent did not start; rolling back");
            }

            // app\ holds a build that just failed to stay up: the new one after a swap,
            // or the identical one that was reinstalled.
            return RollBack("The new RX Vision agent did not start.", appFailed: true);
        }
        catch (Exception ex)
        {
            _log.Line($"unexpected failure: {ex.GetType().Name}: {ex.Message}");
            return RollBack("The RX Vision agent could not be installed.", appFailed: swapped);
        }
    }

    /// <summary>Extracts to app.new, verifies it, then swaps app -> app.previous and
    /// app.new -> app. Returns false when extraction, verification or the swap failed
    /// and app\ is as it was (nothing swapped); throws only when the swap failed midway
    /// and the installed build could not be put back either.</summary>
    private bool TryExtractAndSwap(string payloadSha)
    {
        SafeDeleteDir(_paths.AppNewDir);
        try
        {
            _payload.ExtractTo(_paths.AppNewDir);
        }
        catch (Exception ex)
        {
            // Disk full, a file held by antivirus, or an entry that would land outside
            // app.new (ZipArchive refuses those): nothing has been swapped yet.
            _log.Line($"extraction failed: {ex.GetType().Name}: {ex.Message}");
            SafeDeleteDir(_paths.AppNewDir);
            return false;
        }
        if (!File.Exists(Path.Combine(_paths.AppNewDir, AgentExeName)))
        {
            _log.Line("payload did not contain RXVision.exe");
            SafeDeleteDir(_paths.AppNewDir);
            return false;
        }
        WriteStamp(_paths.AppNewDir, payloadSha);

        SafeDeleteDir(_paths.AppPreviousDir);
        var hadApp = Directory.Exists(_paths.AppDir);
        if (hadApp)
        {
            try
            {
                MoveDir(_paths.AppDir, _paths.AppPreviousDir);
            }
            catch (Exception ex)
            {
                // Still in use (an agent that would not stop) or locked: app\ is untouched.
                _log.Line($"could not move the installed build aside: {ex.Message}");
                SafeDeleteDir(_paths.AppNewDir);
                return false;
            }
        }
        try
        {
            MoveDir(_paths.AppNewDir, _paths.AppDir);
        }
        catch (Exception ex)
        {
            _log.Line($"could not move the new build into place: {ex.Message}");
            // Put the installed build back so app\ is as it was. If that fails too, the
            // exception reaches Run, whose rollback restores app.previous.
            if (hadApp) MoveDir(_paths.AppPreviousDir, _paths.AppDir);
            SafeDeleteDir(_paths.AppNewDir);
            return false;
        }
        _log.Line("installed the new build into app\\");
        return true;
    }

    private void WriteEnrollment()
    {
        var dest = Path.Combine(_paths.AppDir, EnrollFileName);
        try
        {
            if (_opts.EnrollTrailerJson is { Length: > 0 } json)
            {
                File.WriteAllBytes(dest, json);
                _log.Line("wrote enrollment from the installer trailer");
                return;
            }
            CarryLegacyEnrollmentOnce();
        }
        catch (Exception ex)
        {
            _log.Line($"enrollment write failed (agent falls back to sign-in): {ex.Message}");
        }
    }

    /// <summary>
    /// No trailer (an auto-update, or a generic build): an upgrade from 2.9.1 keeps the
    /// person enrolled by carrying the 2.x enrollment across, once. It goes beside the
    /// app under its own name, which the agent reads only when it has no enrollment of
    /// its own and only once, so it can never override a newer enrollment (a per-user
    /// download, a setup code) or sign someone back in after they signed out. Never
    /// copied again: not after the first time, and not once the agent has done its own
    /// 2.x step.
    /// </summary>
    private void CarryLegacyEnrollmentOnce()
    {
        var marker = Path.Combine(_paths.InstallRoot, LegacyCarriedMarker);
        if (File.Exists(marker) || File.Exists(Path.Combine(_paths.DataDir, AgentLegacyDoneMarker))) return;
        var legacyEnroll = Path.Combine(_paths.LegacyInstallDir, EnrollFileName);
        if (!File.Exists(legacyEnroll)) return;
        File.Copy(legacyEnroll, Path.Combine(_paths.AppDir, LegacyEnrollFileName), overwrite: true);
        File.WriteAllText(marker, DateTime.UtcNow.ToString("o"));
        _log.Line("carried the 2.x enrollment across (once)");
    }

    /// <param name="appFailed">True when app\ holds a build that just failed (the new one,
    /// or an identical reinstall); false when app\ still holds the build that was running
    /// before this run, untouched.</param>
    private InstallResult RollBack(string userMessage, bool appFailed)
    {
        var existing = Path.Combine(_paths.AppDir, AgentExeName);

        // 1. When app\ holds a build that just failed (or nothing usable), the previous
        //    v3 build is the best thing to return to. Never when app\ is the untouched
        //    current build: that would delete it and downgrade.
        if ((appFailed || !File.Exists(existing)) && File.Exists(Path.Combine(_paths.AppPreviousDir, AgentExeName)))
        {
            try
            {
                SafeDeleteDir(_paths.AppDir);
                MoveDir(_paths.AppPreviousDir, _paths.AppDir);
                WriteEnrollment(); // a per-user download still enrolls the person
                var exe = Path.Combine(_paths.AppDir, AgentExeName);
                _runKey.Set(RunValueName, $"\"{exe}\" --minimized");
                LaunchAgent(exe);
                _log.Line("rolled back to the previous v3 build");
                MaybeError(userMessage + " The previous version has been restored.");
                return new InstallResult(false, true, userMessage);
            }
            catch (Exception ex)
            {
                _log.Line($"rollback to previous build failed: {ex.Message}");
            }
        }

        // 2. If app\ still holds the pre-existing build, relaunch it. (When it holds the
        //    build that just failed, relaunching it would be pointless and is skipped.)
        if (!appFailed && File.Exists(existing))
        {
            WriteEnrollment();
            _runKey.Set(RunValueName, $"\"{existing}\" --minimized");
            if (LaunchAgent(existing) is not null)
            {
                _log.Line("relaunched the existing build");
                MaybeError(userMessage);
                return new InstallResult(false, true, userMessage);
            }
        }

        // 3. Fall back to the 2.x agent so the machine is never left without one.
        var legacyExe = Path.Combine(_paths.LegacyInstallDir, LegacyAgentExeName);
        if (File.Exists(legacyExe))
        {
            _runKey.Delete(RunValueName);
            _runKey.Set(LegacyRunValueName, $"\"{legacyExe}\" --minimized");
            _procs.Start(legacyExe, _opts.Update || _opts.Minimized ? "--minimized" : null, _paths.LegacyInstallDir);
            _log.Line("rolled back to the 2.x agent");
            MaybeError(userMessage + " The previous RX Vision agent has been restored.");
            return new InstallResult(false, true, userMessage);
        }

        _log.Line("no agent could be started");
        MaybeError(userMessage);
        return new InstallResult(false, false, userMessage);
    }

    private IAgentProcess? LaunchAgent(string exe)
    {
        var minimized = _opts.Update || _opts.Minimized;
        return _procs.Start(exe, minimized ? "--minimized" : null, _paths.AppDir);
    }

    private void BestEffortDeleteLegacyInstall()
    {
        try
        {
            if (Directory.Exists(_paths.LegacyInstallDir))
            {
                Directory.Delete(_paths.LegacyInstallDir, recursive: true);
                _log.Line("removed the 2.x install folder");
            }
        }
        catch (Exception ex)
        {
            // Files may be locked; leaving the old folder is harmless.
            _log.Line($"left the 2.x install folder in place: {ex.Message}");
        }
    }

    private void MaybeError(string message)
    {
        if (!_opts.Update) _messageBox.Error(message);
    }

    private static string? ReadStamp(string appDir)
    {
        try
        {
            var path = Path.Combine(appDir, StampFileName);
            return File.Exists(path) ? File.ReadAllText(path).Trim() : null;
        }
        catch
        {
            return null;
        }
    }

    private void WriteStamp(string appDir, string sha)
    {
        try { File.WriteAllText(Path.Combine(appDir, StampFileName), sha); }
        catch (Exception ex) { _log.Line($"could not write build stamp: {ex.Message}"); }
    }

    private void SafeDeleteDir(string dir)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
                return;
            }
            catch (Exception ex)
            {
                if (attempt >= FsAttempts || ex is not (IOException or UnauthorizedAccessException))
                {
                    _log.Line($"could not delete {Path.GetFileName(dir)}: {ex.Message}");
                    return;
                }
                _waiter.Wait(FsRetryDelay);
            }
        }
    }

    /// <summary>Directory.Move, retried for a few seconds while something holds a file
    /// inside (see <see cref="FsAttempts"/>). Throws the last error when it never succeeds.</summary>
    private void MoveDir(string from, string to)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                Directory.Move(from, to);
                return;
            }
            catch (Exception ex) when (attempt < FsAttempts && ex is (IOException or UnauthorizedAccessException))
            {
                _log.Line($"moving {Path.GetFileName(from)} to {Path.GetFileName(to)} failed ({ex.Message}); retrying");
                _waiter.Wait(FsRetryDelay);
            }
        }
    }
}
