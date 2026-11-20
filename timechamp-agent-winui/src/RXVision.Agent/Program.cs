using Avalonia;
using Avalonia.Media;
using Avalonia.Threading;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;

namespace RXVision.Agent;

internal static class Program
{
    private static ILog _log = NullLog.Instance;

    /// <summary>
    /// RX Vision agent. Arguments: --minimized (started at login: no dashboard,
    /// just the tray and the floating button). Environment, for development:
    /// RXV_PLATFORM=dev (fake OS layer, Debug builds only), RXV_API=http://localhost:4000/api/v1.
    /// </summary>
    [STAThread]
    public static int Main(string[] args)
    {
        var minimized = args.Any(a => string.Equals(a, "--minimized", StringComparison.OrdinalIgnoreCase));

        IPlatform platform;
        var deferred = new DeferredLog();
        try
        {
            platform = PlatformFactory.Create(deferred);
        }
        catch (Exception ex)
        {
            FatalNote("could not start the OS layer", ex);
            return 1;
        }

        RollingFileLog? fileLog = null;
        try
        {
            fileLog = new RollingFileLog(platform.Paths.LogDir);
            _log = fileLog;
        }
        catch (Exception ex)
        {
            FatalNote("could not open the log", ex);
        }
        deferred.SetTarget(_log);
        HookCrashHandlers();

        // One agent per person: a second launch asks the first to show its dashboard, then leaves.
        SingleInstance? instance = null;
        try
        {
            instance = SingleInstance.TryAcquire(platform.Paths.DataDir);
            if (instance is null)
            {
                _log.Info("app", "already running; asked it to show itself");
                fileLog?.Dispose();
                return 0;
            }
        }
        catch (Exception ex)
        {
            _log.Warn("app", "single-instance check failed; carrying on without it", ex);
        }

        var options = AgentOptions.Load(platform.Paths.AppDir);
        var api = Environment.GetEnvironmentVariable("RXV_API");
        if (!string.IsNullOrWhiteSpace(api))
        {
            // Same rule as appsettings: https, or http only to this machine (unless the
            // file allows insecure http for development), so a stray variable can't
            // send passwords in clear text.
            var url = AgentOptions.NormaliseUrl(api, options.AllowInsecureHttp);
            if (url is not null) options.ApiBaseUrl = url;
            else _log.Warn("app", "RXV_API is not a usable https address; ignoring it");
        }

        _log.Info("app", $"RX Vision {AgentOptions.AppVersion} starting on {platform.Name} ({Environment.OSVersion}){(minimized ? ", minimized" : "")}; API {options.ApiBaseUrl}");

        var host = new AgentHost(platform, options, _log);
        App.Startup = new StartupContext(platform, options, _log, host, instance, minimized);
        var code = 0;
        try
        {
            code = BuildAvaloniaApp().StartWithClassicDesktopLifetime(args, Avalonia.Controls.ShutdownMode.OnExplicitShutdown);
        }
        catch (Exception ex)
        {
            _log.Error("app", $"the UI stopped with an error: {ex}");
            code = 1;
        }
        finally
        {
            try { host.Shutdown(); } catch { }
            try { host.Dispose(); } catch { }
            instance?.Dispose();
            _log.Info("app", $"exit {code}");
            fileLog?.Dispose();
        }
        // Background sockets and timers must not keep the process (or an update) waiting.
        Environment.Exit(code);
        return code;
    }

    /// <summary>Used by the Avalonia previewer and by Main.</summary>
    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .With(new FontManagerOptions { DefaultFamilyName = "fonts:Inter#Inter" })
            .With(new MacOSPlatformOptions { ShowInDock = false })
            .AfterSetup(_ => Dispatcher.UIThread.UnhandledException += (_, e) =>
            {
                // Nothing the UI does may stop tracking: log it and carry on.
                _log.Error("ui", $"unhandled exception on the UI thread: {e.Exception}");
                e.Handled = true;
            })
            .LogToTrace();

    private static void HookCrashHandlers()
    {
        // Nothing the UI does may stop tracking silently: log it and carry on where possible.
        // Stack traces included: these are the bugs worth finding. (The UI thread's
        // handler is added once Avalonia is set up: touching the dispatcher earlier
        // would create it without the platform's main loop.)
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            _log.Error("app", $"unhandled exception (terminating: {e.IsTerminating}): {e.ExceptionObject}");
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            _log.Warn("app", "unobserved task exception", e.Exception);
            e.SetObserved();
        };
    }

    /// <summary>Before the log exists: a note in the temp folder, so a failed start is never silent.</summary>
    private static void FatalNote(string what, Exception ex)
    {
        try
        {
            var path = Path.Combine(Path.GetTempPath(), "RXVision-startup-error.log");
            File.AppendAllText(path, $"{DateTimeOffset.Now:o} {what}: {ex}{Environment.NewLine}");
        }
        catch
        {
            // Nowhere left to write.
        }
    }
}
