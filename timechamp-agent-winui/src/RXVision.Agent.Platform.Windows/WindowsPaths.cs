using RXVision.Agent.Core.Platform;

namespace RXVision.Agent.Platform.Windows;

/// <summary>
/// Where the Windows agent keeps its files: all under %LOCALAPPDATA%\RXVision,
/// beside the app folder the installer manages (it only ever touches app,
/// app.new and app.previous). Nothing roams: the device id, the session and the
/// activity queue belong to this machine, and a roaming profile must not carry
/// them to another PC (two PCs would then share one device id and one refresh
/// token). Every directory exists after construction (best effort, so a
/// read-only spot never stops the agent starting).
/// </summary>
internal sealed class WindowsPaths : IPaths
{
    public WindowsPaths()
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        DataDir = Path.Combine(localAppData, "RXVision", "data");
        LogDir = Path.Combine(localAppData, "RXVision", "logs");
        TempDir = Path.Combine(localAppData, "RXVision", "tmp");
        AppDir = AppContext.BaseDirectory;

        foreach (var dir in new[] { DataDir, LogDir, TempDir })
        {
            try { Directory.CreateDirectory(dir); } catch { /* best effort */ }
        }
    }

    public string DataDir { get; }
    public string LogDir { get; }
    public string AppDir { get; }
    public string TempDir { get; }
}
