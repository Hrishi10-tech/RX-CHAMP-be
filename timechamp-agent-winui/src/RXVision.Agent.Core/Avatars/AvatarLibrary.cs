using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RXVision.Agent.Core.Avatars;

/// <summary>One preset avatar: its library (male or female), its set, and its files by pixel size.</summary>
public sealed record AvatarEntry(string Id, string Library, int Set, IReadOnlyDictionary<int, string> Files);

/// <summary>
/// The preset avatars bundled with the app, so they draw with no network. Everything comes
/// from the bundle's manifest: an ID is only ever turned into a file through it, and a path
/// is never built from an ID. Higher-resolution masters under the same names therefore need
/// no code change, only a rebuild. The build writes the bundle (build/avatars).
/// </summary>
public sealed partial class AvatarLibrary
{
    /// <summary>Where the bundle sits, inside the app's folder.</summary>
    public const string BundleFolder = "Assets/avatars";

    private readonly string _directory;
    private readonly Dictionary<string, AvatarEntry> _byId = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _defaults = new(StringComparer.Ordinal);

    private AvatarLibrary(string directory) => _directory = directory;

    /// <summary>The library beside the running app; read once.</summary>
    public static AvatarLibrary Bundled => LazyBundled.Value;

    private static readonly Lazy<AvatarLibrary> LazyBundled = new(() =>
        Load(Path.Combine(AppContext.BaseDirectory, BundleFolder)));

    /// <summary>Why nothing could be read from the manifest, or null. With it set the library is empty and everyone shows the RX mark.</summary>
    public string? LoadError { get; private set; }

    public IReadOnlyList<AvatarEntry> Entries { get; private set; } = Array.Empty<AvatarEntry>();

    /// <summary>Reads a bundle's manifest. Never throws: a broken bundle is an empty library.</summary>
    public static AvatarLibrary Load(string directory)
    {
        var library = new AvatarLibrary(directory);
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(directory, "manifest.json")));
            library.Read(doc.RootElement);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            library.LoadError = $"{ex.GetType().Name}: {ex.Message}";
        }
        return library;
    }

    [GeneratedRegex("^[A-Za-z0-9_-]{1,32}$")]
    private static partial Regex IdShape();

    private void Read(JsonElement root)
    {
        var entries = new List<AvatarEntry>();
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("avatars", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in list.EnumerateArray())
            {
                var entry = ReadEntry(item);
                if (entry is null || _byId.ContainsKey(entry.Id)) continue;
                _byId[entry.Id] = entry;
                entries.Add(entry);
            }
        }
        Entries = entries;
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("default", out var defaults) && defaults.ValueKind == JsonValueKind.Object)
        {
            foreach (var library in new[] { "male", "female" })
            {
                if (Text(defaults, library) is { } id && Find(id)?.Library == library) _defaults[library] = id;
            }
        }
    }

    private static AvatarEntry? ReadEntry(JsonElement item)
    {
        if (item.ValueKind != JsonValueKind.Object) return null;
        var id = Text(item, "id");
        var library = Text(item, "gender");
        if (id is null || !IdShape().IsMatch(id) || library is not ("male" or "female")) return null;
        if (!item.TryGetProperty("set", out var set) || !set.TryGetInt32(out var setNumber) || setNumber < 1) return null;
        if (!item.TryGetProperty("files", out var files) || files.ValueKind != JsonValueKind.Object) return null;
        var found = new SortedDictionary<int, string>();
        foreach (var file in files.EnumerateObject())
        {
            if (int.TryParse(file.Name, NumberStyles.None, CultureInfo.InvariantCulture, out var size) && size > 0
                && file.Value.ValueKind == JsonValueKind.String && file.Value.GetString() is { } path && StaysInside(path))
            {
                found[size] = path;
            }
        }
        return found.Count == 0 ? null : new AvatarEntry(id, library, setNumber, found);
    }

    private static string? Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static bool StaysInside(string relative)
    {
        var parts = relative.Split('/', '\\');
        return !Path.IsPathRooted(relative) && parts.All(p => p.Length > 0 && p != "." && p != "..");
    }

    public AvatarEntry? Find(string? id) => id is not null && _byId.TryGetValue(id, out var entry) ? entry : null;

    /// <summary>One library (male or female), or one of its sets, in manifest order.</summary>
    public IReadOnlyList<AvatarEntry> Of(string? library, int? set = null) =>
        Entries.Where(e => e.Library == library && (set is null || e.Set == set)).ToList();

    /// <summary>The sets of a library, in order.</summary>
    public IReadOnlyList<int> SetsOf(string? library) => Of(library).Select(e => e.Set).Distinct().Order().ToList();

    /// <summary>The default avatar of a library (M01, F01), as the manifest names it.</summary>
    public string? DefaultOf(string? library) => library is not null && _defaults.TryGetValue(library, out var id) ? id : null;

    /// <summary>
    /// The file to draw this avatar at this many physical pixels: the next larger one, else
    /// the largest. Null for anything the manifest does not list: the person shows the RX mark.
    /// </summary>
    public string? FileFor(string? id, int pixels)
    {
        if (Find(id) is not { } entry) return null;
        var size = entry.Files.Keys.Where(s => s >= pixels).DefaultIfEmpty(entry.Files.Keys.Max()).Min();
        return Path.Combine(_directory, entry.Files[size]);
    }
}
