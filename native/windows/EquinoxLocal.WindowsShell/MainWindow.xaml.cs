using System.ComponentModel;
using System.Diagnostics;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace EquinoxLocal.WindowsShell;

public partial class MainWindow : Window
{
    internal const string ControlCenterUrl = "http://127.0.0.1:24891/";
    private bool _fallbackOpened;
    private bool _exitRequested;

    public MainWindow()
    {
        InitializeComponent();
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            _ = CoreWebView2Environment.GetAvailableBrowserVersionString();
            await ControlCenterView.EnsureCoreWebView2Async();
            ControlCenterView.Source = new Uri(ControlCenterUrl, UriKind.Absolute);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            ShowBrowserFallback("Microsoft Edge WebView2 Runtime is unavailable. The Control Center was opened in your default browser.");
        }
        catch (Exception)
        {
            ShowBrowserFallback("The native Control Center could not start. The Control Center was opened in your default browser.");
        }
    }

    private void ShowBrowserFallback(string message)
    {
        FallbackMessage.Text = message;
        FallbackPanel.Visibility = Visibility.Visible;
        OpenControlCenterInBrowser();
    }

    private void OpenBrowserFallback(object sender, RoutedEventArgs e)
    {
        OpenControlCenterInBrowser(force: true);
    }

    internal void OpenControlCenterInBrowser(bool force = false)
    {
        if (_fallbackOpened && !force) return;
        _fallbackOpened = true;

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = ControlCenterUrl,
                UseShellExecute = true,
            });
        }
        catch
        {
            FallbackMessage.Text = $"Open {ControlCenterUrl} in your browser.";
        }
    }

    internal void ActivateFromReopen()
    {
        if (!IsVisible) Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;

        Activate();
        Topmost = true;
        Topmost = false;
        Focus();
    }

    internal void PrepareForExit()
    {
        _exitRequested = true;
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_exitRequested) return;
        e.Cancel = true;
        Hide();
    }
}
