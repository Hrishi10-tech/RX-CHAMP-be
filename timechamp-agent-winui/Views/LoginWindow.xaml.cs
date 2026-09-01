using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;

namespace TimeChampAgent.Views;

public sealed partial class LoginWindow : Window
{
    public LoginWindow()
    {
        InitializeComponent();
        Title = "RX Vision — Sign in";
        AppWindow.Resize(new Windows.Graphics.SizeInt32(420, 520));
    }
}
