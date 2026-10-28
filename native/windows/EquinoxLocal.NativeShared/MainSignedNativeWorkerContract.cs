using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

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

    // A kernel handle with FileShare.Read prevents overwrite/rename of the
    // precise Node.exe and worker.js identities during the signed ZIP audit
    // and WPF Process.Start. This is read-only and grants NO Guardian lease.
    // Both handles must be kept alive by the caller across BOTH operations.
    internal sealed class PinnedExecutables : IDisposable
    {
        private readonly FileStream _node;
        private readonly FileStream _worker;
        internal PinnedExecutables(FileStream node, FileStream worker)
        {
            _node = node;
            _worker = worker;
        }
        public void Dispose()
        {
            _worker.Dispose();
            _node.Dispose();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KernelFileTime
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KernelFileIdentity
    {
        public uint Attributes;
        public KernelFileTime Created;
        public KernelFileTime Accessed;
        public KernelFileTime Modified;
        public uint VolumeSerial;
        public uint SizeHigh;
        public uint SizeLow;
        public uint LinkCount;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadOriginalKernelFileIdentity(SafeFileHandle handle,
        out KernelFileIdentity identity);

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW",
        SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle OpenOriginalBWithoutFollowingFinalReparse(
        string path, uint access, uint share, nint security, uint mode,
        uint flags, nint template);

    private static FileStream PinNormalBExecutable(string file)
    {
        // FileInfo checks before opening can race a renamed symlink.
        // OPEN_REPARSE_POINT makes the returned KERNEL handle identify the
        // final entry itself, rather than a foreign target it could point to.
        const uint genericRead = 0x80000000;
        const uint shareRead = 0x00000001;
        const uint openExisting = 3;
        const uint openReparsePoint = 0x00200000;
        var handle = OpenOriginalBWithoutFollowingFinalReparse(file,
            genericRead, shareRead, 0, openExisting, openReparsePoint, 0);
        if (handle.IsInvalid)
        {
            var code = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(code,
                "Original signed B executable cannot be pinned without following a reparse point.");
        }
        FileStream? pinned = null;
        try
        {
            pinned = new FileStream(handle, FileAccess.Read, 64 * 1024, isAsync: false);
            if (!ReadOriginalKernelFileIdentity(pinned.SafeFileHandle, out var identity))
                throw new Win32Exception(Marshal.GetLastWin32Error(),
                    "Original signed Main B file lacks an OS file ID.");
            const uint reparsePoint = 0x00000400;
            const uint directory = 0x00000010;
            if ((identity.Attributes & (reparsePoint | directory)) != 0 ||
                identity.LinkCount != 1 || identity.VolumeSerial == 0 ||
                (identity.FileIndexHigh == 0 && identity.FileIndexLow == 0) ||
                identity.SizeHigh != 0 || identity.SizeLow is < 1024 or > 250 * 1024 * 1024 ||
                pinned.Length != identity.SizeLow)
                throw new InvalidDataException(
                    "Original signed native B OS handle is a link, alias or invalid file.");
            return pinned;
        }
        catch
        {
            if (pinned is null) handle.Dispose();
            else pinned.Dispose();
            throw;
        }
    }

    internal static PinnedExecutables PinExactBExecutables(Expected expected)
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException(
                "Original signed native B kernel file IDs require Windows.");
        ValidateOriginalReleaseFiles(expected);
        var node = PinNormalBExecutable(expected.NodePath);
        try
        {
            var worker = PinNormalBExecutable(expected.WorkerPath);
            return new PinnedExecutables(node, worker);
        }
        catch
        {
            node.Dispose();
            throw;
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
