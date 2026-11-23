using System.Collections.ObjectModel;
using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;

namespace RXVision.Agent.ViewModels;

/// <summary>One square of a month: a day (working, off or a holiday), or a blank before the 1st.</summary>
public sealed record CalendarCell(string Text, bool IsBlank, bool IsWorking, bool IsWeeklyOff, bool IsHoliday, bool IsToday, string? ToolTip);

/// <summary>One month of the year view: Monday first.</summary>
public sealed record CalendarMonth(string Name, IReadOnlyList<CalendarCell> Cells);

/// <summary>A holiday in the year's list.</summary>
public sealed record CalendarHolidayRow(string Date, string Label);

/// <summary>My calendar (3.2): the person's own year (4.0: GET /calendar/people/:id/year), with arrows to another year.</summary>
public sealed partial class CalendarViewModel : ObservableObject
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    private readonly IAgent _agent;
    private readonly ILog _log;
    private int _loading;

    public CalendarViewModel(IAgent agent, ILog log)
    {
        _agent = agent;
        _log = log;
    }

    public ObservableCollection<CalendarMonth> Months { get; } = new();
    public ObservableCollection<CalendarHolidayRow> Holidays { get; } = new();

    [ObservableProperty] private int _year;
    [ObservableProperty] private string? _summary;
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(TotalsShown))]
    private string _totalsText = "";

    /// <summary>
    /// The year's totals as drawn (G9): spaces inside each figure do not break, so a narrow panel
    /// wraps only between "312 working days", "52 weekly off" and "1 holiday", never mid-phrase.
    /// </summary>
    public string TotalsShown => string.Join(" · ", TotalsText.Split(" · ").Select(p => p.Replace(' ', '\u00A0')));

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasProblem))]
    private string? _problem;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasHolidays))]
    private int _holidayCount;

    public bool HasProblem => Problem is not null;
    public bool HasHolidays => HolidayCount > 0;

    /// <summary>The page opens on this year, or the year last shown.</summary>
    public Task OpenAsync() => LoadAsync(Year > 0 ? Year : _agent.BusinessLocal(_agent.Now).Year);

    [RelayCommand]
    private Task PreviousYearAsync() => LoadAsync(Year - 1);

    [RelayCommand]
    private Task NextYearAsync() => LoadAsync(Year + 1);

    private async Task LoadAsync(int year)
    {
        var mine = Interlocked.Increment(ref _loading);
        try
        {
            var result = await _agent.GetCalendarAsync(year);
            if (mine != Volatile.Read(ref _loading)) return;
            if (result.Ok && result.Data is { } data)
            {
                Show(data);
                Problem = null;
            }
            else
            {
                Problem = result.Transient
                    ? "Try again in a moment. Your calendar shows once RX Vision answers."
                    : result.Message ?? "Try opening your calendar again.";
            }
        }
        catch (Exception ex)
        {
            _log.Warn("calendar", "reading the calendar failed", ex);
            Problem = "Try opening your calendar again in a moment.";
        }
    }

    private void Show(CalendarYear data)
    {
        Year = data.Year;
        Summary = data.Summary;
        TotalsText = $"{data.Totals.Working} working days · {data.Totals.WeeklyOff} weekly off · {data.Totals.Holidays} {(data.Totals.Holidays == 1 ? "holiday" : "holidays")}";
        Months.Clear();
        foreach (var month in data.Days
                     .Select(d => (Day: d, Date: Parse(d.Date)))
                     .Where(d => d.Date is not null)
                     .GroupBy(d => d.Date!.Value.Month)
                     .OrderBy(g => g.Key))
        {
            var cells = new List<CalendarCell>();
            var first = month.Min(d => d.Date!.Value);
            // Monday first: blanks up to the first day's weekday.
            for (var i = 0; i < ((int)first.DayOfWeek + 6) % 7; i++) cells.Add(new CalendarCell("", true, false, false, false, false, null));
            foreach (var (day, date) in month.OrderBy(d => d.Date))
            {
                var holiday = day.Kind == CalendarKinds.Holiday;
                var off = day.Kind == CalendarKinds.WeeklyOff;
                cells.Add(new CalendarCell(
                    date!.Value.Day.ToString(Inv), false, !holiday && !off, off, holiday, day.Date == data.Today,
                    holiday ? (string.IsNullOrWhiteSpace(day.HolidayName) ? "Holiday" : day.HolidayName) : off ? "Weekly day off" : null));
            }
            Months.Add(new CalendarMonth(first.ToString("MMMM", Inv), cells));
        }
        Holidays.Clear();
        foreach (var h in data.Holidays) Holidays.Add(new CalendarHolidayRow(Fmt.DayLabel(h.Date), h.Label));
        HolidayCount = Holidays.Count;
    }

    public void Reset()
    {
        Year = 0;
        Summary = null;
        TotalsText = "";
        Problem = null;
        Months.Clear();
        Holidays.Clear();
        HolidayCount = 0;
    }

    private static DateTime? Parse(string text) =>
        DateTime.TryParseExact(text, "yyyy-MM-dd", Inv, DateTimeStyles.None, out var d) ? d : null;
}
