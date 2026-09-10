using System.Diagnostics;
using System.IO;
using System.Reflection;

namespace TimeChampAgent.Services;

/// <summary>
/// Keeps this machine on the current agent build without anyone visiting it.
///
/// Every agent change used to mean reinstalling on every employee's PC, which is
/// slow enough that fixes queue up instead of shipping. So the agent asks the
/// server what the current version is, and when it is behind it fetches the
/// installer and hands over to it.
///
/// The installer is deliberately the thing that does the swapping. A running exe
/// cannot overwrite itself, and the installer already stops the agent, replaces the
/// files and relaunches — code that has been doing exactly that in the field since
/// day one. Reusing it means self-update adds no new file-swapping logic to get
/// wrong; run with <c>--update</c> it does the same job without a word on screen.
///
/// Everything here fails towards "carry on as you are". A server that cannot be
/// reached, a download that arrives wrong, a disk with no room — each ends the
/// attempt and leaves a working agent running. The one outcome that must never
/// happen is a machine left with no agent at all.
/// </summary>
public sealed class UpdateService
{
    private readonly ApiClient _api;
    private readonly AgentConfig _config;

    /// <summary>The version whose download keeps arriving wrong, and how often.
    ///
    /// A download can break for a passing reason — the machine shut down partway, wifi
    /// moved between access points — and giving up on the first bad copy would leave
    /// that machine quietly behind for no good reason. A few attempts covers bad luck;
    /// past that the release itself is the likely problem and hammering it all day
    /// helps nobody.</summary>
    private string? _failing;
    private int _failures;

    private const int MaxAttempts = 3;

    private bool _busy;

    /// <summary>
    /// Records the version this machine last handed to the installer, and survives
    /// the restart because the installer only overwrites files it ships.
    ///
    /// It guards against the one mistake that would be genuinely disruptive: a build
    /// published under a version number higher than the one compiled into it. Every
    /// agent would install it, come back still behind, and do the whole thing again
    /// on the next check — fifty machines reinstalling all day. Having tried a
    /// version once and got nowhere, the agent stops instead.
    /// </summary>
    private static string MarkerPath => Path.Combine(AppContext.BaseDirectory, ".update-attempt");

    public UpdateService(ApiClient api, AgentConfig config)
    {
        _api = api;
        _config = config;
    }

    /// <summary>This build's version, four-part so comparisons are unsurprising.</summary>
    public static Version Current => Normalise(
        Assembly.GetExecutingAssembly().GetName().Version ?? new Version(0, 0, 0, 0));

    /// <summary>
    /// Checks for a newer build and, if there is one, launches it.
    ///
    /// Returns true only when the installer is actually running, which is the
    /// caller's signal to shut this agent down so its files are free. False means
    /// nothing happened and tracking should carry on untouched.
    ///
    /// It deliberately does not wait for the user to be away. Restarting costs a few
    /// seconds, and with samples a minute apart and gaps under two and a half minutes
    /// not even counted, that is nothing measurable. Waiting for a break, meanwhile,
    /// would start a hundred-megabyte download at the exact moment a laptop is about
    /// to sleep — buying nothing and risking the one thing that matters.
    /// </summary>
    public async Task<bool> TryUpdateAsync(CancellationToken ct = default)
    {
        if (!_config.AutoUpdate || _busy) return false;
        _busy = true;
        try
        {
            ClearMarkerIfLanded();

            var info = await _api.GetAgentVersionAsync(ct);
            if (info is null || !info.Available) return false;
            if (info.Version == _failing && _failures >= MaxAttempts) return false;
            if (!Version.TryParse(info.Version, out var offered)) return false;
            if (Normalise(offered) <= Current) return false;

            // Already installed this version once and still not running it, so
            // installing it again will not help. Almost always means the published
            // version number doesn't match the build it labels.
            if (AlreadyAttempted(info.Version))
            {
                App.Log($"update {info.Version} already installed once and still on {Current} — not retrying");
                return false;
            }

            // No checksum means the server cannot say what the bytes should be. The
            // agent takes screenshots and reports activity, so an unverifiable
            // replacement for it is not worth having — wait for a published one.
            if (info.Sha256.Length == 0)
            {
                App.Log($"update {info.Version} offered without a checksum — declined");
                return false;
            }

            var staged = await StageAsync(info, ct);
            if (staged is null) return false;

            App.Log($"updating {Current} -> {info.Version}");
            if (!Launch(staged)) return false;

            // Only once the installer is genuinely running. Recorded any earlier, a
            // launch that failed for a passing reason would look like an attempt that
            // achieved nothing, and this version would never be offered again.
            RecordAttempt(info.Version);
            return true;
        }
        catch (Exception ex)
        {
            App.Log("update check failed: " + ex.Message);
            return false;
        }
        finally
        {
            _busy = false;
        }
    }

    /// <summary>Downloads the installer and returns its path, or null when it cannot
    /// be trusted. Anything that fails here leaves nothing behind on disk.</summary>
    private async Task<string?> StageAsync(AgentVersionInfo info, CancellationToken ct)
    {
        CleanStale();

        var path = Path.Combine(Path.GetTempPath(), $"RXVision-update-{info.Version}.exe");
        try
        {
            if (!HasRoomFor(info.SizeBytes, path)) return null;

            var sha = await _api.DownloadAgentAsync(path, ct);
            if (sha is null) return null;

            var size = new FileInfo(path).Length;
            var sizeMatches = info.SizeBytes <= 0 || size == info.SizeBytes;
            var shaMatches = string.Equals(sha, info.Sha256, StringComparison.OrdinalIgnoreCase);
            if (sizeMatches && shaMatches) return path;

            // Wrong bytes: a truncated download, a proxy in the way, or something
            // worse. Either way this is not the build the server published.
            NoteFailure(info.Version);
            App.Log($"update {info.Version} rejected (attempt {_failures}/{MaxAttempts}) — " +
                    $"expected {info.SizeBytes}b/{info.Sha256}, got {size}b/{sha}");
            TryDelete(path);
            return null;
        }
        catch (Exception ex)
        {
            App.Log("update download failed: " + ex.Message);
            TryDelete(path);
            return null;
        }
    }

    /// <summary>Hands over to the installer. It stops this agent, replaces the files
    /// and starts the new one back up minimised.</summary>
    private static bool Launch(string installerPath)
    {
        try
        {
            var psi = new ProcessStartInfo(installerPath) { UseShellExecute = true };
            psi.ArgumentList.Add("--update");
            return Process.Start(psi) is not null;
        }
        catch (Exception ex)
        {
            App.Log("update launch failed: " + ex.Message);
            return false;
        }
    }

    /// <summary>True when this exact version was already installed from here and the
    /// agent came back no newer for it.</summary>
    private static bool AlreadyAttempted(string version)
    {
        try
        {
            return File.Exists(MarkerPath) &&
                   File.ReadAllText(MarkerPath).Trim() == version;
        }
        catch
        {
            return false;
        }
    }

    private static void RecordAttempt(string version)
    {
        try { File.WriteAllText(MarkerPath, version); } catch { }
    }

    /// <summary>Drops the marker once the agent is genuinely running the version it
    /// last installed — the update worked, so there is nothing left to guard against.</summary>
    private static void ClearMarkerIfLanded()
    {
        try
        {
            if (!File.Exists(MarkerPath)) return;
            var attempted = File.ReadAllText(MarkerPath).Trim();
            if (Version.TryParse(attempted, out var v) && Normalise(v) <= Current)
                File.Delete(MarkerPath);
        }
        catch { }
    }

    /// <summary>Counts a download that arrived wrong, per version, so bad luck gets
    /// another go while a genuinely broken release still stops after a few.</summary>
    private void NoteFailure(string version)
    {
        if (version == _failing) _failures++;
        else { _failing = version; _failures = 1; }
    }

    /// <summary>Room for the download and for the installer to unpack it. Filling a
    /// user's disk to update ourselves would be a poor trade.</summary>
    private static bool HasRoomFor(long sizeBytes, string path)
    {
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(path));
            if (string.IsNullOrEmpty(root)) return true;
            var free = new DriveInfo(root).AvailableFreeSpace;
            var needed = Math.Max(sizeBytes, 0) * 3;
            if (free >= needed) return true;
            App.Log($"update skipped — {free / (1024 * 1024)}MB free, needs {needed / (1024 * 1024)}MB");
            return false;
        }
        catch
        {
            return true; // can't tell; let the download itself be the judge
        }
    }

    /// <summary>Clears installers left behind by an attempt that never completed.</summary>
    private static void CleanStale()
    {
        try
        {
            foreach (var f in Directory.EnumerateFiles(Path.GetTempPath(), "RXVision-update-*.exe"))
                TryDelete(f);
        }
        catch { }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    /// <summary>Pads a version to four parts. Without this "2.1.0" sorts below
    /// "2.1.0.0", because an unspecified component counts as less than zero.</summary>
    private static Version Normalise(Version v) =>
        new(v.Major, v.Minor, Math.Max(v.Build, 0), Math.Max(v.Revision, 0));
}
