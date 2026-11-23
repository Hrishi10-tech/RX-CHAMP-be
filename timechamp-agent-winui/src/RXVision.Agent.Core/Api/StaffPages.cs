using System.Globalization;

namespace RXVision.Agent.Core.Api;

// The staff pages ported from 3.2 to 3.5 (Instructions, My calendar, Leave), read from
// the 4.0 API: GET /workday/guide, GET /calendar/people/:userId/year, /leave/*.

// ---- The staff guide (3.2) ----------------------------------------------------------

/// <summary>One point of GET /workday/guide.</summary>
public sealed class GuideItem
{
    public int N { get; set; }
    public string Title { get; set; } = "";
    public string Body { get; set; } = "";
}

/// <summary>GET /workday/guide: the Instructions page, with the organisation's numbers filled in.</summary>
public sealed class StaffGuide
{
    public List<GuideItem> Items { get; set; } = new();
}

// ---- My calendar (3.2, 4.0's organisation calendar with 3.5's department and person weeks) --

public static class CalendarKinds
{
    public const string Working = "WORKING";
    public const string WeeklyOff = "WEEKLY_OFF";
    public const string Holiday = "HOLIDAY";
}

/// <summary>One day of GET /calendar/people/:userId/year.</summary>
public sealed class PersonYearDay
{
    /// <summary>YYYY-MM-DD.</summary>
    public string Date { get; set; } = "";
    public bool Working { get; set; }
    /// <summary>A day set on the organisation calendar: a holiday's name, or the label of a worked day.</summary>
    public string? Label { get; set; }
    /// <summary>OVERRIDE, PERSON, DEPARTMENT or ORGANISATION: what decides the day.</summary>
    public string Source { get; set; } = "";
}

/// <summary>GET /calendar/people/:userId/year?year= (4.0): a person's year, day by day.</summary>
public sealed class PersonYear
{
    public string UserId { get; set; } = "";
    public int Year { get; set; }
    /// <summary>PERSON, DEPARTMENT or ORGANISATION: what decides most of the days.</summary>
    public string Source { get; set; } = "";
    public string? SourceLabel { get; set; }
    public int WorkingDays { get; set; }
    public List<PersonYearDay> Days { get; set; } = new();
}

public sealed class CalendarDay
{
    /// <summary>YYYY-MM-DD.</summary>
    public string Date { get; set; } = "";
    /// <summary>WORKING, WEEKLY_OFF or HOLIDAY.</summary>
    public string Kind { get; set; } = CalendarKinds.Working;
    public string? HolidayName { get; set; }
}

public sealed class CalendarHoliday
{
    public string Date { get; set; } = "";
    public string Label { get; set; } = "";
}

public sealed class CalendarTotals
{
    public int Working { get; set; }
    public int WeeklyOff { get; set; }
    public int Holidays { get; set; }
}

/// <summary>The person's year as My calendar shows it (worked out from <see cref="PersonYear"/>).</summary>
public sealed class CalendarYear
{
    public int Year { get; set; }
    public string Today { get; set; } = "";
    /// <summary>Whose week decides the days, in the person's words ("Your department's calendar").</summary>
    public string? Summary { get; set; }
    public CalendarTotals Totals { get; set; } = new();
    public List<CalendarHoliday> Holidays { get; set; } = new();
    public List<CalendarDay> Days { get; set; } = new();

    /// <summary>
    /// The page's year from the API's: a day off set on the organisation calendar (or with a
    /// name) is a holiday, any other day off is a weekly day off.
    /// </summary>
    public static CalendarYear From(PersonYear year, string today)
    {
        var view = new CalendarYear
        {
            Year = year.Year,
            Today = today,
            Summary = year.Source switch
            {
                "PERSON" => "Your own calendar",
                "DEPARTMENT" => "Your department's calendar",
                "ORGANISATION" => "Your organisation's week",
                _ => string.IsNullOrWhiteSpace(year.SourceLabel) ? null : year.SourceLabel,
            },
        };
        foreach (var d in year.Days.OrderBy(d => d.Date, StringComparer.Ordinal))
        {
            var name = string.IsNullOrWhiteSpace(d.Label) ? null : d.Label.Trim();
            var holiday = !d.Working && (d.Source == "OVERRIDE" || name is not null);
            var kind = d.Working ? CalendarKinds.Working : holiday ? CalendarKinds.Holiday : CalendarKinds.WeeklyOff;
            view.Days.Add(new CalendarDay { Date = d.Date, Kind = kind, HolidayName = holiday ? name : null });
            switch (kind)
            {
                case CalendarKinds.Working: view.Totals.Working++; break;
                case CalendarKinds.WeeklyOff: view.Totals.WeeklyOff++; break;
                default:
                    view.Totals.Holidays++;
                    view.Holidays.Add(new CalendarHoliday { Date = d.Date, Label = name ?? "Holiday" });
                    break;
            }
        }
        return view;
    }

    public static string DateKey(DateTimeOffset local) => local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}

// ---- Leave and comp off (3.4, 3.5) ------------------------------------------------------

public static class LeaveCategories
{
    public const string ClSl = "CLSL";
    public const string ElPl = "ELPL";
    public const string CompOff = "COMPOFF";
}

public static class LeaveKinds
{
    public const string FullDay = "FULL_DAY";
    public const string HalfDay = "HALF_DAY";
    public const string QuarterDay = "QUARTER_DAY";
}

public static class LeaveStatuses
{
    public const string Pending = "PENDING";
    public const string Approved = "APPROVED";
    public const string Rejected = "REJECTED";
    public const string Cancelled = "CANCELLED";
    public const string Revoked = "REVOKED";
}

/// <summary>One pool of a person's leave (a <c>balances</c> row of GET /leave/me).</summary>
public sealed class LeaveBalance
{
    public string Category { get; set; } = "";
    /// <summary>"CL/SL".</summary>
    public string Label { get; set; } = "";
    public double GrantedDays { get; set; }
    public double CarriedDays { get; set; }
    public double AdjustedDays { get; set; }
    public double PendingDays { get; set; }
    /// <summary>"left": the balance less what is waiting.</summary>
    public double AvailableDays { get; set; }
}

/// <summary>Comp off on GET /leave/me (3.5): its own balance, claimed in the portal or the phone app.</summary>
public sealed class CompOffBalance
{
    public bool Enabled { get; set; }
    public double AvailableDays { get; set; }
    public double PendingDays { get; set; }
    public double TakenDays { get; set; }
    public CompOffExpiry? NextExpiry { get; set; }
}

public sealed class CompOffExpiry
{
    public string Date { get; set; } = "";
    /// <summary>"Fri 13 Nov".</summary>
    public string Label { get; set; } = "";
    public double Days { get; set; }
}

public sealed class LeaveRequestCan
{
    public bool Cancel { get; set; }
}

/// <summary>One leave request (LeaveRequestView).</summary>
public sealed class LeaveRequest
{
    public string Id { get; set; } = "";
    public string Category { get; set; } = "";
    public string CategoryLabel { get; set; } = "";
    public string Kind { get; set; } = "";
    /// <summary>"Half day (first half)".</summary>
    public string KindLabel { get; set; } = "";
    public string StartDate { get; set; } = "";
    public string? EndDate { get; set; }
    /// <summary>"Mon 14 to Fri 18 Dec".</summary>
    public string Span { get; set; } = "";
    public double Days { get; set; }
    /// <summary>"2.5 days".</summary>
    public string DaysLabel { get; set; } = "";
    public string? PartTimes { get; set; }
    public string Status { get; set; } = "";
    /// <summary>"Waiting for approval".</summary>
    public string StatusLabel { get; set; } = "";
    /// <summary>Who decides it, named by the server (the department's managers, the organisation's admin).</summary>
    public string? WaitingFor { get; set; }
    public string? DecidedByName { get; set; }
    public string? DecisionNote { get; set; }
    public LeaveRequestCan? Can { get; set; }
}

/// <summary>One leave type the apply form offers (<c>categories</c> of the policy).</summary>
public sealed class LeaveCategoryInfo
{
    public string Category { get; set; } = "";
    public string Label { get; set; } = "";
    /// <summary>The sentence under the field: "Apply at least 5 days ahead..."</summary>
    public string? Rule { get; set; }
}

/// <summary>A part of a part day ("first half", "2nd quarter").</summary>
public sealed class LeavePartInfo
{
    public string Part { get; set; } = "";
    public string Label { get; set; } = "";
}

/// <summary>How long leave can be (<c>kinds</c> of the policy).</summary>
public sealed class LeaveKindInfo
{
    public string Kind { get; set; } = "";
    public string Label { get; set; } = "";
    public List<LeavePartInfo> Parts { get; set; } = new();
}

/// <summary>The organisation's leave policy, what the apply form reads (on GET /leave/me).</summary>
public sealed class LeavePolicy
{
    public bool Enabled { get; set; } = true;
    public int ElplNoticeDays { get; set; }
    public List<LeaveCategoryInfo> Categories { get; set; } = new();
    public List<LeaveKindInfo> Kinds { get; set; } = new();
}

/// <summary>GET /leave/me: the caller's leave.</summary>
public sealed class MyLeave
{
    public string Today { get; set; } = "";
    public int Year { get; set; }
    public LeavePolicy Policy { get; set; } = new();
    public List<LeaveBalance> Balances { get; set; } = new();
    public string? WaitingFor { get; set; }
    public List<LeaveRequest> Upcoming { get; set; } = new();
    public List<LeaveRequest> Requests { get; set; } = new();
    public CompOffBalance? CompOff { get; set; }
}

/// <summary>POST /leave/preview and POST /leave/requests.</summary>
public sealed class LeaveRequestBody
{
    public string Category { get; set; } = "";
    public string Kind { get; set; } = "";
    public string? Part { get; set; }
    public string StartDate { get; set; } = "";
    public string? EndDate { get; set; }
    public string Reason { get; set; } = "";
}

public sealed class LeaveProblem
{
    public string? Field { get; set; }
    public string? Code { get; set; }
    public string Message { get; set; } = "";
}

public sealed class LeavePreviewDate
{
    public string Date { get; set; } = "";
    public string Label { get; set; } = "";
    public bool Charged { get; set; }
    public string? Why { get; set; }
}

public sealed class LeavePreviewBalance
{
    public string Label { get; set; } = "";
    public double BeforeDays { get; set; }
    public double AfterDays { get; set; }
}

/// <summary>POST /leave/preview: what a request would charge, or the first thing that stops it.</summary>
public sealed class LeavePreview
{
    public bool Ok { get; set; }
    public LeaveProblem? Problem { get; set; }
    public string? DaysLabel { get; set; }
    public string? PartTimes { get; set; }
    public LeavePreviewBalance? Balance { get; set; }
    public List<LeavePreviewDate> Dates { get; set; } = new();
    public string? WaitingFor { get; set; }
    public bool ApprovedAtOnce { get; set; }
}
