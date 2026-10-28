using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace EquinoxLocal.NativeShared;

/// <summary>
/// ONE exact Windows signed-native worker argv/path contract used by the
/// ORIGINAL WPF handoff and ORIGINAL Guardian. Pure inspection ONLY.
/// Signing, OS PID/start identity, journal HMAC, Guardian IPC and native
/// switch authority are separate mandatory checks: this does NOT grant any.
/// </summary>
internal static class MainSignedNativeWorkerContract
{
    private static readonly Regex Transaction = new(
        @"\Amain-[a-f0-9]{32}\z", RegexOptions.CultureInvariant);
    private static readonly Regex SourceSha = new(
        @"\A[a-f0-9]{40}\z", RegexOptions.CultureInvariant);
    private static readonly StringComparer Paths = StringComparer.OrdinalIgnoreCase;

    internal sealed record Expected(
        string InstallRoot, string TransactionRoot, string ReleaseDir,
        string NodePath, string WorkerPath, string[] OsArgv);

    internal static Expected ForSignedNativeB(string transactionId, string sourceSha,
        string target, string transactionRoot)
    {
        var hostTarget = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Original native Main worker CPU unsupported."),
        };
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (!Transaction.IsMatch(transactionId) ||
            !SourceSha.IsMatch(sourceSha) || !string.Equals(target, hostTarget, StringComparison.Ordinal) ||
            string.IsNullOrEmpty(local) || !Path.IsPathFullyQualified(local) ||
            string.IsNullOrEmpty(transactionRoot) || !Path.IsPathFullyQualified(transactionRoot) ||
            transactionRoot.Contains('\0') || transactionRoot.Contains('\r') ||
            transactionRoot.Contains('\n') ||
            !Paths.Equals(Path.GetFullPath(transactionRoot), transactionRoot))
            throw new InvalidDataException("Signed-native worker has no canonical original Main identity.");

        var installRoot = Path.GetFullPath(Path.Combine(local, "Equinox Local"));
        var expectedRoot = Path.Combine(installRoot, "state", "main-update");
        if (!Paths.Equals(transactionRoot, expectedRoot))
            throw new InvalidDataException("Signed-native worker escaped its single original product state.");

        var releaseDir = Path.Combine(expectedRoot, "native-store", target, sourceSha, "release");
        var node = Path.Combine(releaseDir, "runtime", "node", "bin", "node.exe");
        var worker = Path.Combine(releaseDir, "equinox-local-main-update-worker.js");
        return new Expected(installRoot, expectedRoot, releaseDir, node, worker,
        [
            node, worker, "--signed-native", "--transaction-id", transactionId,
            "--transaction-root", expectedRoot,
        ]);
    }

    internal static void ValidateOsArgv(string[] actual, Expected expected)
    {
        if (actual is null || actual.Length != expected.OsArgv.Length)
            throw new InvalidDataException("Signed-native worker OS argument count differs from original WPF contract.");
        for (var i = 0; i < actual.Length; i++)
        {
            var same = i is 0 or 1 or 6
                ? Paths.Equals(actual[i], expected.OsArgv[i]) &&
                  Path.IsPathFullyQualified(actual[i]) &&
                  Paths.Equals(Path.GetFullPath(actual[i]), expected.OsArgv[i])
                : string.Equals(actual[i], expected.OsArgv[i], StringComparison.Ordinal);
            if (!same)
                throw new InvalidDataException("Signed-native worker OS argv differs from its exact original release contract.");
        }
    }

    internal static void ValidateOriginalReleaseFiles(Expected expected)
    {
        foreach (var directory in new[] {
            expected.InstallRoot,
            Path.Combine(expected.InstallRoot, "state"),
            expected.TransactionRoot,
            Path.Combine(expected.TransactionRoot, "native-store"),
            Path.GetDirectoryName(Path.GetDirectoryName(expected.ReleaseDir))!,
            Path.GetDirectoryName(expected.ReleaseDir)!,
            expected.ReleaseDir,
            Path.Combine(expected.ReleaseDir, "runtime"),
            Path.Combine(expected.ReleaseDir, "runtime", "node"),
            Path.Combine(expected.ReleaseDir, "runtime", "node", "bin"),
        })
        {
            var info = new DirectoryInfo(directory);
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Signed-native worker immutable release directory is missing or redirected.");
        }
        var selector = Path.Combine(Path.GetDirectoryName(expected.ReleaseDir)!, "signed-selector.json");
        var storeManifest = Path.Combine(Path.GetDirectoryName(expected.ReleaseDir)!, "native-store.json");
        foreach (var file in new[] { expected.NodePath, expected.WorkerPath, selector, storeManifest })
        {
            var info = new FileInfo(file);
            var metadata = file == selector || file == storeManifest;
            var minBytes = metadata ? 200L : 1024L;
            var maxBytes = metadata ? 16L * 1024 : 250L * 1024 * 1024;
            if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 ||
                info.Length < minBytes || info.Length > maxBytes)
                throw new InvalidDataException("Signed-native worker executable is not an immutable normal release file.");
        }
    }
}
