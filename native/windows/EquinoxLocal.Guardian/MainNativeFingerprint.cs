using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const int MaxNativeFingerprintEntries = 20_000;
    private const long MaxNativeFingerprintBytes = 2L * 1024 * 1024 * 1024;
    private const string NativeFingerprintDomain = "equinox-local-native-state-v1\0";

    // Match Node.js's Windows stat.mode & 0o777. Windows libuv exposes
    // 0666 for ordinary files/directories and 0444 for readonly entries.
    private static int WindowsNodeMode(FileAttributes attributes) =>
        (attributes & FileAttributes.ReadOnly) != 0 ? 292 : 438;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "CompareStringEx")]
    private static extern int CompareWindowsEnglish(
        string localeName, uint flags, string first, int firstLength,
        string second, int secondLength, nint version, nint reserved, nint param);

    // Windows NLS en-US comparison is the platform-native equivalent of
    // Node's en locale collation for release path names. A discrepancy with
    // the JS producer fails the final release fingerprint check closed.
    private static int CompareFingerprintNames(string first, string second, uint options = 0)
    {
        var result = CompareWindowsEnglish("en-US", options, first, first.Length, second, second.Length, 0, 0, 0);
        if (result is < 1 or > 3) throw new InvalidDataException("Native release path collation is unavailable.");
        return result - 2;
    }

    private sealed record NativeFingerprintRow(string Type, string Relative, int Mode, long Bytes, string? Sha256);
    private sealed record NativeFingerprintResult(string Sha256, int Entries, long Bytes, string WindowsStringSortSha256, string OrdinalSortSha256);

    // Recompute the entire exact native-store release fingerprint. No
    // directory junction, reparse path, partial tree or caller-supplied file
    // list can authorize this result. Remains a READ-ONLY audit stage.
    private static NativeFingerprintResult FingerprintNativeMainRelease(string releaseRoot)
    {
        RequireNormalDirectory(releaseRoot);
        var rows = new List<NativeFingerprintRow>();
        var pending = new Stack<(string Absolute, string Relative)>();
        pending.Push((releaseRoot, ""));
        long totalBytes = 0;
        var entries = 0;
        while (pending.Count > 0)
        {
            var (directory, relativeParent) = pending.Pop();
            RequireNormalDirectory(directory);
            foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
            {
                if (++entries > MaxNativeFingerprintEntries)
                    throw new InvalidDataException("Native Main release contains too many entries.");
                var attributes = File.GetAttributes(entry);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Native Main release contains a reparse path.");
                var name = Path.GetFileName(entry);
                var relative = relativeParent.Length == 0 ? name : relativeParent + "/" + name;
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    rows.Add(new NativeFingerprintRow("dir", relative, WindowsNodeMode(attributes), 0, null));
                    pending.Push((entry, relative));
                }
                else
                {
                    RequireNormalFile(entry);
                    var original = new FileInfo(entry);
                    totalBytes = checked(totalBytes + original.Length);
                    if (totalBytes > MaxNativeFingerprintBytes)
                        throw new InvalidDataException("Native Main release exceeds its maximum size.");
                    using var stream = new FileStream(entry, FileMode.Open, FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete, 64 * 1024, FileOptions.SequentialScan);
                    if (stream.Length != original.Length)
                        throw new InvalidDataException("Native Main release size changed during inspection.");
                    var hash = Convert.ToHexStringLower(SHA256.HashData(stream));
                    if (new FileInfo(entry).Length != original.Length)
                        throw new InvalidDataException("Native Main release bytes changed during inspection.");
                    rows.Add(new NativeFingerprintRow("file", relative, WindowsNodeMode(attributes), original.Length, hash));
                }
            }
        }
        string DigestRows(Comparison<NativeFingerprintRow> compare)
        {
            var sorted = rows.ToArray();
            Array.Sort(sorted, compare);
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            void Add(string value) => digest.AppendData(Encoding.UTF8.GetBytes(value));
            Add(NativeFingerprintDomain);
            foreach (var row in sorted)
            {
                Add($"{row.Type}\0{row.Relative}\0{row.Mode}\0");
                if (row.Type == "file") Add($"{row.Bytes}\0{row.Sha256}\0");
            }
            return Convert.ToHexStringLower(digest.GetHashAndReset());
        }
        var defaultDigest = DigestRows((a, b) => CompareFingerprintNames(a.Relative, b.Relative));
        const uint stringSort = 0x00001000;
        var windowsStringDigest = DigestRows((a, b) => CompareFingerprintNames(a.Relative, b.Relative, stringSort));
        var ordinalDigest = DigestRows((a, b) => StringComparer.Ordinal.Compare(a.Relative, b.Relative));
        return new NativeFingerprintResult(defaultDigest, entries, totalBytes, windowsStringDigest, ordinalDigest);
    }
}
