using System.Text.Json;
using RXVision.Agent.Core;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Avatars;
using RXVision.Agent.Services;
using RXVision.Agent.ViewModels;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.E2E.Tests;

/// <summary>
/// The avatar picker and the icon's person against the real server: the agent's own client, view
/// models and socket. What the server has is read back on a second device, independently of the agent.
/// </summary>
public sealed class AvatarTests : E2ETest
{
    public AvatarTests(E2EFixture env, ITestOutputHelper output) : base(env, output) { }

    private static readonly TimeSpan Seconds = TimeSpan.FromSeconds(10);

    /// <summary>A new person with this gender (none: null), reporting to the seeded manager, signed in on their agent.</summary>
    private async Task<AgentRig> PersonAsync(string first, string? gender, string role = "USER")
    {
        var email = $"{first.ToLowerInvariant()}.{Guid.NewGuid():N}@agent-e2e.test";
        var data = await Env.SuperAdmin.MustAsync(HttpMethod.Post, "users", gender is null
            ? new { firstName = first, lastName = "Avatar", email, password = PortalSetup.Password, role, managerId = Env.Manager.Id }
            : new { firstName = first, lastName = "Avatar", email, password = PortalSetup.Password, role, managerId = Env.Manager.Id, gender } as object);
        var id = data.GetProperty("created").EnumerateArray().Single().GetProperty("id").GetString()!;
        var rig = await AgentRig.CreateAsync(new Person(id, email, PortalSetup.Password, first, "Avatar"));
        Track(rig);
        await rig.SignInAsync();
        await E2EEnv.WaitFor(() => rig.Agent.Avatars.Mine is not null, Seconds, "the first read of /me/avatar");
        return rig;
    }

    private static Task<AvatarPickerViewModel> PickerAsync(AgentRig rig) =>
        rig.Ui.RunAsync(async () =>
        {
            var vm = new AvatarPickerViewModel(rig.Agent, rig.Log);
            await vm.OpenAsync();
            return vm;
        });

    private static async Task<JsonElement> ServerAvatarAsync(Portal device)
    {
        var a = await device.GetAsync("me/avatar");
        Assert.True(a.Ok, a.ToString());
        return a.Data;
    }

    private static string? Text(JsonElement data, string name) =>
        data.GetProperty(name).ValueKind == JsonValueKind.Null ? null : data.GetProperty(name).GetString();

    // ---- The picker's flows -------------------------------------------------------------------------

    [Fact]
    public async Task The_picker_offers_the_RX_logo_and_their_own_library_saves_goes_back_and_the_server_keeps_only_the_id()
    {
        if (Skipped()) return;
        var rig = await PersonAsync("Arjun", "MALE");
        var device = await ServerViewAsync(rig.Person);
        var vm = await PickerAsync(rig);

        // Nothing chosen: the RX logo (D-85), and only the male library.
        Assert.Null(vm.PreviewId);
        Assert.True(vm.IsMarkSelected);
        Assert.Equal("75 male avatars", vm.CountText);
        Assert.Equal(new[] { "Formal", "Casual", "Smart" }, vm.Sets.Select(s => s.Label));
        Assert.Equal(25, vm.Tiles.Count);
        Assert.All(vm.Tiles, t => Assert.StartsWith("M", t.Id));

        // Tapping asks nothing of the server.
        await rig.Ui.Run(() => vm.Tiles[11].PickCommand.Execute(null));
        Assert.Null(rig.Agent.Avatars.ShownId);
        Assert.Equal("M01", Text(await ServerAvatarAsync(device), "avatarId"));

        // Save: there, by ID.
        await rig.Ui.RunAsync(async () => { await vm.SaveCommand.ExecuteAsync(null); return true; });
        Assert.Null(vm.Error);
        var saved = await ServerAvatarAsync(device);
        Assert.Equal("M12", Text(saved, "avatarId"));
        Assert.Equal("M12", Text(saved, "chosenAvatarId"));
        Assert.Equal("male", Text(saved, "library"));
        Assert.Equal("M12", rig.Agent.Avatars.ShownId);

        // The RX logo again: nothing stored, the server's own default behind it.
        await rig.Ui.Run(() => vm.PickMarkCommand.Execute(null));
        await rig.Ui.RunAsync(async () => { await vm.SaveCommand.ExecuteAsync(null); return true; });
        var reset = await ServerAvatarAsync(device);
        Assert.Equal("M01", Text(reset, "avatarId"));
        Assert.Null(Text(reset, "chosenAvatarId"));
        Assert.Null(vm.PreviewId);
        Assert.Null(rig.Agent.Avatars.ShownId);

        // A person's record carries the ID and no picture.
        var record = await Env.SuperAdmin.MustAsync(HttpMethod.Get, "users/" + rig.Person.Id);
        Assert.Equal("M01", record.GetProperty("avatarId").GetString());
        Assert.DoesNotContain("avatarUrl", record.GetRawText(), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("photo", record.GetRawText(), StringComparison.OrdinalIgnoreCase);

        await rig.Ui.Run(vm.Closed);
    }

    [Fact]
    public async Task A_female_person_sees_the_female_library()
    {
        if (Skipped()) return;
        var rig = await PersonAsync("Meera", "FEMALE");
        var vm = await PickerAsync(rig);
        Assert.Equal("75 female avatars", vm.CountText);
        Assert.Null(vm.PreviewId);
        Assert.All(vm.Tiles, t => Assert.StartsWith("F", t.Id));
        await rig.Ui.Run(vm.Closed);
    }

    [Fact]
    public async Task The_server_refuses_the_other_genders_id_and_an_unknown_one_in_the_decks_words()
    {
        if (Skipped()) return;
        var rig = await PersonAsync("Karthik", "MALE");
        var vm = await PickerAsync(rig);

        var other = await rig.Agent.Avatars.SaveAsync("F01");
        Assert.Equal(ApiOutcome.Rejected, other.Outcome);
        Assert.Equal(403, other.Status);
        Assert.Equal("AVATAR_OTHER_LIBRARY", other.Code);
        Assert.Equal("You can pick from your own avatars.", other.Message);
        Assert.Null(rig.Agent.Avatars.ShownId);

        var unknown = await rig.Agent.Avatars.SaveAsync("Z99");
        Assert.Equal(400, unknown.Status);
        Assert.Equal("AVATAR_UNKNOWN", unknown.Code);
        Assert.Equal("Pick one of the avatars.", unknown.Message);
        Assert.Null(rig.Agent.Avatars.ShownId);

        await rig.Ui.Run(vm.Closed);
    }

    [Fact]
    public async Task Staff_change_it_from_the_agent_and_the_server_refuses_the_same_person_on_the_web()
    {
        if (Skipped()) return;
        var rig = await PersonAsync("Praveen", "MALE");
        var saved = await rig.Agent.Avatars.SaveAsync("M20");
        Assert.True(saved.Ok, saved.ToString());

        using var web = await Portal.SignInAsync(rig.Person.Email, rig.Person.Password);
        var refused = await web.PutAsync("me/avatar", new { avatarId = "M21" });
        Assert.Equal(403, refused.Status);
        Assert.Equal("AVATAR_CHANGE_ON_WEB", refused.Code);
        Assert.Equal("You can change your avatar from the agent or the phone app.", refused.Json.GetProperty("message").GetString());
        Assert.All(rig.Http.Calls.Where(c => c.Path.EndsWith("/me/avatar", StringComparison.Ordinal)),
            c => Assert.StartsWith("RXVisionAgent/", c.UserAgent));
    }

    [Fact]
    public async Task With_no_gender_set_it_says_so_is_refused_and_follows_as_soon_as_a_super_admin_sets_one()
    {
        if (Skipped()) return;
        var rig = await PersonAsync("Nila", null);
        var vm = await PickerAsync(rig);
        Assert.True(vm.HasNoLibrary);
        Assert.Equal("Ask the organisation admin to set up your profile. Then you can choose your avatar.", vm.NoLibraryText);
        Assert.Empty(vm.Tiles);
        Assert.Null(rig.Agent.Avatars.ShownId);
        Assert.True(vm.IsMarkSelected);

        // Even if someone asks: the server's refusal, in the deck's words.
        var refused = await rig.Agent.Avatars.SaveAsync("F01");
        Assert.Equal(409, refused.Status);
        Assert.Equal("GENDER_NOT_SET", refused.Code);
        Assert.Equal("Ask a Super Admin to set up your profile. Then you can choose your avatar.", refused.Message);
        Assert.Null(rig.Agent.Avatars.ShownId);

        // The Super Admin finishes the profile: it arrives over the socket, the picker opens up.
        await Env.SuperAdmin.MustAsync(HttpMethod.Patch, "users/" + rig.Person.Id, new { gender = "FEMALE" });
        await E2EEnv.WaitFor(() => vm.HasLibrary && vm.Tiles.Count == 25, Seconds, "the picker to open up");
        Assert.Null(rig.Agent.Avatars.ShownId);
        Assert.Equal("75 female avatars", vm.CountText);
        await rig.Ui.Run(vm.Closed);
    }

    [Fact]
    public async Task A_save_that_cannot_reach_the_server_puts_the_old_one_back_and_says_try_again()
    {
        if (Skipped()) return;
        var rig = await PersonAsync("Vikram", "MALE");
        var vm = await PickerAsync(rig);
        await rig.Ui.Run(() => vm.Tiles[3].PickCommand.Execute(null));

        rig.Relay.GoOffline();
        await rig.Ui.RunAsync(async () => { await vm.SaveCommand.ExecuteAsync(null); return true; });
        Assert.Equal("Try saving your avatar again.", vm.Error);
        Assert.Null(rig.Agent.Avatars.ShownId);
        Assert.Equal("M04", vm.PreviewId);

        rig.Relay.GoOnline();
        await rig.Ui.RunAsync(async () => { await vm.SaveCommand.ExecuteAsync(null); return true; });
        Assert.Null(vm.Error);
        Assert.Equal("M04", rig.Agent.Avatars.ShownId);
        await rig.Ui.Run(vm.Closed);
    }

    // ---- The icon ---------------------------------------------------------------------------------

    [Fact]
    public async Task A_save_reaches_the_icon_at_once_and_a_change_elsewhere_an_admin_reset_and_a_gender_change_within_seconds()
    {
        if (Skipped()) return;
        var rig = await PersonAsync("Rahul", "MALE");
        var icon = await rig.Ui.Run(() => new AvatarIconSource(rig.Agent));
        var device = await ServerViewAsync(rig.Person);

        // From this agent: before the server has answered, as far as the icon can tell.
        var saving = rig.Agent.Avatars.SaveAsync("M30");
        await E2EEnv.WaitFor(() => icon.AvatarId == "M30", TimeSpan.FromSeconds(1), "the icon to take the save");
        Assert.True((await saving).Ok);

        // From another device of theirs.
        Assert.True((await device.PutAsync("me/avatar", new { avatarId = "M31" })).Ok);
        await E2EEnv.WaitFor(() => icon.AvatarId == "M31", Seconds, "the change from the other device");

        // A Super Admin resets it.
        await Env.SuperAdmin.MustAsync(HttpMethod.Post, $"users/{rig.Person.Id}/avatar/reset");
        await E2EEnv.WaitFor(() => icon.AvatarId is null, Seconds, "the admin's reset, back to the RX mark");

        // A Super Admin changes their gender: still the RX mark, and the new library with it.
        await Env.SuperAdmin.MustAsync(HttpMethod.Patch, "users/" + rig.Person.Id, new { gender = "FEMALE" });
        await E2EEnv.WaitFor(() => rig.Agent.Avatars.Mine?.Library == "female", Seconds, "the new library");
        Assert.Null(icon.AvatarId);
    }

    [Fact]
    public async Task A_reconnect_reads_what_changed_while_the_socket_was_down()
    {
        if (Skipped()) return;
        var rig = await PersonAsync("Sanjay", "MALE");
        var device = await ServerViewAsync(rig.Person);
        await E2EEnv.WaitFor(() => rig.Host.Avatars?.Mine is not null, Seconds, "the first read");

        rig.Relay.GoOffline();
        await Task.Delay(500);
        Assert.True((await device.PutAsync("me/avatar", new { avatarId = "M44" })).Ok);
        await Task.Delay(500);
        Assert.Null(rig.Agent.Avatars.ShownId);

        rig.Relay.GoOnline();
        await E2EEnv.WaitFor(() => rig.Agent.Avatars.ShownId == "M44", TimeSpan.FromSeconds(90), "the read after the reconnect");
    }

    [Fact]
    public async Task A_start_with_no_network_draws_the_saved_avatar_from_the_bundle_and_asks_nobody_for_a_picture()
    {
        if (Skipped()) return;
        var rig = await PersonAsync("Deepa", "FEMALE");
        Assert.True((await rig.Agent.Avatars.SaveAsync("F40")).Ok);

        rig.Relay.GoOffline();
        await rig.RestartAsync();

        // 4.0 is offline first: the saved session restores without the server (3.6 waited in Connecting).
        Assert.NotEqual(AgentState.SignIn, rig.Host.State);
        Assert.Equal("F40", rig.Agent.Avatars.ShownId);
        Assert.Equal("Deepa Avatar", rig.Agent.Avatars.PersonName);
        var file = AvatarLibrary.Bundled.FileFor(rig.Agent.Avatars.ShownId, 84);
        Assert.True(File.Exists(file), file);
        Assert.DoesNotContain(rig.Http.Calls, c => c.Path.Contains("/avatars/", StringComparison.Ordinal));

        // The picker works from the ID alone, every one of the library drawn from the bundle.
        var vm = await PickerAsync(rig);
        Assert.Equal("75 female avatars", vm.CountText);
        Assert.Equal("F40", Assert.Single(vm.Tiles, t => t.IsSelected).Id);
        foreach (var entry in AvatarLibrary.Bundled.Of("female")) Assert.True(File.Exists(AvatarLibrary.Bundled.FileFor(entry.Id, 48)), entry.Id);
        await rig.Ui.Run(vm.Closed);

        rig.Relay.GoOnline();
    }

    // ---- Wherever a person shows -----------------------------------------------------------------

    [Fact]
    public async Task The_sign_in_answer_the_chat_and_the_people_search_carry_the_avatar_and_a_colleagues_change_reaches_their_row()
    {
        if (Skipped()) return;
        var manager = await PersonAsync("Maya", "FEMALE", role: "MANAGER");
        var staff = await PersonAsync("Asha", "FEMALE");
        await Env.SuperAdmin.MustAsync(HttpMethod.Patch, "users/" + staff.Person.Id, new { managerId = manager.Person.Id });
        // On their gender's default: no choice, the RX mark (D-85).
        Assert.Null(staff.Host.User?.AvatarId);

        await staff.Ui.RunAsync(async () => { await staff.Dashboard.Chat.ActivateAsync(); return true; });
        await staff.Agent.Chat!.LoadContactsAsync();
        await staff.Ui.RunAsync(async () => { await staff.Dashboard.Chat.ActivateAsync(); return true; });
        var row = Assert.Single(staff.Dashboard.Chat.Contacts, c => c.UserId == manager.Person.Id);
        Assert.Null(row.AvatarId);

        // The manager changes theirs: it reaches their report's chat within seconds.
        Assert.True((await manager.Agent.Avatars.SaveAsync("F22")).Ok);
        await E2EEnv.WaitFor(() => row.AvatarId == "F22", Seconds, "the colleague's new avatar in the chat row");

        var people = await staff.Agent.SearchParticipantsAsync("Maya");
        Assert.Contains(people!, p => p.Id == manager.Person.Id && p.AvatarId == "F22");
    }

    [Fact]
    public async Task No_route_for_a_picture_exists_on_the_server_for_the_agent_to_call()
    {
        if (Skipped()) return;
        var rig = await PersonAsync("Ravi", "MALE");
        var device = await ServerViewAsync(rig.Person);
        foreach (var path in new[] { "me/avatar/upload", "me/photo", "users/me/photo", "avatars/upload" })
            Assert.Equal(404, (await device.PostAsync(path, new { })).Status);
    }
}
