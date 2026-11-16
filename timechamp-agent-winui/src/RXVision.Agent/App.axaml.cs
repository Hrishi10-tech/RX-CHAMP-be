using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using RXVision.Agent.Services;

namespace RXVision.Agent;

public partial class App : Application
{
    /// <summary>Set by Program before the app starts. Null in tests: then only the styles load.</summary>
    public static StartupContext? Startup { get; set; }

    private AppController? _controller;

    public override void Initialize() => AvaloniaXamlLoader.Load(this);

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop && Startup is { } startup)
        {
            // A tray agent: closing windows never ends it; Quit (or an update) does.
            desktop.ShutdownMode = ShutdownMode.OnExplicitShutdown;
            _controller = new AppController(desktop, startup);
            desktop.Exit += (_, _) => _controller.Dispose();
            _controller.Start();
        }
        base.OnFrameworkInitializationCompleted();
    }
}
