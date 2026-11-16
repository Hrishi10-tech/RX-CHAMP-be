using System.Collections.Concurrent;
using RXVision.Agent.Services;

namespace RXVision.Agent.E2E.Tests;

/// <summary>
/// A UI thread for the view models: one thread with its own synchronization context, so
/// the facade's events and the view models' awaits run there in order, as in the app.
/// </summary>
public sealed class UiThread : IUiDispatcher, IDisposable
{
    private readonly BlockingCollection<(SendOrPostCallback Work, object? State)> _queue = new();
    private readonly Thread _thread;

    public UiThread()
    {
        _thread = new Thread(Loop) { IsBackground = true, Name = "E2E UI" };
        _thread.Start();
    }

    private void Loop()
    {
        SynchronizationContext.SetSynchronizationContext(new Context(this));
        foreach (var (work, state) in _queue.GetConsumingEnumerable())
        {
            try { work(state); }
            catch { /* a handler's failure is the facade's to log */ }
        }
    }

    public void Post(Action action) => Enqueue(_ => action(), null);

    private void Enqueue(SendOrPostCallback work, object? state)
    {
        if (!_queue.IsAddingCompleted) _queue.Add((work, state));
    }

    /// <summary>Runs <paramref name="work"/> on the UI thread and waits for it (and what it awaits).</summary>
    public Task<T> RunAsync<T>(Func<Task<T>> work)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        Post(async () =>
        {
            try { tcs.SetResult(await work()); }
            catch (Exception ex) { tcs.SetException(ex); }
        });
        return tcs.Task;
    }

    public Task RunAsync(Func<Task> work) => RunAsync(async () => { await work(); return true; });

    public Task<T> Run<T>(Func<T> work) => RunAsync(() => Task.FromResult(work()));

    public Task Run(Action work) => RunAsync(() => { work(); return Task.FromResult(true); });

    /// <summary>Everything posted so far has run.</summary>
    public Task Drain() => Run(() => { });

    public void Dispose() => _queue.CompleteAdding();

    private sealed class Context : SynchronizationContext
    {
        private readonly UiThread _ui;
        public Context(UiThread ui) => _ui = ui;
        public override void Post(SendOrPostCallback d, object? state) => _ui.Enqueue(d, state);
        public override void Send(SendOrPostCallback d, object? state) => throw new NotSupportedException();
        public override SynchronizationContext CreateCopy() => this;
    }
}
