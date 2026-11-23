using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Threading;
using Avalonia.VisualTree;
using RXVision.Agent.Controls;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Avatars;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.ViewModels.Dialogs;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>The seam to the floating icon, the bundled bitmaps, and the avatar wherever a person shows.</summary>
public class AvatarFaceTests
{
    private static Bitmap Draw(Control control, double width, double height, Action<Window>? before = null)
    {
        var window = new Window { Width = width, Height = height, Background = Avalonia.Media.Brushes.Black, Content = control, SystemDecorations = SystemDecorations.None };
        window.Show();
        before?.Invoke(window);
        for (var i = 0; i < 3; i++)
        {
            Dispatcher.UIThread.RunJobs();
            AvaloniaHeadlessPlatform.ForceRenderTimerTick();
        }
        var frame = window.CaptureRenderedFrame() ?? throw new InvalidOperationException("nothing rendered");
        window.Close();
        return frame;
    }

    /// <summary>The colour of one pixel, whichever byte order the frame has.</summary>
    private static (byte R, byte G, byte B) Pixel(Bitmap frame, int x, int y)
    {
        var bytes = new byte[4];
        unsafe
        {
            fixed (byte* p = bytes)
            {
                frame.CopyPixels(new PixelRect(x, y, 1, 1), (nint)p, 4, 4);
            }
        }
        return frame.Format == PixelFormat.Bgra8888 ? (bytes[2], bytes[1], bytes[0]) : (bytes[0], bytes[1], bytes[2]);
    }

    // ---- The seam to the icon ----------------------------------------------------------------------

    [Fact]
    public void A_save_reaches_the_icon_at_once_before_any_answer_and_a_failure_puts_it_back()
    {
        var agent = new FakeAgent();
        agent.FakeAvatars.Have("male", "M01");
        var icon = new AvatarIconSource(agent);
        Assert.Null(icon.AvatarId);

        var hold = new TaskCompletionSource();
        agent.FakeAvatars.Hold = hold;
        agent.FakeAvatars.Answers.Enqueue(ApiResult<MyAvatar>.TransientFailure("offline"));
        var saving = agent.FakeAvatars.SaveAsync("M12");
        Assert.False(saving.IsCompleted);
        Assert.Equal("M12", icon.AvatarId);

        hold.SetResult();
        Assert.True(saving.IsCompleted);
        Assert.Null(icon.AvatarId);
    }

    [Fact]
    public void With_no_choice_or_no_gender_the_icon_has_the_RX_mark()
    {
        var agent = new FakeAgent();
        agent.FakeAvatars.Have("female", "F01");
        var icon = new AvatarIconSource(agent);
        Assert.Null(icon.AvatarId);
        Assert.Null(icon.Picture(42));
        agent.FakeAvatars.Mine = new MyAvatar();
        Assert.Null(icon.Picture(42));
    }

    [AvaloniaFact]
    public void The_icon_draws_the_bundled_avatar_and_swaps_at_once()
    {
        var agent = new FakeAgent();
        agent.FakeAvatars.Have("male", "M11", "M11");
        using var rig = new IconRig(agent, avatars: new AvatarIconSource(agent));
        rig.Settle();
        var window = rig.Window();
        window.Show();
        IconRig.Pump();
        var view = window.GetVisualDescendants().OfType<FloatingIconView>().Single();
        Assert.NotNull(rig.Vm.Avatars.Picture(42));
        Shots.Save(window, "avatar-icon-m11");

        var draws = view.Draws;
        agent.FakeAvatars.ShownId = "F40";
        agent.FakeAvatars.RaiseChanged();
        IconRig.Pump();
        Assert.Equal(draws + 1, view.Draws);
        Assert.Equal("F40", ((AvatarIconSource)rig.Vm.Avatars).AvatarId);
        Shots.Save(window, "avatar-icon-f40");

        agent.FakeAvatars.ShownId = null;
        agent.FakeAvatars.RaiseChanged();
        IconRig.Pump();
        Assert.Equal(draws + 2, view.Draws);
        Assert.Null(rig.Vm.Avatars.Picture(42));
        Shots.Save(window, "avatar-icon-rx-mark");
        window.Close();
    }

    [AvaloniaFact]
    public void The_source_gives_the_icon_its_picture_at_each_scale_and_says_when_to_draw_again()
    {
        var agent = new FakeAgent();
        agent.FakeAvatars.Have("female", "F07", "F07");
        var source = new AvatarIconSource(agent, new AvatarImages(AvatarLibrary.Bundled));
        var redraws = 0;
        source.Changed += () => redraws++;

        // 1x, 1.5x, 2x and 3x of the icon's 42 px circle.
        foreach (var pixels in new[] { 42, 63, 84, 126 }) Assert.Equal(new PixelSize(pixels, pixels), source.Picture(pixels)!.PixelSize);

        agent.FakeAvatars.ShownId = "F20";
        agent.FakeAvatars.RaiseChanged();
        Assert.Equal(1, redraws);
        Assert.Equal("F20", source.AvatarId);

        // Back to the RX logo: no picture, the mark stands in.
        agent.FakeAvatars.ShownId = null;
        Assert.Null(source.Picture(42));
    }

    // ---- The bundled bitmaps ------------------------------------------------------------------------

    [AvaloniaFact]
    public void Every_avatar_in_the_library_draws_from_the_bundle()
    {
        var images = AvatarImages.Shared;
        Assert.Null(AvatarLibrary.Bundled.LoadError);
        Assert.Equal(150, AvatarLibrary.Bundled.Entries.Count);
        foreach (var entry in AvatarLibrary.Bundled.Entries) Assert.NotNull(images.Get(entry.Id, 48));
    }

    [AvaloniaTheory]
    [InlineData(42, "48")]
    [InlineData(63, "64")]
    [InlineData(84, "96")]
    [InlineData(126, "128")]
    [InlineData(150, "192")]
    public void It_takes_the_next_larger_file_and_gives_the_exact_size(int pixels, string file)
    {
        Assert.Contains($"webp/{file}/", AvatarLibrary.Bundled.FileFor("M12", pixels)!.Replace('\\', '/'));
        var bitmap = new AvatarImages(AvatarLibrary.Bundled).Get("M12", pixels)!;
        Assert.Equal(new PixelSize(pixels, pixels), bitmap.PixelSize);
    }

    [AvaloniaFact]
    public void A_scaled_bitmap_is_kept_and_nothing_unknown_is_drawn()
    {
        var images = new AvatarImages(AvatarLibrary.Bundled);
        Assert.Same(images.Get("F07", 96), images.Get("F07", 96));
        Assert.Null(images.Get("Z99", 96));
        Assert.Null(images.Get(null, 96));
        Assert.Null(images.Get("../../etc/passwd", 96));
    }

    [AvaloniaFact]
    public void A_file_gone_from_the_bundle_falls_back_to_the_RX_mark_and_never_throws()
    {
        var dir = Directory.CreateTempSubdirectory("rxv-avatar-gone-").FullName;
        try
        {
            File.WriteAllText(Path.Combine(dir, "manifest.json"),
                """{"default":{"male":"M01","female":"F01"},"avatars":[{"id":"M01","gender":"male","set":1,"files":{"48":"webp/48/M01.webp"}}]}""");
            var images = new AvatarImages(AvatarLibrary.Load(dir));
            Assert.Null(images.Get("M01", 48));
        }
        finally
        {
            File.Delete(Path.Combine(dir, "manifest.json"));
            Directory.Delete(dir);
        }
    }

    [AvaloniaFact]
    public void A_file_that_is_not_a_picture_falls_back_to_the_RX_mark_too()
    {
        var dir = Directory.CreateTempSubdirectory("rxv-avatar-bad-").FullName;
        try
        {
            File.WriteAllText(Path.Combine(dir, "manifest.json"),
                """{"avatars":[{"id":"M01","gender":"male","set":1,"files":{"48":"M01.webp"}}]}""");
            File.WriteAllText(Path.Combine(dir, "M01.webp"), "not a picture");
            Assert.Null(new AvatarImages(AvatarLibrary.Load(dir)).Get("M01", 48));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }

    // ---- What the controls draw ----------------------------------------------------------------------

    [AvaloniaFact]
    public void An_avatar_is_clipped_to_its_circle_and_the_corners_stay_clear()
    {
        var frame = Draw(new PersonAvatar { AvatarId = "M12", Width = 96, Height = 96 }, 96, 96);
        var middle = Pixel(frame, 48, 48);
        Assert.True(middle.R + middle.G + middle.B > 60, "the face should be drawn");
        var corner = Pixel(frame, 2, 2);
        Assert.Equal(0, corner.R + corner.G + corner.B);
    }

    [AvaloniaFact]
    public void An_unknown_id_and_no_id_draw_the_RX_mark_on_its_fill()
    {
        foreach (var id in new[] { null, "Z99" })
        {
            var frame = Draw(new PersonAvatar { AvatarId = id, Width = 96, Height = 96 }, 96, 96);
            // Above the mark, inside the circle: #2B3343.
            var fill = Pixel(frame, 48, 12);
            Assert.Equal((0x2B, 0x33, 0x43), (fill.R, fill.G, fill.B));
            // In the middle, the R's #B2B9C5 and the X's #687182.
            var middle = Enumerable.Range(20, 56).SelectMany(x => Enumerable.Range(30, 36).Select(y => Pixel(frame, x, y))).ToList();
            Assert.Contains(middle, p => (p.R, p.G, p.B) == (0xB2, 0xB9, 0xC5));
            Assert.Contains(middle, p => (p.R, p.G, p.B) == (0x68, 0x71, 0x82));
        }
    }

    [AvaloniaFact]
    public void The_preview_draws_the_ring_from_the_dot_clockwise_and_the_dot_on_the_ring()
    {
        // 1 s short of a quarter: from 135 degrees clockwise round to 225 degrees, the bottom left.
        var look = PreviewLook.For(PreviewStatus.Working, 2 * 3600, 8 * 3600);
        var frame = Draw(new PreviewIcon { AvatarId = "M12", Look = look, Width = 112, Height = 112 }, 112, 112);
        // At 2x the ring has radius 50 about (56, 56): at 180 degrees, the bottom, it is painted teal.
        var onArc = Pixel(frame, 56, 106);
        Assert.True(onArc.G > onArc.R + 40, $"the arc should pass through the bottom: {onArc}");
        // At 0 degrees, the top, there is only the track.
        var offArc = Pixel(frame, 56, 6);
        Assert.False(offArc.G > offArc.R + 40, $"the arc should stop before the top: {offArc}");
        // The dot, 7 px at 1x, at (45.68, 45.68): green at 2x about (91, 91).
        var dot = Pixel(frame, 91, 91);
        Assert.Equal((0x34, 0xD2, 0x7A), (dot.R, dot.G, dot.B));
    }

    [AvaloniaFact]
    public void With_the_RX_logo_the_preview_keeps_the_bezel_with_the_mark_inside()
    {
        var frame = Draw(new PreviewIcon { Look = PreviewLook.For(PreviewStatus.Working, 3600, 8 * 3600), Width = 112, Height = 112 }, 112, 112);
        var bezel = Pixel(frame, 56, 4);
        Assert.True(bezel.G > 30, $"the bezel should be drawn: {bezel}");
        var fill = Pixel(frame, 56, 22);
        Assert.Equal((0x2B, 0x33, 0x43), (fill.R, fill.G, fill.B));
    }

    // ---- Wherever a person shows -----------------------------------------------------------------

    private static async Task<(FakeAgent, DashboardViewModel, DashboardWindow)> Dashboard()
    {
        var agent = new FakeAgent();
        agent.FakeAvatars.Have("female", "F12", "F12");
        agent.FakeChat.ContactList[0].AvatarId = "F20";
        agent.FakeChat.Conversation.Add(new ChatMessage { Id = "c1", FromUserId = "m-1", ToUserId = "u-1", Body = "Morning. The review moved to 3:30 PM.", CreatedAt = Ist.At("10:40") });
        agent.FakeChat.Conversation.Add(new ChatMessage { Id = "c2", FromUserId = "u-1", ToUserId = "m-1", Body = "Thanks, I'll be there.", Mine = true, CreatedAt = Ist.At("10:41") });
        var dialogs = new FakeDialogs();
        var vm = new DashboardViewModel(agent, new BreakActions(agent, dialogs, NullLog.Instance), NullLog.Instance);
        await vm.Chat.ActivateAsync();
        var window = new DashboardWindow { DataContext = vm };
        window.Show();
        vm.Refresh();
        Dispatcher.UIThread.RunJobs();
        return (agent, vm, window);
    }

    [AvaloniaFact]
    public async Task The_profile_and_chat_rows_show_the_avatar_and_follow_a_change()
    {
        var (agent, vm, window) = await Dashboard();
        // 4.0: the header shows the person; the menu's account row too (3.6 had a Profile tab).
        Assert.Contains(window.GetVisualDescendants().OfType<PersonAvatar>(), f => f.AvatarId == "F12" && f.Width == 40);
        vm.ToggleMenuCommand.Execute(null);
        window.UpdateLayout();
        Dispatcher.UIThread.RunJobs();
        Assert.Contains(window.GetVisualDescendants().OfType<PersonAvatar>(), f => f.AvatarId == "F12" && f.Width == 36);
        // The chat sits on the dashboard in 4.0.
        window.UpdateLayout();
        Dispatcher.UIThread.RunJobs();
        Assert.Contains(window.GetVisualDescendants().OfType<PersonAvatar>(), f => f.AvatarId == "F20" && f.Width == 28);
        Shots.Save(window, "avatar-dashboard-and-chat");

        // Someone else's change, from the socket: their rows follow; a stranger's changes nothing.
        agent.FakeAvatars.RaisePerson("m-1", "F33");
        agent.FakeAvatars.RaisePerson("nobody", "M02");
        Assert.Equal("F33", vm.Chat.SelectedContact!.AvatarId);
        Assert.Equal("F33", Assert.Single(vm.Chat.Messages, m => m.IsTheirs).AvatarId);
        Assert.Null(Assert.Single(vm.Chat.Messages, m => m.IsMine).AvatarId);

        // Back to the RX logo: the mark.
        agent.FakeAvatars.RaisePerson("m-1", null);
        Dispatcher.UIThread.RunJobs();
        Assert.Null(vm.Chat.SelectedContact!.AvatarId);
        Assert.Contains(window.GetVisualDescendants().OfType<PersonAvatar>(), f => f.AvatarId is null && f.Width == 28);
        window.AllowClose = true;
        window.Close();
    }

    [Fact]
    public async Task Contacts_read_again_bring_their_new_pictures_to_an_open_chat()
    {
        var agent = new FakeAgent();
        agent.FakeChat.ContactList[0].AvatarId = "F20";
        agent.FakeChat.Conversation.Add(new ChatMessage { Id = "c1", FromUserId = "m-1", ToUserId = "u-1", Body = "Morning", CreatedAt = Ist.At("10:40") });
        var chat = new ChatViewModel(agent, NullLog.Instance);
        await chat.ActivateAsync();
        Assert.Equal("F20", chat.SelectedContact!.AvatarId);

        agent.FakeChat.ContactList[0].AvatarId = "F33";
        await chat.ActivateAsync();
        Assert.Equal("F33", chat.SelectedContact!.AvatarId);
        Assert.Equal("F33", Assert.Single(chat.Messages).AvatarId);
    }

    [AvaloniaFact]
    public void Meeting_rows_use_the_avatar_chat_knows()
    {
        var agent = new FakeAgent();
        agent.FakeChat.ContactList[0].AvatarId = "F20";
        agent.State = AgentState.Running;
        agent.Presence = new CurrentPresence { Status = PresenceStatus.Meeting, Since = agent.Now };
        agent.LiveMeeting = new MeetingRecord
        {
            Id = "m", Agenda = "Review", StartedAt = agent.Now, InProgress = true,
            Participants = new() { new MeetingParticipant("m-1", "Maya Reddy"), new MeetingParticipant(null, "Vikram") },
        };
        var dialogs = new FakeDialogs();
        var vm = new DashboardViewModel(agent, new BreakActions(agent, dialogs, NullLog.Instance), NullLog.Instance);
        vm.Refresh();
        Assert.Equal("F20", vm.MeetingPeople[0].AvatarId);
        Assert.Null(vm.MeetingPeople[1].AvatarId);
    }

    [AvaloniaFact]
    public void Reconnecting_shows_the_person_who_is_still_signed_in()
    {
        var agent = new FakeAgent();
        agent.FakeAvatars.ShownId = "M12";
        agent.FakeAvatars.PersonName = "Asha Kumar";
        var vm = new SignInViewModel(agent, null, NullLog.Instance);
        vm.Prepare(AgentState.Connecting);
        Assert.True(vm.ShowPerson);
        Assert.Equal("M12", vm.PersonAvatarId);
        Assert.Equal("M12", vm.BrandAvatarId);
        var window = new SignInWindow { DataContext = vm };
        window.Show();
        Dispatcher.UIThread.RunJobs();
        Assert.Contains(window.GetVisualDescendants().OfType<PersonAvatar>(), f => f.IsVisible && f.AvatarId == "M12");
        Shots.Save(window, "avatar-sign-in-reconnecting");
        window.AllowClose = true;
        window.Close();

        // The form itself knows nobody: the RX mark.
        vm.ShowSignInFormCommand.Execute(null);
        Assert.False(vm.ShowPerson);
        Assert.Null(vm.BrandAvatarId);
        vm.Prepare(AgentState.SignIn);
        Assert.False(vm.ShowPerson);
        Assert.Null(vm.BrandAvatarId);
    }

    /// <remarks>On the UI thread: typing a name starts a search a moment later.</remarks>
    [AvaloniaFact]
    public async Task The_people_search_carries_the_avatar_to_the_chip_and_a_free_name_has_the_RX_mark()
    {
        var agent = new FakeAgent();
        agent.Directory[1].AvatarId = "M12";
        var dialogs = new FakeDialogs();
        var dialog = new MeetingDialogViewModel(new BreakActions(agent, dialogs, NullLog.Instance).MeetingContext());
        await dialog.LoadSuggestionsAsync();

        dialog.Suggestions.First(s => s.Person.Id == "p-2").AddCommand.Execute(null);
        Assert.Equal("M12", Assert.Single(dialog.Chosen).AvatarId);

        dialog.PersonQuery = "A visitor";
        dialog.AddTypedCommand.Execute(null);
        Assert.Null(dialog.Chosen[1].AvatarId);
    }

    [AvaloniaFact]
    public void A_message_toast_shows_the_senders_avatar()
    {
        var toast = new ToastViewModel(ToastKind.Message, "chat:m-1")
        {
            Heading = "New message", Title = "Maya Reddy", AvatarId = "F20", Stamp = "3:42 PM", Body = "Can you check the claims file?",
        };
        var window = new ToastWindow { DataContext = toast, Animate = false };
        window.ShowBeside(new PixelRect(1690, 470, 88, 88), new PixelPoint(1734, 514));
        Dispatcher.UIThread.RunJobs();
        Assert.Contains(window.GetVisualDescendants().OfType<PersonAvatar>(), f => f.AvatarId == "F20" && f.IsVisible);
        Shots.Save(window, "avatar-toast");
        window.Close();
    }
}
