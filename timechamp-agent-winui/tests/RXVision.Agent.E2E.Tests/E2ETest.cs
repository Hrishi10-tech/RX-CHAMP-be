using System.Text.Json;
using RXVision.Agent.Core.Api;
using Xunit;
using Xunit.Abstractions;

namespace RXVision.Agent.E2E.Tests;

/// <summary>What every end-to-end test does around its scenario: the skip, its agents, their logs.</summary>
[Collection(E2ECollection.Name)]
public abstract class E2ETest : IAsyncLifetime
{
    public const string AgentUserAgent = "RXVisionAgent/4.0.0 (windows)";

    protected E2ETest(E2EFixture env, ITestOutputHelper output)
    {
        Env = env;
        Out = output;
    }

    protected E2EFixture Env { get; }
    protected ITestOutputHelper Out { get; }
    private readonly List<AgentRig> _rigs = new();
    private readonly List<Portal> _portals = new();

    protected bool Skipped()
    {
        if (Env.Skip is null) return false;
        Out.WriteLine(Env.Skip);
        return true;
    }

    protected void Say(string line) => Out.WriteLine($"{DateTimeOffset.UtcNow:HH:mm:ss.fff} {line}");

    /// <summary>A person with this shift (lunch open now unless given), and their agent, signed in.</summary>
    protected async Task<AgentRig> AgentForAsync(string first, string last, ShiftBreak[]? breaks = null, bool signIn = true,
        Func<Person, Task>? beforeSignIn = null, int ringDurationMin = 5)
    {
        var person = await PortalSetup.CreateStaffAsync(Env.Admin, first, last, E2EFixture.EngineeringId);
        await PortalSetup.ShiftAsync(Env.Admin, first, breaks ?? PortalSetup.LunchOpen, ringDurationMin, person.Id);
        if (beforeSignIn is not null) await beforeSignIn(person);
        var rig = await AgentRig.CreateAsync(person);
        lock (_rigs) _rigs.Add(rig);
        if (signIn) await rig.SignInAsync();
        return rig;
    }

    /// <summary>An agent for a person who already exists (the seeded Admin, say).</summary>
    protected async Task<AgentRig> AgentForAsync(Person person)
    {
        var rig = await AgentRig.CreateAsync(person);
        lock (_rigs) _rigs.Add(rig);
        await rig.SignInAsync();
        return rig;
    }

    /// <summary>The same person on another device (a plain HTTP client with the 4.0 agent's User-Agent): what the server has.</summary>
    protected async Task<Portal> ServerViewAsync(Person person)
    {
        var p = await Portal.SignInAsync(person.Email, person.Password, AgentUserAgent);
        lock (_portals) _portals.Add(p);
        return p;
    }

    /// <summary>GET data as the agent's models read it.</summary>
    protected static T Read<T>(JsonElement data) => data.Deserialize<T>(Json.Options)!;

    public Task InitializeAsync() => Task.CompletedTask;

    public async Task DisposeAsync()
    {
        foreach (var rig in _rigs)
        {
            rig.Log.DumpTo(Out);
            foreach (var call in rig.Http.Calls)
                Out.WriteLine($"  call {call.At:HH:mm:ss.fff} {call.Method} {call.Path} {call.Status}{(call.EventId is null ? "" : $" event-at {call.EventAt} seq {call.Seq}")}");
            await rig.DisposeAsync();
        }
        foreach (var p in _portals) p.Dispose();
    }

    /// <summary>Taps a dashboard tile (its command, as the click runs it).</summary>
    protected static Task Tap(RXVision.Agent.ViewModels.TileViewModel tile) =>
        ((CommunityToolkit.Mvvm.Input.IAsyncRelayCommand)tile.Command!).ExecuteAsync(null);

    protected static void Near(DateTimeOffset expected, DateTimeOffset? actual, double seconds, string what)
    {
        Assert.True(actual.HasValue, $"{what}: missing");
        var off = Math.Abs((actual!.Value - expected).TotalSeconds);
        Assert.True(off <= seconds, $"{what}: {actual:O} is {off:F1} s from {expected:O}");
    }
}
