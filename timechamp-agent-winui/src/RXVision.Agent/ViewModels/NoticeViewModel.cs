using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>One thing RX Vision records.</summary>
public sealed record NoticeItem(string Icon, string Title, string Text);

/// <summary>The monitoring notice, read and acknowledged before tracking starts.</summary>
public sealed partial class NoticeViewModel : ObservableObject
{
    private readonly IAgent _agent;
    private readonly ILog _log;

    public NoticeViewModel(IAgent agent, ILog log)
    {
        _agent = agent;
        _log = log;
        var idleMin = Math.Max(1, agent.Options.IdleThresholdSeconds / 60);
        var shotsMin = Math.Max(1, agent.Options.ScreenshotMinutes);
        Items = new[]
        {
            new NoticeItem("Icon.Clock", "Working hours",
                "When your day starts and ends, and when you're away from your computer or it's locked."),
            new NoticeItem("Icon.Coffee", "Breaks, lunch and meetings",
                "When you take them and for how long, including any reason you give your managers."),
            new NoticeItem("Icon.Globe", "Apps and websites",
                "The app in front and its window title, and the website address in your browser, about once a minute."),
            new NoticeItem("Icon.Moon", "Time away",
                $"Time with no keyboard or mouse use for {idleMin} minutes or more."),
            new NoticeItem("Icon.Camera", "Screenshots",
                $"A picture of your screen about every {shotsMin} minutes, and whenever a manager asks for one. " +
                "Automatic ones pause during breaks and lunch, and while your screen is locked."),
        };
    }

    /// <summary>
    /// AGENT.md section 9: with data handling on (GET /features), this exact sentence comes first.
    /// Null while the flag is off (the notice as it was).
    /// </summary>
    public string? DataHandlingSentence => _agent.FeatureOn(Core.Api.FeatureNames.DataHandling)
        ? "RxVision records activity, periodic captures and file-transfer events on this work device for attendance, payroll and data security."
        : null;

    public string Heading => "RX Vision records your working day";
    public string Intro => "Your company uses RX Vision for attendance and work monitoring. While your day is running, it records:";
    public string Footer => "Your department's managers and your organisation's admins can see this. You can see your own day any time from the round icon, and End day stops tracking until you start again.";
    public IReadOnlyList<NoticeItem> Items { get; }

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AcknowledgeCommand))]
    private bool _isBusy;

    [ObservableProperty] private string? _error;

    [RelayCommand(CanExecute = nameof(CanAcknowledge))]
    private async Task AcknowledgeAsync()
    {
        IsBusy = true;
        Error = null;
        try
        {
            await _agent.AcknowledgeNoticeAsync();
        }
        catch (Exception ex)
        {
            _log.Error("ui", "notice acknowledgement failed", ex);
            Error = "Try again.";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private bool CanAcknowledge() => !IsBusy;
}
