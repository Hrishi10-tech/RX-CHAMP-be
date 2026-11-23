using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Offline;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>What the away pop-up shows: the question, the break it became, or "End your break now?".</summary>
public enum AwayMode { Ask, OnBreak, ConfirmEnd }

/// <summary>One reason button in the away pop-up.</summary>
public sealed partial class AwayReasonViewModel : ObservableObject
{
    public AwayReasonViewModel(AwayReason reason, Action<AwayReasonViewModel> pick)
    {
        Key = reason.Key;
        Label = string.IsNullOrWhiteSpace(reason.Label) ? reason.Key : reason.Label.Trim();
        Kind = string.IsNullOrWhiteSpace(reason.Kind) ? AwayKinds.Other : reason.Kind;
        PickCommand = new RelayCommand(() => pick(this));
    }

    public string Key { get; }
    public string Label { get; }
    public string Kind { get; }
    public IRelayCommand PickCommand { get; }

    [ObservableProperty] private bool _isOn;
}

/// <summary>
/// The away pop-up (SPEC 2.5, 8.4): "Away since 2:05 PM · 23 min" counting up from
/// the last input, the reasons from the person's settings, the fields the chosen
/// reason needs, Submit. "Took a break" turns it into "On a break" with End break
/// (asked first, like every End break). It closes itself once answered.
/// </summary>
public sealed partial class AwayViewModel : ObservableObject
{
    private readonly IAgent _agent;
    private readonly ILog _log;
    private bool _sawBreak;

    public AwayViewModel(IAgent agent, ILog log)
    {
        _agent = agent;
        _log = log;
        Since = agent.AwaySince ?? agent.Now;
        var reasons = agent.IdleConfig?.Reasons is { Count: > 0 } list ? list : AwayKinds.Defaults();
        foreach (var reason in reasons.Where(r => !string.IsNullOrWhiteSpace(r.Key))) Reasons.Add(new AwayReasonViewModel(reason, Pick));
        Refresh();
    }

    /// <summary>When the person went away (the last input).</summary>
    public DateTimeOffset Since { get; private set; }

    public ObservableCollection<AwayReasonViewModel> Reasons { get; } = new();

    /// <summary>Answered, or no longer needed: the window closes.</summary>
    [ObservableProperty] private bool _isDone;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(IsAsking), nameof(IsOnBreak), nameof(IsConfirmingEnd))]
    private AwayMode _mode = AwayMode.Ask;

    public bool IsAsking => Mode == AwayMode.Ask;
    public bool IsOnBreak => Mode == AwayMode.OnBreak;
    public bool IsConfirmingEnd => Mode == AwayMode.ConfirmEnd;

    [ObservableProperty] private string _heading = "";
    [ObservableProperty] private string _sinceText = "";
    [ObservableProperty] private string _breakTimer = "00:00";
    [ObservableProperty] private string _breakSince = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasSelected), nameof(AsksComment), nameof(AsksMeeting), nameof(CommentLabel),
        nameof(CommentPlaceholder), nameof(SubmitText), nameof(SelectedNote))]
    [NotifyCanExecuteChangedFor(nameof(SubmitCommand))]
    private AwayReasonViewModel? _selected;

    public bool HasSelected => Selected is not null;
    /// <summary>Thinking, hardware, other work and custom reasons: one line.</summary>
    public bool AsksComment => Selected is { Kind: not (AwayKinds.Break or AwayKinds.Meeting) };
    /// <summary>A short meeting: who, a one-line summary, who mails the minutes.</summary>
    public bool AsksMeeting => Selected is { Kind: AwayKinds.Meeting };

    public string CommentLabel => Selected?.Kind == AwayKinds.Thinking ? "What were you thinking about?" : "What did you work on?";
    public string CommentPlaceholder => Selected?.Kind switch
    {
        AwayKinds.Thinking => "For example: planning the release checklist",
        AwayKinds.Hardware => "For example: replaced the scanner cable at desk 4",
        _ => "For example: sorted the client's paper files",
    };

    public string SubmitText => Selected?.Kind == AwayKinds.Break ? "Yes, I'm on a break" : "Submit";

    public string? SelectedNote => Selected?.Kind switch
    {
        AwayKinds.Break => "This time becomes a quick break from when you went away. Your focus time stays paused until you end it.",
        null => null,
        _ => $"Sent to {Approver()} for approval. If approved, it counts as focus time.",
    };

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SubmitCommand))]
    private string _comment = "";

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SubmitCommand))]
    private string _participantsText = "";

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SubmitCommand))]
    private string _summary = "";

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SubmitCommand))]
    private string _momSender = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    private string? _error;

    public bool HasError => Error is not null;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SubmitCommand), nameof(EndBreakCommand), nameof(ConfirmEndCommand))]
    private bool _isBusy;

    public bool HasSelfName => !string.IsNullOrWhiteSpace(_agent.User?.DisplayName);
    public string SelfChip => HasSelfName ? $"Me ({Fmt.FirstName(_agent.User?.DisplayName)})" : "Me";

    [RelayCommand]
    private void MomIsMe()
    {
        if (HasSelfName) MomSender = _agent.User!.DisplayName.Trim();
    }

    private void Pick(AwayReasonViewModel reason)
    {
        foreach (var r in Reasons) r.IsOn = ReferenceEquals(r, reason);
        Selected = reason;
        Error = null;
    }

    /// <summary>"Maya, Ravi Kumar; Priya" as people (free names), at most 30.</summary>
    public static IReadOnlyList<MeetingParticipant> ParsePeople(string? text) =>
        (text ?? "").Split(new[] { ',', ';', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(n => ReasonText.Clean(n))
            .Where(n => n.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(n => new MeetingParticipant(null, n.Length > ApiClient.MaxParticipantName ? n[..ApiClient.MaxParticipantName] : n))
            .ToList();

    /// <summary>The answer as the agent takes it.</summary>
    public AwayAnswer? Answer() => Selected is not { } reason ? null : reason.Kind switch
    {
        AwayKinds.Break => new AwayAnswer(reason.Key),
        AwayKinds.Meeting => new AwayAnswer(reason.Key, Summary, ParsePeople(ParticipantsText), MomSender),
        _ => new AwayAnswer(reason.Key, Comment),
    };

    /// <summary>What is still missing (null: Submit works).</summary>
    public string? Problem()
    {
        if (Selected is not { } reason) return "Pick what you were doing.";
        return Answer() is { } answer ? AwayRule.Problem(reason.Kind, answer)?.Message : null;
    }

    [RelayCommand(CanExecute = nameof(CanSubmit))]
    private async Task SubmitAsync()
    {
        if (Answer() is not { } answer) return;
        if (Problem() is { } problem)
        {
            Error = problem;
            return;
        }
        IsBusy = true;
        Error = null;
        try
        {
            var outcome = await _agent.AnswerAwayAsync(answer);
            switch (outcome)
            {
                case AwayOutcome.Recorded:
                    IsDone = true;
                    break;
                case AwayOutcome.OnBreak:
                    Mode = AwayMode.OnBreak;
                    Refresh();
                    break;
                case AwayOutcome.Invalid invalid:
                    Error = invalid.Message;
                    break;
                case AwayOutcome.Refused refused:
                    Error = refused.Message;
                    break;
            }
        }
        catch (Exception ex)
        {
            _log.Error("ui", "away answer failed", ex);
            Error = "Try again in a moment.";
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>Submit works once a reason is picked; what is still missing is said when it is pressed.</summary>
    private bool CanSubmit() => !IsBusy && Selected is not null;

    /// <summary>End break: asks first, here in the pop-up.</summary>
    [RelayCommand(CanExecute = nameof(CanEnd))]
    private void EndBreak()
    {
        Error = null;
        Mode = AwayMode.ConfirmEnd;
    }

    [RelayCommand]
    private void StayOnBreak() => Mode = AwayMode.OnBreak;

    [RelayCommand(CanExecute = nameof(CanEnd))]
    private async Task ConfirmEndAsync()
    {
        IsBusy = true;
        try
        {
            var outcome = await _agent.BackToWorkAsync();
            if (outcome is EndOutcome.Refused refused)
            {
                Error = refused.Message;
                Mode = AwayMode.OnBreak;
                return;
            }
            IsDone = true;
        }
        catch (Exception ex)
        {
            _log.Error("ui", "ending the away break failed", ex);
            Error = "Try again in a moment.";
            Mode = AwayMode.OnBreak;
        }
        finally
        {
            IsBusy = false;
        }
    }

    private bool CanEnd() => !IsBusy;

    public string EndQuestion => "End your break now?";
    public string EndDetail => "Your focus time starts again.";

    /// <summary>Every second: the counters; closes when it is no longer needed (answered elsewhere, the day ended, the break ended).</summary>
    public void Refresh()
    {
        try
        {
            RefreshCore();
        }
        catch (Exception ex)
        {
            _log.Warn("ui", "away refresh failed", ex);
        }
    }

    private void RefreshCore()
    {
        var now = _agent.Now;
        if (_agent.State != AgentState.Running)
        {
            IsDone = true;
            return;
        }
        if (Mode == AwayMode.Ask)
        {
            if (_agent.AwaySince is not { } since)
            {
                // Answered or closed elsewhere (End Day records it as unexplained).
                if (!IsBusy) IsDone = true;
                return;
            }
            Since = since;
            var away = now - since;
            SinceText = $"Away since {_agent.BusinessTime(since)}";
            Heading = $"{SinceText} · {Fmt.Timer((int)Math.Max(60, away.TotalSeconds))}";
            return;
        }

        var active = _agent.BreakPanel.Active;
        if (active is null)
        {
            // Ended from the dashboard or the tray (or not shown yet right after the answer).
            if (_sawBreak && !IsBusy) IsDone = true;
            return;
        }
        _sawBreak = true;
        BreakTimer = active.Countdown;
        BreakSince = $"On a break since {_agent.BusinessTime(active.StartedAt)}";
    }

    private string Approver() => _agent.User?.Role switch
    {
        "MANAGER" => "your admin",
        "ADMIN" or "SUPER_ADMIN" => "an admin",
        _ => "a manager",
    };
}
