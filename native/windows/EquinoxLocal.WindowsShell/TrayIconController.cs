using System.Drawing;
using System.Windows.Forms;

namespace EquinoxLocal.WindowsShell;

internal sealed class TrayIconController : IDisposable
{
    private readonly ContextMenuStrip _menu;
    private readonly NotifyIcon _notifyIcon;

    internal TrayIconController(Action openControlCenter, Action openBrowser, Action exitApplication)
    {
        _menu = new ContextMenuStrip();
        _menu.Items.Add(new ToolStripMenuItem("Open Control Center", null, (_, _) => openControlCenter()));
        _menu.Items.Add(new ToolStripMenuItem("Open in browser", null, (_, _) => openBrowser()));
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

    public void Dispose()
    {
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _menu.Dispose();
    }
}
