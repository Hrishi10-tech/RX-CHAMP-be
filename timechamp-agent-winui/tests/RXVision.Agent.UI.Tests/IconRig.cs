using Avalonia.Headless;
using Avalonia.Threading;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Icon;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.Views;

namespace RXVision.Agent.UI.Tests;

/// <summary>Runs posted work where it is posted: the manual clock's timers then act on the caller's thread.</summary>
public sealed class InlineDispatcher : IUiDispatcher
{
    public void Post(Action action) => action();
}

/// <summary>
/// The floating icon's whole brain on the scripted agent and the manual clock, with the same pieces
/// the app wires. <see cref="Run"/> moves the agent's time and the clock together.
/// </summary>
public sealed class IconRig : IDisposable
{
    public IconRig(FakeAgent agent, UiSettingsStore? store = null, IIconAvatarSource? avatars = null)
    {
        Agent = agent;
        Alerts = new AlertCenter();
        Meter = new DayMeter(agent, store);
        Actions = new BreakActions(agent, Dialogs, NullLog.Instance);
        DayAlerts = new DayAlerts(agent, Alerts, Actions, OpenedUrls.Add);
        Vm = new BubbleViewModel(agent, Meter, Alerts, new InlineDispatcher(), avatars: avatars);
        agent.DayProgressChanged += Vm.Update;
    }

    public FakeAgent Agent { get; }
    public AlertCenter Alerts { get; }
    public DayMeter Meter { get; }
    public BreakActions Actions { get; }
    /// <summary>The dialogs the actions ask (4.0 confirms End break, for one).</summary>
    public FakeDialogs Dialogs { get; } = new();
    public DayAlerts DayAlerts { get; }
    public BubbleViewModel Vm { get; }
    public List<string> OpenedUrls { get; } = new();
    public ManualClock Clock => Agent.ManualClock;

    /// <summary>Moves on by whole frames, following the agent each second as the app does.</summary>
    public void Run(TimeSpan by, TimeSpan? step = null)
    {
        var frame = step ?? FramePump.Interval;
        var end = Clock.Monotonic + by;
        var nextSecond = Clock.Monotonic + TimeSpan.FromSeconds(1);
        while (Clock.Monotonic < end)
        {
            var next = end - Clock.Monotonic < frame ? end - Clock.Monotonic : frame;
            Agent.Now += next;
            Clock.Advance(next);
            if (Clock.Monotonic < nextSecond) continue;
            nextSecond += TimeSpan.FromSeconds(1);
            DayAlerts.Sync();
            Vm.Update();
        }
    }

    public void Run(double seconds) => Run(TimeSpan.FromSeconds(seconds));

    /// <summary>Lets tweens finish, with no more than a second moving on.</summary>
    public void Settle() => Run(1.5);

    public BubbleWindow Window(BubblePlacement? placement = null)
    {
        var window = new BubbleWindow { DataContext = Vm };
        if (placement is not null) window.UsePlacement(placement);
        return window;
    }

    public static void Pump()
    {
        for (var i = 0; i < 3; i++)
        {
            Dispatcher.UIThread.RunJobs();
            AvaloniaHeadlessPlatform.ForceRenderTimerTick();
        }
    }

    public void Dispose() => Vm.Dispose();
}
