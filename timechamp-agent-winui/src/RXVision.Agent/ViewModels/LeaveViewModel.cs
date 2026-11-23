using System.Collections.ObjectModel;
using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels.Dialogs;

namespace RXVision.Agent.ViewModels;

/// <summary>One pool: "CL/SL  10.5 left of 12  (5 days waiting)".</summary>
public sealed record LeaveBalanceRow(string Label, string Left, string? Waiting)
{
    public bool HasWaiting => Waiting is not null;
}

/// <summary>One of the person's requests: span, amount, pool and where it stands.</summary>
public sealed class LeaveRequestRow
{
    public LeaveRequestRow(LeaveRequest request, Func<LeaveRequest, Task> cancel)
    {
        Span = request.Span;
        Amount = request.Kind == LeaveKinds.FullDay ? request.DaysLabel : request.KindLabel;
        Pool = request.CategoryLabel;
        Status = StatusText(request);
        CanCancel = request.Can?.Cancel == true;
        CancelText = request.Status == LeaveStatuses.Pending ? "Cancel request" : "Cancel leave";
        CancelCommand = new AsyncRelayCommand(() => cancel(request));
    }

    public string Span { get; }
    public string Amount { get; }
    public string Pool { get; }
    public string Status { get; }
    public bool CanCancel { get; }
    public string CancelText { get; }
    public IAsyncRelayCommand CancelCommand { get; }

    /// <summary>Where a request stands, with who and why from the API.</summary>
    public static string StatusText(LeaveRequest r)
    {
        var note = string.IsNullOrWhiteSpace(r.DecisionNote) ? "" : $": {r.DecisionNote.Trim()}";
        var by = string.IsNullOrWhiteSpace(r.DecidedByName) ? "" : $" by {r.DecidedByName.Trim()}";
        return r.Status switch
        {
            LeaveStatuses.Pending => string.IsNullOrWhiteSpace(r.WaitingFor) ? "Waiting for approval" : $"Waiting for {r.WaitingFor.Trim()}",
            LeaveStatuses.Approved => $"Approved{by}",
            LeaveStatuses.Rejected => $"Not approved{by}{note}",
            LeaveStatuses.Cancelled => "Cancelled",
            LeaveStatuses.Revoked => $"Revoked{by}{note}",
            _ => r.StatusLabel,
        };
    }
}

/// <summary>
/// The Leave page (3.4, with comp off from 3.5): what is left of each pool, the next leave,
/// the person's requests, Apply for leave. Every number comes from the API; the last answer
/// stays on screen while the next is read.
/// </summary>
public sealed partial class LeaveViewModel : ObservableObject
{
    private readonly IAgent _agent;
    private readonly IDialogService _dialogs;
    private readonly ILog _log;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    private MyLeave? _last;

    /// <param name="delay">How the form waits before it previews (tests pass their own clock's).</param>
    public LeaveViewModel(IAgent agent, IDialogService dialogs, ILog log, Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        _agent = agent;
        _dialogs = dialogs;
        _log = log;
        _delay = delay ?? ((wait, ct) => Task.Delay(wait, ct));
    }

    public ObservableCollection<LeaveBalanceRow> Balances { get; } = new();
    public ObservableCollection<LeaveRequestRow> Requests { get; } = new();

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasNextLeave))]
    private string? _nextLeaveText;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasCompOffExpiry))]
    private string? _compOffExpiryText;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasProblem))]
    private string? _problem;

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(ApplyCommand))]
    private bool _isEnabled;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowNoRequests))]
    private bool _hasRequests;

    /// <summary>Asked once: nothing is known yet, so "no requests" would not be true.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowNoRequests))]
    private bool _isLoaded;

    public bool HasNextLeave => NextLeaveText is not null;
    public bool HasCompOffExpiry => CompOffExpiryText is not null;
    public bool HasProblem => Problem is not null;
    public bool ShowNoRequests => IsLoaded && !HasRequests;

    /// <summary>Reads the person's leave; the last answer stays while offline.</summary>
    public async Task LoadAsync()
    {
        try
        {
            var result = await _agent.GetMyLeaveAsync();
            if (result.Ok && result.Data is { } leave)
            {
                Show(leave);
                Problem = null;
            }
            else
            {
                Problem = result.Transient
                    ? "Try again in a moment. Your leave shows once RX Vision answers."
                    : result.Message ?? "Try opening your leave again.";
            }
        }
        catch (Exception ex)
        {
            _log.Warn("leave", "reading the leave failed", ex);
            Problem = "Try opening your leave again in a moment.";
        }
    }

    private void Show(MyLeave leave)
    {
        _last = leave;
        IsLoaded = true;
        IsEnabled = leave.Policy.Enabled;
        Balances.Clear();
        foreach (var b in leave.Balances)
        {
            var of = b.GrantedDays + b.CarriedDays + b.AdjustedDays;
            Balances.Add(new LeaveBalanceRow(b.Label, $"{Fmt.Days(b.AvailableDays)} left of {Fmt.Days(of)}",
                b.PendingDays > 0 ? $"{Fmt.DaysWord(b.PendingDays)} waiting" : null));
        }
        if (leave.CompOff is { Enabled: true } comp)
        {
            Balances.Add(new LeaveBalanceRow("Comp off", $"{Fmt.Days(comp.AvailableDays)} left",
                comp.PendingDays > 0 ? $"{Fmt.DaysWord(comp.PendingDays)} waiting" : null));
            CompOffExpiryText = comp.NextExpiry is { } next ? $"Comp off: {Fmt.DaysWord(next.Days)} expires {next.Label}" : null;
        }
        else
        {
            CompOffExpiryText = null;
        }
        NextLeaveText = leave.Upcoming.FirstOrDefault() is { } first ? $"{first.Span}{PartWords(first)} · {ShortStatus(first)}" : null;

        // The upcoming first, then the rest of the year's, each once.
        var shown = leave.Upcoming.Concat(leave.Requests).GroupBy(r => r.Id).Select(g => g.First()).ToList();
        Requests.Clear();
        foreach (var r in shown) Requests.Add(new LeaveRequestRow(r, CancelAsync));
        HasRequests = shown.Count > 0;
    }

    private static string PartWords(LeaveRequest r) =>
        r.Kind == LeaveKinds.FullDay || string.IsNullOrWhiteSpace(r.KindLabel) ? "" : $", {Fmt.Lower(r.KindLabel)}";

    private static string ShortStatus(LeaveRequest r) =>
        r.Status == LeaveStatuses.Approved ? "Approved" : string.IsNullOrWhiteSpace(r.StatusLabel) ? r.Status : r.StatusLabel;

    private bool CanApply() => IsEnabled;

    /// <summary>The apply form, then the request. A refusal comes back to the form with what was typed.</summary>
    [RelayCommand(CanExecute = nameof(CanApply))]
    private async Task ApplyAsync()
    {
        var leave = _last;
        if (leave is null) return;
        var context = new LeaveDialogContext(
            leave.Policy,
            ParseDay(leave.Today) ?? _agent.BusinessLocal(_agent.Now).Date,
            _agent.Presets(PresetKinds.LeaveReason),
            await OffDaysAsync(leave),
            _agent.PreviewLeaveAsync,
            _delay);
        LeaveDraft? draft = null;
        string? error = null;
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var dialog = new LeaveDialogViewModel(context, draft) { Error = error };
            _ = dialog.PreviewSoonAsync();
            if (!await _dialogs.ShowAsync(dialog)) return;
            draft = dialog.ToDraft();
            var result = await _agent.RequestLeaveAsync(dialog.ToBody());
            if (result.Ok)
            {
                var made = result.Data;
                await _dialogs.AlertAsync(made?.Status == LeaveStatuses.Approved ? "Leave approved" : "Leave requested",
                    made is null ? "Your request is saved."
                    : made.Status == LeaveStatuses.Approved ? $"Leave approved: {made.Span}."
                    : $"Leave requested: {made.Span}. Waiting for {(string.IsNullOrWhiteSpace(made.WaitingFor) ? "approval" : made.WaitingFor.Trim())}.");
                await LoadAsync();
                return;
            }
            error = result.Transient ? "Try again. Your request isn't saved yet." : result.Message ?? "Try saving that request again.";
        }
    }

    /// <summary>Weekly days off and holidays around the first day EL/PL can take (this year and next).</summary>
    private async Task<IReadOnlySet<DateTime>> OffDaysAsync(MyLeave leave)
    {
        var off = new HashSet<DateTime>();
        if (leave.Year <= 0) return off;
        foreach (var year in new[] { leave.Year, leave.Year + 1 })
        {
            var result = await _agent.GetCalendarAsync(year);
            if (!result.Ok || result.Data is null) continue;
            foreach (var day in result.Data.Days)
                if (day.Kind != CalendarKinds.Working && ParseDay(day.Date) is { } date) off.Add(date);
        }
        return off;
    }

    private async Task CancelAsync(LeaveRequest request)
    {
        var pending = request.Status == LeaveStatuses.Pending;
        if (!await _dialogs.ConfirmAsync(pending ? "Cancel this request?" : "Cancel this leave?",
                $"{request.Span}, {request.DaysLabel} of {request.CategoryLabel}.",
                pending ? "Cancel request" : "Cancel leave", "Keep it"))
        {
            return;
        }
        var result = await _agent.CancelLeaveAsync(request.Id);
        if (!result.Ok)
        {
            await _dialogs.AlertAsync("Try cancelling again", result.Transient
                ? "Try again in a moment."
                : result.Message ?? "Try cancelling that again.");
        }
        await LoadAsync();
    }

    public void Reset()
    {
        _last = null;
        IsLoaded = false;
        IsEnabled = false;
        HasRequests = false;
        Balances.Clear();
        Requests.Clear();
        NextLeaveText = null;
        CompOffExpiryText = null;
        Problem = null;
    }

    private static DateTime? ParseDay(string? text) =>
        DateTime.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d) ? d : null;
}
