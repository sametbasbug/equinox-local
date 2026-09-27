using System.IO;
using System.Windows.Forms;

namespace EquinoxLocal.WindowsShell;

internal readonly record struct NativeFolderSelection(bool Accepted, string? Path);

internal sealed class NativeFolderPicker
{
    private readonly Func<NativeFolderSelection> _select;

    internal NativeFolderPicker(Func<NativeFolderSelection>? selector = null)
    {
        _select = selector ?? ShowNativeDialog;
    }

    internal string? PickFolder()
    {
        var selection = _select();
        if (!selection.Accepted) return null;
        if (string.IsNullOrWhiteSpace(selection.Path))
            throw new InvalidOperationException("The native folder picker returned an empty path.");

        var fullPath = Path.GetFullPath(selection.Path.Trim());
        if (!Directory.Exists(fullPath))
            throw new InvalidOperationException("The selected folder no longer exists.");

        var root = Path.GetPathRoot(fullPath);
        if (!string.IsNullOrWhiteSpace(root)
            && string.Equals(
                fullPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("The filesystem root cannot be granted to Equinox Local.");
        }

        var attributes = File.GetAttributes(fullPath);
        if ((attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidOperationException("The selected folder must not be a reparse point.");

        return fullPath;
    }

    private static NativeFolderSelection ShowNativeDialog()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "Choose a folder for Equinox Local",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
        };
        var result = dialog.ShowDialog();
        return new NativeFolderSelection(result == DialogResult.OK, dialog.SelectedPath);
    }
}
