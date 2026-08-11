using System.Text.Json;
using System.Text.Json.Serialization;

namespace TimeChampAgent.Services;

/// <summary>Shared JSON options — the backend uses camelCase.</summary>
public static class JsonOpts
{
    public static readonly JsonSerializerOptions Default = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

// ---- Response envelope: { success, data, ... } ----------------------------
public sealed class Envelope<T>
{
    [JsonPropertyName("success")] public bool Success { get; set; }
    [JsonPropertyName("data")] public T? Data { get; set; }
}

// ---- Auth ------------------------------------------------------------------
public sealed class LoginRequest
{
    [JsonPropertyName("email")] public string Email { get; set; } = "";
    [JsonPropertyName("password")] public string Password { get; set; } = "";
}

public sealed class PublicUser
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("email")] public string Email { get; set; } = "";
    [JsonPropertyName("role")] public string? Role { get; set; }
    [JsonPropertyName("firstName")] public string? FirstName { get; set; }
    [JsonPropertyName("lastName")] public string? LastName { get; set; }

    public string DisplayName =>
        string.Join(" ", new[] { FirstName, LastName }.Where(s => !string.IsNullOrWhiteSpace(s)))
            is { Length: > 0 } n ? n : Email;
}

public sealed class LoginResponse
{
    [JsonPropertyName("user")] public PublicUser? User { get; set; }
}

// ---- Chat ------------------------------------------------------------------
public sealed class ChatContact
{
    [JsonPropertyName("userId")] public string UserId { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("email")] public string Email { get; set; } = "";
    [JsonPropertyName("role")] public string? Role { get; set; }
    [JsonPropertyName("department")] public string? Department { get; set; }
}

public sealed class ChatMessage
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("fromUserId")] public string FromUserId { get; set; } = "";
    [JsonPropertyName("toUserId")] public string ToUserId { get; set; } = "";
    [JsonPropertyName("body")] public string Body { get; set; } = "";
    [JsonPropertyName("mine")] public bool Mine { get; set; }
    [JsonPropertyName("read")] public bool Read { get; set; }
    [JsonPropertyName("createdAt")] public DateTime CreatedAt { get; set; }
}

// ---- Presence --------------------------------------------------------------
public sealed class StartPresenceRequest
{
    [JsonPropertyName("type")] public string Type { get; set; } = "BREAK"; // BREAK | LUNCH | MEETING
    [JsonPropertyName("note")] public string? Note { get; set; }
}

public sealed class CurrentPresence
{
    [JsonPropertyName("status")] public string Status { get; set; } = "WORKING";
    [JsonPropertyName("sessionId")] public string? SessionId { get; set; }
    [JsonPropertyName("note")] public string? Note { get; set; }
    [JsonPropertyName("since")] public DateTime? Since { get; set; }
    [JsonPropertyName("elapsedSec")] public int ElapsedSec { get; set; }
}

public sealed class TodayTotals
{
    [JsonPropertyName("breakSec")] public int BreakSec { get; set; }
    [JsonPropertyName("lunchSec")] public int LunchSec { get; set; }
    [JsonPropertyName("meetingSec")] public int MeetingSec { get; set; }
    [JsonPropertyName("onlineSec")] public int OnlineSec { get; set; }
}

public sealed class MyToday
{
    [JsonPropertyName("date")] public string Date { get; set; } = "";
    [JsonPropertyName("current")] public CurrentPresence? Current { get; set; }
    [JsonPropertyName("totals")] public TodayTotals Totals { get; set; } = new();
}

// ---- Activity --------------------------------------------------------------

/// <summary>One foreground-activity sample posted to /activity/report.</summary>
public sealed class ActivityReport
{
    [JsonPropertyName("at")] public string? At { get; set; }
    [JsonPropertyName("idle")] public bool Idle { get; set; }
    /// <summary>Workstation locked (Win+L, logged off, or RDP disconnected). <see
    /// cref="Idle"/> is always true alongside it; this tells the server the inactivity
    /// began at this instant rather than one idle-threshold ago, so it must not
    /// reclassify the work that came before.</summary>
    [JsonPropertyName("locked")] public bool Locked { get; set; }
    [JsonPropertyName("app")] public string? App { get; set; }
    [JsonPropertyName("title")] public string? Title { get; set; }
    [JsonPropertyName("url")] public string? Url { get; set; }
    /// <summary>When the user logged into their PC (ISO-8601). The server keeps the
    /// earliest per day as the login time.</summary>
    [JsonPropertyName("loginAt")] public string? LoginAt { get; set; }
}

/// <summary>Server's answer to a report: progress against the 9h basis plus the
/// capture gate. <see cref="ShouldCapture"/> — not <see cref="ClockedOut"/> — decides
/// whether the agent keeps taking screenshots.</summary>
public sealed class ActivityAck
{
    [JsonPropertyName("activeSec")] public int ActiveSec { get; set; }
    [JsonPropertyName("workingBasisSec")] public int WorkingBasisSec { get; set; }
    [JsonPropertyName("remainingSec")] public int RemainingSec { get; set; }

    /// <summary>True once the 9h basis is reached. INFORMATIONAL ONLY (overtime marker);
    /// it does NOT stop tracking or captures.</summary>
    [JsonPropertyName("clockedOut")] public bool ClockedOut { get; set; }

    /// <summary>True once the user has ended their day (the "End Day" button).</summary>
    [JsonPropertyName("dayEnded")] public bool DayEnded { get; set; }

    /// <summary>Whether the agent should keep capturing right now. True for the whole
    /// working day (overtime + idle included); false only after the day has ended.
    /// Defaults to true so a malformed/absent ack never silently stops capture.</summary>
    [JsonPropertyName("shouldCapture")] public bool ShouldCapture { get; set; } = true;
}

/// <summary>One hour of the day's active/idle split (0–23).</summary>
public sealed class HourBucket
{
    [JsonPropertyName("hour")] public int Hour { get; set; }
    [JsonPropertyName("activeSec")] public int ActiveSec { get; set; }
    [JsonPropertyName("idleSec")] public int IdleSec { get; set; }
}

/// <summary>The day's activity rollup (/activity/me/today) — used to drive the
/// dashboard's Focus Score and the hourly productivity bars.</summary>
public sealed class DailyActivity
{
    [JsonPropertyName("activeSec")] public int ActiveSec { get; set; }
    [JsonPropertyName("idleSec")] public int IdleSec { get; set; }
    [JsonPropertyName("workingBasisSec")] public int WorkingBasisSec { get; set; }
    [JsonPropertyName("remainingSec")] public int RemainingSec { get; set; }

    /// <summary>True once the user pressed "End Day" — today's totals are final and
    /// tracking must not resume. Read on launch so restarting the agent after signing
    /// off doesn't re-arm sampling or fire a stray screenshot.</summary>
    [JsonPropertyName("dayEnded")] public bool DayEnded { get; set; }

    /// <summary>When the user logged into their PC today (ISO-8601), or null.</summary>
    [JsonPropertyName("loginAt")] public string? LoginAt { get; set; }

    [JsonPropertyName("hourly")] public List<HourBucket> Hourly { get; set; } = new();
}
