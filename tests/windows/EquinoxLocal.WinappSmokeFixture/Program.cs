using System.Drawing;
using System.Windows.Forms;

namespace EquinoxLocal.WinappSmokeFixture;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        using var form = new Form
        {
            Text = "Equinox Winapp Smoke",
            Name = "EquinoxWinappSmoke",
            StartPosition = FormStartPosition.Manual,
            Location = new Point(120, 120),
            Size = new Size(520, 260),
        };

        var text = new TextBox
        {
            Name = "SmokeText",
            Text = "Initial",
            Location = new Point(24, 30),
            Size = new Size(320, 30),
        };
        var button = new Button
        {
            Name = "SmokeButton",
            Text = "Apply",
            Location = new Point(365, 28),
            Size = new Size(100, 34),
        };
        var status = new Label
        {
            Name = "SmokeStatus",
            Text = "Ready",
            Location = new Point(24, 95),
            AutoSize = true,
        };
        button.Click += (_, _) => status.Text = "Clicked";
        form.Controls.AddRange([text, button, status]);
        Application.Run(form);
    }
}
