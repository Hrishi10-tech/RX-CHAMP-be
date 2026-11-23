using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Shapes;
using Avalonia.Headless.XUnit;
using Avalonia.Layout;
using Avalonia.Media;
using RXVision.Agent.Converters;
using RXVision.Agent.ViewModels;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// The UI kit's component sheets: every style class of Styles/Controls.axaml and every icon of
/// Styles/Theme.axaml, drawn by the app's own theme on the panel colour. Pictures for the kit,
/// and a check that each class still draws.
/// </summary>
public class UiKitShotTests
{
    private static IBrush Res(string key) => (IBrush)Application.Current!.FindResource(key)!;

    private static TextBlock Caption(string text) => new()
    {
        Text = text, FontSize = 11, Foreground = Res("Brush.Neutral"), Margin = new Thickness(0, 6, 0, 0),
        HorizontalAlignment = HorizontalAlignment.Left,
    };

    private static StackPanel Item(Control control, string caption, double width = 0)
    {
        var s = new StackPanel { Spacing = 0, Margin = new Thickness(0, 0, 18, 18) };
        if (width > 0) s.Width = width;
        s.Children.Add(control);
        s.Children.Add(Caption(caption));
        return s;
    }

    private static PathIcon Icon(string key, double size = 17) => new()
    {
        Data = (Geometry)Application.Current!.FindResource("Icon." + key)!, Width = size, Height = size, Classes = { "i" },
    };

    private static Button Btn(string classes, object content, bool enabled = true, double width = double.NaN)
    {
        var b = new Button { Content = content, IsEnabled = enabled, Width = width };
        foreach (var c in classes.Split(' ', StringSplitOptions.RemoveEmptyEntries)) b.Classes.Add(c);
        return b;
    }

    private static Border Box(string classes, Control child, double width = double.NaN)
    {
        var b = new Border { Child = child, Width = width };
        foreach (var c in classes.Split(' ', StringSplitOptions.RemoveEmptyEntries)) b.Classes.Add(c);
        return b;
    }

    private static TextBlock T(string classes, string text, double width = double.NaN)
    {
        var t = new TextBlock { Text = text, Width = width, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Left, HorizontalAlignment = HorizontalAlignment.Left };
        foreach (var c in classes.Split(' ', StringSplitOptions.RemoveEmptyEntries)) t.Classes.Add(c);
        return t;
    }

    private static StackPanel Row(params Control[] items) => Spaced(0, items);

    private static StackPanel Spaced(double spacing, params Control[] items)
    {
        var p = new StackPanel { Orientation = Orientation.Horizontal, Spacing = spacing };
        foreach (var i in items) p.Children.Add(i);
        return p;
    }

    private static Control Heading(string text) => new TextBlock
    {
        Text = text, FontSize = 12, FontWeight = FontWeight.SemiBold, Foreground = Res("Brush.Brand"),
        Margin = new Thickness(0, 4, 0, 12),
    };

    private static void Shoot(string name, double width, params Control[] rows)
    {
        var stack = new StackPanel { Margin = new Thickness(28, 24) };
        foreach (var r in rows) stack.Children.Add(r);
        var window = new Window
        {
            Width = width, SizeToContent = SizeToContent.Height, Background = Res("Brush.Panel"),
            Content = stack, SystemDecorations = SystemDecorations.None,
        };
        window.Show();
        var path = Shots.Save(window, name);
        Assert.True(new FileInfo(path).Length > 5_000, $"{name} looks empty");
        window.Close();
    }

    private static Control WithIcon(string icon, string text)
    {
        var p = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
        p.Children.Add(Icon(icon));
        p.Children.Add(new TextBlock { Text = text, VerticalAlignment = VerticalAlignment.Center });
        return p;
    }

    [AvaloniaFact]
    public void Buttons()
    {
        Shoot("kit-buttons", 1000,
            Heading("Actions"),
            Row(Item(Btn("primary", "Start day", width: 220), "Button.primary"),
                Item(Btn("primary", "Start day", enabled: false, width: 220), "Button.primary, disabled"),
                Item(Btn("secondary", "End day", width: 220), "Button.secondary")),
            Row(Item(Btn("soft", "Cancel leave"), "Button.soft"),
                Item(Btn("quiet", "Not now"), "Button.quiet"),
                Item(Btn("link", "Try again"), "Button.link"),
                Item(Btn("ghost", Icon("ChevronLeft", 16)), "Button.ghost"),
                Item(Btn("send", Icon("Send", 16)), "Button.send")),
            Heading("Choices"),
            Row(Item(Btn("chip", "Teams call"), "Button.chip"),
                Item(Btn("chip on", "Client call"), "Button.chip.on"),
                Item(Btn("chip small", "15 min"), "Button.chip.small"),
                Item(Btn("chip suggest", "Start meeting?"), "Button.chip.suggest"),
                Item(Btn("chip", "Disabled", enabled: false), "Button.chip, disabled")),
            Heading("Navigation"),
            Row(Item(Spaced(14, Btn("paneltab on", "Today"), Btn("paneltab", "Messages"), Btn("paneltab", "Profile")), "Button.paneltab, .on", 300),
                Item(Box("tabs", Row(Btn("tab on", "Formal", width: 110), Btn("tab", "Casual", width: 110), Btn("tab", "Smart", width: 110))), "Border.tabs, Button.tab, .on")),
            Row(Item(Btn("menuitem", WithIcon("History", "History"), width: 300), "Button.menuitem", 300),
                Item(Btn("menuitem", WithIcon("Calendar", "My calendar"), width: 300), "Button.menuitem", 300)));
    }

    [AvaloniaFact]
    public void Type()
    {
        Shoot("kit-type", 1000,
            Heading("Type: Inter, the panel's text styles"),
            Item(T("h1", "Good morning, Asha"), "TextBlock.h1  22 bold"),
            Item(T("h2", "October 2026"), "TextBlock.h2  18 bold"),
            Item(T("status", "Working"), "TextBlock.status  15 bold"),
            Item(T("progressline", "4h 12m of 8h"), "TextBlock.progressline  15 bold"),
            Item(T("lead", "Sign in with the details your admin sent you.", 600), "TextBlock.lead  15, quiet"),
            Item(T("title", "Today's breaks"), "TextBlock.title  13 semibold"),
            Item(T("label", "Work email"), "TextBlock.label  13 semibold"),
            Item(T("body", "Your focus time keeps counting in a meeting. Breaks pause it.", 600), "TextBlock.body  13, line 19, quiet"),
            Item(T("muted", "Nothing recorded yet this month."), "TextBlock.muted  13, quiet"),
            Item(T("small", "General · 9:30 AM - 6:30 PM"), "TextBlock.small  12, quiet"),
            Item(T("small attention", "2 min left on your break"), "TextBlock.small.attention  12, amber"),
            Item(T("error", "Check your email and password, then try again."), "TextBlock.error  13, amber, never red"),
            Item(T("num", "62h 50m · 8h 31m · 10:20 AM"), "TextBlock.num  tabular figures"));
    }

    [AvaloniaFact]
    public void Surfaces()
    {
        Border Chip(Tone tone, string text) => PillOf(tone, text);
        Shoot("kit-surfaces", 1000,
            Heading("Containers"),
            Row(Item(Box("card", T("muted", "Border.card: pages and lists. Fill #222937, border #3A4356, radius 16."), 290), "Border.card"),
                Item(Box("alertcard", T("muted", "Border.alertcard: an alert over Today, radius 16."), 290), "Border.alertcard"),
                Item(Box("banner warn", T("small attention", "Border.banner.warn: something needs a look, in amber."), 290), "Border.banner.warn")),
            Row(Item(Box("note", T("", "Border.note: neutral information, radius 12."), 290), "Border.note"),
                Item(Box("problem", T("", "Border.problem: try again in a moment."), 290), "Border.problem"),
                Item(Box("commentcard", T("muted", "Border.commentcard: a skipped break's comment."), 290), "Border.commentcard")),
            Heading("Chips and status"),
            Row(Item(Chip(Tone.Good, "Full day"), "Tone.Good: brand wash"),
                Item(Chip(Tone.Warn, "Half day"), "Tone.Warn: amber wash"),
                Item(Chip(Tone.Neutral, "Day off"), "Tone.Neutral"),
                Item(Chip(Tone.Due, "Due"), "Tone.Due: amber"),
                Item(Box("nowpill", new TextBlock { Text = "Now" }), "Border.nowpill"),
                Item(Box("pausedpill", new TextBlock { Text = "Paused" }), "Border.pausedpill")),
            Row(Item(Dot("Brush.Working"), "Working #34D27A"),
                Item(Dot("Brush.Meeting"), "Meeting #A78BFA"),
                Item(Dot("Brush.Amber"), "On break #F2A93B"),
                Item(Dot("Brush.Neutral"), "Not started #8A93A3"),
                Item(Box("iconcircle", Icon("Coffee", 18)), "Border.iconcircle"),
                Item(Box("iconcircle amber", Icon("Clock", 18)), "Border.iconcircle.amber")),
            Heading("Fields"),
            Row(Item(new TextBox { Classes = { "field" }, Width = 290, Watermark = "you@company.com" }, "TextBox.field, empty"),
                Item(new TextBox { Classes = { "field" }, Width = 290, Text = "asha@timechamp.test" }, "TextBox.field"),
                Item(new TextBox { Classes = { "chatinput" }, Width = 290, Watermark = "Write a message" }, "TextBox.chatinput")),
            // People: initials (Border.avatar) until the avatars stream brings the pictures.
            Heading("People"),
            Row(Item(Box("avatar", new TextBlock { Text = "AK" }), "Border.avatar, initials")));
    }

    private static Ellipse Dot(string brush) => new() { Width = 10, Height = 10, Fill = Res(brush), HorizontalAlignment = HorizontalAlignment.Left };

    private static Border PillOf(Tone tone, string text)
    {
        var inv = System.Globalization.CultureInfo.InvariantCulture;
        var b = new Border
        {
            HorizontalAlignment = HorizontalAlignment.Left,
            Background = (IBrush)ToneBackgroundConverter.Instance.Convert(tone, typeof(IBrush), null, inv)!,
            Child = new TextBlock { Text = text, Foreground = (IBrush)ToneForegroundConverter.Instance.Convert(tone, typeof(IBrush), null, inv)! },
        };
        b.Classes.Add("pill");
        return b;
    }

    [AvaloniaFact]
    public void Icons()
    {
        var names = new[]
        {
            "Coffee", "Lunch", "Focus", "Meeting", "Clock", "Power", "Play", "CheckCircle", "Check", "SignOut", "Chat", "Send",
            "Bell", "Close", "Download", "Warning", "Info", "Shield", "Camera", "Globe", "Moon", "Mail", "Server", "Menu",
            "Home", "Book", "ChevronLeft", "ChevronDown", "ChevronRight", "Person", "History", "Calendar", "Spark", "Spinner",
        };
        var grid = new WrapPanel();
        foreach (var n in names)
        {
            var cell = new StackPanel { Width = 104, Margin = new Thickness(0, 0, 8, 16), Spacing = 8 };
            cell.Children.Add(new Border
            {
                Width = 48, Height = 48, CornerRadius = new CornerRadius(12), Background = Res("Brush.Card"),
                HorizontalAlignment = HorizontalAlignment.Left, Child = Icon(n, 22),
            });
            cell.Children.Add(new TextBlock { Text = n, FontSize = 11.5, Foreground = Res("Brush.TextQuiet") });
            grid.Children.Add(cell);
        }
        Shoot("kit-icons", 1000, Heading("Icons: 24 px grid, stroke 2, round caps and joins (Styles/Theme.axaml)"), grid);
    }
}
