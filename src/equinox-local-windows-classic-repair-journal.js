import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { parseEquinoxVersion } from "./equinox-local-updater.js";

const SHA = /^[a-f0-9]{40}$/u;
const MAX_BYTES = 4096;

function exactKeys(record, keys) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error("Windows classic repair recovery record is malformed.");
  }
}

export function validateWindowsClassicRepairRecord(record) {
  const keys = [
    "schemaVersion", "target", "oldMainVersion", "oldSourceSha",
    "oldNativeSha", "oldStablePointerVersion", "targetVersion", "mainStamp",
  ];
  exactKeys(record, keys);
  if (record.schemaVersion !== 1 || !["win32-x64", "win32-arm64"].includes(record.target) ||
      !SHA.test(record.oldSourceSha) || !SHA.test(record.oldNativeSha) ||
      typeof record.mainStamp !== "string" || Buffer.byteLength(record.mainStamp) > 1024) {
    throw new Error("Windows classic repair recovery identity is invalid.");
  }
  for (const value of [record.oldMainVersion, record.oldStablePointerVersion, record.targetVersion]) {
    if (parseEquinoxVersion(value).text !== value) throw new Error("Windows classic repair version is invalid.");
  }
  return Object.freeze({ ...record });
}

export async function writeWindowsClassicRepairJournal(filePath, record, { fsImpl = fs } = {}) {
  const admitted = validateWindowsClassicRepairRecord(record);
  const body = JSON.stringify(admitted) + "\n";
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Windows classic repair journal is too large.");
  const parent = path.dirname(filePath);
  const parentStat = await fsImpl.lstat(parent);
  // Windows can canonicalize an ancestor to its long/short DOS spelling
  // even when the directory itself is an owned, normal folder. Resolve the
  // parent and its owner through the same filesystem view instead of
  // comparing an input spelling with realpath().
  const owner = path.dirname(parent);
  const ownerStat = await fsImpl.lstat(owner);
  const parentReal = await fsImpl.realpath(parent);
  const expectedReal = path.join(await fsImpl.realpath(owner), path.basename(parent));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
      !ownerStat.isDirectory() || ownerStat.isSymbolicLink() ||
      path.normalize(parentReal).toLowerCase() !== path.normalize(expectedReal).toLowerCase()) {
    throw new Error("Windows classic repair journal parent is unsafe.");
  }
  try {
    await fsImpl.lstat(filePath);
    throw new Error("An earlier Windows classic repair must be reconciled first.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temp = path.join(parent, `.classic-repair-${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fsImpl.open(temp, "wx", 0o600);
    await handle.writeFile(body);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.rename(temp, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsImpl.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return admitted;
}

export async function readWindowsClassicRepairJournal(filePath, { fsImpl = fs } = {}) {
  let data;
  try {
    ({ data } = await readBoundedNormalFile(filePath, {
      fsImpl, platform: "win32", minBytes: 2, maxBytes: MAX_BYTES,
      encoding: "utf8", label: "Windows classic repair journal",
    }));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let raw;
  try { raw = JSON.parse(data); }
  catch { throw new Error("Windows classic repair journal is not JSON."); }
  return validateWindowsClassicRepairRecord(raw);
}

// A private, durable journal is written before selecting Stable B. Any
// interrupted Main-to-Stable handoff is rolled back to its authenticated Main
// source/native A by default. Only an ALREADY fully committed healthy B with
// neither live nor parked Main stamp may be accepted without rollback.
export async function reconcileWindowsClassicRepairJournal({
  journalPath,
  expectedTarget,
  readStamp,
  readCurrentVersion,
  verifyPrevious,
  isCommittedStableHealthy,
  rollbackPreviousMain,
  isPreviousMainHealthy,
  fsImpl = fs,
} = {}) {
  const record = await readWindowsClassicRepairJournal(journalPath, { fsImpl });
  if (!record) return null;
  if (record.target !== expectedTarget) throw new Error("Windows classic repair journal belongs to a different architecture.");
  const state = await readStamp();
  if (state.live && state.parked) throw new Error("Windows classic repair has two conflicting Main owner stamps.");
  if (state.live && state.live !== record.mainStamp ||
      state.parked && state.parked !== record.mainStamp) {
    throw new Error("Windows classic repair Main ownership stamp changed.");
  }
  await verifyPrevious(record);
  const version = await readCurrentVersion();
  if (![record.oldStablePointerVersion, record.targetVersion].includes(version)) {
    throw new Error("Windows classic repair current pointer left the authenticated A/B range.");
  }
  if (!state.live && !state.parked) {
    if (version !== record.targetVersion || !await isCommittedStableHealthy(record)) {
      throw new Error("Windows classic repair lost its Main owner before Stable B was verified.");
    }
    await fsImpl.unlink(journalPath);
    return Object.freeze({ status: "activated", version: record.targetVersion });
  }
  if (state.parked || version === record.targetVersion || !await isPreviousMainHealthy(record)) {
    await rollbackPreviousMain(record, { parked: Boolean(state.parked) });
  }
  await fsImpl.unlink(journalPath);
  return Object.freeze({ status: "restored-main", version: record.oldMainVersion });
}
