using Avalonia;
using Avalonia.Controls;
using Avalonia.Media;
using RXVision.Agent.Icon;
using RXVision.Agent.ViewModels;

namespace RXVision.Agent.Views;

/// <summary>
/// The floating icon's face in the panel at 64 px: the same painter, avatar and numbers under a
/// scale of 64 / 56. With a shift, the ring is the shift's clock with the breaks marked (see
/// <see cref="DayRing"/>); with none, it reads the same value as the panel's lines.
/// </summary>
public sealed class PanelIcon : Control
{
    public static readonly StyledProperty<PanelIconState?> StateProperty =
        AvaloniaProperty.Register<PanelIcon, PanelIconState?>(nameof(State));

    public static readonly StyledProperty<IIconAvatarSource?> AvatarsProperty =
        AvaloniaProperty.Register<PanelIcon, IIconAvatarSource?>(nameof(Avatars));

    private IIconAvatarSource? _listening;

    static PanelIcon() => AffectsRender<PanelIcon>(StateProperty, AvatarsProperty);

    public PanelIconState? State
    {
        get => GetValue(StateProperty);
        set => SetValue(StateProperty, value);
    }

    public IIconAvatarSource? Avatars
    {
        get => GetValue(AvatarsProperty);
        set => SetValue(AvatarsProperty, value);
    }

    protected override void OnAttachedToVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnAttachedToVisualTree(e);
        Listen(Avatars);
    }

    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e)
    {
        Listen(null);
        base.OnDetachedFromVisualTree(e);
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == AvatarsProperty && TopLevel.GetTopLevel(this) is not null) Listen(Avatars);
    }

    private void Listen(IIconAvatarSource? source)
    {
        if (_listening is not null) _listening.Changed -= OnAvatarChanged;
        _listening = source;
        if (_listening is not null) _listening.Changed += OnAvatarChanged;
    }

    private void OnAvatarChanged() => InvalidateVisual();

    public override void Render(DrawingContext context)
    {
        var k = Math.Min(Bounds.Width, Bounds.Height) / IconGeometry.Box;
        if (State is not { } state || k <= 0) return;
        var scale = (TopLevel.GetTopLevel(this)?.RenderScaling ?? 1) * k;
        var picture = Avatars?.Picture((int)Math.Ceiling(IconGeometry.AvatarDiameter * scale));
        var fit = Matrix.CreateTranslation(-IconGeometry.Margin, -IconGeometry.Margin) * Matrix.CreateScale(k, k);
        using var transform = context.PushTransform(fit);
        IconPainter.Paint(context, state.Frame, scale, picture, Avatars?.Initials ?? state.Initials, state.Break, state.Day);
    }
}
