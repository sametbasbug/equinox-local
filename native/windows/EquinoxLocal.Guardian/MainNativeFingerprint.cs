using System.Globalization;
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

    // Node's native-state-v1 producer sorts by `localeCompare(..., "en")`
    // using ICU. Windows CompareStringEx uses NLS and differs on punctuation
    // (103 reversed pairs in a real 5,637-entry installed release). Modern
    // .NET on Windows uses ICU when invariant globalization is disabled.
    // Fail closed if the host forces legacy collation or has no ICU locale.
    private static readonly CompareInfo FingerprintCollation = CultureInfo.GetCultureInfo("en").CompareInfo;

    private static int CompareFingerprintNames(string first, string second) =>
        FingerprintCollation.Compare(first, second, CompareOptions.None);

    private sealed record NativeFingerprintRow(string Type, string Relative, int Mode, long Bytes, string? Sha256);
    private sealed record NativeFingerprintResult(string Sha256, int Entries, long Bytes);

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
        rows.Sort((a, b) => CompareFingerprintNames(a.Relative, b.Relative));
        using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        void Add(string value) => digest.AppendData(Encoding.UTF8.GetBytes(value));
        Add(NativeFingerprintDomain);
        foreach (var row in rows)
        {
            Add($"{row.Type}\0{row.Relative}\0{row.Mode}\0");
            if (row.Type == "file") Add($"{row.Bytes}\0{row.Sha256}\0");
        }
        return new NativeFingerprintResult(Convert.ToHexStringLower(digest.GetHashAndReset()), entries, totalBytes);
    }
}
