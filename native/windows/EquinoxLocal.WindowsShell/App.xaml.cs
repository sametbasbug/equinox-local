using System.Windows;

namespace EquinoxLocal.WindowsShell;

public partial class App : System.Windows.Application
{
    private SingleInstanceCoordinator? _singleInstance;
    private TrayIconController? _trayIcon;
    private RuntimeStatusMonitor? _runtimeStatus;
    private RuntimeSupervisor? _runtimeSupervisor;
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
            startRuntime: () => _ = StartRuntimeAsync(),
            restartRuntime: () => _ = RestartRuntimeAsync(),
            stopRuntime: () => _ = StopRuntimeAsync(),
            exitApplication: () => _ = ExitApplicationAsync());

        _runtimeSupervisor = RuntimeSupervisor.TryCreateFromEnvironment();
        _runtimeStatus = new RuntimeStatusMonitor();
        _trayIcon.SetRuntimeStatus(_runtimeStatus.Current);
        _runtimeStatus.StatusChanged += (_, status) =>
            Dispatcher.BeginInvoke(new Action(() => _trayIcon?.SetRuntimeStatus(status)));
        _runtimeStatus.Start();
        if (_runtimeSupervisor is not null) _ = StartRuntimeAsync();

        _window.Show();
    }

    private async Task StartRuntimeAsync()
    {
        if (_runtimeSupervisor is null) return;
        try { await _runtimeSupervisor.StartAsync(); } catch { }
    }

    private async Task RestartRuntimeAsync()
    {
        if (_runtimeSupervisor is null) return;
        try { await _runtimeSupervisor.RestartAsync(); } catch { }
    }

    private async Task StopRuntimeAsync()
    {
        if (_runtimeSupervisor is null) return;
        try { await _runtimeSupervisor.StopAsync(); } catch { }
    }

    private async Task ExitApplicationAsync()
    {
        _window?.PrepareForExit();
        if (_runtimeSupervisor is not null) await _runtimeSupervisor.StopAsync();
        _runtimeStatus?.Dispose();
        _runtimeStatus = null;
        if (_runtimeSupervisor is not null) await _runtimeSupervisor.DisposeAsync();
        _runtimeSupervisor = null;
        _trayIcon?.Dispose();
        _trayIcon = null;
        Shutdown();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _runtimeStatus?.Dispose();
        _runtimeStatus = null;
        if (_runtimeSupervisor is not null)
        {
            _runtimeSupervisor.DisposeAsync().AsTask().GetAwaiter().GetResult();
            _runtimeSupervisor = null;
        }
        _trayIcon?.Dispose();
        _trayIcon = null;
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
