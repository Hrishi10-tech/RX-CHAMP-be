using RXVision.Agent.Core.Platform;

namespace RXVision.Agent.Platform.Mac;

/// <summary>macOS locations under ~/Library, following Apple's layout.</summary>
internal sealed class MacPaths : IPaths
{
    public MacPaths()
    {
        var home = Environment.GetEnvironmentVariable("HOME");
        if (string.IsNullOrWhiteSpace(home))
            home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrWhiteSpace(home))
            home = Path.GetTempPath();

        var library = Path.Combine(home, "Library");
        DataDir = Path.Combine(library, "Application Support", "RXVision");
        LogDir = Path.Combine(library, "Logs", "RXVision");
        TempDir = Path.Combine(library, "Caches", "RXVision");
        AppDir = AppContext.BaseDirectory;

        foreach (var d in new[] { DataDir, LogDir, TempDir })
        {
            try { Directory.CreateDirectory(d); } catch { /* never throw out of construction */ }
        }
    }

    public string DataDir { get; }
    public string LogDir { get; }
    public string AppDir { get; }
    public string TempDir { get; }
}
