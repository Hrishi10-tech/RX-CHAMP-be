using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>One point of the guide: "1. Start your day" and its words.</summary>
public sealed record GuideRow(string Heading, string Body);

/// <summary>
/// Instructions (3.2): the staff guide from GET /workday/guide, in order, with the
/// organisation's numbers filled in by the server. The last copy shows while offline.
/// </summary>
public sealed partial class InstructionsViewModel : ObservableObject
{
    private readonly IAgent _agent;
    private readonly ILog _log;

    public InstructionsViewModel(IAgent agent, ILog log)
    {
        _agent = agent;
        _log = log;
    }

    public ObservableCollection<GuideRow> Items { get; } = new();

    /// <summary>What to say when the guide on screen is not fresh, or there is none.</summary>
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasNote))]
    private string? _note;

    public bool HasNote => Note is not null;

    public async Task LoadAsync()
    {
        try
        {
            var (guide, fresh) = await _agent.GetGuideAsync();
            if (guide is not null)
            {
                Items.Clear();
                foreach (var item in guide.Items.OrderBy(i => i.N)) Items.Add(new GuideRow($"{item.N}. {item.Title}", item.Body));
            }
            Note = fresh ? null
                : guide is not null ? "You're offline, so this is the last copy."
                : "Can't reach RX Vision to read the instructions. Try again in a moment.";
        }
        catch (Exception ex)
        {
            _log.Warn("guide", "reading the guide failed", ex);
            Note = "The instructions couldn't be read. Try again in a moment.";
        }
    }

    public void Reset()
    {
        Items.Clear();
        Note = null;
    }
}
