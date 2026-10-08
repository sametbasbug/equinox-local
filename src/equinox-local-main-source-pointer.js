import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { inspectCanonicalMainCheckout } from "./equinox-local-main-update.js";
import { inspectPrivateStatePath, protectWindowsPrivateStatePath, verifyWindowsPrivateStateAcl } from "./equinox-local-private-state.js";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const MAX_BYTES = 8 * 1024;
export const EQUINOX_LOCAL_MAIN_SOURCE_POINTER_SCHEMA_VERSION = 1;

function assertAbsoluteNormalPath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error(`${label} must be an absolute normal path.`);
  }
  return path.resolve(value);
}
function assertSha(value) {
  if (!SHA_PATTERN.test(value ?? "")) throw new Error("Main source pointer SHA is invalid.");
  return value;
}
async function syncDirectory(directory, fsImpl) {
  if (process.platform === "win32") return;
  const handle = await fsImpl.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
function parsePointer(text) {
  const values = new Map();
  for (const raw of String(text).split(/\r?\n/u)) {
    if (!raw) continue;
    const index = raw.indexOf("=");
    if (index <= 0) throw new Error("Main source pointer is malformed.");
    const key = raw.slice(0, index);
    const value = raw.slice(index + 1);
    if (!new Set(["schemaVersion", "sourceRoot", "sha"]).has(key) || values.has(key)) throw new Error("Main source pointer contains unsupported or duplicate fields.");
    values.set(key, value);
  }
  if (values.size !== 3 || values.get("schemaVersion") !== String(EQUINOX_LOCAL_MAIN_SOURCE_POINTER_SCHEMA_VERSION)) throw new Error("Main source pointer schema is invalid.");
  return Object.freeze({
    schemaVersion: EQUINOX_LOCAL_MAIN_SOURCE_POINTER_SCHEMA_VERSION,
    sourceRoot: assertAbsoluteNormalPath(values.get("sourceRoot"), "Main source pointer sourceRoot"),
    sha: assertSha(values.get("sha")),
  });
}

export async function readEquinoxLocalMainSourcePointer(pointerPath, { fsImpl = fs, execFileImpl, gitPath = "git" } = {}) {
  const resolvedPath = assertAbsoluteNormalPath(pointerPath, "Main source pointer path");
  let handle;
  try {
    handle = await fsImpl.open(resolvedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Main source pointer must be a bounded regular file.");
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("Main source pointer permissions must be private.");
    const body = await handle.readFile("utf8");
    if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Main source pointer exceeds the size limit.");
    const value = parsePointer(body);
    const checkout = await inspectCanonicalMainCheckout(value.sourceRoot, { fsImpl, execFileImpl, gitPath });
    if (!checkout.eligible) throw new Error(`Main source pointer target is not update-eligible: ${checkout.reason}`);
    if (checkout.currentSha !== value.sha) throw new Error("Main source pointer SHA does not match its checkout.");
    return Object.freeze({ ...value, sourceRoot: checkout.sourceRoot ?? value.sourceRoot });
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function writeEquinoxLocalMainSourcePointer(pointerPath, { sourceRoot, sha }, {
  fsImpl = fs,
  execFileImpl,
  gitPath = "git",
  randomBytesImpl = randomBytes,
  platform = process.platform,
  env = process.env,
  protectWindowsAcl = protectWindowsPrivateStatePath,
  verifyWindowsAcl = verifyWindowsPrivateStateAcl,
} = {}) {
  const resolvedPath = assertAbsoluteNormalPath(pointerPath, "Main source pointer path");
  const resolvedRoot = assertAbsoluteNormalPath(sourceRoot, "Main source pointer sourceRoot");
  assertSha(sha);
  const checkout = await inspectCanonicalMainCheckout(resolvedRoot, { fsImpl, execFileImpl, gitPath });
  if (!checkout.eligible) throw new Error(`Main source pointer target is not update-eligible: ${checkout.reason}`);
  if (checkout.currentSha !== sha) throw new Error("Main source pointer target SHA changed before activation.");
  const parent = path.dirname(resolvedPath);
  await fsImpl.mkdir(parent, { recursive: true, mode: 0o700 });
  const [parentStat, parentReal] = await Promise.all([fsImpl.lstat(parent), fsImpl.realpath(parent)]);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentReal !== parent) throw new Error("Main source pointer parent is unsafe.");
  if (platform === "win32") {
    const parentSecurity = await inspectPrivateStatePath(parent, { platform, type: "directory", fsImpl, verifyWindowsAcl });
    if (!parentSecurity.safe) throw new Error("Main source pointer parent must be private.");
  } else if ((parentStat.mode & 0o022) !== 0) {
    throw new Error("Main source pointer parent must not be group/world writable.");
  }
  const tempPath = path.join(parent, `.main-source-${randomBytesImpl(8).toString("hex")}.tmp`);
  const body = `schemaVersion=${EQUINOX_LOCAL_MAIN_SOURCE_POINTER_SCHEMA_VERSION}\nsourceRoot=${resolvedRoot}\nsha=${sha}\n`;
  let handle;
  try {
    handle = await fsImpl.open(tempPath, "wx", 0o600);
    await handle.writeFile(body, "utf8"); await handle.sync(); await handle.close(); handle = null;
    if (platform === "win32") {
      await protectWindowsAcl({ target: tempPath, type: "file", env });
      const tempSecurity = await inspectPrivateStatePath(tempPath, { platform, type: "file", fsImpl, verifyWindowsAcl });
      if (!tempSecurity.safe) throw new Error("Main source pointer temporary file is not private.");
    }
    await fsImpl.rename(tempPath, resolvedPath); await syncDirectory(parent, fsImpl);
    if (platform === "win32") {
      const finalSecurity = await inspectPrivateStatePath(resolvedPath, { platform, type: "file", fsImpl, verifyWindowsAcl });
      if (!finalSecurity.safe) throw new Error("Main source pointer protection changed during publish.");
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsImpl.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return await readEquinoxLocalMainSourcePointer(resolvedPath, { fsImpl, execFileImpl, gitPath });
}
