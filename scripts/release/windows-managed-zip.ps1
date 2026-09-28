param(
  [Parameter(Mandatory=$true)][string]$SourceDirectory,
  [Parameter(Mandatory=$true)][string]$DestinationZip
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source = [System.IO.Path]::GetFullPath($SourceDirectory)
if (-not [System.IO.Directory]::Exists($source)) { throw 'Managed ZIP source directory is missing.' }
$root = [System.IO.DirectoryInfo]::new($source)
if (($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Managed ZIP source root may not be a reparse point.' }
$destination = [System.IO.Path]::GetFullPath($DestinationZip)
if ([System.IO.File]::Exists($destination)) { throw 'Managed ZIP destination already exists.' }
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($destination)) | Out-Null

$zipSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;

public static class EquinoxManagedZip
{
    private sealed class Item
    {
        public string FullPath;
        public string Relative;
        public bool IsDirectory;
    }

    private static readonly DateTimeOffset FixedTime = new DateTimeOffset(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);

    public static void Create(string sourceDirectory, string destinationZip)
    {
        string source = Path.GetFullPath(sourceDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string destination = Path.GetFullPath(destinationZip);
        var root = new DirectoryInfo(source);
        if (!root.Exists) throw new InvalidOperationException("Managed ZIP source directory is missing.");
        if ((root.Attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Managed ZIP source root may not be a reparse point.");
        if (File.Exists(destination)) throw new InvalidOperationException("Managed ZIP destination already exists.");

        var items = new List<Item>();
        foreach (string fullPath in Directory.EnumerateFileSystemEntries(source, "*", SearchOption.AllDirectories))
        {
            FileAttributes attributes = File.GetAttributes(fullPath);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Managed ZIP source contains a reparse point: " + fullPath);
            string relative = fullPath.Substring(source.Length).TrimStart('\\', '/').Replace('\\', '/');
            if (String.IsNullOrWhiteSpace(relative) || relative.StartsWith("/", StringComparison.Ordinal)) throw new InvalidOperationException("Managed ZIP source contains an invalid relative path.");
            string[] segments = relative.Split('/');
            if (segments.Any(segment => segment.Length == 0 || segment == "." || segment == "..")) throw new InvalidOperationException("Managed ZIP source contains an unsafe relative path.");
            items.Add(new Item { FullPath = fullPath, Relative = relative, IsDirectory = (attributes & FileAttributes.Directory) != 0 });
        }
        items.Sort((left, right) => StringComparer.Ordinal.Compare(left.Relative, right.Relative));

        try
        {
            using (var stream = new FileStream(destination, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None))
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Create, false, Encoding.UTF8))
            {
                ZipArchiveEntry rootEntry = zip.CreateEntry("release/", CompressionLevel.NoCompression);
                rootEntry.LastWriteTime = FixedTime;
                rootEntry.ExternalAttributes = 0;
                foreach (Item item in items)
                {
                    string name = "release/" + item.Relative + (item.IsDirectory ? "/" : "");
                    ZipArchiveEntry entry = zip.CreateEntry(name, item.IsDirectory ? CompressionLevel.NoCompression : CompressionLevel.Fastest);
                    entry.LastWriteTime = FixedTime;
                    entry.ExternalAttributes = 0;
                    if (item.IsDirectory) continue;
                    using (var input = new FileStream(item.FullPath, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, FileOptions.SequentialScan))
                    using (Stream output = entry.Open())
                    {
                        input.CopyTo(output, 1024 * 1024);
                    }
                }
            }
        }
        catch
        {
            try { File.Delete(destination); } catch { }
            throw;
        }
    }
}
'@
Add-Type -TypeDefinition $zipSource -ReferencedAssemblies @('System.IO.Compression.dll','System.IO.Compression.FileSystem.dll','System.Core.dll')
[EquinoxManagedZip]::Create($source, $destination)
