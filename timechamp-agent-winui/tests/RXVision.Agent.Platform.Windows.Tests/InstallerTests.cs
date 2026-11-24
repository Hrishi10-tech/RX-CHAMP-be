using System.IO.Compression;
using System.Text;
using RXVision.Installer;
using Xunit;

namespace RXVision.Agent.Platform.Windows.Tests;

public class TrailerTests
{
    private const string Magic = "TCAGCFG1";

    private static byte[] WithTrailer(byte[] body, byte[] json)
    {
        var len = BitConverter.GetBytes((uint)json.Length);
        return body.Concat(json).Concat(len).Concat(Encoding.ASCII.GetBytes(Magic)).ToArray();
    }

    [Fact]
    public void Reads_the_appended_config()
    {
        var json = Encoding.UTF8.GetBytes("{\"ApiBaseUrl\":\"https://api.example.com\",\"EnrollmentToken\":\"t.o.k\"}");
        using var ms = new MemoryStream(WithTrailer(Encoding.ASCII.GetBytes("MZ fake exe body"), json));
        var read = Trailer.Read(ms);
        Assert.NotNull(read);
        Assert.Equal(json, read);
    }

    [Fact]
    public void No_trailer_returns_null()
    {
        using var ms = new MemoryStream(Encoding.ASCII.GetBytes("a plain exe with no trailer at all"));
        Assert.Null(Trailer.Read(ms));
    }

    [Fact]
    public void A_bogus_length_is_rejected()
    {
        var len = BitConverter.GetBytes(0xFFFFFFu); // larger than the stream
        var bytes = Encoding.ASCII.GetBytes("body").Concat(len).Concat(Encoding.ASCII.GetBytes(Magic)).ToArray();
        using var ms = new MemoryStream(bytes);
        Assert.Null(Trailer.Read(ms));
    }
}

public class InstallerCoreTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("rxv-install-").FullName;
    private readonly string _install;
    private readonly string _legacy;
    private readonly InstallPaths _paths;

    public InstallerCoreTests()
    {
        _install = Path.Combine(_root, "RXVision");
        _legacy = Path.Combine(_root, "RXChampAgent");
        _paths = new InstallPaths(_install, _legacy);
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { }
    }

    // ---- fakes -------------------------------------------------------------------------

    private sealed class FakePayload : IPayloadSource
    {
        public string Sha = "newsha";
        public bool IncludeExe = true;
        public int ExtractCalls;
        public string[] ExtraFiles = Array.Empty<string>();
        public Exception? ShaThrows;
        public Exception? ExtractThrows;

        public string Sha256() => ShaThrows is null ? Sha : throw ShaThrows;

        public void ExtractTo(string destDir)
        {
            ExtractCalls++;
            Directory.CreateDirectory(destDir);
            if (IncludeExe) File.WriteAllText(Path.Combine(destDir, InstallerCore.AgentExeName), "new-exe");
            foreach (var f in ExtraFiles) File.WriteAllText(Path.Combine(destDir, f), f);
            if (ExtractThrows is not null) throw ExtractThrows;
        }
    }

    /// <summary>A real zip, extracted exactly like the installer's EmbeddedPayload does.</summary>
    private sealed class ZipPayload : IPayloadSource
    {
        private readonly byte[] _zip;

        public ZipPayload(params (string name, string content)[] entries)
        {
            using var ms = new MemoryStream();
            using (var archive = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
            {
                foreach (var (name, content) in entries)
                {
                    using var writer = new StreamWriter(archive.CreateEntry(name).Open());
                    writer.Write(content);
                }
            }
            _zip = ms.ToArray();
        }

        public string Sha256() => "zipsha";

        public void ExtractTo(string destDir)
        {
            Directory.CreateDirectory(destDir);
            using var archive = new ZipArchive(new MemoryStream(_zip), ZipArchiveMode.Read);
            archive.ExtractToDirectory(destDir, overwriteFiles: true);
        }
    }

    private sealed class FakeProcess : IProcessControl
    {
        public readonly List<string> Stopped = new();
        public readonly List<(string exe, string? args, string wd)> Started = new();
        public readonly Queue<bool> Running = new();
        public bool NextStartNull;

        public void StopAgents(IEnumerable<string> processNames) => Stopped.AddRange(processNames);

        public IAgentProcess? Start(string exePath, string? arguments, string workingDir)
        {
            Started.Add((exePath, arguments, workingDir));
            if (NextStartNull) { NextStartNull = false; return null; }
            var running = Running.Count > 0 ? Running.Dequeue() : true;
            return new Handle(running);
        }

        private sealed class Handle : IAgentProcess
        {
            public Handle(bool running) => IsRunning = running;
            public bool IsRunning { get; }
        }
    }

    private sealed class FakeRunKey : IRunKeyStore
    {
        public readonly Dictionary<string, string> Values = new();
        public void Set(string name, string value) => Values[name] = value;
        public void Delete(string name) => Values.Remove(name);
        public string? Get(string name) => Values.TryGetValue(name, out var v) ? v : null;
    }

    private sealed class FakeLog : IInstallLog
    {
        public readonly List<string> Lines = new();
        public void Line(string message) => Lines.Add(message);
    }

    private sealed class FakeBox : IMessageBox
    {
        public readonly List<string> Errors = new();
        public void Error(string message) => Errors.Add(message);
    }

    private sealed class NoWait : IWaiter
    {
        public void Wait(TimeSpan duration) { }
    }

    private (InstallerCore core, FakePayload payload, FakeProcess procs, FakeRunKey runKey, FakeBox box, FakeLog log)
        Build(InstallOptions opts, FakePayload? payload = null, FakeProcess? procs = null)
    {
        payload ??= new FakePayload();
        var (core, procs2, runKey, box, log) = BuildWith(opts, payload, procs);
        return (core, payload, procs2, runKey, box, log);
    }

    private (InstallerCore core, FakeProcess procs, FakeRunKey runKey, FakeBox box, FakeLog log)
        BuildWith(InstallOptions opts, IPayloadSource payload, FakeProcess? procs = null)
    {
        procs ??= new FakeProcess();
        var runKey = new FakeRunKey();
        var box = new FakeBox();
        var log = new FakeLog();
        var core = new InstallerCore(_paths, opts, payload, procs, runKey, log, box, new NoWait());
        return (core, procs, runKey, box, log);
    }

    private string PreviousExe => Path.Combine(_paths.AppPreviousDir, InstallerCore.AgentExeName);

    private void SeedPreviousApp(string sha, params string[] extraFiles)
    {
        Directory.CreateDirectory(_paths.AppPreviousDir);
        File.WriteAllText(PreviousExe, "previous-exe");
        File.WriteAllText(Path.Combine(_paths.AppPreviousDir, ".build-stamp"), sha);
        foreach (var f in extraFiles) File.WriteAllText(Path.Combine(_paths.AppPreviousDir, f), f);
    }

    private string AppExe => Path.Combine(_paths.AppDir, InstallerCore.AgentExeName);

    private void SeedExistingApp(string sha, params string[] extraFiles)
    {
        Directory.CreateDirectory(_paths.AppDir);
        File.WriteAllText(AppExe, "old-exe");
        File.WriteAllText(Path.Combine(_paths.AppDir, ".build-stamp"), sha);
        foreach (var f in extraFiles) File.WriteAllText(Path.Combine(_paths.AppDir, f), f);
    }

    // ---- scenarios ---------------------------------------------------------------------

    [Fact]
    public void Fresh_install_succeeds_and_writes_everything()
    {
        var trailer = Encoding.UTF8.GetBytes("{\"EnrollmentToken\":\"tok\"}");
        var opts = new InstallOptions { Update = false, EnrollTrailerJson = trailer, ConfirmDelay = TimeSpan.Zero };
        var (core, _, procs, runKey, box, _) = Build(opts);
        Directory.CreateDirectory(_legacy);
        File.WriteAllText(Path.Combine(_legacy, "old.txt"), "x");

        var result = core.Run();

        Assert.True(result.Success);
        Assert.True(File.Exists(AppExe));
        Assert.Equal("newsha", File.ReadAllText(Path.Combine(_paths.AppDir, ".build-stamp")));
        Assert.Equal(trailer, File.ReadAllBytes(Path.Combine(_paths.AppDir, InstallerCore.EnrollFileName)));
        Assert.Equal($"\"{AppExe}\" --minimized", runKey.Get(InstallerCore.RunValueName));
        Assert.Null(runKey.Get(InstallerCore.LegacyRunValueName)); // 2.x run value removed
        Assert.False(Directory.Exists(_legacy));                   // 2.x install removed on success
        Assert.Contains(InstallerCore.AgentProcessName, procs.Stopped);
        Assert.Contains(InstallerCore.LegacyProcessName, procs.Stopped);
        Assert.Empty(box.Errors);
        // A fresh interactive install launches the agent shown, not minimised.
        Assert.Single(procs.Started);
        Assert.Null(procs.Started[0].args);
    }

    [Fact]
    public void Update_launches_minimised()
    {
        var opts = new InstallOptions { Update = true, ConfirmDelay = TimeSpan.Zero };
        var (core, _, procs, _, _, _) = Build(opts);
        core.Run();
        Assert.Equal("--minimized", procs.Started[0].args);
    }

    [Fact]
    public void Agent_is_started_from_the_install_root_not_inside_app()
    {
        // The agent hands its current directory to the installer it starts for an
        // update; standing inside app\ kept that folder from being moved aside, so
        // every update failed with "being used by another process".
        SeedExistingApp("oldsha");
        var opts = new InstallOptions { Update = true, ConfirmDelay = TimeSpan.Zero };
        var (core, _, procs, _, _, _) = Build(opts);

        Assert.True(core.Run().Success);

        var wd = Assert.Single(procs.Started).wd;
        Assert.Equal(_paths.InstallRoot, wd);
        Assert.False(wd.StartsWith(_paths.AppDir, StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Failed_update_rolls_back_to_the_previous_v3_build()
    {
        SeedExistingApp("oldsha", "marker.txt");
        var procs = new FakeProcess();
        procs.Running.Enqueue(false); // the new build fails to stay up
        procs.Running.Enqueue(true);  // the restored previous build is fine
        var opts = new InstallOptions { Update = true, ConfirmDelay = TimeSpan.Zero };
        var (core, _, _, runKey, _, _) = Build(opts, new FakePayload { Sha = "newsha" }, procs);

        var result = core.Run();

        Assert.False(result.Success);
        Assert.True(result.RolledBack);
        Assert.True(File.Exists(Path.Combine(_paths.AppDir, "marker.txt")));          // previous content is back
        Assert.Equal("oldsha", File.ReadAllText(Path.Combine(_paths.AppDir, ".build-stamp")));
        Assert.False(Directory.Exists(_paths.AppPreviousDir));
        Assert.Equal($"\"{AppExe}\" --minimized", runKey.Get(InstallerCore.RunValueName));
        Assert.Equal(2, procs.Started.Count);                                          // new, then restored
    }

    [Fact]
    public void Failed_fresh_update_falls_back_to_the_2x_agent()
    {
        var legacyExe = Path.Combine(_legacy, InstallerCore.LegacyAgentExeName);
        Directory.CreateDirectory(_legacy);
        File.WriteAllText(legacyExe, "legacy-exe");

        var procs = new FakeProcess();
        procs.Running.Enqueue(false); // the new build fails
        var opts = new InstallOptions { Update = true, ConfirmDelay = TimeSpan.Zero };
        var (core, _, _, runKey, box, _) = Build(opts, new FakePayload(), procs);

        var result = core.Run();

        Assert.True(result.RolledBack);
        Assert.False(result.Success);
        Assert.Null(runKey.Get(InstallerCore.RunValueName));                           // broken v3 run value removed
        Assert.Equal($"\"{legacyExe}\" --minimized", runKey.Get(InstallerCore.LegacyRunValueName));
        Assert.Contains(procs.Started, s => s.exe == legacyExe);
        Assert.Empty(box.Errors);                                                      // silent update: no box
    }

    [Fact]
    public void Identical_build_skips_extraction_but_still_relaunches()
    {
        SeedExistingApp("samesha", "marker.txt");
        var payload = new FakePayload { Sha = "samesha" };
        var opts = new InstallOptions { Update = true, ConfirmDelay = TimeSpan.Zero };
        var (core, _, procs, runKey, _, _) = Build(opts, payload);

        var result = core.Run();

        Assert.True(result.Success);
        Assert.Equal(0, payload.ExtractCalls);                                         // nothing re-extracted
        Assert.True(File.Exists(Path.Combine(_paths.AppDir, "marker.txt")));
        Assert.Equal($"\"{AppExe}\" --minimized", runKey.Get(InstallerCore.RunValueName));
        Assert.Single(procs.Started);
    }

    [Fact]
    public void No_trailer_carries_the_2x_enrollment_across_once_under_its_own_name()
    {
        Directory.CreateDirectory(_legacy);
        File.WriteAllText(Path.Combine(_legacy, InstallerCore.EnrollFileName), "LEGACY-ENROLL");
        var opts = new InstallOptions { Update = true, EnrollTrailerJson = null, ConfirmDelay = TimeSpan.Zero };
        var (core, _, _, _, _, _) = Build(opts);

        var result = core.Run();

        Assert.True(result.Success);
        // Beside the app as the 2.x enrollment, never as a new per-user enrollment.
        Assert.Equal("LEGACY-ENROLL", File.ReadAllText(Path.Combine(_paths.AppDir, InstallerCore.LegacyEnrollFileName)));
        Assert.False(File.Exists(Path.Combine(_paths.AppDir, InstallerCore.EnrollFileName)));
        Assert.True(File.Exists(Path.Combine(_install, InstallerCore.LegacyCarriedMarker)));
    }

    [Fact]
    public void A_later_update_never_carries_the_2x_enrollment_again()
    {
        var opts = new InstallOptions { Update = true, EnrollTrailerJson = null, ConfirmDelay = TimeSpan.Zero };
        Directory.CreateDirectory(_legacy);
        File.WriteAllText(Path.Combine(_legacy, InstallerCore.EnrollFileName), "LEGACY-ENROLL");
        Assert.True(Build(opts).Item1.Run().Success);
        // The agent read it (and deleted it); the person later signed out. The 2.x folder
        // could not be removed (a locked file), and the next update comes along.
        File.Delete(Path.Combine(_paths.AppDir, InstallerCore.LegacyEnrollFileName));
        Directory.CreateDirectory(_legacy);
        File.WriteAllText(Path.Combine(_legacy, InstallerCore.EnrollFileName), "LEGACY-ENROLL");

        Assert.True(Build(opts, new FakePayload { Sha = "v2sha" }).Item1.Run().Success);

        Assert.False(File.Exists(Path.Combine(_paths.AppDir, InstallerCore.LegacyEnrollFileName)));
        Assert.False(File.Exists(Path.Combine(_paths.AppDir, InstallerCore.EnrollFileName)));
    }

    [Fact]
    public void The_2x_enrollment_is_not_carried_once_the_agent_has_done_its_own_2x_step()
    {
        Directory.CreateDirectory(_legacy);
        File.WriteAllText(Path.Combine(_legacy, InstallerCore.EnrollFileName), "LEGACY-ENROLL");
        Directory.CreateDirectory(_paths.DataDir);
        File.WriteAllText(Path.Combine(_paths.DataDir, InstallerCore.AgentLegacyDoneMarker), "");
        var opts = new InstallOptions { Update = true, EnrollTrailerJson = null, ConfirmDelay = TimeSpan.Zero };

        Assert.True(Build(opts).Item1.Run().Success);

        Assert.False(File.Exists(Path.Combine(_paths.AppDir, InstallerCore.LegacyEnrollFileName)));
        Assert.False(File.Exists(Path.Combine(_paths.AppDir, InstallerCore.EnrollFileName)));
    }

    [Fact]
    public void The_agent_manifest_carries_the_agents_version()
    {
        // app.manifest cannot read Directory.Build.props: this keeps the two in step.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Directory.Build.props"))) dir = dir.Parent;
        Assert.NotNull(dir);
        var props = File.ReadAllText(Path.Combine(dir!.FullName, "Directory.Build.props"));
        var version = System.Text.RegularExpressions.Regex.Match(props, "<Version>([0-9.]+)</Version>").Groups[1].Value;
        var manifest = File.ReadAllText(Path.Combine(dir.FullName, "src", "RXVision.Agent", "app.manifest"));
        Assert.Contains($"<assemblyIdentity version=\"{version}.0\" name=\"RXVision.Agent\"/>", manifest);
    }

    [Fact]
    public void A_bad_payload_with_nothing_to_restore_fails_and_shows_a_box()
    {
        var opts = new InstallOptions { Update = false, ConfirmDelay = TimeSpan.Zero };
        var (core, _, _, _, box, _) = Build(opts, new FakePayload { IncludeExe = false });

        var result = core.Run();

        Assert.False(result.Success);
        Assert.False(result.RolledBack);
        Assert.Single(box.Errors);                                 // interactive install: user is told
        Assert.False(Directory.Exists(_paths.AppNewDir));          // scratch cleaned up
    }

    [Fact]
    public void A_bad_update_with_nothing_to_restore_is_silent()
    {
        var opts = new InstallOptions { Update = true, ConfirmDelay = TimeSpan.Zero };
        var (core, _, _, _, box, _) = Build(opts, new FakePayload { IncludeExe = false });

        var result = core.Run();

        Assert.False(result.Success);
        Assert.Empty(box.Errors);                                  // silent update: no box
    }

    [Fact]
    public void A_failure_before_the_swap_relaunches_the_current_build_and_never_downgrades()
    {
        SeedExistingApp("cursha", "current.txt");
        SeedPreviousApp("prevsha", "previous.txt");
        var trailer = Encoding.UTF8.GetBytes("{\"EnrollmentToken\":\"tok\"}");
        var opts = new InstallOptions { Update = false, EnrollTrailerJson = trailer, ConfirmDelay = TimeSpan.Zero };
        var (core, _, procs, runKey, _, _) = Build(opts, new FakePayload { IncludeExe = false });

        var result = core.Run();

        Assert.False(result.Success);
        Assert.True(result.RolledBack);
        Assert.True(File.Exists(Path.Combine(_paths.AppDir, "current.txt")));          // current build kept
        Assert.Equal("cursha", File.ReadAllText(Path.Combine(_paths.AppDir, ".build-stamp")));
        Assert.True(File.Exists(Path.Combine(_paths.AppPreviousDir, "previous.txt"))); // rollback target kept
        Assert.Equal(AppExe, Assert.Single(procs.Started).exe);                        // the current build relaunched
        Assert.Equal($"\"{AppExe}\" --minimized", runKey.Get(InstallerCore.RunValueName));
        // The per-user download still enrolls the person with the build that runs.
        Assert.Equal(trailer, File.ReadAllBytes(Path.Combine(_paths.AppDir, InstallerCore.EnrollFileName)));
    }

    [Fact]
    public void An_extraction_error_keeps_and_relaunches_the_installed_build()
    {
        SeedExistingApp("cursha", "current.txt");
        var payload = new FakePayload { ExtractThrows = new IOException("There is not enough space on the disk.") };
        var opts = new InstallOptions { Update = true, ConfirmDelay = TimeSpan.Zero };
        var (core, _, procs, _, _, _) = Build(opts, payload);

        var result = core.Run();

        Assert.False(result.Success);
        Assert.True(result.RolledBack);
        Assert.Equal("old-exe", File.ReadAllText(AppExe));                             // untouched
        Assert.False(Directory.Exists(_paths.AppNewDir));                              // partial extraction removed
        Assert.Equal(AppExe, Assert.Single(procs.Started).exe);
    }

    [Theory]
    [InlineData("../evil.txt")]
    [InlineData("{root}/abs-evil.txt")]
    public void A_zip_entry_outside_the_install_folder_is_refused(string badEntry)
    {
        SeedExistingApp("cursha");
        var entry = badEntry.Replace("{root}", _root);
        var payload = new ZipPayload((InstallerCore.AgentExeName, "new-exe"), (entry, "pwned"));
        var opts = new InstallOptions { Update = true, ConfirmDelay = TimeSpan.Zero };
        var (core, procs, _, _, _) = BuildWith(opts, payload);

        var result = core.Run();

        Assert.False(result.Success);
        Assert.False(File.Exists(Path.Combine(_install, "evil.txt")));                 // nothing escaped app.new
        Assert.False(File.Exists(Path.Combine(_root, "abs-evil.txt")));
        Assert.Equal("old-exe", File.ReadAllText(AppExe));                             // installed build untouched
        Assert.False(Directory.Exists(_paths.AppNewDir));
        Assert.Equal(AppExe, Assert.Single(procs.Started).exe);
    }

    [Fact]
    public void An_unreadable_payload_changes_nothing_and_leaves_the_agent_running()
    {
        SeedExistingApp("cursha");
        var payload = new FakePayload { ShaThrows = new InvalidOperationException("Installer payload (app.zip) is missing.") };
        var opts = new InstallOptions { Update = false, ConfirmDelay = TimeSpan.Zero };
        var (core, _, procs, runKey, box, _) = Build(opts, payload);

        var result = core.Run();

        Assert.False(result.Success);
        Assert.Empty(procs.Stopped);                                                   // the running agent was not stopped
        Assert.Empty(procs.Started);
        Assert.Empty(runKey.Values);
        Assert.Equal(0, payload.ExtractCalls);
        Assert.Single(box.Errors);
    }

    [Fact]
    public void A_swap_that_cannot_move_the_installed_build_keeps_it()
    {
        SeedExistingApp("cursha", "current.txt");
        // Something in the way of app -> app.previous that is not a folder the installer may delete.
        Directory.CreateDirectory(_install);
        File.WriteAllText(_paths.AppPreviousDir, "in the way");
        var opts = new InstallOptions { Update = true, ConfirmDelay = TimeSpan.Zero };
        var (core, _, procs, _, _, _) = Build(opts);

        var result = core.Run();

        Assert.False(result.Success);
        Assert.True(result.RolledBack);
        Assert.True(File.Exists(Path.Combine(_paths.AppDir, "current.txt")));
        Assert.Equal("old-exe", File.ReadAllText(AppExe));
        Assert.False(Directory.Exists(_paths.AppNewDir));
        Assert.Equal(AppExe, Assert.Single(procs.Started).exe);
    }

    [Fact]
    public void An_identical_reinstall_that_will_not_start_returns_to_the_previous_build()
    {
        SeedExistingApp("samesha", "current.txt");
        SeedPreviousApp("prevsha", "previous.txt");
        var procs = new FakeProcess();
        procs.Running.Enqueue(false); // the reinstalled build dies
        procs.Running.Enqueue(true);  // the previous build is fine
        var trailer = Encoding.UTF8.GetBytes("{\"EnrollmentToken\":\"tok\"}");
        var opts = new InstallOptions { Update = false, EnrollTrailerJson = trailer, ConfirmDelay = TimeSpan.Zero };
        var (core, payload, _, runKey, box, _) = Build(opts, new FakePayload { Sha = "samesha" }, procs);

        var result = core.Run();

        Assert.False(result.Success);
        Assert.True(result.RolledBack);
        Assert.Equal(0, payload.ExtractCalls);
        Assert.True(File.Exists(Path.Combine(_paths.AppDir, "previous.txt")));
        Assert.Equal($"\"{AppExe}\" --minimized", runKey.Get(InstallerCore.RunValueName));
        Assert.Equal(trailer, File.ReadAllBytes(Path.Combine(_paths.AppDir, InstallerCore.EnrollFileName)));
        Assert.Single(box.Errors);
    }
}
