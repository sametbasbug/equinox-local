using System.IO.Compression;
using Microsoft.Win32.SafeHandles;
using System.Security.Cryptography;
using System.Text;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const string OriginalContentIndex = "native-content-sha256.txt";

    // The signed Ed25519 pointer authenticates the ZIP SHA256, NOT a mutable
    // native-store fingerprint. New archives carry a bounded content index
    // generated from the exact bytes written to their entries. Authenticate
    // the entire retained ZIP first, then hash EVERY installed file against
    // that signed index. Legacy archives still verify decompressed entries.
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
        var contentIndex = ReadOriginalContentIndex(archiveEntries);

        // Walk actual filesystem paths, not archive-supplied paths. Reject
        // junctions before descending and require an exact signed inventory.
        // When startup also needs the native-store fingerprint, reuse only the
        // physical digests measured against the authenticated ZIP in THIS audit.
        // There is no persistent cache or metadata-only integrity shortcut.
        var discovered = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "" };
        List<NativeFingerprintRow>? rows = measureFingerprint ? new() : null;
        // Reuse the authenticated, write/delete-denying archive handle for
        // independent read cursors. No worker reopens a pathname or trusts a
        // stored digest. Validate the entire inventory before dispatching any
        // content reads; a bounded worker pool hashes ZIP and installed bytes.
        var files = new List<(string Path, string Relative, FileAttributes Attributes, long Length, string ZipName, int Row)>();
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
                var length = expected.Entry.Length;
                // Keep exactly the old deterministic row order, including
                // paths with equal collation keys. Workers fill slots only.
                var row = rows?.Count ?? -1;
                rows?.Add(new NativeFingerprintRow("file", relative, WindowsNodeMode(attributes), length, null));
                files.Add((item, relative, attributes, length, expected.Entry.FullName, row));
            }
        }
        if (discovered.Count != archiveEntries.Count)
            throw new InvalidDataException("Original signed Windows archive and extracted B have different entries.");
        var verified = new NativeFingerprintRow[files.Count];
        // Large entries first reduces the tail of the bounded work queue.
        var jobs = Enumerable.Range(0, files.Count).OrderByDescending(i => files[i].Length).ToArray();
        var workers = Math.Min(4, Math.Max(1, Environment.ProcessorCount));
        Parallel.For(0, workers, new ParallelOptions { MaxDegreeOfParallelism = workers }, worker =>
        {
            using var cursor = contentIndex is null ? new AuthenticatedArchiveCursor(archiveStream.SafeFileHandle, signedArtifactBytes) : null;
            using var workerZip = cursor is null ? null : new ZipArchive(cursor, ZipArchiveMode.Read);
            for (var index = worker; index < jobs.Length; index += workers)
            {
                var i = jobs[index];
                var file = files[i];
                byte[] digest;
                if (contentIndex is not null) digest = contentIndex[file.ZipName["release/".Length..]];
                else
                {
                    var entry = workerZip!.GetEntry(file.ZipName) ?? throw new InvalidDataException("Authenticated ZIP entry disappeared.");
                    if (entry.Length != file.Length) throw new InvalidDataException("Authenticated ZIP entry size changed.");
                    using var original = entry.Open();
                    digest = SHA256.HashData(original);
                }
                verified[i] = VerifyOriginalExtractedFile(file.Path, file.Relative, file.Attributes, file.Length, digest);
            }
        });
        if (rows is not null)
            for (var i = 0; i < files.Count; i++) rows[files[i].Row] = verified[i];
        // No B WPF launch or pointer mutation here. Future mutation MUST
        // independently bind the OS-owned handles through its journal lease.
        InspectionPhase = "signed-native-original-archive-reconciled-read-only";
        return rows is null ? null : BuildNativeFingerprint(rows, discovered.Count - 1, total);
    }

    // The index is part of the already authenticated ZIP, not a digest
    // cache or a mutable file in native-store. It covers the entire archive
    // file inventory; the index file itself is verified against its bytes.
    private static Dictionary<string, byte[]>? ReadOriginalContentIndex(
        Dictionary<string, (ZipArchiveEntry Entry, bool Directory)> archiveEntries)
    {
        if (!archiveEntries.TryGetValue(OriginalContentIndex, out var index)) return null;
        if (index.Directory || index.Entry.FullName != "release/" + OriginalContentIndex || index.Entry.Length is < 1 or > 16 * 1024 * 1024)
            throw new InvalidDataException("Signed native content index has invalid identity or size.");
        var bytes = new byte[(int)index.Entry.Length];
        using (var stream = index.Entry.Open())
        {
            stream.ReadExactly(bytes);
            if (stream.ReadByte() != -1) throw new InvalidDataException("Signed native content index exceeded its declared size.");
        }
        var result = new Dictionary<string, byte[]>(StringComparer.Ordinal)
        {
            [OriginalContentIndex] = SHA256.HashData(bytes)
        };
        using var reader = new StringReader(new UTF8Encoding(false, true).GetString(bytes));
        while (reader.ReadLine() is { } line)
        {
            if (line.Length <= 65 || line[64] != '\t' || !DigestPattern.IsMatch(line[..64]))
                throw new InvalidDataException("Signed native content index has an invalid digest row.");
            var relative = line[65..];
            if (!archiveEntries.TryGetValue(relative, out var file) || file.Directory || file.Entry.FullName != "release/" + relative ||
                !result.TryAdd(relative, Convert.FromHexString(line[..64])))
                throw new InvalidDataException("Signed native content index has an extra, duplicate or ambiguous path.");
        }
        if (result.Count != archiveEntries.Values.Count(entry => !entry.Directory))
            throw new InvalidDataException("Signed native content index does not cover every archive file.");
        return result;
    }

    // ZipArchive needs a seekable stream. Each cursor uses positional reads on
    // the SAME authenticated handle, so parallel decompression cannot race a
    // shared FileStream position or resolve a second archive pathname.
    private sealed class AuthenticatedArchiveCursor(SafeFileHandle handle, long length) : Stream
    {
        private long position;
        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => length;
        public override long Position { get => position; set => position = value >= 0 ? value : throw new IOException("Negative archive position."); }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override int Read(Span<byte> buffer)
        {
            if (position >= length) return 0;
            var count = RandomAccess.Read(handle, buffer[..(int)Math.Min(buffer.Length, length - position)], position);
            position += count;
            return count;
        }
        public override long Seek(long offset, SeekOrigin origin)
        {
            Position = checked(offset + (origin switch { SeekOrigin.Begin => 0, SeekOrigin.Current => position, SeekOrigin.End => length, _ => throw new ArgumentOutOfRangeException(nameof(origin)) }));
            return position;
        }
        public override void Flush() { }
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private static NativeFingerprintRow VerifyOriginalExtractedFile(string file, string relative,
        FileAttributes attributes, long length, byte[] archiveDigest)
    {
        RequireNormalFile(file);
        var info = new FileInfo(file);
        if (info.Length != length || WindowsNodeMode(info.Attributes) != WindowsNodeMode(attributes))
            throw new InvalidDataException("Original signed ZIP extracted B file size or mode changed before inspection.");
        using var extracted = new FileStream(file, FileMode.Open, FileAccess.Read,
            FileShare.Read, 64 * 1024, FileOptions.SequentialScan);
        if (extracted.Length != length)
            throw new InvalidDataException("Original signed B file changed before inspection.");
        var releaseDigest = SHA256.HashData(extracted);
        if (!CryptographicOperations.FixedTimeEquals(archiveDigest, releaseDigest) ||
            extracted.Length != length || new FileInfo(file).Length != length)
            throw new InvalidDataException("Original signed ZIP extracted B file differs from production archive.");
        return new NativeFingerprintRow("file", relative, WindowsNodeMode(attributes), length,
            Convert.ToHexStringLower(releaseDigest));
    }
}
