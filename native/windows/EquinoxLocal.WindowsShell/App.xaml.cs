using System.Windows;

namespace EquinoxLocal.WindowsShell;

public partial class App : System.Windows.Application
{
    private SingleInstanceCoordinator? _singleInstance;
    private TrayIconController? _trayIcon;
    private ShellPresentationMonitor? _presentationStatus;
    private RuntimeSupervisor? _runtimeSupervisor;
    private StartupRegistration? _startupRegistration;
    private MainWindow? _window;
    private bool _startedAtLogin;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        _startedAtLogin = e.Args.Any(arg => string.Equals(arg, "--startup", StringComparison.OrdinalIgnoreCase));

        _singleInstance = new SingleInstanceCoordinator();
        if (!_singleInstance.IsPrimary)
        {
            try
            {
                if (!_startedAtLogin) _singleInstance.SignalPrimaryAsync().GetAwaiter().GetResult();
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
        _singleInstance.RuntimeRestartRequested += (_, _) =>
            Dispatcher.BeginInvoke(new Action(() => _ = RestartRuntimeAsync()));
        _singleInstance.UpdateShutdownRequested += (_, _) =>
            Dispatcher.BeginInvoke(new Action(() => _ = ExitApplicationAsync()));
        _singleInstance.StartListening();

        _startupRegistration = new StartupRegistration();
        var startupStatus = _startupRegistration.Read();

        _trayIcon = new TrayIconController(
            openControlCenter: () => Dispatcher.BeginInvoke(new Action(_window.ActivateFromReopen)),
            openBrowser: () => Dispatcher.BeginInvoke(new Action(() => _window.OpenControlCenterInBrowser(force: true))),
            startRuntime: () => _ = StartRuntimeAsync(),
            restartRuntime: () => _ = RestartRuntimeAsync(),
            stopRuntime: () => _ = StopRuntimeAsync(),
            toggleStartup: ToggleStartupRegistration,
            exitApplication: () => _ = ExitApplicationAsync());

        _trayIcon.SetStartupStatus(startupStatus);

        _runtimeSupervisor = RuntimeSupervisor.TryCreateFromEnvironmentOrManagedInstall();
        _presentationStatus = new ShellPresentationMonitor();
        _trayIcon.SetPresentationStatus(_presentationStatus.Current);
        _presentationStatus.StatusChanged += (_, status) =>
            Dispatcher.BeginInvoke(new Action(() => _trayIcon?.SetPresentationStatus(status)));
        _presentationStatus.Start();
        if (_runtimeSupervisor is not null) _ = StartRuntimeAsync();

        if (!_startedAtLogin) _window.Show();
    }

    private void ToggleStartupRegistration()
    {
        if (_startupRegistration is null) return;
        var current = _startupRegistration.Read();
        var next = current.State == StartupRegistrationState.Enabled
            ? _startupRegistration.Disable()
            : _startupRegistration.Enable();
        _trayIcon?.SetStartupStatus(next);
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
        _presentationStatus?.Dispose();
        _presentationStatus = null;
        if (_runtimeSupervisor is not null) await _runtimeSupervisor.DisposeAsync();
        _runtimeSupervisor = null;
        _trayIcon?.Dispose();
        _trayIcon = null;
        Shutdown();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _presentationStatus?.Dispose();
        _presentationStatus = null;
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
