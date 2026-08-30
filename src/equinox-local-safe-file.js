import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";

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
