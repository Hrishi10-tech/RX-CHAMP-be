using System.Collections.Concurrent;
using System.Text;
using System.Threading.Channels;

namespace RXVision.Agent.Core.Util;

public enum LogLevel { Debug, Info, Warn, Error }

public interface ILog
{
    void Write(LogLevel level, string area, string message, Exception? error = null);
}

public static class LogExtensions
{
    public static void Debug(this ILog log, string area, string message) => log.Write(LogLevel.Debug, area, message);
    public static void Info(this ILog log, string area, string message) => log.Write(LogLevel.Info, area, message);
    public static void Warn(this ILog log, string area, string message, Exception? e = null) => log.Write(LogLevel.Warn, area, message, e);
    public static void Error(this ILog log, string area, string message, Exception? e = null) => log.Write(LogLevel.Error, area, message, e);
}

/// <summary>Discards everything (tests).</summary>
public sealed class NullLog : ILog
{
    public static readonly NullLog Instance = new();
    public void Write(LogLevel level, string area, string message, Exception? error = null) { }
}

/// <summary>Collects entries in memory (tests).</summary>
public sealed class MemoryLog : ILog
{
    public ConcurrentQueue<string> Lines { get; } = new();
    public void Write(LogLevel level, string area, string message, Exception? error = null) =>
        Lines.Enqueue($"{level} {area}: {message}{(error is null ? "" : " | " + error.Message)}");
}

/// <summary>
/// Rolling file log: one writer thread, ISO timestamps with the date, 5 files of
/// 1 MB, and the same message repeated within a minute collapsed into a count.
/// Never throws, never blocks the caller.
/// </summary>
public sealed class RollingFileLog : ILog, IDisposable
{
    private const long MaxBytes = 1024 * 1024;
    private const int MaxFiles = 5;

    private readonly string _dir;
    private readonly string _baseName;
    private readonly Channel<string> _channel = Channel.CreateBounded<string>(
        new BoundedChannelOptions(5000) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
    private readonly Task _writer;
    private readonly ConcurrentDictionary<string, (DateTime first, int count)> _recent = new();
    private readonly LogLevel _minLevel;

    public RollingFileLog(string dir, string baseName = "agent", LogLevel minLevel = LogLevel.Info)
    {
        _dir = dir;
        _baseName = baseName;
        _minLevel = minLevel;
        try { Directory.CreateDirectory(dir); } catch { /* logging must never stop the agent */ }
        _writer = Task.Run(WriteLoopAsync);
    }

    public string CurrentFile => Path.Combine(_dir, $"{_baseName}.log");

    public void Write(LogLevel level, string area, string message, Exception? error = null)
    {
        if (level < _minLevel) return;
        var key = $"{level}|{area}|{message}";
        var now = DateTime.UtcNow;
        var entry = _recent.AddOrUpdate(key, _ => (now, 1), (_, v) => (v.first, v.count + 1));
        if (entry.count > 1 && now - entry.first < TimeSpan.FromMinutes(1))
        {
            // Said already this minute: count it, write it again only every 50th time.
            if (entry.count % 50 != 0) return;
            message += $" (x{entry.count} in the last minute)";
        }
        else if (entry.count > 1)
        {
            _recent[key] = (now, 1);
        }
        if (_recent.Count > 2000) _recent.Clear();

        var sb = new StringBuilder(160);
        sb.Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff zzz")).Append(' ')
          .Append(level.ToString().ToUpperInvariant()).Append(' ')
          .Append(area).Append(": ").Append(message);
        if (error is not null) sb.Append(" | ").Append(error.GetType().Name).Append(": ").Append(error.Message);
        _channel.Writer.TryWrite(sb.ToString());
    }

    private async Task WriteLoopAsync()
    {
        await foreach (var line in _channel.Reader.ReadAllAsync())
        {
            try
            {
                RollIfNeeded();
                await File.AppendAllTextAsync(CurrentFile, line + Environment.NewLine);
            }
            catch
            {
                // A full disk or a locked file must not take the agent down.
            }
        }
    }

    private void RollIfNeeded()
    {
        var info = new FileInfo(CurrentFile);
        if (!info.Exists || info.Length < MaxBytes) return;
        for (var i = MaxFiles - 1; i >= 1; i--)
        {
            var src = Path.Combine(_dir, i == 1 ? $"{_baseName}.log" : $"{_baseName}.{i - 1}.log");
            var dst = Path.Combine(_dir, $"{_baseName}.{i}.log");
            if (File.Exists(src)) File.Move(src, dst, overwrite: true);
        }
    }

    public void Dispose()
    {
        _channel.Writer.TryComplete();
        try { _writer.Wait(TimeSpan.FromSeconds(2)); } catch { }
    }
}
