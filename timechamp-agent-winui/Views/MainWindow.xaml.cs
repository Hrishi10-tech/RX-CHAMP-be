using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using TimeChampAgent.Helpers;
using TimeChampAgent.ViewModels;

namespace TimeChampAgent.Views;

public sealed partial class MainWindow : Window
{
    public DashboardViewModel ViewModel => PageHost.ViewModel;

    public MainWindow()
    {
        InitializeComponent();

   
        Title = "RX Vision";
        var tb = AppWindow.TitleBar;
        var caption = UiUtil.ColorFromHex("#F4F5FD");
        tb.BackgroundColor = caption;
        tb.InactiveBackgroundColor = caption;
        tb.ForegroundColor = UiUtil.ColorFromHex("#1A2130");
        tb.InactiveForegroundColor = UiUtil.ColorFromHex("#64748B");
        tb.ButtonBackgroundColor = caption;
        tb.ButtonInactiveBackgroundColor = caption;
        tb.ButtonForegroundColor = UiUtil.ColorFromHex("#1A2130");
        tb.ButtonHoverBackgroundColor = UiUtil.ColorFromHex("#C7D0DD");
        tb.ButtonHoverForegroundColor = UiUtil.ColorFromHex("#1A2130");
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1040, 660));

        // Hide to tray instead of closing — presence keeps running.
        AppWindow.Closing += (_, e) => { e.Cancel = true; ViewModel.StopClock(); AppWindow.Hide(); };

        Activated += (_, e) =>
        {
            if (e.WindowActivationState != WindowActivationState.Deactivated) PageHost.OnShown();
        };
    }
}
