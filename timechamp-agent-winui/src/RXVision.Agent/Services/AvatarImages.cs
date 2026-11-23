using Avalonia;
using Avalonia.Media.Imaging;
using RXVision.Agent.Core.Avatars;

namespace RXVision.Agent.Services;

/// <summary>
/// Avatars as bitmaps, read from the bundle and never from the network. Takes the next larger
/// file and scales it down with a high-quality filter (1x icon from 48, 1.5x from 64, 2x from
/// 96, 3x from 128), and keeps the scaled result, so drawing costs nothing after the first
/// time. Only the UI thread calls it.
/// </summary>
public sealed class AvatarImages
{
    /// <summary>Enough for a whole set in the picker at two scales, plus everyone in a chat.</summary>
    private const int Capacity = 96;

    private readonly AvatarLibrary _library;
    private readonly Dictionary<(string Id, int Pixels), LinkedListNode<(string Id, int Pixels, Bitmap? Image)>> _cache = new();
    private readonly LinkedList<(string Id, int Pixels, Bitmap? Image)> _recent = new();

    public AvatarImages(AvatarLibrary library) => _library = library;

    public static AvatarImages Shared { get; } = new(AvatarLibrary.Bundled);

    /// <summary>The avatar at this many physical pixels; null for an ID the manifest does not know or a file that cannot be read: the RX mark stands in.</summary>
    public Bitmap? Get(string? id, int pixels)
    {
        if (string.IsNullOrEmpty(id) || pixels <= 0) return null;
        var key = (id, pixels);
        if (_cache.TryGetValue(key, out var node))
        {
            _recent.Remove(node);
            _recent.AddFirst(node);
            return node.Value.Image;
        }
        var image = Load(id, pixels);
        _cache[key] = _recent.AddFirst((id, pixels, image));
        if (_cache.Count > Capacity && _recent.Last is { } oldest)
        {
            // Not disposed: a control may still be drawing it. It goes when nothing holds it.
            _recent.RemoveLast();
            _cache.Remove((oldest.Value.Id, oldest.Value.Pixels));
        }
        return image;
    }

    private Bitmap? Load(string id, int pixels)
    {
        var path = _library.FileFor(id, pixels);
        if (path is null) return null;
        try
        {
            var file = new Bitmap(path);
            if (file.PixelSize.Width == pixels && file.PixelSize.Height == pixels) return file;
            using (file) return file.CreateScaledBitmap(new PixelSize(pixels, pixels), BitmapInterpolationMode.HighQuality);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException or NotSupportedException)
        {
            return null;
        }
    }
}
