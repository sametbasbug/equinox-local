using System.Globalization;
using System.Runtime.InteropServices;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Read-only evidence: THIS currently installed original managed-Main A
    // Guardian's physical NTFS identity, acquired from a kernel file handle.
    // An unsigned B or callback must never supply an old-A File ID string.
    // This does NOT authorize staged B, journal writes, WPF exit, rollback,
    // current-native pointer changes or Native Messaging registration.
    private static void InspectOriginalMainGuardianPhysicalFileId()
    {
        InspectionPhase = "native-original-a-guardian-main-identity";
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Original A kernel File ID requires Windows.");
        // Require original owned Main A, not a numbered Stable predecessor or
        // a simulated B SHA. The active prepared owner remains read-only.
        InspectMainNativeIdentity(allowExactActiveMainTransaction: true);
        InspectionPhase = "native-original-a-guardian-kernel-file-id";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local))
            throw new InvalidDataException("Original A installed user directory is missing.");
        var guardian = Path.Combine(local, "Equinox Local", "runtime", "guardian", "EquinoxLocalGuardian.exe");
        if (!Path.IsPathFullyQualified(guardian) ||
            !Compare.Equals(Path.GetFullPath(Environment.ProcessPath ?? ""), Path.GetFullPath(guardian)))
            throw new InvalidDataException("Original A Guardian OS executable differs from the installed owned Guardian.");
        RequireNormalFile(guardian);
        // This is a read-only HANDLE: no DELETE requested and NO shared DELETE
        // allowed. The original executable cannot be renamed through this
        // descriptor while the kernel identity is being observed.
        using var native = OpenNativeOrphanFileForRename(guardian, NativeOrphanGenericRead,
            NativeOrphanShareRead, 0, NativeOrphanOpenExisting, NativeOrphanOpenReparsePoint, 0);
        if (native.IsInvalid || !ReadNativeOrphanHandleInformation(native, out var original))
            throw new InvalidDataException("Original A Guardian kernel file identity is inaccessible.");
        if ((original.Attributes & (NativeOrphanReparseAttribute | NativeOrphanDirectoryAttribute)) != 0 ||
            original.LinkCount != 1 || original.SizeHigh == 0 && original.SizeLow == 0 ||
            original.VolumeSerial == 0 || original.FileIndexHigh == 0 && original.FileIndexLow == 0)
            throw new InvalidDataException("Original A Guardian is not a singly linked normal physical NTFS file.");
        // Read the same OPEN handle twice; no TOCTOU reopening by path.
        if (!ReadNativeOrphanHandleInformation(native, out var again) ||
            original.VolumeSerial != again.VolumeSerial ||
            original.FileIndexHigh != again.FileIndexHigh ||
            original.FileIndexLow != again.FileIndexLow || original.SizeHigh != again.SizeHigh ||
            original.SizeLow != again.SizeLow || again.LinkCount != 1)
            throw new InvalidDataException("Original A Guardian kernel identity changed during observation.");
        var physical = ((ulong)original.FileIndexHigh << 32) | original.FileIndexLow;
        // Test-only output of a non-secret kernel file identity. This is NOT
        // a durable journal milestone or a future rollback success receipt.
        Console.WriteLine($"MAIN_A_GUARDIAN_KERNEL_ID volume={original.VolumeSerial.ToString("x8", CultureInfo.InvariantCulture)} fileId={physical.ToString("x16", CultureInfo.InvariantCulture)} readOnly=true");
        InspectionPhase = "native-original-a-guardian-physical-baseline-readonly";
    }
}
