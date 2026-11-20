using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Update;

public sealed record UpdateOffer(string Version, long SizeBytes, bool CanInstall);

/// <summary>Where a by-hand download landed (<paramref name="Path"/>), or why it did not (<paramref name="Error"/>).</summary>
public sealed record ManualDownload(string? Path, string? Error);

/// <summary>
/// Keeps the agent current. Checks shortly after launch and then every
/// UpdateCheckMinutes (with jitter). A newer build is downloaded, its SHA-256
/// compared with what the server published, and only then handed to the
/// platform installer. Failures back off per version and expire after a day, so
/// a broken release can neither loop downloads nor pin the fleet for ever.
/// When the app cannot replace itself (macOS app folder not writable), the
/// person is told an update is available instead.
/// What failed is kept on disk (update-state.json in the data folder): the
/// process exits to install, so memory alone would forget a release that rolled
/// back and download it again on the next start, in a loop.
/// </summary>
public sealed class UpdateService : IDisposable
{
    /// <summary>A version that was handed to the installer but is not what runs now is refused this long.</summary>
    public static readonly TimeSpan DidNotTakeBlock = TimeSpan.FromHours(24);
    public const string StateFileName = "update-state.json";
    /// <summary>
    /// Written at every start: line 1 the running version, line 2 the process id. The Mac
    /// update script waits for the new build to report itself here before it deletes the
    /// previous bundle (and puts the previous one back if it never does).
    /// </summary>
    public const string RunningFileName = "running-version.txt";

    private readonly ApiClient _api;
    private readonly IPlatform _platform;
    private readonly AgentOptions _options;
    private readonly ILog _log;
    private readonly string _currentVersion;
    private readonly string? _downloadsFolder;
    private readonly Dictionary<string, (int failures, DateTimeOffset retryAfter)> _failures = new();
    private readonly string _statePath;
    private string? _attemptVersion;
    private DateTimeOffset _attemptAt;
    private Timer? _timer;
    private int _busy;

    /// <param name="downloadsFolder">Where by-hand downloads go (tests); default ~/Downloads.</param>
    public UpdateService(ApiClient api, IPlatform platform, AgentOptions options, ILog log, string? currentVersion = null, string? downloadsFolder = null)
    {
        _api = api;
        _platform = platform;
        _options = options;
        _log = log;
        _currentVersion = currentVersion ?? AgentOptions.AppVersion;
        _downloadsFolder = downloadsFolder;
        _statePath = Path.Combine(platform.Paths.DataDir, StateFileName);
        LoadState();
        ReconcileLastAttempt();
    }

    /// <summary>
    /// Records that this build is running (see <see cref="RunningFileName"/>). Called first
    /// thing at start, before anything that can wait on the person (a Keychain prompt).
    /// </summary>
    public static void ReportRunning(string dataDir, string version, ILog log)
    {
        try
        {
            var text = $"{Clean(version)}\n{Environment.ProcessId}\n";
            AtomicFile.WriteAllBytes(Path.Combine(dataDir, RunningFileName), System.Text.Encoding.UTF8.GetBytes(text));
        }
        catch (Exception ex)
        {
            log.Debug("update", $"could not record the running version: {ex.Message}");
        }
    }

    /// <summary>When this version may be tried again, or null if nothing failed (tests and logs).</summary>
    public DateTimeOffset? BlockedUntil(string version) =>
        _failures.TryGetValue(version, out var f) && DateTimeOffset.UtcNow < f.retryAfter ? f.retryAfter : null;

    /// <summary>An update is ready to install (it will install itself) or available to download by hand.</summary>
    public event Action<UpdateOffer>? Available;

    /// <summary>The installer is running; the app must exit now so its files can be replaced.</summary>
    public event Action? ExitForUpdate;

    public void Start()
    {
        if (!_options.AutoUpdate || _timer is not null) return;
        var period = TimeSpan.FromMinutes(_options.UpdateCheckMinutes + Random.Shared.Next(0, 6));
        _timer = new Timer(_ => _ = CheckAsync(), null, TimeSpan.FromSeconds(45 + Random.Shared.Next(0, 30)), period);
    }

    public void Stop()
    {
        _timer?.Dispose();
        _timer = null;
    }

    public static bool IsNewer(string offered, string current) =>
        Version.TryParse(Clean(offered), out var o) && Version.TryParse(Clean(current), out var c) && o > c;

    private static string Clean(string v) => v.Trim().TrimStart('v', 'V').Split('-', '+')[0];

    /// <summary>The public key updates must be signed with; null: signing not set up (tests set it).</summary>
    internal string? TrustedKey { get; set; } = UpdateSignature.PublicKeyPem;
    private bool _unsignedNoted;

    public async Task<bool> CheckAsync(CancellationToken ct = default)
    {
        if (!_api.IsSignedIn || Interlocked.Exchange(ref _busy, 1) == 1) return false;
        try
        {
            var result = await _api.GetAgentVersionAsync(_platform.UpdateChannel, ct);
            if (!result.Ok || result.Data is not { Available: true } info) return false;
            if (!IsNewer(info.Version, _currentVersion)) return false;

            if (_failures.TryGetValue(info.Version, out var f) && DateTimeOffset.UtcNow < f.retryAfter) return false;

            if (!_platform.Updater.CanSelfUpdate)
            {
                Available?.Invoke(new UpdateOffer(info.Version, info.SizeBytes, false));
                return false;
            }
            if (string.IsNullOrWhiteSpace(info.Sha256))
            {
                // Nothing to check the download against: never run unverified code.
                _log.Warn("update", $"{info.Version} offered without a checksum; not installing");
                return false;
            }

            var ext = _platform.Name == "windows" ? ".exe" : ".zip";
            var path = Path.Combine(_platform.Paths.TempDir, $"rxvision-{Clean(info.Version)}{ext}");
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(TimeSpan.FromMinutes(20));
            _log.Info("update", $"downloading {info.Version} ({info.SizeBytes / 1024 / 1024} MB)");
            var sha = await _api.DownloadAgentAsync(_platform.UpdateChannel, path, budget.Token);

            var sizeOk = info.SizeBytes <= 0 || (File.Exists(path) && new FileInfo(path).Length == info.SizeBytes);
            if (sha is null || !sizeOk || !string.Equals(sha, info.Sha256.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                Fail(info.Version, sha is null ? "download failed" : "checksum or size mismatch");
                try { if (File.Exists(path)) File.Delete(path); } catch { }
                return false;
            }

            // Security review S-01, S-08: with the owner's key built in, only a signed build runs,
            // and what runs is the verified copy, held open so nothing can swap it before launch.
            var launchPath = path;
            FileStream? held = null;
            if (TrustedKey is { } key)
            {
                var verified = Path.Combine(_platform.Paths.TempDir, $"rxvision-{Clean(info.Version)}-verified{ext}");
                held = UpdateSignature.VerifyAndStrip(path, verified, _platform.Name, Clean(info.Version), key, out var problem);
                try { File.Delete(path); } catch { }
                if (held is null)
                {
                    Fail(info.Version, $"refused: {problem}");
                    return false;
                }
                launchPath = verified;
            }
            // Audit F-01: a build without the key still installs on the server's checksum; it does
            // not refuse. The agents already on people's machines carry no key, and this is how
            // they take the first signed build (build/signing/README.md, "The first signed
            // release"); refusing here would leave them on an unsigned build for good. The gap is
            // closed where the build is made instead: a release build without the key does not
            // build unless asked for on purpose (RxvAllowUnsignedUpdates), says so beside its
            // version, and the publish scripts never upload it.
            else if (!_unsignedNoted)
            {
                _unsignedNoted = true;
                _log.Warn("update", "update signing is not set up in this build; trusting the server's checksum");
            }

            using (held)
            {
                _log.Info("update", $"verified {info.Version}; starting the installer");
                // Recorded first: once the installer runs, this process is stopped. The
                // next start compares it with the running version (ReconcileLastAttempt).
                _attemptVersion = info.Version;
                _attemptAt = DateTimeOffset.UtcNow;
                SaveState();
                if (_platform.Updater.Launch(launchPath, info.Version))
                {
                    ExitForUpdate?.Invoke();
                    return true;
                }
            }
            _attemptVersion = null;
            Fail(info.Version, "installer did not start");
            return false;
        }
        catch (Exception ex)
        {
            _log.Warn("update", "check failed", ex);
            return false;
        }
        finally
        {
            Interlocked.Exchange(ref _busy, 0);
        }
    }

    /// <summary>
    /// For an app that cannot replace itself: saves the current build into the
    /// person's Downloads folder, checked against the published SHA-256 exactly
    /// like an automatic update, so they can install it by hand. Never runs it.
    /// (Opening the download link in a browser would not work: it needs the
    /// agent's sign-in.)
    /// </summary>
    public async Task<ManualDownload> DownloadForManualInstallAsync(CancellationToken ct = default)
    {
        if (!_api.IsSignedIn) return new ManualDownload(null, "Sign in to download the update.");
        if (Interlocked.Exchange(ref _busy, 1) == 1)
            return new ManualDownload(null, "An update check is running. Try again in a minute.");
        string? part = null;
        try
        {
            var result = await _api.GetAgentVersionAsync(_platform.UpdateChannel, ct);
            if (result.Transient) return new ManualDownload(null, "Can't reach RX Vision. Try again in a moment.");
            if (!result.Ok || result.Data is not { Available: true } info || string.IsNullOrWhiteSpace(info.Sha256))
                return new ManualDownload(null, "The update isn't available to download right now. Try again later.");

            var folder = DownloadsFolder();
            var dest = Path.Combine(folder, ManualFileName(info.FileName, info.Version, _platform.UpdateChannel, _platform.Name));
            part = dest + ".part";
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
            budget.CancelAfter(TimeSpan.FromMinutes(20));
            _log.Info("update", $"downloading {info.Version} for a manual install");
            var sha = await _api.DownloadAgentAsync(_platform.UpdateChannel, part, budget.Token);
            if (sha is null) return new ManualDownload(null, "The download didn't finish. Try again in a moment.");

            var sizeOk = info.SizeBytes <= 0 || new FileInfo(part).Length == info.SizeBytes;
            if (!sizeOk || !string.Equals(sha, info.Sha256.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                _log.Warn("update", $"{info.Version}: manual download failed the checksum or size check");
                return new ManualDownload(null, "The download didn't match the published build, so it was deleted. Try again later.");
            }
            if (TrustedKey is { } key)
            {
                // The saved copy is the verified one, without its signature (S-01).
                using var held = UpdateSignature.VerifyAndStrip(part, dest, _platform.Name, Clean(info.Version), key, out var problem);
                if (held is null)
                {
                    _log.Warn("update", $"{info.Version}: manual download refused: {problem}");
                    return new ManualDownload(null, "Try the download again soon. That copy didn't match, so it was removed.");
                }
            }
            // No key in this build: saved on the server's checksum, as CheckAsync installs (F-01).
            else File.Move(part, dest, overwrite: true);
            if (File.Exists(part)) { try { File.Delete(part); } catch { } }
            part = null;
            _log.Info("update", $"saved {info.Version} for a manual install");
            return new ManualDownload(dest, null);
        }
        catch (Exception ex)
        {
            _log.Warn("update", "manual download failed", ex);
            return new ManualDownload(null, "Couldn't save the update. Try again in a moment.");
        }
        finally
        {
            if (part is not null)
            {
                try { if (File.Exists(part)) File.Delete(part); } catch { }
            }
            Interlocked.Exchange(ref _busy, 0);
        }
    }

    /// <summary>~/Downloads when it exists, else the agent's temp folder.</summary>
    private string DownloadsFolder()
    {
        if (_downloadsFolder is not null) return _downloadsFolder;
        try
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var downloads = string.IsNullOrEmpty(home) ? null : Path.Combine(home, "Downloads");
            if (downloads is not null && Directory.Exists(downloads)) return downloads;
        }
        catch
        {
            // Fall through to the temp folder.
        }
        Directory.CreateDirectory(_platform.Paths.TempDir);
        return _platform.Paths.TempDir;
    }

    /// <summary>
    /// "RXVision-mac-3.1.0.zip": the server's file name with the version added, so
    /// an older download is never overwritten. Only safe characters survive.
    /// </summary>
    public static string ManualFileName(string? serverName, string version, string channel, string platformName)
    {
        static string Safe(string s) => new(s.Where(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '_').ToArray());
        var name = Safe(Path.GetFileName(serverName ?? "")).Trim('.');
        var ext = Path.GetExtension(name);
        if (ext is not (".zip" or ".exe")) ext = platformName == "windows" ? ".exe" : ".zip";
        var stem = Safe(Path.GetFileNameWithoutExtension(name)).Trim('.');
        if (stem.Length == 0) stem = "RXVision-" + Safe(channel);
        var v = Safe(Clean(version));
        return v.Length == 0 ? stem + ext : $"{stem}-{v}{ext}";
    }

    private void Fail(string version, string why, TimeSpan? block = null)
    {
        var n = _failures.TryGetValue(version, out var f) ? f.failures + 1 : 1;
        var wait = block ?? TimeSpan.FromMinutes(Math.Min(24 * 60, 15 * Math.Pow(2, n - 1)));
        _failures[version] = (n, DateTimeOffset.UtcNow + wait);
        _log.Warn("update", $"{version}: {why}; next try in {wait.TotalMinutes:F0} min");
        SaveState();
    }

    /// <summary>
    /// After a start: if the last installer run was for a newer version than the
    /// one running, it did not take (it rolled back, or the build inside was
    /// labelled wrong). Refuse that version for a day instead of looping.
    /// </summary>
    private void ReconcileLastAttempt()
    {
        if (_attemptVersion is not { } attempted) return;
        _attemptVersion = null;
        if (IsNewer(attempted, _currentVersion))
        {
            Fail(attempted, $"was installed at {_attemptAt:u} but {_currentVersion} is running", DidNotTakeBlock);
        }
        else
        {
            _failures.Remove(attempted);
            _log.Info("update", $"now running {_currentVersion}");
            SaveState();
        }
    }

    private sealed class State
    {
        public string? AttemptVersion { get; set; }
        public DateTimeOffset AttemptAt { get; set; }
        public Dictionary<string, Entry> Failures { get; set; } = new();
    }

    private sealed class Entry
    {
        public int Failures { get; set; }
        public DateTimeOffset RetryAfter { get; set; }
    }

    private void LoadState()
    {
        try
        {
            if (!File.Exists(_statePath)) return;
            var state = JsonSerializer.Deserialize<State>(File.ReadAllText(_statePath), Json.Options);
            if (state is null) return;
            _attemptVersion = string.IsNullOrWhiteSpace(state.AttemptVersion) ? null : state.AttemptVersion;
            _attemptAt = state.AttemptAt;
            var now = DateTimeOffset.UtcNow;
            foreach (var (version, e) in state.Failures)
            {
                // Never trust a far-future date from a broken clock: a day at most.
                if (e.RetryAfter > now) _failures[version] = (e.Failures, e.RetryAfter > now + DidNotTakeBlock ? now + DidNotTakeBlock : e.RetryAfter);
            }
        }
        catch (Exception ex)
        {
            _log.Warn("update", "update state unreadable; starting fresh", ex);
        }
    }

    private void SaveState()
    {
        try
        {
            var now = DateTimeOffset.UtcNow;
            var state = new State
            {
                AttemptVersion = _attemptVersion,
                AttemptAt = _attemptAt,
                Failures = _failures.Where(f => f.Value.retryAfter > now)
                    .ToDictionary(f => f.Key, f => new Entry { Failures = f.Value.failures, RetryAfter = f.Value.retryAfter }),
            };
            AtomicFile.WriteAllBytes(_statePath, JsonSerializer.SerializeToUtf8Bytes(state, Json.Options));
        }
        catch (Exception ex)
        {
            _log.Warn("update", "could not save the update state", ex);
        }
    }

    public void Dispose() => Stop();
}
