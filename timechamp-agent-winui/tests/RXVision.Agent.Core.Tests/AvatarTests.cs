using System.Text;
using System.Text.Json;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Avatars;
using RXVision.Agent.Core.Platform.Dev;
using RXVision.Agent.Core.Realtime;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;
using Xunit;

namespace RXVision.Agent.Core.Tests;

/// <summary>The bundle's manifest is the only way from an ID to a file.</summary>
public sealed class AvatarLibraryTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("rxv-avatars-").FullName;

    private AvatarLibrary Library(string manifest)
    {
        File.WriteAllText(Path.Combine(_dir, "manifest.json"), manifest);
        return AvatarLibrary.Load(_dir);
    }

    private const string Two = """
        {
          "version": 1,
          "default": { "male": "M01", "female": "F01" },
          "avatars": [
            { "id": "M01", "gender": "male", "set": 1, "files": { "48": "anywhere/first-small.webp", "96": "anywhere/first-big.webp" } },
            { "id": "M02", "gender": "male", "set": 2, "files": { "48": "a.webp" } },
            { "id": "F01", "gender": "female", "set": 1, "files": { "48": "b.webp" } }
          ]
        }
        """;

    [Fact]
    public void Files_come_from_the_manifest_and_are_never_built_from_an_id()
    {
        var library = Library(Two);
        Assert.Null(library.LoadError);
        Assert.Equal(Path.Combine(_dir, "anywhere/first-small.webp"), library.FileFor("M01", 42));
        Assert.Equal(Path.Combine(_dir, "anywhere/first-big.webp"), library.FileFor("M01", 63));
    }

    [Fact]
    public void Takes_the_next_larger_file_and_the_largest_when_none_is_larger()
    {
        var library = Library(Two);
        Assert.EndsWith("first-small.webp", library.FileFor("M01", 48));
        Assert.EndsWith("first-big.webp", library.FileFor("M01", 49));
        Assert.EndsWith("first-big.webp", library.FileFor("M01", 500));
    }

    [Fact]
    public void An_id_the_manifest_does_not_know_has_no_file()
    {
        var library = Library(Two);
        Assert.Null(library.FileFor("M99", 48));
        Assert.Null(library.FileFor(null, 48));
        Assert.Null(library.Find("../manifest"));
    }

    [Fact]
    public void Libraries_sets_and_defaults_read_from_it()
    {
        var library = Library(Two);
        Assert.Equal(new[] { "M01", "M02" }, library.Of("male").Select(e => e.Id));
        Assert.Equal(new[] { "M02" }, library.Of("male", 2).Select(e => e.Id));
        Assert.Equal(new[] { "F01" }, library.Of("female").Select(e => e.Id));
        Assert.Empty(library.Of(null));
        Assert.Equal(new[] { 1, 2 }, library.SetsOf("male"));
        Assert.Equal("M01", library.DefaultOf("male"));
        Assert.Equal("F01", library.DefaultOf("female"));
        Assert.Null(library.DefaultOf(null));
    }

    [Fact]
    public void A_default_from_the_wrong_library_is_not_taken()
    {
        var library = Library("""
            { "default": { "male": "F01", "female": "F01" },
              "avatars": [ { "id": "F01", "gender": "female", "set": 1, "files": { "48": "b.webp" } } ] }
            """);
        Assert.Null(library.DefaultOf("male"));
        Assert.Equal("F01", library.DefaultOf("female"));
    }

    [Theory]
    [InlineData("""{ "id": "M01", "gender": "male", "set": 1, "files": { "48": "../outside.webp" } }""")]
    [InlineData("""{ "id": "M01", "gender": "male", "set": 1, "files": { "48": "a/../../outside.webp" } }""")]
    [InlineData("""{ "id": "M01", "gender": "male", "set": 1, "files": { "48": "/etc/passwd" } }""")]
    [InlineData("""{ "id": "M01", "gender": "male", "set": 1, "files": { "tiny": "a.webp" } }""")]
    [InlineData("""{ "id": "M01", "gender": "male", "set": 1, "files": {} }""")]
    [InlineData("""{ "id": "M 01", "gender": "male", "set": 1, "files": { "48": "a.webp" } }""")]
    [InlineData("""{ "id": "../M01", "gender": "male", "set": 1, "files": { "48": "a.webp" } }""")]
    [InlineData("""{ "id": "M01", "gender": "other", "set": 1, "files": { "48": "a.webp" } }""")]
    [InlineData("""{ "id": "M01", "gender": "male", "set": 0, "files": { "48": "a.webp" } }""")]
    [InlineData("""{ "id": "M01", "gender": "male", "files": { "48": "a.webp" } }""")]
    public void An_entry_that_is_not_sound_is_left_out_and_the_rest_stand(string bad)
    {
        var library = Library($$"""{ "avatars": [ {{bad}}, { "id": "F01", "gender": "female", "set": 1, "files": { "48": "b.webp" } } ] }""");
        Assert.Null(library.Find("M01"));
        Assert.NotNull(library.Find("F01"));
    }

    [Fact]
    public void An_id_listed_twice_keeps_the_first()
    {
        var library = Library("""
            { "avatars": [ { "id": "M01", "gender": "male", "set": 1, "files": { "48": "first.webp" } },
                           { "id": "M01", "gender": "male", "set": 2, "files": { "48": "second.webp" } } ] }
            """);
        Assert.Single(library.Entries);
        Assert.EndsWith("first.webp", library.FileFor("M01", 48));
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{}")]
    public void A_broken_manifest_is_an_empty_library_and_never_throws(string text)
    {
        var library = Library(text);
        Assert.Empty(library.Entries);
        Assert.Null(library.FileFor("M01", 48));
    }

    [Fact]
    public void A_missing_bundle_says_why_and_everyone_shows_the_RX_mark()
    {
        var library = AvatarLibrary.Load(Path.Combine(_dir, "not-here"));
        Assert.NotNull(library.LoadError);
        Assert.Empty(library.Entries);
    }

    public void Dispose()
    {
        File.Delete(Path.Combine(_dir, "manifest.json"));
        Directory.Delete(_dir);
    }
}

/// <summary>The person's avatar against a scripted server.</summary>
public class AvatarServiceTests
{
    private const string Base = "https://api.example.com/api/v1";

    private sealed class Rig
    {
        public FakeServer Server { get; } = new();
        public SessionStore Sessions { get; }
        public ApiClient Api { get; }
        public AvatarService Service { get; }
        public List<string?> Drawn { get; } = new();

        public object Answer { get; set; } = new { avatarId = "M01", chosenAvatarId = (string?)null, defaultAvatarId = "M01", library = "male" };

        public Rig()
        {
            var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
            Sessions = new SessionStore(platform.Secrets);
            Api = new ApiClient(Base, new AgentIdentity("3.6.0", "mac", "dev-1"), Sessions, new ServerClock(), NullLog.Instance, Server);
            Service = new AvatarService(Api, NullLog.Instance);
            Service.Changed += () => Drawn.Add(Service.ShownId);
            Server.Route("POST auth/login", (_, _) => FakeServer.Ok(FakeServer.User(), FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
            Server.Route("GET me/avatar", (_, _) => FakeServer.Ok(Answer));
            Server.Route("PUT me/avatar", (_, body) =>
            {
                var id = JsonDocument.Parse(body!).RootElement.GetProperty("avatarId").GetString();
                return FakeServer.Ok(new { avatarId = id, chosenAvatarId = id, defaultAvatarId = "M01", library = "male" });
            });
            Server.Route("DELETE me/avatar", (_, _) => FakeServer.Ok(new { avatarId = "M01", chosenAvatarId = (string?)null, defaultAvatarId = "M01", library = "male" }));
        }
    }

    [Fact]
    public async Task A_read_adopts_what_the_server_has()
    {
        var r = new Rig();
        Assert.True(await r.Service.RefreshAsync());
        // The server's M01 is its default, not a choice: the RX mark (D-85).
        Assert.Null(r.Service.ShownId);
        Assert.Equal("male", r.Service.Mine!.Library);
        Assert.Null(r.Service.Mine.ChosenAvatarId);
    }

    [Fact]
    public async Task A_read_with_no_gender_has_no_library_and_no_avatar()
    {
        var r = new Rig { Answer = new { avatarId = (string?)null, chosenAvatarId = (string?)null, defaultAvatarId = (string?)null, library = (string?)null } };
        await r.Service.RefreshAsync();
        Assert.Null(r.Service.ShownId);
        Assert.Null(r.Service.Mine!.Library);
    }

    [Fact]
    public async Task A_read_with_no_answer_keeps_what_is_known()
    {
        var r = new Rig();
        r.Service.Seed("M12", "Asha");
        r.Server.FailWith = _ => new HttpRequestException("offline");
        Assert.False(await r.Service.RefreshAsync());
        Assert.Equal("M12", r.Service.ShownId);
        Assert.Null(r.Service.Mine);
    }

    [Fact]
    public async Task An_older_server_without_the_route_changes_nothing()
    {
        var r = new Rig();
        r.Server.Route("GET me/avatar", (_, _) => FakeServer.Error(404, "NOT_FOUND", "Cannot GET"));
        r.Service.Seed(null, "Asha");
        Assert.False(await r.Service.RefreshAsync());
        Assert.Null(r.Service.ShownId);
    }

    [Fact]
    public async Task A_save_sends_only_the_id_and_shows_before_the_server_answers()
    {
        var r = new Rig();
        await r.Service.RefreshAsync();
        var gate = new TaskCompletionSource();
        string? sent = null;
        r.Server.Route("PUT me/avatar", (_, body) =>
        {
            sent = body;
            gate.Task.Wait();
            return FakeServer.Ok(new { avatarId = "M12", chosenAvatarId = "M12", defaultAvatarId = "M01", library = "male" });
        });
        r.Drawn.Clear();
        var saving = Task.Run(() => r.Service.SaveAsync("M12"));
        await HostHarness.WaitFor(() => r.Service.ShownId == "M12");
        Assert.False(saving.IsCompleted);
        Assert.Contains("M12", r.Drawn);
        gate.SetResult();

        var result = await saving;
        Assert.True(result.Ok);
        Assert.Equal("""{"avatarId":"M12"}""", sent);
        Assert.Equal("M12", r.Service.Mine!.ChosenAvatarId);
        Assert.Equal("M12", r.Service.ShownId);
    }

    [Fact]
    public async Task A_save_with_no_answer_puts_the_old_one_back()
    {
        var r = new Rig();
        await r.Service.RefreshAsync();
        r.Server.FailWith = req => req.Method == HttpMethod.Put ? new HttpRequestException("offline") : null;
        r.Drawn.Clear();
        var result = await r.Service.SaveAsync("M12");
        Assert.Equal(ApiOutcome.Transient, result.Outcome);
        Assert.Equal(new[] { "M12", null }, r.Drawn);
        Assert.Null(r.Service.ShownId);
    }

    [Theory]
    [InlineData(403, "AVATAR_OTHER_LIBRARY", "You can pick from your own avatars.")]
    [InlineData(400, "AVATAR_UNKNOWN", "Pick one of the avatars.")]
    [InlineData(409, "GENDER_NOT_SET", "Ask a Super Admin to set up your profile. Then you can choose your avatar.")]
    [InlineData(403, "AVATAR_CHANGE_ON_WEB", "You can change your avatar from the agent or the phone app.")]
    public async Task A_refused_save_puts_the_old_one_back_and_brings_the_servers_words(int status, string code, string message)
    {
        var r = new Rig();
        await r.Service.RefreshAsync();
        r.Server.Route("PUT me/avatar", (_, _) => FakeServer.Error(status, code, message));
        var result = await r.Service.SaveAsync("F01");
        Assert.Equal(ApiOutcome.Rejected, result.Outcome);
        Assert.Equal(code, result.Code);
        Assert.Equal(message, result.Message);
        Assert.Null(r.Service.ShownId);
    }

    [Fact]
    public async Task A_reset_shows_the_RX_mark_at_once_and_a_failed_one_puts_the_old_back()
    {
        var r = new Rig { Answer = new { avatarId = "M12", chosenAvatarId = "M12", defaultAvatarId = "M01", library = "male" } };
        await r.Service.RefreshAsync();
        r.Server.FailWith = req => req.Method == HttpMethod.Delete ? new HttpRequestException("offline") : null;
        r.Drawn.Clear();
        await r.Service.ResetAsync();
        Assert.Equal(new[] { null, "M12" }, r.Drawn);

        r.Server.FailWith = _ => null;
        var ok = await r.Service.ResetAsync();
        Assert.True(ok.Ok);
        Assert.Null(r.Service.ShownId);
        Assert.Null(r.Service.Mine!.ChosenAvatarId);
        Assert.Equal(2, r.Server.Calls.Count(c => c is { Method: "DELETE", Body: null }));
    }

    [Fact]
    public async Task A_read_begun_before_a_save_never_undoes_it()
    {
        var r = new Rig();
        await r.Service.RefreshAsync();
        var gate = new TaskCompletionSource();
        r.Server.Route("GET me/avatar", (_, _) =>
        {
            gate.Task.Wait();
            return FakeServer.Ok(new { avatarId = "M01", chosenAvatarId = (string?)null, defaultAvatarId = "M01", library = "male" });
        });
        var read = Task.Run(() => r.Service.RefreshAsync());
        await HostHarness.WaitFor(() => r.Server.Count("GET me/avatar") == 2);
        await r.Service.SaveAsync("M12");
        gate.SetResult();
        await read;
        Assert.Equal("M12", r.Service.ShownId);
        Assert.Equal("M12", r.Service.Mine!.AvatarId);
    }

    [Fact]
    public async Task A_read_begun_during_a_save_never_undoes_it_either()
    {
        var r = new Rig();
        await r.Service.RefreshAsync();
        var saveGate = new TaskCompletionSource();
        var readGate = new TaskCompletionSource();
        r.Server.Route("PUT me/avatar", (_, _) =>
        {
            saveGate.Task.Wait();
            return FakeServer.Ok(new { avatarId = "M12", chosenAvatarId = "M12", defaultAvatarId = "M01", library = "male" });
        });
        r.Server.Route("GET me/avatar", (_, _) =>
        {
            readGate.Task.Wait();
            return FakeServer.Ok(new { avatarId = "M01", chosenAvatarId = (string?)null, defaultAvatarId = "M01", library = "male" });
        });
        var saving = Task.Run(() => r.Service.SaveAsync("M12"));
        await HostHarness.WaitFor(() => r.Service.ShownId == "M12");
        var read = Task.Run(() => r.Service.RefreshAsync());
        await HostHarness.WaitFor(() => r.Server.Count("GET me/avatar") == 2);
        saveGate.SetResult();
        await saving;
        readGate.SetResult();
        await read;
        Assert.Equal("M12", r.Service.ShownId);
    }

    [Fact]
    public async Task A_push_updates_what_shows_at_once_and_reads_again_for_the_library()
    {
        var r = new Rig();
        await r.Service.RefreshAsync();
        r.Answer = new { avatarId = "F20", chosenAvatarId = "F20", defaultAvatarId = "F01", library = "female" };
        r.Service.OnPushed("F20");
        Assert.Equal("F20", r.Service.ShownId);
        await HostHarness.WaitFor(() => r.Service.Mine?.Library == "female");
        Assert.Equal("F20", r.Service.ShownId);
        // Back to the default elsewhere: the push carries F01, which is no choice: the RX mark.
        r.Answer = new { avatarId = "F01", chosenAvatarId = (string?)null, defaultAvatarId = "F01", library = "female" };
        r.Service.OnPushed("F01");
        Assert.Null(r.Service.ShownId);
        await HostHarness.WaitFor(() => r.Service.Mine?.ChosenAvatarId is null);
        Assert.Null(r.Service.ShownId);
    }

    [Fact]
    public async Task A_push_during_a_save_waits_for_it_and_then_the_server_decides()
    {
        var r = new Rig();
        await r.Service.RefreshAsync();
        var gate = new TaskCompletionSource();
        r.Server.Route("PUT me/avatar", (_, _) =>
        {
            gate.Task.Wait();
            return FakeServer.Ok(new { avatarId = "M12", chosenAvatarId = "M12", defaultAvatarId = "M01", library = "male" });
        });
        var saving = Task.Run(() => r.Service.SaveAsync("M12"));
        await HostHarness.WaitFor(() => r.Service.ShownId == "M12");
        r.Service.OnPushed("M30");
        Assert.Equal("M12", r.Service.ShownId);

        r.Answer = new { avatarId = "M30", chosenAvatarId = "M30", defaultAvatarId = "M01", library = "male" };
        gate.SetResult();
        await saving;
        Assert.Equal("M30", r.Service.ShownId);
    }

    [Fact]
    public async Task The_id_is_kept_with_the_saved_session_and_nothing_else_about_it()
    {
        var r = new Rig();
        await r.Api.LoginAsync("a@x.test", "pw");
        await r.Service.SaveAsync("M12");
        Assert.Equal("M12", r.Sessions.Load()!.AvatarId);
        await r.Service.ResetAsync();
        Assert.Null(r.Sessions.Load()!.AvatarId);
    }

    [Fact]
    public async Task A_session_saved_by_an_older_agent_reads_with_no_avatar()
    {
        var r = new Rig();
        var older = """{"apiBaseUrl":"https://a/api/v1","refreshToken":"rt","userId":"u-1","email":"a@x.test","displayName":"Asha","role":"USER"}""";
        var saved = JsonSerializer.Deserialize<SavedSession>(Encoding.UTF8.GetBytes(older), Json.Options)!;
        Assert.Null(saved.AvatarId);
        r.Server.Route("POST auth/refresh", (_, _) => FakeServer.Ok(new { refreshed = true }, FakeServer.AccessCookie(), FakeServer.RefreshCookie("rt-2")));
        Assert.True((await r.Api.RestoreAsync(saved)).Ok);
        Assert.Null(r.Api.CurrentUser!.AvatarId);
    }

    [Fact]
    public void A_socket_payload_reads_with_its_id_or_with_null()
    {
        var change = Payload.As<AvatarChange>(JsonDocument.Parse("""{"userId":"u-1","avatarId":"M12"}""").RootElement);
        Assert.Equal(("u-1", "M12"), (change!.UserId, change.AvatarId));
        var none = Payload.As<AvatarChange>(JsonDocument.Parse("""{"userId":"u-1","avatarId":null}""").RootElement);
        Assert.Null(none!.AvatarId);
        // A gender default is no choice: the RX mark (D-85).
        var fallback = Payload.As<AvatarChange>(JsonDocument.Parse("""{"userId":"u-1","avatarId":"F01"}""").RootElement);
        Assert.Null(fallback!.AvatarId);
    }

    [Theory]
    [InlineData(null, null)]
    [InlineData("", null)]
    [InlineData("M01", null)]
    [InlineData("F01", null)]
    [InlineData("M02", "M02")]
    [InlineData("F40", "F40")]
    public void Other_peoples_gender_default_draws_as_the_RX_mark(string? fromServer, string? drawn)
    {
        Assert.Equal(drawn, AvatarChoice.Shown(fromServer));
        Assert.Equal(drawn, new ChatContact { AvatarId = fromServer }.AvatarId);
        Assert.Equal(drawn, new PublicUser { AvatarId = fromServer }.AvatarId);
    }

    [Fact]
    public async Task The_day_progress_reads_with_the_rings_numbers()
    {
        var r = new Rig();
        r.Server.Route("GET me/day-progress", (_, _) => FakeServer.Ok(new
        {
            status = "BREAK", date = "2026-10-13", workedSec = 12600, targetSec = 28800, overSec = 0, targetFromShift = true,
            breakStartedAt = "2026-10-13T08:00:00.000Z", breakEndsAt = "2026-10-13T08:15:00.000Z", meetingStartedAt = (string?)null,
        }));
        var day = (await r.Api.GetDayProgressAsync()).Data!;
        Assert.Equal(DayProgressStatus.Break, day.Status);
        Assert.Equal(12600, day.WorkedSec);
        Assert.Equal(28800, day.TargetSec);
        Assert.Equal(new DateTimeOffset(2026, 10, 13, 8, 15, 0, TimeSpan.Zero), day.BreakEndsAt);
    }

    [Fact]
    public void A_participants_avatar_is_never_sent_when_a_meeting_is_logged()
    {
        var clean = ApiClient.CleanParticipants(new[] { new MeetingParticipant("p-1", "Praveen") { AvatarId = "M12" } });
        var json = JsonSerializer.Serialize(new PastMeetingRequest { Agenda = "Review", Participants = clean }, Json.Options);
        Assert.DoesNotContain("avatar", json, StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>The whole core: from sign-in, a start with no network, sockets and sign-out.</summary>
public class AvatarHostTests
{
    private static void Routes(HostHarness h, string? avatarId = "M12")
    {
        h.Server.Route("POST auth/login", (_, _) => FakeServer.Ok(
            new { user = new { id = "u-1", email = "u-1@x.test", firstName = "Asha", lastName = "Kumar", role = "USER", screenshotsEnabled = true, avatarId } },
            FakeServer.AccessCookie(), FakeServer.RefreshCookie()));
        h.Server.Route("GET me/avatar", (_, _) => FakeServer.Ok(new { avatarId, chosenAvatarId = avatarId, defaultAvatarId = "M01", library = "male" }));
    }

    [Fact]
    public async Task Sign_in_shows_the_answers_avatar_and_reads_the_rest()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        Routes(h);
        await h.SignInAsync();
        Assert.Equal("M12", h.Host.Avatars!.ShownId);
        Assert.Equal("Asha Kumar", h.Host.Avatars.PersonName);
        await HostHarness.WaitFor(() => h.Host.Avatars.Mine is not null);
        Assert.Equal("male", h.Host.Avatars.Mine!.Library);
    }

    [Fact]
    public async Task A_start_with_no_network_draws_the_saved_avatar_and_asks_nobody_for_a_picture()
    {
        var platform = new DevPlatform(Directory.CreateTempSubdirectory().FullName);
        using (var first = new HostHarness(HostHarness.Day("OPEN"), platform: platform))
        {
            Routes(first);
            await first.SignInAsync();
            await HostHarness.WaitFor(() => first.Host.Avatars!.Mine is not null);
        }

        using var again = new HostHarness(HostHarness.Day("OPEN"), platform: platform);
        again.Server.FailWith = _ => new HttpRequestException("offline");
        var changes = 0;
        again.Host.MyAvatarChanged += () => changes++;
        await again.Host.StartAsync();

        // 4.0 is offline first: the saved session restores without the server (3.6 waited in Connecting).
        Assert.NotEqual(AgentState.SignIn, again.Host.State);
        Assert.Equal("M12", again.Host.Avatars!.ShownId);
        Assert.Equal("Asha Kumar", again.Host.Avatars.PersonName);
        Assert.True(changes > 0);
        Assert.DoesNotContain(again.Server.Calls, c => c.Path.StartsWith("avatars", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Nothing_in_the_agent_ever_asks_the_server_for_a_picture()
    {
        using var h = new HostHarness(HostHarness.Day("OPEN"));
        Routes(h);
        await h.SignInAsync();
        await h.Host.Avatars!.SaveAsync("M30");
        await h.Host.Avatars.ResetAsync();
        await HostHarness.WaitFor(() => h.Host.Avatars.Mine is not null);
        Assert.DoesNotContain(h.Server.Calls, c => c.Path.Contains("avatars/", StringComparison.Ordinal));
    }

    [Fact]
    public async Task A_push_about_this_person_updates_the_icon_and_one_about_someone_else_their_chat_row()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        Routes(h);
        h.Server.Route("GET chat/contacts", (_, _) => FakeServer.Ok(new[] { new { userId = "m-1", name = "Maya", email = "m@x.test", role = "MANAGER", relation = "MANAGER", avatarId = "F01" } }));
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Host.Chat!.ContactsLoaded);
        var others = new List<(string, string?)>();
        h.Host.PersonAvatarChanged += (id, avatar) => others.Add((id, avatar));

        h.Server.Route("GET me/avatar", (_, _) => FakeServer.Ok(new { avatarId = "M30", chosenAvatarId = "M30", defaultAvatarId = "M01", library = "male" }));
        h.Host.OnAvatarChanged(new AvatarChange { UserId = "u-1", AvatarId = "M30" });
        Assert.Equal("M30", h.Host.Avatars!.ShownId);
        Assert.Empty(others);

        h.Host.OnAvatarChanged(new AvatarChange { UserId = "m-1", AvatarId = "F20" });
        Assert.Equal(("m-1", "F20"), Assert.Single(others));
        Assert.Equal("F20", h.Host.Chat!.Contacts[0].AvatarId);
    }

    [Fact]
    public async Task A_reconnect_reads_the_avatar_and_the_contacts_again()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        Routes(h);
        h.Server.Route("GET chat/contacts", (_, _) => FakeServer.Ok(new[] { new { userId = "m-1", name = "Maya", email = "m@x.test", role = "MANAGER", relation = "MANAGER", avatarId = "F01" } }));
        await h.SignInAsync();
        await HostHarness.WaitFor(() => h.Host.Chat!.ContactsLoaded && h.Host.Avatars!.Mine is not null);
        var others = new List<(string, string?)>();
        h.Host.PersonAvatarChanged += (id, avatar) => others.Add((id, avatar));

        // Changed elsewhere while the socket was down.
        h.Server.Route("GET me/avatar", (_, _) => FakeServer.Ok(new { avatarId = "M44", chosenAvatarId = "M44", defaultAvatarId = "M01", library = "male" }));
        h.Server.Route("GET chat/contacts", (_, _) => FakeServer.Ok(new[] { new { userId = "m-1", name = "Maya", email = "m@x.test", role = "MANAGER", relation = "MANAGER", avatarId = "F33" } }));
        await h.Host.ReadAvatarsAgainAsync();

        Assert.Equal("M44", h.Host.Avatars!.ShownId);
        Assert.Equal(("m-1", "F33"), Assert.Single(others));
    }

    [Fact]
    public async Task Sign_out_forgets_whose_avatar_it_was()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        Routes(h);
        h.Server.Route("POST auth/logout", (_, _) => FakeServer.Ok(new { ok = true }));
        await h.SignInAsync();
        await h.Host.SignOutAsync();
        Assert.Null(h.Host.Avatars!.ShownId);
        Assert.Null(h.Host.Avatars.PersonName);
    }

    [Fact]
    public async Task Someone_else_signing_in_on_this_machine_starts_from_their_own_avatar()
    {
        using var h = new HostHarness(HostHarness.Day("NOT_STARTED"));
        Routes(h);
        h.Server.Route("POST auth/logout", (_, _) => FakeServer.Ok(new { ok = true }));
        await h.SignInAsync();
        await h.Host.SignOutAsync();
        Routes(h, "M55");
        await h.Host.SignInAsync("next@x.test", "pw");
        Assert.Equal("M55", h.Host.Avatars!.ShownId);
    }
}
