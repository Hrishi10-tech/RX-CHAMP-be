using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using RXVision.Agent.Core.Avatars;
using RXVision.AvatarBundle;
using SkiaSharp;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.UI.Tests;

/// <summary>Where the agent's source and its masters are, from the running tests.</summary>
internal static class AgentRepo
{
    public static string Root { get; } = Find();
    public static string Masters => Path.Combine(Root, "src", "RXVision.Agent", "Assets", "avatars");
    public static string AppProject => Path.Combine(Root, "src", "RXVision.Agent", "RXVision.Agent.csproj");
    public static string Tool => Path.Combine(Root, "build", "avatars", "AvatarBundle", "bin", "RXVision.AvatarBundle.dll");

    private static string Find()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "RXVision.Agent.sln"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("the agent's source is not above the test run");
    }
}

/// <summary>A copy of the library in a temp folder, to change, and a place for its bundle.</summary>
internal sealed class LibraryCopy : IDisposable
{
    public LibraryCopy()
    {
        Root = Directory.CreateTempSubdirectory("rxv-bundle-").FullName;
        Library = Path.Combine(Root, "library");
        Out = Path.Combine(Root, "out");
        Directory.CreateDirectory(Path.Combine(Library, "male"));
        Directory.CreateDirectory(Path.Combine(Library, "female"));
        File.Copy(Path.Combine(AgentRepo.Masters, "manifest.json"), Path.Combine(Library, "manifest.json"));
        foreach (var folder in new[] { "male", "female" })
        {
            foreach (var file in Directory.EnumerateFiles(Path.Combine(AgentRepo.Masters, folder)))
                File.Copy(file, Path.Combine(Library, folder, Path.GetFileName(file)));
        }
    }

    public string Root { get; }
    public string Library { get; }
    public string Out { get; }
    public string Bundle => AvatarBundler.BundleFolder(Out);
    public string Master(string relative) => Path.Combine(Library, relative);
    public string Webp(int size, string relative) => Path.Combine(Bundle, "webp", size.ToString(), relative + ".webp");

    public void Dispose()
    {
        try { Directory.Delete(Root, recursive: true); }
        catch (IOException) { }
    }

    /// <summary>The bundle the build already made for this test run, as if a build had just run here: only what changes is encoded.</summary>
    public void SeedFromRealBuild()
    {
        var built = Path.Combine(AgentRepo.Root, "src", "RXVision.Agent", "obj", "avatars");
        foreach (var file in Directory.EnumerateFiles(built, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(Out, Path.GetRelativePath(built, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target);
        }
    }
}

/// <summary>The WebP sizes generated from the PNG masters at build time.</summary>
public class AvatarBundleTests
{
    private static SKBitmap Square(int size, SKColor colour)
    {
        var bitmap = new SKBitmap(new SKImageInfo(size, size, SKColorType.Rgba8888, SKAlphaType.Premul));
        using var canvas = new SKCanvas(bitmap);
        canvas.Clear(SKColors.Transparent);
        using var paint = new SKPaint { Color = colour, IsAntialias = true };
        canvas.DrawCircle(size / 2f, size / 2f, size / 2f, paint);
        return bitmap;
    }

    private static void WritePng(string path, int size, SKColor colour)
    {
        using var bitmap = Square(size, colour);
        using var data = bitmap.Encode(SKEncodedImageFormat.Png, 100);
        File.WriteAllBytes(path, data.ToArray());
    }

    private static SKColor Middle(string webp)
    {
        using var bitmap = SKBitmap.Decode(webp);
        return bitmap.GetPixel(bitmap.Width / 2, bitmap.Height / 2);
    }

    // ---- What this test run was given ---------------------------------------------------------------

    [Fact]
    public void The_build_put_every_size_of_every_avatar_beside_the_app_and_a_manifest_that_names_them()
    {
        var folder = Path.Combine(AppContext.BaseDirectory, "Assets", "avatars");
        var library = AvatarLibrary.Load(folder);
        Assert.Null(library.LoadError);
        Assert.Equal(150, library.Entries.Count);
        Assert.Equal(75, library.Of("male").Count);
        Assert.Equal(75, library.Of("female").Count);
        foreach (var name in new[] { "male", "female" })
        {
            Assert.Equal(new[] { 1, 2, 3 }, library.SetsOf(name));
            foreach (var set in new[] { 1, 2, 3 }) Assert.Equal(25, library.Of(name, set).Count);
        }
        Assert.Equal("M01", library.DefaultOf("male"));
        Assert.Equal("F01", library.DefaultOf("female"));
        foreach (var entry in library.Entries)
        {
            Assert.Equal(new[] { 48, 64, 96, 128, 192 }, entry.Files.Keys);
            foreach (var (size, file) in entry.Files)
            {
                var path = Path.Combine(folder, file);
                Assert.True(File.Exists(path), path);
                var head = new byte[12];
                using (var stream = File.OpenRead(path)) stream.ReadExactly(head);
                Assert.Equal("RIFF", System.Text.Encoding.ASCII.GetString(head, 0, 4));
                Assert.Equal("WEBP", System.Text.Encoding.ASCII.GetString(head, 8, 4));
            }
        }
        // One of each, actually decoded: right size, transparent outside the circle.
        foreach (var size in AvatarBundler.Sizes)
        {
            using var bitmap = SKBitmap.Decode(library.FileFor("F07", size));
            Assert.Equal(size, bitmap.Width);
            Assert.Equal(size, bitmap.Height);
            Assert.Equal(0, bitmap.GetPixel(0, 0).Alpha);
            Assert.Equal(255, bitmap.GetPixel(size / 2, size / 2).Alpha);
        }
    }

    [Fact]
    public void Masters_are_in_the_repo_and_the_generated_files_are_not()
    {
        var manifest = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(AgentRepo.Masters, "manifest.json"))).RootElement;
        var avatars = manifest.GetProperty("avatars").EnumerateArray().ToList();
        Assert.Equal(150, avatars.Count);
        foreach (var avatar in avatars) Assert.True(File.Exists(Path.Combine(AgentRepo.Masters, avatar.GetProperty("file").GetString()!)));
        Assert.Empty(Directory.EnumerateFiles(AgentRepo.Masters, "*.webp", SearchOption.AllDirectories));
        // bin and obj are ignored, and the bundle is under obj.
        Assert.Contains("obj/", File.ReadAllLines(Path.Combine(AgentRepo.Root, ".gitignore")));
    }

    [Fact]
    public void The_masters_match_the_approved_library_shape()
    {
        var library = AvatarLibraryIds();
        Assert.Equal(Enumerable.Range(1, 75).Select(n => $"M{n:00}"), library.Where(id => id[0] == 'M'));
        Assert.Equal(Enumerable.Range(1, 75).Select(n => $"F{n:00}"), library.Where(id => id[0] == 'F'));
    }

    private static List<string> AvatarLibraryIds() =>
        JsonDocument.Parse(File.ReadAllBytes(Path.Combine(AgentRepo.Masters, "manifest.json"))).RootElement
            .GetProperty("avatars").EnumerateArray().Select(a => a.GetProperty("id").GetString()!).ToList();

    // ---- A replaced master ----------------------------------------------------------------------------

    [Fact]
    public void A_replaced_master_with_an_older_date_is_encoded_again_and_only_it()
    {
        using var copy = new LibraryCopy();
        copy.SeedFromRealBuild();
        var master = copy.Master("male/M12.png");
        var untouched = copy.Webp(96, "male/M13");
        var before = File.GetLastWriteTimeUtc(untouched);
        var oldBytes = File.ReadAllBytes(copy.Webp(96, "male/M12"));

        WritePng(master, 192, SKColors.Red);
        File.SetLastWriteTimeUtc(master, new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        var result = AvatarBundler.Run(copy.Library, copy.Out);

        Assert.Equal(AvatarBundler.Sizes.Count, result.Encoded);
        Assert.NotEqual(oldBytes, File.ReadAllBytes(copy.Webp(96, "male/M12")));
        var middle = Middle(copy.Webp(96, "male/M12"));
        Assert.True(middle.Red > 200 && middle.Green < 60 && middle.Blue < 60, middle.ToString());
        Assert.Equal(before, File.GetLastWriteTimeUtc(untouched));
    }

    [Fact]
    public void A_higher_resolution_master_under_the_same_name_needs_nothing_else()
    {
        using var copy = new LibraryCopy();
        copy.SeedFromRealBuild();
        var manifestBefore = File.ReadAllText(Path.Combine(copy.Bundle, "manifest.json"));
        WritePng(copy.Master("female/F07.png"), 512, SKColors.Blue);
        var result = AvatarBundler.Run(copy.Library, copy.Out);

        Assert.Equal(AvatarBundler.Sizes.Count, result.Encoded);
        Assert.Equal(manifestBefore, File.ReadAllText(Path.Combine(copy.Bundle, "manifest.json")));
        foreach (var size in AvatarBundler.Sizes)
        {
            using var bitmap = SKBitmap.Decode(copy.Webp(size, "female/F07"));
            Assert.Equal(size, bitmap.Width);
            Assert.True(bitmap.GetPixel(size / 2, size / 2).Blue > 200);
            Assert.Equal(0, bitmap.GetPixel(0, 0).Alpha);
        }
        // And the agent reads it through the manifest as it reads any other.
        Assert.EndsWith(Path.Combine("webp", "96", "female", "F07.webp"), AvatarLibrary.Load(copy.Bundle).FileFor("F07", 84)!.Replace('/', Path.DirectorySeparatorChar));
    }

    [Fact]
    public void A_run_with_nothing_new_writes_nothing()
    {
        using var copy = new LibraryCopy();
        copy.SeedFromRealBuild();
        var manifest = Path.Combine(copy.Bundle, "manifest.json");
        var stamp = File.GetLastWriteTimeUtc(manifest);
        var result = AvatarBundler.Run(copy.Library, copy.Out);
        Assert.Equal(0, result.Encoded);
        Assert.Equal(750, result.Files);
        Assert.Equal(stamp, File.GetLastWriteTimeUtc(manifest));
    }

    [Fact]
    public void A_webp_gone_from_the_bundle_comes_back_and_one_nobody_lists_goes()
    {
        using var copy = new LibraryCopy();
        copy.SeedFromRealBuild();
        File.Delete(copy.Webp(64, "male/M02"));
        var stray = Path.Combine(copy.Bundle, "webp", "64", "male", "M99.webp");
        File.WriteAllBytes(stray, new byte[] { 1, 2, 3 });
        var result = AvatarBundler.Run(copy.Library, copy.Out);
        Assert.Equal(AvatarBundler.Sizes.Count, result.Encoded);
        Assert.True(File.Exists(copy.Webp(64, "male/M02")));
        Assert.False(File.Exists(stray));
    }

    // ---- What stops the build --------------------------------------------------------------------------

    [Fact]
    public void A_missing_master_stops_it_and_names_the_file()
    {
        using var copy = new LibraryCopy();
        File.Delete(copy.Master("female/F33.png"));
        var ex = Assert.Throws<AvatarBundleException>(() => AvatarBundler.Run(copy.Library, copy.Out));
        Assert.Contains("female/F33.png", ex.Message);
        Assert.False(Directory.Exists(copy.Out));
    }

    [Fact]
    public void A_missing_manifest_stops_it()
    {
        using var copy = new LibraryCopy();
        File.Delete(copy.Master("manifest.json"));
        var ex = Assert.Throws<AvatarBundleException>(() => AvatarBundler.Run(copy.Library, copy.Out));
        Assert.Contains("manifest is missing", ex.Message);
    }

    [Fact]
    public void A_master_that_is_not_a_picture_or_is_too_small_stops_it()
    {
        using var copy = new LibraryCopy();
        File.WriteAllText(copy.Master("male/M05.png"), "not a picture");
        Assert.Contains("M05", Assert.Throws<AvatarBundleException>(() => AvatarBundler.Run(copy.Library, copy.Out)).Message);

        using var small = new LibraryCopy();
        WritePng(small.Master("male/M05.png"), 96, SKColors.Green);
        Assert.Contains("smaller than 192", Assert.Throws<AvatarBundleException>(() => AvatarBundler.Run(small.Library, small.Out)).Message);
    }

    [Theory]
    [InlineData("\"file\": \"male/M01.png\"", "\"file\": \"../M01.png\"", "M01")]
    [InlineData("\"file\": \"male/M01.png\"", "\"file\": \"/etc/M01.png\"", "M01")]
    [InlineData("\"id\": \"M02\"", "\"id\": \"M01\"", "listed twice")]
    [InlineData("\"gender\": \"male\"", "\"gender\": \"other\"", "gender")]
    [InlineData("\"male\": \"M01\"", "\"male\": \"F01\"", "male default")]
    public void A_manifest_that_is_not_sound_stops_it(string from, string to, string says)
    {
        using var copy = new LibraryCopy();
        var path = copy.Master("manifest.json");
        var text = File.ReadAllText(path);
        Assert.Contains(from, text);
        var first = text.IndexOf(from, StringComparison.Ordinal);
        File.WriteAllText(path, text[..first] + to + text[(first + from.Length)..]);
        var ex = Assert.Throws<AvatarBundleException>(() => AvatarBundler.Run(copy.Library, copy.Out));
        Assert.Contains(says, ex.Message);
    }

    [Fact]
    public void A_library_short_of_avatars_stops_it_so_the_words_75_stay_true()
    {
        using var copy = new LibraryCopy();
        var path = copy.Master("manifest.json");
        var doc = JsonDocument.Parse(File.ReadAllBytes(path)).RootElement;
        var kept = doc.GetProperty("avatars").EnumerateArray().Where(a => a.GetProperty("id").GetString() != "M75").ToList();
        File.WriteAllText(path, JsonSerializer.Serialize(new { version = 1, @default = doc.GetProperty("default"), avatars = kept }));
        var ex = Assert.Throws<AvatarBundleException>(() => AvatarBundler.Run(copy.Library, copy.Out));
        Assert.Contains("male set 3 has 24 avatars", ex.Message);
    }

    [Fact]
    public void The_tool_itself_exits_with_an_error_msbuild_reads_and_names_the_file()
    {
        using var copy = new LibraryCopy();
        File.Delete(copy.Master("male/M50.png"));
        var (code, _, errors) = Run(DotnetHost(), AgentRepo.Tool, copy.Library, copy.Out);
        Assert.Equal(1, code);
        Assert.Matches(@": error RXVAVATAR: M50: male/M50\.png is listed in the manifest but missing", errors);

        File.Copy(Path.Combine(AgentRepo.Masters, "male", "M50.png"), copy.Master("male/M50.png"));
        var (good, _, _) = Run(DotnetHost(), AgentRepo.Tool, copy.Library, copy.Out);
        Assert.Equal(0, good);
    }

    internal static string DotnetHost() => Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") is { Length: > 0 } host ? host : "dotnet";

    internal static (int Code, string Output, string Errors) Run(string file, params string[] args)
    {
        var start = new ProcessStartInfo(file) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var errors = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        return (process.ExitCode, output.Result, errors.Result);
    }
}

/// <summary>
/// The whole build with each runtime: opt-in with RXV_PUBLISH_TESTS=1, because a publish takes
/// minutes and installs that runtime's packs. Without it each test returns at once.
/// </summary>
public class AvatarPublishTests
{
    private readonly ITestOutputHelper _out;

    public AvatarPublishTests(ITestOutputHelper output) => _out = output;

    private bool Skipped()
    {
        if (Environment.GetEnvironmentVariable("RXV_PUBLISH_TESTS") == "1") return false;
        _out.WriteLine("skipped: set RXV_PUBLISH_TESTS=1 to run the publishes");
        return true;
    }

    private static (int Code, string Output, string Errors) Dotnet(params string[] args) =>
        AvatarBundleTests.Run(AvatarBundleTests.DotnetHost(), args);

    private static string[] PublishArgs(string rid, string output, params string[] more) =>
        new[]
        {
            "publish", AgentRepo.AppProject, "-c", "Release", "-r", rid, "--self-contained", "true",
            "-p:PublishSingleFile=false", "--nologo", "-o", output,
        }.Concat(more).ToArray();

    [Theory]
    [InlineData("win-x64")]
    [InlineData("osx-arm64")]
    [InlineData("osx-x64")]
    public void A_publish_for_each_runtime_carries_every_webp_and_the_manifest_and_no_master(string rid)
    {
        if (Skipped()) return;
        var output = Directory.CreateTempSubdirectory($"rxv-publish-{rid}-").FullName;
        try
        {
            var (code, text, errors) = Dotnet(PublishArgs(rid, output));
            _out.WriteLine(text);
            Assert.True(code == 0, text + errors);
            var folder = Path.Combine(output, "Assets", "avatars");
            var library = AvatarLibrary.Load(folder);
            Assert.Equal(150, library.Entries.Count);
            foreach (var entry in library.Entries)
            {
                foreach (var file in entry.Files.Values) Assert.True(File.Exists(Path.Combine(folder, file)), file);
            }
            Assert.Equal(750, Directory.EnumerateFiles(folder, "*.webp", SearchOption.AllDirectories).Count());
            Assert.Empty(Directory.EnumerateFiles(folder, "*.png", SearchOption.AllDirectories));
            Assert.Empty(Directory.EnumerateFiles(output, "RXVision.AvatarBundle*", SearchOption.TopDirectoryOnly));
        }
        finally
        {
            Directory.Delete(output, recursive: true);
        }
    }

    [Theory]
    [InlineData("win-x64")]
    [InlineData("osx-arm64")]
    [InlineData("osx-x64")]
    public void A_publish_with_a_master_missing_fails_for_each_runtime(string rid)
    {
        if (Skipped()) return;
        using var copy = new LibraryCopy();
        File.Delete(copy.Master("female/F33.png"));
        var output = Directory.CreateTempSubdirectory($"rxv-publish-{rid}-").FullName;
        try
        {
            var (code, text, errors) = Dotnet(PublishArgs(rid, output, $"-p:AvatarLibraryDir={copy.Library}"));
            Assert.NotEqual(0, code);
            Assert.Contains("female/F33.png is listed in the manifest but missing", text + errors);
        }
        finally
        {
            Directory.Delete(output, recursive: true);
        }
    }

    [Fact]
    public void A_debug_build_with_a_master_missing_fails()
    {
        if (Skipped()) return;
        using var copy = new LibraryCopy();
        File.Delete(copy.Master("male/M50.png"));
        var (code, text, errors) = Dotnet("build", AgentRepo.AppProject, "-c", "Debug", "--nologo", $"-p:AvatarLibraryDir={copy.Library}");
        Assert.NotEqual(0, code);
        Assert.Contains("male/M50.png is listed in the manifest but missing", text + errors);
    }
}

/// <summary>Presets only: there is no way to send a picture anywhere in the avatar's code.</summary>
public class AvatarNoUploadTests
{
    private static IEnumerable<string> AvatarSources()
    {
        var src = Path.Combine(AgentRepo.Root, "src");
        return new[]
        {
            "RXVision.Agent.Core/Avatars/AvatarService.cs",
            "RXVision.Agent.Core/Avatars/AvatarLibrary.cs",
            "RXVision.Agent/Services/AvatarImages.cs",
            "RXVision.Agent/Services/AvatarIconSource.cs",
            "RXVision.Agent/ViewModels/AvatarPickerViewModel.cs",
            "RXVision.Agent/ViewModels/ProfileViewModel.cs",
            "RXVision.Agent/Views/AvatarPickerWindow.axaml",
            "RXVision.Agent/Views/AvatarPickerWindow.axaml.cs",
            "RXVision.Agent/Controls/PersonAvatar.cs",
            "RXVision.Agent/Controls/PreviewIcon.cs",
            "RXVision.Agent/Controls/AvatarPainter.cs",
        }.Select(relative => Path.Combine(src, relative));
    }

    [Fact]
    public void Nothing_in_the_avatars_code_opens_a_file_chooser_or_sends_a_file()
    {
        var forbidden = new Regex(@"StorageProvider|OpenFilePicker|OpenFileDialog|FilePicker|MultipartFormData|StreamContent|ByteArrayContent|DragDrop|AllowDrop|[Uu]pload", RegexOptions.Compiled);
        foreach (var path in AvatarSources())
        {
            Assert.True(File.Exists(path), path);
            var text = File.ReadAllText(path);
            Assert.False(forbidden.IsMatch(text), $"{path}: {forbidden.Match(text).Value}");
        }
    }

    [Fact]
    public void The_client_has_only_the_three_calls_on_me_avatar_and_no_route_for_a_picture()
    {
        var text = File.ReadAllText(Path.Combine(AgentRepo.Root, "src", "RXVision.Agent.Core", "Api", "ApiClient.cs"));
        var avatarCalls = Regex.Matches(text, "\"([^\"\n]*avatar[^\"\n]*)\"").Select(m => m.Groups[1].Value).Distinct().ToList();
        Assert.Equal(new[] { "me/avatar" }, avatarCalls);
        // Multipart is the screenshots' alone, as in 3.5.
        Assert.Single(Regex.Matches(text, "MultipartFormDataContent\\(").Cast<Match>());
    }
}
