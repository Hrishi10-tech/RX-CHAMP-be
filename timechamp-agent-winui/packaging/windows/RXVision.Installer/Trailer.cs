using System.Text;

namespace RXVision.Installer;

/// <summary>
/// Reads the per-user config trailer the backend appends to the downloaded exe,
/// same format as the old installer: <c>[json][uint32 LE length]["TCAGCFG1"]</c> at
/// the very end of the file. Pure stream logic, so it is unit tested with a MemoryStream.
/// </summary>
public static class Trailer
{
    private const string Magic = "TCAGCFG1";

    public static byte[]? Read(Stream stream)
    {
        var magic = Encoding.ASCII.GetBytes(Magic);
        if (!stream.CanSeek || stream.Length < magic.Length + 4) return null;

        var tail = new byte[magic.Length];
        stream.Seek(-magic.Length, SeekOrigin.End);
        stream.ReadExactly(tail);
        for (var i = 0; i < magic.Length; i++)
            if (tail[i] != magic[i]) return null; // no trailer (a generic build)

        var lenBytes = new byte[4];
        stream.Seek(-(magic.Length + 4), SeekOrigin.End);
        stream.ReadExactly(lenBytes);
        var len = BitConverter.ToUInt32(lenBytes, 0);
        if (len == 0 || len > 64 * 1024 || len + magic.Length + 4 > stream.Length) return null;

        var json = new byte[len];
        stream.Seek(-(magic.Length + 4 + (long)len), SeekOrigin.End);
        stream.ReadExactly(json);
        return json;
    }

    public static byte[]? ReadFromFile(string? path)
    {
        try
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return null;
            using var fs = File.OpenRead(path);
            return Read(fs);
        }
        catch
        {
            return null;
        }
    }
}
