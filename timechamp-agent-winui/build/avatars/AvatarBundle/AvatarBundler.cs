using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using SkiaSharp;

namespace RXVision.AvatarBundle;

/// <summary>Why the library cannot be bundled: the build stops and says so.</summary>
public sealed class AvatarBundleException : Exception
{
    public AvatarBundleException(string message) : base(message) { }
}

/// <summary>What a run did.</summary>
public sealed record AvatarBundleResult(int Avatars, int Files, int Encoded);

/// <summary>
/// Reads the library's manifest and writes the bundle the agent loads: a manifest of its
/// own that names every file, and the WebP sizes generated from the PNG masters.
///
/// Only the manifest names files. Higher-resolution masters under the same names need no
/// change here or in the agent, only a rebuild. Whether a master changed is told by its
/// content, never its date: a replaced file can carry an older date than its WebP (unzip,
/// rsync -a, cp -p). A file is written only when its bytes change.
/// </summary>
public static partial class AvatarBundler
{
    /// <summary>AGENT.md section 7: 1x icon from 48, 1.5x from 64, 2x from 96, 3x from 128.</summary>
    public static readonly IReadOnlyList<int> Sizes = new[] { 48, 64, 96, 128, 192 };

    /// <summary>The fixed shape the deck's "75 male avatars" and Set 1 to Set 3 rest on.</summary>
    public const int PerSet = 25;
    public const int SetsPerLibrary = 3;

    private const float Quality = 88f;
    private const string ManifestName = "manifest.json";
    private const string HashesName = "masters.json";

    /// <summary>Part of every master's fingerprint: new sizes or quality encode everything again.</summary>
    private static readonly string Recipe = $"quality {Quality}; sizes {string.Join(",", Sizes)}";

    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true };

    public static string LibraryFile(string libraryDir) => Path.GetFullPath(Path.Combine(libraryDir, ManifestName));

    /// <summary>The folder inside <paramref name="outDir"/> that goes into the app, whole.</summary>
    public static string BundleFolder(string outDir) => Path.Combine(outDir, "bundle");

    public static AvatarBundleResult Run(string libraryDir, string outDir)
    {
        var library = ReadLibrary(libraryDir);
        var bundle = BundleFolder(outDir);
        Directory.CreateDirectory(bundle);

        var hashesPath = Path.Combine(outDir, HashesName);
        var known = ReadHashes(hashesPath);
        var fresh = new Dictionary<string, string>();
        var expected = new HashSet<string>(StringComparer.Ordinal) { ManifestName };
        var jobs = new List<(MasterEntry Entry, byte[] Master, string Hash)>();

        foreach (var entry in library.Entries)
        {
            var masterPath = Path.Combine(libraryDir, entry.File);
            byte[] master;
            try
            {
                master = File.ReadAllBytes(masterPath);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                throw new AvatarBundleException($"{entry.Id}: {entry.File} is listed in the manifest but cannot be read ({ex.GetType().Name}).");
            }
            var hash = Convert.ToHexString(SHA256.HashData(master.Concat(Encoding.UTF8.GetBytes(Recipe)).ToArray()));
            fresh[entry.Id] = hash;
            foreach (var size in Sizes) expected.Add(WebpPath(entry, size));
            var whole = Sizes.All(size => File.Exists(Path.Combine(bundle, WebpPath(entry, size))));
            if (!whole || !known.TryGetValue(entry.Id, out var was) || was != hash) jobs.Add((entry, master, hash));
        }

        var encoded = 0;
        try
        {
            Parallel.ForEach(jobs, new ParallelOptions { MaxDegreeOfParallelism = 4 }, job =>
            {
                foreach (var (size, bytes) in Encode(job.Entry, job.Master))
                {
                    WriteIfChanged(Path.Combine(bundle, WebpPath(job.Entry, size)), bytes);
                    Interlocked.Increment(ref encoded);
                }
            });
        }
        catch (AggregateException ex) when (ex.Flatten().InnerExceptions.OfType<AvatarBundleException>().FirstOrDefault() is { } first)
        {
            throw first;
        }

        WriteIfChanged(Path.Combine(bundle, ManifestName), Encoding.UTF8.GetBytes(BundleManifest(library)));
        WriteIfChanged(hashesPath, JsonSerializer.SerializeToUtf8Bytes(fresh, Pretty));
        Prune(bundle, expected);
        return new AvatarBundleResult(library.Entries.Count, library.Entries.Count * Sizes.Count, encoded);
    }

    // ---- The library ------------------------------------------------------------------------

    private sealed record MasterEntry(string Id, string Gender, int Set, string File);

    private sealed record Library(int Version, string DefaultMale, string DefaultFemale, IReadOnlyList<MasterEntry> Entries);

    [GeneratedRegex("^[A-Za-z0-9_-]{1,32}$")]
    private static partial Regex IdShape();

    private static Library ReadLibrary(string libraryDir)
    {
        var path = LibraryFile(libraryDir);
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(path));
            root = doc.RootElement.Clone();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new AvatarBundleException($"the avatar library's manifest is missing: {path}");
        }
        catch (JsonException ex)
        {
            throw new AvatarBundleException($"the avatar library's manifest is not JSON: {ex.Message}");
        }

        var entries = new List<MasterEntry>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        if (!root.TryGetProperty("avatars", out var list) || list.ValueKind != JsonValueKind.Array)
            throw new AvatarBundleException("the manifest has no avatars list.");
        foreach (var item in list.EnumerateArray())
        {
            var id = Text(item, "id");
            var gender = Text(item, "gender");
            var file = Text(item, "file");
            var set = item.TryGetProperty("set", out var s) && s.TryGetInt32(out var n) ? n : 0;
            if (id is null || !IdShape().IsMatch(id)) throw new AvatarBundleException($"an avatar has no usable ID: {item}");
            if (gender is not ("male" or "female")) throw new AvatarBundleException($"{id}: gender is not male or female.");
            if (set is < 1 or > SetsPerLibrary) throw new AvatarBundleException($"{id}: set must be 1 to {SetsPerLibrary}.");
            if (file is null || !StaysInside(file) || !file.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
                throw new AvatarBundleException($"{id}: file must be a PNG inside the library.");
            if (!seen.Add(id)) throw new AvatarBundleException($"{id} is listed twice.");
            if (!File.Exists(Path.Combine(libraryDir, file)))
                throw new AvatarBundleException($"{id}: {file} is listed in the manifest but missing.");
            entries.Add(new MasterEntry(id, gender, set, file));
        }

        foreach (var gender in new[] { "male", "female" })
        {
            for (var set = 1; set <= SetsPerLibrary; set++)
            {
                var count = entries.Count(e => e.Gender == gender && e.Set == set);
                if (count != PerSet) throw new AvatarBundleException($"{gender} set {set} has {count} avatars, not {PerSet}.");
            }
        }

        var defaults = root.TryGetProperty("default", out var d) ? d : default;
        var male = defaults.ValueKind == JsonValueKind.Object ? Text(defaults, "male") : null;
        var female = defaults.ValueKind == JsonValueKind.Object ? Text(defaults, "female") : null;
        if (!entries.Any(e => e.Id == male && e.Gender == "male")) throw new AvatarBundleException("the male default is not a male avatar.");
        if (!entries.Any(e => e.Id == female && e.Gender == "female")) throw new AvatarBundleException("the female default is not a female avatar.");
        var version = root.TryGetProperty("version", out var v) && v.TryGetInt32(out var vn) ? vn : 1;
        return new Library(version, male!, female!, entries);
    }

    private static string? Text(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool StaysInside(string relative)
    {
        var parts = relative.Split('/', '\\');
        return !Path.IsPathRooted(relative) && parts.All(p => p.Length > 0 && p != "." && p != "..");
    }

    private static Dictionary<string, string> ReadHashes(string path)
    {
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllBytes(path)) ?? new();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return new();
        }
    }

    // ---- The bundle ---------------------------------------------------------------------------

    /// <summary>"webp/48/male/M01.webp": named after the master, and only ever read through the manifest.</summary>
    private static string WebpPath(MasterEntry entry, int size) =>
        $"webp/{size}/{Path.ChangeExtension(entry.File.Replace('\\', '/'), ".webp")}";

    private static string BundleManifest(Library library)
    {
        var manifest = new
        {
            version = library.Version,
            @default = new { male = library.DefaultMale, female = library.DefaultFemale },
            sizes = Sizes,
            avatars = library.Entries.Select(e => new
            {
                id = e.Id,
                gender = e.Gender,
                set = e.Set,
                files = Sizes.ToDictionary(size => size.ToString(), size => WebpPath(e, size)),
            }),
        };
        return JsonSerializer.Serialize(manifest, Pretty);
    }

    private static IEnumerable<(int Size, byte[] Bytes)> Encode(MasterEntry entry, byte[] master)
    {
        using var source = Decode(entry, master);
        if (source.Width != source.Height) throw new AvatarBundleException($"{entry.Id}: {entry.File} is {source.Width} x {source.Height}, not square.");
        if (source.Width < Sizes[^1]) throw new AvatarBundleException($"{entry.Id}: {entry.File} is {source.Width} px, smaller than {Sizes[^1]}.");
        var result = new List<(int, byte[])>();
        foreach (var size in Sizes) result.Add((size, Webp(source, size, entry)));
        return result;
    }

    private static SKBitmap Decode(MasterEntry entry, byte[] master)
    {
        try
        {
            return SKBitmap.Decode(master) ?? throw new AvatarBundleException($"{entry.Id}: {entry.File} is not a PNG that can be read.");
        }
        catch (ArgumentException)
        {
            throw new AvatarBundleException($"{entry.Id}: {entry.File} is not a PNG that can be read.");
        }
    }

    /// <summary>Halves down to within twice the size, then one last high-quality step, so a large master does not alias.</summary>
    private static byte[] Webp(SKBitmap source, int size, MasterEntry entry)
    {
        var current = source;
        try
        {
            while (current.Width / 2 >= size) current = Step(current, current.Width / 2, source);
            if (current.Width != size) current = Step(current, size, source);
            using var pixels = current.PeekPixels();
            using var data = pixels.Encode(new SKWebpEncoderOptions(SKWebpEncoderCompression.Lossy, Quality))
                ?? throw new AvatarBundleException($"{entry.Id}: the {size} px WebP could not be encoded.");
            return data.ToArray();
        }
        finally
        {
            if (!ReferenceEquals(current, source)) current.Dispose();
        }
    }

    private static SKBitmap Step(SKBitmap from, int size, SKBitmap source)
    {
        var next = from.Resize(new SKImageInfo(size, size, SKColorType.Rgba8888, SKAlphaType.Premul), SKFilterQuality.High)
            ?? throw new AvatarBundleException($"a master could not be scaled to {size} px.");
        if (!ReferenceEquals(from, source)) from.Dispose();
        return next;
    }

    private static void WriteIfChanged(string path, byte[] bytes)
    {
        if (File.Exists(path) && File.ReadAllBytes(path).AsSpan().SequenceEqual(bytes)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + ".tmp";
        File.WriteAllBytes(temp, bytes);
        File.Move(temp, path, overwrite: true);
    }

    /// <summary>Anything the manifest no longer names leaves the bundle, so it cannot ship by accident.</summary>
    private static void Prune(string bundle, HashSet<string> expected)
    {
        foreach (var file in Directory.EnumerateFiles(bundle, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(bundle, file).Replace('\\', '/');
            if (!expected.Contains(relative)) File.Delete(file);
        }
    }
}
