using System.Windows;

namespace EquinoxLocal.WindowsShell;

public partial class App : System.Windows.Application
{
    private SingleInstanceCoordinator? _singleInstance;
    private TrayIconController? _trayIcon;
    private MainWindow? _window;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _singleInstance = new SingleInstanceCoordinator();
        if (!_singleInstance.IsPrimary)
        {
            try
            {
                _singleInstance.SignalPrimaryAsync().GetAwaiter().GetResult();
            }
            catch
            {
                // A second process must never become a competing shell merely because
                // the primary is still starting. The next explicit launch can retry.
            }
            finally
            {
                Shutdown();
            }
            return;
        }

        _window = new MainWindow();
        MainWindow = _window;
        _singleInstance.ReopenRequested += (_, _) =>
            Dispatcher.BeginInvoke(new Action(_window.ActivateFromReopen));
        _singleInstance.StartListening();

        _trayIcon = new TrayIconController(
            openControlCenter: () => Dispatcher.BeginInvoke(new Action(_window.ActivateFromReopen)),
            openBrowser: () => Dispatcher.BeginInvoke(new Action(() => _window.OpenControlCenterInBrowser(force: true))),
            exitApplication: () => Dispatcher.BeginInvoke(new Action(ExitApplication)));

        _window.Show();
    }

    private void ExitApplication()
    {
        _window?.PrepareForExit();
        _trayIcon?.Dispose();
        _trayIcon = null;
        Shutdown();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _trayIcon?.Dispose();
        _trayIcon = null;
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
