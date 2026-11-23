using Avalonia.Controls;

namespace RXVision.Agent.Views;

/// <summary>History (SPEC 8.2), a page of the main window.</summary>
public partial class HistoryView : UserControl
{
    public HistoryView() => InitializeComponent();
}

/// <summary>Instructions (SPEC 8.3), a page of the main window, with the organisation's guide (3.2).</summary>
public partial class InstructionsView : UserControl
{
    public InstructionsView() => InitializeComponent();
}

/// <summary>Leave and comp off (3.4, 3.5), a page of the main window.</summary>
public partial class LeaveView : UserControl
{
    public LeaveView() => InitializeComponent();
}

/// <summary>My calendar (3.2), a page of the main window.</summary>
public partial class CalendarView : UserControl
{
    public CalendarView() => InitializeComponent();
}
