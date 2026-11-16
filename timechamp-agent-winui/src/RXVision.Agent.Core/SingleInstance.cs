using System.IO.Pipes;
using System.Text;

namespace RXVision.Agent.Core;

/// <summary>
/// One agent per user session. The first instance holds a lock file and listens
/// on a named pipe; a second launch (the user double-clicks the app again) asks
/// the first to show its dashboard and exits.
/// </summary>
public sealed class SingleInstance : IDisposable
{
    private readonly FileStream _lock;
    private readonly string _pipeName;
    private readonly CancellationTokenSource _cts = new();

    private SingleInstance(FileStream lockFile, string pipeName)
    {
        _lock = lockFile;
        _pipeName = pipeName;
        _ = Task.Run(ListenAsync);
    }

    /// <summary>Raised (background thread) when another launch asked this one to show itself.</summary>
    public event Action<string>? Activated;

    /// <summary>The first instance gets an object; a second one gets null after signalling the first.</summary>
    public static SingleInstance? TryAcquire(string dataDir, string message = "show")
    {
        var pipeName = "RXVisionAgent-" + Environment.UserName.Replace(' ', '_');
        try
        {
            Directory.CreateDirectory(dataDir);
            var fs = new FileStream(Path.Combine(dataDir, "agent.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            return new SingleInstance(fs, pipeName);
        }
        catch (IOException)
        {
            Signal(pipeName, message);
            return null;
        }
    }

    private static void Signal(string pipeName, string message)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.Out);
            client.Connect(2000);
            var bytes = Encoding.UTF8.GetBytes(message);
            client.Write(bytes, 0, bytes.Length);
        }
        catch
        {
            // The other instance is starting or stuck; nothing more to do.
        }
    }

    private async Task ListenAsync()
    {
        while (!_cts.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(_pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                await server.WaitForConnectionAsync(_cts.Token);
                var buffer = new byte[256];
                var read = await server.ReadAsync(buffer, _cts.Token);
                Activated?.Invoke(Encoding.UTF8.GetString(buffer, 0, read));
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch
            {
                await Task.Delay(1000);
            }
        }
    }

    public void Dispose()
    {
        _cts.Cancel();
        _lock.Dispose();
    }
}
