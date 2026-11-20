using RXVision.Agent.Core.Util;
using RXVision.Agent.Platform.Mac;
using Xunit;

namespace RXVision.Agent.Platform.Mac.Tests;

/// <summary>Security review S-09: full-size capture files a crash left behind are removed at start.</summary>
public class CaptureLeftoverTests
{
    [Fact]
    public void Old_capture_files_go_and_one_being_written_now_stays()
    {
        var dir = Directory.CreateTempSubdirectory().FullName;
        var old = Path.Combine(dir, "cap-old.jpg");
        var fresh = Path.Combine(dir, "cap-fresh.jpg");
        var other = Path.Combine(dir, "rxvision-3.6.1.zip");
        foreach (var f in new[] { old, fresh, other }) File.WriteAllBytes(f, new byte[] { 1 });
        var now = DateTime.UtcNow;
        File.SetLastWriteTimeUtc(old, now.AddMinutes(-10));
        File.SetLastWriteTimeUtc(other, now.AddMinutes(-10));

        Assert.Equal(1, MacScreenCapture.SweepLeftovers(dir, now, NullLog.Instance));
        Assert.False(File.Exists(old));
        Assert.True(File.Exists(fresh));
        Assert.True(File.Exists(other));
    }
}
