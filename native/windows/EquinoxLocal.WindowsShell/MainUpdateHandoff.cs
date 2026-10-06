using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace EquinoxLocal.WindowsShell;

internal static partial class MainUpdateHandoff
{
    private const long MaxStateBytes = 64 * 1024;

    [GeneratedRegex(@"^main-[a-f0-9]{32}$", RegexOptions.CultureInvariant)]
    private static partial Regex TransactionPattern();

    [GeneratedRegex(@"^[a-f0-9]{40}$", RegexOptions.CultureInvariant)]
    private static partial Regex ShaPattern();

    internal static int Launch(string transactionId)
    {
        if (!TransactionPattern().IsMatch(transactionId))
            throw new InvalidDataException("Main update transaction id is invalid.");

        var bootstrap = WindowsManagedReleaseLocator.ResolveCurrentRelease();
        var installRoot = bootstrap.InstallRoot
            ?? throw new InvalidDataException("Managed installation root is unavailable.");
        var transactionRoot = Path.GetFullPath(Path.Combine(installRoot, "state", "main-update"));
        RequireNormalDirectory(transactionRoot, "Main update state directory");
        ValidateInstallStamp(Path.Combine(transactionRoot, "install.json"));

        var active = ReadState(Path.Combine(transactionRoot, "active.json"), "Main update active marker");
        RequireExactProperties(active, ["schemaVersion", "transactionId", "channel", "currentSha", "targetSha", "startedAt"], "Main update active marker");
        RequireInt(active, "schemaVersion", 1);
        RequireString(active, "transactionId", transactionId);
        RequireString(active, "channel", "main");
        var currentSha = RequireSha(active, "currentSha");
        var targetSha = RequireSha(active, "targetSha");

        var receiptPath = Path.Combine(transactionRoot, "receipts", $"{transactionId}.json");
        var receipt = ReadState(receiptPath, "Main update receipt");
        RequireExactProperties(receipt, [
            "schemaVersion", "transactionId", "channel", "status", "stage", "currentSha", "targetSha",
            "rollbackSha", "rollbackSourceRoot", "targetSourceRoot", "startedAt", "updatedAt", "lastError"
        ], "Main update receipt");
        RequireInt(receipt, "schemaVersion", 1);
        RequireString(receipt, "transactionId", transactionId);
        RequireString(receipt, "channel", "main");
        RequireString(receipt, "currentSha", currentSha);
        RequireString(receipt, "targetSha", targetSha);
        RequireString(receipt, "rollbackSha", currentSha);
        ValidateResumableStage(receipt);

        var sourcesRoot = Path.GetFullPath(Path.Combine(transactionRoot, "sources"));
        RequireNormalDirectory(sourcesRoot, "Main update source store");
        var rollbackSourceRoot = RequireExactSourceRoot(receipt, "rollbackSourceRoot", sourcesRoot, currentSha);
        var targetSourceRoot = RequireExactSourceRoot(receipt, "targetSourceRoot", sourcesRoot, targetSha);
        var workerPath = RequireNormalFile(
            Path.Combine(targetSourceRoot, "src", "equinox-local-main-update-worker.js"),
            "Main update worker");

        var nodePath = RequireNormalFile(
            Path.Combine(bootstrap.ReleaseDir, "runtime", "node", "bin", "node.exe"),
            "managed Node runtime");
        var startInfo = new ProcessStartInfo(nodePath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = targetSourceRoot,
        };
        startInfo.ArgumentList.Add(workerPath);
        startInfo.ArgumentList.Add("--transaction-id");
        startInfo.ArgumentList.Add(transactionId);
        startInfo.ArgumentList.Add("--source-root");
        startInfo.ArgumentList.Add(rollbackSourceRoot);
        startInfo.ArgumentList.Add("--transaction-root");
        startInfo.ArgumentList.Add(transactionRoot);
        var systemRoot = Environment.GetEnvironmentVariable("SystemRoot");
        if (string.IsNullOrWhiteSpace(systemRoot))
            throw new InvalidDataException("SystemRoot is unavailable for the Main update handoff.");
        var system32 = Path.Combine(systemRoot, "System32");
        var powershellDirectory = Path.Combine(system32, "WindowsPowerShell", "v1.0");
        RequireNormalFile(Path.Combine(powershellDirectory, "powershell.exe"), "Windows PowerShell runtime");
        var gitPath = ResolveGitExecutable(systemRoot);
        var gitDirectory = Path.GetDirectoryName(gitPath)
            ?? throw new InvalidDataException("Git executable directory is unavailable.");

        startInfo.Environment.Clear();
        CopyEnvironment(startInfo, "USERPROFILE");
        CopyEnvironment(startInfo, "LOCALAPPDATA");
        CopyEnvironment(startInfo, "SystemRoot");
        CopyEnvironment(startInfo, "WINDIR");
        CopyEnvironment(startInfo, "TEMP");
        CopyEnvironment(startInfo, "TMP");
        startInfo.Environment["PATH"] = string.Join(Path.PathSeparator, [gitDirectory, powershellDirectory, system32, systemRoot]);
        startInfo.Environment["EQUINOX_LOCAL_INSTALL_ROOT"] = installRoot;
        startInfo.Environment["EQUINOX_LOCAL_RELEASE_DIR"] = bootstrap.ReleaseDir;

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Main update worker did not start.");
        return process.Id;
    }

    private static string ResolveGitExecutable(string systemRoot)
    {
        var wherePath = RequireNormalFile(Path.Combine(systemRoot, "System32", "where.exe"), "Windows where executable");
        var startInfo = new ProcessStartInfo(wherePath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("git.exe");
        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Git discovery process did not start.");
        if (!process.WaitForExit(5_000))
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            throw new InvalidDataException("Git discovery timed out for the Main update handoff.");
        }
        if (process.ExitCode != 0)
            throw new InvalidDataException("Git is unavailable for the Main update handoff.");

        var output = process.StandardOutput.ReadToEnd();
        foreach (var raw in output.Split(['', '
'], StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = raw.Trim();
            if (!Path.IsPathFullyQualified(candidate)) continue;
            try { return RequireNormalFile(candidate, "Git executable"); }
            catch (InvalidDataException) { }
        }
        throw new InvalidDataException("Git discovery did not return a safe executable.");
    }

    private static void ValidateInstallStamp(string stampPath)
    {
        var stamp = ReadState(stampPath, "managed-source install stamp");
        RequireExactProperties(stamp, ["schemaVersion", "channel", "repository", "branch", "bootstrapSha"], "managed-source install stamp");
        RequireInt(stamp, "schemaVersion", 1);
        RequireString(stamp, "channel", "main");
        RequireString(stamp, "repository", "sametbasbug/equinox-local");
        RequireString(stamp, "branch", "main");
        _ = RequireSha(stamp, "bootstrapSha");
    }

    private static void ValidateResumableStage(JsonElement receipt)
    {
        var status = receipt.GetProperty("status").GetString();
        var stage = receipt.GetProperty("stage").GetString();
        var valid = (status, stage) switch
        {
            ("promoting", "ready_to_switch") => true,
            ("promoting", "native_rollback_ready") => true,
            ("promoting", "native_switched") => true,
            ("verifying", "source_switched") => true,
            ("verifying", "rollback_source_restored") => true,
            ("verifying", "rollback_native_restored") => true,
            _ => false,
        };
        if (!valid) throw new InvalidDataException("Main update receipt is not resumable.");
    }

    private static string RequireExactSourceRoot(JsonElement receipt, string name, string sourcesRoot, string sha)
    {
        var value = receipt.GetProperty(name).GetString();
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value))
            throw new InvalidDataException($"Main update {name} is invalid.");
        var resolved = Path.GetFullPath(value);
        var expected = Path.GetFullPath(Path.Combine(sourcesRoot, sha));
        if (!string.Equals(resolved, expected, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException($"Main update {name} escaped the canonical source store.");
        RequireNormalDirectory(resolved, $"Main update {name}");
        return resolved;
    }

    private static JsonElement ReadState(string filePath, string label)
    {
        var path = RequireNormalFile(filePath, label);
        var info = new FileInfo(path);
        if (info.Length is < 2 or > MaxStateBytes)
            throw new InvalidDataException($"{label} has an invalid size.");
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        return document.RootElement.Clone();
    }

    private static string RequireNormalFile(string filePath, string label)
    {
        var fullPath = Path.GetFullPath(filePath);
        var info = new FileInfo(fullPath);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException($"{label} is missing or unsafe.");
        return fullPath;
    }

    private static string RequireNormalDirectory(string directoryPath, string label)
    {
        var fullPath = Path.GetFullPath(directoryPath);
        var info = new DirectoryInfo(fullPath);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException($"{label} is missing or unsafe.");
        return fullPath;
    }

    private static void RequireExactProperties(JsonElement value, string[] expected, string label)
    {
        if (value.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException($"{label} must be a JSON object.");
        var actual = value.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToArray();
        var wanted = expected.Order(StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(wanted, StringComparer.Ordinal))
            throw new InvalidDataException($"{label} contains missing or unsupported fields.");
    }

    private static void RequireInt(JsonElement value, string name, int expected)
    {
        if (value.GetProperty(name).GetInt32() != expected)
            throw new InvalidDataException($"Main update {name} is invalid.");
    }

    private static void RequireString(JsonElement value, string name, string expected)
    {
        if (!string.Equals(value.GetProperty(name).GetString(), expected, StringComparison.Ordinal))
            throw new InvalidDataException($"Main update {name} is invalid.");
    }

    private static string RequireSha(JsonElement value, string name)
    {
        var sha = value.GetProperty(name).GetString();
        if (sha is null || !ShaPattern().IsMatch(sha))
            throw new InvalidDataException($"Main update {name} is invalid.");
        return sha;
    }

    private static void CopyEnvironment(ProcessStartInfo startInfo, string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        if (!string.IsNullOrWhiteSpace(value)) startInfo.Environment[name] = value;
    }
}
