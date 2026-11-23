using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Automation;
using Avalonia.Input;
using Avalonia.VisualTree;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Icon;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>The design's day (page 7): lunch at 1:00 PM for 45 min, the next break at 4:30 PM, 3h 30m worked.</summary>
internal static class DesignDay
{
    public const int Worked = 3 * 3600 + 30 * 60;

    public static BreakDay Slots(bool lunchSkippable = true)
    {
        var day = Days.General();
        day.Breaks = new List<BreakSlot>
        {
            Days.Slot("MORNING", "11:00", 15).Skippable(),
            Days.Slot("LUNCH", "13:00", 45).Skippable(lunchSkippable),
            Days.Slot("EVENING", "16:30", 15).Skippable(),
        };
        return day.WithRecord(Days.Taken("MORNING", "11:00", "11:14"));
    }

    /// <summary>Lunch has come due: the worked time stands at 3h 30m.</summary>
    public static FakeAgent Due(string now = "13:00", bool lunchSkippable = true) => new(now)
    {
        Day = Slots(lunchSkippable),
        Workday = Days.Open(serverNow: now, focusSec: Worked),
    };

    /// <summary>On lunch since 1:00 PM: the ring stands at 3h 30m.</summary>
    public static FakeAgent OnLunch(string now) => new(now)
    {
        Day = Slots().WithActive(Days.Running("LUNCH", "13:00", 45)),
        Workday = Days.Open(serverNow: "13:00", focusSec: Worked),
        Presence = new CurrentPresence { Status = PresenceStatus.Lunch, Since = Ist.At("13:00") },
    };

    /// <summary>A plain break on a free day, with no length.</summary>
    public static FakeAgent PlainBreak(string now)
    {
        var day = Days.Free();
        day.ActiveBreak = new BreakRecord { Id = "x", Label = "Break", PresenceType = "BREAK", StartedAt = Ist.At("10:00").ToUniversalTime(), InProgress = true, Timing = "UNSCHEDULED" };
        return new FakeAgent(now)
        {
            Day = day,
            Workday = Days.Open(serverNow: "10:00", focusSec: Worked),
            Presence = new CurrentPresence { Status = PresenceStatus.Break, Since = Ist.At("10:00") },
        };
    }
}

/// <summary>Screens A to G (brief 1.3 and 1.4, AGENT.md section 5): every element, on the real window, by clicks.</summary>
public class BreakScreenTests
{
    private static bool Styled(StyledElement element, string style) => element.Classes.Contains(style);

    /// <summary>
    /// On a break the ring is the 64 px one Working shows, in the same place, its clock running amber
    /// through the break. Its name says the paused time and the count the panel leaves out.
    /// </summary>
    private static PanelIcon AssertBreakRing(DashboardHarness ui, string paused = "3h 30m")
    {
        var ring = ui.Window.GetVisualDescendants().OfType<PanelIcon>().Single(r => r.Name == "BreakRing");
        Assert.True(ring.IsEffectivelyVisible);
        Assert.Equal(64, ring.Bounds.Width);
        Assert.Equal(64, ring.Bounds.Height);
        Assert.StartsWith($"Ring paused at {paused}. ", AutomationProperties.GetName(ring));
        Assert.DoesNotContain(ui.Window.GetVisualDescendants().OfType<ProgressBar>(), p => p.IsEffectivelyVisible);
        return ring;
    }

    private static Point Where(Visual visual, DashboardHarness ui) => visual.TranslatePoint(new Point(0, 0), ui.Window)!.Value;

    /// <summary>The ring's clock as drawn now.</summary>
    private static DayRing Day(DashboardHarness ui) => (ui.Vm.BreakIcon ?? ui.Vm.Icon)!.Day!;

    private static List<DayRing.Arc> Arcs(DashboardHarness ui, DayRing.Kind kind) => Day(ui).Arcs().Where(a => a.Kind == kind).ToList();

    /// <summary>Degrees on the 9:30 AM to 6:30 PM shift for a time today.</summary>
    private static double Deg(string hhmmss) => (Ist.At(hhmmss) - Ist.At("09:30")).TotalMinutes / 540 * 360;

    /// <summary>No break clock anywhere on the panel: the ring carries it.</summary>
    private static void AssertNoCountdown(DashboardHarness ui, params string[] clocks)
    {
        foreach (var clock in clocks) Assert.False(ui.Shows(clock), $"{clock} should not show");
    }

    private static string Saved(DashboardHarness ui, string name)
    {
        var path = Shots.Save(ui.Window, name);
        Assert.True(new FileInfo(path).Length > 5_000, $"{name} looks empty");
        return path;
    }

    private static bool IsAbove(DashboardHarness ui, string upper, string lower)
    {
        double Y(string text) => ui.Window.GetVisualDescendants().OfType<TextBlock>()
            .First(t => t.IsEffectivelyVisible && t.Text == text).TranslatePoint(new Point(0, 0), ui.Window)!.Value.Y;
        return Y(upper) < Y(lower);
    }

    // ---- A. Break due -----------------------------------------------------------------------

    [AvaloniaFact]
    public void Screen_A_shows_the_break_its_primary_action_a_quiet_skip_progress_and_the_days_breaks()
    {
        var ui = new DashboardHarness(DesignDay.Due());
        Assert.True(ui.Shows("Time for your lunch break"));
        Assert.True(ui.Shows("45 min, from 1:00 PM."));
        Assert.True(Styled(ui.Button("Take a break"), "primary"));
        Assert.True(Styled(ui.Button("Skip this break"), "quiet"));
        Assert.True(ui.Shows("3h 30m of 8h"));
        Assert.True(ui.Shows("4h 30m to go"));
        Assert.True(ui.Shows("Today's breaks"));
        Assert.True(ui.Shows("Morning break"));
        Assert.True(ui.Shows("11:00 AM · Taken"));
        Assert.True(ui.Shows("Lunch break"));
        Assert.True(ui.Shows("Now"));
        Assert.True(ui.Shows("Evening break"));
        Assert.True(ui.Shows("4:30 PM"));
        Assert.True(IsAbove(ui, "Time for your lunch break", "3h 30m of 8h"));
        Assert.True(IsAbove(ui, "3h 30m of 8h", "Today's breaks"));
        Assert.Equal("!", ui.Vm.Icon!.Badge);
        Assert.Equal(BreakAlertKind.BreakDue, ui.Vm.BreakAlert);
        // One filled button on the screen.
        Assert.Single(ui.Window.GetVisualDescendants().OfType<Button>(), b => b.IsEffectivelyVisible && b.Classes.Contains("primary"));
        Saved(ui, "A-break-due");
        ui.Close();
    }

    [AvaloniaFact]
    public void Screen_A_has_no_skip_when_the_slot_cannot_be_skipped()
    {
        var ui = new DashboardHarness(DesignDay.Due(lunchSkippable: false));
        Assert.True(ui.HasButton("Take a break"));
        Assert.False(ui.HasButton("Skip this break"));
        ui.Close();
    }

    [AvaloniaFact]
    public void Screen_A_fires_at_the_ring_start_and_stays_until_the_window_closes()
    {
        var agent = DesignDay.Due("12:58:59");
        var ui = new DashboardHarness(agent);
        Assert.False(ui.Vm.BreakDue.IsShown);
        ui.At("12:59:00");
        Assert.True(ui.Vm.BreakDue.IsShown);
        ui.At("13:30"); // past the ring: still true, now with a note to add
        Assert.True(ui.Vm.BreakDue.IsShown);
        Assert.True(ui.Shows("Time for your lunch break"));
        ui.At("14:00");
        Assert.False(ui.Vm.BreakDue.IsShown);
        ui.Close();
    }

    [AvaloniaFact]
    public void A_day_started_after_the_ring_shows_no_card_and_the_break_can_still_be_taken()
    {
        var agent = DesignDay.Due("13:20");
        agent.Workday = Days.Open(startedAt: "13:10", serverNow: "13:20", focusSec: 600);
        var ui = new DashboardHarness(agent);
        Assert.False(ui.Vm.BreakDue.IsShown);
        Assert.True(ui.Button("Next break").IsEffectivelyEnabled); // 4.0: Next break takes it
        ui.Close();
    }

    [AvaloniaFact]
    public void Screen_A_shows_in_a_meeting_too_and_goes_once_skipped()
    {
        var agent = DesignDay.Due();
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = Ist.At("12:40") };
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Vm.BreakDue.IsShown);
        Assert.Equal(BreakAlertKind.BreakDue, ui.Vm.BreakAlert);
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Working };
        agent.Day = DesignDay.Slots().WithRecord(Days.Skip("LUNCH", "13:01", auto: false, reason: "Client call"));
        ui.At("13:02");
        Assert.False(ui.Vm.BreakDue.IsShown);
        Assert.Equal(BreakAlertKind.None, ui.Vm.BreakAlert);
        Assert.True(ui.Shows("1:01 PM · Skipped"));
        ui.Close();
    }

    [AvaloniaFact]
    public void Past_the_ring_Take_a_break_asks_for_the_short_note_with_quick_answers()
    {
        var agent = DesignDay.Due("13:20");
        agent.PresetLists[PresetKinds.BreakLate] = new List<string> { "A customer call ran over", "Stuck in traffic" };
        var ui = new DashboardHarness(agent);
        ui.Click("Take a break");
        var note = ui.Dialog<ReasonDialogViewModel>();
        Assert.True(ui.Shows("Lunch break, 20 min after its time"));
        Assert.True(ui.Shows("Your lunch break was due at 1:00 PM. Add a short note for a manager."));
        Assert.True(ui.Shows("What came up?"));
        Assert.NotEmpty(note.Chips);
        ui.Click(note.Chips[0].Label);
        ui.Click("Start lunch");
        Assert.Equal(("LUNCH", (string?)note.Chips[0].Label), Assert.Single(agent.TakeCalls));
        ui.Close();
    }

    [AvaloniaFact]
    public void Before_the_ring_Take_a_break_asks_for_the_note_and_offers_Skip_break_on_the_same_screen()
    {
        var agent = new FakeAgent("10:47") { Day = Days.General(), Workday = Days.Open(serverNow: "10:47", focusSec: 3600) };
        var ui = new DashboardHarness(agent);
        Assert.False(ui.Vm.BreakDue.IsShown);
        Assert.True(ui.Shows("Open now · 13 min early, reason needed")); // 4.0: Next break
        ui.Click("Next break");
        Assert.True(ui.Shows("Morning break, 13 min early"));
        Assert.True(ui.Shows("Your morning break is due at 11:00 AM. Add a short note for a manager."));
        Assert.True(ui.Shows("What is coming up?"));
        Assert.True(ui.HasButton("Skip break"));
        ui.Type(ui.Box("ReasonBox"), "A client call starts in 15 min");
        ui.Click("Start break");
        Assert.Equal(("MORNING", (string?)"A client call starts in 15 min"), Assert.Single(agent.TakeCalls));
        ui.Close();
    }

    // ---- G. Start confirmation ------------------------------------------------------------

    [AvaloniaFact]
    public void Screen_G_opens_on_Take_a_break_and_starts_the_break()
    {
        var agent = DesignDay.Due();
        var ui = new DashboardHarness(agent);
        ui.Click("Take a break");
        Assert.True(ui.Shows("Take your lunch break?"));
        Assert.True(ui.Shows("45 min, ends at 1:45 PM. Your ring pauses until you resume."));
        Assert.True(Styled(ui.Button("Start lunch"), "primary"));
        Assert.True(Styled(ui.Button("Skip break"), "secondary"));
        Saved(ui, "G-start-confirmation");
        ui.Click("Start lunch");
        Assert.False(ui.HasDialog);
        Assert.Equal(("LUNCH", (string?)null), Assert.Single(agent.TakeCalls));
        ui.Close();
    }

    [AvaloniaFact]
    public void Screen_G_closing_the_card_changes_nothing_and_a_slot_that_cannot_skip_has_no_skip()
    {
        var agent = DesignDay.Due(lunchSkippable: false);
        var ui = new DashboardHarness(agent);
        ui.Click("Take a break");
        Assert.False(ui.HasButton("Skip break"));
        ui.Click(ui.Window.GetVisualDescendants().OfType<Button>().Last(b => b.IsEffectivelyVisible && AutomationClose(b)));
        Assert.False(ui.HasDialog);
        Assert.Empty(agent.TakeCalls);

        ui.Click("Take a break");
        ui.Press(Key.Escape);
        Assert.False(ui.HasDialog);
        Assert.Empty(agent.TakeCalls);
        ui.Close();
    }

    private static bool AutomationClose(Button b) => Avalonia.Automation.AutomationProperties.GetName(b) == "Close";

    // ---- D. Skip confirmation -------------------------------------------------------------

    [AvaloniaFact]
    public void Screen_D_asks_once_says_when_the_next_one_is_and_what_a_rejection_costs()
    {
        var agent = DesignDay.Due();
        var ui = new DashboardHarness(agent);
        ui.Click("Skip this break");
        Assert.True(ui.Shows("Skip this break?"));
        Assert.True(ui.Shows("Your next one is at 4:30 PM."));
        Assert.True(ui.Shows("Your focus time keeps running. If a manager rejects the skip, the 45 min come off it."));
        Assert.True(Styled(ui.Button("Keep my break"), "secondary"));
        Assert.True(Styled(ui.Button("Skip break"), "primary"));
        Assert.True(ui.Shows("Why are you skipping it?"));
        Assert.False(ui.Button("Skip break").IsEffectivelyEnabled);
        Saved(ui, "D-skip-confirmation");

        ui.Click("Keep my break");
        Assert.False(ui.HasDialog);
        Assert.Empty(agent.SkipCalls);

        ui.Click("Skip this break");
        ui.Click("Client call");
        ui.Click("Skip break");
        Assert.False(ui.HasDialog);
        Assert.Equal(("LUNCH", (string?)"Client call"), Assert.Single(agent.SkipCalls));
        ui.Close();
    }

    [AvaloniaFact]
    public void Screen_D_on_the_last_break_says_so()
    {
        var agent = new FakeAgent("16:30") { Day = DesignDay.Slots(), Workday = Days.Open(serverNow: "16:30", focusSec: DesignDay.Worked) };
        var ui = new DashboardHarness(agent);
        ui.Click("Skip this break");
        Assert.True(ui.Shows("This is your last break today."));
        Saved(ui, "D-skip-last-break");
        ui.Close();
    }

    [AvaloniaFact]
    public void Screen_D_with_nobody_to_decide_is_only_the_question_as_page_7_draws_it()
    {
        var agent = DesignDay.Due();
        agent.User!.Role = "SUPER_ADMIN";
        var ui = new DashboardHarness(agent);
        ui.Click("Skip this break");
        Assert.True(ui.Shows("Skip this break?"));
        Assert.True(ui.Shows("Your next one is at 4:30 PM."));
        Assert.True(ui.HasButton("Keep my break"));
        Assert.True(ui.Button("Skip break").IsEffectivelyEnabled);
        Assert.Empty(ui.Boxes());
        Saved(ui, "D-skip-confirmation-question-only");
        ui.Close();
    }

    [AvaloniaFact]
    public void Screen_D_from_the_start_card_comes_back_to_it_on_Keep_my_break()
    {
        var agent = DesignDay.Due();
        var ui = new DashboardHarness(agent);
        ui.Click("Take a break");
        ui.Click("Skip break");
        Assert.True(ui.Shows("Skip this break?"));
        ui.Click("Keep my break");
        Assert.True(ui.Shows("Take your lunch break?"));
        ui.Close();
    }

    [AvaloniaFact]
    public void Screen_D_keeps_the_typed_reason_when_the_server_wants_more()
    {
        var agent = DesignDay.Due();
        agent.SkipOutcomes.Enqueue(new SkipOutcome.NeedsReason(25, "Add a little more. 25 characters or more."));
        var ui = new DashboardHarness(agent);
        ui.Click("Skip this break");
        ui.Type(ui.Box("ReasonBox"), "A long client call");
        ui.Click("Skip break");
        Assert.True(ui.Shows("Add a little more. 25 characters or more."));
        Assert.Equal("A long client call", ui.Box("ReasonBox").Text);
        ui.Close();
    }

    // ---- B. On break ----------------------------------------------------------------------

    [AvaloniaFact]
    public void Screen_B_keeps_the_64_px_ring_its_clock_runs_amber_through_lunch_and_the_focus_time_shows_paused()
    {
        var agent = DesignDay.OnLunch("13:12:42");
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("On break"));
        Assert.True(ui.Shows("3h 30m of 8h"));
        Assert.True(ui.Shows("Paused"));
        Assert.True(ui.Shows("Lunch break, 1:00 to 1:45 PM"));
        AssertNoCountdown(ui, "32:18", "left of your 45 min lunch break", "Ends at 1:45 PM");
        Assert.True(Styled(ui.Button("Resume work"), "primary"));
        Assert.Equal(BubbleStatus.Away, ui.Vm.StatusKind);
        var ring = AssertBreakRing(ui);
        Assert.Equal("Ring paused at 3h 30m. On break · 32:18", AutomationProperties.GetName(ring));

        // The clock: morning taken 11:00 to 11:14, lunch running since 1:00 in its 45 min section,
        // the evening break next at 4:30, brighter.
        var now = Assert.Single(Arcs(ui, DayRing.Kind.BreakNow));
        Assert.Equal(Deg("13:00"), now.From, 2);
        Assert.Equal(Deg("13:12:42"), now.From + now.Length, 2);
        var taken = Assert.Single(Arcs(ui, DayRing.Kind.Break));
        Assert.Equal(Deg("11:00"), taken.From, 2);
        Assert.Equal(Deg("11:14"), taken.From + taken.Length, 2);
        var next = Assert.Single(Arcs(ui, DayRing.Kind.NextSection));
        Assert.Equal(Deg("16:30"), next.From, 2);
        Assert.Equal(Deg("16:45") - Deg("16:30"), next.Length, 2);
        Assert.Contains(Deg("13:45"), Day(ui).Notches());
        Assert.False(ui.HasButton("Take a break"));
        Assert.False(ui.HasButton("End day"));
        Saved(ui, "B-on-break");

        ui.At("13:30:00");
        now = Assert.Single(Arcs(ui, DayRing.Kind.BreakNow));
        Assert.Equal(Deg("13:30"), now.From + now.Length, 2);
        Assert.True(ui.Shows("3h 30m of 8h")); // the focus time holds
        Saved(ui, "B1-thirty-minutes-in");
        ui.Close();
    }

    [AvaloniaFact]
    public void The_ring_holds_its_size_and_place_into_a_break_and_runs_green_again_on_resume()
    {
        var agent = DesignDay.Due("12:59:00");
        var ui = new DashboardHarness(agent);
        var working = ui.Window.GetVisualDescendants().OfType<PanelIcon>().Single(r => r.Name == "DayRing");
        Assert.Equal(64, working.Bounds.Width);
        // Before lunch: the lunch section waits just ahead of the green, brighter as the next break.
        var next = Assert.Single(Arcs(ui, DayRing.Kind.NextSection));
        Assert.Equal(Deg("13:00"), next.From, 2);
        Assert.Equal(Deg("12:59"), Arcs(ui, DayRing.Kind.Work).Max(a => a.From + a.Length), 2);
        Assert.Equal("Shift 9:30 AM to 6:30 PM. Next: Lunch break at 1:00 PM.", AutomationProperties.GetName(working));

        agent.Day = DesignDay.Slots().WithActive(Days.Running("LUNCH", "13:00", 45));
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Lunch, Since = Ist.At("13:00") };
        ui.At("13:20:00");
        Assert.True(ui.Vm.IsOnBreak);
        var onBreak = AssertBreakRing(ui, paused: "3h 31m"); // a minute worked from 12:59
        var place = Where(onBreak, ui);
        Assert.Single(Arcs(ui, DayRing.Kind.BreakNow));

        agent.Day = DesignDay.Slots().WithRecord(Days.Taken("LUNCH", "13:00", "13:30"));
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Working, Since = Ist.At("13:30") };
        agent.Workday = Days.Open(serverNow: "13:30", focusSec: DesignDay.Worked);
        ui.Click("Resume work");
        ui.At("13:40:00");
        Assert.False(ui.Vm.IsOnBreak);
        working = ui.Window.GetVisualDescendants().OfType<PanelIcon>().Single(r => r.Name == "DayRing");
        Assert.Equal(place, Where(working, ui)); // the plain Working screen: same size, same place
        Assert.Equal(Avalonia.Media.Color.Parse("#6FC9B6"), ui.Vm.Icon!.Frame.Look.RingColor);
        // Lunch stays amber where it was taken; the green carries on after it.
        Assert.Contains(Arcs(ui, DayRing.Kind.Break), a => Math.Abs(a.From - Deg("13:00")) < 0.01 && Math.Abs(a.From + a.Length - Deg("13:30")) < 0.01);
        Assert.Contains(Arcs(ui, DayRing.Kind.Work), a => Math.Abs(a.From - Deg("13:30")) < 0.01 && Math.Abs(a.From + a.Length - Deg("13:40")) < 0.01);
        Assert.True(ui.HasButton("Next break"));
        Saved(ui, "B3-resumed-green");
        ui.Close();
    }

    // ---- C. Break extended ----------------------------------------------------------------

    [AvaloniaFact]
    public void Screen_C_is_the_amber_running_past_the_sections_closing_notch_with_no_count()
    {
        var agent = DesignDay.OnLunch("13:45:00");
        var ui = new DashboardHarness(agent);
        Assert.False(ui.Vm.ActiveBreak.IsOverrun);
        var now = Assert.Single(Arcs(ui, DayRing.Kind.BreakNow));
        Assert.Equal(Deg("13:45"), now.From + now.Length, 2);

        ui.At("13:49:32");
        Assert.True(ui.Shows("Break extended"));
        Assert.True(ui.Shows("Lunch break, 1:00 to 1:45 PM"));
        Assert.True(ui.Shows("3h 30m of 8h"));
        AssertNoCountdown(ui, "04:32", "Your lunch break ended at 1:45 PM.", "Resume work to start your ring again.");
        Assert.Equal("Break extended · 04:32", ui.Vm.ActiveBreak.OneLine); // the hover label and screen readers keep the count
        AssertBreakRing(ui);
        now = Assert.Single(Arcs(ui, DayRing.Kind.BreakNow));
        Assert.Equal(Deg("13:49:32"), now.From + now.Length, 2);
        Assert.Contains(Deg("13:45"), Day(ui).Notches()); // the amber runs past this notch
        Assert.True(ui.HasButton("Resume work"));
        Assert.Equal(BreakAlertKind.BreakExtended, ui.Vm.BreakAlert);
        Assert.Equal("!", ui.Vm.Icon!.Badge); // the floating icon's; the panel's clock draws none
        Assert.Equal(BubbleStatus.Overrun, ui.Vm.StatusKind);
        Saved(ui, "C-break-extended");

        ui.At("14:20:00");
        now = Assert.Single(Arcs(ui, DayRing.Kind.BreakNow));
        Assert.Equal(Deg("14:20") - Deg("13:45"), now.From + now.Length - Deg("13:45"), 2);
        Saved(ui, "C2-thirty-five-over");
        ui.Close();
    }

    // ---- E. Two minutes before a break ends -----------------------------------------------

    [AvaloniaFact]
    public void Screen_E_is_a_card_on_screen_B_at_120_seconds_with_the_i_badge_and_Resume_now()
    {
        var agent = DesignDay.OnLunch("13:42:59");
        var ui = new DashboardHarness(agent);
        Assert.False(ui.Vm.ActiveBreak.EndsSoon);
        Assert.False(ui.Shows("Break ends in 2 min"));

        ui.At("13:43:00");
        Assert.True(ui.Shows("Break ends in 2 min"));
        Assert.True(ui.Shows("Your ring starts again when you resume."));
        Assert.True(ui.Shows("i"));
        // G5 (owner's choice, 18 Nov): one action, one button. The card's Resume now is the screen's
        // filled button and the pinned Resume work is hidden while the card shows (was: both).
        Assert.True(Styled(ui.Button("Resume now"), "primary"));
        Assert.True(ui.Shows("Lunch break, 1:00 to 1:45 PM")); // screen B goes on under it
        Assert.False(ui.Shows("02:00"));
        Assert.False(ui.HasButton("Resume work"));
        Assert.Equal(BreakAlertKind.BreakEndsSoon, ui.Vm.BreakAlert);
        Assert.Equal("i", ui.Vm.Icon!.Badge);
        Saved(ui, "E-two-minutes");

        ui.Click("Resume now");
        // 4.0: ending a break always asks first (SPEC 2.3).
        Assert.True(ui.Shows("End your lunch break now?"));
        ui.Click("End break");
        Assert.Equal(1, agent.BackToWorkCalls);

        // It goes once the break runs out.
        ui.At("13:45:01");
        Assert.False(ui.Shows("Break ends in 2 min"));
        Assert.Equal(BreakAlertKind.BreakExtended, ui.Vm.BreakAlert);
        Assert.True(ui.HasButton("Resume work"));   // the card is gone: the pinned one is back
        ui.Close();
    }

    [AvaloniaFact]
    public void A_break_of_two_minutes_or_less_never_shows_screen_E()
    {
        var day = DesignDay.Slots();
        day.Breaks[2] = Days.Slot("EVENING", "16:30", 2).Skippable();
        var agent = new FakeAgent("16:30:30")
        {
            Day = day.WithActive(Days.Running("EVENING", "16:30", 2)),
            Workday = Days.Open(serverNow: "16:30", focusSec: DesignDay.Worked),
            Presence = new CurrentPresence { Status = PresenceStatus.Break, Since = Ist.At("16:30") },
        };
        var ui = new DashboardHarness(agent);
        Assert.False(ui.Shows("Break ends in 2 min"));
        Assert.Equal(BreakAlertKind.None, ui.Vm.BreakAlert);
        ui.Close();
    }

    // ---- F. A break with no length --------------------------------------------------------

    [AvaloniaFact]
    public void Screen_F_with_no_shift_keeps_the_64_px_ring_and_fills_after_the_held_arc_with_no_count()
    {
        var agent = DesignDay.PlainBreak("10:12:20");
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("On break"));
        Assert.True(ui.Shows("3h 30m of 8h"));
        Assert.True(ui.Shows("Break since 10:00 AM"));
        AssertBreakRing(ui);
        AssertNoCountdown(ui, "12 min so far");
        Assert.Equal("Ring paused at 3h 30m. On break · 12 min so far", ui.Vm.ActiveBreak.RingName);
        Assert.Null(ui.Vm.BreakIcon!.Day); // a free day has no shift clock
        var ring = ui.Vm.BreakIcon.Break!.Layout(ui.Vm.BreakIcon.Frame.SweepDegrees);
        Assert.Equal(0, ring.SectionLength);
        Assert.Equal(12.333 * BreakSpan.NoLengthPace, ring.Fill, 1);
        Assert.True(ui.HasButton("Resume work"));
        Saved(ui, "F-no-length");

        ui.At("11:05:40");
        Assert.Equal(BreakAlertKind.None, ui.Vm.BreakAlert);
        ui.Click("Resume work");
        Assert.True(ui.HasDialog); // 4.0: ending a break always asks first (SPEC 2.3)
        ui.Close();
    }

    /// <summary>The panel's 64 px ring at three times its size through a day, for the review.</summary>
    [AvaloniaFact]
    public void Ring_close_ups_through_a_day()
    {
        var shiftStart = Ist.At("09:30");
        DayRing At(string now, bool onLunch = false, string? lunchEnd = null, string? next = null)
        {
            var breaks = new List<DayRingBreak> { new(Ist.At("11:00"), 15, Ist.At("11:00"), Ist.At("11:14")) };
            if (onLunch) breaks.Add(new DayRingBreak(Ist.At("13:00"), 45, Ist.At("13:00"), lunchEnd is null ? null : Ist.At(lunchEnd)));
            else breaks.Add(new DayRingBreak(Ist.At("13:00"), 45, Next: next == "LUNCH"));
            breaks.Add(new DayRingBreak(Ist.At("16:30"), 15, Next: next == "EVENING"));
            if (Ist.At(now) < Ist.At("11:00")) breaks[0] = new DayRingBreak(Ist.At("11:00"), 15, Next: true);
            return new DayRing(shiftStart, Ist.At("18:30"), Ist.At(now), shiftStart, null, breaks);
        }
        var working = IconLook.For(IconStatus.Working, false);
        var away = IconLook.For(IconStatus.OnBreak, false);
        void Shoot(string name, IconLook look, DayRing day)
        {
            var window = new Window
            {
                Width = 220, Height = 220,
                Background = new Avalonia.Media.SolidColorBrush(Avalonia.Media.Color.Parse("#1A2029")),
                Content = new PanelIcon { Width = 192, Height = 192, State = new PanelIconState(new IconFrame(look, 0, null, 1), false, "", Day: day),
                    HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Center, VerticalAlignment = Avalonia.Layout.VerticalAlignment.Center },
            };
            window.Show();
            var path = Shots.Save(window, name);
            Assert.True(new FileInfo(path).Length > 3_000, $"{name} looks empty");
            window.Close();
        }
        Shoot("ring-1-morning", working, At("10:15"));
        Shoot("ring-2-lunch-coming", working, At("12:40", next: "LUNCH"));
        Shoot("ring-3-on-lunch", away, At("13:25", onLunch: true));
        Shoot("ring-4-lunch-over", away, At("14:00", onLunch: true));
        Shoot("ring-5-back-to-work", working, At("15:10", onLunch: true, lunchEnd: "13:44", next: "EVENING"));
    }

    [Fact]
    public void The_shift_bounds_come_from_its_times_and_a_breaks_own_instant_across_midnight_too()
    {
        var day = Days.General();
        Assert.Equal((Ist.At("09:30"), Ist.At("18:30")), BreakSchedule.ShiftBounds(day));

        var night = Days.General();
        night.Shift!.Start = "22:00";
        night.Shift.End = "06:00";
        night.Breaks = new List<BreakSlot> { Days.Slot("LUNCH", "02:00", 30) };
        Assert.Equal((Ist.At("02:00").AddHours(-4), Ist.At("02:00").AddHours(4)), BreakSchedule.ShiftBounds(night));

        Assert.Null(BreakSchedule.ShiftBounds(Days.Free()));
    }

    [Fact]
    public void The_shift_runs_round_the_ring_from_the_dot_with_each_break_where_its_time_falls()
    {
        var shift = new DayRing(Ist.At("09:30"), Ist.At("18:30"), Ist.At("12:00"), Ist.At("09:30"), null, new List<DayRingBreak>
        {
            new(Ist.At("11:00"), 15, Ist.At("11:00"), Ist.At("11:20")),
            new(Ist.At("13:00"), 45, Next: true),
        });
        Assert.Equal(0, shift.Degrees(Ist.At("09:00")));
        Assert.Equal(180, shift.Degrees(Ist.At("14:00")), 3);
        Assert.Equal(360, shift.Degrees(Ist.At("19:30")));
        Assert.Equal(new[] { 60.0, 70.0, 140.0, 170.0 }, shift.Notches().Select(d => Math.Round(d, 3)));
        var arcs = shift.Arcs();
        // Work 9:30 to 11:00 and 11:20 to 12:00; the morning's 20 min amber, 5 past its closing notch.
        var work = arcs.Where(a => a.Kind == DayRing.Kind.Work).ToList();
        Assert.Equal(2, work.Count);
        Assert.Equal((0, 60), (work[0].From, Math.Round(work[0].Length, 3)));
        Assert.Equal(Deg("11:20"), work[1].From, 3);
        Assert.Equal(Deg("12:00"), work[1].From + work[1].Length, 3);
        var morning = Assert.Single(arcs, a => a.Kind == DayRing.Kind.Break);
        Assert.Equal(60, morning.From, 3);
        Assert.Equal(Deg("11:20") - 60, morning.Length, 3);
        Assert.Single(arcs, a => a.Kind == DayRing.Kind.NextSection && Math.Abs(a.From - 140) < 0.001);
    }

    [Fact]
    public void A_break_section_is_a_quarter_of_the_ring_whatever_its_length()
    {
        var lunch = new BreakSpan(45, 45).Layout(100);
        var tea = new BreakSpan(15, 15).Layout(100);
        Assert.Equal(lunch, tea);
        Assert.Equal(90, lunch.Fill);
        Assert.Equal(0, lunch.Over);

        // Past target: the full arc gives way so the break still shows, ending a gap short of the dot.
        var late = new BreakSpan(15, 5).Layout(360);
        Assert.Equal(360 - BreakSpan.Gap - BreakSpan.Gap - 90 - BreakSpan.Gap, late.Held, 3);
        Assert.Equal(30, late.Fill, 3);

        // Hours over: the run over stops a gap short of the dot.
        var forgotten = new BreakSpan(15, 600).Layout(200);
        Assert.Equal(0, forgotten.Held);
        Assert.Equal(360 - BreakSpan.Gap, forgotten.OverStart + forgotten.Over, 3);
    }

    [AvaloniaFact]
    public void A_free_day_offers_a_break_and_lunch_with_no_card_then_screen_F()
    {
        var agent = new FakeAgent("10:47") { Day = Days.Free() };
        var ui = new DashboardHarness(agent);
        Assert.False(ui.Vm.BreakDue.IsShown);
        // 4.0: Next break on a free day offers lunch or a break; Quick break sits beside it.
        Assert.True(Styled(ui.Button("Next break"), "secondary"));
        Assert.True(Styled(ui.Button("Quick break"), "secondary"));
        ui.Click("Next break");
        Assert.True(ui.Shows("There's no break schedule today. Your ring pauses until you resume."));
        ui.Click("Start lunch");
        Assert.Equal(new[] { PresenceStatus.Lunch }, agent.FreeCalls);
        ui.Close();
    }

    // ---- Around the screens ----------------------------------------------------------------

    [AvaloniaFact]
    public void An_auto_skip_puts_a_card_on_top_with_Add_comment_until_the_comment_is_sent()
    {
        var agent = new FakeAgent("12:10") { Day = Days.General().WithRecord(Days.Skip("MORNING", "12:00", auto: true)) };
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("Morning break skipped for you."));
        Assert.True(ui.Shows("Add a comment before you end your day."));
        Assert.Equal(BreakAlertKind.CommentNeeded, ui.Vm.BreakAlert);
        Assert.Equal("!", ui.Vm.Icon!.Badge);
        Saved(ui, "comment-card");
        ui.Click(ui.ButtonsReading("Add comment").First());
        Assert.True(ui.Shows("Add a comment"));
        ui.Type(ui.Box("ReasonBox"), "The client demo ran until 12:15");
        ui.Click("Send comment");
        Assert.Equal(("morning-auto", "The client demo ran until 12:15"), Assert.Single(agent.CommentCalls));
        ui.Close();
    }

    [AvaloniaFact]
    public void Plain_working_shows_the_status_line_progress_and_outlined_actions_above_the_breaks()
    {
        var agent = new FakeAgent("10:20") { Day = DesignDay.Slots(), Workday = Days.Open(serverNow: "10:20", focusSec: 3600) };
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("Working"));
        Assert.True(ui.Shows("1h 00m of 8h"));
        Assert.True(ui.Shows("7h 00m to go"));
        foreach (var name in new[] { "Next break", "Quick break", "Start meeting" })
            Assert.True(Styled(ui.Button(name), "secondary"), name);
        Assert.True(Styled(ui.Button("End day"), "quiet"));
        Assert.True(ui.Shows("Time taken today"));
        Assert.True(ui.Shows("Online · synced 10:44 AM"));
        Assert.True(IsAbove(ui, "7h 00m to go", "Today's breaks"));
        ui.Close();
    }

    [AvaloniaFact]
    public void Past_the_target_the_panel_says_so_and_how_far()
    {
        var agent = new FakeAgent("18:00") { Day = Days.Free(), Workday = Days.Open(serverNow: "18:00", focusSec: 8 * 3600 + 15 * 60) };
        var ui = new DashboardHarness(agent);
        Assert.True(ui.Shows("Target reached · 8h 15m today"));
        Assert.True(ui.Shows("+15 min over target"));
        Assert.True(ui.Vm.Icon!.PastTarget);
        ui.Close();
    }

    [AvaloniaFact]
    public void Nothing_is_read_as_a_message_until_Messages_opens()
    {
        var agent = new FakeAgent("10:20") { ChatUnread = 2 };
        var ui = new DashboardHarness(agent);
        Assert.Equal(0, agent.FakeChat.Loads);
        ui.Click("Messages");
        Assert.True(ui.Vm.IsMessagesTab);
        DashboardHarness.Settle();
        Assert.Equal(1, agent.FakeChat.Loads);
        ui.Close();
    }
}

/// <summary>The window itself: 340 x 540, no system frame, tabs, Close, and where it opens.</summary>
public class PanelFrameTests
{
    [AvaloniaFact]
    public void The_panel_is_340_by_540_with_no_system_frame_and_fixed_size()
    {
        var ui = new DashboardHarness(new FakeAgent("10:20"));
        Assert.Equal(340, ui.Window.ClientSize.Width);
        Assert.Equal(540, ui.Window.ClientSize.Height);
        Assert.False(ui.Window.CanResize);
        Assert.Equal(SystemDecorations.None, ui.Window.SystemDecorations);
        ui.Close();
    }

    [AvaloniaFact]
    public void Close_only_hides_the_panel()
    {
        var ui = new DashboardHarness(new FakeAgent("10:20"));
        ui.Click(ui.Window.CloseButton);
        Assert.False(ui.Window.IsVisible);
        ui.Window.AllowClose = true;
        ui.Window.Close();
    }

    [AvaloniaFact]
    public void Every_tab_and_page_is_reachable_and_opening_Today_comes_back_from_any_of_them()
    {
        var agent = new FakeAgent("10:20") { LeaveResult = ApiResult<MyLeave>.Success(LeavePageTests.Leave()) };
        agent.GuideResult = (PagesData.Guide(), true);
        agent.CalendarFor = y => ApiResult<CalendarYear>.Success(PagesData.Calendar(y));
        var signedOut = 0;
        var ui = new DashboardHarness(agent);
        ui.Vm.SignOutRequested = () => { signedOut++; return Task.CompletedTask; };

        ui.Click("Profile");
        Assert.True(ui.Vm.ShowProfileList);
        ui.Click("Instructions");
        Assert.True(ui.Vm.IsInstructionsPage);
        ui.Click("Back");
        ui.Click("My calendar");
        Assert.True(ui.Vm.IsCalendarPage);
        ui.Click("Back");
        ui.Click("Leave");
        Assert.True(ui.Vm.IsLeavePage);
        Assert.True(ui.HasButton("Apply for leave"));
        ui.Click("Today");
        Assert.True(ui.Vm.IsTodayTab && ui.Vm.IsDashboardPage);
        ui.Click("Profile");
        ui.Click("Sign out");
        Assert.Equal(1, signedOut);
        ui.Close();
    }

    [AvaloniaFact]
    public void The_newest_cards_primary_action_has_the_keyboard_as_the_panel_opens()
    {
        var ui = new DashboardHarness(DesignDay.Due());
        ui.Window.FocusNewestCard();
        DashboardHarness.Settle();
        Assert.True(ui.Window.TakeBreakNow.IsFocused);
        ui.Close();
    }

    [Fact]
    public void A_settings_file_from_the_old_window_still_reads()
    {
        var dir = Path.Combine(Path.GetTempPath(), "rxv-ui-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "ui-settings.json"), """{ "Dashboard": { "X": 1, "Y": 2, "Width": 1080, "Height": 700 }, "LastEmail": "asha@timechamp.test" }""");
        var store = new UiSettingsStore(dir, Core.Util.NullLog.Instance);
        Assert.Equal("asha@timechamp.test", store.Current.LastEmail);
    }

    private static readonly PixelRect Work = new(0, 25, 1920, 1015);

    [Fact]
    public void It_opens_left_of_the_icon_bottoms_aligned_with_a_16_px_gap()
    {
        var at = PanelPlacement.Place(new PixelPoint(1864, 984), Work, 1);
        Assert.Equal(1864 - 28 - 16 - 340, at.X);
        Assert.Equal(984 + 28 - 540, at.Y);
    }

    [Fact]
    public void With_no_room_on_the_left_it_opens_on_the_right()
    {
        var at = PanelPlacement.Place(new PixelPoint(100, 600), Work, 1);
        Assert.Equal(100 + 28 + 16, at.X);
    }

    [Fact]
    public void It_stays_inside_the_work_area_at_any_scale()
    {
        var high = PanelPlacement.Place(new PixelPoint(1864, 100), Work, 1);
        Assert.Equal(Work.Y, high.Y);
        var scaled = PanelPlacement.Place(new PixelPoint(3728, 1968), new PixelRect(0, 50, 3840, 2030), 2);
        Assert.Equal(3728 - 2 * (28 + 16 + 340), scaled.X);
        Assert.Equal(1968 + 2 * 28 - 2 * 540, scaled.Y);
    }
}

/// <summary>The alert seam (<see cref="BreakAlerts"/>): what the floating icon reads to raise its badge.</summary>
public class BreakAlertSeamTests
{
    /// <summary>What the icon shows for this day, with the app's own pieces, beside what the seam says.</summary>
    private static (string?, BreakAlertKind) Read(FakeAgent agent)
    {
        using var rig = new IconRig(agent);
        rig.DayAlerts.Sync();
        rig.Vm.Update();
        return (rig.Vm.BadgeGlyph, BreakAlerts.For(agent.State, agent.BreakPanel, agent.Workday, agent.IsBiometric));
    }

    [Fact]
    public void Due_is_action_two_minutes_is_information_extended_is_action()
    {
        Assert.Equal(("!", BreakAlertKind.BreakDue), Read(DesignDay.Due()));
        Assert.Equal((null, BreakAlertKind.None), Read(DesignDay.OnLunch("13:10")));
        Assert.Equal(("i", BreakAlertKind.BreakEndsSoon), Read(DesignDay.OnLunch("13:44")));
        Assert.Equal(("!", BreakAlertKind.BreakExtended), Read(DesignDay.OnLunch("13:50")));
        Assert.Equal((null, BreakAlertKind.None), Read(DesignDay.PlainBreak("10:45")));
    }

    [Fact]
    public void A_skip_waiting_for_its_comment_is_action_and_nothing_fires_outside_the_running_day()
    {
        var waiting = new FakeAgent("12:10") { Day = Days.General().WithRecord(Days.Skip("MORNING", "12:00", auto: true)) };
        Assert.Equal(("!", BreakAlertKind.CommentNeeded), Read(waiting));

        var ended = DesignDay.Due();
        ended.State = AgentState.DayEnded;
        Assert.Equal((null, BreakAlertKind.None), Read(ended));

        var biometric = DesignDay.Due();
        biometric.IsBiometric = true;
        Assert.Equal((null, BreakAlertKind.None), Read(biometric));
    }

    [Fact]
    public void The_status_stays_amber_when_a_break_runs_over()
    {
        Assert.Equal(RXVision.Agent.Icon.IconStatus.BreakExtended, RXVision.Agent.Icon.DayMeter.StatusOf(DesignDay.OnLunch("13:50")));
        var dot = new Converters.StatusBrushConverter().Convert(BubbleStatus.Overrun, typeof(object), null, System.Globalization.CultureInfo.InvariantCulture);
        Assert.Equal(Avalonia.Media.Color.Parse("#F2A93B"), ((Avalonia.Media.ISolidColorBrush)dot!).Color);
    }
}
