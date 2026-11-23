using RXVision.Agent.Core.Activity;
using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Approvals;
using RXVision.Agent.Core.Avatars;
using RXVision.Agent.Core.Breaks;
using RXVision.Agent.Core.Config;
using RXVision.Agent.Core.Meetings;
using RXVision.Agent.Core.Platform;
using RXVision.Agent.Core.Realtime;
using RXVision.Agent.Core.Screenshots;
using RXVision.Agent.Core.Session;
using RXVision.Agent.Core.Update;
using RXVision.Agent.Core.Util;
using RXVision.Agent.Core.Workday;

namespace RXVision.Agent.Core;

/// <summary>
/// Everything bound to one API server: the client and the services that use it.
/// Rebuilt only when the server changes (a setup code for another server).
/// </summary>
public sealed class AgentServices : IDisposable
{
    public ApiClient Api { get; }
    public WorkdayService Workday { get; }
    public DayProgressService DayProgress { get; }
    public BreakService Breaks { get; }
    public MeetingService Meetings { get; }
    public ApprovalService Approvals { get; }
    public ScreenshotService Screenshots { get; }
    public ChatService Chat { get; }
    public AvatarService Avatars { get; }
    public NotificationService Notifications { get; }
    public UpdateService Updates { get; }
    public SocketChannel ScreenshotSocket { get; }

    public AgentServices(
        string apiBaseUrl,
        AgentIdentity identity,
        SessionStore sessions,
        ServerClock clock,
        IPlatform platform,
        AgentOptions options,
        ILog log,
        HttpMessageHandler? handler = null)
    {
        Api = new ApiClient(apiBaseUrl, identity, sessions, clock, log, handler);
        Workday = new WorkdayService(Api, log);
        DayProgress = new DayProgressService(Api, log);
        Breaks = new BreakService(Api, clock, log);
        Meetings = new MeetingService(Api, log);
        Approvals = new ApprovalService(Api, log);
        Screenshots = new ScreenshotService(Api, platform, options, log);
        Chat = new ChatService(Api, new SocketChannel(Api, "/chat", log), log);
        Avatars = new AvatarService(Api, log);
        Notifications = new NotificationService(new SocketChannel(Api, "/notifications", log), log);
        Updates = new UpdateService(Api, platform, options, log);
        ScreenshotSocket = new SocketChannel(Api, "/screenshots", log);
    }

    public void StopAll()
    {
        Screenshots.Stop();
        Chat.Stop();
        Notifications.Stop();
        Updates.Stop();
        ScreenshotSocket.Stop();
    }

    public void Dispose()
    {
        StopAll();
        Api.Dispose();
    }
}
