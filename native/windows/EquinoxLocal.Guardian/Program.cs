using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace EquinoxLocal.Guardian;

/// <summary>
/// Independent, per-user native launcher. Launches only a verified Stable
/// baseline or a fully committed, independently attested Main native snapshot.
/// An active or orphaned transaction always blocks launch; this is NOT
/// permission to switch native A/B or recover an unverified transaction.
/// No network access, arbitrary executable, generic command or server.
/// </summary>
internal static partial class Program
{
    private const int MaxPointerBytes = 4 * 1024;
    private const int MaxReleaseBytes = 16 * 1024;
    private const int MaxShellEntries = 4000;
    private const long MaxShellBytes = 450L * 1024 * 1024;
    private static readonly StringComparer Compare = StringComparer.OrdinalIgnoreCase;
    private static string InspectionPhase = "entry";

    [GeneratedRegex(@"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionRegex();

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length > 1 || (args.Length == 1 && args[0] is not ("--inspect" or "--audit-native-identity" or "--audit-native-journal" or "--audit-native-worker" or "--audit-native-worker-ipc" or "--audit-native-worker-argv" or "--audit-native-wpf-owner" or "--hold-native-journal-lease" or "--hold-native-journal-authority" or "--hold-native-prepared-abort" or "--hold-native-stage-b" or "--hold-native-stage-b-cancel" or "--hold-native-stable-shell-quiesce" or "--reconcile-native-prepared-abort" or "--startup" or "--uninstall")))
                throw new InvalidOperationException("Unsupported Guardian argument.");
            if (args.Length == 1 && args[0] == "--audit-native-identity")
            {
                InspectMainNativeIdentity();
                return 0; // Structural audit only; never a Main launch signal.
            }
            if (args.Length == 1 && args[0] == "--audit-native-journal")
            {
                InspectOwnedNativeTransitionJournal();
                return 0; // Receipt ownership audit ONLY; no resume or launch.
            }
            if (args.Length == 1 && args[0] == "--audit-native-worker")
            {
                InspectOwnedNativeWorkerProcess();
                return 0; // Process provenance only; NO Main launch or replay.
            }
            if (args.Length == 1 && args[0] == "--audit-native-worker-ipc")
            {
                InspectOwnedNativeWorkerPipeProof();
                return 0; // Live PID + token proof ONLY, never native update authority.
            }
            if (args.Length == 1 && args[0] == "--audit-native-worker-argv")
            {
                InspectOwnedNativeWorkerOsArguments();
                return 0; // Exact kernel argv proof ONLY; never Main mutation authority.
            }
            if (args.Length == 1 && args[0] == "--audit-native-wpf-owner")
            {
                InspectOwnedMainWpfProcess();
                return 0; // Read-only kernel ownership evidence, never transition authority.
            }
            if (args.Length == 1 && args[0] == "--hold-native-journal-lease")
            {
                HoldOwnedNativeJournalLease();
                return 70; // No automatic reclaim or native mutation capability.
            }
            if (args.Length == 1 && args[0] == "--hold-native-journal-authority")
            {
                HoldOwnedNativeJournalLease(acceptAuthorityProof: true);
                return 70; // Prepared-stage sidecar proof only, never native mutation.
            }
            if (args.Length == 1 && args[0] == "--hold-native-prepared-abort")
            {
                HoldOwnedNativeJournalLease(recordPreparedAbort: true);
                return 70; // Only prepared -> rollback_started, never native side effects.
            }
            if (args.Length == 1 && args[0] == "--hold-native-stage-b")
            {
                HoldOwnedNativeJournalLease(recordNativeStaged: true);
                return 70; // Authenticated prepared -> native_staged ONLY; no WPF mutation.
            }
            if (args.Length == 1 && args[0] == "--hold-native-stage-b-cancel")
            {
                HoldOwnedNativeJournalLease(recordNativeStaged: true, cancelBeforeSwitch: true);
                return 70; // Durable pre-switch cancellation only. No native slot/WPF change.
            }
            if (args.Length == 1 && args[0] == "--hold-native-stable-shell-quiesce")
            {
                HoldOwnedNativeJournalLease(quiesceStableShell: true);
                return 70; // Pilot: exact owned WPF quiesce only, no native A/B swap.
            }
            if (args.Length == 1 && args[0] == "--reconcile-native-prepared-abort")
            {
                ReconcileNativePreparedAbortOrphan();
                return 0; // Retire only a fully verified dead prepared abort lock; no launch.
            }
            var inspection = InspectBaseline();
            if (args.Length == 1 && args[0] is "--inspect" or "--audit-native-identity" or "--audit-native-journal" or "--audit-native-worker" or "--audit-native-worker-ipc" or "--audit-native-worker-argv" or "--audit-native-wpf-owner") return 0;
            using var process = Launch(inspection.Executable, args.Length == 0 ? null : args[0]);
            return process.Id > 0 ? 0 : 70;
        }
        catch (Exception ex)
        {
            // Only the explicit inspection mode exposes bounded, static
            // validation errors to the disposable installed-host acceptance.
            // Never echo paths from OS exceptions or launch arguments.
            if (args.Length == 1 && args[0] is "--inspect" or "--audit-native-identity" or "--audit-native-journal" or "--audit-native-worker" or "--audit-native-worker-ipc" or "--audit-native-worker-argv" or "--audit-native-wpf-owner")
            {
                var reason = ex is InvalidDataException or InvalidOperationException or PlatformNotSupportedException
                    ? ex.Message : ex.GetType().Name;
                if (reason.Length > 120) reason = reason[..120];
                Console.Error.WriteLine($"Guardian inspection refused: phase={InspectionPhase}; kind={ex.GetType().Name}; code=0x{ex.HResult:x8}; reason={reason}");
            }
            else if (args.Length == 1 && args[0] is "--hold-native-journal-authority" or "--hold-native-prepared-abort" or "--hold-native-stage-b" or "--hold-native-stage-b-cancel" or "--hold-native-stable-shell-quiesce" or "--reconcile-native-prepared-abort")
            {
                // Bounded phase/type only: no worker token, paths, journal
                // contents or dynamic exception reason enter CI diagnostics.
                Console.Error.WriteLine($"Guardian authority refused: phase={InspectionPhase}; kind={ex.GetType().Name}; code=0x{ex.HResult:x8}");
            }
            else Debug.WriteLine("Equinox Local Guardian refused launch: " + ex.GetType().Name);
            return 70;
        }
    }

    private sealed record VerifiedBaseline(string Executable);

    private static VerifiedBaseline InspectBaseline(bool allowActiveOrphanForReconciliation = false)
    {
        InspectionPhase = "resolve-user-root";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Current-user LocalAppData is unavailable.");
        var installRoot = Path.GetFullPath(Path.Combine(local, "Equinox Local"));
        var programRoot = Path.GetFullPath(Path.Combine(local, "Programs", "Equinox Local"));
        var guardianDir = Path.Combine(installRoot, "runtime", "guardian");
        var guardianPath = Path.Combine(guardianDir, "EquinoxLocalGuardian.exe");
        var actual = Environment.ProcessPath ?? throw new InvalidDataException("Guardian executable path unavailable.");
        if (!Compare.Equals(Path.GetFullPath(actual), guardianPath))
            throw new InvalidDataException("Guardian is outside its per-user immutable executable location.");
        InspectionPhase = "verify-guardian-ownership";
        RequireNormalDirectory(installRoot);
        RequireNormalDirectory(Path.Combine(installRoot, "runtime"));
        RequireNormalDirectory(guardianDir);
        RequireNormalFile(guardianPath);

        InspectionPhase = "check-existing-update-ownership";
        var transactionRoot = Path.Combine(installRoot, "state", "main-update");
        var updateLock = Path.Combine(transactionRoot, "active.json");
        if (!allowActiveOrphanForReconciliation && (File.Exists(updateLock) || Directory.Exists(updateLock)))
            throw new InvalidDataException("A Main update requires exact journal reconciliation before Guardian launch.");
        var nativePointer = Path.Combine(transactionRoot, "current-native.json");
        if (Directory.Exists(nativePointer))
            throw new InvalidDataException("Main native pointer is not a normal file.");
        // A signed owner crash leaves a durable OS-session lease, never an
        // implicit green light to launch Main after partial A/B replacement.
        var guardianJournalDir = Path.Combine(transactionRoot, "guardian-journal");
        if (!allowActiveOrphanForReconciliation && Directory.Exists(guardianJournalDir))
        {
            RequireNormalDirectory(guardianJournalDir);
            if (Directory.EnumerateFileSystemEntries(guardianJournalDir, "*.guardian-session-lock").Any())
                throw new InvalidDataException("Unreconciled signed Guardian owner session blocks native launch.");
        }
        var handoffDir = Path.Combine(transactionRoot, "handoff");
        if (Directory.Exists(handoffDir))
        {
            RequireNormalDirectory(handoffDir);
            // Any detached-worker trace requires explicit ownership recovery.
            if (!allowActiveOrphanForReconciliation && Directory.EnumerateFileSystemEntries(handoffDir, "*.windows-worker.json").Any())
                throw new InvalidDataException("Detached native update worker ownership remains unresolved.");
        }

        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported Windows Guardian CPU target."),
        };
        // A verified committed Main native-store is the sole runtime identity
        // after successful B. Do not depend on the obsolete Stable release
        // after it is reclaimed; keep the signed Stable fallback only before
        // initial Main native selection.
        var mainPointerPath = Path.Combine(installRoot, "state", "main-update", "current-native.json");
        if (File.Exists(mainPointerPath))
        {
            // Post-commit WPF launch is an entirely different privilege from
            // updating the native slot. Verify the exact committed source Git,
            // source/native pointers, complete SHA-addressed B payload, actual
            // installed WPF bytes and HKCU Native Messaging FIRST. A partially
            // advanced transaction or a forged pointer cannot launch Main.
            InspectionPhase = "verify-committed-main-native-baseline";
            InspectMainNativeIdentity();
            var node = ResolveOwnedMainWorkerNodePath(installRoot, target);
            var nodeBin = Path.GetDirectoryName(node)
                ?? throw new InvalidDataException("Main native Node path has no directory.");
            var nativeRelease = Path.GetFullPath(Path.Combine(nodeBin, "..", "..", ".."));
            var mainSourceShell = Path.Combine(nativeRelease, "runtime", "shell");
            RequireNormalDirectory(mainSourceShell);
            RequireNormalDirectory(programRoot);
            InspectionPhase = "compare-main-native-tree";
            CompareNativeTrees(mainSourceShell, programRoot);
            var mainShell = Path.Combine(programRoot, "EquinoxLocal.exe");
            RequireNormalFile(mainShell);
            return new VerifiedBaseline(mainShell);
        }

        InspectionPhase = "read-stable-pointer";
        var pointerPath = Path.Combine(installRoot, "current-version.json");
        using var pointerDoc = ReadJson(pointerPath, MaxPointerBytes);
        var pointer = pointerDoc.RootElement;
        RequireExactKeys(pointer, ["schemaVersion", "target", "version"]);
        if (pointer.GetProperty("schemaVersion").GetInt32() != 1 || pointer.GetProperty("target").GetString() != target)
            throw new InvalidDataException("Managed Stable pointer architecture mismatch.");
        var version = pointer.GetProperty("version").GetString();
        if (version is null || !VersionRegex().IsMatch(version))
            throw new InvalidDataException("Managed Stable version is not a safe directory name.");
        var releasesRoot = Path.Combine(installRoot, "releases");
        var release = Path.Combine(releasesRoot, version);
        RequireNormalDirectory(releasesRoot);
        RequireNormalDirectory(release);
        InspectionPhase = "read-release-identity";
        using var metadataDoc = ReadJson(Path.Combine(release, "release.json"), MaxReleaseBytes);
        var metadata = metadataDoc.RootElement;
        if (metadata.ValueKind != JsonValueKind.Object ||
            metadata.GetProperty("schemaVersion").GetInt32() != 1 ||
            metadata.GetProperty("target").GetString() != target ||
            metadata.GetProperty("version").GetString() != version ||
            metadata.GetProperty("serverEntry").GetString() != "server.js")
            throw new InvalidDataException("Signed baseline release identity mismatch.");
        var sourceShell = Path.Combine(release, "runtime", "shell");
        RequireNormalDirectory(sourceShell);
        RequireNormalDirectory(programRoot);
        InspectionPhase = "compare-native-tree";
        CompareNativeTrees(sourceShell, programRoot);
        var executable = Path.Combine(programRoot, "EquinoxLocal.exe");
        InspectionPhase = "verify-active-shell";
        RequireNormalFile(executable);
        return new VerifiedBaseline(executable);
    }

    private static JsonDocument ReadJson(string path, int limit)
    {
        RequireNormalFile(path);
        var info = new FileInfo(path);
        if (info.Length is < 2 or > MaxReleaseBytes || info.Length > limit)
            throw new InvalidDataException("Bounded managed release metadata is invalid.");
        return JsonDocument.Parse(File.ReadAllBytes(path));
    }

    private static void RequireExactKeys(JsonElement element, string[] keys)
    {
        if (element.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Managed release pointer is not an object.");
        var actual = element.EnumerateObject().Select(property => property.Name).Order(StringComparer.Ordinal).ToArray();
        if (!actual.SequenceEqual(keys.Order(StringComparer.Ordinal), StringComparer.Ordinal))
            throw new InvalidDataException("Managed release pointer contains unsupported keys.");
    }

    private static void RequireNormalDirectory(string path)
    {
        var info = new DirectoryInfo(path);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Managed directory is missing or a reparse point.");
    }

    private static void RequireNormalFile(string path)
    {
        var info = new FileInfo(path);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Managed executable or metadata is missing or a reparse point.");
    }

    private static void CompareNativeTrees(string releaseShell, string installedShell)
    {
        InspectionPhase = "hash-reference-shell";
        var expected = Snapshot(releaseShell, false);
        InspectionPhase = "hash-installed-shell";
        var actual = Snapshot(installedShell, true);
        InspectionPhase = "compare-native-digests";
        if (expected.Count != actual.Count)
            throw new InvalidDataException($"Installed WPF inventory differs: reference={expected.Count}; installed={actual.Count}.");
        foreach (var (key, digest) in expected)
        {
            if (!actual.TryGetValue(key, out var installedDigest) || !CryptographicOperations.FixedTimeEquals(digest, installedDigest))
                throw new InvalidDataException("Installed native file does not match signed Stable baseline.");
        }
    }

    private static Dictionary<string, byte[]> Snapshot(string root, bool ignoreWebViewCache)
    {
        var result = new Dictionary<string, byte[]>(Compare);
        var pending = new Stack<string>();
        pending.Push(root);
        long bytes = 0;
        var directories = 0;
        while (pending.Count != 0)
        {
            var directory = pending.Pop();
            if (++directories > MaxShellEntries)
                throw new InvalidDataException("Managed WPF native directory tree exceeds its supported bound.");
            RequireNormalDirectory(directory);
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                var relative = Path.GetRelativePath(root, entry);
                var name = Path.GetFileName(entry);
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("A managed WPF tree contains a reparse point.");
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    // Match the existing product's exact known legacy cache
                    // exceptions; never ignore arbitrary folders or files.
                    if (ignoreWebViewCache && directory == root &&
                        (name.Equals("EquinoxLocal.exe.WebView2", StringComparison.OrdinalIgnoreCase) ||
                         name.Equals("%SystemDrive%", StringComparison.OrdinalIgnoreCase)))
                        continue;
                    pending.Push(entry);
                }
                else
                {
                    var info = new FileInfo(entry);
                    bytes = checked(bytes + info.Length);
                    if (bytes > MaxShellBytes || result.Count >= MaxShellEntries)
                        throw new InvalidDataException("Managed WPF native tree exceeds its supported bound.");
                    // Loaded WPF/WebView2 modules may have read/write handles
                    // open while another Guardian invocation checks the shell.
                    // Open READ-ONLY but allow those existing holders to keep
                    // their sharing rights. Never grant write access ourselves.
                    var share = ignoreWebViewCache
                        ? FileShare.ReadWrite | FileShare.Delete
                        : FileShare.Read;
                    using var stream = new FileStream(entry, FileMode.Open, FileAccess.Read, share, 64 * 1024, FileOptions.SequentialScan);
                    if (stream.Length != info.Length)
                        throw new InvalidDataException("Native file size changed during Guardian admission.");
                    var digest = SHA256.HashData(stream);
                    if (new FileInfo(entry).Length != info.Length)
                        throw new InvalidDataException("Native file changed during Guardian admission.");
                    result.Add(relative, digest);
                }
            }
        }
        if (!result.ContainsKey("EquinoxLocal.exe") || !result.ContainsKey("coreclr.dll"))
            throw new InvalidDataException("Managed native WPF executable tree is incomplete.");
        return result;
    }

    private static Process Launch(string executable, string? arg)
    {
        var info = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(executable)!,
        };
        if (arg is not null) info.ArgumentList.Add(arg);
        return Process.Start(info) ?? throw new IOException("Verified WPF application could not start.");
    }
}
