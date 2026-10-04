import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { readEquinoxLocalMainSourcePointer, writeEquinoxLocalMainSourcePointer } from "./equinox-local-main-source-pointer.js";
import {
  EQUINOX_LOCAL_MAIN_BRANCH,
  EQUINOX_LOCAL_MAIN_REMOTE,
  inspectCanonicalMainCheckout,
  isCanonicalMainRemote,
} from "./equinox-local-main-update.js";

const execFile = promisify(execFileCallback);
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const TRANSACTION_ID_PATTERN = /^main-[a-f0-9]{32}$/u;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_ERROR_LENGTH = 500;
export const EQUINOX_LOCAL_MAIN_TRANSACTION_SCHEMA_VERSION = 1;

function boundedMessage(value) {
  return String(value ?? "").replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_ERROR_LENGTH);
}
function assertSha(value, label) {
  if (!SHA_PATTERN.test(value ?? "")) throw new Error(`${label} must be an exact lowercase 40-character Git SHA.`);
  return value;
}
function assertTransactionId(value) {
  if (!TRANSACTION_ID_PATTERN.test(value ?? "")) throw new Error("Main update transaction id is invalid.");
  return value;
}
function assertOptionalAbsolutePath(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\n") || value.includes("\r") || value.includes("\0")) throw new Error(`${label} is invalid.`);
  return path.resolve(value);
}
function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
async function assertCanonicalDirectory(directory, { fsImpl = fs, create = false } = {}) {
  const resolved = path.resolve(directory);
  if (!path.isAbsolute(directory)) throw new Error("Main update transaction paths must be absolute.");
  if (create) await fsImpl.mkdir(resolved, { recursive: true, mode: 0o700 });
  const [stat, real] = await Promise.all([fsImpl.lstat(resolved), fsImpl.realpath(resolved)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved) throw new Error(`Main update directory is not a canonical normal directory: ${resolved}`);
  return resolved;
}
async function syncDirectory(directory, { fsImpl = fs } = {}) {
  if (process.platform === "win32") return;
  const handle = await fsImpl.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeAtomicPrivateJson(filePath, value, { fsImpl = fs } = {}) {
  const parent = path.dirname(filePath);
  await fsImpl.mkdir(parent, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_RECEIPT_BYTES) throw new Error("Main update receipt exceeds the size limit.");
  let handle;
  try {
    handle = await fsImpl.open(tempPath, "wx", 0o600);
    await handle.writeFile(body, "utf8"); await handle.sync(); await handle.close(); handle = null;
    await fsImpl.rename(tempPath, filePath); await syncDirectory(parent, { fsImpl });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsImpl.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}
async function readBoundedJsonFile(filePath, { fsImpl = fs } = {}) {
  let handle;
  try {
    handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) throw new Error("Main update state file is not an admissible regular file.");
    const body = await handle.readFile("utf8");
    if (Buffer.byteLength(body) > MAX_RECEIPT_BYTES) throw new Error("Main update state file exceeds the size limit.");
    try { return JSON.parse(body); } catch { throw new Error("Main update state file contains invalid JSON."); }
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} contains missing or unsupported fields.`);
}
function validateLockMarker(value) {
  assertExactKeys(value, ["schemaVersion", "transactionId", "channel", "currentSha", "targetSha", "startedAt"], "Main update lock marker");
  assertTransactionId(value.transactionId); assertSha(value.currentSha, "Current SHA"); assertSha(value.targetSha, "Target SHA");
  if (value.schemaVersion !== EQUINOX_LOCAL_MAIN_TRANSACTION_SCHEMA_VERSION || value.channel !== "main") throw new Error("Main update lock identity is invalid.");
  if (typeof value.startedAt !== "string" || Number.isNaN(Date.parse(value.startedAt))) throw new Error("Main update lock timestamp is invalid.");
  return Object.freeze({ ...value });
}
function validateReceipt(value) {
  assertExactKeys(value, ["schemaVersion", "transactionId", "channel", "status", "stage", "currentSha", "targetSha", "rollbackSha", "rollbackSourceRoot", "targetSourceRoot", "startedAt", "updatedAt", "lastError"], "Main update receipt");
  assertTransactionId(value.transactionId); assertSha(value.currentSha, "Current SHA"); assertSha(value.targetSha, "Target SHA"); assertSha(value.rollbackSha, "Rollback SHA");
  if (value.rollbackSha !== value.currentSha) throw new Error("Main update receipt rollback SHA does not match the admitted source SHA.");
  assertOptionalAbsolutePath(value.rollbackSourceRoot, "Main update rollback source root");
  assertOptionalAbsolutePath(value.targetSourceRoot, "Main update target source root");
  if (value.schemaVersion !== EQUINOX_LOCAL_MAIN_TRANSACTION_SCHEMA_VERSION || value.channel !== "main") throw new Error("Main update receipt identity is invalid.");
  if (!["active", "staged", "failed", "promoting", "verifying", "succeeded", "rolled_back", "rollback_failed"].includes(value.status)) throw new Error("Main update receipt status is invalid.");
  if (typeof value.stage !== "string" || value.stage.length < 1 || value.stage.length > 80) throw new Error("Main update receipt stage is invalid.");
  for (const key of ["startedAt", "updatedAt"]) if (typeof value[key] !== "string" || Number.isNaN(Date.parse(value[key]))) throw new Error(`Main update receipt ${key} is invalid.`);
  if (value.lastError !== null && (typeof value.lastError !== "string" || value.lastError.length > MAX_ERROR_LENGTH)) throw new Error("Main update receipt error is invalid.");
  return Object.freeze({ ...value });
}
async function run(command, args, { cwd, execFileImpl = execFile, timeout = COMMAND_TIMEOUT_MS } = {}) {
  return await execFileImpl(command, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", npm_config_audit: "false", npm_config_fund: "false" } });
}
async function assertStagedCheckout(stageRoot, targetSha, { execFileImpl = execFile, fsImpl = fs } = {}) {
  const root = await assertCanonicalDirectory(stageRoot, { fsImpl });
  const top = String((await run("git", ["-C", root, "rev-parse", "--show-toplevel"], { execFileImpl })).stdout ?? "").trim();
  if (path.resolve(top) !== root) throw new Error("Staged checkout root does not match its Git top-level directory.");
  const head = String((await run("git", ["-C", root, "rev-parse", "HEAD"], { execFileImpl })).stdout ?? "").trim();
  if (head !== targetSha) throw new Error("Staged checkout HEAD does not match the pinned target SHA.");
  const remote = String((await run("git", ["-C", root, "remote", "get-url", "origin"], { execFileImpl })).stdout ?? "").trim();
  if (!isCanonicalMainRemote(remote)) throw new Error("Staged checkout origin is not canonical.");
  const branch = String((await run("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], { execFileImpl })).stdout ?? "").trim();
  if (branch !== EQUINOX_LOCAL_MAIN_BRANCH) throw new Error("Staged checkout is not on canonical main.");
  const dirty = String((await run("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=normal"], { execFileImpl })).stdout ?? "").trim();
  if (dirty) throw new Error("Staged checkout is not clean.");
  return Object.freeze({ sourceRoot: root, head, branch, remote });
}

export function createEquinoxLocalMainUpdateTransactionEngine({
  sourceRoot,
  transactionRoot,
  sourcePointerPath = path.join(transactionRoot ?? "", "current-source.conf"),
  sourceStoreRoot = path.join(transactionRoot ?? "", "sources"),
  fsImpl = fs,
  execFileImpl = execFile,
  now = () => new Date(),
  randomBytesImpl = randomBytes,
  installDependencies = async ({ stagedSourceRoot }) => {
    await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: stagedSourceRoot, execFileImpl });
  },
  validateStagedSource = async ({ stagedSourceRoot }) => {
    await run("npm", ["run", "check"], { cwd: stagedSourceRoot, execFileImpl });
    await run(process.execPath, ["--test", "tests/release/equinox-local-main-update.test.js"], { cwd: stagedSourceRoot, execFileImpl });
  },
} = {}) {
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) throw new Error("Main update source root must be absolute.");
  if (typeof transactionRoot !== "string" || !path.isAbsolute(transactionRoot)) throw new Error("Main update transaction root must be absolute.");
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedTransactionRoot = path.resolve(transactionRoot);
  const resolvedPointerPath = path.resolve(sourcePointerPath);
  const resolvedSourceStoreRoot = path.resolve(sourceStoreRoot);
  if (isInside(resolvedSourceRoot, resolvedTransactionRoot) || isInside(resolvedTransactionRoot, resolvedSourceRoot)) throw new Error("Main update transaction state and active source checkout must not overlap.");
  if (!isInside(resolvedTransactionRoot, resolvedPointerPath) || !isInside(resolvedTransactionRoot, resolvedSourceStoreRoot)) throw new Error("Main update pointer and source store must remain inside transaction state.");

  const lockPath = path.join(resolvedTransactionRoot, "active.json");
  const receiptsRoot = path.join(resolvedTransactionRoot, "receipts");
  const stagingRoot = path.join(resolvedTransactionRoot, "staging");

  const receiptPathFor = (transactionId) => path.join(receiptsRoot, `${assertTransactionId(transactionId)}.json`);
  const readReceipt = async (transactionId) => validateReceipt(await readBoundedJsonFile(receiptPathFor(transactionId), { fsImpl }));
  const readActive = async () => {
    let marker;
    try { marker = validateLockMarker(await readBoundedJsonFile(lockPath, { fsImpl })); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    try { return await readReceipt(marker.transactionId); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return Object.freeze({ ...marker, status: "active", stage: "admitted", rollbackSha: marker.currentSha, rollbackSourceRoot: resolvedSourceRoot, targetSourceRoot: null, updatedAt: marker.startedAt, lastError: null });
    }
  };
  const writeReceipt = async (receipt) => {
    const validated = validateReceipt(receipt);
    await writeAtomicPrivateJson(receiptPathFor(validated.transactionId), validated, { fsImpl });
    return validated;
  };

  const begin = async ({ currentSha, targetSha }) => {
    assertSha(currentSha, "Current SHA"); assertSha(targetSha, "Target SHA");
    if (currentSha === targetSha) throw new Error("Main update target already matches the current source SHA.");
    await assertCanonicalDirectory(resolvedTransactionRoot, { fsImpl, create: true });
    await fsImpl.mkdir(receiptsRoot, { recursive: true, mode: 0o700 });
    await fsImpl.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const active = await readActive();
    if (active) throw new Error(`Main update transaction ${active.transactionId} already owns the update lock.`);

    const local = await inspectCanonicalMainCheckout(resolvedSourceRoot, { fsImpl, execFileImpl });
    if (!local.eligible) throw new Error(`Active source checkout is not update-eligible: ${local.reason}`);
    if (local.currentSha !== currentSha) throw new Error("Active source SHA changed after update discovery.");

    const transactionId = `main-${randomBytesImpl(16).toString("hex")}`;
    assertTransactionId(transactionId);
    const timestamp = now().toISOString();
    const receipt = Object.freeze({
      schemaVersion: EQUINOX_LOCAL_MAIN_TRANSACTION_SCHEMA_VERSION,
      transactionId, channel: "main", status: "active", stage: "admitted",
      currentSha, targetSha, rollbackSha: currentSha,
      rollbackSourceRoot: resolvedSourceRoot, targetSourceRoot: null,
      startedAt: timestamp, updatedAt: timestamp, lastError: null,
    });
    let lockHandle;
    try {
      const marker = { schemaVersion: receipt.schemaVersion, transactionId, channel: "main", currentSha, targetSha, startedAt: timestamp };
      lockHandle = await fsImpl.open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
      await lockHandle.sync(); await lockHandle.close(); lockHandle = null;
      await syncDirectory(resolvedTransactionRoot, { fsImpl });
      await writeAtomicPrivateJson(receiptPathFor(transactionId), receipt, { fsImpl });
    } catch (error) {
      if (lockHandle) await lockHandle.close().catch(() => {});
      if (error?.code === "EEXIST") {
        const owner = await readActive().catch(() => null);
        throw new Error(owner ? `Main update transaction ${owner.transactionId} already owns the update lock.` : "Main update lock already exists.");
      }
      throw error;
    }
    return receipt;
  };

  const stage = async ({ currentSha, targetSha }) => {
    let receipt = await begin({ currentSha, targetSha });
    const transactionDir = path.join(stagingRoot, receipt.transactionId);
    const stagedSourceRoot = path.join(transactionDir, "source");
    try {
      await fsImpl.mkdir(transactionDir, { recursive: false, mode: 0o700 });
      await run("git", ["clone", "--no-checkout", "--filter=blob:none", "--single-branch", "--branch", EQUINOX_LOCAL_MAIN_BRANCH, EQUINOX_LOCAL_MAIN_REMOTE, stagedSourceRoot], { execFileImpl });
      await run("git", ["-C", stagedSourceRoot, "checkout", "--force", "-B", EQUINOX_LOCAL_MAIN_BRANCH, targetSha], { execFileImpl });
      await assertStagedCheckout(stagedSourceRoot, targetSha, { execFileImpl, fsImpl });
      receipt = await writeReceipt(Object.freeze({ ...receipt, stage: "dependencies", updatedAt: now().toISOString() }));
      await installDependencies({ stagedSourceRoot, currentSha, targetSha, transactionId: receipt.transactionId });
      receipt = await writeReceipt(Object.freeze({ ...receipt, stage: "validation", updatedAt: now().toISOString() }));
      await validateStagedSource({ stagedSourceRoot, currentSha, targetSha, transactionId: receipt.transactionId });
      await assertStagedCheckout(stagedSourceRoot, targetSha, { execFileImpl, fsImpl });
      receipt = await writeReceipt(Object.freeze({ ...receipt, status: "staged", stage: "staged", updatedAt: now().toISOString() }));
      return Object.freeze({ receipt, stagedSourceRoot });
    } catch (error) {
      const failed = Object.freeze({ ...receipt, status: "failed", updatedAt: now().toISOString(), lastError: boundedMessage(error instanceof Error ? error.message : error) });
      await writeReceipt(failed).catch(() => {});
      const owner = await readActive().catch(() => null);
      if (owner?.transactionId === receipt.transactionId) await fsImpl.rm(lockPath, { force: true });
      throw error;
    }
  };

  const initializeSourcePointer = async () => {
    const local = await inspectCanonicalMainCheckout(resolvedSourceRoot, { fsImpl, execFileImpl });
    if (!local.eligible) throw new Error(`Active source checkout is not update-eligible: ${local.reason}`);
    try {
      const existing = await readEquinoxLocalMainSourcePointer(resolvedPointerPath, { fsImpl, execFileImpl });
      if (existing.sourceRoot !== resolvedSourceRoot || existing.sha !== local.currentSha) throw new Error("Existing main source pointer does not match the active checkout.");
      return existing;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return await writeEquinoxLocalMainSourcePointer(resolvedPointerPath, { sourceRoot: resolvedSourceRoot, sha: local.currentSha }, { fsImpl, execFileImpl, randomBytesImpl });
  };

  const preparePromotion = async (transactionId) => {
    assertTransactionId(transactionId);
    let receipt = await readActive();
    if (!receipt || receipt.transactionId !== transactionId) throw new Error("Main update promotion does not own the active transaction.");
    if (receipt.status !== "staged") throw new Error("Main update transaction is not staged for promotion.");
    const pointer = await readEquinoxLocalMainSourcePointer(resolvedPointerPath, { fsImpl, execFileImpl });
    if (pointer.sha !== receipt.currentSha || pointer.sourceRoot !== receipt.rollbackSourceRoot) throw new Error("Main source pointer changed after transaction admission.");
    const stagedSourceRoot = path.join(stagingRoot, transactionId, "source");
    await fsImpl.mkdir(resolvedSourceStoreRoot, { recursive: true, mode: 0o700 });
    const targetSourceRoot = path.join(resolvedSourceStoreRoot, receipt.targetSha);
    let durableTargetExists = false;
    try {
      const existing = await inspectCanonicalMainCheckout(targetSourceRoot, { fsImpl, execFileImpl });
      if (!existing.eligible || existing.currentSha !== receipt.targetSha) throw new Error("Existing main source store target is invalid.");
      durableTargetExists = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (durableTargetExists) {
      await fsImpl.rm(stagedSourceRoot, { recursive: true, force: true });
    } else {
      await assertStagedCheckout(stagedSourceRoot, receipt.targetSha, { fsImpl, execFileImpl });
      await fsImpl.rename(stagedSourceRoot, targetSourceRoot);
      await syncDirectory(resolvedSourceStoreRoot, { fsImpl });
    }
    await assertStagedCheckout(targetSourceRoot, receipt.targetSha, { fsImpl, execFileImpl });
    receipt = await writeReceipt(Object.freeze({ ...receipt, status: "promoting", stage: "ready_to_switch", targetSourceRoot, updatedAt: now().toISOString() }));
    return Object.freeze({ receipt, targetSourceRoot, rollbackSourceRoot: receipt.rollbackSourceRoot });
  };

  const activatePromotion = async (transactionId) => {
    assertTransactionId(transactionId);
    let receipt = await readActive();
    if (!receipt || receipt.transactionId !== transactionId) throw new Error("Main update activation does not own the active transaction.");
    if (receipt.status !== "promoting" || receipt.stage !== "ready_to_switch" || !receipt.targetSourceRoot) throw new Error("Main update transaction is not ready to switch source.");
    await writeEquinoxLocalMainSourcePointer(resolvedPointerPath, { sourceRoot: receipt.targetSourceRoot, sha: receipt.targetSha }, { fsImpl, execFileImpl, randomBytesImpl });
    receipt = await writeReceipt(Object.freeze({ ...receipt, status: "verifying", stage: "source_switched", updatedAt: now().toISOString() }));
    return receipt;
  };

  const rollbackPromotion = async (transactionId, failure) => {
    assertTransactionId(transactionId);
    let receipt = await readActive();
    if (!receipt || receipt.transactionId !== transactionId) throw new Error("Main update rollback does not own the active transaction.");
    if (!receipt.rollbackSourceRoot) throw new Error("Main update rollback source is unavailable.");
    try {
      await writeEquinoxLocalMainSourcePointer(resolvedPointerPath, { sourceRoot: receipt.rollbackSourceRoot, sha: receipt.rollbackSha }, { fsImpl, execFileImpl, randomBytesImpl });
      receipt = await writeReceipt(Object.freeze({ ...receipt, status: "rolled_back", stage: "rollback_source_restored", updatedAt: now().toISOString(), lastError: boundedMessage(failure) || receipt.lastError }));
      return receipt;
    } catch (error) {
      await writeReceipt(Object.freeze({ ...receipt, status: "rollback_failed", stage: "rollback_failed", updatedAt: now().toISOString(), lastError: boundedMessage(error instanceof Error ? error.message : error) })).catch(() => {});
      throw error;
    }
  };

  const abortPreparedPromotion = async (transactionId, failure) => {
    assertTransactionId(transactionId);
    let receipt = await readActive();
    if (!receipt || receipt.transactionId !== transactionId) throw new Error("Main update abort does not own the active transaction.");
    if (receipt.status !== "promoting" || receipt.stage !== "ready_to_switch") throw new Error("Main update transaction cannot be aborted after source activation.");
    receipt = await writeReceipt(Object.freeze({ ...receipt, status: "failed", stage: "handoff_schedule_failed", updatedAt: now().toISOString(), lastError: boundedMessage(failure) || "Main update handoff scheduling failed." }));
    await fsImpl.rm(lockPath, { force: true });
    await syncDirectory(resolvedTransactionRoot, { fsImpl });
    return receipt;
  };

  const markPromotionSucceeded = async (transactionId) => {
    assertTransactionId(transactionId);
    let receipt = await readActive();
    if (!receipt || receipt.transactionId !== transactionId) throw new Error("Main update success does not own the active transaction.");
    if (receipt.status !== "verifying" || receipt.stage !== "source_switched" || !receipt.targetSourceRoot) throw new Error("Main update transaction is not awaiting target verification.");
    const pointer = await readEquinoxLocalMainSourcePointer(resolvedPointerPath, { fsImpl, execFileImpl });
    if (pointer.sha !== receipt.targetSha || pointer.sourceRoot !== receipt.targetSourceRoot) throw new Error("Main source pointer does not match the verified target.");
    receipt = await writeReceipt(Object.freeze({ ...receipt, status: "succeeded", stage: "healthy", updatedAt: now().toISOString(), lastError: null }));
    return receipt;
  };

  const markRollbackFailed = async (transactionId, failure) => {
    assertTransactionId(transactionId);
    const receipt = await readActive();
    if (!receipt || receipt.transactionId !== transactionId) throw new Error("Main update rollback failure does not own the active transaction.");
    return await writeReceipt(Object.freeze({ ...receipt, status: "rollback_failed", stage: "rollback_failed", updatedAt: now().toISOString(), lastError: boundedMessage(failure) || "Rollback verification failed." }));
  };

  const releaseStagedLock = async (transactionId) => {
    assertTransactionId(transactionId);
    const active = await readActive();
    if (!active) return false;
    if (active.transactionId !== transactionId) throw new Error("Cannot release a main update lock owned by another transaction.");
    if (!["staged", "failed", "succeeded", "rolled_back"].includes(active.status)) throw new Error("Main update lock cannot be released while the transaction is still active.");
    await fsImpl.rm(lockPath, { force: true }); await syncDirectory(resolvedTransactionRoot, { fsImpl });
    return true;
  };

  return Object.freeze({ readActive, readReceipt, begin, stage, initializeSourcePointer, preparePromotion, activatePromotion, rollbackPromotion, abortPreparedPromotion, markPromotionSucceeded, markRollbackFailed, releaseStagedLock, paths: Object.freeze({ transactionRoot: resolvedTransactionRoot, lockPath, receiptsRoot, stagingRoot, sourcePointerPath: resolvedPointerPath, sourceStoreRoot: resolvedSourceStoreRoot }) });
}
