using Microsoft.Win32;

namespace EquinoxLocal.WindowsShell;

internal enum StartupRegistrationState
{
    Disabled,
    Enabled,
    Foreign,
}

internal sealed record StartupRegistrationSnapshot(StartupRegistrationState State, string Detail);

internal sealed class StartupRegistration
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string DefaultValueName = "Equinox Local";

    private readonly string _executablePath;
    private readonly string _valueName;

    internal StartupRegistration(string? executablePath = null, string? valueName = null)
    {
        var candidate = executablePath ?? Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(candidate) || !Path.IsPathFullyQualified(candidate))
        {
            throw new InvalidOperationException("A trusted absolute Windows shell path is required for startup registration.");
        }
        if (candidate.Contains('"'))
        {
            throw new InvalidOperationException("Windows shell path cannot contain a quote character.");
        }

        var name = string.IsNullOrWhiteSpace(valueName) ? DefaultValueName : valueName.Trim();
        if (name.Length > 120 || name.IndexOfAny(['\0', '\r', '\n']) >= 0)
        {
            throw new InvalidOperationException("Startup registration value name is invalid.");
        }

        _executablePath = Path.GetFullPath(candidate);
        _valueName = name;
    }

    internal string ExpectedCommand => $"\"{_executablePath}\" --startup";

    internal StartupRegistrationSnapshot Read()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
        if (key is null) return Disabled();

        object? raw;
        try
        {
            raw = key.GetValue(_valueName, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
        }
        catch
        {
            return Foreign("Startup registration could not be read safely");
        }

        if (raw is null) return Disabled();
        if (raw is string command && string.Equals(command, ExpectedCommand, StringComparison.OrdinalIgnoreCase))
        {
            return Enabled();
        }
        return Foreign("Startup registration is owned by another command");
    }

    internal StartupRegistrationSnapshot Enable()
    {
        var current = Read();
        if (current.State == StartupRegistrationState.Foreign) return current;

        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true)
            ?? throw new InvalidOperationException("Could not open the per-user startup registry key.");
        key.SetValue(_valueName, ExpectedCommand, RegistryValueKind.String);
        return Read();
    }

    internal StartupRegistrationSnapshot Disable()
    {
        var current = Read();
        if (current.State == StartupRegistrationState.Foreign) return current;
        if (current.State == StartupRegistrationState.Disabled) return current;

        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
        key?.DeleteValue(_valueName, throwOnMissingValue: false);
        return Read();
    }

    private static StartupRegistrationSnapshot Disabled() =>
        new(StartupRegistrationState.Disabled, "Start at login is disabled");

    private static StartupRegistrationSnapshot Enabled() =>
        new(StartupRegistrationState.Enabled, "Start at login is enabled");

    private static StartupRegistrationSnapshot Foreign(string detail) =>
        new(StartupRegistrationState.Foreign, detail);
}
