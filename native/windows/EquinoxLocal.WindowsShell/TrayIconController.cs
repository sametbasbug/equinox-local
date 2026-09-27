using System.Drawing;
using System.Windows.Forms;

namespace EquinoxLocal.WindowsShell;

internal sealed class TrayIconController : IDisposable
{
    private readonly ContextMenuStrip _menu;
    private readonly NotifyIcon _notifyIcon;
    private readonly ToolStripMenuItem _runtimeStatusItem;
    private readonly ToolStripMenuItem _startupItem;

    internal TrayIconController(Action openControlCenter, Action openBrowser, Action startRuntime, Action restartRuntime, Action stopRuntime, Action toggleStartup, Action exitApplication)
    {
        _menu = new ContextMenuStrip();
        _runtimeStatusItem = new ToolStripMenuItem("Runtime: Checking") { Enabled = false };
        _menu.Items.Add(_runtimeStatusItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(new ToolStripMenuItem("Open Control Center", null, (_, _) => openControlCenter()));
        _menu.Items.Add(new ToolStripMenuItem("Open in browser", null, (_, _) => openBrowser()));
        _startupItem = new ToolStripMenuItem("Start at login", null, (_, _) => toggleStartup());
        _menu.Items.Add(_startupItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(new ToolStripMenuItem("Start Runtime", null, (_, _) => startRuntime()));
        _menu.Items.Add(new ToolStripMenuItem("Restart Runtime", null, (_, _) => restartRuntime()));
        _menu.Items.Add(new ToolStripMenuItem("Stop Runtime", null, (_, _) => stopRuntime()));
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(new ToolStripMenuItem("Exit Equinox Local", null, (_, _) => exitApplication()));

        _notifyIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Equinox Local",
            ContextMenuStrip = _menu,
            Visible = true,
        };
        _notifyIcon.DoubleClick += (_, _) => openControlCenter();
    }

    internal void SetRuntimeStatus(RuntimeHealthSnapshot status)
    {
        var label = status.State switch
        {
            RuntimeHealthState.Healthy => "Healthy",
            RuntimeHealthState.Unavailable => "Unavailable",
            _ => "Checking",
        };
        _runtimeStatusItem.Text = $"Runtime: {label}";
        _notifyIcon.Text = $"Equinox Local · {label}";
    }

    internal void SetStartupStatus(StartupRegistrationSnapshot status)
    {
        _startupItem.Checked = status.State == StartupRegistrationState.Enabled;
        _startupItem.Enabled = status.State != StartupRegistrationState.Foreign;
        _startupItem.Text = status.State == StartupRegistrationState.Foreign
            ? "Start at login (registration conflict)"
            : "Start at login";
        _startupItem.ToolTipText = status.Detail;
    }

    public void Dispose()
    {
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _menu.Dispose();
    }
}
