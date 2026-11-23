using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Realtime;

/// <summary>
/// The bell, for the agent: break decisions for staff, and approval requests and
/// the daily reminder for managers. Chat has its own socket and is not repeated here.
/// </summary>
public sealed class NotificationService
{
    public static readonly HashSet<string> ShownTypes = new()
    {
        "BREAK_DECIDED",
        "BREAK_APPROVAL_REQUESTED",
        "BREAK_APPROVALS_DIGEST",
        "COMPANY_ASSIGNED",
        "MEETING_NOTE",
        // 3.1: decisions on your own items, and your day closed for you.
        "MEETING_DECIDED",
        "DAY_AUTO_CLOSED",
        // 3.1, for managers and Super Admins: items to decide and their deadlines.
        "SKIP_REQUESTED",
        "AUTO_SKIP_REQUESTED",
        "SKIP_COMMENT_ADDED",
        "MEETING_REQUESTED",
        "APPROVALS_DUE_SOON",
        "APPROVALS_OVERDUE",
        "APPROVALS_ESCALATED",
        "MONTHLY_REPORT_READY",
        // 4.0: away answers decided (staff) and to decide (managers).
        "AWAY_DECIDED",
        "AWAY_REQUESTED",
    };

    private readonly SocketChannel _socket;

    public NotificationService(SocketChannel socket, ILog log)
    {
        _socket = socket;
        _socket.On("notification", e =>
        {
            var item = Payload.As<NotificationItem>(e);
            if (item is null) return;
            // 4.0: any decision moves a past day: History reads it again.
            if (item.Type.EndsWith("_DECIDED", StringComparison.Ordinal)) RaiseChanged("DECIDED");
            if (!ShownTypes.Contains(item.Type)) return;
            Received?.Invoke(item);
        });
        // 4.0: the organisation's settings (calendar, away tracking) or the person's day changed.
        _socket.On("config:changed", e => RaiseChanged("CONFIG:" + Kind(e)));
        _socket.On("workday:changed", e => RaiseChanged("WORKDAY:" + Kind(e, "reason")));
        // 3.6: someone's preset avatar changed: this person's, or someone they see.
        _socket.On("avatar:changed", e =>
        {
            if (Payload.As<AvatarChange>(e) is { UserId.Length: > 0 } change) AvatarChanged?.Invoke(change);
        });
        _socket.ConnectionChanged += up =>
        {
            if (up) RaiseConnected();
        };
    }

    /// <summary>The socket is up. Events are not replayed: what may have been missed is read again (background thread).</summary>
    public event Action? Connected;

    /// <summary>Someone's avatar changed (background thread).</summary>
    public event Action<AvatarChange>? AvatarChanged;

    /// <summary>The socket came up (tests call it to stand in for a real reconnect).</summary>
    internal void RaiseConnected()
    {
        try { Connected?.Invoke(); }
        catch { /* the host logs its own failures */ }
    }

    /// <summary>A notification worth a toast arrived (background thread).</summary>
    public event Action<NotificationItem>? Received;

    /// <summary>
    /// 4.0: something about today or History changed on the server ("CONFIG:CALENDAR",
    /// "WORKDAY:DECISION", "DECIDED"...): read the day again (background thread).
    /// </summary>
    public event Action<string>? DayChanged;

    private void RaiseChanged(string what)
    {
        try { DayChanged?.Invoke(what); }
        catch { /* the host logs its own failures */ }
    }

    private static string Kind(System.Text.Json.JsonElement e, string name = "kind")
    {
        try
        {
            var element = e.ValueKind == System.Text.Json.JsonValueKind.Array && e.GetArrayLength() > 0 ? e[0] : e;
            return element.ValueKind == System.Text.Json.JsonValueKind.Object && element.TryGetProperty(name, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.String
                ? v.GetString() ?? ""
                : "";
        }
        catch
        {
            return "";
        }
    }

    public void Start() => _socket.Start();
    public void Stop() => _socket.Stop();
    public void Reconnect() => _socket.Reconnect();
}
