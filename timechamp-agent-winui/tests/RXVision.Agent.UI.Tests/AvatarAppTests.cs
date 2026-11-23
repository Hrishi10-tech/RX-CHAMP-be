using System.Net;
using System.Text;
using System.Text.Json;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Headless.XUnit;
using Avalonia.Threading;
using Avalonia.VisualTree;
using RXVision.Agent.Controls;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Avatars;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using Xunit;

namespace RXVision.Agent.UI.Tests;

/// <summary>
/// The whole app headless: the real AppController, AgentFacade and AgentHost over a scripted
/// transport. What only the wiring proves: a save reaches the icon's window at once, an offline
/// start draws the icon from the bundle, the picker sits beside the icon and goes away cleanly.
/// </summary>
public sealed class AvatarAppTests : IDisposable
{
    private const string Base = "https://api.rxv.invalid/api/v1";

    private readonly string _dir = Directory.CreateTempSubdirectory("rxv-avatar-app-").FullName;
    private readonly List<AppController> _apps = new();
    private readonly List<AgentHost> _hosts = new();

    /// <summary>Just enough of the API, keeping the person's avatar as the server would. A PUT can be held back.</summary>
    private sealed class Server : HttpMessageHandler
    {
        private readonly object _gate = new();
        public string? AvatarId { get; set; } = "M01";
        public string? Library { get; set; } = "male";
        public TaskCompletionSource? HoldPut { get; set; }
        public bool Offline { get; set; }
        public List<string> Calls { get; } = new();

        private object Mine => new
        {
            avatarId = AvatarId,
            chosenAvatarId = AvatarId == "M01" ? null : AvatarId,
            defaultAvatarId = Library is null ? null : Library == "male" ? "M01" : "F01",
            library = Library,
        };

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var path = request.RequestUri!.AbsolutePath.Replace("/api/v1/", "");
            var key = $"{request.Method.Method} {path}";
            lock (_gate) Calls.Add(key);
            if (Offline) throw new HttpRequestException("offline");
            switch (key)
            {
                case "POST auth/login":
                    var ok = Json(new { user = new { id = "u-1", email = "asha@x.test", firstName = "Asha", lastName = "Kumar", role = "USER", screenshotsEnabled = false, avatarId = AvatarId } });
                    ok.Headers.Add("Set-Cookie", "accessToken=at; Path=/api/v1; HttpOnly");
                    ok.Headers.Add("Set-Cookie", "refreshToken=rt; Path=/api/v1/auth; HttpOnly");
                    return ok;
                case "GET me/avatar":
                    return Json(Mine);
                case "PUT me/avatar":
                    var body = await request.Content!.ReadAsStringAsync(ct);
                    if (HoldPut is { } hold) await hold.Task;
                    AvatarId = JsonDocument.Parse(body).RootElement.GetProperty("avatarId").GetString();
                    return Json(Mine);
                case "DELETE me/avatar":
                    AvatarId = "M01";
                    return Json(Mine);
                case "GET me/day-progress":
                    return Json(new { status = "NOT_STARTED", date = "2026-11-06", workedSec = 0, targetSec = 28800, overSec = 0 });
                case "GET workday/me/today":
                    return Json(new { date = "2026-11-06", serverNow = DateTimeOffset.UtcNow.ToString("o"), timezone = "Asia/Kolkata", state = "NOT_STARTED", focus = new { focusSec = 0, running = false }, expectedSec = 28800, settings = new { approvalSlaHours = 48, reasonMinChars = 10 }, attendance = new { source = "AGENT" } });
                case "GET breaks/me/today":
                    return Json(new { date = "2026-11-06", mode = "FREE", workday = true });
                case "GET presence/me/current":
                    return Json(new { status = "NOT_STARTED" });
                case "GET presence/me/today":
                    return Json(new { date = "2026-11-06", totals = new { breakSec = 0 } });
                case "GET chat/contacts":
                    return Json(Array.Empty<object>());
                case "GET chat/unread":
                    return Json(new { count = 0 });
                case "GET meetings/me/today":
                case "GET approvals/me":
                    return Json(new { items = Array.Empty<object>() });
                case "POST auth/logout":
                    return Json(new { ok = true });
                default:
                    return new HttpResponseMessage(HttpStatusCode.NotFound)
                    {
                        Content = new StringContent(JsonSerializer.Serialize(new { success = false, message = "Not found", error = new { code = "NOT_FOUND", message = "Not found" } }), Encoding.UTF8, "application/json"),
                    };
            }
        }

        private static HttpResponseMessage Json(object? data) => new(HttpStatusCode.OK)
        {
            Content = new StringContent(JsonSerializer.Serialize(new { success = true, data }), Encoding.UTF8, "application/json"),
        };
    }

    private (AppController App, AgentHost Host, DevPlatform Platform) Build(Server server)
    {
        var platform = new DevPlatform(_dir);
        // The monitoring notice was read on an earlier day.
        File.WriteAllText(Path.Combine(platform.DataDir, "notice-u1.txt"), "ok");
        var options = new AgentOptions { ApiBaseUrl = Base, AutoUpdate = false }.Normalised();
        var host = new AgentHost(platform, options, NullLog.Instance, server);
        var app = new AppController(new ClassicDesktopStyleApplicationLifetime { ShutdownMode = ShutdownMode.OnExplicitShutdown }, new StartupContext(platform, options, NullLog.Instance, host, null, true));
        _apps.Add(app);
        _hosts.Add(host);
        return (app, host, platform);
    }

    private static async Task WaitFor(Func<bool> condition, string what, int seconds = 8)
    {
        var until = DateTime.UtcNow.AddSeconds(seconds);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < until, $"timed out waiting for {what}");
            Dispatcher.UIThread.RunJobs();
            await Task.Delay(15);
        }
    }

    /// <summary>What the icon draws: its bitmap comes from here (<see cref="FloatingIconView"/>).</summary>
    private static AvatarIconSource IconFace(AppController app) =>
        (AvatarIconSource)((BubbleViewModel)app.Bubble!.DataContext!).Avatars;

    private async Task<AppController> SignedIn(Server server)
    {
        var (app, host, _) = Build(server);
        app.Start();
        await WaitFor(() => host.State == AgentState.SignIn, "the sign-in state");
        Assert.Null(await host.SignInAsync("asha@x.test", "pw"));
        await WaitFor(() => app.Bubble is { IsVisible: true }, "the icon");
        await WaitFor(() => IconFace(app).AvatarId == AvatarChoice.Shown(server.AvatarId), "the icon's avatar");
        return app;
    }

    private static AvatarPickerViewModel OpenPicker(AppController app)
    {
        app.Dashboard.ShowProfileCommand.Execute(null);
        app.Dashboard.Profile.OpenAvatarCommand.Execute(null);
        Assert.NotNull(app.AvatarPicker);
        return (AvatarPickerViewModel)app.AvatarPicker!.DataContext!;
    }

    [AvaloniaFact]
    public async Task A_save_from_the_picker_reaches_the_floating_icon_before_the_server_has_answered()
    {
        var server = new Server();
        var app = await SignedIn(server);
        var vm = OpenPicker(app);
        await WaitFor(() => vm.Tiles.Count == 25, "the grid");
        Assert.True(app.AvatarPicker!.IsVisible);

        vm.Tiles[11].PickCommand.Execute(null);
        Assert.Null(IconFace(app).AvatarId);

        var hold = new TaskCompletionSource();
        server.HoldPut = hold;
        var saving = vm.SaveCommand.ExecuteAsync(null);
        await WaitFor(() => IconFace(app).AvatarId == "M12", "the icon to take the save");
        Assert.Equal("M01", server.AvatarId);
        Assert.False(saving.IsCompleted);

        hold.SetResult();
        server.HoldPut = null;
        await saving;
        Assert.Equal("M12", server.AvatarId);
        Dispatcher.UIThread.RunJobs();
        Assert.Equal("M12", IconFace(app).AvatarId);
        Assert.Equal("M12", app.Dashboard.Profile.AvatarId);

        // Nothing here ever asked the server for a picture.
        Assert.DoesNotContain(server.Calls, c => c.Contains("avatars", StringComparison.Ordinal));
    }

    [AvaloniaFact]
    public async Task On_the_default_the_icon_shows_the_RX_mark_and_choosing_it_again_clears_a_choice()
    {
        var server = new Server();
        var app = await SignedIn(server);
        Assert.Null(IconFace(app).AvatarId);
        var vm = OpenPicker(app);
        await WaitFor(() => vm.Tiles.Count == 25, "the grid");
        Assert.True(vm.IsMarkSelected);
        vm.Tiles[11].PickCommand.Execute(null);
        await vm.SaveCommand.ExecuteAsync(null);
        await WaitFor(() => IconFace(app).AvatarId == "M12", "the icon to take the save");

        vm.PickMarkCommand.Execute(null);
        await vm.SaveCommand.ExecuteAsync(null);
        Dispatcher.UIThread.RunJobs();
        Assert.Contains("DELETE me/avatar", server.Calls);
        Assert.Null(IconFace(app).AvatarId);
        Assert.Null(app.Dashboard.Profile.AvatarId);
        Assert.True(vm.IsMarkSelected);
    }

    [AvaloniaFact]
    public async Task The_picker_sits_beside_the_icon_with_its_gap_and_bottoms_aligned()
    {
        var app = await SignedIn(new Server());
        OpenPicker(app);
        var picker = app.AvatarPicker!;
        var scale = picker.DesktopScaling;
        var anchor = app.Bubble!.Anchor;
        var half = (int)Math.Round(28 * scale);
        Assert.Equal(anchor.Y + half - (int)Math.Ceiling(630 * scale), picker.Position.Y);
        Assert.Equal(anchor.X - half - (int)Math.Round(16 * scale) - (int)Math.Ceiling(396 * scale), picker.Position.X);
    }

    [AvaloniaFact]
    public async Task Close_goes_away_and_back_returns_to_profile()
    {
        var app = await SignedIn(new Server());
        var vm = OpenPicker(app);
        vm.CloseCommand.Execute(null);
        Assert.Null(app.AvatarPicker);

        vm = OpenPicker(app);
        app.Dashboard.ShowDashboardCommand.Execute(null);
        vm.BackCommand.Execute(null);
        Assert.Null(app.AvatarPicker);
        Assert.True(app.Dashboard.IsProfileTab);
    }

    [AvaloniaFact]
    public async Task Closed_by_the_os_it_lets_go_and_opens_again()
    {
        var app = await SignedIn(new Server());
        var vm = OpenPicker(app);
        app.AvatarPicker!.Close();
        Assert.Null(app.AvatarPicker);
        Assert.NotSame(vm, OpenPicker(app));
    }

    [AvaloniaFact]
    public async Task Opening_it_again_comes_back_to_the_same_window()
    {
        var app = await SignedIn(new Server());
        OpenPicker(app);
        var window = app.AvatarPicker;
        app.Dashboard.Profile.OpenAvatarCommand.Execute(null);
        Assert.Same(window, app.AvatarPicker);
    }

    [AvaloniaFact]
    public async Task Signing_out_takes_the_picker_and_the_person_away()
    {
        var server = new Server();
        var app = await SignedIn(server);
        OpenPicker(app);
        var host = _hosts.Single();
        // Internal to the core: the sign-out a key or a lost session ends in.
        await (Task)typeof(AgentHost).GetMethod("SignOutAsync", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!.Invoke(host, null)!;
        await WaitFor(() => host.State == AgentState.SignIn && app.AvatarPicker is null, "the picker to go");
        Assert.False(app.Bubble!.IsVisible);
    }

    [AvaloniaFact]
    public async Task With_no_gender_the_icon_shows_the_RX_mark_and_the_picker_the_calm_line()
    {
        var server = new Server { AvatarId = null, Library = null };
        var (app, host, _) = Build(server);
        app.Start();
        await WaitFor(() => host.State == AgentState.SignIn, "the sign-in state");
        Assert.Null(await host.SignInAsync("asha@x.test", "pw"));
        await WaitFor(() => app.Bubble is { IsVisible: true }, "the icon");
        Dispatcher.UIThread.RunJobs();
        var face = IconFace(app);
        Assert.Null(face.AvatarId);
        Assert.Null(face.Picture(42));
        var vm = OpenPicker(app);
        await WaitFor(() => vm.HasNoLibrary && vm.StatusLabel is not null, "the calm line");
        Assert.Empty(vm.Tiles);
    }

    [AvaloniaFact]
    public async Task A_start_with_no_network_shows_the_icon_with_the_saved_avatar_from_the_bundle()
    {
        var server = new Server { Offline = true };
        var (app, host, platform) = Build(server);
        new SessionStore(platform.Secrets).Save(new SavedSession
        {
            ApiBaseUrl = Base, RefreshToken = "rt", UserId = "u-1", Email = "deepa@x.test", DisplayName = "Deepa Rao", Role = "USER", AvatarId = "F40",
        });
        app.Start();
        // 4.0 is offline first: the saved session restores without the server (3.6 waited in Connecting).
        await WaitFor(() => host.State is AgentState.NotStarted or AgentState.Running or AgentState.DayEnded, "the restored session");
        await WaitFor(() => app.Bubble is { IsVisible: true }, "the icon");
        var face = IconFace(app);
        Assert.Equal("F40", face.AvatarId);
        Assert.NotNull(AvatarImages.Shared.Get("F40", 84));
        Assert.DoesNotContain(server.Calls, c => c.Contains("avatars", StringComparison.Ordinal));
        Shots.Save(app.Bubble!, "avatar-offline-start-icon");
    }

    [AvaloniaFact]
    public async Task A_start_with_no_network_and_nobody_saved_keeps_the_icon_away()
    {
        var server = new Server { Offline = true };
        var (app, host, _) = Build(server);
        app.Start();
        await WaitFor(() => host.State == AgentState.SignIn, "the sign-in state");
        Dispatcher.UIThread.RunJobs();
        Assert.Null(app.Bubble);
    }

    public void Dispose()
    {
        foreach (var app in _apps) app.Dispose();
        foreach (var host in _hosts) host.Dispose();
        try { Directory.Delete(_dir, recursive: true); }
        catch (IOException) { }
    }
}
