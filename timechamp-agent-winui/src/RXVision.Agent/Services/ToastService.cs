using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Services;

/// <summary>Puts a toast on screen beside the button, or takes it away.</summary>
public interface IToastPresenter
{
    void Show(ToastViewModel toast);
    void Hide();
}

/// <summary>
/// One toast at a time, in order. A burst from one sender is one card with a
/// count; the break ring jumps the queue and stays until it is dismissed or
/// withdrawn; nothing shows while a full-screen app is in front (it waits, and
/// anything that waited more than half an hour is dropped: the badge still
/// counts it). Driven by <see cref="Tick"/> once a second.
/// </summary>
public sealed class ToastService
{
    private static readonly TimeSpan Stale = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan AfterHover = TimeSpan.FromSeconds(3);
    private readonly IToastPresenter _presenter;
    private readonly Func<DateTimeOffset> _now;
    private readonly List<ToastViewModel> _queue = new();
    private DateTimeOffset _shownAt;
    private bool _hovered;

    public ToastService(IToastPresenter presenter, Func<DateTimeOffset>? now = null)
    {
        _presenter = presenter;
        _now = now ?? (() => DateTimeOffset.UtcNow);
    }

    public ToastViewModel? Current { get; private set; }
    public IReadOnlyList<ToastViewModel> Queued => _queue;
    /// <summary>True while a full-screen app is in front.</summary>
    public bool Suppressed { get; private set; }

    public void Show(ToastViewModel toast)
    {
        toast.OnDismiss = () => Dismiss(toast);
        toast.QueuedAt = _now();
        if (Current is not null && Current.Key == toast.Key)
        {
            if (toast.Kind == ToastKind.Message)
            {
                Merge(Current, toast);
                _shownAt = _now();
                return;
            }
            HideCurrent();
            _queue.Insert(0, toast);
            Pump();
            return;
        }

        var queued = _queue.FindIndex(t => t.Key == toast.Key);
        if (queued >= 0)
        {
            if (toast.Kind == ToastKind.Message) Merge(_queue[queued], toast);
            else _queue[queued] = toast;
            return;
        }

        if (toast.Sticky)
        {
            // The ring is time-critical: it goes first, and an ordinary card makes way.
            _queue.Insert(0, toast);
            if (Current is { Sticky: false } current)
            {
                HideCurrent();
                _queue.Insert(1, current);
            }
        }
        else
        {
            _queue.Add(toast);
        }
        Pump();
    }

    /// <summary>Takes back a toast that no longer applies (the ring ended, the break started).</summary>
    public void Withdraw(string key)
    {
        _queue.RemoveAll(t => t.Key == key);
        if (Current?.Key == key)
        {
            HideCurrent();
            Pump();
        }
    }

    /// <summary>Takes back every toast of a kind (opening the dashboard answers all messages).</summary>
    public void Withdraw(ToastKind kind)
    {
        _queue.RemoveAll(t => t.Kind == kind);
        if (Current?.Kind == kind)
        {
            HideCurrent();
            Pump();
        }
    }

    public void Dismiss(ToastViewModel toast)
    {
        if (ReferenceEquals(Current, toast))
        {
            HideCurrent();
            Pump();
        }
        else
        {
            _queue.Remove(toast);
        }
    }

    public void Clear()
    {
        _queue.Clear();
        HideCurrent();
    }

    public void SetSuppressed(bool suppressed)
    {
        if (Suppressed == suppressed) return;
        Suppressed = suppressed;
        if (suppressed)
        {
            if (Current is { } current)
            {
                HideCurrent();
                _queue.Insert(0, current);
            }
        }
        else
        {
            Pump();
        }
    }

    /// <summary>While the pointer is on the card it stays; it leaves a few seconds after.</summary>
    public void SetHovered(bool hovered)
    {
        _hovered = hovered;
        if (!hovered && Current is { } c) _shownAt = _now() - c.Lifetime + AfterHover;
    }

    public void Tick()
    {
        var now = _now();
        _queue.RemoveAll(t => Expired(t, now));
        if (Current is { Sticky: false } current && !_hovered && now - _shownAt >= current.Lifetime)
        {
            HideCurrent();
        }
        Pump();
    }

    private static void Merge(ToastViewModel into, ToastViewModel from)
    {
        into.Count += from.Count;
        into.Body = from.Body;
        into.Stamp = from.Stamp;
        into.Title = from.Title;
        into.Heading = into.Count > 1 ? $"{into.Count} new messages" : from.Heading;
    }

    private void HideCurrent()
    {
        if (Current is null) return;
        Current = null;
        _hovered = false;
        _presenter.Hide();
    }

    /// <summary>Waited too long to be worth showing (half an hour, or a cue's few seconds).</summary>
    private static bool Expired(ToastViewModel toast, DateTimeOffset now) =>
        !toast.Sticky && (now - toast.QueuedAt > Stale || (toast.MaxWait is { } wait && now - toast.QueuedAt > wait));

    private void Pump()
    {
        var now = _now();
        _queue.RemoveAll(t => Expired(t, now));
        if (Current is not null || Suppressed || _queue.Count == 0) return;
        Current = _queue[0];
        _queue.RemoveAt(0);
        _shownAt = _now();
        _presenter.Show(Current);
    }
}
