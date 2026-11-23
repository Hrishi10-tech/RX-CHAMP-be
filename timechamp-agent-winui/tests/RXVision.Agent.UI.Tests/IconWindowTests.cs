using System.Reflection;
using System.Text.RegularExpressions;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.Media;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Icon;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using RXVision.Agent.Views;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>The icon's window: its size, where it goes, what takes the pointer, the hover label.</summary>
public class IconWindowTests
{
    private static (BubbleWindow Window, IconRig Rig) Shown(FakeAgent? agent = null)
    {
        var rig = new IconRig(agent ?? new FakeAgent("10:20"));
        var window = rig.Window();
        window.Show();
        IconRig.Pump();
        return (window, rig);
    }

    [AvaloniaFact]
    public void The_window_is_72_px_with_the_icon_in_a_56_px_box_at_its_middle()
    {
        var (window, rig) = Shown();
        Assert.Equal(72, window.ClientSize.Width);
        Assert.Equal(72, window.ClientSize.Height);
        Assert.Equal(WindowTransparencyLevel.Transparent, window.TransparencyLevelHint[0]);
        Assert.True(window.Topmost);
        Assert.False(window.ShowInTaskbar);
        Assert.False(window.ShowActivated);
        Assert.Equal(SystemDecorations.None, window.SystemDecorations);
        window.Close();
        rig.Dispose();
    }

    [AvaloniaFact]
    public void By_default_the_box_sits_28_px_from_the_right_and_bottom_of_the_work_area()
    {
        var (window, rig) = Shown();
        var screen = window.Screens.Primary!;
        var area = screen.WorkingArea;
        var pixels = OperatingSystem.IsMacOS() ? 1 : screen.Scaling;
        Assert.Equal((int)(area.Right - 56 * pixels), window.Anchor.X);
        Assert.Equal((int)(area.Bottom - 56 * pixels), window.Anchor.Y);
        window.Close();
        rig.Dispose();
    }

    [AvaloniaFact]
    public void A_saved_spot_stays()
    {
        var dir = Path.Combine(Path.GetTempPath(), "rxv-ui-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var placement = new BubblePlacement(new UiSettingsStore(dir, NullLog.Instance));
        using var rig = new IconRig(new FakeAgent("10:20"));
        var window = rig.Window(placement);
        var screen = window.Screens.Primary!;
        var spot = new PixelPoint(screen.WorkingArea.X + 300, screen.WorkingArea.Y + 240);
        placement.Save(screen, spot);
        window.Show();
        IconRig.Pump();
        Assert.Equal(spot, window.Anchor);
        window.Close();
    }

    [AvaloniaFact]
    public void Only_the_circle_and_the_badge_take_a_click()
    {
        var (window, rig) = Shown();
        var clicks = 0;
        window.Clicked += () => clicks++;

        void Click(Point at)
        {
            window.MouseMove(at);
            window.MouseDown(at, MouseButton.Left);
            window.MouseUp(at, MouseButton.Left);
            IconRig.Pump();
        }

        // On the bezel, near its edge.
        Click(new Point(36, 10));
        Assert.Equal(1, clicks);
        // The margin, the corners, the shadow below the bezel: nothing.
        Click(new Point(3, 3));
        Click(new Point(69, 69));
        Click(new Point(36, 68));
        Assert.Equal(1, clicks);
        // The corner by the top right has nothing to click until a badge is there.
        var corner = new Point(8 + 46 + 4.2, 8 + 10 - 4.2);
        Assert.False(IconGeometry.IsOnIcon(corner, hasBadge: false));
        Assert.True(IconGeometry.IsOnIcon(corner, hasBadge: true));
        Click(corner);
        Assert.Equal(1, clicks);
        rig.Alerts.Raise(new AlertCard("x", AlertLevel.Info, "Break ends in 2 min"));
        IconRig.Pump();
        Click(corner);
        Assert.Equal(2, clicks);
        window.Close();
        rig.Dispose();
    }

    private sealed class FakePointer : IIconPointer
    {
        public bool? On { get; set; }
        public List<bool> Through { get; } = new();
        public bool? IsOnIcon() => On;
        public void SetPassThrough(bool passThrough) => Through.Add(passThrough);
    }

    [Fact]
    public void On_the_margin_clicks_pass_through_until_the_pointer_leaves_it_and_nothing_runs_after()
    {
        var clock = new ManualClock(Ist.At("10:00"));
        var pointer = new FakePointer { On = false };
        using var through = new IconClickThrough(pointer, clock, new InlineDispatcher());
        through.PointerOnMargin();
        Assert.Equal(new[] { true }, pointer.Through);
        Assert.Equal(1, clock.Pending);

        clock.Advance(TimeSpan.FromSeconds(2));
        Assert.Single(pointer.Through);

        // Back on the circle: the window takes the pointer again, and the watch stops.
        pointer.On = true;
        clock.Advance(IconClickThrough.WatchEvery);
        Assert.Equal(new[] { true, false }, pointer.Through);
        Assert.Equal(0, clock.Pending);
        Assert.False(through.IsPassingThrough);

        // Off the window altogether does the same.
        pointer.On = false;
        through.PointerOnMargin();
        pointer.On = null;
        clock.Advance(IconClickThrough.WatchEvery);
        Assert.Equal(new[] { true, false, true, false }, pointer.Through);
        Assert.Equal(0, clock.Pending);
    }

    [Fact]
    public void Where_the_pointer_cannot_be_told_nothing_changes()
    {
        var clock = new ManualClock(Ist.At("10:00"));
        var pointer = new FakePointer { On = null };
        using var through = new IconClickThrough(pointer, clock, new InlineDispatcher());
        through.PointerOnMargin();
        Assert.Empty(pointer.Through);
        Assert.Equal(0, clock.Pending);
    }

    [AvaloniaFact]
    public void A_half_second_on_the_circle_shows_the_label_above_it_and_leaving_takes_it_away()
    {
        var (window, rig) = Shown();
        window.MouseMove(new Point(36, 36));
        IconRig.Pump();
        rig.Run(0.49);
        Assert.False(window.LabelWindow.IsVisible);
        rig.Run(0.02);
        IconRig.Pump();
        Assert.True(window.LabelWindow.IsVisible);
        Assert.Equal("Working · 1h 00m of 8h", window.LabelWindow.LabelText);

        window.MouseMove(new Point(2, 2));
        IconRig.Pump();
        Assert.False(window.LabelWindow.IsVisible);
        window.Close();
        rig.Dispose();
    }

    [AvaloniaFact]
    public void Hidden_by_a_full_screen_app_with_the_label_up_nothing_is_left_behind()
    {
        var (window, rig) = Shown();
        window.MouseMove(new Point(36, 36));
        IconRig.Pump();
        rig.Run(0.6);
        IconRig.Pump();
        Assert.True(window.LabelWindow.IsVisible);
        window.Hide();
        IconRig.Pump();
        Assert.False(window.LabelWindow.IsVisible);
        Assert.False(rig.Vm.IsLabelVisible);
        window.Close();
        rig.Dispose();
    }

    [AvaloniaFact]
    public void Closing_the_icon_closes_its_label_and_stops_the_margin_watch()
    {
        var (window, rig) = Shown();
        var label = window.LabelWindow;
        window.Close();
        IconRig.Pump();
        Assert.False(label.IsVisible);
        rig.Dispose();
        Assert.Equal(0, rig.Clock.Pending);
    }

    [Fact]
    public void The_pill_is_centred_above_the_icon_10_px_off_and_stays_inside_the_work_area()
    {
        var area = new PixelRect(0, 0, 1920, 1040);
        var label = new PixelSize(180, 29);
        var box = new PixelRect(1836, 956, 56, 56);
        var spot = HoverLabelWindow.Spot(box, area, label, 1);
        Assert.Equal(956 - 10 - 29, spot.Y);
        // Pushed in from the right edge: centred would leave the screen.
        Assert.Equal(1920 - 180, spot.X);

        var middle = new PixelRect(800, 400, 56, 56);
        spot = HoverLabelWindow.Spot(middle, area, label, 1);
        Assert.Equal(800 + (56 - 180) / 2, spot.X);

        // No room above: below it.
        var top = new PixelRect(800, 8, 56, 56);
        spot = HoverLabelWindow.Spot(top, area, label, 1);
        Assert.Equal(8 + 56 + 10, spot.Y);

        // The gap scales.
        spot = HoverLabelWindow.Spot(new PixelRect(800, 400, 112, 112), area, new PixelSize(360, 58), 2);
        Assert.Equal(400 - 20 - 58, spot.Y);
    }

    [AvaloniaFact]
    public void The_pill_is_drawn_as_set()
    {
        var label = new HoverLabelWindow();
        label.SetText("Working · 5h 12m of 8h");
        label.Show();
        IconRig.Pump();
        var pill = label.Content as Avalonia.Controls.Border;
        Assert.NotNull(pill);
        Assert.Equal(29, pill!.Bounds.Height);
        Assert.Equal(10, pill.CornerRadius.TopLeft);
        Assert.Equal(new Thickness(12, 0), pill.Padding);
        Assert.Equal(Color.Parse("#0F131A"), ((ISolidColorBrush)pill.Background!).Color);
        Assert.Equal(Color.Parse("#3A4356"), ((ISolidColorBrush)pill.BorderBrush!).Color);
        Assert.False(label.ShowActivated);
        Assert.True(new FileInfo(Shots.Save(label, "hover-label")).Length > 500);
        label.Close();
    }

    [AvaloniaFact]
    public void Screen_readers_get_the_label_named_on_the_window_and_it_follows_the_minute()
    {
        var (window, rig) = Shown();
        Assert.Equal("RX Vision · Working · 1h 00m of 8h", window.Title);
        rig.Run(60);
        IconRig.Pump();
        Assert.Equal("RX Vision · Working · 1h 01m of 8h", window.Title);
        window.Close();
        rig.Dispose();
    }

    [AvaloniaFact]
    public void Holding_still_does_not_redraw_and_the_view_shows_what_the_frame_says()
    {
        var (window, rig) = Shown();
        rig.Run(2);
        IconRig.Pump();
        var draws = window.View.Draws;
        // Faded and still: opacity and saturation changed, then nothing does, not the vectors either.
        rig.Run(30);
        IconRig.Pump();
        Assert.Equal(0.4, window.View.Opacity, 3);
        Assert.Equal(draws, window.View.Draws);
        rig.Run(20);
        IconRig.Pump();
        Assert.Equal(draws, window.View.Draws);
        window.Close();
        rig.Dispose();
    }

    [AvaloniaFact]
    public void The_faded_look_really_is_less_saturated_and_alpha_is_untouched()
    {
        var (window, rig) = Shown();
        rig.Run(5);
        IconRig.Pump();
        var full = Views.IconBitmap.CopyPixels(window.View.Shown!);
        rig.Run(30);
        IconRig.Pump();
        var faded = Views.IconBitmap.CopyPixels(window.View.Shown!);
        Assert.Equal(full.Length, faded.Length);
        var changed = 0;
        for (var i = 0; i < full.Length; i += 4)
        {
            Assert.Equal(full[i + 3], faded[i + 3]);
            var spreadFull = Math.Max(full[i], Math.Max(full[i + 1], full[i + 2])) - Math.Min(full[i], Math.Min(full[i + 1], full[i + 2]));
            var spreadFaded = Math.Max(faded[i], Math.Max(faded[i + 1], faded[i + 2])) - Math.Min(faded[i], Math.Min(faded[i + 1], faded[i + 2]));
            if (spreadFull < 40) continue;
            Assert.InRange(spreadFaded, spreadFull * 0.6 - 2, spreadFull * 0.6 + 2);
            changed++;
        }
        Assert.True(changed > 20, "the green dot lost its colour with the rest");
        window.Close();
        rig.Dispose();
    }

    [AvaloniaFact]
    public void Dragging_holds_the_hover_state_and_counts_as_an_interaction()
    {
        var (window, rig) = Shown();
        rig.Run(29);
        window.MouseMove(new Point(36, 36));
        window.MouseDown(new Point(36, 36), MouseButton.Left);
        window.MouseMove(new Point(50, 50));
        IconRig.Pump();
        window.MouseUp(new Point(50, 50), MouseButton.Left);
        IconRig.Pump();
        rig.Run(29);
        Assert.Equal(1, rig.Vm.Opacity, 3);
        window.Close();
        rig.Dispose();
    }

    [AvaloniaFact]
    public void The_icon_moves_with_the_shake_and_not_up_or_down()
    {
        var (window, rig) = Shown();
        rig.Alerts.Raise(new AlertCard("x", AlertLevel.Action, "Time for your morning break"));
        rig.Run(0.0625);
        IconRig.Pump();
        var shift = Assert.IsType<TranslateTransform>(window.View.RenderTransform);
        Assert.InRange(Math.Abs(shift.X), 0.9, 1.0);
        Assert.Equal(0, shift.Y);
        rig.Run(1.2);
        IconRig.Pump();
        Assert.Equal(0, shift.X);
        window.Close();
        rig.Dispose();
    }

    [AvaloniaFact]
    public void The_avatar_seam_changes_the_picture_on_its_own_say()
    {
        var source = new SwitchingAvatars();
        var rig = new IconRig(new FakeAgent("10:20"), avatars: source);
        var window = rig.Window();
        window.Show();
        IconRig.Pump();
        var draws = window.View.Draws;
        source.Set();
        IconRig.Pump();
        Assert.Equal(draws + 1, window.View.Draws);
        window.Close();
        rig.Dispose();
    }

    private sealed class SwitchingAvatars : IIconAvatarSource
    {
        public Avalonia.Media.Imaging.Bitmap? Picture(int devicePixels) => null;
        public event Action? Changed;
        public void Set() => Changed?.Invoke();
    }
}

/// <summary>Things that must not exist any more, read from the build and from the source.</summary>
public class NoSoundNoRedTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "RXVision.Agent.sln"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("no repo root");
    }

    [Fact]
    public void The_agent_has_no_sound_on_any_path()
    {
        Assert.Null(typeof(IPlatform).GetProperty("Sound"));
        var assemblies = new[] { typeof(IPlatform).Assembly, typeof(BubbleViewModel).Assembly };
        foreach (var assembly in assemblies)
        {
            Assert.DoesNotContain(assembly.GetTypes(), t => Regex.IsMatch(t.Name, "Sound|Chime", RegexOptions.IgnoreCase));
        }
        var banned = new Regex(@"chime|afplay|Glass\.aiff|PlaySound|MessageBeep|ringSound|RingSound", RegexOptions.IgnoreCase);
        var root = Path.Combine(RepoRoot(), "src");
        foreach (var file in Directory.EnumerateFiles(root, "*.*", SearchOption.AllDirectories)
                     .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}") && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
                     .Where(f => Path.GetExtension(f) is ".cs" or ".axaml" or ".csproj" or ".json" or ".plist" or ".sh" or ".iss"))
        {
            Assert.False(banned.IsMatch(File.ReadAllText(file)), $"{file} still has a sound in it");
        }
        Assert.False(File.Exists(Path.Combine(root, "RXVision.Agent", "Assets", "chime.wav")));
        Assert.False(File.Exists(Path.Combine(AppContext.BaseDirectory, "Assets", "chime.wav")));
    }

    [Fact]
    public void The_bubbles_old_ring_pulse_and_tooltip_are_gone()
    {
        var root = Path.Combine(RepoRoot(), "src", "RXVision.Agent");
        var xaml = File.ReadAllText(Path.Combine(root, "Views", "BubbleWindow.axaml"));
        foreach (var gone in new[] { "pulse", "wash", "ringlabel", "ToolTip", "agent-badge", "Animation" })
        {
            Assert.DoesNotContain(gone, xaml);
        }
        Assert.Null(typeof(BubbleViewModel).GetProperty("IsRinging"));
        Assert.Null(typeof(BubbleViewModel).GetProperty("RingLabel"));
    }

    [Fact]
    public void No_red_in_the_icons_code()
    {
        var root = Path.Combine(RepoRoot(), "src", "RXVision.Agent");
        var files = Directory.EnumerateFiles(Path.Combine(root, "Icon"))
            .Concat(new[]
            {
                "Views/BubbleWindow.axaml", "Views/BubbleWindow.axaml.cs", "Views/FloatingIconView.cs",
                "Views/HoverLabelWindow.axaml", "Views/HoverLabelWindow.axaml.cs",
                "Views/AlertCardsView.axaml", "Views/AlertCardsView.axaml.cs",
                "ViewModels/BubbleViewModel.cs", "ViewModels/AlertCard.cs",
                "Services/AlertCenter.cs", "Services/DayAlerts.cs",
            }.Select(f => Path.Combine(root, f)));
        var hex = new Regex(@"#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6})\b");
        var seen = 0;
        foreach (var file in files)
        {
            var text = File.ReadAllText(file);
            Assert.False(Regex.IsMatch(text, @"\bRed\b|Brush\.Red|Palette\.Red"), $"{file} names red");
            foreach (Match match in hex.Matches(text))
            {
                var c = Color.Parse(match.Value);
                var (hue, saturation) = new Rgba(c.R, c.G, c.B, 1).HueSaturation();
                Assert.False((hue >= 340 || hue <= 20) && saturation > 0.4, $"{file}: {match.Value}");
                seen++;
            }
        }
        Assert.True(seen > 20, "the scan found the colours");
    }

    [Fact]
    public void No_em_dash_in_the_icons_code()
    {
        var root = Path.Combine(RepoRoot(), "src", "RXVision.Agent");
        foreach (var file in Directory.EnumerateFiles(Path.Combine(root, "Icon")))
        {
            Assert.DoesNotContain("\u2014", File.ReadAllText(file));
        }
    }
}
