using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Media;
using Avalonia.Threading;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Platform.Dev;

[assembly: AvaloniaTestApplication(typeof(RXVision.Agent.UI.Tests.TestApp))]

namespace RXVision.Agent.UI.Tests;

/// <summary>The real App (styles, templates, Inter) on the headless platform, drawn with Skia.</summary>
public static class TestApp
{
    public static AppBuilder BuildAvaloniaApp() =>
        AppBuilder.Configure<App>()
            .UseSkia()
            .UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false })
            .WithInterFont()
            .With(new FontManagerOptions { DefaultFamilyName = "fonts:Inter#Inter" });
}

/// <summary>Saves what a window drew, for a person to look at.</summary>
public static class Shots
{
    /// <summary>RXV_SHOTS, else TestResults/shots beside the test run.</summary>
    public static string Dir =>
        Environment.GetEnvironmentVariable("RXV_SHOTS") is { Length: > 0 } dir
            ? dir
            : Path.Combine(AppContext.BaseDirectory, "TestResults", "shots");

    public static string Save(TopLevel top, string name)
    {
        for (var i = 0; i < 3; i++)
        {
            Dispatcher.UIThread.RunJobs();
            AvaloniaHeadlessPlatform.ForceRenderTimerTick();
        }
        var frame = top.CaptureRenderedFrame() ?? throw new InvalidOperationException("nothing rendered");
        Directory.CreateDirectory(Dir);
        var path = Path.Combine(Dir, name + ".png");
        frame.Save(path);
        return path;
    }
}

/// <summary>The dev platform, but macOS-like: screen recording not allowed yet.</summary>
public sealed class NoScreenRecordingPlatform : IPlatform, IPermissions
{
    private readonly DevPlatform _dev;
    public NoScreenRecordingPlatform(DevPlatform dev) => _dev = dev;
    public string Name => "mac";
    public string UpdateChannel => "mac";
    public IPaths Paths => _dev.Paths;
    public IIdleProbe Idle => _dev.Idle;
    public ILockProbe Lock => _dev.Lock;
    public ISleepClock SleepClock => _dev.SleepClock;
    public IForegroundProbe Foreground => _dev.Foreground;
    public ICallWindowProbe CallWindows => _dev.CallWindows;
    public IScreenCapture Screen => _dev.Screen;
    public ISecretStore Secrets => _dev.Secrets;
    public IAutostart Autostart => _dev.Autostart;
    public IPermissions Permissions => this;
    public IScreenInfo ScreenInfo => _dev.ScreenInfo;
    public IUpdateInstaller Updater => _dev.Updater;
    public IShell Shell => _dev.Shell;
    public ILegacyMigration Legacy => _dev.Legacy;

    public PermissionState ScreenRecording { get; set; } = PermissionState.NotDetermined;
    public PermissionState Accessibility => PermissionState.Granted;
    public int Requests { get; private set; }
    public int SettingsOpened { get; private set; }
    public int Renewals { get; private set; }
    public void RequestScreenRecording() => Requests++;
    public void OpenScreenRecordingSettings() => SettingsOpened++;
    public void RenewScreenRecording() => Renewals++;
    public void OpenAccessibilitySettings() { }
}
