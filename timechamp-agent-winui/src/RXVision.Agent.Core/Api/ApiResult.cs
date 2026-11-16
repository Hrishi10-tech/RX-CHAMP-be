using System.Net;
using System.Text.Json;

namespace RXVision.Agent.Core.Api;

/// <summary>
/// How a call ended. The distinction is what keeps the agent alive through bad
/// networks: only a real answer from the API can end a session or drop data.
/// </summary>
public enum ApiOutcome
{
    /// <summary>2xx with the API's JSON envelope.</summary>
    Ok,
    /// <summary>The API answered and refused (4xx with its JSON error, or 413). Retrying the same request will not help.</summary>
    Rejected,
    /// <summary>The session is gone (refresh and re-enroll were both refused).</summary>
    Unauthorized,
    /// <summary>No usable answer: no network, timeout, proxy or captive portal, 408, 429, 5xx. Try again later.</summary>
    Transient,
}

public sealed class ApiResult<T>
{
    public ApiOutcome Outcome { get; init; }
    public T? Data { get; init; }
    public int Status { get; init; }
    /// <summary>The API's error code, e.g. REASON_REQUIRED.</summary>
    public string? Code { get; init; }
    /// <summary>The API's human message, safe to show.</summary>
    public string? Message { get; init; }
    public JsonElement? Details { get; init; }
    /// <summary>How long the server asks to wait before trying again (Retry-After on 429 or 503), when it says.</summary>
    public TimeSpan? RetryAfter { get; init; }

    public bool Ok => Outcome == ApiOutcome.Ok;
    public bool Transient => Outcome == ApiOutcome.Transient;

    public static ApiResult<T> Success(T? data, int status = 200) => new() { Outcome = ApiOutcome.Ok, Data = data, Status = status };

    public static ApiResult<T> TransientFailure(string message, int status = 0) =>
        new() { Outcome = ApiOutcome.Transient, Status = status, Message = message };

    public ApiResult<TOther> As<TOther>(TOther? data = default) => new()
    {
        Outcome = Outcome,
        Data = data,
        Status = Status,
        Code = Code,
        Message = Message,
        Details = Details,
        RetryAfter = RetryAfter,
    };

    public int? DetailInt(string name) =>
        Details is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty(name, out var v) && v.TryGetInt32(out var i) ? i : null;

    public string? DetailString(string name) =>
        Details is { ValueKind: JsonValueKind.Object } d && d.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>A structured detail (a list of breaks, an object), or default when it is missing or malformed.</summary>
    public TDetail? Detail<TDetail>(string name)
    {
        if (Details is not { ValueKind: JsonValueKind.Object } d || !d.TryGetProperty(name, out var v)) return default;
        try
        {
            return v.Deserialize<TDetail>(Json.Options);
        }
        catch (Exception ex) when (ex is JsonException or NotSupportedException or InvalidOperationException)
        {
            return default;
        }
    }

    /// <summary>An ISO-8601 instant from the details, or null.</summary>
    public DateTimeOffset? DetailTime(string name) =>
        DetailString(name) is { } text
        && DateTimeOffset.TryParse(text, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal, out var at)
            ? at
            : null;

    public override string ToString() => $"{Outcome} {Status} {Code} {Message}";
}

/// <summary>Turns an HTTP response into an <see cref="ApiResult{T}"/>.</summary>
internal static class ResultReader
{
    private sealed class Envelope<T>
    {
        public bool Success { get; set; }
        public T? Data { get; set; }
    }

    private sealed class ErrorEnvelope
    {
        public bool Success { get; set; }
        public string? Message { get; set; }
        public ErrorBody? Error { get; set; }
    }

    private sealed class ErrorBody
    {
        public string? Code { get; set; }
        public string? Message { get; set; }
        public JsonElement? Details { get; set; }
    }

    public static async Task<ApiResult<T>> ReadAsync<T>(HttpResponseMessage res, CancellationToken ct)
    {
        var status = (int)res.StatusCode;
        string body;
        try
        {
            body = await res.Content.ReadAsStringAsync(ct);
        }
        catch (Exception ex) when (ex is IOException or HttpRequestException or TaskCanceledException)
        {
            return ApiResult<T>.TransientFailure("The connection dropped while reading the answer.", status);
        }

        if (res.IsSuccessStatusCode)
        {
            // A 2xx that is not our envelope is a proxy or captive portal talking.
            try
            {
                var env = JsonSerializer.Deserialize<Envelope<T>>(body, Json.Options);
                if (env is { Success: true }) return ApiResult<T>.Success(env.Data, status);
            }
            catch (JsonException) { }
            return ApiResult<T>.TransientFailure("The server's answer was not understood (a network login page?).", status);
        }

        ErrorEnvelope? error = null;
        try
        {
            error = JsonSerializer.Deserialize<ErrorEnvelope>(body, Json.Options);
            if (error is { Success: true }) error = null;
        }
        catch (JsonException) { }

        var fromApi = error is not null && (error.Error is not null || error.Message is not null);
        var code = error?.Error?.Code;
        var message = error?.Error?.Message ?? error?.Message;

        // Only the API's own refusals are final. A 4xx page from a proxy is not. 409
        // EVENT_IN_PROGRESS is the server still running the first copy of a journalled
        // action (its answer was lost or late): it is decided in a moment, so ask again.
        var outcome = status switch
        {
            408 or 425 or 429 => ApiOutcome.Transient,
            409 when code == "EVENT_IN_PROGRESS" => ApiOutcome.Transient,
            >= 500 => ApiOutcome.Transient,
            413 => ApiOutcome.Rejected,
            >= 400 and < 500 when fromApi => ApiOutcome.Rejected,
            _ => ApiOutcome.Transient,
        };
        return new ApiResult<T>
        {
            Outcome = outcome,
            Status = status,
            Code = code,
            Message = message ?? (outcome == ApiOutcome.Transient ? $"The server is not available right now ({status})." : $"Refused ({status})."),
            Details = error?.Error?.Details,
            RetryAfter = RetryAfterOf(res),
        };
    }

    /// <summary>Retry-After as a wait (seconds or a date), capped at an hour; null when absent.</summary>
    internal static TimeSpan? RetryAfterOf(HttpResponseMessage res)
    {
        var header = res.Headers.RetryAfter;
        TimeSpan? wait = header?.Delta ?? (header?.Date is { } at ? at - DateTimeOffset.UtcNow : null);
        if (wait is null) return null;
        return wait < TimeSpan.Zero ? TimeSpan.Zero : wait > TimeSpan.FromHours(1) ? TimeSpan.FromHours(1) : wait;
    }

    public static bool IsJsonApiError(HttpStatusCode status, string body)
    {
        try
        {
            var error = JsonSerializer.Deserialize<ErrorEnvelope>(body, Json.Options);
            return error is { Success: false } && (error.Error is not null || error.Message is not null);
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
