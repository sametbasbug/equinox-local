import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const SAFE_FILE_ERROR_CODES = Object.freeze({
  notNormal: "EQUINOX_SAFE_FILE_NOT_NORMAL",
  tooSmall: "EQUINOX_SAFE_FILE_TOO_SMALL",
  tooLarge: "EQUINOX_SAFE_FILE_TOO_LARGE",
});

function safeFileError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateBounds(minBytes, maxBytes) {
  if (!Number.isInteger(minBytes) || minBytes < 0) {
    throw new Error("Safe file minimum byte bound must be a non-negative integer.");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes < minBytes) {
    throw new Error("Safe file maximum byte bound must be a positive integer not smaller than the minimum.");
  }
}

export async function readBoundedNormalFile(filePath, {
  fsImpl = fs,
  minBytes = 0,
  maxBytes,
  encoding = null,
  label = "File",
} = {}) {
  if (typeof filePath !== "string" || !filePath) {
    throw new Error(`${label} path must be non-empty text.`);
  }
  validateBounds(minBytes, maxBytes);
  if (encoding !== null && encoding !== "utf8") {
    throw new Error("Safe file reads support only raw bytes or UTF-8 text.");
  }
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error("This platform does not provide O_NOFOLLOW for safe file reads.");
  }

  const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  let handle;
  try {
    handle = await fsImpl.open(filePath, flags);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw safeFileError(`${label} must be a normal, non-symlink file.`, SAFE_FILE_ERROR_CODES.notNormal);
    }
    throw error;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw safeFileError(`${label} must be a normal file.`, SAFE_FILE_ERROR_CODES.notNormal);
    }
    if (stat.size < minBytes) {
      throw safeFileError(`${label} is smaller than the allowed minimum.`, SAFE_FILE_ERROR_CODES.tooSmall);
    }
    if (stat.size > maxBytes) {
      throw safeFileError(`${label} exceeds the allowed size.`, SAFE_FILE_ERROR_CODES.tooLarge);
    }

    const chunks = [];
    let total = 0;
    let position = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      if (remaining <= 0) break;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
      if (total > maxBytes) break;
    }

    if (total < minBytes) {
      throw safeFileError(`${label} became smaller than the allowed minimum while being read.`, SAFE_FILE_ERROR_CODES.tooSmall);
    }
    if (total > maxBytes) {
      throw safeFileError(`${label} exceeded the allowed size while being read.`, SAFE_FILE_ERROR_CODES.tooLarge);
    }

    const buffer = Buffer.concat(chunks, total);
    return Object.freeze({
      data: encoding === "utf8" ? buffer.toString("utf8") : buffer,
      stat,
    });
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function writeBoundedUtf8File(filePath, {
  content,
  expectedSha256,
  fsImpl = fs,
  maxBytes = 512 * 1024,
  maxExistingBytes = 10 * 1024 * 1024,
  label = "File",
} = {}) {
  if (typeof filePath !== "string" || !filePath) {
    throw new Error(`${label} path must be non-empty text.`);
  }
  if (typeof content !== "string" || content.includes("\0")) {
    throw new Error(`${label} content must be UTF-8 text without NUL characters.`);
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Safe file maximum byte bound must be a positive integer.");
  }
  if (!Number.isInteger(maxExistingBytes) || maxExistingBytes < 1) {
    throw new Error("Safe existing-file byte bound must be a positive integer.");
  }

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxBytes) {
    throw safeFileError(`${label} exceeds the allowed size.`, SAFE_FILE_ERROR_CODES.tooLarge);
  }

  const parentPath = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const parentStat = await fsImpl.stat(parentPath);
  if (!parentStat.isDirectory()) {
    throw new Error(`${label} parent path must be a directory.`);
  }

  let existing = null;
  try {
    existing = await fsImpl.lstat(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  let previousSha256 = null;
  let mode = 0o644;
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw safeFileError(
        `${label} must be a normal, non-symlink file.`,
        SAFE_FILE_ERROR_CODES.notNormal,
      );
    }
    if (typeof expectedSha256 !== "string" || !/^[a-fA-F0-9]{64}$/u.test(expectedSha256)) {
      throw new Error(`${label} replacement requires expectedSha256.`);
    }
    if (existing.size > maxExistingBytes) {
      throw safeFileError(`${label} exceeds the allowed replacement size.`, SAFE_FILE_ERROR_CODES.tooLarge);
    }
    const current = await readBoundedNormalFile(filePath, {
      fsImpl,
      maxBytes: maxExistingBytes,
      label,
    });
    previousSha256 = createHash("sha256").update(current.data).digest("hex");
    if (previousSha256 !== expectedSha256.toLowerCase()) {
      throw new Error(
        `${label} SHA-256 guard mismatch. Expected: ${expectedSha256.toLowerCase()} Current: ${previousSha256}`,
      );
    }
    mode = existing.mode & 0o777;
  } else if (expectedSha256 !== undefined) {
    throw new Error(`${label} does not exist; expectedSha256 is only valid for replacement.`);
  }

  const temporaryPath = path.join(
    parentPath,
    `.${baseName}.equinox-write-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  let temporaryCreated = false;
  try {
    const handle = await fsImpl.open(temporaryPath, "wx", mode);
    temporaryCreated = true;
    try {
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (existing) {
      const current = await readBoundedNormalFile(filePath, {
        fsImpl,
        maxBytes: maxExistingBytes,
        label,
      });
      const currentSha256 = createHash("sha256").update(current.data).digest("hex");
      if (currentSha256 !== expectedSha256.toLowerCase()) {
        throw new Error(
          `${label} SHA-256 guard changed before replacement. Expected: ${expectedSha256.toLowerCase()} Current: ${currentSha256}`,
        );
      }
    }
    await fsImpl.rename(temporaryPath, filePath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) {
      await fsImpl.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  return Object.freeze({
    created: !existing,
    replaced: Boolean(existing),
    previousSha256,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bytes,
  });
}
