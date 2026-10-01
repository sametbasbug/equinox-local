using System.IO;
using System.Text;

namespace EquinoxLocal.WindowsShell;

internal static class WindowsShellDiagnostics
{
    internal const string RuntimeFailureLogName = "windows-shell-runtime.log";
    private const int MaxMessageChars = 1_500;
    private const long MaxLogBytes = 64 * 1024;

    internal static void RecordRuntimeFailure(string operation, Exception error) =>
        RecordLine(operation, $"{Clean(error.GetType().Name, 120)}: {Clean(error.Message, MaxMessageChars)}");

    internal static void RecordRuntimeState(string operation, string detail) =>
        RecordLine(operation, Clean(detail, MaxMessageChars));

    private static void RecordLine(string operation, string detail)
    {
        try
        {
            var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrWhiteSpace(localAppData)) return;
            var logsRoot = Path.Combine(localAppData, "Equinox Local", "logs");
            Directory.CreateDirectory(logsRoot);
            var logPath = Path.Combine(logsRoot, RuntimeFailureLogName);
            TrimIfNeeded(logPath);
            var line = $"{DateTimeOffset.UtcNow:O} {Clean(operation, 80)} {detail}{Environment.NewLine}";
            File.AppendAllText(logPath, line, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
        catch
        {
            // Diagnostics must never make shell lifecycle handling fail.
        }
    }

    private static string Clean(string value, int maxChars)
    {
        var builder = new StringBuilder(Math.Min(value.Length, maxChars));
        foreach (var character in value)
        {
            if (builder.Length >= maxChars) break;
            builder.Append(char.IsControl(character) ? ' ' : character);
        }
        return builder.ToString().Trim();
    }

    private static void TrimIfNeeded(string logPath)
    {
        var info = new FileInfo(logPath);
        if (!info.Exists || info.Length <= MaxLogBytes) return;
        using var input = new FileStream(logPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var keep = (int)Math.Min(MaxLogBytes / 2, input.Length);
        input.Seek(-keep, SeekOrigin.End);
        var tail = new byte[keep];
        var read = input.Read(tail, 0, keep);
        input.Close();
        File.WriteAllBytes(logPath, tail.AsSpan(0, read).ToArray());
    }
}
