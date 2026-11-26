using System.IO.Compression;
using System.Security.Cryptography;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // The signed Ed25519 pointer authenticates the ZIP SHA256, NOT a mutable
    // native-store fingerprint. Read the retained, exact ZIP and prove that
    // EVERY executable B file/directory matches its signed decompressed
    // contents BEFORE the original WPF is ever allowed to launch B.
    // This audit is read-only and does not authorize a Guardian OS lease.
    private static NativeFingerprintResult? InspectOriginalSignedWindowsArchive(
        string archivePath, string releaseDir, string signedArtifactSha256, long signedArtifactBytes,
        bool measureFingerprint = false)
    {
        InspectionPhase = "signed-native-original-archive";
        RequireNormalDirectory(releaseDir);
        RequireNormalFile(archivePath);
        var archiveInfo = new FileInfo(archivePath);
        if (archiveInfo.Length != signedArtifactBytes ||
            signedArtifactBytes is < 1 or > 1024L * 1024 * 1024 ||
            !DigestPattern.IsMatch(signedArtifactSha256))
            throw new InvalidDataException("Original signed Windows B archive size or SHA is not valid.");

        using var archiveStream = new FileStream(archivePath, FileMode.Open, FileAccess.Read,
            FileShare.Read, 1024 * 1024, FileOptions.SequentialScan);
        if (archiveStream.Length != signedArtifactBytes ||
            Convert.ToHexStringLower(SHA256.HashData(archiveStream)) != signedArtifactSha256)
            throw new InvalidDataException("Original Windows B retained archive differs from production Ed25519 SHA256.");
        archiveStream.Position = 0;
        using var zip = new ZipArchive(archiveStream, ZipArchiveMode.Read, leaveOpen: true);
        if (zip.Entries.Count is < 2 or > MaxNativeFingerprintEntries + 1)
            throw new InvalidDataException("Original signed ZIP has invalid native entry count.");
        var archiveEntries = new Dictionary<string, (ZipArchiveEntry Entry, bool Directory)>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var entry in zip.Entries)
        {
            var name = entry.FullName;
            if (name == "release/")
            {
                if (entry.Length != 0 || !archiveEntries.TryAdd("", (entry, true)))
                    throw new InvalidDataException("Original signed ZIP contains an invalid or duplicate root.");
                continue;
            }
            if (name.Length < 9 || name.Length > 500 ||
                !name.StartsWith("release/", StringComparison.Ordinal) ||
                name.Contains('\\') || name.Contains('\0'))
                throw new InvalidDataException("Original signed ZIP entry escaped its release root.");
            var directory = name.EndsWith("/", StringComparison.Ordinal);
            var relative = name["release/".Length..].TrimEnd('/');
            var parts = relative.Split('/');
            if (parts.Any(part => part.Length == 0 || part is "." or ".." ||
                part.EndsWith(' ') || part.EndsWith('.') || part.Contains(':')))
                throw new InvalidDataException("Original signed ZIP entry contains an unsafe Windows segment.");
            if (!archiveEntries.TryAdd(string.Join("/", parts), (entry, directory)))
                throw new InvalidDataException("Original signed ZIP contains duplicate or case-folded native paths.");
            if (directory)
            {
                if (entry.Length != 0) throw new InvalidDataException("Original signed ZIP directory has file bytes.");
            }
            else
            {
                if (entry.Length < 0 || entry.Length > MaxNativeFingerprintBytes - total)
                    throw new InvalidDataException("Original signed ZIP exceeds its extracted byte budget.");
                total += entry.Length;
            }
        }
        if (!archiveEntries.ContainsKey(""))
            throw new InvalidDataException("Original signed ZIP has no release root.");

        // Walk actual filesystem paths, not archive-supplied paths. Reject
        // junctions before descending and require an exact signed inventory.
        // When startup also needs the native-store fingerprint, reuse only the
        // physical digests measured against the authenticated ZIP in THIS audit.
        // There is no persistent cache or metadata-only integrity shortcut.
        var discovered = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "" };
        List<NativeFingerprintRow>? rows = measureFingerprint ? new() : null;
        var pending = new Stack<(string Full, string Relative)>();
        pending.Push((releaseDir, ""));
        while (pending.Count > 0)
        {
            var (parent, parentRelative) = pending.Pop();
            RequireNormalDirectory(parent);
            foreach (var item in Directory.EnumerateFileSystemEntries(parent))
            {
                if (discovered.Count > MaxNativeFingerprintEntries + 1)
                    throw new InvalidDataException("Original signed B has too many filesystem entries.");
                var attributes = File.GetAttributes(item);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Original signed B contains an unauthorized reparse path.");
                var relative = parentRelative.Length == 0
                    ? Path.GetFileName(item) : parentRelative + "/" + Path.GetFileName(item);
                if (!discovered.Add(relative) || !archiveEntries.TryGetValue(relative, out var expected))
                    throw new InvalidDataException("Original signed B contains an extra or duplicate release path.");
                var directory = (attributes & FileAttributes.Directory) != 0;
                if (directory != expected.Directory)
                    throw new InvalidDataException("Original signed B entry type differs from archive.");
                if (directory)
                {
                    rows?.Add(new NativeFingerprintRow("dir", relative, WindowsNodeMode(attributes), 0, null));
                    pending.Push((item, relative));
                    continue;
                }
                RequireNormalFile(item);
                var length = expected.Entry.Length;
                if (new FileInfo(item).Length != length)
                    throw new InvalidDataException("Original signed ZIP extracted B file size differs from archive.");
                using var original = expected.Entry.Open();
                using var extracted = new FileStream(item, FileMode.Open, FileAccess.Read,
                    FileShare.Read, 64 * 1024, FileOptions.SequentialScan);
                if (extracted.Length != length)
                    throw new InvalidDataException("Original signed B file changed before inspection.");
                var archiveDigest = SHA256.HashData(original);
                var releaseDigest = SHA256.HashData(extracted);
                if (!CryptographicOperations.FixedTimeEquals(archiveDigest, releaseDigest) ||
                    extracted.Length != length || new FileInfo(item).Length != length)
                    throw new InvalidDataException("Original signed ZIP extracted B file differs from production archive.");
                rows?.Add(new NativeFingerprintRow("file", relative, WindowsNodeMode(attributes), length,
                    Convert.ToHexStringLower(releaseDigest)));
            }
        }
        if (discovered.Count != archiveEntries.Count)
            throw new InvalidDataException("Original signed Windows archive and extracted B have different entries.");
        // No B WPF launch or pointer mutation here. Future mutation MUST
        // independently bind the OS-owned handles through its journal lease.
        InspectionPhase = "signed-native-original-archive-reconciled-read-only";
        return rows is null ? null : BuildNativeFingerprint(rows, discovered.Count - 1, total);
    }
}
