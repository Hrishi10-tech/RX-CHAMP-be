using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using Xunit;

namespace RXVision.Agent.UI.Tests;

public class ReasonDialogTests
{
    [Fact]
    public async Task Submit_waits_for_the_minimum_length()
    {
        var dialog = new ReasonDialogViewModel("Morning break, 12 min after its time", "Your morning break was due at 11:00 AM. Add a short note for a manager.", 10);
        Assert.False(dialog.SubmitCommand.CanExecute(null));
        Assert.Equal("10 more characters", dialog.CountText);
        Assert.False(dialog.CountOk);

        dialog.Text = "On a call";
        Assert.Equal("1 more character", dialog.CountText);
        Assert.False(dialog.SubmitCommand.CanExecute(null));

        dialog.Text = "   On a cal   ";
        Assert.Equal(8, dialog.Length);
        Assert.False(dialog.SubmitCommand.CanExecute(null));

        dialog.Text = "On a customer call";
        Assert.True(dialog.CountOk);
        Assert.Equal("Looks good", dialog.CountText);
        Assert.True(dialog.SubmitCommand.CanExecute(null));
        dialog.SubmitCommand.Execute(null);
        Assert.True(dialog.Completion.IsCompletedSuccessfully);
        Assert.True(await dialog.Completion);
        Assert.Equal("On a customer call", dialog.Reason);
    }

    [Fact]
    public void Counts_down_near_the_limit_and_refuses_too_long()
    {
        var dialog = new ReasonDialogViewModel("t", "m", 10);
        Assert.Equal(500, dialog.MaxLength);
        dialog.Text = new string('a', 470);
        Assert.Equal("30 characters left", dialog.CountText);
        dialog.Text = new string('a', 501);
        Assert.Equal("1 too many", dialog.CountText);
        Assert.False(dialog.SubmitCommand.CanExecute(null));
    }

    [Fact]
    public async Task Cancel_answers_false()
    {
        var dialog = new ReasonDialogViewModel("t", "m", 10) { Text = "A long enough reason" };
        dialog.CancelCommand.Execute(null);
        Assert.False(await dialog.Completion);
    }

    [Fact]
    public async Task Note_dialog_skip_sends_no_note()
    {
        var dialog = new NoteDialogViewModel("t", "m") { SkipText = "Skip", Text = "typed anyway" };
        dialog.SkipCommand.Execute(null);
        Assert.True(await dialog.Completion);
        Assert.Null(dialog.Note);
    }
}

/// <summary>The start, skip and back-to-work flows shared by tiles, menus and toasts.</summary>
public class BreakActionsTests
{
    private static (BreakActions Actions, FakeAgent Agent, FakeDialogs Dialogs) Setup(string now, BreakDay? day = null, string role = "USER")
    {
        var agent = new FakeAgent(now) { Day = day ?? Days.General() };
        agent.User!.Role = role;
        var dialogs = new FakeDialogs();
        return (new BreakActions(agent, dialogs, NullLog.Instance), agent, dialogs);
    }

    [Fact]
    public async Task Late_start_asks_for_a_reason_first()
    {
        var (actions, agent, dialogs) = Setup("11:12");
        dialogs.Answer(d =>
        {
            var reason = Assert.IsType<ReasonDialogViewModel>(d);
            Assert.Equal("Morning break, 12 min after its time", reason.Title);
            Assert.Equal("Your morning break was due at 11:00 AM. Add a short note for a manager.", reason.Message);
            Assert.Equal("Starting after its time", reason.TagText);
            Assert.Equal("Due 11:00 AM · window 10:30 AM to 12:00 PM", reason.TagDetail);
            Assert.Equal("What came up?", reason.Label);
            Assert.Equal("Start break", reason.PrimaryText);
            Assert.Equal("Skip break", reason.AltText);
            reason.Text = "On a customer call until now";
            return true;
        });
        await actions.TakeAsync(PresenceStatus.Break);
        Assert.Equal(("MORNING", (string?)"On a customer call until now"), Assert.Single(agent.TakeCalls));
        Assert.Empty(agent.SkipCalls);
    }

    [Fact]
    public async Task Cancelling_the_reason_starts_nothing()
    {
        var (actions, agent, dialogs) = Setup("11:12");
        dialogs.Answer(_ => false);
        await actions.TakeAsync(PresenceStatus.Break);
        Assert.Empty(agent.TakeCalls);
        Assert.Empty(agent.SkipCalls);
    }

    [Fact]
    public async Task On_time_confirms_then_starts_without_a_reason()
    {
        var (actions, agent, dialogs) = Setup("10:59:30");
        dialogs.Answer(d =>
        {
            var confirm = Assert.IsType<MessageDialogViewModel>(d);
            Assert.Equal("Take your morning break?", confirm.Title);
            Assert.Equal("15 min, ends at 11:14 AM. Your ring pauses until you resume.", confirm.Message);
            Assert.Equal("Start break", confirm.PrimaryText);
            Assert.Equal("Skip break", confirm.AltText);
            Assert.Null(confirm.CancelText);
            Assert.True(confirm.ShowClose);
            return true;
        });
        await actions.TakeAsync(PresenceStatus.Break);
        Assert.Equal(("MORNING", (string?)null), Assert.Single(agent.TakeCalls));
    }

    [Fact]
    public async Task Lunch_has_no_skip_when_the_shift_does_not_allow_it()
    {
        var (actions, agent, dialogs) = Setup("12:59:30");
        dialogs.Answer(d =>
        {
            var confirm = Assert.IsType<MessageDialogViewModel>(d);
            Assert.Equal("Take your lunch break?", confirm.Title);
            Assert.Null(confirm.AltText);
            Assert.Equal("Start lunch", confirm.PrimaryText);
            return false;
        });
        await actions.TakeAsync(PresenceStatus.Lunch);
        Assert.Empty(agent.TakeCalls);

        dialogs.Answer(_ => true);
        await actions.SkipAsync("LUNCH");
        var alert = Assert.IsType<MessageDialogViewModel>(dialogs.Shown[^1]);
        Assert.Equal("Lunch break can't be skipped", alert.Title);
        Assert.Equal("Your shift doesn't allow skipping this break.", alert.Message);
        Assert.Empty(agent.SkipCalls);
    }

    [Fact]
    public async Task Take_it_from_the_ring_skips_the_confirmation()
    {
        var (actions, agent, dialogs) = Setup("10:59:30");
        await actions.TakeAsync(PresenceStatus.Break, "MORNING", confirm: false);
        Assert.Empty(dialogs.Shown);
        Assert.Single(agent.TakeCalls);
    }

    [Fact]
    public async Task Server_judged_late_reopens_the_dialog_with_its_message()
    {
        var (actions, agent, dialogs) = Setup("11:03:50");
        agent.StartOutcomes.Enqueue(new StartOutcome.NeedsReason("LATE", 1, 12, "You're 1 min late for your morning break. Add a reason."));
        dialogs
            .Answer(_ => true) // the on-time confirmation
            .Answer(d =>
            {
                var reason = Assert.IsType<ReasonDialogViewModel>(d);
                Assert.Equal("You're 1 min late for your morning break. Add a reason.", reason.Message);
                Assert.Equal(12, reason.MinChars);
                Assert.Equal("Morning break, 1 min after its time", reason.Title);
                Assert.Null(reason.AltText); // asked again by the server: no Skip here
                reason.Text = "Was finishing an email";
                return true;
            });
        await actions.TakeAsync(PresenceStatus.Break);
        Assert.Equal(2, agent.TakeCalls.Count);
        Assert.Null(agent.TakeCalls[0].Reason);
        Assert.Equal("Was finishing an email", agent.TakeCalls[1].Reason);
    }

    [Fact]
    public async Task Refused_shows_the_servers_message()
    {
        var (actions, agent, dialogs) = Setup("11:12");
        agent.StartOutcomes.Enqueue(new StartOutcome.Refused("BREAK_WINDOW_CLOSED", "That break's window has closed."));
        dialogs.Answer(d => { ((ReasonDialogViewModel)d).Text = "Long enough reason"; return true; })
               .Answer(_ => true);
        await actions.TakeAsync(PresenceStatus.Break);
        var alert = Assert.IsType<MessageDialogViewModel>(dialogs.Shown[1]);
        Assert.Equal("Try starting your break again", alert.Title);
        Assert.Equal("That break's window has closed.", alert.Message);
        Assert.False(alert.HasCancel);
    }

    [Fact]
    public async Task Offline_starts_at_once_and_never_offers_a_retry()
    {
        // SPEC 6: the start is kept on this computer and shown at once; it is sent later.
        var (actions, agent, dialogs) = Setup("10:59:30");
        agent.Online = false;
        dialogs.Answer(_ => true); // confirm
        await actions.TakeAsync(PresenceStatus.Break);
        Assert.Single(agent.TakeCalls);
        Assert.Single(dialogs.Shown);
    }

    [Fact]
    public async Task Blocked_explains_when_it_opens()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        dialogs.Answer(_ => true);
        await actions.TakeAsync(PresenceStatus.Break);
        Assert.Empty(agent.TakeCalls);
        var alert = Assert.IsType<MessageDialogViewModel>(Assert.Single(dialogs.Shown));
        Assert.Equal("Morning break isn't open yet", alert.Title);
        Assert.Equal("Due at 11:00 AM. You can start or skip it from 10:30 AM. Before 10:59 AM it needs a reason.", alert.Message);
    }

    [Fact]
    public void Taken_says_whats_next_or_that_there_is_nothing_left()
    {
        var (actions, _, _) = Setup("17:20");
        var day = Days.General()
            .WithRecord(Days.Taken("MORNING", "11:00", "11:14"))
            .WithRecord(Days.Taken("LUNCH", "13:00", "13:28", duration: 30))
            .WithRecord(Days.Taken("EVENING", "16:00", "16:12"));
        var panel = BreakSchedule.Compute(day, Ist.At("17:20"));
        Assert.Equal(("Evening break already taken", "There are no more breaks today."), actions.BlockedText(panel.Slots[2], panel));
        Assert.Equal(("Lunch break already taken", "There's no more lunch today."), actions.BlockedText(panel.Slots[1], panel));

        var midday = BreakSchedule.Compute(Days.General().WithRecord(Days.Taken("MORNING", "11:00", "11:14")), Ist.At("11:20"));
        Assert.Equal(("Morning break already taken", "Next: Lunch break at 1:00 PM, opens 12:30 PM."), actions.BlockedText(midday.Slots[0], midday));
    }

    [Fact]
    public void Closed_window_says_when_it_was_open_and_whats_next()
    {
        var (actions, _, _) = Setup("12:10");
        var panel = BreakSchedule.Compute(Days.General(), Ist.At("12:10"));
        Assert.Equal(SlotState.Closed, panel.Slots[0].State);
        var (title, message) = actions.BlockedText(panel.Slots[0], panel);
        Assert.Equal("Morning break has closed", title);
        Assert.Equal("It could be started between 10:30 AM and 12:00 PM. Next: Lunch break at 1:00 PM, opens 12:30 PM.", message);
    }

    [Fact]
    public void Skipped_and_auto_skipped_say_so()
    {
        var (actions, _, _) = Setup("12:10");
        var skipped = BreakSchedule.Compute(Days.General().WithRecord(Days.Skip("MORNING", "11:02", auto: false, reason: "Client call ran over")), Ist.At("12:10"));
        Assert.Equal(("Morning break was skipped", "Next: Lunch break at 1:00 PM, opens 12:30 PM."), actions.BlockedText(skipped.Slots[0], skipped));

        var auto = BreakSchedule.Compute(Days.General().WithRecord(Days.Skip("MORNING", "12:00", auto: true)), Ist.At("12:10"));
        Assert.Equal(("Morning break was skipped for you", "Add a comment before you end the day. Its window closed before it was taken."),
            actions.BlockedText(auto.Slots[0], auto));
    }

    [Fact]
    public async Task Free_mode_uses_plain_breaks()
    {
        var (actions, agent, dialogs) = Setup("10:20", Days.Free());
        dialogs.Answer(d => { Assert.Equal("Go to lunch?", ((MessageDialogViewModel)d).Title); return true; });
        await actions.TakeAsync(PresenceStatus.Lunch);
        Assert.Equal("LUNCH", Assert.Single(agent.FreeCalls));
        Assert.Empty(agent.TakeCalls);
    }

    [Fact]
    public async Task Breaks_wait_for_Start_Day()
    {
        var (actions, agent, dialogs) = Setup("10:59:30");
        agent.State = AgentState.NotStarted;
        dialogs.Answer(_ => true);
        await actions.TakeAsync(PresenceStatus.Break);
        var alert = Assert.IsType<MessageDialogViewModel>(Assert.Single(dialogs.Shown));
        Assert.Equal("Start your day first", alert.Title);
        Assert.Empty(agent.TakeCalls);
    }

    // ---- Skip break ----------------------------------------------------------------------

    [Fact]
    public async Task Skip_from_the_start_dialog_asks_why_then_skips()
    {
        var (actions, agent, dialogs) = Setup("10:59:30");
        var cues = new List<string>();
        actions.Cue += cues.Add;
        dialogs
            .Alternative(d => Assert.Equal("Skip break", Assert.IsType<MessageDialogViewModel>(d).AltText))
            .Answer(d =>
            {
                var skip = Assert.IsType<ReasonDialogViewModel>(d);
                Assert.Equal("Skip this break?", skip.Title);
                Assert.Equal("Your next one is at 1:00 PM.", skip.Lead);
                Assert.Equal("Your focus time keeps running. If a manager rejects the skip, the 15 min come off it.", skip.Message);
                Assert.Equal("Why are you skipping it?", skip.Label);
                Assert.Equal("10 characters or more, please.", skip.Hint);
                Assert.Equal("Skip break", skip.PrimaryText);
                Assert.Equal("Keep my break", skip.CancelText);
                Assert.Equal(new[] { "Client call", "Deadline", "Not needed today", "Already rested" }, skip.Chips.Select(c => c.Label));
                Assert.False(skip.SubmitCommand.CanExecute(null));
                skip.Chips[0].PickCommand.Execute(null); // "Client call": 11 characters
                Assert.True(skip.Chips[0].IsOn);
                Assert.True(skip.SubmitCommand.CanExecute(null));
                return true;
            });
        await actions.TakeAsync(PresenceStatus.Break);
        Assert.Equal(("MORNING", (string?)"Client call"), Assert.Single(agent.SkipCalls));
        Assert.Empty(agent.TakeCalls);
        Assert.Equal(new[] { "Skipped and noted. Keep it steady." }, cues);
    }

    [Fact]
    public async Task Back_from_the_skip_dialog_returns_to_the_start_dialog()
    {
        var (actions, agent, dialogs) = Setup("10:59:30");
        dialogs
            .Alternative()                 // Skip break
            .Answer(_ => false)            // Back
            .Answer(d =>
            {
                Assert.Equal("Take your morning break?", d.Title); // the start dialog again
                return true;
            });
        await actions.TakeAsync(PresenceStatus.Break);
        Assert.Empty(agent.SkipCalls);
        Assert.Equal(("MORNING", (string?)null), Assert.Single(agent.TakeCalls));
    }

    [Fact]
    public async Task Skip_from_the_late_reason_dialog()
    {
        var (actions, agent, dialogs) = Setup("11:12");
        dialogs
            .Alternative(d => Assert.Equal("Morning break, 12 min after its time", d.Title))
            .Answer(d => { ((ReasonDialogViewModel)d).Text = "On a client call until noon"; return true; });
        await actions.TakeAsync(PresenceStatus.Break);
        Assert.Equal(("MORNING", (string?)"On a client call until noon"), Assert.Single(agent.SkipCalls));
        Assert.Empty(agent.TakeCalls);
    }

    [Fact]
    public async Task Skip_needing_more_keeps_the_text_and_says_why()
    {
        var (actions, agent, dialogs) = Setup("10:59:30");
        agent.SkipOutcomes.Enqueue(new SkipOutcome.NeedsReason(20, "Add a little more. 20 characters or more."));
        dialogs
            .Answer(d => { ((ReasonDialogViewModel)d).Text = "Client call"; return true; })
            .Answer(d =>
            {
                var again = Assert.IsType<ReasonDialogViewModel>(d);
                Assert.Equal("Client call", again.Text);
                Assert.Equal("Add a little more. 20 characters or more.", again.Error);
                Assert.Equal(20, again.MinChars);
                Assert.False(again.SubmitCommand.CanExecute(null));
                again.Text = "Client call about the invoice release";
                return true;
            });
        await actions.SkipAsync("MORNING");
        Assert.Equal(2, agent.SkipCalls.Count);
        Assert.Equal("Client call about the invoice release", agent.SkipCalls[1].Reason);
    }

    [Fact]
    public async Task Skip_refused_says_so()
    {
        var (actions, agent, dialogs) = Setup("10:59:30");
        agent.SkipOutcomes.Enqueue(new SkipOutcome.Refused("BREAK_WINDOW_CLOSED", "That break's window has closed."));
        var cues = new List<string>();
        actions.Cue += cues.Add;
        dialogs
            .Answer(d => { ((ReasonDialogViewModel)d).Text = "Not needed today"; return true; })
            .Answer(_ => true);
        await actions.SkipAsync("MORNING");
        Assert.Single(agent.SkipCalls);
        var alert = Assert.IsType<MessageDialogViewModel>(dialogs.Shown[^1]);
        Assert.Equal("Try skipping again", alert.Title);
        Assert.Equal("That break's window has closed.", alert.Message);
        Assert.Empty(cues);
    }

    [Fact]
    public async Task A_break_End_Day_already_skipped_can_be_taken_but_not_skipped_again()
    {
        var day = Days.General();
        // End Day (stopped by a gate) auto-skipped it at 11:02, inside its window.
        day.Breaks[0].Record = Days.Skip("MORNING", "11:02", auto: true);
        var (actions, agent, dialogs) = Setup("11:05", day);
        dialogs.Answer(_ => true);

        await actions.SkipAsync("MORNING");

        Assert.Empty(agent.SkipCalls);
        var alert = Assert.IsType<MessageDialogViewModel>(Assert.Single(dialogs.Shown));
        Assert.Equal("Morning break is already skipped", alert.Title);
        Assert.Equal("You can still take it until 12:00 PM. If you don't, add a comment when you end the day.", alert.Message);
        Assert.True(agent.BreakPanel.Slots[0].CanStart);
    }

    [Fact]
    public async Task A_Super_Admins_skip_asks_once_with_no_reason_and_no_pay_line()
    {
        var (actions, agent, dialogs) = Setup("10:59:30", role: "SUPER_ADMIN");
        dialogs.Answer(d =>
        {
            var skip = Assert.IsType<ReasonDialogViewModel>(d);
            Assert.Equal("Skip this break?", skip.Title);
            Assert.Equal("Your next one is at 1:00 PM.", skip.Lead);
            Assert.False(skip.AsksReason);
            Assert.False(skip.HasMessage);
            Assert.False(skip.HasChips);
            Assert.True(skip.SubmitCommand.CanExecute(null));
            return true;
        });
        await actions.SkipAsync("MORNING");
        Assert.Equal(("MORNING", (string?)null), Assert.Single(agent.SkipCalls));
    }

    [Fact]
    public async Task Skip_cues_rotate()
    {
        var (actions, _, dialogs) = Setup("10:59:30", role: "SUPER_ADMIN");
        var cues = new List<string>();
        actions.Cue += cues.Add;
        dialogs.Answer(_ => true).Answer(_ => true).Answer(_ => true);
        await actions.SkipAsync("MORNING");
        await actions.SkipAsync("MORNING");
        await actions.SkipAsync("MORNING");
        Assert.Equal(new[]
        {
            "Skipped and noted. Keep it steady.",
            "Skipped and noted. Thanks for staying on it.",
            "Skipped and noted. Keep it steady.",
        }, cues);
        Assert.Equal(3, dialogs.Shown.Count);
    }

    // ---- Comments on skipped breaks ---------------------------------------------------------

    [Fact]
    public async Task Comment_on_an_auto_skip_from_its_row()
    {
        var (actions, agent, dialogs) = Setup("12:10", Days.General().WithRecord(Days.Skip("MORNING", "12:00", auto: true)));
        dialogs.Answer(d =>
        {
            var comment = Assert.IsType<ReasonDialogViewModel>(d);
            Assert.Equal("Add a comment", comment.Title);
            Assert.Equal("Add a comment before you end the day. This skip goes to a manager either way.", comment.Message);
            Assert.Equal("Skipped for you", comment.TagText);
            Assert.Equal("Morning break · closed 12:00 PM", comment.TagDetail);
            Assert.Equal("Send comment", comment.PrimaryText);
            Assert.Equal(4, comment.Chips.Count);
            comment.Text = "The client demo ran until 12:15";
            return true;
        });
        await actions.CommentAsync("morning-auto");
        Assert.Equal(("morning-auto", "The client demo ran until 12:15"), Assert.Single(agent.CommentCalls));
    }

    [Fact]
    public async Task Comment_on_an_earlier_day_comes_from_the_days_list()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        agent.Workday!.SkipsNeedingComment.Add(Days.NeedsComment("EVENING", "17:00", date: "2026-10-12"));
        dialogs.Answer(d =>
        {
            Assert.Equal("Evening break · Skipped for you at 5:00 PM on 12 Oct", ((ReasonDialogViewModel)d).TagDetail);
            ((ReasonDialogViewModel)d).Text = "Stayed on the release call";
            return true;
        });
        await actions.CommentAsync("evening-auto");
        Assert.Equal("evening-auto", Assert.Single(agent.CommentCalls).Id);
    }

    [Fact]
    public async Task Comment_needing_more_or_not_needed()
    {
        var (actions, agent, dialogs) = Setup("12:10", Days.General().WithRecord(Days.Skip("MORNING", "12:00", auto: true)));
        agent.CommentOutcomes.Enqueue(new CommentOutcome.NeedsReason(15, "Add a little more. 15 characters or more."));
        agent.CommentOutcomes.Enqueue(new CommentOutcome.NotNeeded("This break already has a comment."));
        dialogs
            .Answer(d => { ((ReasonDialogViewModel)d).Text = "Client demo"; return true; })
            .Answer(d =>
            {
                var again = (ReasonDialogViewModel)d;
                Assert.Equal("Client demo", again.Text);
                Assert.Equal(15, again.MinChars);
                Assert.Equal("Add a little more. 15 characters or more.", again.Error);
                again.Text = "Client demo ran long";
                return true;
            })
            .Answer(_ => true);
        await actions.CommentAsync("morning-auto");
        Assert.Equal(2, agent.CommentCalls.Count);
        var alert = Assert.IsType<MessageDialogViewModel>(dialogs.Shown[^1]);
        Assert.Equal("No comment needed", alert.Title);
    }

    [Fact]
    public async Task Comment_on_something_that_no_longer_needs_one()
    {
        var (actions, agent, dialogs) = Setup("12:10");
        dialogs.Answer(_ => true);
        await actions.CommentAsync("gone");
        Assert.Equal("Nothing to add", Assert.Single(dialogs.Shown).Title);
        Assert.Empty(agent.CommentCalls);
    }

    // ---- Back to work -----------------------------------------------------------------------

    // ---- 4.0: End break is always confirmed (SPEC 2.3, 8.1) -----------------------------------

    [Fact]
    public async Task End_break_asks_first_with_what_is_left()
    {
        var (actions, agent, dialogs) = Setup("11:03", Days.General().WithActive(Days.Running("LUNCH", "11:00", duration: 15)));
        dialogs.Answer(d =>
        {
            var confirm = Assert.IsType<MessageDialogViewModel>(d);
            Assert.Equal("End your lunch break now?", confirm.Title);
            Assert.Equal("You have 12 min left.", confirm.Message);
            Assert.Equal("End break", confirm.PrimaryText);
            Assert.Equal("Stay on break", confirm.CancelText);
            return false;
        });
        await actions.EndBreakAsync();
        Assert.Equal(0, agent.BackToWorkCalls);

        dialogs.Answer(_ => true);
        await actions.EndBreakAsync();
        Assert.Equal(1, agent.BackToWorkCalls);
    }

    [Fact]
    public async Task End_break_over_time_says_the_buffer_takes_it_and_asks_nothing_more()
    {
        var (actions, agent, dialogs) = Setup("11:19", Days.General().WithActive(Days.Running("MORNING", "11:00")));
        var cues = new List<string>();
        actions.Cue += cues.Add;
        dialogs.Answer(d =>
        {
            Assert.Equal("You're 4 min over. Minutes over come out of your paid buffer first.", ((MessageDialogViewModel)d).Message);
            return true;
        });
        await actions.EndBreakAsync();
        Assert.Single(dialogs.Shown); // no "ask your manager to count them" any more
        Assert.Equal(1, agent.BackToWorkCalls);
        Assert.Empty(cues);
    }

    [Theory]
    [InlineData("USER")]
    [InlineData("MANAGER")]
    [InlineData("SUPER_ADMIN")]
    public async Task Back_to_work_from_the_tray_confirms_a_break_for_everyone(string role)
    {
        var (actions, agent, dialogs) = Setup("11:10", Days.General().WithActive(Days.Running("MORNING", "11:00")), role);
        dialogs.Answer(_ => false);
        await actions.BackToWorkAsync();
        Assert.Equal("End your morning break now?", Assert.Single(dialogs.Shown).Title);
        Assert.Equal(0, agent.BackToWorkCalls);
    }

    [Fact]
    public async Task Back_early_gets_a_quiet_cue()
    {
        var (actions, agent, dialogs) = Setup("11:10", Days.General().WithActive(Days.Running("MORNING", "11:00")));
        var cues = new List<string>();
        actions.Cue += cues.Add;
        dialogs.Answer(_ => true).Answer(_ => true).Answer(_ => true);
        agent.EndOutcomes.Enqueue(new EndOutcome.Ended(Days.Taken("MORNING", "11:00", "11:10")));
        await actions.BackToWorkAsync();
        agent.EndOutcomes.Enqueue(new EndOutcome.Ended(Days.Taken("MORNING", "11:00", "11:14:30")));
        await actions.BackToWorkAsync(); // 30 seconds early: on time, no cue
        agent.EndOutcomes.Enqueue(new EndOutcome.Ended(Days.Taken("MORNING", "11:00", "11:08")));
        await actions.BackToWorkAsync();
        Assert.Equal(new[] { "Back early. Nice rhythm.", "Back early. Good pace." }, cues);
    }

    [Fact]
    public async Task End_break_refused_says_why()
    {
        var (actions, agent, dialogs) = Setup("11:10", Days.General().WithActive(Days.Running("MORNING", "11:00")));
        agent.EndOutcomes.Enqueue(new EndOutcome.Refused("No break is running."));
        dialogs.Answer(_ => true).Answer(_ => true);
        await actions.EndBreakAsync();
        var alert = Assert.IsType<MessageDialogViewModel>(dialogs.Shown[^1]);
        Assert.Equal("Couldn't end your break", alert.Title);
        Assert.Equal("No break is running.", alert.Message);
    }

    // ---- 4.0: pause and resume ------------------------------------------------------------------

    private static BreakDay PausedMorning(string pausedAt = "11:05")
    {
        var paused = Days.Running("MORNING", "11:00");
        paused.InProgress = false;
        paused.State = BreakStates.Paused;
        paused.Segments.Add(new BreakSegment { StartedAt = Ist.At("11:00").ToUniversalTime(), EndedAt = Ist.At(pausedAt).ToUniversalTime() });
        return Days.General().WithRecord(paused);
    }

    [Fact]
    public async Task Pause_only_a_scheduled_break()
    {
        var (actions, agent, dialogs) = Setup("11:05", Days.General().WithActive(Days.Running("MORNING", "11:00")));
        await actions.PauseAsync();
        Assert.Equal(1, agent.PauseCalls);
        Assert.Empty(dialogs.Shown);

        // A quick break has no Pause (SPEC 2.3): it says so instead.
        var quick = Days.General();
        quick.ActiveBreak = new BreakRecord
        {
            Id = "q-1", Kind = BreakKinds.Quick, Label = "Quick break", PresenceType = "BREAK", PlannedMin = 10,
            StartedAt = Ist.At("11:00").ToUniversalTime(), InProgress = true, Timing = "UNSCHEDULED",
        };
        quick.Quick.Add(new QuickBreakView { Id = "q-1", StartedAt = Ist.At("11:00").ToUniversalTime(), PlannedMin = 10 });
        agent.Day = quick;
        dialogs.Answer(_ => true);
        await actions.PauseAsync();
        Assert.Equal(1, agent.PauseCalls);
        Assert.Equal("This break can't pause", Assert.Single(dialogs.Shown).Title);
    }

    [Fact]
    public async Task Pause_refused_says_why()
    {
        var (actions, agent, dialogs) = Setup("11:05", Days.General().WithActive(Days.Running("MORNING", "11:00")));
        agent.ActionOutcomes.Enqueue(new ActionOutcome.Refused("NOT_PAUSABLE", "Quick breaks can't be paused."));
        dialogs.Answer(_ => true);
        await actions.PauseAsync();
        var alert = Assert.IsType<MessageDialogViewModel>(Assert.Single(dialogs.Shown));
        Assert.Equal("Couldn't pause your break", alert.Title);
        Assert.Equal("Quick breaks can't be paused.", alert.Message);
    }

    [Fact]
    public async Task The_next_break_tile_resumes_a_paused_break()
    {
        var (actions, agent, dialogs) = Setup("11:20", PausedMorning());
        var panel = agent.BreakPanel;
        Assert.Equal(SlotState.Paused, panel.Next!.State);
        Assert.True(panel.Next.CanResume);
        await actions.NextBreakAsync();
        Assert.Equal(1, agent.ResumeCalls);
        Assert.Empty(agent.TakeCalls);
        Assert.Empty(dialogs.Shown);
    }

    [Fact]
    public async Task Resume_after_the_window_closed_says_why()
    {
        var (actions, agent, dialogs) = Setup("11:20", PausedMorning());
        agent.ActionOutcomes.Enqueue(new ActionOutcome.Refused("RESUME_WINDOW_CLOSED", "Its window closed at 12:00 PM, so it ended at the pause."));
        dialogs.Answer(_ => true);
        await actions.ResumeAsync();
        var alert = Assert.IsType<MessageDialogViewModel>(Assert.Single(dialogs.Shown));
        Assert.Equal("Couldn't resume your break", alert.Title);
    }

    [Fact]
    public async Task Ending_a_paused_break_asks_first()
    {
        var (actions, agent, dialogs) = Setup("11:20", PausedMorning());
        dialogs.Answer(d =>
        {
            var confirm = (MessageDialogViewModel)d;
            Assert.Equal("End your morning break now?", confirm.Title);
            Assert.Equal("It is paused with 10 min left. Ending it now means you can't resume it.", confirm.Message);
            Assert.Equal("Keep it paused", confirm.CancelText);
            return true;
        });
        await actions.EndBreakAsync();
        Assert.Equal(1, agent.BackToWorkCalls);
    }

    [Fact]
    public void A_paused_break_closes_with_its_window()
    {
        var panel = BreakSchedule.Compute(PausedMorning(), Ist.At("12:01"));
        Assert.Equal(SlotState.Taken, panel.Slots[0].State);
        Assert.Null(panel.Paused);
        Assert.False(panel.Slots[0].CanResume);
    }

    // ---- 4.0: quick breaks ----------------------------------------------------------------------

    [Fact]
    public async Task Quick_break_choose_then_start()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        dialogs.Answer(d =>
        {
            var quick = Assert.IsType<QuickBreakDialogViewModel>(d);
            Assert.Equal(new[] { 5, 10, 15 }, quick.Choices.Select(c => c.Minutes));
            quick.Choices.Single(c => c.Minutes == 15).PickCommand.Execute(null);
            Assert.Equal("Start 15 min break", quick.PrimaryText);
            return true;
        });
        await actions.QuickBreakAsync();
        Assert.Equal(15, Assert.Single(agent.QuickCalls));

        // Cancel starts nothing.
        dialogs.Answer(_ => false);
        await actions.QuickBreakAsync();
        Assert.Single(agent.QuickCalls);
    }

    [Fact]
    public void Quick_break_uses_the_lengths_the_server_sends()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        agent.Workday!.Config = new WorkdayConfig { QuickBreakMinutes = new List<int> { 5, 20 }, BreakBufferMin = 15 };
        var dialog = actions.QuickDialog();
        Assert.Equal(new[] { 5, 20 }, dialog.Choices.Select(c => c.Minutes));
    }

    [Fact]
    public async Task No_quick_break_on_a_break_or_in_a_meeting()
    {
        var (actions, agent, dialogs) = Setup("11:05", Days.General().WithActive(Days.Running("MORNING", "11:00")));
        dialogs.Answer(_ => true).Answer(_ => true);
        await actions.QuickBreakAsync();
        agent.Day = Days.General();
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting };
        await actions.QuickBreakAsync();
        Assert.Equal(new[] { "You're on a break", "You're in a meeting" }, dialogs.Shown.Select(d => d.Title));
        Assert.Empty(agent.QuickCalls);
    }

    [Fact]
    public async Task Quick_break_refused_says_why()
    {
        var (actions, agent, dialogs) = Setup("10:20");
        agent.ActionOutcomes.Enqueue(new ActionOutcome.Refused("DAY_ENDED", "Your working day has ended."));
        dialogs.Answer(d => true).Answer(_ => true);
        await actions.QuickBreakAsync();
        Assert.Equal("Couldn't start your quick break", dialogs.Shown[^1].Title);
    }

    [Fact]
    public async Task Next_break_with_nothing_left_says_so()
    {
        var (actions, agent, dialogs) = Setup("17:30");
        dialogs.Answer(_ => true);
        await actions.NextBreakAsync();
        Assert.Equal("No more breaks today", Assert.Single(dialogs.Shown).Title);
        Assert.Empty(agent.TakeCalls);
    }

    [Fact]
    public async Task Next_break_on_a_free_day_offers_lunch_or_a_break()
    {
        var (actions, agent, dialogs) = Setup("10:20", Days.Free());
        dialogs.Alternative(d => Assert.Equal("Start break", ((MessageDialogViewModel)d).AltText));
        await actions.NextBreakAsync();
        Assert.Equal(new[] { PresenceStatus.Break }, agent.FreeCalls);
    }

    // ---- 4.0: sign out and quit with an admin's key (SPEC 2.8, 8.5) -------------------------------

    [Fact]
    public async Task Sign_out_syncs_first_then_asks_for_the_key()
    {
        var (actions, agent, dialogs) = Setup("18:40");
        agent.PendingActions = 3;
        dialogs
            .Answer(d =>
            {
                Assert.Equal("Sign out of RX Vision?", d.Title);
                Assert.Contains("needs a key from your admin and an internet connection", ((MessageDialogViewModel)d).Message);
                return true;
            })
            .Answer(d =>
            {
                var progress = Assert.IsType<ProgressDialogViewModel>(d);
                Assert.Equal("Syncing 3 actions…", progress.Heading);
                // Stays up until the sync finishes (the fake finishes at once).
                return true;
            })
            .Answer(d =>
            {
                var key = Assert.IsType<KeyDialogViewModel>(d);
                Assert.Equal("Enter the sign-out key", key.Title);
                key.Key = "  Amber orbit  cedar river lamp 42 ";
                return true;
            });
        await actions.SignOutAsync();
        Assert.Single(agent.SyncCalls);
        Assert.Equal("amber orbit cedar river lamp 42", Assert.Single(agent.SignOutKeys));
    }

    [Fact]
    public async Task A_wrong_key_asks_again_and_too_many_tries_stops()
    {
        var (actions, agent, dialogs) = Setup("18:40");
        agent.KeyOutcomes.Enqueue(new KeyOutcome.WrongKey("That key isn't valid for you. Check it with your admin."));
        agent.KeyOutcomes.Enqueue(new KeyOutcome.TooManyTries("Too many wrong keys. Wait 10 minutes and try again."));
        dialogs
            .Answer(_ => true)
            .Answer(d => { ((KeyDialogViewModel)d).Key = "wrong words here now 11"; return true; })
            .Answer(d =>
            {
                var again = (KeyDialogViewModel)d;
                Assert.Equal("That key isn't valid for you. Check it with your admin.", again.Error);
                Assert.Equal("wrong words here now 11", again.Key);
                again.Key = "other words here now 12";
                return true;
            })
            .Answer(_ => true);
        await actions.SignOutAsync();
        Assert.Equal(2, agent.SignOutKeys.Count);
        var alert = Assert.IsType<MessageDialogViewModel>(dialogs.Shown[^1]);
        Assert.Equal("Too many tries", alert.Title);
        Assert.Equal(AgentState.Running, agent.State);
    }

    [Fact]
    public async Task Sign_out_offline_says_it_needs_the_internet_and_keeps_everything()
    {
        var (actions, agent, dialogs) = Setup("18:40");
        agent.PendingActions = 2;
        agent.Online = false;
        agent.SyncLeaves = 2;
        dialogs.Answer(_ => true).Answer(_ => true).Answer(_ => true);
        await actions.SignOutAsync();
        var alert = Assert.IsType<MessageDialogViewModel>(dialogs.Shown[^1]);
        Assert.Equal("Try signing out in a moment", alert.Title);
        Assert.Equal("Connect to the internet to sign out. 2 actions must reach RX Vision first.", alert.Message);
        Assert.Empty(agent.SignOutKeys);
        Assert.Equal(AgentState.Running, agent.State);
    }

    [Theory]
    [InlineData("USER", false)]
    [InlineData("MANAGER", false)]
    [InlineData("ADMIN", true)]
    [InlineData("SUPER_ADMIN", true)]
    public void Only_admins_can_quit(string role, bool canQuit)
    {
        var (actions, _, _) = Setup("18:40", role: role);
        Assert.Equal(canQuit, actions.CanQuit);
    }

    [Fact]
    public async Task An_admins_quit_takes_a_key()
    {
        var (actions, agent, dialogs) = Setup("18:40", role: "ADMIN");
        var exited = 0;
        dialogs.Answer(d =>
        {
            var key = Assert.IsType<KeyDialogViewModel>(d);
            Assert.Equal("Quit RX Vision?", key.Title);
            key.Key = "amber orbit cedar river lamp 42";
            return true;
        });
        await actions.QuitAsync(() => { exited++; return Task.CompletedTask; });
        Assert.Equal(1, exited);
        Assert.Equal("amber orbit cedar river lamp 42", Assert.Single(agent.QuitKeys));

        // Staff can't quit at all: nothing is asked.
        var (staff, staffAgent, staffDialogs) = Setup("18:40");
        await staff.QuitAsync(() => { exited++; return Task.CompletedTask; });
        Assert.Empty(staffDialogs.Shown);
        Assert.Equal(1, exited);
    }

    [Fact]
    public async Task One_flow_at_a_time()
    {
        var agent = new FakeAgent("11:12");
        var gate = new TaskCompletionSource<bool>();
        var dialogs = new BlockingDialogs(gate.Task);
        var actions = new BreakActions(agent, dialogs, NullLog.Instance);
        var first = actions.TakeAsync(PresenceStatus.Break);
        await actions.TakeAsync(PresenceStatus.Break); // ignored while the first waits on its dialog
        await actions.EndDayAsync();                   // so is every other flow
        Assert.Equal(1, dialogs.Count);
        gate.SetResult(false);
        await first;
    }

    private sealed class BlockingDialogs : IDialogService
    {
        private readonly Task<bool> _answer;
        public BlockingDialogs(Task<bool> answer) => _answer = answer;
        public int Count { get; private set; }
        public Task<bool> ShowAsync(DialogViewModel dialog)
        {
            Count++;
            return _answer;
        }
    }
}

public class ChatViewModelTests
{
    [Fact]
    public async Task Loads_the_conversation_with_the_manager_newest_last()
    {
        var agent = new FakeAgent();
        agent.FakeChat.Conversation.Add(new ChatMessage { Id = "2", FromUserId = "u-1", ToUserId = "m-1", Body = "On it", Mine = true, CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-1) });
        agent.FakeChat.Conversation.Add(new ChatMessage { Id = "1", FromUserId = "m-1", ToUserId = "u-1", Body = "Can you join the 4 pm call?", CreatedAt = DateTimeOffset.UtcNow.AddMinutes(-5) });
        var chat = new ChatViewModel(agent, NullLog.Instance);
        await chat.ActivateAsync();
        Assert.Equal("Maya Reddy", chat.HeaderText);
        Assert.False(chat.HasManyContacts);
        Assert.Equal(new[] { "1", "2" }, chat.Messages.Select(m => m.Id));
        Assert.True(chat.Messages[0].IsTheirs);
        Assert.True(chat.Messages[1].IsMine);
        Assert.Null(chat.Messages[0].AvatarId);
    }

    [Fact]
    public async Task A_failed_send_keeps_the_text_and_says_why()
    {
        var agent = new FakeAgent();
        var chat = new ChatViewModel(agent, NullLog.Instance);
        await chat.ActivateAsync();
        agent.FakeChat.SendResults.Enqueue(ApiResult<ChatMessage>.TransientFailure("Check your connection and try again."));
        chat.Draft = "Running 5 min late";
        Assert.True(chat.SendCommand.CanExecute(null));
        await chat.SendCommand.ExecuteAsync(null);
        Assert.Equal("Running 5 min late", chat.Draft);
        Assert.Equal("Check your connection and try sending again.", chat.SendError);
        Assert.Empty(chat.Messages);

        agent.FakeChat.SendResults.Enqueue(new ApiResult<ChatMessage> { Outcome = ApiOutcome.Rejected, Message = "Messages can be up to 2000 characters." });
        await chat.SendCommand.ExecuteAsync(null);
        Assert.Equal("Messages can be up to 2000 characters.", chat.SendError);
        Assert.Equal("Running 5 min late", chat.Draft);

        // Typing again clears the error; a successful send clears the box.
        chat.Draft = "Running 5 min late, sorry";
        Assert.Null(chat.SendError);
        await chat.SendCommand.ExecuteAsync(null);
        Assert.Equal("", chat.Draft);
        Assert.True(Assert.Single(chat.Messages).IsMine);
    }

    [Fact]
    public async Task Empty_or_too_long_cannot_be_sent()
    {
        var agent = new FakeAgent();
        var chat = new ChatViewModel(agent, NullLog.Instance);
        await chat.ActivateAsync();
        chat.Draft = "   ";
        Assert.False(chat.SendCommand.CanExecute(null));
        chat.Draft = new string('x', 2001);
        Assert.False(chat.SendCommand.CanExecute(null));
        Assert.Equal("2001 / 2000", chat.CounterText);
        chat.Draft = new string('x', 2000);
        Assert.True(chat.SendCommand.CanExecute(null));
    }

    [Fact]
    public async Task Live_messages_join_the_open_conversation_once()
    {
        var agent = new FakeAgent();
        var chat = new ChatViewModel(agent, NullLog.Instance);
        await chat.ActivateAsync();
        var m = new ChatMessage { Id = "9", FromUserId = "m-1", ToUserId = "u-1", Body = "Hi", CreatedAt = DateTimeOffset.UtcNow };
        Assert.True(chat.OnMessageReceived(m));
        Assert.False(chat.OnMessageReceived(m));
        Assert.False(chat.OnMessageReceived(new ChatMessage { Id = "10", FromUserId = "other", ToUserId = "u-1", Body = "x" }));
        Assert.Single(chat.Messages);
    }

    [Fact]
    public async Task Managers_pick_who_to_talk_to()
    {
        var agent = new FakeAgent();
        agent.FakeChat.ContactList.Add(new ChatContact { UserId = "s-2", Name = "Ravi Shah", Relation = "REPORT" });
        var chat = new ChatViewModel(agent, NullLog.Instance);
        await chat.ActivateAsync();
        Assert.True(chat.HasManyContacts);
        Assert.Equal("Maya Reddy (your manager)", chat.SelectedContact!.Display);
        chat.Select("s-2");
        Assert.Equal("Ravi Shah", chat.SelectedContact!.Name);
        Assert.Equal("Ravi Shah (your team)", chat.SelectedContact.Display);
    }

    [Fact]
    public async Task No_one_to_talk_to()
    {
        var agent = new FakeAgent();
        agent.FakeChat.ContactList.Clear();
        var chat = new ChatViewModel(agent, NullLog.Instance);
        await chat.ActivateAsync();
        Assert.Null(chat.SelectedContact);
        Assert.StartsWith("No one to chat with yet", chat.EmptyText);
        Assert.False(chat.SendCommand.CanExecute(null));
    }
}

public class MenuStateTests
{
    [Theory]
    [InlineData(AgentState.Starting, false, false, false, false, false)]
    [InlineData(AgentState.SignIn, false, false, false, false, false)]
    [InlineData(AgentState.Connecting, false, false, false, false, true)]
    [InlineData(AgentState.NeedsNotice, false, false, false, false, true)]
    [InlineData(AgentState.NotStarted, false, false, false, true, true)]
    [InlineData(AgentState.Running, true, false, true, false, true)]
    [InlineData(AgentState.DayEnded, false, false, false, true, true)]
    public void Enablement_follows_the_state(AgentState state, bool takeBreak, bool back, bool endDay, bool startDay, bool signOut)
    {
        var s = MenuState.For(state, PresenceStatus.Working, onBreak: false);
        Assert.Equal(takeBreak, s.CanQuickBreak);
        Assert.Equal(takeBreak, s.CanNextBreak);
        Assert.Equal(back, s.CanBackToWork);
        Assert.Equal(endDay, s.CanEndDay);
        Assert.Equal(startDay, s.CanStartDay);
        Assert.Equal(signOut, s.CanSignOut);
        Assert.False(s.ShowQuit);
    }

    [Fact]
    public void On_a_break_only_back_to_work()
    {
        var s = MenuState.For(AgentState.Running, PresenceStatus.Break, onBreak: true);
        Assert.False(s.CanQuickBreak);
        Assert.False(s.CanNextBreak);
        Assert.True(s.CanBackToWork);
        Assert.Equal("On break", s.Status);
        Assert.Equal("On break", MenuState.For(AgentState.Running, PresenceStatus.Lunch, true).Status);
    }

    [Fact]
    public void In_a_meeting_only_back_to_work()
    {
        var s = MenuState.For(AgentState.Running, PresenceStatus.Meeting, onBreak: false);
        Assert.False(s.CanQuickBreak);
        Assert.True(s.CanBackToWork);
        Assert.Equal("In a meeting", s.Status);
    }

    [Fact]
    public void The_menu_view_model_applies_it_and_hides_quit_from_staff()
    {
        var calls = new List<string>();
        var menu = new AgentMenuViewModel(() => calls.Add("open"), () => calls.Add("quick"), () => calls.Add("next"),
            () => calls.Add("back"), () => calls.Add("end"), () => calls.Add("start"), () => calls.Add("out"), () => calls.Add("quit"));
        Assert.False(menu.QuickBreak.Command.CanExecute(null));
        Assert.True(menu.Open.Command.CanExecute(null));
        // SPEC 2.8: no Quit for staff and managers.
        Assert.False(menu.Quit.IsVisible);
        Assert.False(menu.Quit.Command.CanExecute(null));
        menu.Update(MenuState.For(AgentState.Running, PresenceStatus.Working, false));
        Assert.True(menu.QuickBreak.Command.CanExecute(null));
        Assert.Equal("RX Vision: Working", menu.ToolTip);
        menu.QuickBreak.Command.Execute(null);
        menu.Quit.Command.Execute(null); // hidden: ignored
        menu.Update(MenuState.For(AgentState.DayEnded, PresenceStatus.DayEnded, false));
        menu.QuickBreak.Command.Execute(null); // disabled: ignored
        Assert.Equal(new[] { "quick" }, calls);
        Assert.Equal("RX Vision: Day ended", menu.ToolTip);
        Assert.Equal(4, menu.Items.Count(i => i.IsSeparator) + 1);
        Assert.Equal(new[] { "Open RX Vision", "Quick break…", "Next break", "Resume work", "End day", "Start day", "Sign out…", "Quit RX Vision…" },
            menu.Items.Where(i => !i.IsSeparator).Select(i => i.Header));

        menu.Update(MenuState.For(AgentState.NotStarted, PresenceStatus.NotStarted, false));
        Assert.Equal("RX Vision: Not started", menu.ToolTip);
        menu.StartDay.Command.Execute(null);
        menu.EndDay.Command.Execute(null); // disabled before Start Day
        Assert.Equal(new[] { "quick", "start" }, calls);

        // An admin's menu has Quit (it asks for a key).
        menu.Update(MenuState.For(AgentState.Running, PresenceStatus.Working, false, canQuit: true));
        Assert.True(menu.Quit.IsVisible);
        menu.Quit.Command.Execute(null);
        Assert.Equal("quit", calls[^1]);
    }
}

public class ToastServiceTests
{
    private sealed class Presenter : IToastPresenter
    {
        public List<string> Log { get; } = new();
        public void Show(ToastViewModel toast) => Log.Add("show " + toast.Key);
        public void Hide() => Log.Add("hide");
    }

    private static ToastViewModel Chat(string from, string body) => new(ToastKind.Message, "chat:" + from) { Heading = "New message", Body = body };

    [Fact]
    public void One_at_a_time_and_auto_hide()
    {
        var now = DateTimeOffset.UtcNow;
        var presenter = new Presenter();
        var toasts = new ToastService(presenter, () => now);
        toasts.Show(Chat("a", "1"));
        toasts.Show(new ToastViewModel(ToastKind.Info, "note:1"));
        Assert.Equal("chat:a", toasts.Current!.Key);
        Assert.Single(toasts.Queued);
        now += TimeSpan.FromSeconds(10);
        toasts.Tick();
        Assert.Equal("note:1", toasts.Current!.Key);
        Assert.Equal(new[] { "show chat:a", "hide", "show note:1" }, presenter.Log);
    }

    [Fact]
    public void A_burst_from_one_sender_is_one_card()
    {
        var presenter = new Presenter();
        var toasts = new ToastService(presenter);
        toasts.Show(Chat("a", "first"));
        toasts.Show(Chat("a", "second"));
        toasts.Show(Chat("a", "third"));
        Assert.Equal(3, toasts.Current!.Count);
        Assert.Equal("3 new messages", toasts.Current.Heading);
        Assert.Equal("third", toasts.Current.Body);
        Assert.Empty(toasts.Queued);
    }

    [Fact]
    public void Waits_while_a_full_screen_app_is_in_front()
    {
        var presenter = new Presenter();
        var toasts = new ToastService(presenter);
        toasts.Show(Chat("a", "hi"));
        toasts.SetSuppressed(true);
        Assert.Null(toasts.Current);
        toasts.Show(Chat("b", "hello"));
        Assert.Null(toasts.Current);
        toasts.SetSuppressed(false);
        Assert.Equal("chat:a", toasts.Current!.Key);
        Assert.Equal(new[] { "show chat:a", "hide", "show chat:a" }, presenter.Log);
    }

    [Fact]
    public void Hovering_keeps_it_up()
    {
        var now = DateTimeOffset.UtcNow;
        var toasts = new ToastService(new Presenter(), () => now);
        toasts.Show(Chat("a", "hi"));
        toasts.SetHovered(true);
        now += TimeSpan.FromSeconds(30);
        toasts.Tick();
        Assert.NotNull(toasts.Current);
        toasts.SetHovered(false);
        now += TimeSpan.FromSeconds(4);
        toasts.Tick();
        Assert.Null(toasts.Current);
    }

    [Fact]
    public void Dismiss_and_primary_actions()
    {
        var toasts = new ToastService(new Presenter());
        var took = 0;
        var opened = 0;
        var note = new ToastViewModel(ToastKind.Info, "day:refused") { OnPrimary = () => took++, OnOpen = () => opened++ };
        toasts.Show(note);
        note.PrimaryCommand.Execute(null);
        Assert.Equal(1, took);
        Assert.Equal(0, opened);
        Assert.Null(toasts.Current);

        var chat = Chat("a", "x");
        chat.OnOpen = () => opened++;
        toasts.Show(chat);
        chat.OpenCommand.Execute(null);
        Assert.Equal(1, opened);
        Assert.Null(toasts.Current);
    }
}

public class BubbleAndSignInTests
{
    [Fact]
    public async Task Sign_in_shows_the_agents_error_and_keeps_the_email()
    {
        var agent = new FakeAgent { SignInError = "Wrong email or password." };
        var vm = new SignInViewModel(agent, null, NullLog.Instance) { Email = " asha@timechamp.test ", Password = "nope" };
        await vm.SignInCommand.ExecuteAsync(null);
        Assert.Equal("Wrong email or password.", vm.Error);
        Assert.Equal(("asha@timechamp.test", "nope", (string?)null), Assert.Single(agent.SignInCalls));

        agent.SignInError = null;
        vm.ShowAdvanced = true;
        vm.Server = "http://localhost:4000/api/v1";
        vm.Password = "user123";
        await vm.SignInCommand.ExecuteAsync(null);
        Assert.Null(vm.Error);
        Assert.Equal("", vm.Password);
        Assert.Equal("http://localhost:4000/api/v1", agent.SignInCalls[1].Server);
    }

    [Fact]
    public async Task Sign_in_error_clears_when_they_edit_what_they_typed()
    {
        var agent = new FakeAgent { SignInError = "Wrong email or password." };
        var vm = new SignInViewModel(agent, null, NullLog.Instance) { Email = "asha@timechamp.test", Password = "nope" };
        await vm.SignInCommand.ExecuteAsync(null);
        Assert.True(vm.HasError);
        vm.Password = "nope1";
        Assert.False(vm.HasError);

        await vm.SignInCommand.ExecuteAsync(null);
        Assert.True(vm.HasError);
        vm.Email = "asha@timechamp.tes";
        Assert.False(vm.HasError);
    }

    [Fact]
    public void Sign_in_states()
    {
        var agent = new FakeAgent();
        var vm = new SignInViewModel(agent, null, NullLog.Instance);
        Assert.False(vm.SignInCommand.CanExecute(null));
        vm.Prepare(AgentState.Connecting);
        Assert.True(vm.ShowConnecting);
        Assert.False(vm.ShowForm);
        vm.ShowSignInFormCommand.Execute(null);
        Assert.True(vm.ShowForm);
        vm.SetSessionLost("Sign in again to carry on.");
        Assert.Equal("Sign in again to carry on.", vm.SessionLostReason);
        vm.ToggleModeCommand.Execute(null);
        Assert.True(vm.UseCode);
        Assert.Equal("Paste the setup code from the RX Vision portal.", vm.Subtitle);
        Assert.Equal("https://api.rxvision.shop/api/v1", vm.Server);
    }
}
