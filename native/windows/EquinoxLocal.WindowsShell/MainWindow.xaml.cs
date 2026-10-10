using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace EquinoxLocal.WindowsShell;

public partial class MainWindow : Window
{
    internal const string ControlCenterUrl = "http://127.0.0.1:24891/";
    private static readonly JsonSerializerOptions NativeBridgeJson = new(JsonSerializerDefaults.Web);
    private readonly NativeFolderPicker _folderPicker = new();
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
            // Never create mutable WebView2 caches beside the signed native shell.
            // An ordinary page visit must not poison native ownership checks,
            // future upgrades or managed uninstall.
            var userData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Equinox Local", "state", "webview2");
            Directory.CreateDirectory(userData);
            var webEnvironment = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
            await ControlCenterView.EnsureCoreWebView2Async(webEnvironment);
            ControlCenterView.CoreWebView2.WebMessageReceived += OnNativeWebMessageReceived;
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

    private void OnNativeWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (!IsTrustedControlCenterSource(e.Source)) return;

        NativeBridgeRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<NativeBridgeRequest>(e.TryGetWebMessageAsString(), NativeBridgeJson);
        }
        catch
        {
            return;
        }
        if (request?.Type != "equinox-folder-picker" || !IsSafeRequestId(request.RequestId)) return;

        try
        {
            var selected = _folderPicker.PickFolder();
            PostNativeBridgeResponse(new NativeBridgeResponse(
                "equinox-folder-picker-result", request.RequestId!, selected is null, selected, null));
        }
        catch (Exception error)
        {
            var message = error.Message.Length <= 240 ? error.Message : error.Message[..240];
            PostNativeBridgeResponse(new NativeBridgeResponse(
                "equinox-folder-picker-result", request.RequestId!, false, null, message));
        }
    }

    private void PostNativeBridgeResponse(NativeBridgeResponse response)
    {
        ControlCenterView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(response, NativeBridgeJson));
    }

    private static bool IsTrustedControlCenterSource(string source)
    {
        return Uri.TryCreate(source, UriKind.Absolute, out var uri)
            && string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            && string.Equals(uri.Host, "127.0.0.1", StringComparison.Ordinal)
            && uri.Port == 24891;
    }

    private static bool IsSafeRequestId(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 128) return false;
        return value.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_');
    }

    private sealed record NativeBridgeRequest(string? Type, string? RequestId);
    private sealed record NativeBridgeResponse(string Type, string RequestId, bool Cancelled, string? Path, string? Error);

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
