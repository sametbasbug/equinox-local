import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { inspectPinnedElectronZip } from "./inspect-pinned-electron-zip.mjs";

// Build-time extraction observation, never an installer or application launch.
// Retains the original signed Main tree's global no-symlink rule. The caller
// supplies a private scratch root; all extracted files are deleted on return.
const execFile = promisify(execFileCallback);
const MAX_ENTRIES = 5_000;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;

export async function inspectExtractedPinnedMacElectron({
  archivePath,
  target,
  scratchRoot,
}: {archivePath: string; target: string; scratchRoot: string}): Promise<Readonly<{
  target: string; files: number; links: number; expandedBytes: number; machine: "arm64" | "x64";
}>> {
  if (process.platform !== "darwin" ||
      (target !== "darwin-arm64" && target !== "darwin-x64") ||
      !path.isAbsolute(archivePath) || !path.isAbsolute(scratchRoot)) {
    throw new Error("Electron native ZIP extraction inspection supports only isolated macOS targets.");
  }
  const scratchStat = await fs.lstat(scratchRoot);
  if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink() ||
      (scratchStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && scratchStat.uid !== process.getuid())) {
    throw new Error("Electron ZIP extraction requires a private, user-owned scratch root.");
  }
  const temporary = await fs.mkdtemp(path.join(scratchRoot, "electron-"));
  try {
    // Copy to a directory no other UID can mutate, then inspect the COPY
    // using the same pinned descriptor+SHA-256 checks as signed staging.
    const privateZip = path.join(temporary, "electron.zip");
    await fs.copyFile(archivePath, privateZip, fsConstants.COPYFILE_EXCL);
    await fs.chmod(privateZip, 0o400);
    const inspected = await inspectPinnedElectronZip({archivePath: privateZip, target});
    const extracted = path.join(temporary, "content");
    await fs.mkdir(extracted, {mode: 0o700});
    await execFile("/usr/bin/ditto", ["-x", "-k", privateZip, extracted], {
      timeout: 180_000, maxBuffer: 1024 * 1024,
    });

    const root = await fs.realpath(extracted);
    let entries = 0;
    let files = 0;
    let links = 0;
    let expandedBytes = 0;
    const directories = [extracted];
    while (directories.length) {
      const directory = directories.pop()!;
      for (const name of await fs.readdir(directory)) {
        const full = path.join(directory, name);
        const stat = await fs.lstat(full);
        entries++;
        if (entries > MAX_ENTRIES) throw new Error("Extracted Electron has too many entries.");
        if (stat.isSymbolicLink()) {
          const targetPath = await fs.realpath(full);
          if (!targetPath.startsWith(root + path.sep)) throw new Error("Extracted Electron link escapes the private directory.");
          links++;
        } else if (stat.isDirectory()) {
          directories.push(full);
        } else if (stat.isFile()) {
          files++;
          expandedBytes += stat.size;
          if (expandedBytes > MAX_UNPACKED_BYTES) throw new Error("Extracted Electron exceeds the inspected byte budget.");
        } else {
          throw new Error("Extracted Electron contains an unsupported file type.");
        }
      }
    }
    if (links !== inspected.links || entries !== inspected.entries ||
        expandedBytes > inspected.unpackedBytes) {
      throw new Error("Extracted Electron tree does not match the inspected ZIP budget.");
    }
    for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
      const stat = await fs.lstat(path.join(extracted, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100) {
        throw new Error("Extracted Electron license notices are missing.");
      }
    }

    const executable = path.join(extracted, "Electron.app", "Contents", "MacOS", "Electron");
    const handle = await fs.open(executable, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o111) === 0) {
        throw new Error("Extracted Electron Mach-O executable has an unsafe mode.");
      }
      const header = Buffer.alloc(8);
      if ((await handle.read(header, 0, header.length, 0)).bytesRead !== 8 ||
          header.readUInt32LE(0) !== 0xfeedfacf ||
          header.readUInt32LE(4) !== (target === "darwin-arm64" ? 0x0100000c : 0x01000007)) {
        throw new Error("Extracted Electron Mach-O architecture does not match the pinned target.");
      }
    } finally {
      await handle.close();
    }
    return Object.freeze({target, files, links, expandedBytes,
      machine: target === "darwin-arm64" ? "arm64" : "x64"});
  } finally {
    await fs.rm(temporary, {recursive: true, force: true});
  }
}
