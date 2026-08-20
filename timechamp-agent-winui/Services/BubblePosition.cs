using System.IO;
using System.Text.Json;

namespace TimeChampAgent.Services;

/// <summary>
/// Remembers where the user dragged the floating button to, so it comes back to the
/// same place next launch. Plain JSON, not DPAPI — a screen coordinate is not a
/// secret, and losing the file just means the button returns to its default corner.
/// </summary>
public static class BubblePosition
{
    public sealed class Saved
    {
        public int X { get; set; }
        public int Y { get; set; }
    }

    private static string Dir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TimeChampAgent");

    private static string FilePath => Path.Combine(Dir, "bubble.json");

    public static Saved? Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return null;
            return JsonSerializer.Deserialize<Saved>(File.ReadAllText(FilePath));
        }
        catch
        {
            return null;
        }
    }

    public static void Save(int x, int y)
    {
        try
        {
            Directory.CreateDirectory(Dir);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(new Saved { X = x, Y = y }));
        }
        catch
        {
            // Non-fatal: the button just returns to its default position next time.
        }
    }
}
