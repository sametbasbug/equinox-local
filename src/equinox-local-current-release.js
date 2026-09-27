import { createHash } from "node:crypto";
import fs from "node:fs/promises";

import { readBoundedNormalFile, writeBoundedUtf8File } from "./equinox-local-safe-file.js";
import { parseEquinoxVersion } from "./equinox-local-updater.js";

export const EQUINOX_LOCAL_CURRENT_VERSION_SCHEMA_VERSION = 1;
const MAX_CURRENT_POINTER_BYTES = 4 * 1024;

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

export function parseEquinoxLocalCurrentVersionPointer(raw, { target = "win32-x64" } = {}) {
  exactKeys(raw, ["schemaVersion", "target", "version"], "Current-version pointer");
  if (raw.schemaVersion !== EQUINOX_LOCAL_CURRENT_VERSION_SCHEMA_VERSION) {
    throw new Error("Unsupported current-version pointer schema.");
  }
  if (raw.target !== target) {
    throw new Error("Current-version pointer target does not match this Equinox Local build.");
  }
  const version = parseEquinoxVersion(raw.version).text;
  return Object.freeze({ schemaVersion: raw.schemaVersion, target: raw.target, version });
}

export function serializeEquinoxLocalCurrentVersionPointer({ version, target = "win32-x64" } = {}) {
  const normalized = parseEquinoxLocalCurrentVersionPointer({
    schemaVersion: EQUINOX_LOCAL_CURRENT_VERSION_SCHEMA_VERSION,
    target,
    version,
  }, { target });
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export async function readEquinoxLocalCurrentVersionPointer(filePath, {
  fsImpl = fs,
  platform = process.platform,
  target = "win32-x64",
} = {}) {
  const { data } = await readBoundedNormalFile(filePath, {
    fsImpl,
    platform,
    minBytes: 1,
    maxBytes: MAX_CURRENT_POINTER_BYTES,
    encoding: "utf8",
    label: "Equinox Local current-version pointer",
  });
  let raw;
  try {
    raw = JSON.parse(data);
  } catch {
    throw new Error("Equinox Local current-version pointer is not valid JSON.");
  }
  return parseEquinoxLocalCurrentVersionPointer(raw, { target });
}

export async function writeEquinoxLocalCurrentVersionPointer(filePath, {
  version,
  fsImpl = fs,
  platform = process.platform,
  target = "win32-x64",
} = {}) {
  if (platform !== "win32") throw new Error("Version-file current pointers are supported only on Windows.");
  const content = serializeEquinoxLocalCurrentVersionPointer({ version, target });
  let expectedSha256;
  try {
    const current = await readBoundedNormalFile(filePath, {
      fsImpl,
      platform,
      minBytes: 1,
      maxBytes: MAX_CURRENT_POINTER_BYTES,
      label: "Equinox Local current-version pointer",
    });
    expectedSha256 = createHash("sha256").update(current.data).digest("hex");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await writeBoundedUtf8File(filePath, {
    content,
    ...(expectedSha256 ? { expectedSha256 } : {}),
    fsImpl,
    maxBytes: MAX_CURRENT_POINTER_BYTES,
    maxExistingBytes: MAX_CURRENT_POINTER_BYTES,
    label: "Equinox Local current-version pointer",
  });
  return parseEquinoxLocalCurrentVersionPointer(JSON.parse(content), { target });
}
