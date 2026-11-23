using System.Diagnostics;
using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Platform.Windows.Native;

namespace RXVision.Agent.Platform.Windows.Probes;

/// <summary>
/// The call detectors' window read (AGENT.md section 6): <c>EnumWindows</c>, reading a title and
/// a class only for windows of the listed processes, so no other window is read. A browser's
/// tabs come from UI Automation, only while a call in that browser is being tracked. Never throws.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsCallWindowProbe : ICallWindowProbe
{
    private readonly BrowserHost _browser;

    public WindowsCallWindowProbe(Action<string>? log) => _browser = new BrowserHost(log);

    public IReadOnlyList<CallWindow> WindowsOf(IReadOnlyCollection<string> owners)
    {
        try
        {
            var byPid = ProcessIds(owners);
            var found = new List<CallWindow>();
            if (byPid.Count == 0) return found;
            NativeMethods.EnumWindows((hWnd, _) =>
            {
                NativeMethods.GetWindowThreadProcessId(hWnd, out var pid);
                if (byPid.TryGetValue(pid, out var owner) && NativeMethods.IsWindowVisible(hWnd))
                    found.Add(new CallWindow(owner, NativeMethods.ForegroundTitle(hWnd), NativeMethods.ClassNameOf(hWnd)));
                return true;
            }, IntPtr.Zero);
            return found;
        }
        catch
        {
            return Array.Empty<CallWindow>();
        }
    }

    public IReadOnlyList<string> TabTitlesOf(string browserOwner)
    {
        try
        {
            var byPid = ProcessIds(new[] { browserOwner });
            var handles = new List<IntPtr>();
            NativeMethods.EnumWindows((hWnd, _) =>
            {
                NativeMethods.GetWindowThreadProcessId(hWnd, out var pid);
                if (byPid.ContainsKey(pid) && NativeMethods.IsWindowVisible(hWnd) && NativeMethods.ForegroundTitle(hWnd) is not null) handles.Add(hWnd);
                return true;
            }, IntPtr.Zero);
            return handles.SelectMany(_browser.TabTitles).ToList();
        }
        catch
        {
            return Array.Empty<string>();
        }
    }

    private static Dictionary<uint, string> ProcessIds(IEnumerable<string> names)
    {
        var byPid = new Dictionary<uint, string>();
        foreach (var name in names)
        {
            foreach (var process in Process.GetProcessesByName(name))
            {
                using (process) byPid[(uint)process.Id] = name;
            }
        }
        return byPid;
    }
}
