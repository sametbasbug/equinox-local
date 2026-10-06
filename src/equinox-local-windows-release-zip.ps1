param(
  [Parameter(Mandatory=$true)][ValidateSet('Inspect','Extract')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$ArchivePath,
  [string]$DestinationPath,
  [string]$ExpectedRoot = 'release'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$CompressionAssembly = [System.IO.Compression.ZipArchive].Assembly.Location
$CompressionFileSystemAssembly = [System.IO.Compression.ZipFile].Assembly.Location
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text.RegularExpressions;

public static class EquinoxWindowsReleaseZip
{
    const int MaxEntries = 20000;
    const long MaxBytes = 2147483648L;
    const int MaxName = 500;
    const int ReparsePoint = 0x400;
    static readonly Regex Reserved = new Regex(@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    sealed class Item
    {
        public ZipArchiveEntry Entry;
        public string Name;
        public bool Directory;
    }

    static void ValidateSegment(string segment)
    {
        if (segment.Length == 0 || segment == "." || segment == "..") throw new InvalidDataException("ZIP contains an unsafe path segment.");
        if (segment.EndsWith(" ", StringComparison.Ordinal) || segment.EndsWith(".", StringComparison.Ordinal)) throw new InvalidDataException("ZIP contains a Windows-ambiguous path segment.");
        if (Reserved.IsMatch(segment)) throw new InvalidDataException("ZIP contains a reserved Windows device path.");
        foreach (char c in segment) {
            if (c < 32 || c == '<' || c == '>' || c == ':' || c == '"' || c == '\\' || c == '|' || c == '?' || c == '*')
                throw new InvalidDataException("ZIP contains an unsupported Windows path character.");
        }
    }

    static List<Item> ValidateArchive(ZipArchive zip, string expectedRoot, out long bytes)
    {
        if (String.IsNullOrEmpty(expectedRoot) || expectedRoot.IndexOf('/') >= 0 || expectedRoot.IndexOf('\\') >= 0) throw new InvalidDataException("ZIP expected root is invalid.");
        ValidateSegment(expectedRoot);
        var items = new List<Item>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        bytes = 0;
        foreach (ZipArchiveEntry entry in zip.Entries) {
            if (items.Count >= MaxEntries) throw new InvalidDataException("ZIP entry count exceeds the allowed bound.");
            string raw = entry.FullName;
            if (String.IsNullOrEmpty(raw) || raw.Length > MaxName || raw.IndexOf('\0') >= 0 || raw.IndexOf('\\') >= 0)
                throw new InvalidDataException("ZIP contains an invalid entry name.");
            bool directory = raw.EndsWith("/", StringComparison.Ordinal);
            string name = directory ? raw.Substring(0, raw.Length - 1) : raw;
            if (String.IsNullOrEmpty(name) || name.StartsWith("/", StringComparison.Ordinal)) throw new InvalidDataException("ZIP entries must be relative paths.");
            string[] parts = name.Split('/');
            if (parts.Length == 0 || !String.Equals(parts[0], expectedRoot, StringComparison.Ordinal)) throw new InvalidDataException("ZIP escaped the expected archive root.");
            foreach (string part in parts) ValidateSegment(part);
            string key = String.Join("/", parts);
            if (!seen.Add(key)) throw new InvalidDataException("ZIP contains a case-insensitive duplicate path.");

            int external = entry.ExternalAttributes;
            int unixType = (external >> 16) & 0xF000;
            int dos = external & 0xFFFF;
            if ((dos & ReparsePoint) != 0 || unixType == 0xA000) throw new InvalidDataException("ZIP contains a symlink or reparse-point entry.");
            if (directory) {
                if (entry.Length != 0 || (unixType != 0 && unixType != 0x4000)) throw new InvalidDataException("ZIP directory metadata is invalid.");
            } else {
                if (unixType != 0 && unixType != 0x8000) throw new InvalidDataException("ZIP contains an unsupported filesystem entry type.");
                if (entry.Length < 0 || entry.Length > MaxBytes - bytes) throw new InvalidDataException("ZIP exceeds the extracted size limit.");
                bytes += entry.Length;
            }
            items.Add(new Item { Entry = entry, Name = key, Directory = directory });
        }
        if (items.Count == 0) throw new InvalidDataException("ZIP is empty.");
        return items;
    }

    static string Summary(int entries, long bytes) { return String.Format("{{\"entryCount\":{0},\"extractedBytes\":{1}}}", entries, bytes); }

    public static string Inspect(string archivePath, string expectedRoot)
    {
        using (FileStream stream = File.Open(archivePath, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (ZipArchive zip = new ZipArchive(stream, ZipArchiveMode.Read, false)) {
            long bytes;
            List<Item> items = ValidateArchive(zip, expectedRoot, out bytes);
            return Summary(items.Count, bytes);
        }
    }

    static bool Inside(string root, string candidate)
    {
        string prefix = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        return candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    static void AssertNormalDirectory(string directory)
    {
        FileAttributes attributes = File.GetAttributes(directory);
        if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("Extraction directory is not a normal directory.");
    }

    static void ValidateExtractedTree(string root, ref int count, ref long bytes)
    {
        AssertNormalDirectory(root);
        foreach (string entry in Directory.GetFileSystemEntries(root)) {
            count++;
            if (count > MaxEntries) throw new InvalidDataException("Extracted ZIP contains too many entries.");
            FileAttributes attributes = File.GetAttributes(entry);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Extracted ZIP contains a reparse point.");
            if ((attributes & FileAttributes.Directory) != 0) ValidateExtractedTree(entry, ref count, ref bytes);
            else {
                long length = new FileInfo(entry).Length;
                if (length > MaxBytes - bytes) throw new InvalidDataException("Extracted ZIP exceeds the size limit.");
                bytes += length;
            }
        }
    }

    public static string Extract(string archivePath, string destinationPath, string expectedRoot)
    {
        string destination = Path.GetFullPath(destinationPath);
        if (Directory.Exists(destination) || File.Exists(destination)) throw new InvalidDataException("Extraction destination must not already exist.");
        Directory.CreateDirectory(destination);
        AssertNormalDirectory(destination);
        try {
            using (FileStream stream = File.Open(archivePath, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (ZipArchive zip = new ZipArchive(stream, ZipArchiveMode.Read, false)) {
                long expectedBytes;
                List<Item> items = ValidateArchive(zip, expectedRoot, out expectedBytes);
                foreach (Item item in items) {
                    string[] parts = item.Name.Split('/');
                    string target = destination;
                    foreach (string part in parts) target = Path.Combine(target, part);
                    target = Path.GetFullPath(target);
                    if (!Inside(destination, target)) throw new InvalidDataException("ZIP extraction escaped its destination.");
                    if (item.Directory) {
                        Directory.CreateDirectory(target);
                        AssertNormalDirectory(target);
                    } else {
                        string parent = Path.GetDirectoryName(target);
                        Directory.CreateDirectory(parent);
                        AssertNormalDirectory(parent);
                        using (Stream input = item.Entry.Open())
                        using (FileStream output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None)) input.CopyTo(output);
                    }
                }
                int actualCount = 0;
                long actualBytes = 0;
                ValidateExtractedTree(destination, ref actualCount, ref actualBytes);
                if (actualBytes != expectedBytes) throw new InvalidDataException("Extracted ZIP byte count drifted from central-directory metadata.");
                return Summary(items.Count, expectedBytes);
            }
        } catch {
            try { Directory.Delete(destination, true); } catch { }
            throw;
        }
    }
}
'@ -ReferencedAssemblies @($CompressionAssembly, $CompressionFileSystemAssembly)
$archive = [System.IO.Path]::GetFullPath($ArchivePath)
if (-not [System.IO.File]::Exists($archive)) { throw 'Windows release ZIP is missing.' }
if ($Mode -eq 'Inspect') {
  [EquinoxWindowsReleaseZip]::Inspect($archive, $ExpectedRoot)
} else {
  if ([string]::IsNullOrWhiteSpace($DestinationPath)) { throw 'DestinationPath is required for extraction.' }
  [EquinoxWindowsReleaseZip]::Extract($archive, [System.IO.Path]::GetFullPath($DestinationPath), $ExpectedRoot)
}
