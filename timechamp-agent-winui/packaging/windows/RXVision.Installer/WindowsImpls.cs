using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace RXVision.Installer;

/// <summary>Stops and starts agents with System.Diagnostics.Process.</summary>
internal sealed class ProcessControl : IProcessControl
{
    private readonly TimeSpan _grace;

    /// <param name="grace">How long a running agent may take to exit by itself before it is stopped.</param>
    public ProcessControl(TimeSpan grace) => _grace = grace;

    public void StopAgents(IEnumerable<string> processNames)
    {
        int selfId, sessionId;
        using (var self = Process.GetCurrentProcess())
        {
            selfId = self.Id;
            sessionId = self.SessionId;
        }
        foreach (var name in processNames)
        {
            Process[] running;
            try { running = Process.GetProcessesByName(name); }
            catch { continue; }
            foreach (var p in running)
            {
                try
                {
                    // Never this installer (the per-user download is saved as RXVision.exe,
                    // so it shares the agent's process name), and never another person's
                    // agent on a shared machine.
                    if (p.Id == selfId || p.SessionId != sessionId) continue;
                    if (_grace > TimeSpan.Zero && p.WaitForExit((int)_grace.TotalMilliseconds)) continue;
                    // The agent process only. Kill(entireProcessTree: true) throws when this
                    // installer is the agent's child (every --update), leaving the agent
                    // running, and otherwise also kills whatever the agent started, such
                    // as the browser it opened a link in.
                    p.Kill();
                    p.WaitForExit(10_000);
                }
                catch { /* already gone or access denied */ }
                finally { p.Dispose(); }
            }
        }
    }

    public IAgentProcess? Start(string exePath, string? arguments, string workingDir)
    {
        try
        {
            var psi = new ProcessStartInfo(exePath)
            {
                UseShellExecute = true,
                WorkingDirectory = workingDir,
            };
            if (!string.IsNullOrEmpty(arguments)) psi.ArgumentList.Add(arguments);
            var process = Process.Start(psi);
            return process is null ? null : new StartedProcess(process);
        }
        catch
        {
            return null;
        }
    }

    private sealed class StartedProcess : IAgentProcess
    {
        private readonly Process _process;
        public StartedProcess(Process process) => _process = process;

        public bool IsRunning
        {
            get
            {
                try { return !_process.HasExited; }
                catch { return false; }
            }
        }
    }
}

/// <summary>The embedded payload/app.zip: its SHA-256 (the build stamp) and extraction.</summary>
internal sealed class EmbeddedPayload : IPayloadSource
{
    private const string ResourceName = "app.zip";

    public string Sha256()
    {
        using var stream = Open();
        using var sha = SHA256.Create();
        return Convert.ToHexString(sha.ComputeHash(stream)).ToLowerInvariant();
    }

    public void ExtractTo(string destDir)
    {
        Directory.CreateDirectory(destDir);
        using var stream = Open();
        using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
        archive.ExtractToDirectory(destDir, overwriteFiles: true);
    }

    private static Stream Open() =>
        Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
        ?? throw new InvalidOperationException("Installer payload (app.zip) is missing.");
}

/// <summary>Appends timestamped lines to the installer log under the install root.</summary>
internal sealed class FileInstallLog : IInstallLog
{
    private readonly string _logFile;

    public FileInstallLog(string logFile)
    {
        _logFile = logFile;
        try { Directory.CreateDirectory(Path.GetDirectoryName(logFile)!); } catch { }
    }

    public void Line(string message)
    {
        try
        {
            File.AppendAllText(_logFile, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff zzz} {message}{Environment.NewLine}");
        }
        catch { /* logging must never stop the install */ }
    }
}

/// <summary>A Win32 message box, suppressed for a silent update.</summary>
internal sealed class Win32MessageBox : IMessageBox
{
    private const uint MB_ICONERROR = 0x10;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);

    public void Error(string message)
    {
        try { MessageBoxW(IntPtr.Zero, message, "RX Vision Installer", MB_ICONERROR); }
        catch { }
    }
}

/// <summary>Collects the installer's errors and shows them later, after the install lock is released.</summary>
internal sealed class DeferredMessageBox : IMessageBox
{
    private readonly List<string> _pending = new();

    public void Error(string message) => _pending.Add(message);

    public void ShowPending()
    {
        var box = new Win32MessageBox();
        foreach (var message in _pending) box.Error(message);
        _pending.Clear();
    }
}

internal sealed class ThreadWaiter : IWaiter
{
    public void Wait(TimeSpan duration) { try { Thread.Sleep(duration); } catch { } }
}

/// <summary>HKCU Run values via advapi32 (no Microsoft.Win32.Registry package).</summary>
internal sealed class RunKeyStore : IRunKeyStore
{
    private static readonly IntPtr HKEY_CURRENT_USER = new(unchecked((int)0x80000001));
    private const string RunSubKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const int KEY_QUERY_VALUE = 0x0001;
    private const int KEY_SET_VALUE = 0x0002;
    private const int REG_SZ = 1;
    private const int ERROR_SUCCESS = 0;
    private const int ERROR_MORE_DATA = 234;

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegOpenKeyExW(IntPtr hKey, string lpSubKey, int ulOptions, int samDesired, out IntPtr phkResult);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegCreateKeyExW(IntPtr hKey, string lpSubKey, int Reserved, string? lpClass, int dwOptions, int samDesired, IntPtr lpSecurityAttributes, out IntPtr phkResult, out int lpdwDisposition);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegSetValueExW(IntPtr hKey, string lpValueName, int Reserved, int dwType, byte[] lpData, int cbData);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegQueryValueExW(IntPtr hKey, string lpValueName, IntPtr lpReserved, out int lpType, byte[]? lpData, ref int lpcbData);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int RegDeleteValueW(IntPtr hKey, string lpValueName);

    [DllImport("advapi32.dll")]
    private static extern int RegCloseKey(IntPtr hKey);

    public void Set(string name, string value)
    {
        if (RegCreateKeyExW(HKEY_CURRENT_USER, RunSubKey, 0, null, 0, KEY_SET_VALUE, IntPtr.Zero, out var key, out _) != ERROR_SUCCESS)
            return;
        try
        {
            var data = Encoding.Unicode.GetBytes(value + "\0");
            RegSetValueExW(key, name, 0, REG_SZ, data, data.Length);
        }
        finally { RegCloseKey(key); }
    }

    public void Delete(string name)
    {
        if (RegOpenKeyExW(HKEY_CURRENT_USER, RunSubKey, 0, KEY_SET_VALUE, out var key) != ERROR_SUCCESS) return;
        try { RegDeleteValueW(key, name); }
        finally { RegCloseKey(key); }
    }

    public string? Get(string name)
    {
        if (RegOpenKeyExW(HKEY_CURRENT_USER, RunSubKey, 0, KEY_QUERY_VALUE, out var key) != ERROR_SUCCESS) return null;
        try
        {
            var cb = 0;
            var probe = RegQueryValueExW(key, name, IntPtr.Zero, out _, null, ref cb);
            if ((probe != ERROR_SUCCESS && probe != ERROR_MORE_DATA) || cb <= 0) return null;
            var data = new byte[cb];
            if (RegQueryValueExW(key, name, IntPtr.Zero, out var type, data, ref cb) != ERROR_SUCCESS || type != REG_SZ) return null;
            return Encoding.Unicode.GetString(data, 0, cb / 2 * 2).TrimEnd('\0');
        }
        finally { RegCloseKey(key); }
    }
}
