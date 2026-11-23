using System.ComponentModel;
using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Rendering;
using RXVision.Agent.Icon;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Views;

/// <summary>
/// Draws the icon to a cached bitmap at device pixels and shows that bitmap, one pixel to one. The
/// vectors run again only when the frame or the scale changes. Opacity and the shake are the
/// compositor's and redraw nothing. The faded look's saturation is worked out from the cached
/// pixels, whole icon, avatar included. Only the circle and the badge take the pointer.
/// </summary>
public sealed class FloatingIconView : Control, ICustomHitTest
{
    private readonly TranslateTransform _shake = new();
    private BubbleViewModel? _vm;
    private RenderTargetBitmap? _drawn;
    private WriteableBitmap? _toned;
    private byte[]? _pixels;
    private double _drawnScale;
    private IconFrame _drawnFrame;
    private double _tonedSaturation = 1;
    private TopLevel? _top;

    public FloatingIconView()
    {
        Width = IconGeometry.Canvas;
        Height = IconGeometry.Canvas;
        RenderTransform = _shake;
    }

    /// <summary>How many times the vectors have run, for the tests.</summary>
    public int Draws { get; private set; }

    public void Attach(BubbleViewModel? vm)
    {
        if (_vm is not null)
        {
            _vm.PropertyChanged -= OnVmChanged;
            _vm.AvatarChanged -= OnAvatarChanged;
        }
        _vm = vm;
        if (_vm is null) return;
        _vm.PropertyChanged += OnVmChanged;
        _vm.AvatarChanged += OnAvatarChanged;
        Opacity = _vm.Opacity;
        _shake.X = _vm.ShakeX;
        Redraw(force: true);
    }

    /// <summary>The bitmap as it is shown now, for the tests.</summary>
    public Bitmap? Shown => _toned is not null && _tonedSaturation < 1 ? _toned : _drawn;

    public bool HitTest(Point point) => IconGeometry.IsOnIcon(point, _vm?.HasBadge == true);

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        _top = TopLevel.GetTopLevel(this);
        if (_top is not null) _top.ScalingChanged += OnScalingChanged;
        Redraw(force: true);
    }

    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e)
    {
        if (_top is not null) _top.ScalingChanged -= OnScalingChanged;
        _top = null;
        base.OnDetachedFromVisualTree(e);
    }

    public override void Render(DrawingContext context)
    {
        if (Shown is not { } bitmap) return;
        // Whole pixels at rest stay exact; between them, during the shake, the filter keeps it smooth.
        using var options = context.PushRenderOptions(new RenderOptions { BitmapInterpolationMode = BitmapInterpolationMode.LowQuality });
        IconBitmap.Show(context, bitmap, new Point(0, 0), _drawnScale);
    }

    private void OnScalingChanged(object? sender, EventArgs e) => Redraw(force: true);

    private void OnAvatarChanged() => Redraw(force: true);

    private void OnVmChanged(object? sender, PropertyChangedEventArgs e)
    {
        switch (e.PropertyName)
        {
            case nameof(BubbleViewModel.Frame):
                Redraw(force: false);
                break;
            case nameof(BubbleViewModel.Saturation):
                Tone();
                InvalidateVisual();
                break;
            case nameof(BubbleViewModel.Opacity):
                Opacity = _vm!.Opacity;
                break;
            case nameof(BubbleViewModel.ShakeX):
                _shake.X = _vm!.ShakeX;
                break;
        }
    }

    private void Redraw(bool force)
    {
        if (_vm is null || _top is null) return;
        var scale = _top.RenderScaling;
        if (!force && _vm.Frame == _drawnFrame && scale == _drawnScale) return;
        _drawnFrame = _vm.Frame;
        _drawnScale = scale;
        var pixels = IconGeometry.CanvasPixels(scale);
        _drawn?.Dispose();
        _drawn = IconBitmap.Draw(_vm.Frame, scale, _vm.Avatars);
        Draws++;
        _pixels = IconBitmap.CopyPixels(_drawn);
        if (_toned is null || _toned.PixelSize != pixels)
        {
            _toned?.Dispose();
            _toned = new WriteableBitmap(pixels, _drawn.Dpi, _drawn.Format ?? PixelFormat.Bgra8888, AlphaFormat.Premul);
        }
        _tonedSaturation = 1;
        Tone();
        InvalidateVisual();
    }

    private void Tone()
    {
        if (_vm is null || _pixels is null || _toned is null || _drawn is null) return;
        var saturation = _vm.Saturation;
        if (saturation == _tonedSaturation) return;
        _tonedSaturation = saturation;
        if (saturation >= 1) return;
        using var target = _toned.Lock();
        IconBitmap.Desaturate(_pixels, target, saturation, _drawn.Format ?? PixelFormat.Bgra8888);
    }
}

/// <summary>The icon's bitmap, for the view and for the render tests.</summary>
public static class IconBitmap
{
    /// <summary>One drawing at device pixels. The caller owns the bitmap.</summary>
    public static RenderTargetBitmap Draw(IconFrame frame, double scale, IIconAvatarSource avatars)
    {
        var pixels = IconGeometry.CanvasPixels(scale);
        var bitmap = new RenderTargetBitmap(pixels, new Vector(96 * scale, 96 * scale));
        using var context = bitmap.CreateDrawingContext();
        var picture = avatars.Picture((int)Math.Ceiling(IconGeometry.AvatarDiameter * scale));
        IconPainter.Paint(context, frame, scale, picture, avatars.Initials);
        return bitmap;
    }

    /// <summary>Shows the bitmap one pixel to one device pixel, at a point in device-independent pixels.</summary>
    public static void Show(DrawingContext context, Bitmap bitmap, Point at, double scale)
    {
        var size = bitmap.PixelSize;
        context.DrawImage(bitmap, new Rect(0, 0, size.Width, size.Height), new Rect(at.X, at.Y, size.Width / scale, size.Height / scale));
    }

    /// <summary>The bitmap's bytes: premultiplied, four to a pixel, top row first.</summary>
    public static byte[] CopyPixels(Bitmap bitmap)
    {
        var size = bitmap.PixelSize;
        var bytes = new byte[size.Width * size.Height * 4];
        var pin = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            bitmap.CopyPixels(new PixelRect(size), pin.AddrOfPinnedObject(), bytes.Length, size.Width * 4);
        }
        finally
        {
            pin.Free();
        }
        return bytes;
    }

    /// <summary>Writes the pixels at this share of full saturation. Premultiplied values mix the same way, so alpha never changes.</summary>
    public static void Desaturate(byte[] source, ILockedFramebuffer target, double saturation, PixelFormat format)
    {
        var redFirst = format == PixelFormat.Rgba8888;
        var red = redFirst ? 0 : 2;
        var blue = redFirst ? 2 : 0;
        var buffer = new byte[source.Length];
        for (var i = 0; i < source.Length; i += 4)
        {
            var luma = 0.2126 * source[i + red] + 0.7152 * source[i + 1] + 0.0722 * source[i + blue];
            buffer[i + red] = Channel(luma, source[i + red], saturation);
            buffer[i + 1] = Channel(luma, source[i + 1], saturation);
            buffer[i + blue] = Channel(luma, source[i + blue], saturation);
            buffer[i + 3] = source[i + 3];
        }
        var width = target.Size.Width * 4;
        for (var row = 0; row < target.Size.Height; row++)
        {
            Marshal.Copy(buffer, row * width, target.Address + row * target.RowBytes, width);
        }
    }

    private static byte Channel(double luma, byte value, double saturation) =>
        (byte)Math.Clamp(Math.Round(luma + saturation * (value - luma)), 0, 255);
}
