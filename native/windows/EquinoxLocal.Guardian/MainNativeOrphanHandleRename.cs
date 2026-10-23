using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const uint NativeOrphanGenericRead = 0x80000000;
    private const uint NativeOrphanDelete = 0x00010000;
    private const uint NativeOrphanShareRead = 0x00000001;
    private const uint NativeOrphanOpenExisting = 3;
    private const uint NativeOrphanOpenReparsePoint = 0x00200000;
    private const uint NativeOrphanReparseAttribute = 0x00000400;
    private const uint NativeOrphanDirectoryAttribute = 0x00000010;
    private const int NativeOrphanFileRenameInfo = 3;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeOrphanFileTime
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeOrphanByHandleFileInformation
    {
        public uint Attributes;
        public NativeOrphanFileTime Created;
        public NativeOrphanFileTime Accessed;
        public NativeOrphanFileTime Modified;
        public uint VolumeSerial;
        public uint SizeHigh;
        public uint SizeLow;
        public uint LinkCount;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern SafeFileHandle OpenNativeOrphanFileForRename(string path, uint access,
        uint share, nint security, uint mode, uint flags, nint template);

    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadNativeOrphanHandleInformation(SafeFileHandle handle,
        out NativeOrphanByHandleFileInformation info);

    [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RenameNativeOrphanByHandle(SafeFileHandle handle, int kind,
        nint info, uint length);

    // A verified original Windows handle and its transaction destination are
    // inseparable: a later caller cannot pair an unrelated FileStream with an
    // arbitrary transactionId and rename the wrong native OS-owned file.
    private sealed class NativeOrphanPinnedWriterLock : IDisposable
    {
        internal FileStream Handle { get; }
        internal string JournalRoot { get; }
        internal string TransactionId { get; }

        internal NativeOrphanPinnedWriterLock(FileStream handle, string journalRoot, string transactionId)
        {
            Handle = handle;
            JournalRoot = journalRoot;
            TransactionId = transactionId;
        }

        public void Dispose() => Handle.Dispose();
    }

    // PRIVATE UNINVOKED pilot surface, intentionally NOT integrated with prepared-abort
    // orphan reconciliation before signed Windows x64+ARM64 native acceptance.
    // The final verified writer-lock file identity must never be reopened by
    // pathname for quarantine; this handle requests DELETE at its FIRST open.
    private static NativeOrphanPinnedWriterLock OpenNativeOrphanWriterLockPilot(string journalRoot, string transactionId)
    {
        if (!NativeTransactionPattern.IsMatch(transactionId))
            throw new InvalidDataException("Native orphan writer-lock identity is invalid.");
        RequireNormalDirectory(journalRoot);
        var path = Path.Combine(journalRoot, "." + transactionId + ".writer-lock");
        if (!OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(path))
            throw new PlatformNotSupportedException("Native writer-lock rename requires Windows and an absolute path.");
        RequireNormalFile(path);
        var native = OpenNativeOrphanFileForRename(path, NativeOrphanGenericRead | NativeOrphanDelete,
            NativeOrphanShareRead, 0, NativeOrphanOpenExisting, NativeOrphanOpenReparsePoint, 0);
        if (native.IsInvalid)
        {
            var code = Marshal.GetLastWin32Error();
            native.Dispose();
            throw new Win32Exception(code, "Cannot acquire DELETE access to original orphan writer-lock.");
        }
        try
        {
            // FILE_FLAG_OPEN_REPARSE_POINT prevents following a swapped final
            // symlink between RequireNormalFile(path) and CreateFileW.
            if (!ReadNativeOrphanHandleInformation(native, out var opened))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect original orphan writer-lock handle.");
            if ((opened.Attributes & (NativeOrphanReparseAttribute | NativeOrphanDirectoryAttribute)) != 0)
                throw new InvalidDataException("Orphan writer-lock OS handle cannot be a link or directory.");
            // Require ONE on-disk name: a hard-linked lock can alias a foreign
            // file even when it has neither a reparse nor directory attribute.
            // Bound the KERNEL-reported length before allowing any allocation
            // or bytes to be read from the DELETE-capable original handle.
            if (opened.LinkCount != 1 || opened.SizeHigh != 0 || opened.SizeLow is < 8 or > 512)
                throw new InvalidDataException("Native orphan writer-lock must be singly linked and 8..512 bytes.");
            var stream = new FileStream(native, FileAccess.Read, 512, isAsync: false);
            try
            {
                if (stream.Length != opened.SizeLow)
                    throw new InvalidDataException("Native orphan writer-lock changed after OS handle inspection.");
                return new NativeOrphanPinnedWriterLock(stream, journalRoot, transactionId);
            }
            catch
            {
                stream.Dispose();
                throw;
            }
        }
        catch
        {
            native.Dispose();
            throw;
        }
    }

    // FileRenameInfo operates on the already-open verified HANDLE, never a
    // second source path; ReplaceIfExists=FALSE preserves any existing target.
    // The caller must FIRST establish the same PID/HMAC/journal/lock evidence
    // and fsync a create-only quarantine receipt while this HANDLE is live.
    // This method deliberately has NO caller in production Guardian CLI yet.
    private static void RenameNativeOrphanWriterLockPilot(NativeOrphanPinnedWriterLock original)
    {
        ArgumentNullException.ThrowIfNull(original);
        if (!NativeTransactionPattern.IsMatch(original.TransactionId) ||
            !original.Handle.CanRead || original.Handle.SafeFileHandle.IsClosed ||
            original.Handle.SafeFileHandle.IsInvalid)
            throw new InvalidDataException("Native orphan quarantine requires its original live transaction-owned file handle.");
        RequireNormalDirectory(original.JournalRoot);
        var target = Path.Combine(original.JournalRoot, "." + original.TransactionId + ".quarantined.writer-lock");
        if (!OperatingSystem.IsWindows() || !Path.IsPathFullyQualified(target) || target.Contains('\0'))
            throw new InvalidDataException("Native orphan quarantine target must be a bounded absolute path.");
        var name = Encoding.Unicode.GetBytes(target);
        if (name.Length is < 2 or > 8192)
            throw new InvalidDataException("Native orphan quarantine destination exceeds its bounded path.");
        // FILE_RENAME_INFO on 64-bit Windows: Flags@0, RootDirectory@8,
        // FileNameLength@16, variable UTF-16 FileName@20 (minimum size 24).
        // Both supported Windows binaries are 64-bit (x64 and ARM64).
        if (IntPtr.Size != 8)
            throw new PlatformNotSupportedException("Native by-handle rename is supported on Windows 64-bit only.");
        var size = Math.Max(24, 20 + name.Length);
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.Copy(new byte[size], 0, buffer, size);
            Marshal.WriteInt32(buffer, 0, 0); // Never replace existing destination.
            Marshal.WriteIntPtr(buffer, 8, IntPtr.Zero);
            Marshal.WriteInt32(buffer, 16, name.Length);
            Marshal.Copy(name, 0, buffer + 20, name.Length);
            if (!RenameNativeOrphanByHandle(original.Handle.SafeFileHandle,
                    NativeOrphanFileRenameInfo, buffer, (uint)size))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "Native orphan writer-lock handle rename was refused.");
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
