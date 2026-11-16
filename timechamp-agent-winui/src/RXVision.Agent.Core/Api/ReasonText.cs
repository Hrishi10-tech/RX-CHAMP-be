using System.Text;

namespace RXVision.Agent.Core.Api;

/// <summary>
/// A reason or comment as the server stores and counts it (its cleanReason): every run
/// of whitespace, line breaks included, becomes one space, and the ends are trimmed.
/// The agent counts and sends this, so a box it accepts is never refused as too short
/// ("Too    short" is 9 characters to the server, not 12).
/// </summary>
public static class ReasonText
{
    public static string Clean(string? text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var sb = new StringBuilder(text.Length);
        var pendingSpace = false;
        foreach (var ch in text)
        {
            if (IsSpace(ch))
            {
                pendingSpace = sb.Length > 0;
                continue;
            }
            if (pendingSpace) sb.Append(' ');
            pendingSpace = false;
            sb.Append(ch);
        }
        return sb.ToString();
    }

    /// <summary>The characters JavaScript's \s matches (what the server collapses).</summary>
    private static bool IsSpace(char ch) => (int)ch switch
    {
        0x20 or 0x09 or 0x0A or 0x0B or 0x0C or 0x0D or 0xA0 or 0x1680 or 0x2028 or 0x2029 or 0x202F or 0x205F or 0x3000 or 0xFEFF => true,
        >= 0x2000 and <= 0x200A => true,
        _ => false,
    };
}
