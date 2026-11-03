import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { ELECTRON_DISTRIBUTIONS } from "../../src/equinox-local-runtime-versions.js";

// Read-only, bounded ZIP central-directory preflight. A successful inspection
// never extracts the archive, runs Electron, or loosens the Main tree's global
// prohibition on symlinks. Full SHA-256 admission is a separate mandatory gate.
const MAX_ZIP_ENTRIES = 5_000;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_LINK_BYTES = 1024;
const ZIP_END_BYTES = 65_557;
const FILE_TYPE_MASK = 0o170000;
const NORMAL_FILE = 0o100000;
const NORMAL_DIRECTORY = 0o040000;
const LINK = 0o120000;
const RESERVED_WINDOWS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

type ZipKind = "file" | "directory" | "symlink";
type ZipEntry = {name: string; kind: ZipKind; compressedBytes: number; uncompressedBytes: number; mode: number; method: number; localOffset: number; dataOffset?: number};

function verifiedRelative(name: string, isWindows: boolean): string {
  if (!name || name.length > 1024 || name.startsWith("/") || name.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(name) || name !== name.normalize("NFC")) {
    throw new Error("Pinned Electron ZIP contains an unsafe entry path.");
  }
  const normalized = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!normalized || normalized.split("/").some((segment) =>
    !segment || segment === "." || segment === ".." ||
    (isWindows && (/[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment) || RESERVED_WINDOWS.test(segment))))) {
    throw new Error("Pinned Electron ZIP entry escapes or aliases the install root.");
  }
  return normalized;
}

function resolvedLinkTarget(name: string, target: string): string {
  if (!target || target.length > MAX_LINK_BYTES || target.startsWith("/") ||
      target.includes("\\") || /[\u0000-\u001f\u007f]/u.test(target)) {
    throw new Error("Pinned Electron ZIP contains an unsafe symbolic link.");
  }
  const parts = name.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) throw new Error("Pinned Electron symbolic link escapes the archive.");
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  if (!parts.length) throw new Error("Pinned Electron symbolic link targets the archive root.");
  return parts.join("/");
}

export async function inspectPinnedElectronZip({
  archivePath,
  target,
}: {archivePath: string; target: string}): Promise<Readonly<{target: string; entries: number; links: number; unpackedBytes: number}>> {
  if (!Object.hasOwn(ELECTRON_DISTRIBUTIONS, target) || !path.isAbsolute(archivePath)) {
    throw new Error("Pinned Electron ZIP requires a supported target and absolute archive path.");
  }
  const pinned = ELECTRON_DISTRIBUTIONS[target as keyof typeof ELECTRON_DISTRIBUTIONS];
  if (!pinned) throw new Error("Pinned Electron target is not admitted.");
  // Open once: never stat one path and then reopen it for reading. POSIX uses
  // O_NOFOLLOW; on Windows the path is additionally checked after opening.
  // The same descriptor supplies size, bounded contents and exact SHA-256.
  const flags = fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW);
  const handle = await fs.open(archivePath, flags);
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    const pathStat = await fs.lstat(archivePath);
    if (!stat.isFile() || stat.size !== pinned.bytes ||
        pathStat.isSymbolicLink() || !pathStat.isFile() ||
        stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error("Pinned Electron ZIP is not an exact-size normal file.");
    }
    // Bounded reads also reject concurrent growth, rather than allowing
    // readFile to allocate arbitrary memory after the initial stat call.
    bytes = Buffer.alloc(pinned.bytes);
    let cursor = 0;
    while (cursor < bytes.length) {
      const { bytesRead } = await handle.read(bytes, cursor,
        Math.min(1024 * 1024, bytes.length - cursor), cursor);
      if (bytesRead < 1) throw new Error("Pinned Electron ZIP was truncated during inspection.");
      cursor += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0 ||
        createHash("sha256").update(bytes).digest("hex") !== pinned.sha256) {
      throw new Error("Pinned Electron ZIP content changed or does not match the official digest.");
    }
  } finally {
    await handle.close();
  }
  const isWindows = target.startsWith("win32-");
  const endStart = Math.max(0, bytes.length - ZIP_END_BYTES);
  let end = -1;
  for (let at = bytes.length - 22; at >= endStart; at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 &&
        at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) {
      end = at; break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) {
    throw new Error("Pinned Electron ZIP has no valid single-disk end record.");
  }
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralOffset = bytes.readUInt32LE(end + 16);
  if (!count || count > MAX_ZIP_ENTRIES || count !== bytes.readUInt16LE(end + 8) ||
      count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
      centralOffset + centralSize !== end || centralOffset < 0) {
    throw new Error("Pinned Electron ZIP central directory is unsupported or unbounded.");
  }

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let cursor = centralOffset;
  let unpackedBytes = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Pinned Electron ZIP central directory is malformed.");
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedBytes = bytes.readUInt32LE(cursor + 20);
    const uncompressedBytes = bytes.readUInt32LE(cursor + 24);
    const nameBytes = bytes.readUInt16LE(cursor + 28);
    const extraBytes = bytes.readUInt16LE(cursor + 30);
    const commentBytes = bytes.readUInt16LE(cursor + 32);
    const disk = bytes.readUInt16LE(cursor + 34);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (!nameBytes || next > end || disk || (flags & ~0x800) !== 0 ||
        ![0, 8].includes(method) || compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff ||
        uncompressedBytes > MAX_ENTRY_BYTES || compressedBytes > pinned.bytes) {
      throw new Error("Pinned Electron ZIP contains unsupported or oversized member metadata.");
    }
    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + nameBytes);
    const normal = verifiedRelative(name, isWindows);
    // Default APFS and Windows installs are both case-insensitive.
    const unique = normal.toLowerCase();
    if (names.has(unique)) throw new Error("Pinned Electron ZIP contains duplicate or aliased entries.");
    names.add(unique);
    const kindBits = mode & FILE_TYPE_MASK;
    const kind: ZipKind = kindBits === LINK ? "symlink" : name.endsWith("/") ? "directory" : "file";
    if ((kind === "directory" && kindBits !== 0 && kindBits !== NORMAL_DIRECTORY) ||
        (kind === "file" && kindBits !== 0 && kindBits !== NORMAL_FILE) ||
        (kind === "symlink" && (isWindows || uncompressedBytes > MAX_LINK_BYTES)) ||
        (kind === "directory" && (uncompressedBytes !== 0 || compressedBytes !== 0))) {
      throw new Error("Pinned Electron ZIP contains an unsupported filesystem entry.");
    }
    unpackedBytes += uncompressedBytes;
    if (unpackedBytes > MAX_UNPACKED_BYTES) throw new Error("Pinned Electron ZIP exceeds extracted size budget.");
    entries.push({name: normal, kind, compressedBytes, uncompressedBytes, mode, method, localOffset});
    cursor = next;
  }
  if (cursor !== end) throw new Error("Pinned Electron ZIP central directory has trailing data.");

  const localRanges: Array<{start: number; end: number}> = [];
  for (const entry of entries) {
    const at = entry.localOffset;
    if (at + 30 > centralOffset || bytes.readUInt32LE(at) !== 0x04034b50 ||
        (bytes.readUInt16LE(at + 6) & ~0x800) !== 0 ||
        bytes.readUInt16LE(at + 8) !== entry.method ||
        bytes.readUInt32LE(at + 18) !== entry.compressedBytes ||
        bytes.readUInt32LE(at + 22) !== entry.uncompressedBytes) {
      throw new Error("Pinned Electron ZIP local header does not match the central directory.");
    }
    const nameLength = bytes.readUInt16LE(at + 26);
    const extraLength = bytes.readUInt16LE(at + 28);
    const offset = at + 30 + nameLength + extraLength;
    if (offset + entry.compressedBytes > centralOffset ||
        bytes.toString("utf8", at + 30, at + 30 + nameLength) !==
          (entry.kind === "directory" ? entry.name + "/" : entry.name)) {
      throw new Error("Pinned Electron ZIP local member escapes its declared bounds.");
    }
    entry.dataOffset = offset;
    localRanges.push({start: at, end: offset + entry.compressedBytes});
  }
  localRanges.sort((a, b) => a.start - b.start);
  if (localRanges.some((range, index) => index > 0 && range.start < localRanges[index - 1]!.end)) {
    throw new Error("Pinned Electron ZIP local member ranges overlap.");
  }

  const symlinks = new Map(entries.filter((item) => item.kind === "symlink").map((item) => [item.name, item]));
  for (const entry of entries) {
    for (const linkName of symlinks.keys()) {
      if (entry.name.startsWith(linkName + "/")) {
        throw new Error("Pinned Electron ZIP writes through a symbolic-link directory.");
      }
    }
  }
  // Inspect relative framework link bodies without writing to the filesystem.
  for (const entry of symlinks.values()) {
    if (entry.dataOffset === undefined) throw new Error("Pinned Electron link is missing its local data offset.");
    const data = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedBytes);
    const contents = entry.method === 0 ? data : inflateRawSync(data, {maxOutputLength: MAX_LINK_BYTES + 1});
    if (contents.length !== entry.uncompressedBytes) throw new Error("Pinned Electron symbolic link size is inconsistent.");
    resolvedLinkTarget(entry.name, contents.toString("utf8"));
  }
  const required = isWindows
    ? ["electron.exe", "LICENSE", "LICENSES.chromium.html"]
    : ["Electron.app/Contents/MacOS/Electron", "LICENSE", "LICENSES.chromium.html"];
  for (const name of required) {
    if (!entries.some((entry) => entry.name === name && entry.kind === "file")) {
      throw new Error("Pinned Electron ZIP is missing a required binary or license.");
    }
  }
  return Object.freeze({target, entries: entries.length, links: symlinks.size, unpackedBytes});
}
