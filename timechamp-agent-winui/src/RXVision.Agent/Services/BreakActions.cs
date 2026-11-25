using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;

namespace RXVision.Agent.Services;

/// <summary>
/// Everything the person can start or stop, as one flow per action, shared by
/// the dashboard tiles, the tray and button menus, and the toasts: on time,
/// reason, skip, or blocked with an explanation.
///
/// 4.0, offline first: every action is kept on this computer the moment it is
/// confirmed and shown at once; it reaches RX Vision when the connection allows.
/// There is no "No connection, try again" for any of them. The server's answer is
/// waited for a moment when it is reachable, so a refusal it gives in time (a
/// reason needed, comments needed) is asked about in the same flow.
/// </summary>
public sealed class BreakActions
{
    private const int MaxAttempts = 5;

    /// <summary>Quick reasons for skipping a break (and for a skipped break's comment).</summary>
    public static readonly string[] SkipChips = { "Client call", "Deadline", "Not needed today", "Already rested" };
    /// <summary>The quiet line after an early return, in rotation.</summary>
    public static readonly string[] EarlyCues = { "Back early. Nice rhythm.", "Back early. Good pace." };
    /// <summary>The quiet line after a skip, in rotation.</summary>
    public static readonly string[] SkipCues = { "Skipped and noted. Keep it steady.", "Skipped and noted. Thanks for staying on it." };

    private readonly IAgent _agent;
    private readonly IDialogService _dialogs;
    private readonly ILog _log;
    private int _flow;
    private int _busy;
    private int _earlyCue;
    private int _skipCue;

    public BreakActions(IAgent agent, IDialogService dialogs, ILog log)
    {
        _agent = agent;
        _dialogs = dialogs;
        _log = log;
    }

    /// <summary>True while an action is being saved.</summary>
    public bool IsBusy => _busy > 0;
    public event Action? BusyChanged;

    /// <summary>A quiet line to show beside the round button for a few seconds (after a skip or an early return).</summary>
    public event Action<string>? Cue;

    /// <summary>True while a flow (including its dialogs) is running.</summary>
    public bool InFlow => _flow == 1;

    private bool IsSuperAdmin => _agent.User?.Role == "SUPER_ADMIN";

    /// <summary>Where the flows ask their questions (the Leave page asks there too).</summary>
    public IDialogService Dialogs => _dialogs;

    /// <summary>An Admin or Super Admin may quit (with a key); staff and managers cannot quit at all (SPEC 2.8).</summary>
    public bool CanQuit => _agent.User?.Role is "ADMIN" or "SUPER_ADMIN";

    /// <summary>Who decides the person's items, mid-sentence: "a manager" (staff: any of the department's managers) or "your admin" (managers).</summary>
    public string Approver => _agent.User?.Role switch
    {
        "MANAGER" => "your admin",
        "ADMIN" or "SUPER_ADMIN" => "an admin",
        _ => "a manager",
    };

    public string ApproverCapital => Capital(Approver);

    // ---- Scheduled breaks ------------------------------------------------------------

    /// <summary>
    /// Takes the break the tile points at (presenceType BREAK or LUNCH), or a
    /// specific scheduled kind (from the ring toast). <paramref name="confirm"/>
    /// asks before an on-time start; a reason is always asked for when needed.
    /// The start card offers Skip break when the shift allows it.
    /// </summary>
    public Task TakeAsync(string presenceType, string? kind = null, bool confirm = true) =>
        RunFlowAsync(() => TakeCoreAsync(presenceType, kind, confirm));

    private async Task TakeCoreAsync(string presenceType, string? kind, bool confirm)
    {
        if (!await EnsureWorkingDayAsync()) return;
        var panel = _agent.BreakPanel;
        if (panel.Active is not null || IsAway(_agent.Presence.Status))
        {
            await _dialogs.AlertAsync("You're on break", "Tap Resume work first, then start the next one.");
            return;
        }
        if (_agent.Presence.Status == PresenceStatus.Meeting)
        {
            await _dialogs.AlertAsync("You're in a meeting", "Tap End meeting first, then start your break.");
            return;
        }
        if (!panel.Scheduled)
        {
            await TakeFreeAsync(presenceType, confirm);
            return;
        }

        var slot = kind is null
            ? (presenceType == PresenceStatus.Lunch ? panel.LunchTile : panel.BreakTile)
            : panel.Slots.FirstOrDefault(s => s.Kind == kind);
        if (slot is null)
        {
            await _dialogs.AlertAsync(
                presenceType == PresenceStatus.Lunch ? "No lunch in your shift today" : "No breaks in your shift today",
                "Your shift doesn't have one scheduled today. Ask your managers if that looks wrong.");
            return;
        }

        // The start card, with Skip break beside Start break; Keep my break on the skip card returns here.
        var slotKind = slot.Kind;
        for (var round = 0; round < MaxAttempts; round++)
        {
            // Time moves on while the person decides: read the slot as it is now.
            panel = _agent.BreakPanel;
            slot = panel.Slots.FirstOrDefault(s => s.Kind == slotKind) ?? slot;
            if (slot.State == SlotState.Paused)
            {
                await ResumeCoreAsync();
                return;
            }
            if (!slot.CanStart)
            {
                await ExplainBlockedAsync(slot, panel);
                return;
            }
            string? reason = null;
            if (slot.ReasonRequired)
            {
                var dialog = ReasonFor(slot, panel);
                if (!await _dialogs.ShowAsync(dialog))
                {
                    if (dialog.ChoseAlternative && await SkipFlowAsync(slot, offerBack: true)) continue;
                    return;
                }
                reason = dialog.Reason;
            }
            else if (confirm)
            {
                var dialog = ConfirmStart(slot);
                if (!await _dialogs.ShowAsync(dialog))
                {
                    if (dialog.ChoseAlternative && await SkipFlowAsync(slot, offerBack: true)) continue;
                    return;
                }
            }
            await StartScheduledAsync(slot, reason);
            return;
        }
    }

    private async Task StartScheduledAsync(SlotView slot, string? reason)
    {
        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var outcome = await Busy(() => _agent.TakeBreakAsync(slot.Kind, reason));
            switch (outcome)
            {
                case StartOutcome.Started:
                    _log.Info("ui", $"break {slot.Kind} started");
                    return;
                case StartOutcome.NeedsReason needs:
                    reason = await AskReasonAsync(ReasonFromServer(slot, needs));
                    if (reason is null) return;
                    continue;
                case StartOutcome.Refused refused:
                    await _dialogs.AlertAsync(StartFailedTitle(slot.PresenceType), refused.Message);
                    return;
                default:
                    return;
            }
        }
    }

    private async Task TakeFreeAsync(string presenceType, bool confirm)
    {
        var lunch = presenceType == PresenceStatus.Lunch;
        if (confirm && !await _dialogs.ConfirmAsync(
                lunch ? "Go to lunch?" : "Take a break?",
                "Your ring pauses until you resume.",
                lunch ? "Start lunch" : "Start break"))
        {
            return;
        }
        var outcome = await Busy(() => _agent.TakeFreeBreakAsync(lunch ? PresenceStatus.Lunch : PresenceStatus.Break));
        switch (outcome)
        {
            case StartOutcome.NeedsReason needs:
                await _dialogs.AlertAsync(StartFailedTitle(presenceType), needs.Message);
                return;
            case StartOutcome.Refused refused:
                await _dialogs.AlertAsync(StartFailedTitle(presenceType), refused.Message);
                return;
        }
    }

    // ---- 4.0: the Next break tile, quick breaks, pause and resume -------------------------

    /// <summary>
    /// The Next break tile: resumes a paused break, starts one that is open (with its
    /// confirmation or reason), or says when the next one opens.
    /// </summary>
    public Task NextBreakAsync() =>
        RunFlowAsync(async () =>
        {
            if (!await EnsureWorkingDayAsync()) return;
            var panel = _agent.BreakPanel;
            if (!panel.Scheduled)
            {
                var choice = new MessageDialogViewModel("Take a break?", "There's no break schedule today. Your ring pauses until you resume.")
                {
                    PrimaryText = "Start lunch",
                    AltText = "Start break",
                    CancelText = "Cancel",
                };
                if (await _dialogs.ShowAsync(choice)) await TakeFreeAsync(PresenceStatus.Lunch, confirm: false);
                else if (choice.ChoseAlternative) await TakeFreeAsync(PresenceStatus.Break, confirm: false);
                return;
            }
            var next = panel.Next;
            if (next is null)
            {
                await _dialogs.AlertAsync("No more breaks today", "Every break in your shift is done or closed. A quick break is there any time you need one.");
                return;
            }
            if (next.State == SlotState.Paused)
            {
                await ResumeCoreAsync();
                return;
            }
            if (next.CanStart)
            {
                await TakeCoreAsync(next.PresenceType, next.Kind, confirm: true);
                return;
            }
            await ExplainBlockedAsync(next, panel);
        });

    /// <summary>Quick break: choose 5, 10 or 15 minutes, then it starts (SPEC 8.1).</summary>
    public Task QuickBreakAsync() =>
        RunFlowAsync(async () =>
        {
            if (!await EnsureWorkingDayAsync()) return;
            if (_agent.BreakPanel.Active is not null || IsAway(_agent.Presence.Status))
            {
                await _dialogs.AlertAsync("You're on a break", "End this break first, then start the next one.");
                return;
            }
            if (_agent.Presence.Status == PresenceStatus.Meeting)
            {
                await _dialogs.AlertAsync("You're in a meeting", "Tap End meeting first, then take your break.");
                return;
            }
            var dialog = QuickDialog();
            if (!await _dialogs.ShowAsync(dialog)) return;
            var outcome = await Busy(() => _agent.QuickBreakAsync(dialog.SelectedMinutes));
            if (outcome is ActionOutcome.Refused refused) await _dialogs.AlertAsync("Couldn't start your quick break", refused.Message);
            else _log.Info("ui", $"quick break of {dialog.SelectedMinutes} min");
        });

    /// <summary>The quick-break picker with the lengths and buffer today's config gives.</summary>
    public QuickBreakDialogViewModel QuickDialog()
    {
        var config = _agent.Workday?.Config;
        var minutes = config?.QuickBreakMinutes is { Count: > 0 } m ? m : new List<int> { 5, 10, 15 };
        var buffer = _agent.Allowance.BufferSec > 0 ? _agent.Allowance.BufferSec / 60 : config?.BreakBufferMin ?? 10;
        return new QuickBreakDialogViewModel(minutes, buffer);
    }

    /// <summary>Pause a scheduled break: focus time starts again; it can be resumed until its window closes.</summary>
    public Task PauseAsync() =>
        RunFlowAsync(async () =>
        {
            var active = _agent.BreakPanel.Active;
            if (active is null) return;
            if (!active.CanPause)
            {
                await _dialogs.AlertAsync("This break can't pause", "Only a scheduled break can be paused. End it when you're back.");
                return;
            }
            var outcome = await Busy(_agent.PauseBreakAsync);
            if (outcome is ActionOutcome.Refused refused) await _dialogs.AlertAsync("Couldn't pause your break", refused.Message);
        });

    /// <summary>Resume the paused break (inside its window).</summary>
    public Task ResumeAsync() => RunFlowAsync(ResumeCoreAsync);

    private async Task ResumeCoreAsync()
    {
        if (!await EnsureWorkingDayAsync()) return;
        var outcome = await Busy(_agent.ResumeBreakAsync);
        if (outcome is ActionOutcome.Refused refused) await _dialogs.AlertAsync("Couldn't resume your break", refused.Message);
    }

    // ---- Skipping a break ---------------------------------------------------------------

    /// <summary>Skip this break (from its card or a toast): screen D, then it is saved.</summary>
    public Task SkipAsync(string kind) =>
        RunFlowAsync(async () =>
        {
            if (!await EnsureWorkingDayAsync()) return;
            var panel = _agent.BreakPanel;
            var slot = panel.Slots.FirstOrDefault(s => s.Kind == kind);
            if (slot is null)
            {
                await _dialogs.AlertAsync("That break isn't in your shift today", "Your shift doesn't have that break today.");
                return;
            }
            if (!slot.CanSkip)
            {
                var (title, message) = slot.PendingAutoSkip is not null
                    ? ($"{slot.Label} is already skipped",
                        $"You can still take it until {slot.LocalWindowClose}. If you don't, add a comment when you end the day.")
                    : slot.CanStart && !slot.AllowSkip
                    ? ($"{slot.Label} can't be skipped", "Your shift doesn't allow skipping this break.")
                    : BlockedText(slot, panel);
                await _dialogs.AlertAsync(title, message);
                return;
            }
            await SkipFlowAsync(slot, offerBack: false);
        });

    /// <summary>
    /// Screen D, then the skip is saved. A Super Admin's skip goes to nobody: the same
    /// question with no pay line and no reason (BF-19).
    /// Returns true when the person chose Keep my break from the start card (back to it).
    /// </summary>
    private async Task<bool> SkipFlowAsync(SlotView slot, bool offerBack)
    {
        if (IsSuperAdmin)
        {
            if (!await _dialogs.ShowAsync(SkipDialog(slot, _agent.BreakPanel.MinChars))) return offerBack;
            await SendSkipAsync(slot, null);
            return false;
        }
        var minChars = _agent.BreakPanel.MinChars;
        string text = "";
        string? error = null;
        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var dialog = SkipDialog(slot, minChars);
            dialog.Text = text;
            dialog.Error = error;
            if (!await _dialogs.ShowAsync(dialog)) return offerBack;
            text = dialog.Reason;
            var outcome = await SendSkipAsync(slot, text);
            if (outcome is SkipOutcome.NeedsReason needs)
            {
                minChars = Math.Max(minChars, needs.MinChars);
                error = needs.Message;
                continue;
            }
            return false;
        }
        return false;
    }

    /// <summary>Saves the skip; says what was refused.</summary>
    private async Task<SkipOutcome?> SendSkipAsync(SlotView slot, string? reason)
    {
        var outcome = await Busy(() => _agent.SkipBreakAsync(slot.Kind, reason));
        switch (outcome)
        {
            case SkipOutcome.Skipped:
                _log.Info("ui", $"break {slot.Kind} skipped");
                RaiseCue(SkipCues, ref _skipCue);
                return outcome;
            case SkipOutcome.NeedsReason needs when IsSuperAdmin:
                await _dialogs.AlertAsync("Try skipping again", needs.Message);
                return outcome;
            case SkipOutcome.Refused refused:
                await _dialogs.AlertAsync("Try skipping again", refused.Message);
                return outcome;
            default:
                return outcome;
        }
    }

    /// <summary>
    /// Screen D: "Skip this break? Your next one is at 4:30 PM.", what a rejection costs when
    /// someone decides it, and the reason on the same screen when the server asks for one.
    /// </summary>
    public ReasonDialogViewModel SkipDialog(SlotView slot, int minChars)
    {
        var decided = !IsSuperAdmin;
        return new ReasonDialogViewModel("Skip this break?",
            decided ? $"Your focus time keeps running. If {Approver} rejects the skip, the {Fmt.Minutes(slot.DurationMin)} come off it." : "",
            minChars, PresetsOr(PresetKinds.BreakSkip, SkipChips))
        {
            Lead = NextBreakLine(slot, _agent.BreakPanel),
            AsksReason = decided,
            Label = "Why are you skipping it?",
            Placeholder = "For example: on a client call until 11:40",
            Hint = $"{minChars} characters or more, please.",
            PrimaryText = "Skip break",
            CancelText = "Keep my break",
        };
    }

    /// <summary>"Your next one is at 4:30 PM.", or "This is your last break today."</summary>
    private static string NextBreakLine(SlotView slot, BreakPanel panel)
    {
        var index = panel.Slots.ToList().FindIndex(s => s.Kind == slot.Kind);
        var next = panel.Slots.Skip(index + 1).FirstOrDefault(s =>
            s.State is SlotState.Upcoming or SlotState.OpenEarly or SlotState.Due or SlotState.OpenLate);
        return next is null ? "This is your last break today." : $"Your next one is at {next.LocalStart}.";
    }

    // ---- Comments on skipped breaks --------------------------------------------------------

    /// <summary>Add comment: the one comment a skip with no reason takes (an auto-skip, today or earlier).</summary>
    public Task CommentAsync(string breakId) =>
        RunFlowAsync(async () =>
        {
            var target = FindSkip(breakId);
            if (target is null)
            {
                await _dialogs.AlertAsync("Nothing to add", "That break already has a comment, or is no longer waiting for one.");
                return;
            }
            var (label, closed, minChars) = target.Value;
            string text = "";
            string? error = null;
            for (var attempt = 0; attempt < MaxAttempts; attempt++)
            {
                var dialog = CommentDialog(label, closed, minChars);
                dialog.Text = text;
                dialog.Error = error;
                if (!await _dialogs.ShowAsync(dialog)) return;
                text = dialog.Reason;
                var outcome = await SendCommentAsync(breakId, text);
                if (outcome is CommentOutcome.NeedsReason needs)
                {
                    minChars = Math.Max(minChars, needs.MinChars);
                    error = needs.Message;
                    continue;
                }
                return;
            }
        });

    private async Task<CommentOutcome?> SendCommentAsync(string breakId, string comment)
    {
        var outcome = await Busy(() => _agent.CommentBreakAsync(breakId, comment));
        switch (outcome)
        {
            case CommentOutcome.NotNeeded notNeeded:
                await _dialogs.AlertAsync("No comment needed", notNeeded.Message);
                return outcome;
            case CommentOutcome.Refused refused:
                await _dialogs.AlertAsync("Try adding the comment again", refused.Message);
                return outcome;
            default:
                return outcome;
        }
    }

    /// <summary>The comment dialog for a skipped break.</summary>
    public ReasonDialogViewModel CommentDialog(string label, string closedText, int minChars) =>
        new("Add a comment",
            $"Add a comment before you end the day. This skip goes to {Approver} either way.",
            minChars, PresetsOr(PresetKinds.SkipComment, SkipChips))
        {
            TagText = "Skipped for you",
            TagTone = Tone.Neutral,
            TagDetail = $"{label} · {closedText}",
            Label = "Why was it skipped?",
            Placeholder = "For example: the client demo ran until 12:15",
            Hint = $"{minChars} characters or more, please.",
            PrimaryText = "Send comment",
        };

    /// <summary>A skip needing a comment, from today's slots or the day's list (earlier days too).</summary>
    private (string Label, string Closed, int MinChars)? FindSkip(string breakId)
    {
        var panel = _agent.BreakPanel;
        var slot = panel.Slots.FirstOrDefault(s => s.Record?.Id == breakId);
        if (slot?.Record is { NeedsComment: true } record)
            return (slot.Label, record.IsAutoSkip ? $"closed {slot.LocalWindowClose}" : $"skipped {_agent.BusinessTime(record.StartedAt)}", panel.MinChars);
        var listed = _agent.Workday?.SkipsNeedingComment.FirstOrDefault(s => s.Id == breakId);
        if (listed is null) return null;
        return (string.IsNullOrWhiteSpace(listed.Label) ? "Break" : listed.Label, SkippedWhen(listed), listed.MinChars);
    }

    private string SkippedWhen(SkipNeedingComment skip)
    {
        var at = _agent.BusinessTime(skip.SkippedAt);
        var verb = skip.Outcome == BreakOutcomes.AutoSkipped ? "Skipped for you" : "Skipped";
        var today = _agent.Workday?.Date;
        return today is not null && skip.Date != today && !string.IsNullOrEmpty(skip.Date)
            ? $"{verb} at {at} on {DayLabel(skip.Date)}"
            : $"{verb} at {at}";
    }

    private static string DayLabel(string date) =>
        DateTime.TryParseExact(date, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out var d)
            ? d.ToString("d MMM", System.Globalization.CultureInfo.InvariantCulture)
            : date;

    // ---- End break / back to work -----------------------------------------------------------

    /// <summary>
    /// Resume work (the panel's foot, the tray, the icon's menu): a meeting ends at once; a break,
    /// like every End break in 4.0, asks first (SPEC 2.3). Minutes over come out of the paid buffer.
    /// </summary>
    public Task BackToWorkAsync() =>
        RunFlowAsync(async () =>
        {
            var panel = _agent.BreakPanel;
            if (panel.Active is null && panel.Paused is null && _agent.Presence.Status == PresenceStatus.Meeting)
            {
                await EndMeetingCoreAsync();
                return;
            }
            await EndBreakCoreAsync();
        });

    /// <summary>End break, always confirmed ("End your lunch break now? You have 12 min left.").</summary>
    public Task EndBreakAsync() => RunFlowAsync(EndBreakCoreAsync);

    private async Task EndBreakCoreAsync()
    {
        var panel = _agent.BreakPanel;
        var active = panel.Active;
        if (active is null && panel.Paused is null && !IsAway(_agent.Presence.Status)) return;
        if (!await _dialogs.ShowAsync(ConfirmEnd(active, active is null ? panel.Paused : null))) return;
        var outcome = await Busy(_agent.BackToWorkAsync);
        switch (outcome)
        {
            case EndOutcome.Ended ended when IsEarly(ended.Record):
                RaiseCue(EarlyCues, ref _earlyCue);
                break;
            case EndOutcome.Refused refused:
                await _dialogs.AlertAsync("Couldn't end your break", refused.Message);
                break;
        }
    }

    /// <summary>"End your lunch break now?" with what is left, or how far over it is.</summary>
    public MessageDialogViewModel ConfirmEnd(ActiveBreakView? active, SlotView? paused = null)
    {
        if (active is null && paused is not null)
        {
            var left = Math.Max(0, paused.DurationMin * 60 - paused.TakenSec);
            return new MessageDialogViewModel($"End your {Fmt.Lower(paused.Label)} now?",
                left > 0
                    ? $"It is paused with {Fmt.Minutes(CeilMinutes(left))} left. Ending it now means you can't resume it."
                    : "It is paused. Ending it now means you can't resume it.")
            {
                PrimaryText = "End break",
                CancelText = "Keep it paused",
            };
        }
        var label = active is null ? "break" : active.IsQuick ? "quick break" : Fmt.Lower(active.Label);
        string message;
        if (active?.Remaining is { } remaining)
        {
            message = remaining > TimeSpan.Zero
                ? $"You have {Fmt.Minutes(CeilMinutes((int)Math.Ceiling(remaining.TotalSeconds)))} left."
                : $"You're {Fmt.Minutes(Math.Max(1, (int)Math.Floor(-remaining.TotalMinutes)))} over. Minutes over come out of your paid buffer first.";
        }
        else
        {
            message = active is null ? "Your focus time starts again." : $"You've been on it for {Fmt.Minutes(Math.Max(1, (int)Math.Floor(active.Elapsed.TotalMinutes)))}.";
        }
        return new MessageDialogViewModel($"End your {label} now?", message)
        {
            PrimaryText = "End break",
            CancelText = "Stay on break",
        };
    }

    private static int CeilMinutes(int seconds) => Math.Max(1, (int)Math.Ceiling(seconds / 60.0));

    /// <summary>A minute or more before the break's length: an early return.</summary>
    private static bool IsEarly(BreakRecord? record)
    {
        if (record?.DurationMin is not { } minutes || minutes <= 0) return false;
        var took = record.TookSec > 0
            ? record.TookSec
            : record.EndedAt is { } ended ? (int)(ended - record.StartedAt).TotalSeconds : 0;
        return took > 0 && took <= minutes * 60 - 60;
    }

    // ---- Meetings ---------------------------------------------------------------------

    /// <summary>
    /// Start meeting (3.6), from the button or a suggestion the person tapped: In a meeting at
    /// once, no form, no approval. It needs the server; with no answer nothing starts and the
    /// person may try again (or record the meeting with its details, which works offline).
    /// </summary>
    public Task StartMeetingAsync(string source = MeetingSources.Button) =>
        RunFlowAsync(async () =>
        {
            if (!await EnsureWorkingDayAsync()) return;
            if (_agent.BreakPanel.Active is not null || IsAway(_agent.Presence.Status))
            {
                await _dialogs.AlertAsync("You're on break", "Tap Resume work first, then start the meeting.");
                return;
            }
            if (Status == DayStatus.InMeeting)
            {
                await _dialogs.AlertAsync("You're in a meeting", "Tap End meeting first, then start the next one.");
                return;
            }
            for (var attempt = 0; attempt < MaxAttempts; attempt++)
            {
                var outcome = await Busy(() => _agent.StartMeetingStatusAsync(source));
                switch (outcome)
                {
                    case MeetingStatusOutcome.Offline offline:
                        if (!await _dialogs.ConfirmAsync("The meeting isn't started yet", offline.Message, "Try again", "Cancel")) return;
                        continue;
                    case MeetingStatusOutcome.Refused refused:
                        await _dialogs.AlertAsync("Couldn't start the meeting", MeetingMessage(refused.Code, refused.Message, null));
                        return;
                    default:
                        return;
                }
            }
        });

    /// <summary>Still in it, on the 2 hour check. A tap that lost the race reads Working, with its card.</summary>
    public Task ConfirmMeetingAsync() =>
        RunFlowAsync(async () =>
        {
            for (var attempt = 0; attempt < MaxAttempts; attempt++)
            {
                var outcome = await Busy(_agent.ConfirmMeetingAsync);
                switch (outcome)
                {
                    case MeetingStatusOutcome.Offline offline:
                        if (!await _dialogs.ConfirmAsync("Couldn't reach RX Vision", offline.Message, "Try again", "Cancel")) return;
                        continue;
                    case MeetingStatusOutcome.Refused refused:
                        await _dialogs.AlertAsync("Try again in a moment", refused.Message);
                        return;
                    default:
                        return;
                }
            }
        });

    /// <summary>The person's status as the icon, the panel and the menus read it (3.6).</summary>
    private DayStatus Status => DayStatusReader.Of(_agent.State, _agent.DayProgress, _agent.Presence.Status, _agent.BreakPanel.Active is not null);

    /// <summary>
    /// The 4.0 meeting dialog: Starting now (a meeting with its agenda, people and who mails the
    /// minutes, journaled so it works offline, and approved after) or Already happened. Cancel
    /// starts nothing.
    /// </summary>
    public Task RecordMeetingAsync() =>
        RunFlowAsync(async () =>
        {
            if (!await EnsureWorkingDayAsync()) return;
            if (_agent.BreakPanel.Active is not null || IsAway(_agent.Presence.Status))
            {
                await _dialogs.AlertAsync("You're on a break", "End your break first, then start the meeting.");
                return;
            }
            if (Status == DayStatus.InMeeting)
            {
                await _dialogs.AlertAsync("You're in a meeting", "Tap End meeting first, then start the next one.");
                return;
            }

            MeetingDraft? draft = null;
            string? error = null;
            for (var attempt = 0; attempt < MaxAttempts; attempt++)
            {
                var dialog = new MeetingDialogViewModel(MeetingContext(), draft) { Error = error };
                _ = SafeAsync(dialog.LoadSuggestionsAsync);
                if (!await _dialogs.ShowAsync(dialog)) return;
                draft = dialog.ToDraft();
                var outcome = await Busy(() => draft.IsPast && draft.StartedAt is { } at
                    ? _agent.LogPastMeetingAsync(at, draft.DurationMin, draft.Agenda, draft.People, draft.MomSender)
                    : _agent.StartMeetingAsync(draft.Agenda, draft.People, draft.MomSender));
                switch (outcome)
                {
                    case MeetingOutcome.Invalid invalid:
                        error = MeetingMessage(invalid.Code, invalid.Message, invalid.With);
                        continue;
                    case MeetingOutcome.Refused refused:
                        await _dialogs.AlertAsync(draft.IsPast ? "Try logging the meeting again" : "Couldn't start the meeting",
                            MeetingMessage(refused.Code, refused.Message, null));
                        return;
                    default:
                        return;
                }
            }
        });

    public MeetingDialogContext MeetingContext() => new(
        _agent.SearchParticipantsAsync,
        _agent.Now,
        _agent.Workday?.StartedAt,
        _agent.BusinessTime,
        _agent.User?.Id,
        Approver,
        _agent.User?.DisplayName);

    /// <summary>The server's code, in the person's words (its own message when the code is new to us).</summary>
    public string MeetingMessage(string code, string message, MeetingClash? with)
    {
        string Span() => with?.StartedAt is { } s && with.EndedAt is { } e
            ? $" from {_agent.BusinessTime(s)} to {_agent.BusinessTime(e)}"
            : "";
        return code switch
        {
            "MEETING_OUTSIDE_DAY" => "Pick a time between Start day and now.",
            "MEETING_IN_FUTURE" => "Pick an earlier start or fewer minutes. That runs past now.",
            "MEETING_OVERLAPS_BREAK" => $"Pick another time. That overlaps your {(with?.Kind == "LUNCH" ? "lunch" : "break")}{Span()}.",
            "MEETING_OVERLAPS_MEETING" => $"Pick another time. That overlaps another meeting{Span()}.",
            "MOM_SENDER_REQUIRED" => "Add who will mail the minutes.",
            "DAY_NOT_STARTED" => "Start your day first.",
            "DAY_ENDED" => "Your working day has ended.",
            "ON_BREAK" => "End your break first.",
            "MEETING_IN_PROGRESS" => "You're already in a meeting. Tap End meeting first.",
            _ => string.IsNullOrWhiteSpace(message) ? "Try saving that meeting again." : message,
        };
    }

    /// <summary>End meeting: back to Working.</summary>
    public Task EndMeetingAsync() => RunFlowAsync(EndMeetingCoreAsync);

    private async Task EndMeetingCoreAsync()
    {
        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            var outcome = await Busy(_agent.EndMeetingAsync);
            switch (outcome)
            {
                case EndOutcome.Offline offline:
                    // In a meeting (3.6) ends only with the server's answer: it still runs.
                    if (!await _dialogs.ConfirmAsync("Your meeting is still running", offline.Message, "Try again", "Cancel")) return;
                    continue;
                case EndOutcome.Refused refused:
                    await _dialogs.AlertAsync("Couldn't end the meeting", refused.Message);
                    return;
                default:
                    return;
            }
        }
    }

    // ---- The working day --------------------------------------------------------------------

    /// <summary>Start Day (also after End Day): the day starts at once.</summary>
    public Task StartDayAsync() =>
        RunFlowAsync(async () =>
        {
            if (_agent.State is not (AgentState.NotStarted or AgentState.DayEnded)) return;
            // A full day of leave (3.4): asked first, it would count as an extra day.
            if (_agent.State == AgentState.NotStarted && _agent.Workday?.Leave is { Full: true } leave
                && !await _dialogs.ConfirmAsync("You're on leave today",
                    $"You are on leave today ({leave.Categories}). Start your day anyway? It will count as an extra day.",
                    "Start day", "Cancel"))
            {
                return;
            }
            // Past the grace (3.2): the note, with the quick answers, then the press again.
            // Cancel leaves the day not started (nothing was recorded).
            string? reason = null;
            string? error = null;
            for (var attempt = 0; attempt < MaxAttempts; attempt++)
            {
                var sending = reason;
                var outcome = await Busy(() => _agent.StartDayAsync(sending));
                switch (outcome)
                {
                    case StartDayOutcome.NeedsLateReason needs:
                        var dialog = LateStartDialog(needs);
                        dialog.Text = reason ?? "";
                        dialog.Error = reason is null ? error : needs.Message;
                        if (!await _dialogs.ShowAsync(dialog)) return;
                        reason = dialog.Reason;
                        continue;
                    case StartDayOutcome.Refused { Code: "REASON_TOO_LONG" } tooLong:
                        error = tooLong.Message;
                        reason = null;
                        continue;
                    case StartDayOutcome.Refused { Code: "ATTENDANCE_BY_BIOMETRIC" } biometric:
                        await _dialogs.AlertAsync("Your attendance", biometric.Message);
                        return;
                    case StartDayOutcome.Refused refused:
                        await _dialogs.AlertAsync("Try starting your day again", refused.Message);
                        return;
                    default:
                        return;
                }
            }
        });

    /// <summary>Past the grace: why, with the server's words and the organisation's quick answers (3.2).</summary>
    public ReasonDialogViewModel LateStartDialog(StartDayOutcome.NeedsLateReason needs) =>
        new("Add a short note", needs.Message, needs.MinChars, needs.Presets)
        {
            TagText = needs.ShiftStart is null ? null : "Your shift start",
            TagTone = Tone.Neutral,
            TagDetail = needs.ShiftStart is { } start ? _agent.BusinessTime(start) : null,
            Label = "What came up?",
            Placeholder = "For example: a morning appointment ran over",
            Hint = $"Required. {needs.MinChars} characters or more, or pick a quick answer.",
            PrimaryText = "Start day",
            CancelText = "Cancel",
            PresetsPassAnyLength = true,
        };

    /// <summary>"Add a note": a late start made by another computer or an older agent still wants its note (lateStart.needsReason).</summary>
    public Task AddLateReasonAsync() =>
        RunFlowAsync(async () =>
        {
            if (_agent.Workday?.LateStart is not { NeedsReason: true } late) return;
            var minChars = _agent.Workday?.Settings.ReasonMinChars ?? 10;
            var text = "";
            string? error = null;
            for (var attempt = 0; attempt < MaxAttempts; attempt++)
            {
                var dialog = new ReasonDialogViewModel("Add a short note",
                    $"Your day started {Fmt.Minutes(late.Minutes)} after your shift start. Add a short note for {Approver}.",
                    minChars, _agent.Presets(PresetKinds.LateDayStart))
                {
                    Label = "What came up?",
                    Placeholder = "For example: a morning appointment ran over",
                    Hint = $"Required. {minChars} characters or more, or pick a quick answer.",
                    PrimaryText = "Add note",
                    Text = text,
                    Error = error,
                    PresetsPassAnyLength = true,
                };
                if (!await _dialogs.ShowAsync(dialog)) return;
                text = dialog.Reason;
                var result = await Busy(() => _agent.AddLateReasonAsync(text));
                if (result.Ok)
                {
                    // Until the day is read again, the banner goes.
                    late.NeedsReason = false;
                    late.Reason = text;
                    return;
                }
                if (result.Transient)
                {
                    error = "Can't reach RX Vision, so the note isn't saved. Try again.";
                    continue;
                }
                if (result.Code is "REASON_REQUIRED" or "REASON_TOO_LONG")
                {
                    if (result.DetailInt("minChars") is { } min) minChars = Math.Max(minChars, min);
                    error = result.Message;
                    continue;
                }
                await _dialogs.AlertAsync("Try adding the note again", result.Message ?? "Try again in a moment.");
                return;
            }
        });

    /// <summary>
    /// End Day. Finish a break or meeting first. Skipped breaks with no comment are
    /// listed with a box each (End Day waits for every one); approvals past their due
    /// time stop a manager with a way to the portal.
    /// </summary>
    public Task EndDayAsync() =>
        RunFlowAsync(async () =>
        {
            if (_agent.State != AgentState.Running) return;
            if (_agent.BreakPanel.Active is not null || IsAway(_agent.Presence.Status))
            {
                await _dialogs.AlertAsync("Finish this first", "Tap Resume work, then end your day.");
                return;
            }
            if (_agent.Presence.Status == PresenceStatus.Meeting)
            {
                await _dialogs.AlertAsync("Finish this first", "Tap End meeting, then end your day.");
                return;
            }

            // A copy: the agent's day may be replaced by a refresh while the dialog is open.
            IReadOnlyList<SkipNeedingComment> needed = (_agent.Workday?.SkipsNeedingComment ?? new List<SkipNeedingComment>()).ToList();
            // An End Day done offline and refused for comments: it ends the day when the person
            // ended it, with a comment for each break the server listed, keyed by exactly its ids
            // (auto-skips End Day will make have the id they will get; nothing is looked up).
            var held = _agent.HeldEndDay;
            var at = held?.At;
            var intro = held is null ? null : HeldIntro(held);
            if (held is not null)
                needed = held.Breaks.Concat(needed).GroupBy(b => b.Id).Select(g => g.First()).ToList();
            var drafts = new Dictionary<string, string>();
            IReadOnlyList<SkipComment>? comments = null;
            if (needed.Count > 0)
            {
                comments = await AskCommentsAsync(needed, drafts, null, intro);
                if (comments is null) return;
            }
            else if (!await _dialogs.ConfirmAsync(
                         "End your day?",
                         _agent.AwaySince is not null
                             ? "Your focus time stops now and today is saved as it is. The away time you haven't explained stays out of your focus time."
                             : "Your focus time stops now and today is saved as it is. You can start your day again from here if you need to.",
                         "End day", "Keep working"))
            {
                return;
            }

            for (var attempt = 0; attempt < MaxAttempts * 2; attempt++)
            {
                var outcome = await Busy(() => _agent.EndDayAsync(comments, at));
                switch (outcome)
                {
                    case EndDayOutcome.Ended:
                        _log.Info("ui", at is null ? "day ended" : "day ended at the held End Day's time");
                        return;
                    case EndDayOutcome.CommentsRequired required when required.Breaks.Count > 0:
                        // The server's list, with its ids as they are (planned auto-skips included).
                        needed = required.Breaks;
                        comments = await AskCommentsAsync(needed, drafts, null, intro);
                        if (comments is null) return;
                        continue;
                    case EndDayOutcome.CommentsRequired required:
                        await _dialogs.AlertAsync("Try ending your day again", required.Message);
                        return;
                    case EndDayOutcome.CommentInvalid { FixableByEditing: false, BreakId: { } bad } invalid
                        when comments?.Any(c => c.BreakId == bad) == true:
                        // That break no longer takes a comment (gone, not a skip, not yours, or
                        // sent twice): no typing can fix it, so send the rest again without it.
                        // If more is still needed, the server lists it and the dialog comes back.
                        _log.Info("ui", $"End Day: a comment was refused ({invalid.Problem}); sending the others again");
                        comments = invalid.Problem == CommentProblems.Duplicate
                            ? comments!.GroupBy(c => c.BreakId).Select(g => g.First()).ToList()
                            : comments!.Where(c => c.BreakId != bad).ToList();
                        if (invalid.Problem != CommentProblems.Duplicate) drafts.Remove(bad);
                        continue;
                    case EndDayOutcome.CommentInvalid invalid:
                        // The list the person was answering (the server's newest view first).
                        var list = _agent.Workday?.SkipsNeedingComment is { Count: > 0 } current ? current : needed;
                        if (list.Count == 0)
                        {
                            await _dialogs.AlertAsync("Try ending your day again", invalid.Message);
                            return;
                        }
                        comments = await AskCommentsAsync(list, drafts, invalid, intro);
                        if (comments is null) return;
                        continue;
                    case EndDayOutcome.ApprovalsOverdue overdue:
                        await ShowOverdueAsync(overdue.Count);
                        return;
                    case EndDayOutcome.NotStarted notStarted:
                        await _dialogs.AlertAsync("Your day hasn't started", notStarted.Message);
                        return;
                    case EndDayOutcome.Refused refused:
                        await _dialogs.AlertAsync("Try ending your day again", refused.Message);
                        return;
                    default:
                        return;
                }
            }
        });

    /// <summary>
    /// The End Day dialog: one box per skipped break, with what was typed before;
    /// the box the server refused says why. Null when the person chose Not now.
    /// </summary>
    /// <summary>"You ended your day at 6:30 PM while offline. ..." (the dialog for a held End Day).</summary>
    public string HeldIntro(HeldEndDay held)
    {
        var time = _agent.BusinessTime(held.At);
        var n = held.Breaks.Count;
        return $"You ended your day at {time} while offline. RX Vision needs a comment for {(n == 1 ? "a skipped break" : $"{n} skipped breaks")} " +
               $"before it can save that. With {(n == 1 ? "it" : "them")}, your day ends at {time}.";
    }

    private async Task<IReadOnlyList<SkipComment>?> AskCommentsAsync(IReadOnlyList<SkipNeedingComment> breaks,
        Dictionary<string, string> drafts, EndDayOutcome.CommentInvalid? invalid, string? intro = null)
    {
        var items = breaks
            .Where(b => !string.IsNullOrWhiteSpace(b.Id))
            .GroupBy(b => b.Id).Select(g => g.First())
            .Select(b =>
            {
                drafts.TryGetValue(b.Id, out var draft);
                var item = new SkipCommentItemViewModel(b.Id, string.IsNullOrWhiteSpace(b.Label) ? "Break" : b.Label,
                    SkippedWhen(b), b.MinChars, SkipChips, draft, b.Kind);
                if (invalid is not null && b.Id == invalid.BreakId)
                {
                    if (invalid.MinChars is { } min) item.RequireAtLeast(min);
                    item.Error = invalid.Message;
                }
                return item;
            }).ToList();
        if (items.Count == 0)
        {
            await _dialogs.AlertAsync("Try ending your day again", invalid?.Message ?? "Try again in a moment. Some skipped breaks still need a comment.");
            return null;
        }
        var dialog = new EndDayDialogViewModel(items, Approver, ApproverCapital, intro);
        // Refused for a break not in the list (or for no break in particular): say it over the list.
        if (invalid is not null && !items.Any(i => i.HasError)) dialog.Error = invalid.Message;
        var ok = await _dialogs.ShowAsync(dialog);
        foreach (var item in dialog.Items) drafts[item.Id] = item.Comment;
        return ok ? dialog.Comments : null;
    }

    /// <summary>"Decide 3 approvals in the portal to end your day. They are past 48 hours."</summary>
    public async Task ShowOverdueAsync(int count)
    {
        var sla = _agent.Workday?.Settings.ApprovalSlaHours is { } h and > 0 ? h : 48;
        var what = count switch
        {
            <= 0 => $"Decide your approvals in the portal to end your day. They are past {sla} hours.",
            1 => $"Decide 1 approval in the portal to end your day. It is past {sla} hours.",
            _ => $"Decide {count} approvals in the portal to end your day. They are past {sla} hours.",
        };
        var portal = ApprovalsUrl(_agent.Workday?.PortalUrl);
        var title = $"Approvals waiting past {sla} hours";
        if (portal is null)
        {
            await _dialogs.AlertAsync(title, what);
            return;
        }
        var open = await _dialogs.ShowAsync(new MessageDialogViewModel(title, what)
        {
            PrimaryText = "Open approvals",
            CancelText = "Close",
        });
        if (!open) return;
        try { _agent.Platform.Shell.OpenUrl(portal); }
        catch (Exception ex) { _log.Warn("ui", "could not open the portal", ex); }
    }

    /// <summary>&lt;portal&gt;/dashboard/approvals, or null when the server gave no usable portal address.</summary>
    public static string? ApprovalsUrl(string? portalUrl)
    {
        if (string.IsNullOrWhiteSpace(portalUrl)) return null;
        if (!Uri.TryCreate(portalUrl.Trim(), UriKind.Absolute, out var uri)) return null;
        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) return null;
        return uri.GetLeftPart(UriPartial.Path).TrimEnd('/') + "/dashboard/approvals";
    }

    // ---- Sign out and quit (4.0: an admin's key) ------------------------------------------

    /// <summary>
    /// Sign out (SPEC 2.8, 8.5): "Syncing N actions…" until everything reached RX Vision,
    /// then the admin's key, then the result. Needs the internet, and says so.
    /// </summary>
    public Task SignOutAsync() =>
        RunFlowAsync(async () =>
        {
            if (!await _dialogs.ConfirmAsync("Sign out of RX Vision?",
                    "Signing out needs a key from your admin and an internet connection: everything you did is sent to RX Vision first. Tracking stops until you sign in again.",
                    "Continue", "Cancel"))
            {
                return;
            }
            if (!await SyncBeforeKeyAsync("sign out")) return;
            await KeyFlowAsync(
                () => new KeyDialogViewModel("Enter the sign-out key",
                    "Your admin creates sign-out keys in the RX Vision portal. A key works for 24 hours.", "Sign out") { IsDanger = true },
                _agent.SignOutWithKeyAsync,
                () =>
                {
                    _log.Info("ui", "signed out with a key");
                    return Task.CompletedTask;
                });
        });

    /// <summary>An Admin's or Super Admin's quit (SPEC 2.8), with the same kind of key.</summary>
    public Task QuitAsync(Func<Task> exit) =>
        RunFlowAsync(async () =>
        {
            if (!CanQuit) return;
            await KeyFlowAsync(
                () => new KeyDialogViewModel("Quit RX Vision?",
                    "Tracking stops until RX Vision is opened again. Enter a sign-out key from the portal to quit.", "Quit") { IsDanger = true },
                _agent.QuitCheckAsync,
                exit);
        });

    /// <summary>Sends everything first, showing "Syncing N actions…"; false when it could not (offline) or was cancelled.</summary>
    private async Task<bool> SyncBeforeKeyAsync(string what)
    {
        var actions = _agent.PendingActions;
        if (actions == 0) return true;
        var progress = new ProgressDialogViewModel(
            actions == 1 ? "Syncing 1 action…" : $"Syncing {actions} actions…",
            $"Sending what you did to RX Vision before you {what}.");
        var shown = _dialogs.ShowAsync(progress);
        var sync = _agent.SyncNowAsync(TimeSpan.FromSeconds(20));
        if (await Task.WhenAny(shown, sync) == shown && !shown.Result) return false;
        var left = await sync;
        progress.Finish();
        await shown;
        if (left == 0) return true;
        var waiting = Fmt.Count(left, "action is", "actions are");
        var queued = Fmt.Count(left, "action", "actions");
        await _dialogs.AlertAsync("Try signing out in a moment", _agent.Online
            ? $"Try again in a moment. {waiting} still on the way to RX Vision."
            : $"Connect to the internet to sign out. {queued} must reach RX Vision first.");
        return false;
    }

    private async Task KeyFlowAsync(Func<KeyDialogViewModel> make, Func<string, Task<KeyOutcome>> check, Func<Task> accepted)
    {
        var key = "";
        string? error = null;
        for (var attempt = 0; attempt < 6; attempt++)
        {
            var dialog = make();
            dialog.Key = key;
            dialog.Error = error;
            if (!await _dialogs.ShowAsync(dialog)) return;
            key = dialog.CleanKey;
            var outcome = await Busy(() => check(key));
            switch (outcome)
            {
                case KeyOutcome.Accepted:
                    await accepted();
                    return;
                case KeyOutcome.WrongKey wrong:
                    error = wrong.Message;
                    continue;
                case KeyOutcome.TooManyTries tooMany:
                    await _dialogs.AlertAsync("Too many tries", tooMany.Message);
                    return;
                case KeyOutcome.NotSynced notSynced:
                    await _dialogs.AlertAsync("Can't sign out yet", notSynced.Message);
                    return;
                case KeyOutcome.Offline offline:
                    await _dialogs.AlertAsync("No internet connection", offline.Message);
                    return;
                case KeyOutcome.Refused refused:
                    await _dialogs.AlertAsync("Couldn't use the key", refused.Message);
                    return;
            }
        }
    }

    // ---- Dialog content ------------------------------------------------------------------

    private static string StartFailedTitle(string presenceType) =>
        presenceType == PresenceStatus.Lunch ? "Try starting your lunch again" : "Try starting your break again";

    private static string PrimaryFor(string presenceType) =>
        presenceType == PresenceStatus.Lunch ? "Start lunch" : "Start break";

    /// <summary>Screen G: Take your lunch break? Skip break beside Start break where the slot allows it; closing the card changes nothing.</summary>
    public MessageDialogViewModel ConfirmStart(SlotView slot)
    {
        var ends = _agent.BusinessTime(_agent.Now.AddMinutes(slot.DurationMin));
        return new MessageDialogViewModel(
            $"Take your {Fmt.Lower(slot.Label)}?",
            $"{Fmt.Length(slot.DurationMin)}, ends at {ends}. Your ring pauses until you resume.")
        {
            PrimaryText = PrimaryFor(slot.PresenceType),
            AltText = slot.CanSkip ? "Skip break" : null,
            ShowClose = true,
        };
    }

    /// <summary>The note screen for a slot the panel says needs one.</summary>
    public ReasonDialogViewModel ReasonFor(SlotView slot, BreakPanel panel)
    {
        var early = slot.TimingIfStartedNow == "EARLY";
        var minutes = Math.Max(1, slot.MinutesOffIfStartedNow);
        return BuildReason(slot, early, minutes, panel.Rules.ReasonMinChars, PresetsFor(early), NoteAsk(slot, early));
    }

    /// <summary>The note screen after the server judged the start early or late: its words when it sent any.</summary>
    public ReasonDialogViewModel ReasonFromServer(SlotView slot, StartOutcome.NeedsReason needs)
    {
        var early = needs.Timing == "EARLY";
        var minutes = Math.Max(1, needs.MinutesOff);
        var message = string.IsNullOrWhiteSpace(needs.Message) ? NoteAsk(slot, early) : needs.Message;
        // Asked again by the server: Skip is still offered from the first screen, not here.
        return BuildReason(slot with { CanSkip = false }, early, minutes, needs.MinChars, PresetsFor(early), message);
    }

    private string NoteAsk(SlotView slot, bool early) =>
        $"Your {Fmt.Lower(slot.Label)} {(early ? "is" : "was")} due at {slot.LocalStart}. Add a short note for {Approver}.";

    private IReadOnlyList<string> PresetsFor(bool early) => _agent.Presets(early ? PresetKinds.BreakEarly : PresetKinds.BreakLate);

    /// <summary>The organisation's quick answers (3.6), or 4.0's own chips when it set none.</summary>
    private IReadOnlyList<string> PresetsOr(string kind, IReadOnlyList<string> fallback) =>
        _agent.Presets(kind) is { Count: > 0 } presets ? presets : fallback;

    private static ReasonDialogViewModel BuildReason(SlotView slot, bool early, int minutes, int minChars, IReadOnlyList<string> chips, string message) =>
        new($"{slot.Label}, {Fmt.Minutes(minutes)} {(early ? "early" : "after its time")}", message, minChars, chips)
        {
            TagText = early ? "Starting before its time" : "Starting after its time",
            TagDetail = $"Due {slot.LocalStart} · window {slot.LocalWindowOpen} to {slot.LocalWindowClose}",
            Label = early ? "What is coming up?" : "What came up?",
            Placeholder = early ? "For example: a client call starts in 15 min" : "For example: on a customer call until now",
            PrimaryText = PrimaryFor(slot.PresenceType),
            AltText = slot.CanSkip ? "Skip break" : null,
        };

    private async Task<string?> AskReasonAsync(ReasonDialogViewModel dialog) =>
        await _dialogs.ShowAsync(dialog) ? dialog.Reason : null;

    /// <summary>Why a break can't start now, in the person's words.</summary>
    private Task ExplainBlockedAsync(SlotView slot, BreakPanel panel)
    {
        var (title, message) = BlockedText(slot, panel);
        return _dialogs.AlertAsync(title, message);
    }

    public (string Title, string Message) BlockedText(SlotView slot, BreakPanel panel)
    {
        if (panel.DayEnded) return ("Your day has ended", "Breaks start again with your next working day.");
        var next = NextLine(slot, panel);
        return slot.State switch
        {
            SlotState.Upcoming => ($"{slot.Label} isn't open yet",
                $"Due at {slot.LocalStart}. You can start or skip it from {slot.LocalWindowOpen}." +
                (panel.Rules.ReasonOnEarly ? $" Before {_agent.BusinessTime(slot.RingStart)} it needs a reason." : "")),
            SlotState.Closed => ($"{slot.Label} has closed",
                $"It could be started between {slot.LocalWindowOpen} and {slot.LocalWindowClose}.{Prefix(next)}"),
            SlotState.Skipped => ($"{slot.Label} was skipped",
                next ?? "Your focus time kept counting through it."),
            SlotState.AutoSkipped => ($"{slot.Label} was skipped for you",
                slot.Record is { NeedsComment: true }
                    ? "Add a comment before you end the day. Its window closed before it was taken."
                    : next ?? "Its window closed before it was taken."),
            SlotState.Taken => ($"{slot.Label} already taken",
                next ?? (slot.PresenceType == PresenceStatus.Lunch ? "There's no more lunch today." : "There are no more breaks today.")),
            SlotState.Unavailable => ($"{slot.Label} isn't available",
                $"A later break was already taken today, so this one can't start.{Prefix(next)}"),
            SlotState.InProgress => ("You're on this break now", "Tap Resume work when you're back."),
            SlotState.Paused => ($"{slot.Label} is paused", $"Resume it before {slot.LocalWindowClose}, or end it."),
            _ => ("No more breaks today", "Every break in your shift is done or closed."),
        };
    }

    private static string Prefix(string? line) => line is null ? "" : " " + line;

    /// <summary>"Next: Lunch break at 1:00 PM, opens 12:30 PM." for the next break still to come.</summary>
    private static string? NextLine(SlotView slot, BreakPanel panel)
    {
        var index = panel.Slots.ToList().FindIndex(s => s.Kind == slot.Kind);
        var next = panel.Slots.Skip(index + 1).FirstOrDefault(s =>
            s.State is SlotState.Upcoming or SlotState.OpenEarly or SlotState.Due or SlotState.OpenLate);
        if (next is null) return null;
        return next.State == SlotState.Upcoming
            ? $"Next: {next.Label} at {next.LocalStart}, opens {next.LocalWindowOpen}."
            : $"Next: {next.Label} at {next.LocalStart}, open now.";
    }

    // ---- Plumbing ------------------------------------------------------------------------

    private static bool IsAway(string status) => status is PresenceStatus.Break or PresenceStatus.Lunch;

    private static string Capital(string text) =>
        string.IsNullOrEmpty(text) ? text : char.ToUpperInvariant(text[0]) + text[1..];

    private void RaiseCue(string[] lines, ref int next)
    {
        var line = lines[(next++ & int.MaxValue) % lines.Length];
        try { Cue?.Invoke(line); }
        catch (Exception ex) { _log.Warn("ui", "cue failed", ex); }
    }

    private async Task<bool> EnsureWorkingDayAsync()
    {
        switch (_agent.State)
        {
            case AgentState.Running:
                return true;
            case AgentState.DayEnded:
                await _dialogs.AlertAsync("Your day has ended", "Start your day again first if you're still working.");
                return false;
            case AgentState.NotStarted:
                await _dialogs.AlertAsync("Start your day first", "Tap Start day when you begin work. Breaks and meetings follow from there.");
                return false;
            default:
                await _dialogs.AlertAsync("Not started", "Sign in and finish setting up RX Vision first.");
                return false;
        }
    }

    /// <summary>
    /// One flow at a time: a second tap while a dialog is open brings that dialog in front
    /// (on a Mac it can sit behind other apps), and starts nothing new.
    /// </summary>
    private async Task RunFlowAsync(Func<Task> flow)
    {
        if (Interlocked.Exchange(ref _flow, 1) == 1)
        {
            try { _dialogs.BringForward(); }
            catch (Exception ex) { _log.Warn("ui", "could not bring the open dialog forward", ex); }
            return;
        }
        try
        {
            await flow();
        }
        catch (Exception ex)
        {
            _log.Error("ui", "action failed", ex);
            try { await _dialogs.AlertAsync("Try that again", "Try again in a moment."); }
            catch { /* the dialog itself failed; the log has it */ }
        }
        finally
        {
            Interlocked.Exchange(ref _flow, 0);
        }
    }

    private async Task SafeAsync(Func<Task> work)
    {
        try { await work(); }
        catch (Exception ex) { _log.Warn("ui", "background work failed", ex); }
    }

    private async Task<T> Busy<T>(Func<Task<T>> call)
    {
        _busy++;
        BusyChanged?.Invoke();
        try
        {
            return await call();
        }
        finally
        {
            _busy--;
            BusyChanged?.Invoke();
        }
    }
}
