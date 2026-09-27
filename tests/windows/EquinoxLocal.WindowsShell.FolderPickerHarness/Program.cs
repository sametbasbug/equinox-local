using EquinoxLocal.WindowsShell;

var selected = Path.Combine(Path.GetTempPath(), $"equinox-picker-{Guid.NewGuid():N}", "Project Folder");
Directory.CreateDirectory(selected);
try
{
    var picker = new NativeFolderPicker(() => new NativeFolderSelection(true, selected));
    var result = picker.PickFolder();
    if (!string.Equals(result, Path.GetFullPath(selected), StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("folder picker did not preserve the selected absolute directory");

    var cancelled = new NativeFolderPicker(() => new NativeFolderSelection(false, selected)).PickFolder();
    if (cancelled is not null) throw new InvalidOperationException("cancelled picker invented a folder");

    var root = Path.GetPathRoot(selected) ?? throw new InvalidOperationException("missing filesystem root");
    try
    {
        _ = new NativeFolderPicker(() => new NativeFolderSelection(true, root)).PickFolder();
        throw new InvalidOperationException("filesystem root was accepted");
    }
    catch (InvalidOperationException error) when (error.Message.Contains("filesystem root", StringComparison.OrdinalIgnoreCase)) { }

    var missing = Path.Combine(Path.GetTempPath(), $"equinox-picker-missing-{Guid.NewGuid():N}");
    try
    {
        _ = new NativeFolderPicker(() => new NativeFolderSelection(true, missing)).PickFolder();
        throw new InvalidOperationException("missing directory was accepted");
    }
    catch (InvalidOperationException error) when (error.Message.Contains("no longer exists", StringComparison.OrdinalIgnoreCase)) { }

    Console.WriteLine("WINDOWS_SHELL_FOLDER_PICKER_PASS");
}
finally
{
    try { Directory.Delete(Path.GetDirectoryName(selected)!, recursive: true); } catch { }
}
