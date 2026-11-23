using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Avalonia.VisualTree;
using RXVision.Agent.Controls;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Avatars;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>Profile, then the account, on a scripted agent: what is offered, what Save and the RX logo do, what a refusal says.</summary>
public class AvatarPickerTests
{
    private static async Task<(FakeAgent Agent, AvatarPickerViewModel Vm)> Open(string? library = "male", string? avatarId = "M01", string? chosen = null,
        string role = "USER", Action<FakeAgent>? before = null)
    {
        var agent = new FakeAgent();
        agent.User!.Role = role;
        if (library is null) agent.FakeAvatars.Mine = new MyAvatar();
        else agent.FakeAvatars.Have(library, avatarId!, chosen);
        agent.FakeAvatars.PersonName = "Asha Kumar";
        before?.Invoke(agent);
        var vm = new AvatarPickerViewModel(agent, NullLog.Instance);
        await vm.OpenAsync();
        return (agent, vm);
    }

    private static ApiResult<MyAvatar> Refused(int status, string code, string message) =>
        new() { Outcome = ApiOutcome.Rejected, Status = status, Code = code, Message = message };

    // ---- What is offered --------------------------------------------------------------------------

    [Fact]
    public async Task Offers_only_the_persons_own_library_in_three_sets_of_25()
    {
        foreach (var (library, prefix, words) in new[] { ("male", "M", "75 male avatars"), ("female", "F", "75 female avatars") })
        {
            var (_, vm) = await Open(library, prefix + "01");
            Assert.True(vm.HasLibrary);
            Assert.Equal(words, vm.CountText);
            Assert.Equal(new[] { "Formal", "Casual", "Smart" }, vm.Sets.Select(s => s.Label));
            var seen = new List<string>();
            foreach (var set in vm.Sets.ToList())
            {
                set.ChooseCommand.Execute(null);
                Assert.True(set.IsSelected);
                Assert.Equal(25, vm.Tiles.Count);
                seen.AddRange(vm.Tiles.Select(t => t.Id));
            }
            Assert.Equal(75, seen.Distinct().Count());
            Assert.All(seen, id => Assert.StartsWith(prefix, id));
        }
    }

    [Fact]
    public async Task The_RX_logo_is_the_default_and_a_chosen_avatar_opens_on_its_own_set()
    {
        var (_, fresh) = await Open();
        Assert.True(fresh.IsMarkSelected);
        Assert.Null(fresh.PreviewId);
        Assert.True(fresh.Sets[0].IsSelected);
        Assert.DoesNotContain(fresh.Tiles, t => t.IsSelected);

        var (_, vm) = await Open("male", "M40", "M40");
        // M40 is in Casual, the second set: the picker opens there.
        Assert.False(vm.IsMarkSelected);
        Assert.True(vm.Sets[1].IsSelected);
        Assert.Equal("M40", Assert.Single(vm.Tiles, t => t.IsSelected).Id);
        vm.Sets[0].ChooseCommand.Execute(null);
        Assert.DoesNotContain(vm.Tiles, t => t.IsSelected);
    }

    [Theory]
    [InlineData("USER")]
    [InlineData("MANAGER")]
    [InlineData("SUPER_MANAGER")]
    [InlineData("SUPER_ADMIN")]
    public async Task Everyone_has_it_whatever_their_role(string role)
    {
        var (agent, vm) = await Open(role: role);
        Assert.Equal(25, vm.Tiles.Count);
        vm.Tiles[3].PickCommand.Execute(null);
        await vm.SaveCommand.ExecuteAsync(null);
        Assert.Equal("M04", Assert.Single(agent.FakeAvatars.Saves));
    }

    [Fact]
    public async Task With_no_gender_set_a_calm_line_stands_where_the_grid_would_be()
    {
        var (agent, vm) = await Open(library: null);
        Assert.False(vm.HasLibrary);
        Assert.True(vm.HasNoLibrary);
        Assert.Equal("Ask the organisation admin to set up your profile. Then you can choose your avatar.", vm.NoLibraryText);
        Assert.Empty(vm.Sets);
        Assert.Empty(vm.Tiles);
        Assert.False(vm.SaveCommand.CanExecute(null));
        Assert.Null(vm.PreviewId);
        Assert.True(vm.IsMarkSelected);
        Assert.Empty(agent.FakeAvatars.Saves);
    }

    // ---- Tapping and saving ------------------------------------------------------------------------

    [Fact]
    public async Task Tapping_previews_only_and_save_sends_the_id()
    {
        var (agent, vm) = await Open();
        Assert.False(vm.SaveCommand.CanExecute(null));

        vm.Tiles[11].PickCommand.Execute(null);
        Assert.Equal("M12", vm.PreviewId);
        Assert.Equal("M12", Assert.Single(vm.Tiles, t => t.IsSelected).Id);
        Assert.Empty(agent.FakeAvatars.Saves);
        Assert.Null(agent.FakeAvatars.ShownId);
        Assert.True(vm.SaveCommand.CanExecute(null));

        await vm.SaveCommand.ExecuteAsync(null);
        Assert.Equal("M12", Assert.Single(agent.FakeAvatars.Saves));
        Assert.Equal("M12", agent.FakeAvatars.ShownId);
        Assert.Equal("M12", vm.PreviewId);
        Assert.False(vm.SaveCommand.CanExecute(null));
        Assert.Null(vm.Error);
    }

    [Fact]
    public async Task Tapping_back_to_what_shows_leaves_nothing_to_save()
    {
        var (_, vm) = await Open();
        vm.Tiles[5].PickCommand.Execute(null);
        vm.PickMarkCommand.Execute(null);
        Assert.False(vm.SaveCommand.CanExecute(null));
    }

    [Fact]
    public async Task A_save_with_no_answer_puts_the_old_one_back_and_says_try_again_and_the_pick_stays()
    {
        var (agent, vm) = await Open();
        agent.FakeAvatars.Answers.Enqueue(ApiResult<MyAvatar>.TransientFailure("Check your connection and try again."));
        vm.Tiles[11].PickCommand.Execute(null);
        await vm.SaveCommand.ExecuteAsync(null);

        Assert.Equal("Try saving your avatar again.", vm.Error);
        Assert.True(vm.HasError);
        Assert.Null(agent.FakeAvatars.ShownId);
        Assert.Equal("M12", vm.PreviewId);
        Assert.True(vm.SaveCommand.CanExecute(null));

        vm.Tiles[12].PickCommand.Execute(null);
        Assert.Null(vm.Error);
    }

    [Theory]
    [InlineData(400, "AVATAR_UNKNOWN", "Pick one of the avatars.")]
    [InlineData(403, "AVATAR_CHANGE_ON_WEB", "You can change your avatar from the agent or the phone app.")]
    [InlineData(404, "NOT_FOUND", "We can't find your profile. Sign in again.")]
    public async Task A_refusal_is_shown_in_the_servers_words(int status, string code, string words)
    {
        var (agent, vm) = await Open();
        agent.FakeAvatars.Answers.Enqueue(Refused(status, code, words));
        vm.Tiles[11].PickCommand.Execute(null);
        await vm.SaveCommand.ExecuteAsync(null);
        Assert.Equal(words, vm.Error);
        Assert.Null(agent.FakeAvatars.ShownId);
    }

    [Theory]
    [InlineData(403, "AVATAR_OTHER_LIBRARY", "You can pick from your own avatars.")]
    [InlineData(409, "GENDER_NOT_SET", "Ask a Super Admin to set up your profile. Then you can choose your avatar.")]
    public async Task A_refusal_that_says_the_profile_moved_reads_it_again(int status, string code, string words)
    {
        var (agent, vm) = await Open();
        var reads = agent.FakeAvatars.Refreshes;
        agent.FakeAvatars.Answers.Enqueue(Refused(status, code, words));
        vm.Tiles[11].PickCommand.Execute(null);
        await vm.SaveCommand.ExecuteAsync(null);
        Assert.Equal(words, vm.Error);
        Assert.Equal(reads + 1, agent.FakeAvatars.Refreshes);
        Assert.Null(vm.PreviewId);
    }

    [Fact]
    public async Task While_a_save_is_on_its_way_nothing_else_can_be_pressed()
    {
        var (agent, vm) = await Open();
        var hold = new TaskCompletionSource();
        agent.FakeAvatars.Hold = hold;
        vm.Tiles[11].PickCommand.Execute(null);
        var saving = vm.SaveCommand.ExecuteAsync(null);

        Assert.True(vm.IsBusy);
        Assert.False(vm.SaveCommand.CanExecute(null));
        vm.Tiles[20].PickCommand.Execute(null);
        vm.PickMarkCommand.Execute(null);
        Assert.Equal("M12", vm.PreviewId);

        hold.SetResult();
        await saving;
        Assert.False(vm.IsBusy);
        Assert.Equal("M12", agent.FakeAvatars.ShownId);
    }

    // ---- The RX logo, the default (D-85) -----------------------------------------------------------

    [Fact]
    public async Task Choosing_the_RX_logo_and_saving_clears_the_choice()
    {
        var (agent, vm) = await Open("female", "F40", "F40");
        Assert.False(vm.IsMarkSelected);
        vm.PickMarkCommand.Execute(null);
        Assert.Null(vm.PreviewId);
        Assert.True(vm.IsMarkSelected);
        Assert.DoesNotContain(vm.Tiles, t => t.IsSelected);
        Assert.Empty(agent.FakeAvatars.Saves);
        Assert.Equal(0, agent.FakeAvatars.Resets);
        Assert.True(vm.SaveCommand.CanExecute(null));

        await vm.SaveCommand.ExecuteAsync(null);
        Assert.Equal(1, agent.FakeAvatars.Resets);
        Assert.Null(agent.FakeAvatars.ShownId);
        Assert.Null(vm.PreviewId);
        Assert.True(vm.IsMarkSelected);
        Assert.False(vm.SaveCommand.CanExecute(null));
    }

    [Fact]
    public async Task With_the_RX_logo_on_show_tapping_it_again_leaves_nothing_to_save()
    {
        var (agent, vm) = await Open();
        Assert.True(vm.IsMarkSelected);
        vm.Tiles[11].PickCommand.Execute(null);
        Assert.False(vm.IsMarkSelected);
        vm.PickMarkCommand.Execute(null);
        Assert.Null(vm.PreviewId);
        Assert.False(vm.SaveCommand.CanExecute(null));
        Assert.Equal(0, agent.FakeAvatars.Resets);
    }

    [Fact]
    public async Task A_return_to_the_RX_logo_with_no_answer_says_try_again()
    {
        var (agent, vm) = await Open("male", "M40", "M40");
        agent.FakeAvatars.Answers.Enqueue(ApiResult<MyAvatar>.TransientFailure("Check your connection and try again."));
        vm.PickMarkCommand.Execute(null);
        await vm.SaveCommand.ExecuteAsync(null);
        Assert.Equal("Try saving your avatar again.", vm.Error);
        Assert.Equal("M40", agent.FakeAvatars.ShownId);
        Assert.True(vm.SaveCommand.CanExecute(null));
    }

    // ---- A change from elsewhere ------------------------------------------------------------------

    [Fact]
    public async Task A_change_from_another_device_shows_here_and_a_pick_made_meanwhile_stays()
    {
        var (agent, vm) = await Open();
        agent.FakeAvatars.Have("male", "M07", "M07");
        agent.FakeAvatars.RaiseChanged();
        Assert.Equal("M07", vm.PreviewId);

        vm.Tiles[1].PickCommand.Execute(null);
        agent.FakeAvatars.Have("male", "M09", "M09");
        agent.FakeAvatars.RaiseChanged();
        Assert.Equal("M02", vm.PreviewId);
        Assert.True(vm.SaveCommand.CanExecute(null));
    }

    [Fact]
    public async Task A_gender_change_or_an_admins_reset_starts_the_picker_over_on_the_new_library()
    {
        var (agent, vm) = await Open("male", "M40", "M40");
        vm.Tiles[1].PickCommand.Execute(null);
        agent.FakeAvatars.Have("female", "F01");
        agent.FakeAvatars.RaiseChanged();

        Assert.Equal("75 female avatars", vm.CountText);
        Assert.Null(vm.PreviewId);
        Assert.True(vm.IsMarkSelected);
        Assert.False(vm.SaveCommand.CanExecute(null));
        Assert.All(vm.Tiles, t => Assert.StartsWith("F", t.Id));
        Assert.True(vm.Sets[0].IsSelected);

        // The gender taken away: back to the calm line.
        agent.FakeAvatars.Mine = new MyAvatar();
        agent.FakeAvatars.ShownId = null;
        agent.FakeAvatars.RaiseChanged();
        Assert.True(vm.HasNoLibrary);
        Assert.Empty(vm.Tiles);
    }

    [Fact]
    public async Task Closing_stops_following()
    {
        var (agent, vm) = await Open();
        vm.Closed();
        agent.FakeAvatars.Have("male", "M07", "M07");
        agent.FakeAvatars.RaiseChanged();
        Assert.Null(vm.PreviewId);
    }

    // ---- The preview's status and ring ------------------------------------------------------------

    private static ApiResult<DayProgress> Day(string status, int worked, int target = 8 * 3600, string date = "2026-10-13", DateTimeOffset? breakEndsAt = null) =>
        ApiResult<DayProgress>.Success(new DayProgress { Status = status, WorkedSec = worked, TargetSec = target, Date = date, BreakEndsAt = breakEndsAt });

    private static int Hm(int hours, int minutes) => hours * 3600 + minutes * 60;

    [Theory]
    [InlineData(DayProgressStatus.Working, 4, 58, "Working · 4h 58m of 8h")]
    [InlineData(DayProgressStatus.Meeting, 5, 12, "In a meeting · 5h 12m of 8h")]
    [InlineData(DayProgressStatus.Break, 3, 30, "On break · 3h 30m of 8h")]
    [InlineData(DayProgressStatus.NotStarted, 0, 0, "Not started · 0h 00m of 8h")]
    [InlineData(DayProgressStatus.Ended, 8, 15, "Day ended · 8h 15m today")]
    [InlineData(DayProgressStatus.Working, 8, 15, "Working · +15 min over target")]
    [InlineData(DayProgressStatus.Meeting, 9, 5, "In a meeting · +1h 05m over target")]
    public async Task The_preview_says_what_the_hover_label_says(string status, int hours, int minutes, string label)
    {
        var (_, vm) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(status, Hm(hours, minutes)));
        Assert.Equal(label, vm.StatusLabel);
    }

    [Fact]
    public async Task An_ended_day_drops_today_once_the_date_has_moved_on()
    {
        var (_, vm) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Ended, Hm(8, 15), date: "2026-10-12"));
        Assert.Equal("Day ended · 8h 15m", vm.StatusLabel);
    }

    [Fact]
    public async Task A_break_past_its_length_counts_up_every_second()
    {
        var (agent, vm) = await Open(before: a =>
            a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Break, Hm(3, 30), breakEndsAt: Ist.At("10:40:28")));
        Assert.Equal("Break extended · 04:32", vm.StatusLabel);
        Assert.Equal("!", vm.Look.Badge);
        agent.SetNow("10:45:30");
        vm.Tick();
        Assert.Equal("Break extended · 05:02", vm.StatusLabel);
    }

    [Fact]
    public async Task The_ring_follows_the_look_the_design_gives_each_status()
    {
        var (_, working) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Working, Hm(4, 0)));
        Assert.Equal(0.5, working.Look.Sweep, 3);
        Assert.Equal(PreviewLook.Teal, working.Look.Ring);
        Assert.Equal(0.90, working.Look.RingOpacity);
        Assert.Equal(PreviewLook.Green, working.Look.Dot);
        Assert.False(working.Look.HollowDot);

        var (_, meeting) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Meeting, Hm(4, 0)));
        Assert.Equal(PreviewLook.Purple, meeting.Look.Ring);
        Assert.Equal(PreviewLook.Purple, meeting.Look.Dot);

        var (_, onBreak) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Break, Hm(3, 30)));
        Assert.Equal(0.36, onBreak.Look.RingOpacity);
        Assert.Equal(PreviewLook.Amber, onBreak.Look.Dot);

        var (_, reached) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Working, Hm(9, 0)));
        Assert.Equal(1, reached.Look.Sweep);
        Assert.Equal(PreviewLook.Green, reached.Look.Ring);
        Assert.Equal(0.95, reached.Look.RingOpacity);

        var (_, ended) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Ended, Hm(8, 15)));
        Assert.True(ended.Look.HollowDot);
        Assert.Equal(PreviewLook.Teal, ended.Look.Ring);
        Assert.Equal(0.30, ended.Look.RingOpacity);
        Assert.Equal(1, ended.Look.Sweep);

        var (_, notStarted) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.NotStarted, 0));
        Assert.True(notStarted.Look.HollowDot);
        Assert.Null(notStarted.Look.Ring);
    }

    [Fact]
    public async Task Between_reads_the_time_counts_on_only_while_working_and_is_read_again_each_minute()
    {
        var (agent, vm) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Working, Hm(4, 58)));
        var reads = agent.FakeAvatars.DayReads;
        agent.ManualClock.Advance(TimeSpan.FromSeconds(30));
        vm.Tick();
        Assert.Equal(reads, agent.FakeAvatars.DayReads);
        agent.ManualClock.Advance(TimeSpan.FromSeconds(31));
        vm.Tick();
        Assert.Equal(reads + 1, agent.FakeAvatars.DayReads);

        var (paused, onBreak) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Break, Hm(3, 30)));
        paused.ManualClock.Advance(TimeSpan.FromMinutes(5));
        onBreak.Tick();
        Assert.Equal("On break · 3h 30m of 8h", onBreak.StatusLabel);
    }

    [Fact]
    public async Task With_no_answer_the_preview_draws_the_day_this_agent_knows()
    {
        var (_, vm) = await Open();
        Assert.Equal(PreviewStatus.Working, vm.Look.Status);
        Assert.StartsWith("Working · ", vm.StatusLabel);
        Assert.True(vm.Look.Sweep > 0);
    }

    [Fact]
    public async Task A_day_change_reads_the_ring_again()
    {
        var (agent, vm) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Working, Hm(4, 58)));
        agent.FakeAvatars.DayAnswer = Day(DayProgressStatus.Break, Hm(4, 58));
        agent.RaiseWorkday();
        await Task.Yield();
        Assert.Equal("On break · 4h 58m of 8h", vm.StatusLabel);
    }

    // ---- Offline ---------------------------------------------------------------------------------

    [Fact]
    public async Task Before_any_answer_the_avatars_id_says_which_library_to_offer()
    {
        var (agent, vm) = await Open(before: a =>
        {
            a.FakeAvatars.Mine = null;
            a.FakeAvatars.ShownId = "F40";
        });
        Assert.Equal("75 female avatars", vm.CountText);
        Assert.Equal("F40", Assert.Single(vm.Tiles, t => t.IsSelected).Id);
        Assert.All(vm.Tiles, t => Assert.StartsWith("F", t.Id));
        // A save with no network is tried, and says so.
        agent.FakeAvatars.Answers.Enqueue(ApiResult<MyAvatar>.TransientFailure("Check your connection and try again."));
        vm.Tiles[0].PickCommand.Execute(null);
        await vm.SaveCommand.ExecuteAsync(null);
        Assert.Equal("Try saving your avatar again.", vm.Error);
    }

    // ---- The window ------------------------------------------------------------------------------

    private static AvatarPickerWindow Show(AvatarPickerViewModel vm)
    {
        var window = new AvatarPickerWindow { DataContext = vm };
        window.Show();
        Dispatcher.UIThread.RunJobs();
        return window;
    }

    private static readonly DayProgress Working = new() { Status = DayProgressStatus.Working, WorkedSec = Hm(4, 58), TargetSec = 8 * 3600, Date = "2026-10-13" };

    [AvaloniaFact]
    public async Task Picker_is_396_by_630_with_the_RX_logo_six_across_and_no_file_control_anywhere()
    {
        var (_, vm) = await Open(before: a => a.FakeAvatars.DayAnswer = ApiResult<DayProgress>.Success(Working));
        var window = Show(vm);
        Assert.Equal(396, window.Width);
        Assert.Equal(630, window.Height);
        Assert.Equal(25, window.GetVisualDescendants().OfType<PersonAvatar>().Count());
        Assert.Single(window.GetVisualDescendants().OfType<MarkCircle>());
        var preview = window.FindControl<PreviewIcon>("Preview")!;
        Assert.Equal(88, preview.Width);
        Assert.Equal(60, preview.TranslatePoint(new Point(0, 0), window)!.Value.Y, 0);
        Assert.DoesNotContain(window.GetVisualDescendants(), v => v.GetType().Name.Contains("File", StringComparison.OrdinalIgnoreCase));
        var labels = window.GetVisualDescendants().OfType<Button>().Select(b => Avalonia.Automation.AutomationProperties.GetName(b)).ToList();
        Assert.Contains("Save", labels);
        Assert.Contains("RX logo, default", labels);
        Assert.Equal(new[] { "Formal", "Casual", "Smart" }, labels.Where(l => l is "Formal" or "Casual" or "Smart"));
        Assert.DoesNotContain("Reset to default", labels);
        Assert.DoesNotContain(labels, l => l is not null && l.Contains("upload", StringComparison.OrdinalIgnoreCase));
        window.Close();
    }

    [AvaloniaFact]
    public async Task Shot_the_RX_logo_by_default()
    {
        var (_, vm) = await Open(before: a => a.FakeAvatars.DayAnswer = ApiResult<DayProgress>.Success(Working));
        var window = Show(vm);
        Shots.Save(window, "avatar-picker-rx-default");
        window.Close();
    }

    [AvaloniaFact]
    public async Task Shot_male_set_1_working_with_a_pick()
    {
        var (_, vm) = await Open(before: a => a.FakeAvatars.DayAnswer = ApiResult<DayProgress>.Success(Working));
        vm.Tiles[11].PickCommand.Execute(null);
        var window = Show(vm);
        Shots.Save(window, "avatar-picker-male-set-1");
        window.Close();
    }

    [AvaloniaFact]
    public async Task Shot_female_set_2_in_a_meeting()
    {
        var (_, vm) = await Open("female", "F40", "F40", before: a =>
            a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Meeting, Hm(5, 12)));
        var window = Show(vm);
        Shots.Save(window, "avatar-picker-female-set-2-meeting");
        window.Close();
    }

    [AvaloniaFact]
    public async Task A_selected_avatar_down_the_set_is_brought_into_view()
    {
        var (_, vm) = await Open("female", "F40", "F40");
        var window = Show(vm);
        Dispatcher.UIThread.RunJobs();
        var scroller = window.FindControl<ScrollViewer>("GridScroller")!;
        // F40 is the 15th of its set: the third row, with one row above it.
        Assert.Equal(74, scroller.Offset.Y);

        vm.Sets[0].ChooseCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal(0, scroller.Offset.Y);
        window.Close();
    }

    [AvaloniaFact]
    public async Task Shot_no_gender_set_shows_the_RX_logo_in_the_bezel()
    {
        var (_, vm) = await Open(library: null, before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Working, Hm(2, 10)));
        var window = Show(vm);
        Shots.Save(window, "avatar-picker-no-gender");
        window.Close();
    }

    [AvaloniaFact]
    public async Task Shot_a_save_that_did_not_reach_the_server()
    {
        var (agent, vm) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Break, Hm(3, 30)));
        agent.FakeAvatars.Answers.Enqueue(ApiResult<MyAvatar>.TransientFailure("Check your connection and try again."));
        vm.Tiles[7].PickCommand.Execute(null);
        await vm.SaveCommand.ExecuteAsync(null);
        var window = Show(vm);
        Shots.Save(window, "avatar-picker-try-again");
        window.Close();
    }

    [AvaloniaFact]
    public async Task Shot_a_refusal_in_the_decks_words()
    {
        var (agent, vm) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Ended, Hm(8, 15)));
        agent.FakeAvatars.Answers.Enqueue(Refused(403, "AVATAR_OTHER_LIBRARY", "You can pick from your own avatars."));
        vm.Tiles[7].PickCommand.Execute(null);
        await vm.SaveCommand.ExecuteAsync(null);
        var window = Show(vm);
        Shots.Save(window, "avatar-picker-refused");
        window.Close();
    }

    [AvaloniaFact]
    public async Task Shot_break_extended()
    {
        var (_, vm) = await Open(before: a => a.FakeAvatars.DayAnswer = Day(DayProgressStatus.Break, Hm(3, 30), breakEndsAt: Ist.At("10:40:28")));
        var window = Show(vm);
        Shots.Save(window, "avatar-picker-break-extended");
        window.Close();
    }

    [AvaloniaFact]
    public void Placement_opens_left_of_the_icon_then_right_and_stays_in_the_work_area()
    {
        var work = new PixelRect(0, 0, 1440, 900);
        var panel = new PixelSize(396, 572);
        // Bottom right: to the left, 16 px gap, bottoms aligned.
        var spot = PickerPlacement.Beside(new PixelPoint(1384, 844), 1, panel, work);
        Assert.Equal(1384 - 28 - 16 - 396, spot.X);
        Assert.Equal(844 + 28 - 572, spot.Y);
        // No room on the left: to the right.
        spot = PickerPlacement.Beside(new PixelPoint(100, 844), 1, panel, work);
        Assert.Equal(100 + 28 + 16, spot.X);
        // Near the top: pushed down into the work area.
        spot = PickerPlacement.Beside(new PixelPoint(1384, 100), 1, panel, work);
        Assert.Equal(0, spot.Y);
        // At 2x every distance doubles.
        spot = PickerPlacement.Beside(new PixelPoint(2768, 1688), 2, new PixelSize(792, 1144), new PixelRect(0, 0, 2880, 1800));
        Assert.Equal(2768 - 56 - 32 - 792, spot.X);
        Assert.Equal(1688 + 56 - 1144, spot.Y);
    }

    // ---- Profile ----------------------------------------------------------------------------------

    private static async Task<(FakeAgent Agent, DashboardViewModel Vm, DashboardWindow Window)> Dashboard(string role = "USER")
    {
        var agent = new FakeAgent();
        agent.User!.Role = role;
        agent.FakeAvatars.Have("male", "M12", "M12");
        agent.FakeAvatars.PersonName = agent.User.DisplayName;
        var dialogs = new FakeDialogs();
        var vm = new DashboardViewModel(agent, new BreakActions(agent, dialogs, NullLog.Instance), NullLog.Instance);
        await vm.Chat.ActivateAsync();
        var window = new DashboardWindow { DataContext = vm, Width = 1080, Height = 700 };
        window.Show();
        vm.Refresh();
        Dispatcher.UIThread.RunJobs();
        return (agent, vm, window);
    }

    [AvaloniaTheory]
    [InlineData("USER")]
    [InlineData("MANAGER")]
    [InlineData("SUPER_ADMIN")]
    public async Task Profile_is_in_the_menu_for_everyone_and_leads_to_the_avatar(string role)
    {
        var (_, vm, window) = await Dashboard(role);
        var opened = 0;
        vm.Profile.AvatarRequested = () => opened++;
        // 4.0: the account row heads the panel's menu (3.6 had a Profile tab).
        vm.ToggleMenuCommand.Execute(null);
        Dispatcher.UIThread.RunJobs();
        Assert.True(vm.IsMenuOpen);
        Assert.Equal("Asha Kumar", vm.Profile.DisplayName);
        Assert.Equal("M12", vm.Profile.AvatarId);
        // No Avatar row: the account itself is the way in (D-85).
        var buttons = window.GetVisualDescendants().OfType<Button>().Where(b => b.IsEffectivelyVisible).ToList();
        Assert.DoesNotContain(buttons, b => Avalonia.Automation.AutomationProperties.GetName(b) == "Avatar");
        var account = Assert.Single(buttons, b => b.Name == "Account");
        account.Command!.Execute(null);
        Assert.Equal(1, opened);
        if (role == "USER") Shots.Save(window, "avatar-profile-page");
        window.AllowClose = true;
        window.Close();
    }

    [AvaloniaFact]
    public async Task The_panels_icon_and_the_profile_follow_a_change_at_once()
    {
        var (agent, vm, window) = await Dashboard();
        Assert.Equal("M12", vm.Profile.AvatarId);
        agent.FakeAvatars.ShownId = "M30";
        agent.FakeAvatars.RaiseChanged();
        Assert.Equal("M30", vm.Profile.AvatarId);
        Assert.Equal("M30", ((AvatarIconSource)vm.IconAvatars).AvatarId);
        window.AllowClose = true;
        window.Close();
    }
}
