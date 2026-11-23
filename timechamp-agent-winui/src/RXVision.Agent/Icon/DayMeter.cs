using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Services;

namespace RXVision.Agent.Icon;

/// <summary>
/// The one value the ring, the hover label and the panel all read, so they always agree. It moves
/// on the minute. The words come from here too (deck C-001, C-579 to C-589, C-592).
/// </summary>
/// <param name="ExtendedFor">How far past its length a break is; null otherwise.</param>
/// <param name="OnEarlierDate">The total belongs to a day before today: the words drop "today".</param>
public sealed record DayReading(IconStatus Status, int WorkedSec, int TargetSec, TimeSpan? ExtendedFor = null, bool OnEarlierDate = false)
{
    public static readonly DayReading Start = new(IconStatus.NotStarted, 0, DayMeter.DefaultTargetSec);

    public bool Reached => WorkedSec >= TargetSec;
    public int OverSec => Math.Max(0, WorkedSec - TargetSec);
    /// <summary>A whole minute past the target: the words say so.</summary>
    public bool Over => OverSec >= 60;

    /// <summary>min(value / target, 1) x 360, from the dot, clockwise. None before the day starts.</summary>
    public double SweepDegrees => Status == IconStatus.NotStarted ? 0 : Math.Min(WorkedSec / (double)TargetSec, 1) * 360;

    private string Worked => Fmt.HoursMinutes(WorkedSec);
    private string Target => Fmt.Hours(TargetSec);
    private string StatusWord => Status switch
    {
        IconStatus.Working => "Working",
        IconStatus.Meeting => "In a meeting",
        IconStatus.OnBreak => "On break",
        IconStatus.BreakExtended => "Break extended",
        IconStatus.DayEnded => "Day ended",
        _ => "Not started",
    };
    private string OverWords => $"{Fmt.PlusMinutes(OverSec / 60)} over target";

    /// <summary>The hover label: "Working · 5h 12m of 8h".</summary>
    public string Label => Status switch
    {
        IconStatus.BreakExtended => $"{StatusWord} · {Fmt.Clock(ExtendedFor ?? TimeSpan.Zero)}",
        IconStatus.DayEnded => OnEarlierDate ? $"{StatusWord} · {Worked}" : $"{StatusWord} · {Worked} today",
        _ when Over => $"{StatusWord} · {OverWords}",
        _ => $"{StatusWord} · {Worked} of {Target}",
    };

    /// <summary>The panel's first progress line: "3h 30m of 8h", or "Target reached · 8h 00m today".</summary>
    public string PanelLine => Reached
        ? OnEarlierDate ? $"Target reached · {Worked}" : $"Target reached · {Worked} today"
        : $"{Worked} of {Target}";

    /// <summary>The panel's second line: "4h 30m to go", or "+15 min over target".</summary>
    public string PanelNote => Over ? OverWords
        : Reached ? ""
        : $"{Fmt.HoursMinutes(TargetSec / 60 * 60 - WorkedSec / 60 * 60)} to go";

    /// <summary>The window's name for screen readers: "RX Vision · Working · 5h 12m of 8h".</summary>
    public string AccessibleName => $"RX Vision · {Label}";
}

/// <summary>
/// Keeps the reading: the server's <c>workedSec</c>, plus the time since only while Working or In
/// a meeting. A status change changes the tint and never moves the sweep; the sweep moves when
/// <see cref="MinuteTick"/> says so. A new day, or the first answer, is taken at once: nothing
/// should sweep backwards to zero or fill up from nothing on start.
/// </summary>
public sealed class DayMeter
{
    public const int DefaultTargetSec = 8 * 3600;

    private readonly IAgent _agent;
    private readonly UiSettingsStore? _store;
    private DayProgress? _answer;
    private bool _answered;
    private string? _date;
    private TimeSpan _worked;
    private int _targetSec = DefaultTargetSec;
    private int _shownWorkedSec;
    private int _shownTargetSec = DefaultTargetSec;
    private IconStatus _status = IconStatus.NotStarted;
    private TimeSpan _markedAt;
    private bool _marked;
    private bool _jumped;

    /// <param name="store">Keeps the last ended day, to draw while offline; the server's next answer replaces it.</param>
    public DayMeter(IAgent agent, UiSettingsStore? store = null)
    {
        _agent = agent;
        _store = store;
    }

    public DayReading Reading { get; private set; } = DayReading.Start;

    /// <summary>Whether the sweep jumped since this was last asked (a new day, the first answer): it does not ease.</summary>
    public bool TakeJump()
    {
        var jumped = _jumped;
        _jumped = false;
        return jumped;
    }

    public static IconStatus StatusOf(IAgent agent)
    {
        switch (agent.State)
        {
            case AgentState.Running:
                // The one reading of the status (DayStatusReader): the local day leads, the server's
                // progress adds a status meeting the day has not read yet.
                return ExtendedFor(agent) is not null ? IconStatus.BreakExtended
                    : DayStatusReader.Of(agent.State, agent.DayProgress, agent.Presence.Status, agent.BreakPanel.Active is not null) switch
                    {
                        DayStatus.OnBreak => IconStatus.OnBreak,
                        DayStatus.InMeeting => IconStatus.Meeting,
                        _ => IconStatus.Working,
                    };
            case AgentState.DayEnded:
                return IconStatus.DayEnded;
            default:
                // The last ended day keeps its total until the next Start day, on any later date.
                return agent.DayProgress?.Status == DayProgressStatus.Ended ? IconStatus.DayEnded : IconStatus.NotStarted;
        }
    }

    private static bool IsOnBreak(IAgent agent) =>
        agent.BreakPanel.Active is not null || agent.Presence.Status is PresenceStatus.Break or PresenceStatus.Lunch;

    private static TimeSpan? ExtendedFor(IAgent agent)
    {
        if (!IsOnBreak(agent)) return null;
        var active = agent.BreakPanel.Active;
        if (active is not null) return active is { Overrun: true, Remaining: { } remaining } ? -remaining : null;
        return agent.DayProgress is { Status: DayProgressStatus.Break, BreakEndsAt: { } ends } && agent.Now >= ends
            ? agent.Now - ends
            : null;
    }

    /// <summary>Follows the agent. Cheap, for every event and every second. Moves the sweep only for a new day or a first answer.</summary>
    public void Follow()
    {
        Accrue();
        _status = CurrentStatus();
        var answer = _agent.DayProgress ?? StoredAnswer() ?? DayViewAnswer();
        if (answer is not null && !ReferenceEquals(answer, _answer)) Take(answer);
        Publish();
    }

    /// <summary>The minute: the ring, the label and the panel move together. On a break they hold still; only the server correcting the time by a minute or more moves them.</summary>
    public void MinuteTick()
    {
        Follow();
        if (_status is IconStatus.OnBreak or IconStatus.BreakExtended && Math.Abs(_worked.TotalSeconds - _shownWorkedSec) < 60) return;
        _shownWorkedSec = (int)_worked.TotalSeconds;
        _shownTargetSec = _targetSec;
        Publish();
    }

    /// <summary>Whoever signed in next starts from nothing.</summary>
    public void Reset()
    {
        _answer = null;
        _answered = false;
        _date = null;
        _worked = TimeSpan.Zero;
        _targetSec = DefaultTargetSec;
        _shownWorkedSec = 0;
        _shownTargetSec = DefaultTargetSec;
        _marked = false;
        Reading = DayReading.Start;
        if (_store is { Current.LastDay: not null } store)
        {
            store.Current.LastDay = null;
            store.Save();
        }
    }

    private void Accrue()
    {
        var now = _agent.Clock.Monotonic;
        if (_marked && _status is IconStatus.Working or IconStatus.Meeting) _worked += now - _markedAt;
        _markedAt = now;
        _marked = true;
    }

    private void Take(DayProgress answer)
    {
        var jump = !_answered || answer.Date != _date;
        _answer = answer;
        _answered = true;
        _date = answer.Date;
        _worked = TimeSpan.FromSeconds(Math.Max(0, answer.WorkedSec));
        _targetSec = answer.TargetSec > 0 ? answer.TargetSec : DefaultTargetSec;
        if (jump)
        {
            _shownWorkedSec = (int)_worked.TotalSeconds;
            _shownTargetSec = _targetSec;
            _jumped = true;
        }
        Remember(answer);
    }

    private void Publish()
    {
        var status = CurrentStatus();
        var reading = new DayReading(status, _shownWorkedSec, _shownTargetSec,
            status == IconStatus.BreakExtended ? ExtendedFor(_agent) : null,
            status == IconStatus.DayEnded && _date is { Length: > 0 } date && date != Today());
        if (reading != Reading) Reading = reading;
    }

    /// <summary>As <see cref="StatusOf"/>, and the copy kept on disk counts while the server has not answered.</summary>
    private IconStatus CurrentStatus()
    {
        var status = StatusOf(_agent);
        return status == IconStatus.NotStarted && _answer?.Status == DayProgressStatus.Ended ? IconStatus.DayEnded : status;
    }

    /// <summary>Today is the date on the day view; before its first answer, the business date now.</summary>
    private string Today() => _agent.Workday?.Date is { Length: > 0 } date ? date : _agent.BusinessDate(_agent.Now);

    private void Remember(DayProgress answer)
    {
        if (_store is null || _agent.User?.Id is not { Length: > 0 } user) return;
        var copy = answer.Status == DayProgressStatus.Ended
            ? new LastDayCopy { UserId = user, Date = answer.Date, WorkedSec = answer.WorkedSec, TargetSec = answer.TargetSec }
            : null;
        var current = _store.Current.LastDay;
        if (copy is null && current is null) return;
        if (copy is not null && current is not null && copy.UserId == current.UserId && copy.Date == current.Date
            && copy.WorkedSec == current.WorkedSec && copy.TargetSec == current.TargetSec) return;
        _store.Current.LastDay = copy;
        _store.Save();
    }

    /// <summary>Until the first answer, the day view stands in: the same focus time, the same expected time.</summary>
    private DayProgress? DayViewAnswer()
    {
        if (_answered || _agent.Workday is not { } day) return null;
        return new DayProgress
        {
            Status = day.State == WorkdayStates.Ended ? DayProgressStatus.Ended : DayProgressStatus.Working,
            Date = day.Date,
            WorkedSec = FocusClock.At(day, _agent.Now),
            TargetSec = day.ExpectedSec,
        };
    }

    private DayProgress? StoredAnswer()
    {
        if (_answered || _agent.State == AgentState.Running) return null;
        if (_store?.Current.LastDay is not { } copy || copy.UserId != _agent.User?.Id) return null;
        return new DayProgress { Status = DayProgressStatus.Ended, Date = copy.Date, WorkedSec = copy.WorkedSec, TargetSec = copy.TargetSec };
    }
}
