using Microsoft.Win32;
using EquinoxLocal.WindowsShell;

const string runKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
var valueName = $"Equinox Local CI {Guid.NewGuid():N}";
var root = Path.Combine(Path.GetTempPath(), $"Equinox Local Ω {Guid.NewGuid():N}");
Directory.CreateDirectory(root);
var executable = Path.Combine(root, "Equinox Local Ω.exe");
await File.WriteAllBytesAsync(executable, []);

static string? ReadRaw(string keyPath, string valueName)
{
    using var key = Registry.CurrentUser.OpenSubKey(keyPath, writable: false);
    return key?.GetValue(valueName, null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
}

try
{
    var registration = new StartupRegistration(executable, valueName);
    if (registration.Read().State != StartupRegistrationState.Disabled) throw new InvalidOperationException("startup registration was not initially disabled");

    if (registration.Enable().State != StartupRegistrationState.Enabled) throw new InvalidOperationException("startup registration did not enable");
    if (!string.Equals(ReadRaw(runKeyPath, valueName), registration.ExpectedCommand, StringComparison.Ordinal)) throw new InvalidOperationException("startup command was not exact");
    if (registration.Enable().State != StartupRegistrationState.Enabled) throw new InvalidOperationException("startup enable was not idempotent");

    using (var key = Registry.CurrentUser.CreateSubKey(runKeyPath, writable: true)!)
    {
        key.SetValue(valueName, "\"C:\\Foreign\\Other.exe\" --startup", RegistryValueKind.String);
    }
    if (registration.Read().State != StartupRegistrationState.Foreign) throw new InvalidOperationException("foreign startup owner was not detected");
    if (registration.Disable().State != StartupRegistrationState.Foreign) throw new InvalidOperationException("foreign startup owner was modified during disable");
    if (!string.Equals(ReadRaw(runKeyPath, valueName), "\"C:\\Foreign\\Other.exe\" --startup", StringComparison.Ordinal)) throw new InvalidOperationException("foreign startup value was overwritten");

    using (var key = Registry.CurrentUser.CreateSubKey(runKeyPath, writable: true)!)
    {
        key.SetValue(valueName, registration.ExpectedCommand, RegistryValueKind.String);
    }
    if (registration.Disable().State != StartupRegistrationState.Disabled) throw new InvalidOperationException("owned startup registration did not disable");
    if (ReadRaw(runKeyPath, valueName) is not null) throw new InvalidOperationException("owned startup registry value remained after disable");

    Console.WriteLine("WINDOWS_SHELL_STARTUP_REGISTRATION_PASS");
}
finally
{
    try
    {
        using var key = Registry.CurrentUser.OpenSubKey(runKeyPath, writable: true);
        key?.DeleteValue(valueName, throwOnMissingValue: false);
    }
    catch { }
    try { Directory.Delete(root, recursive: true); } catch { }
}
