using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Text;

// ============================================================================
// RX Champ Agent — self-extracting installer.
//
// The employee downloads ONE .exe and double-clicks it. This bootstrapper:
//   1. Extracts the embedded WinUI agent into %LOCALAPPDATA%\RXChampAgent.
//   2. Reads the per-user enrollment appended to its own file (the backend
//      appends [configJson][uint32-LE len][magic "TCAGCFG1"]) and writes it as
//      tc-enroll.json into the install folder, so the agent auto-enrolls.
//   3. Launches the agent and exits.
// A plain .NET single-file exe (unlike WinUI) tolerates the appended trailer.
// ============================================================================

const string Magic = "TCAGCFG1";

try
{
    var installDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "RXChampAgent");
    Directory.CreateDirectory(installDir);
    var exePath = Path.Combine(installDir, "TimeChampAgent.exe");
    var stampPath = Path.Combine(installDir, ".appstamp");

    // Extract when not installed OR when this download is a newer build (the
    // embedded payload size acts as a build stamp). Re-extract stops a running
    // agent first so its files aren't locked.
    var stamp = PayloadStamp();
    var installed = File.Exists(exePath) &&
                    File.Exists(stampPath) &&
                    File.ReadAllText(stampPath).Trim() == stamp;
    if (!installed)
    {
        StopRunningAgent();
        ExtractPayload(installDir);
        File.WriteAllText(stampPath, stamp);
    }

    // Drop in this download's per-user enrollment (refreshed every run).
    TryWriteEnroll(installDir);

    if (File.Exists(exePath))
    {
        Process.Start(new ProcessStartInfo(exePath)
        {
            UseShellExecute = true,
            WorkingDirectory = installDir,
        });
    }
    else
    {
        Fail("The agent files could not be installed. Please contact your administrator.");
    }
}
catch (Exception ex)
{
    Fail("Couldn't install the RX Champ agent.\n\n" + ex.Message);
}

static void ExtractPayload(string installDir)
{
    using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.zip");
    if (s is null) throw new InvalidOperationException("Installer payload is missing.");
    using var archive = new ZipArchive(s, ZipArchiveMode.Read);
    archive.ExtractToDirectory(installDir, overwriteFiles: true);
}

/// <summary>Build stamp for the embedded payload (its byte length). Changes whenever
/// the agent is rebuilt, so a re-download refreshes an existing install.</summary>
static string PayloadStamp()
{
    using var s = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.zip");
    return s is null ? "0" : s.Length.ToString();
}

/// <summary>Stops any running agent so its files can be overwritten.</summary>
static void StopRunningAgent()
{
    try
    {
        foreach (var p in Process.GetProcessesByName("TimeChampAgent"))
        {
            try { p.Kill(); p.WaitForExit(4000); } catch { }
        }
    }
    catch { }
}

/// <summary>Reads the config trailer appended to this exe and writes tc-enroll.json.</summary>
static void TryWriteEnroll(string installDir)
{
    try
    {
        var self = Environment.ProcessPath;
        if (string.IsNullOrEmpty(self) || !File.Exists(self)) return;

        var magic = Encoding.ASCII.GetBytes(Magic);
        using var fs = File.OpenRead(self);
        if (fs.Length < magic.Length + 4) return;

        var tail = new byte[magic.Length];
        fs.Seek(-magic.Length, SeekOrigin.End);
        fs.ReadExactly(tail);
        for (var i = 0; i < magic.Length; i++)
            if (tail[i] != magic[i]) return; // no trailer (generic build)

        var lenBytes = new byte[4];
        fs.Seek(-(magic.Length + 4), SeekOrigin.End);
        fs.ReadExactly(lenBytes);
        var len = BitConverter.ToUInt32(lenBytes, 0);
        if (len == 0 || len > 64 * 1024 || len > fs.Length) return;

        var json = new byte[len];
        fs.Seek(-(magic.Length + 4 + (long)len), SeekOrigin.End);
        fs.ReadExactly(json);

        File.WriteAllBytes(Path.Combine(installDir, "tc-enroll.json"), json);
    }
    catch
    {
        // Non-fatal: the agent will just fall back to the login screen.
    }
}

static void Fail(string message)
{
    // Minimal message box via Win32 so we don't pull in WinForms/WPF.
    MessageBoxW(IntPtr.Zero, message, "RX Champ Agent", 0x10 /* MB_ICONERROR */);
}

[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);
