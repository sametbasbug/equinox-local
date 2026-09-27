using System.Windows;

namespace EquinoxLocal.WindowsShell;

public partial class App : Application
{
    private SingleInstanceCoordinator? _singleInstance;

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

        var window = new MainWindow();
        MainWindow = window;
        _singleInstance.ReopenRequested += (_, _) =>
            Dispatcher.BeginInvoke(new Action(window.ActivateFromReopen));
        _singleInstance.StartListening();
        window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
