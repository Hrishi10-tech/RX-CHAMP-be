using System.Text.Json;
using RXVision.Agent.Core.Api;

namespace RXVision.Agent.Core.Realtime;

/// <summary>Parses socket payloads with the API's JSON conventions.</summary>
public static class Payload
{
    public static T? As<T>(JsonElement element)
    {
        try { return element.Deserialize<T>(Json.Options); }
        catch { return default; }
    }
}
