using System.Reflection;
using RXVision.Installer;

// RX Vision Installer v3. Installs the agent side by side under
// %LOCALAPPDATA%\RXVision\app, switches to it, keeps the previous build to roll
// back to, migrates the 2.x install, and never leaves the machine without an agent.
//
//   --update     silent: no message boxes, relaunch the agent minimised
//   --minimized  launch the agent minimised

var update = args.Any(a => string.Equals(a, "--update", StringComparison.OrdinalIgnoreCase));
var minimized = args.Any(a => string.Equals(a, "--minimized", StringComparison.OrdinalIgnoreCase));

var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
var paths = new InstallPaths(
    InstallRoot: Path.Combine(localAppData, "RXVision"),
    LegacyInstallDir: Path.Combine(localAppData, "RXChampAgent"));
var logFile = Path.Combine(paths.InstallRoot, "logs", "installer.log");

var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "4.0.0";
var log = new FileInstallLog(logFile);
// An agent that launched this installer for an update is already on its way out:
// give it a moment to finish cleanly before it is stopped.
var procs = new ProcessControl(update ? TimeSpan.FromSeconds(10) : TimeSpan.Zero);

// One installer at a time per session: a second copy (double-clicked twice, or a
// manual install racing an automatic update) waits for the first to finish instead
// of racing it through the same folders and stopping the agent it just started.
using var gate = new Mutex(initiallyOwned: false, @"Local\RXVision.Installer");
bool owned;
try { owned = gate.WaitOne(TimeSpan.FromMinutes(3)); }
catch (AbandonedMutexException) { owned = true; } // the previous holder died; the lock is ours
if (!owned)
{
    log.Line("another installer is still running after 3 minutes; giving up");
    if (update)
    {
        // The agent that launched this update has exited: do not leave the machine without one.
        var exe = Path.Combine(paths.AppDir, InstallerCore.AgentExeName);
        if (File.Exists(exe)) procs.Start(exe, "--minimized", paths.AppDir);
    }
    else
    {
        new Win32MessageBox().Error("Another RX Vision installation is still running. Try again in a few minutes.");
    }
    return 1;
}

// Errors are shown once the lock is released, so a box left open on screen never
// holds up the next installer (an automatic update waits for this one).
var box = new DeferredMessageBox();
int exitCode;
try
{
    var options = new InstallOptions
    {
        Update = update,
        Minimized = minimized,
        EnrollTrailerJson = Trailer.ReadFromFile(Environment.ProcessPath),
        ConfirmDelay = TimeSpan.FromSeconds(15),
        Version = version,
    };

    var core = new InstallerCore(
        paths,
        options,
        payload: new EmbeddedPayload(),
        procs: procs,
        runKey: new RunKeyStore(),
        log: log,
        messageBox: box,
        waiter: new ThreadWaiter());

    exitCode = core.Run().Success ? 0 : 1;
}
finally
{
    gate.ReleaseMutex();
}
box.ShowPending();
return exitCode;
