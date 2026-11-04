import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { inspectPinnedElectronZip } from "./inspect-pinned-electron-zip.mjs";

// Pure, read-only attestation of an already extracted Windows UI tree.
// This does NOT activate, repair, spawn or authorize a native Main version.
// The caller must separately prove the original signed Main selector/store,
// product-owned ACL and exclusive native UI process/installer ownership.
const MAX_ENTRIES = 5_000;
const MAX_BYTES = 1024 * 1024 * 1024;

export async function inspectExtractedPinnedWindowsElectron({
  archivePath, target, extractedRoot,
}: { archivePath: string; target: string; extractedRoot: string }): Promise<Readonly<{
  target: string; entries: number; files: number; bytes: number; executablePath: string;
}>> {
  if ((target !== "win32-x64" && target !== "win32-arm64") ||
      !path.isAbsolute(archivePath) || !path.isAbsolute(extractedRoot) ||
      path.normalize(extractedRoot) !== extractedRoot) {
    throw new Error("Windows Electron verification requires a fixed target and absolute installed root.");
  }
  const admitted = await inspectPinnedElectronZip({archivePath, target, includeMemberDigests: true});
  if (!admitted.members || admitted.links) throw new Error("Pinned Windows Electron ZIP must contain only regular files and directories.");
  const root = await fs.realpath(extractedRoot);
  const rootStat = await fs.lstat(extractedRoot);
  if (root !== extractedRoot || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Extracted Electron Windows UI root is not a canonical normal directory.");
  }
  const expected = new Map<string, Readonly<{name: string; kind: string; bytes: number; sha256: string | null}>>();
  for (const member of admitted.members) {
    const segments = member.name.split("/");
    for (let i = 1; i < segments.length; i++) {
      const name = segments.slice(0, i).join("/");
      const lower = name.toLowerCase();
      const prior = expected.get(lower);
      if (prior && (prior.name !== name || prior.kind !== "directory")) {
        throw new Error("Pinned Windows Electron ZIP has a conflicting implicit directory.");
      }
      expected.set(lower, {name, kind: "directory", bytes: 0, sha256: null});
    }
    const lower = member.name.toLowerCase();
    const prior = expected.get(lower);
    if (prior && (prior.name !== member.name || prior.kind !== member.kind)) {
      throw new Error("Pinned Windows Electron ZIP contains a conflicting path type.");
    }
    expected.set(lower, member);
  }
  const pending = [""];
  const seen = new Set<string>();
  const buffer = Buffer.alloc(1024 * 1024);
  let files = 0;
  let totalBytes = 0;
  while (pending.length) {
    const relative = pending.pop()!;
    const folder = path.join(root, relative);
    for (const name of await fs.readdir(folder)) {
      const subpath = relative ? relative.replaceAll(path.sep, "/") + "/" + name : name;
      const lookup = subpath.toLowerCase();
      const member = expected.get(lookup);
      if (!member || member.name !== subpath || seen.has(lookup) || seen.size >= MAX_ENTRIES) {
        throw new Error("Installed Windows Electron contains an unexpected or aliased entry.");
      }
      seen.add(lookup);
      const full = path.join(folder, name);
      // Open regular content BEFORE examining its path: Windows cannot
      // always open a directory handle through Node, so in that case only
      // a matching non-reparse directory may be traversed, never a file.
      let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
      try {
        handle = await fs.open(full, fsConstants.O_RDONLY);
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) ||
            !["EPERM", "EACCES", "EISDIR"].includes(String(error.code))) throw error;
      }
      if (!handle) {
        const directory = await fs.lstat(full);
        if (member.kind !== "directory" || !directory.isDirectory() ||
            directory.isSymbolicLink() || await fs.realpath(full) !== full) {
          throw new Error("Installed Windows Electron directory cannot be safely opened.");
        }
        pending.push(subpath.split("/").join(path.sep));
        continue;
      }
      try {
        const opened = await handle.stat();
        const named = await fs.lstat(full);
        if (named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino ||
            await fs.realpath(full) !== full) {
          throw new Error("Installed Windows Electron contains a reparse alias or changed path.");
        }
        if (member.kind === "directory" && opened.isDirectory()) {
          pending.push(subpath.split("/").join(path.sep));
          continue;
        }
        if (member.kind !== "file" || !opened.isFile() || !member.sha256 ||
            opened.size !== member.bytes) {
          throw new Error("Installed Windows Electron entry type or length differs from the pinned ZIP.");
        }
        totalBytes += opened.size;
          if (totalBytes > MAX_BYTES) throw new Error("Installed Windows Electron exceeds the byte budget.");
          const digest = createHash("sha256");
          for (let position = 0; position < opened.size;) {
            const length = Math.min(buffer.length, opened.size - position);
            const {bytesRead} = await handle.read(buffer, 0, length, position);
            if (!bytesRead) throw new Error("Installed Windows Electron file was truncated.");
            digest.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
          }
          if (digest.digest("hex") !== member.sha256 ||
              (await handle.stat()).size !== opened.size) {
            throw new Error("Installed Windows Electron file differs from the pinned ZIP.");
          }
          const after = await fs.lstat(full);
          if (!after.isFile() || after.isSymbolicLink() ||
              after.dev !== opened.dev || after.ino !== opened.ino ||
              after.size !== opened.size || await fs.realpath(full) !== full) {
            throw new Error("Installed Windows Electron file path changed after verification.");
          }
          files++;
      } finally { await handle.close(); }
    }
  }
  if (seen.size !== expected.size || files < 3) {
    throw new Error("Installed Windows Electron is missing pinned ZIP members.");
  }
  const executablePath = path.join(root, "electron.exe");
  if (!seen.has("electron.exe")) throw new Error("Installed Windows Electron executable is missing.");
  return Object.freeze({target, entries: seen.size, files, bytes: totalBytes, executablePath});
}
