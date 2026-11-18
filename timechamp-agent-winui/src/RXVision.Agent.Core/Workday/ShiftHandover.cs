namespace RXVision.Agent.Core.Workday;

/// <summary>What the shift-end handover wants done now.</summary>
public enum HandoverStep
{
    None,
    /// <summary>Ask "Are you taking the next shift?" (15 minutes before the shift ends).</summary>
    Ask,
    /// <summary>Ask again, the last time (5 minutes before, or once at a missed shift end).</summary>
    AskLast,
    /// <summary>Not continuing (No, or no answer): end the day and sign out.</summary>
    SignOut,
}

/// <summary>
/// 4.1 shared computer: the shift-end question and the automatic sign-out, as pure
/// decisions over the clock. Asked 15 and 5 minutes before the shift ends; "Yes"
/// carries the day on (no more questions that day); "No", or no answer by the shift
/// end, signs out. It never signs anyone out without having asked at least once: a
/// computer that was off or asleep at the ask times asks at the shift end and gives
/// five minutes from then.
/// </summary>
public sealed class ShiftHandover
{
    public static readonly TimeSpan FirstAsk = TimeSpan.FromMinutes(15);
    public static readonly TimeSpan LastAsk = TimeSpan.FromMinutes(5);

    private readonly object _gate = new();
    private DateTimeOffset? _shiftEnd;
    private DateTimeOffset? _deadline;
    private bool _askedFirst;
    private bool _askedLast;
    private bool _continuing;
    private bool _declined;
    private bool _signOutDue;

    /// <summary>When the person will be signed out if they do not continue; null before any question.</summary>
    public DateTimeOffset? Deadline { get { lock (_gate) return _deadline; } }

    /// <summary>The person said they are taking the next shift.</summary>
    public bool Continuing { get { lock (_gate) return _continuing; } }

    /// <summary>
    /// The step due at <paramref name="now"/>. <paramref name="running"/>: the day is open.
    /// <paramref name="extended"/>: the server already knows they carried on.
    /// </summary>
    public HandoverStep Next(DateTimeOffset now, bool sharedComputer, DateTimeOffset? shiftEnd, bool extended, bool running)
    {
        lock (_gate)
        {
            if (!sharedComputer || shiftEnd is null || !running)
            {
                // Signed out, day ended or setting off: a sign-out already decided still happens.
                return _signOutDue && sharedComputer ? HandoverStep.SignOut : HandoverStep.None;
            }
            if (_shiftEnd != shiftEnd)
            {
                // A new day or a changed shift: start over.
                _shiftEnd = shiftEnd;
                _deadline = shiftEnd;
                _askedFirst = _askedLast = _continuing = _declined = _signOutDue = false;
            }
            if (extended || _continuing) return HandoverStep.None;
            if (_signOutDue) return HandoverStep.SignOut;

            var asked = _askedFirst || _askedLast;
            if (asked && now >= _deadline)
            {
                _signOutDue = true;
                return HandoverStep.SignOut;
            }
            if (_declined) return HandoverStep.None;
            if (!asked && now >= shiftEnd.Value)
            {
                // Missed both questions (the computer was off or asleep): ask once, five minutes to answer.
                _askedFirst = _askedLast = true;
                _deadline = now + LastAsk;
                return HandoverStep.AskLast;
            }
            if (!_askedLast && now >= shiftEnd.Value - LastAsk)
            {
                _askedFirst = _askedLast = true;
                return HandoverStep.AskLast;
            }
            if (!_askedFirst && now >= shiftEnd.Value - FirstAsk)
            {
                _askedFirst = true;
                return HandoverStep.Ask;
            }
            return HandoverStep.None;
        }
    }

    /// <summary>"Yes, I'm taking the next shift": no more questions today.</summary>
    public void Continue()
    {
        lock (_gate) { _continuing = true; _declined = false; _signOutDue = false; }
    }

    /// <summary>"No": signed out at the shift end (no more questions).</summary>
    public void Decline()
    {
        lock (_gate) _declined = true;
    }

    /// <summary>The person ended their day themselves: sign out as soon as it can.</summary>
    public void SignOutNow()
    {
        lock (_gate) _signOutDue = true;
    }

    /// <summary>Signed out (or signed in again): forget everything.</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _shiftEnd = _deadline = null;
            _askedFirst = _askedLast = _continuing = _declined = _signOutDue = false;
        }
    }
}
