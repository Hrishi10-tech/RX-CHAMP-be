using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RXVision.Agent.Core.Api;

/// <summary>The backend speaks camelCase JSON; enums travel as strings.</summary>
public static class Json
{
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters =
        {
            new JsonStringEnumConverter(),
            // A field the server sends as null (or a number sent as text) reads as the
            // type's default instead of failing the whole answer: one odd field must
            // never stop the day, the breaks or the waiting list from loading.
            new LenientIntConverter(),
            new LenientBoolConverter(),
            new LenientDateTimeOffsetConverter(),
        },
    };
}

/// <summary>An int that tolerates null, a fraction or a numeric string.</summary>
internal sealed class LenientIntConverter : JsonConverter<int>
{
    public override bool HandleNull => true;

    public override int Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.Null:
                return 0;
            case JsonTokenType.Number:
                if (reader.TryGetInt32(out var whole)) return whole;
                return reader.TryGetDouble(out var d) && double.IsFinite(d)
                    ? (int)Math.Clamp(Math.Round(d), int.MinValue, int.MaxValue)
                    : 0;
            case JsonTokenType.String:
                return int.TryParse(reader.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
            default:
                throw new JsonException($"Expected a number, got {reader.TokenType}.");
        }
    }

    public override void Write(Utf8JsonWriter writer, int value, JsonSerializerOptions options) => writer.WriteNumberValue(value);
}

/// <summary>A bool that tolerates null or "true"/"false" as text.</summary>
internal sealed class LenientBoolConverter : JsonConverter<bool>
{
    public override bool HandleNull => true;

    public override bool Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) => reader.TokenType switch
    {
        JsonTokenType.True => true,
        JsonTokenType.False or JsonTokenType.Null => false,
        JsonTokenType.String => bool.TryParse(reader.GetString(), out var b) && b,
        _ => throw new JsonException($"Expected true or false, got {reader.TokenType}."),
    };

    public override void Write(Utf8JsonWriter writer, bool value, JsonSerializerOptions options) => writer.WriteBooleanValue(value);
}

/// <summary>An instant that tolerates null (read as the default) and any ISO-8601 spelling.</summary>
internal sealed class LenientDateTimeOffsetConverter : JsonConverter<DateTimeOffset>
{
    public override bool HandleNull => true;

    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return default;
        if (reader.TokenType != JsonTokenType.String) throw new JsonException($"Expected a date, got {reader.TokenType}.");
        if (reader.TryGetDateTimeOffset(out var exact)) return exact;
        return DateTimeOffset.TryParse(reader.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var loose)
            ? loose
            : default;
    }

    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) => writer.WriteStringValue(value);
}

/// <summary>
/// Text that also takes a number or a bool (as their JSON text), for a field whose type the
/// server chooses: GET /workday/me/history sends a day's weekday as a number (1 Monday to
/// 7 Sunday), and that one field failed the whole month (History never loaded). Put on the
/// property; anything else (an object, a list) reads as null.
/// </summary>
public sealed class TextOrNumberConverter : JsonConverter<string?>
{
    public override bool HandleNull => true;

    public override string? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        switch (reader.TokenType)
        {
            case JsonTokenType.String:
                return reader.GetString();
            case JsonTokenType.Number:
                using (var doc = JsonDocument.ParseValue(ref reader)) return doc.RootElement.GetRawText();
            case JsonTokenType.True:
                return "true";
            case JsonTokenType.False:
                return "false";
            case JsonTokenType.StartObject:
            case JsonTokenType.StartArray:
                reader.Skip();
                return null;
            default:
                return null;
        }
    }

    public override void Write(Utf8JsonWriter writer, string? value, JsonSerializerOptions options)
    {
        if (value is null) writer.WriteNullValue();
        else writer.WriteStringValue(value);
    }
}
