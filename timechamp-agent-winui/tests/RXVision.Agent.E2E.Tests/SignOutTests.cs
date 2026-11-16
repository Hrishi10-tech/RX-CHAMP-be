using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Workday;
using RXVision.Agent.ViewModels.Dialogs;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.E2E.Tests;

/// <summary>Sign-out and quit with an Admin's key (scenario 7).</summary>
public sealed class SignOutTests : E2ETest
{
    public SignOutTests(E2EFixture env, ITestOutputHelper output) : base(env, output) { }

    private async Task<string> KeyForAsync(string scope, params string[] userIds)
    {
        var created = await Env.Admin.PostAsync("signout-keys", scope == "ORG" ? new { scope } : new { scope, userIds });
        Assert.True(created.Ok, created.ToString());
        return created.Data.GetProperty("phrase").GetString()!;
    }

    private string[] LocalFiles(AgentRig rig) =>
        Directory.GetFiles(rig.DataDir).Select(Path.GetFileName).Where(n => n!.StartsWith("journal-") || n.StartsWith("state-") || n.StartsWith("queue-")).ToArray()!;

    [Fact]
    public async Task Sign_out_needs_everything_sent_then_the_right_key_and_only_then_clears_this_computer()
    {
        if (Skipped()) return;
        var rig = await AgentForAsync("Tara", "Joseph");
        Assert.IsType<StartDayOutcome.Started>(await rig.Agent.StartDayAsync());
        await rig.WaitSyncedAsync();
        await rig.Ui.Run(rig.Dashboard.Refresh);
        Assert.False(rig.Actions.CanQuit);       // staff never get Quit
        Assert.False(rig.Dashboard.CanQuit);
        var key = await KeyForAsync("USERS", rig.Person.Id);
        Say($"key issued ({key.Split(' ').Length} words)");

        // Offline with an action waiting: nothing is asked of the server, nothing is cleared.
        rig.Relay.GoOffline();
        Assert.IsType<ActionOutcome.Done>(await rig.Agent.QuickBreakAsync(5));
        Assert.Equal(1, rig.Host.PendingActions);
        var notSynced = Assert.IsType<KeyOutcome.NotSynced>(await rig.Agent.SignOutWithKeyAsync(key));
        Assert.Equal(1, notSynced.Actions);
        Say($"offline: {notSynced.Message}");
        Assert.Equal(0, rig.Http.Count("POST", "/agent/sign-out"));
        Assert.Equal(AgentState.Running, rig.Host.State);
        Assert.NotEmpty(LocalFiles(rig));
        // The sign-out flow says so too: "Syncing 1 action…", then "Can't sign out yet".
        rig.Dialogs.Answer(d => Assert.IsType<MessageDialogViewModel>(d).Title == "Sign out of RX Vision?");
        rig.Dialogs.Wait();
        rig.Dialogs.Answer(_ => true);
        await rig.Ui.RunAsync(rig.Actions.SignOutAsync);
        Assert.Equal("Syncing 1 action…", Assert.Single(rig.Dialogs.Shown.OfType<ProgressDialogViewModel>()).Title);
        var cannot = rig.Dialogs.Last<MessageDialogViewModel>()!;
        Assert.Equal("Can't sign out yet", cannot.Title);
        Say($"offline sign-out: {cannot.Message}");
        Assert.Equal(0, rig.Http.Count("POST", "/agent/sign-out"));
        Assert.NotEmpty(LocalFiles(rig));

        rig.Relay.GoOnline();
        await rig.WaitSyncedAsync(TimeSpan.FromMinutes(2));
        Assert.IsType<EndOutcome.Ended>(await rig.Agent.BackToWorkAsync());
        await rig.WaitSyncedAsync();

        // Online, everything sent: the key is asked for; a wrong one is said, the right one signs out.
        rig.Dialogs.Answer(d => Assert.IsType<MessageDialogViewModel>(d).Title == "Sign out of RX Vision?");
        rig.Dialogs.Answer(d =>
        {
            var k = Assert.IsType<KeyDialogViewModel>(d);
            k.Key = "  Amber   ORBIT cedar river lamp 42 ";   // not this person's key
            return true;
        });
        string? wrongKeyError = null;
        rig.Dialogs.Answer(d =>
        {
            var k = Assert.IsType<KeyDialogViewModel>(d);
            wrongKeyError = k.Error;
            k.Key = key.ToUpperInvariant().Replace(" ", "   ");   // as pasted, any case and spacing
            return true;
        });
        await rig.Ui.RunAsync(rig.Actions.SignOutAsync);
        Assert.Equal("That key isn't valid for you. Check it with your admin (keys work for 24 hours).", wrongKeyError);
        Assert.Equal(2, rig.Http.Count("POST", "/agent/sign-out"));
        Assert.Equal(1, rig.Http.Count("POST", "/agent/sign-out", 403));
        Assert.Equal(1, rig.Http.Count("POST", "/agent/sign-out", 200));
        Assert.Equal(AgentState.SignIn, rig.Host.State);
        // Everything reached the server before the key was even asked for.
        var lastAction = rig.Http.Calls.Last(c => c.EventId is not null && c.Status == 200).At;
        Assert.True(rig.Http.Calls.First(c => c.Path.EndsWith("/agent/sign-out", StringComparison.Ordinal)).At > lastAction);
        Assert.Empty(LocalFiles(rig));
        using var server = await Portal.SignInAsync(rig.Person.Email, rig.Person.Password, AgentUserAgent);
        // The quick break taken offline reached the server before the data went.
        var quick = Assert.Single((await server.GetAsync("breaks/me/today")).Data.GetProperty("quick").EnumerateArray());
        Assert.NotEqual(System.Text.Json.JsonValueKind.Null, quick.GetProperty("endedAt").ValueKind);
    }

    [Fact]
    public async Task Five_wrong_keys_lock_sign_out_for_ten_minutes()
    {
        if (Skipped()) return;
        var rig = await AgentForAsync("Vivek", "Rao");
        var key = await KeyForAsync("USERS", rig.Person.Id);
        for (var i = 1; i <= 5; i++)
        {
            var wrong = Assert.IsType<KeyOutcome.WrongKey>(await rig.Agent.SignOutWithKeyAsync($"wrong key number {i} here"));
            Assert.Contains("isn't valid", wrong.Message);
        }
        var locked = Assert.IsType<KeyOutcome.TooManyTries>(await rig.Agent.SignOutWithKeyAsync("wrong key number six"));
        Say($"after five wrong keys: {locked.Message}");
        // The right key now waits too, and the dialog says so.
        Assert.IsType<KeyOutcome.TooManyTries>(await rig.Agent.SignOutWithKeyAsync(key));
        rig.Dialogs.Answer(_ => true);
        rig.Dialogs.Answer(d => { ((KeyDialogViewModel)d).Key = key; return true; });
        rig.Dialogs.Answer(_ => true);
        await rig.Ui.RunAsync(rig.Actions.SignOutAsync);
        var alert = rig.Dialogs.Last<MessageDialogViewModel>()!;
        Assert.Equal("Too many tries", alert.Title);
        Assert.Contains("minute", alert.Message);
        Assert.Equal(5, rig.Http.Count("POST", "/agent/sign-out", 403));
        Assert.Equal(3, rig.Http.Count("POST", "/agent/sign-out", 429));
        Assert.NotEqual(AgentState.SignIn, rig.Host.State);
        Assert.NotEmpty(LocalFiles(rig));
    }

    [Fact]
    public async Task An_admin_quits_with_a_key_and_staff_cannot()
    {
        if (Skipped()) return;
        var admin = await AgentForAsync(new Person(Env.Admin.Id, "orgadmin@timechamp.test", "orgadmin123", "Anita", "Menon"));
        await admin.Ui.Run(admin.Dashboard.Refresh);
        Assert.True(admin.Actions.CanQuit);
        Assert.True(admin.Dashboard.CanQuit);
        var key = await KeyForAsync("ORG");

        Assert.IsType<KeyOutcome.WrongKey>(await admin.Agent.QuitCheckAsync("not the key at all"));
        var exited = false;
        admin.Dialogs.Answer(d => { ((KeyDialogViewModel)d).Key = "still not the key"; return true; });
        string? error = null;
        admin.Dialogs.Answer(d => { var k = (KeyDialogViewModel)d; error = k.Error; k.Key = key; return true; });
        await admin.Ui.RunAsync(() => admin.Actions.QuitAsync(() => { exited = true; return Task.CompletedTask; }));
        Assert.True(exited, "the app may quit");
        Assert.NotNull(error);
        Assert.Equal(1, admin.Http.Count("POST", "/agent/quit-check", 200));
        Assert.Equal(2, admin.Http.Count("POST", "/agent/quit-check", 403));
        // Quitting signs nobody out and clears nothing.
        Assert.NotEqual(AgentState.SignIn, admin.Host.State);

        // Staff are never offered Quit, and the server refuses them anyway.
        var staff = await AgentForAsync("Kabir", "Singh");
        Assert.False(staff.Actions.CanQuit);
        using var device = await Portal.SignInAsync(staff.Person.Email, staff.Person.Password, AgentUserAgent);
        var refused = await device.PostAsync("agent/quit-check", new { key });
        Assert.Equal((403, "QUIT_NOT_ALLOWED"), (refused.Status, refused.Code));
    }
}
