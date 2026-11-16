using System.Runtime.Versioning;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Platform.Windows.Native;

namespace RXVision.Agent.Platform.Windows.Probes;

/// <summary>Time since the last keyboard or mouse input, system-wide, via GetLastInputInfo.</summary>
[SupportedOSPlatform("windows")]
internal sealed class WindowsIdleProbe : IIdleProbe
{
    public TimeSpan IdleTime()
    {
        try
        {
            var info = new NativeMethods.LASTINPUTINFO { cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.LASTINPUTINFO>() };
            if (!NativeMethods.GetLastInputInfo(ref info)) return TimeSpan.Zero;
            return IdleMath.Idle(info.dwTime, NativeMethods.GetTickCount());
        }
        catch
        {
            return TimeSpan.Zero;
        }
    }
}
