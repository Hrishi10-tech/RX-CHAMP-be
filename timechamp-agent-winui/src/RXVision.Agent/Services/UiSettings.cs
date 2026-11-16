using System.Text;
using System.Text.Json;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Services;

/// <summary>Where the dashboard was and how big, in physical pixels and DIPs.</summary>
public sealed class WindowPlacement
{
    public int X { get; set; }
    public int Y { get; set; }
    public double Width { get; set; }
    public double Height { get; set; }
    public bool Maximized { get; set; }
}

/// <summary>Where the floating button's face centre sits on one screen, in physical pixels.</summary>
public sealed class BubbleSpot
{
    public int X { get; set; }
    public int Y { get; set; }
}

/// <summary>
/// Per-person UI conveniences: window placement, the button's spot on each
/// screen, the last email used. Plain JSON (nothing here is secret); losing the
/// file only means windows come back to their default places.
/// </summary>
public sealed class UiSettings
{
    public WindowPlacement? Dashboard { get; set; }
    /// <summary>Keyed by screen ("1920x1080@0,0").</summary>
    public Dictionary<string, BubbleSpot> Bubble { get; set; } = new();
    /// <summary>The screen the button was last left on.</summary>
    public string? BubbleScreen { get; set; }
    public string? LastEmail { get; set; }
}

public sealed class UiSettingsStore
{
    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true };
    private readonly string _path;
    private readonly ILog _log;

    public UiSettingsStore(string dataDir, ILog log)
    {
        _path = Path.Combine(dataDir, "ui-settings.json");
        _log = log;
        Current = Load();
    }

    public UiSettings Current { get; }

    private UiSettings Load()
    {
        try
        {
            if (File.Exists(_path))
                return JsonSerializer.Deserialize<UiSettings>(File.ReadAllText(_path), Options) ?? new UiSettings();
        }
        catch (Exception ex)
        {
            _log.Warn("ui", "settings unreadable; using defaults", ex);
        }
        return new UiSettings();
    }

    public void Save()
    {
        try
        {
            AtomicFile.WriteAllBytes(_path, Encoding.UTF8.GetBytes(JsonSerializer.Serialize(Current, Options)));
        }
        catch (Exception ex)
        {
            _log.Warn("ui", "could not save settings", ex);
        }
    }
}
