using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Media.Imaging;

namespace RXVision.Agent.Controls;

/// <summary>A person's circle wherever one shows: their chosen avatar, else the RX mark.</summary>
public sealed class PersonAvatar : Control
{
    public static readonly StyledProperty<string?> AvatarIdProperty =
        AvaloniaProperty.Register<PersonAvatar, string?>(nameof(AvatarId));

    static PersonAvatar() => AffectsRender<PersonAvatar>(AvatarIdProperty);

    public PersonAvatar() => RenderOptions.SetBitmapInterpolationMode(this, BitmapInterpolationMode.HighQuality);

    /// <summary>The manifest's ID, or null: the RX mark.</summary>
    public string? AvatarId
    {
        get => GetValue(AvatarIdProperty);
        set => SetValue(AvatarIdProperty, value);
    }

    public override void Render(DrawingContext context)
    {
        var size = Math.Min(Bounds.Width, Bounds.Height);
        if (size <= 0) return;
        var circle = new Rect((Bounds.Width - size) / 2, (Bounds.Height - size) / 2, size, size);
        AvatarPainter.Draw(context, circle, AvatarId, TopLevel.GetTopLevel(this)?.RenderScaling ?? 1);
    }
}
