using System.Text.Json;
using Xunit;

namespace RXVision.Agent.E2E.Tests;

/// <summary>Every end-to-end test runs in this one collection: one at a time, one setup for all.</summary>
[CollectionDefinition(Name)]
public sealed class E2ECollection : ICollectionFixture<E2EFixture>
{
    public const string Name = "Agent end to end";
}

/// <summary>
/// What the tests share: the portal sessions (Admin, Manager, Super Admin), the department
/// the test people join (its manager decides their items), and the away settings the Admin
/// sets up: a custom reason and the department's reason list (HARDWARE and the custom one
/// added). Away tracking stays off for the department; the people of the away tests get
/// their own override, so nobody else is asked. Put back as it was at the end.
/// </summary>
public sealed class E2EFixture : IAsyncLifetime
{
    public const string EngineeringId = "00000000-0000-0000-0000-0000000000e1";
    public const string CustomReasonKey = "CUSTOM_E2E_SITE_VISIT";
    public const string CustomReasonLabel = "Site visit";

    public string? Skip { get; private set; }
    public Portal Admin { get; private set; } = null!;
    public Portal Manager { get; private set; } = null!;
    public Portal SuperAdmin { get; private set; } = null!;

    private JsonElement _reasonsBefore;
    private JsonElement _departmentBefore;

    public async Task InitializeAsync()
    {
        Skip = E2EEnv.SkipReason();
        if (Skip is not null) return;
        Admin = await Portal.SignInAsync("orgadmin@timechamp.test", "orgadmin123");
        Manager = await Portal.SignInAsync("manager@timechamp.test", "manager123");
        SuperAdmin = await Portal.SignInAsync("admin@timechamp.test", "admin123");

        var idle = await Admin.MustAsync(HttpMethod.Get, "idle-settings");
        _reasonsBefore = idle.GetProperty("reasons").Clone();
        _departmentBefore = idle.GetProperty("departments").EnumerateArray().First(d => d.GetProperty("departmentId").GetString() == EngineeringId).Clone();
        // The custom reason (the organisation's list), then the department's choice of reasons.
        var reasons = _reasonsBefore.EnumerateArray()
            .Where(r => r.GetProperty("key").GetString() != CustomReasonKey)
            .Select(r => (object)new { key = r.GetProperty("key").GetString(), label = r.GetProperty("label").GetString() })
            .Append(new { key = CustomReasonKey, label = CustomReasonLabel })
            .ToArray();
        await Admin.MustAsync(HttpMethod.Put, "idle-settings", new
        {
            defaultEnabled = idle.GetProperty("defaultEnabled").GetBoolean(),
            defaultMinutes = idle.GetProperty("defaultMinutes").GetInt32(),
            reasons,
        });
        await Admin.MustAsync(HttpMethod.Put, $"idle-settings/departments/{EngineeringId}", new
        {
            enabled = (bool?)null,
            minutes = 2,
            reasonKeys = new[] { "BREAK", "THINKING", "MEETING", "HARDWARE", "OTHER", CustomReasonKey },
        });
    }

    public async Task DisposeAsync()
    {
        if (Skip is not null) return;
        try
        {
            await Admin.SendAsync(HttpMethod.Put, $"idle-settings/departments/{EngineeringId}", new
            {
                enabled = Nullable(_departmentBefore, "enabled", e => e.GetBoolean()),
                minutes = Nullable(_departmentBefore, "minutes", e => e.GetInt32()),
                reasonKeys = _departmentBefore.TryGetProperty("reasonKeys", out var keys) && keys.ValueKind == JsonValueKind.Array
                    ? keys.EnumerateArray().Select(k => k.GetString()).ToArray()
                    : null,
            });
        }
        catch { }
        Admin?.Dispose();
        Manager?.Dispose();
        SuperAdmin?.Dispose();
    }

    private static T? Nullable<T>(JsonElement e, string name, Func<JsonElement, T> read) where T : struct =>
        e.TryGetProperty(name, out var v) && v.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined) ? read(v) : null;

    /// <summary>Turns away tracking on for one person (2 minutes), the way the portal's person page does.</summary>
    public async Task AwayOnAsync(Person person)
    {
        await Admin.MustAsync(HttpMethod.Post, $"users/{person.Id}/idle", new { enabled = true, minutes = 2 });
    }

    /// <summary>
    /// The person's own day started earlier (a replay from another device, with that device's
    /// activity samples since), so past meetings fit in it and the time counts as focus.
    /// </summary>
    public static async Task StartDayEarlierAsync(Person person, TimeSpan ago)
    {
        using var device = await Portal.SignInAsync(person.Email, person.Password, "RXVisionAgent/4.0.0 (windows)");
        var at = DateTimeOffset.UtcNow - ago;
        var r = await device.PostAsync("activity/start-day", new { }, new Dictionary<string, string>
        {
            ["X-Client-Event-Id"] = Guid.NewGuid().ToString(),
            ["X-Event-At"] = E2EEnv.Iso(at),
        });
        Assert.True(r.Ok, $"start-day {ago.TotalMinutes} min ago: {r}");
        // A replayed day counts only where the agent's activity samples cover it (SPEC 2.4): that
        // agent's samples since then follow, one a minute, as it sends its backlog after the journal.
        for (var t = at.AddSeconds(5); t < DateTimeOffset.UtcNow; t = t.AddMinutes(1))
        {
            var sample = await device.PostAsync("activity/report", new { at = E2EEnv.Iso(t), app = "Visual Studio Code", title = "Planning notes", idle = false });
            Assert.True(sample.Ok, $"the sample at {t:HH:mm:ss}Z: {sample}");
        }
    }
}
