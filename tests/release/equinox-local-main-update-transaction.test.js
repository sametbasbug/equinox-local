import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEquinoxLocalMainUpdateTransactionEngine } from "../../src/equinox-local-main-update-transaction.js";
import { EQUINOX_LOCAL_MAIN_REMOTE } from "../../src/equinox-local-main-update.js";
import { protectWindowsPrivateStatePath } from "../../src/equinox-local-private-state.js";

const CURRENT = "1".repeat(40);
const TARGET = "2".repeat(40);

async function fixture(t, { failValidation = false, rejectPromotedValidation = false, stagedHead = TARGET, usePinnedDefaults = false, gitPath = "git", fsImpl = fs, platform = process.platform } = {}) {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "equinox-m6-"));
  const sourceRoot = path.join(parent, "active");
  const transactionRoot = path.join(parent, "state");
  await fs.mkdir(sourceRoot);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const calls = [];
  const ownedNode = path.join(parent, "pinned-node");
  const ownedNpm = path.join(parent, "pinned-npm-cli.js");
  const execFileImpl = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd ?? null });
    const joined = args.join(" ");
    if (command === ownedNode) {
      if (args[0] === ownedNpm && args[1] === "ci") {
        const lifecycleDir = path.join(options.cwd, "node_modules", "node-pty", "scripts");
        await fs.mkdir(lifecycleDir, { recursive: true });
        for (const name of ["prebuild.js", "post-install.js"]) {
          await fs.writeFile(path.join(lifecycleDir, name), "// fake pinned prebuilt acceptance\n");
        }
      }
      return { stdout: "", stderr: "" };
    }
    if (command === gitPath && joined === `-C ${sourceRoot} rev-parse --show-toplevel`) return { stdout: `${sourceRoot}\n`, stderr: "" };
    if (command === gitPath && joined === `-C ${sourceRoot} rev-parse HEAD`) return { stdout: `${CURRENT}\n`, stderr: "" };
    if (command === gitPath && joined === `-C ${sourceRoot} symbolic-ref --quiet --short HEAD`) return { stdout: "main\n", stderr: "" };
    if (command === gitPath && joined === `-C ${sourceRoot} remote get-url origin`) return { stdout: `${EQUINOX_LOCAL_MAIN_REMOTE}\n`, stderr: "" };
    if (command === gitPath && joined === `-C ${sourceRoot} status --porcelain=v1 --untracked-files=normal`) return { stdout: "", stderr: "" };
    if (command === gitPath && args[0] === "clone") { await fs.mkdir(args.at(-1), { recursive: true }); return { stdout: "", stderr: "" }; }
    if (command === gitPath && args.includes("checkout")) return { stdout: "", stderr: "" };
    if (command === gitPath && args[0] === "-C" && args[2] === "rev-parse" && args[3] === "--show-toplevel") return { stdout: `${args[1]}\n`, stderr: "" };
    if (command === gitPath && args[0] === "-C" && args[2] === "rev-parse" && args[3] === "HEAD") return { stdout: `${stagedHead}\n`, stderr: "" };
    if (command === gitPath && args[0] === "-C" && args[2] === "symbolic-ref") return { stdout: "main\n", stderr: "" };
    if (command === gitPath && args[0] === "-C" && args[2] === "remote") return { stdout: `${EQUINOX_LOCAL_MAIN_REMOTE}\n`, stderr: "" };
    if (command === gitPath && args[0] === "-C" && args[2] === "status") return { stdout: "", stderr: "" };
    throw new Error(`unexpected command: ${command} ${joined}`);
  };
  const installs = [];
  const validations = [];
  const engine = createEquinoxLocalMainUpdateTransactionEngine({
    sourceRoot, transactionRoot, execFileImpl, gitPath, fsImpl, platform,
    now: (() => { let n = 0; return () => new Date(1_800_000_000_000 + n++ * 1000); })(),
    randomBytesImpl: () => Buffer.alloc(16, 0xab),
    ...(usePinnedDefaults ? {
      nodePath: ownedNode,
      npmPath: ownedNpm,
      shellPath: process.platform === "win32" ? "C:\\owned\\git\\usr\\bin\\sh.exe" : null,
    } : {
      installDependencies: async (value) => installs.push(value),
      validateStagedSource: async (value) => { validations.push(value); if (failValidation) throw new Error("synthetic staged validation failure\nsecond line"); if (rejectPromotedValidation && value.stagedSourceRoot.includes(`${path.sep}sources${path.sep}`)) throw new Error("invalid copied dependency payload"); },
    }),
  });
  return { sourceRoot, calls, installs, validations, engine };
}

test("transaction state must live outside the active checkout", () => {
  assert.throws(() => createEquinoxLocalMainUpdateTransactionEngine({ sourceRoot: "/Users/example/equinox-local", transactionRoot: "/Users/example/equinox-local/.updates" }), /must not live inside/u);
});

test("transaction state rejects arbitrary active checkouts beneath itself", () => {
  assert.throws(() => createEquinoxLocalMainUpdateTransactionEngine({ sourceRoot: "/Users/example/state/active", transactionRoot: "/Users/example/state" }), /direct SHA-addressed source-store checkout/u);
  assert.throws(() => createEquinoxLocalMainUpdateTransactionEngine({ sourceRoot: `/Users/example/state/sources/${CURRENT}/nested`, transactionRoot: "/Users/example/state" }), /direct SHA-addressed source-store checkout/u);
  assert.throws(() => createEquinoxLocalMainUpdateTransactionEngine({ sourceRoot: `/Users/example/state/staging/${CURRENT}`, transactionRoot: "/Users/example/state" }), /direct SHA-addressed source-store checkout/u);
});

test("transaction state accepts the promoted direct SHA-addressed source-store checkout", () => {
  const engine = createEquinoxLocalMainUpdateTransactionEngine({ sourceRoot: `/Users/example/state/sources/${CURRENT}`, transactionRoot: "/Users/example/state" });
  assert.equal(engine.paths.sourceStoreRoot, "/Users/example/state/sources");
});

test("Main lock and receipt never use unbounded descriptor readFile after size admission", async (t) => {
  const { engine, sourceRoot } = await fixture(t);
  const receipt = await engine.begin({ currentSha: CURRENT, targetSha: TARGET });
  const receiptPath = path.join(engine.paths.receiptsRoot, `${receipt.transactionId}.json`);
  const protectedPaths = new Set([engine.paths.lockPath, receiptPath]);
  let unboundedReads = 0;
  let boundedReads = 0;
  const mockFs = Object.create(fs);
  mockFs.open = async (candidate, ...args) => {
    const handle = await fs.open(candidate, ...args);
    if (!protectedPaths.has(candidate)) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === "readFile") return async (...params) => {
          unboundedReads += 1;
          return target.readFile(...params);
        };
        if (key === "read") return async (...params) => {
          boundedReads += 1;
          assert.ok(params[2] <= 64 * 1024 + 1, "A single read cannot escape the receipt byte budget");
          return target.read(...params);
        };
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const isolated = createEquinoxLocalMainUpdateTransactionEngine({
    sourceRoot, transactionRoot: engine.paths.transactionRoot, fsImpl: mockFs,
  });
  assert.equal((await isolated.readActive()).transactionId, receipt.transactionId);
  assert.equal(unboundedReads, 0, "Main forensic state cannot be streamed into memory without a hard bound");
  assert.ok(boundedReads >= 2, "Both forensic lock and receipt must use bounded reads");
});

test("Main forensic read stops at exactly 64 KiB plus one byte when content grows after stat", async (t) => {
  const { engine, sourceRoot } = await fixture(t);
  await engine.begin({ currentSha: CURRENT, targetSha: TARGET });
  let delivered = 0;
  let closes = 0;
  const mockFs = Object.create(fs);
  mockFs.open = async (candidate, ...args) => {
    const handle = await fs.open(candidate, ...args);
    if (candidate !== engine.paths.lockPath) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === "read") return async (buffer, offset, length) => {
          buffer.fill(88, offset, offset + length);
          delivered += length;
          assert.ok(delivered <= 64 * 1024 + 1, "Growing file reads must never escape the byte budget");
          return { bytesRead: length, buffer };
        };
        if (key === "close") return async () => { closes += 1; return target.close(); };
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const alternate = createEquinoxLocalMainUpdateTransactionEngine({
    sourceRoot, transactionRoot: engine.paths.transactionRoot, fsImpl: mockFs,
  });
  await assert.rejects(alternate.readActive(), /exceeds the size limit/u);
  assert.equal(delivered, 64 * 1024 + 1, "Stop immediately on the first over-limit byte");
  assert.equal(closes, 1, "Close the opened forensic file on failure");
  assert.ok((await engine.readActive()).transactionId, "Original transaction remains usable");
});

test("Main refuses a symlinked receipt directory before persisting the transaction", async (t) => {
  const { engine } = await fixture(t);
  const foreign = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-m6-foreign-receipts-"));
  t.after(() => fs.rm(foreign, { recursive: true, force: true }));
  await fs.mkdir(engine.paths.transactionRoot, { recursive: true, mode: 0o700 });
  await fs.symlink(foreign, engine.paths.receiptsRoot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(engine.begin({ currentSha: CURRENT, targetSha: TARGET }), /canonical normal directory|unsafe|symlink|directory/u);
  assert.deepEqual(await fs.readdir(foreign), [], "A foreign folder must not receive a private receipt");
  await assert.rejects(fs.access(engine.paths.lockPath), { code: "ENOENT" });
});

test("Main refuses a receipt-directory symlink appearing after lock admission", async (t) => {
  const { engine } = await fixture(t);
  const original = await engine.begin({ currentSha: CURRENT, targetSha: TARGET });
  const foreign = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-m6-foreign-receipt-update-"));
  t.after(() => fs.rm(foreign, { recursive: true, force: true }));
  const moved = `${engine.paths.receiptsRoot}-held`;
  const filename = `${original.transactionId}.json`;
  const receiptBytes = await fs.readFile(path.join(engine.paths.receiptsRoot, filename));
  await fs.rename(engine.paths.receiptsRoot, moved);
  // A foreign existing receipt can otherwise be read and silently overwritten.
  await fs.writeFile(path.join(foreign, filename), receiptBytes, { mode: 0o600 });
  await fs.symlink(foreign, engine.paths.receiptsRoot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(engine.markRollbackFailed(original.transactionId, "intentional failure"), /canonical normal directory|unsafe|symlink|directory/u);
  assert.deepEqual(await fs.readFile(path.join(foreign, filename)), receiptBytes, "Foreign receipt bytes must remain untouched");
  assert.equal(JSON.parse(await fs.readFile(path.join(moved, filename), "utf8")).status, "active");
});

test("Main receipt temp cannot be replaced by another normal inode before atomic rename", async (t) => {
  const rogue = "synthetic-foreign-receipt-content";
  let swapped = false;
  let destination = null;
  const fsImpl = Object.create(fs);
  fsImpl.open = async (candidate, ...args) => {
    const handle = await fs.open(candidate, ...args);
    if (!candidate.includes(".json.tmp-")) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === "close") return async () => {
          await target.close();
          if (!swapped) {
            swapped = true;
            destination = candidate.split(".tmp-")[0];
            await fs.unlink(candidate);
            await fs.writeFile(candidate, rogue, { mode: 0o600 });
          }
        };
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const { engine } = await fixture(t, { fsImpl });
  await assert.rejects(
    engine.begin({ currentSha: CURRENT, targetSha: TARGET }),
    /temporary.*changed|identity|unsafe|inode/u,
  );
  assert.equal(swapped, true, "A regular 0600 replacement must be injected after descriptor close");
  await assert.rejects(fs.access(destination), { code: "ENOENT" });
  assert.equal((await fs.lstat(engine.paths.lockPath)).isFile(), true,
    "A failed receipt must retain single-flight ownership for recovery");
});

test("begin acquires one private durable owner and refuses a concurrent updater", async (t) => {
  const { engine } = await fixture(t);
  const first = await engine.begin({ currentSha: CURRENT, targetSha: TARGET });
  assert.equal(first.transactionId, `main-${"ab".repeat(16)}`);
  assert.equal(first.status, "active");
  assert.equal((await fs.stat(engine.paths.lockPath)).mode & 0o077, 0);
  await assert.rejects(engine.begin({ currentSha: CURRENT, targetSha: TARGET }), /already owns the update lock/u);
  assert.equal((await engine.readActive()).transactionId, first.transactionId);
});

test("an interrupted receipt write still leaves durable single-flight ownership", async (t) => {
  const { engine } = await fixture(t);
  const first = await engine.begin({ currentSha: CURRENT, targetSha: TARGET });
  await fs.rm(path.join(engine.paths.receiptsRoot, `${first.transactionId}.json`));
  const recovered = await engine.readActive();
  assert.equal(recovered.transactionId, first.transactionId);
  assert.equal(recovered.status, "active");
  assert.equal(recovered.stage, "admitted");
  await assert.rejects(engine.begin({ currentSha: CURRENT, targetSha: TARGET }), /already owns the update lock/u);
});

test("begin fails closed if active SHA changed after discovery", async (t) => {
  const { engine } = await fixture(t);
  await assert.rejects(engine.begin({ currentSha: TARGET, targetSha: "3".repeat(40) }), /changed after update discovery/u);
  assert.equal(await engine.readActive(), null);
});

test("pinned production defaults run owned npm, node-pty prebuilt scripts and staged validation before Main promotion", async (t) => {
  const { engine, calls } = await fixture(t, { usePinnedDefaults: true });
  const staged = await engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  assert.equal(staged.receipt.status, "staged");
  const ownedCalls = calls.filter(({ command }) => command.includes("pinned-node"));
  assert.equal(ownedCalls.length, 5);
  assert.deepEqual(ownedCalls[0].args.slice(0, 3), [path.join(path.dirname(engine.paths.transactionRoot), "pinned-npm-cli.js"), "ci", "--ignore-scripts"]);
  assert.equal(ownedCalls.some(({ args }) => args.some((arg) => arg.endsWith("prebuild.js"))), true);
  assert.equal(ownedCalls.some(({ args }) => args.some((arg) => arg.endsWith("post-install.js"))), true);
  assert.equal(ownedCalls.some(({ args }) => args.includes("run") && args.includes("check")), true);
  assert.equal(ownedCalls.some(({ args }) => args.includes("tests/release/equinox-local-main-update.test.js")), true);
  await engine.releaseStagedLock(staged.receipt.transactionId);
});

test("stage prepares exact canonical main bytes without mutating active source", async (t) => {
  const { engine, sourceRoot, calls, installs, validations } = await fixture(t);
  const before = await fs.readdir(sourceRoot);
  const staged = await engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  assert.equal(staged.receipt.status, "staged");
  assert.equal(staged.receipt.stage, "staged");
  assert.equal(staged.receipt.rollbackSha, CURRENT);
  assert.equal(installs.length, 1); assert.equal(validations.length, 1);
  assert.deepEqual(await fs.readdir(sourceRoot), before);
  assert.equal(calls.some(({ command, args }) => command === "git" && args[0] === "clone" && args.includes(EQUINOX_LOCAL_MAIN_REMOTE)), true);
  assert.equal(calls.some(({ command, args }) => command === "git" && args.includes("checkout") && args.includes("-B") && args.includes("main") && args.includes(TARGET)), true);
  assert.equal(await engine.releaseStagedLock(staged.receipt.transactionId), true);
  assert.equal(await engine.readActive(), null);
});

test("promotion moves staged source into durable store, atomically switches pointer and rolls back A to B to A", async (t) => {
  const { engine, sourceRoot } = await fixture(t);
  const staged = await engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  const initialPointer = await engine.initializeSourcePointer();
  assert.equal(initialPointer.sourceRoot, sourceRoot);
  assert.equal(initialPointer.sha, CURRENT);

  const prepared = await engine.preparePromotion(staged.receipt.transactionId);
  assert.equal(prepared.receipt.status, "promoting");
  assert.equal(prepared.receipt.stage, "ready_to_switch");
  assert.equal(prepared.receipt.rollbackSourceRoot, sourceRoot);
  assert.equal(prepared.targetSourceRoot, path.join(engine.paths.sourceStoreRoot, TARGET));
  await assert.rejects(fs.lstat(staged.stagedSourceRoot), { code: "ENOENT" });
  assert.equal((await fs.lstat(prepared.targetSourceRoot)).isDirectory(), true);

  const switched = await engine.activatePromotion(staged.receipt.transactionId);
  assert.equal(switched.status, "verifying");
  assert.equal(switched.stage, "source_switched");
  const pointerAfterSwitch = await fs.readFile(engine.paths.sourcePointerPath, "utf8");
  assert.match(pointerAfterSwitch, new RegExp(`sha=${TARGET}`));
  assert.match(pointerAfterSwitch, new RegExp(`sourceRoot=${prepared.targetSourceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  const rolledBack = await engine.rollbackPromotion(staged.receipt.transactionId, "synthetic health failure");
  assert.equal(rolledBack.status, "rolled_back");
  assert.equal(rolledBack.stage, "rollback_source_restored");
  assert.match(rolledBack.lastError, /synthetic health failure/u);
  const pointerAfterRollback = await fs.readFile(engine.paths.sourcePointerPath, "utf8");
  assert.match(pointerAfterRollback, new RegExp(`sha=${CURRENT}`));
  assert.match(pointerAfterRollback, new RegExp(`sourceRoot=${sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(await engine.releaseStagedLock(staged.receipt.transactionId), true);
});

test("native-impact promotion persists rollback readiness and native switch before source activation", async (t) => {
  const f = await fixture(t);
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  await f.engine.initializeSourcePointer();
  await f.engine.preparePromotion(staged.receipt.transactionId);
  const pointerBefore = await fs.readFile(f.engine.paths.sourcePointerPath, "utf8");

  const rollbackReady = await f.engine.markNativeRollbackReady(staged.receipt.transactionId);
  assert.equal(rollbackReady.status, "promoting");
  assert.equal(rollbackReady.stage, "native_rollback_ready");
  assert.equal((await f.engine.markNativeRollbackReady(staged.receipt.transactionId)).stage, "native_rollback_ready");
  assert.equal(await fs.readFile(f.engine.paths.sourcePointerPath, "utf8"), pointerBefore);
  await assert.rejects(f.engine.activatePromotion(staged.receipt.transactionId), /not ready to switch source/u);

  const nativeSwitched = await f.engine.markNativeSwitched(staged.receipt.transactionId);
  assert.equal(nativeSwitched.status, "promoting");
  assert.equal(nativeSwitched.stage, "native_switched");
  assert.equal((await f.engine.markNativeSwitched(staged.receipt.transactionId)).stage, "native_switched");
  assert.equal(await fs.readFile(f.engine.paths.sourcePointerPath, "utf8"), pointerBefore);

  const sourceSwitched = await f.engine.activatePromotion(staged.receipt.transactionId);
  assert.equal(sourceSwitched.status, "verifying");
  assert.equal(sourceSwitched.stage, "source_switched");
  assert.match(await fs.readFile(f.engine.paths.sourcePointerPath, "utf8"), new RegExp(`sha=${TARGET}`));
});

test("native switch cannot be recorded before durable rollback readiness", async (t) => {
  const f = await fixture(t);
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  await f.engine.initializeSourcePointer();
  await f.engine.preparePromotion(staged.receipt.transactionId);
  await assert.rejects(
    f.engine.markNativeSwitched(staged.receipt.transactionId),
    /has not durably prepared native rollback state/u,
  );
  assert.equal((await f.engine.readActive()).stage, "ready_to_switch");
});

test("receipt validation fails closed on an incompatible status-stage pair", async (t) => {
  const f = await fixture(t);
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  const receiptPath = path.join(f.engine.paths.receiptsRoot, `${staged.receipt.transactionId}.json`);
  const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  receipt.status = "promoting";
  receipt.stage = "validation";
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  await assert.rejects(f.engine.readReceipt(staged.receipt.transactionId), /status and stage are incompatible/u);
});

test("preparePromotion recovers if durable-store rename completed before receipt update", async (t) => {
  const f = await fixture(t);
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  await f.engine.initializeSourcePointer();
  await fs.mkdir(f.engine.paths.sourceStoreRoot, { recursive: true });
  const durableTarget = path.join(f.engine.paths.sourceStoreRoot, TARGET);
  await fs.rename(staged.stagedSourceRoot, durableTarget);
  assert.equal((await f.engine.readActive()).status, "staged");
  const recovered = await f.engine.preparePromotion(staged.receipt.transactionId);
  assert.equal(recovered.receipt.status, "promoting");
  assert.equal(recovered.targetSourceRoot, durableTarget);
});

async function protectWindowsFixture(f) {
  if (process.platform !== "win32") return;
  await fs.mkdir(f.engine.paths.transactionRoot, { recursive: true });
  await protectWindowsPrivateStatePath({ target: f.engine.paths.transactionRoot, type: "directory" });
}

test("Windows source promotion copies and fully revalidates when a locked staged directory cannot be renamed", async (t) => {
  let copyCount = 0;
  const guardedFs = {
    ...fs,
    rename: async (from, to) => {
      if (from.endsWith(path.join("source")) && to.includes(`${path.sep}sources${path.sep}${TARGET}`)) {
        throw Object.assign(new Error("locked descendant"), { code: "EPERM" });
      }
      return fs.rename(from, to);
    },
    cp: async (...args) => { copyCount++; return fs.cp(...args); },
  };
  const f = await fixture(t, { fsImpl: guardedFs, platform: "win32" });
  await protectWindowsFixture(f);
  await f.engine.initializeSourcePointer();
  const before = await fs.readFile(f.engine.paths.sourcePointerPath, "utf8");
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  await fs.writeFile(path.join(staged.stagedSourceRoot, "ignored-native-file.node"), "native payload");
  const result = await f.engine.preparePromotion(staged.receipt.transactionId);
  assert.equal(result.receipt.stage, "ready_to_switch");
  assert.equal(copyCount, 1);
  assert.equal(await fs.readFile(path.join(result.targetSourceRoot, "ignored-native-file.node"), "utf8"), "native payload");
  assert.equal(await fs.readFile(f.engine.paths.sourcePointerPath, "utf8"), before);
  assert.equal((await f.engine.readActive()).status, "promoting");
});

test("Windows source copy fallback refuses invalid data without switching Main pointer", async (t) => {
  const guardedFs = {
    ...fs,
    rename: async (from, to) => {
      if (from.endsWith(path.join("source")) && to.includes(`${path.sep}sources${path.sep}${TARGET}`)) {
        throw Object.assign(new Error("locked directory"), { code: "EPERM" });
      }
      return fs.rename(from, to);
    },
    cp: async () => { throw Object.assign(new Error("file copy denied"), { code: "EACCES" }); },
  };
  const f = await fixture(t, { fsImpl: guardedFs, platform: "win32" });
  await protectWindowsFixture(f);
  await f.engine.initializeSourcePointer();
  const before = await fs.readFile(f.engine.paths.sourcePointerPath, "utf8");
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  await fs.writeFile(path.join(staged.stagedSourceRoot, "ignored-native-file.node"), "native payload");
  await assert.rejects(f.engine.preparePromotion(staged.receipt.transactionId), /file copy denied/u);
  await assert.rejects(fs.lstat(path.join(f.engine.paths.sourceStoreRoot, TARGET)), { code: "ENOENT" });
  assert.equal((await f.engine.readActive()).stage, "staged");
  assert.equal(await fs.readFile(f.engine.paths.sourcePointerPath, "utf8"), before);
});

test("Windows copied Main source requires a second dependency validation before promotion", async (t) => {
  const guardedFs = {
    ...fs,
    rename: async (from, to) => {
      if (from.endsWith(path.join("source")) && to.includes(`${path.sep}sources${path.sep}${TARGET}`)) {
        throw Object.assign(new Error("source file still held"), { code: "EPERM" });
      }
      return fs.rename(from, to);
    },
  };
  const f = await fixture(t, { fsImpl: guardedFs, platform: "win32", rejectPromotedValidation: true });
  await protectWindowsFixture(f);
  await f.engine.initializeSourcePointer();
  const oldPointer = await fs.readFile(f.engine.paths.sourcePointerPath, "utf8");
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  await fs.writeFile(path.join(staged.stagedSourceRoot, "ignored-native-file.node"), "native payload");
  await assert.rejects(f.engine.preparePromotion(staged.receipt.transactionId), /invalid copied dependency payload/u);
  await assert.rejects(fs.lstat(path.join(f.engine.paths.sourceStoreRoot, TARGET)), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.engine.paths.sourcePointerPath, "utf8"), oldPointer);
  assert.equal((await f.engine.readActive()).status, "staged");
});

test("promotion runs all Git validation through the pinned Git path without ambient PATH", async (t) => {
  const ownedGit = path.join(os.tmpdir(), "product-owned-git");
  const f = await fixture(t, { gitPath: ownedGit });
  await f.engine.initializeSourcePointer();
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  const promoted = await f.engine.preparePromotion(staged.receipt.transactionId);
  assert.equal(promoted.receipt.status, "promoting");
  assert.equal(f.calls.some((call) => call.command === "git"), false);
  assert.equal(f.calls.every((call) => call.command === ownedGit), true);
});

test("staged preparation abort records failure, removes transaction staging and preserves source pointer", async (t) => {
  const f = await fixture(t);
  const initialPointer = await f.engine.initializeSourcePointer();
  assert.equal(initialPointer.sourceRoot, f.sourceRoot);
  assert.equal(initialPointer.sha, CURRENT);
  const pointerBefore = await fs.readFile(f.engine.paths.sourcePointerPath, "utf8");
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  const transactionDir = path.dirname(staged.stagedSourceRoot);
  await fs.mkdir(path.join(transactionDir, "native"));
  await fs.writeFile(path.join(transactionDir, "native", "partial.bin"), "partial");

  const failed = await f.engine.abortStagedPreparation(staged.receipt.transactionId, "native snapshot digest mismatch\nsecond line");
  assert.equal(failed.status, "failed");
  assert.equal(failed.stage, "preparation_failed");
  assert.match(failed.lastError, /native snapshot digest mismatch second line/u);
  assert.equal(failed.lastError.includes("\n"), false);
  assert.equal(await f.engine.readActive(), null);
  const durable = await f.engine.readReceipt(staged.receipt.transactionId);
  assert.equal(durable.status, "failed");
  assert.equal(durable.stage, "preparation_failed");
  await assert.rejects(fs.lstat(transactionDir), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.engine.paths.sourcePointerPath, "utf8"), pointerBefore);
});

test("staged preparation abort refuses promotion or another transaction owner", async (t) => {
  const f = await fixture(t);
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  await f.engine.initializeSourcePointer();
  await f.engine.preparePromotion(staged.receipt.transactionId);
  await assert.rejects(
    f.engine.abortStagedPreparation(staged.receipt.transactionId, "too late"),
    /only be aborted before promotion begins/u,
  );
  assert.equal((await f.engine.readActive()).status, "promoting");
  await assert.rejects(
    f.engine.abortStagedPreparation(`main-${"cd".repeat(16)}`, "wrong owner"),
    /does not own the active transaction/u,
  );
});

test("prepared promotion can abort before pointer activation and release ownership", async (t) => {
  const f = await fixture(t);
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  await f.engine.initializeSourcePointer();
  await f.engine.preparePromotion(staged.receipt.transactionId);
  const failed = await f.engine.abortPreparedPromotion(staged.receipt.transactionId, "scheduler unavailable");
  assert.equal(failed.status, "failed");
  assert.equal(failed.stage, "handoff_schedule_failed");
  assert.match(failed.lastError, /scheduler unavailable/u);
  assert.equal(await f.engine.readActive(), null);
});

test("prepared promotion can record native admission failure before source activation", async (t) => {
  const f = await fixture(t);
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  await f.engine.initializeSourcePointer();
  await f.engine.preparePromotion(staged.receipt.transactionId);
  const failed = await f.engine.abortPreparedPromotion(staged.receipt.transactionId, "artifact digest drift", { stage: "native_admission_failed" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.stage, "native_admission_failed");
  assert.match(failed.lastError, /artifact digest drift/u);
  assert.equal(await f.engine.readActive(), null);
});

test("prepared promotion rejects arbitrary abort stages without releasing ownership", async (t) => {
  const f = await fixture(t);
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  await f.engine.initializeSourcePointer();
  await f.engine.preparePromotion(staged.receipt.transactionId);
  await assert.rejects(
    f.engine.abortPreparedPromotion(staged.receipt.transactionId, "nope", { stage: "arbitrary" }),
    /prepared abort stage is invalid/u,
  );
  assert.equal((await f.engine.readActive()).stage, "ready_to_switch");
});

test("source-switched receipt remains durable until explicit rollback", async (t) => {
  const f = await fixture(t);
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  await f.engine.initializeSourcePointer();
  await f.engine.preparePromotion(staged.receipt.transactionId);
  await f.engine.activatePromotion(staged.receipt.transactionId);
  const active = await f.engine.readActive();
  assert.equal(active.status, "verifying");
  assert.equal(active.stage, "source_switched");
  assert.equal((await f.engine.readReceipt(staged.receipt.transactionId)).targetSourceRoot, path.join(f.engine.paths.sourceStoreRoot, TARGET));
  const rolledBack = await f.engine.rollbackPromotion(staged.receipt.transactionId, "interrupted after pointer switch");
  assert.equal(rolledBack.status, "rolled_back");
});

test("native-impact rollback is non-terminal until native restore and rollback health complete", async (t) => {
  const f = await fixture(t);
  const staged = await f.engine.stage({ currentSha: CURRENT, targetSha: TARGET });
  await f.engine.initializeSourcePointer();
  await f.engine.preparePromotion(staged.receipt.transactionId);
  await f.engine.markNativeRollbackReady(staged.receipt.transactionId);
  await f.engine.markNativeSwitched(staged.receipt.transactionId);
  await f.engine.activatePromotion(staged.receipt.transactionId);
  const sourceRestored = await f.engine.rollbackPromotion(staged.receipt.transactionId, "target failed", { nativeRollbackPending: true });
  assert.equal(sourceRestored.status, "verifying");
  assert.equal(sourceRestored.stage, "rollback_source_restored");
  await assert.rejects(f.engine.releaseStagedLock(staged.receipt.transactionId), /still active/u);
  const nativeRestored = await f.engine.markNativeRollbackRestored(staged.receipt.transactionId);
  assert.equal(nativeRestored.stage, "rollback_native_restored");
  const done = await f.engine.markRollbackSucceeded(staged.receipt.transactionId);
  assert.equal(done.status, "rolled_back");
  assert.equal(done.stage, "rollback_healthy");
  assert.equal(await f.engine.releaseStagedLock(staged.receipt.transactionId), true);
});

test("staged SHA mismatch records failure and releases handled pre-promotion lock", async (t) => {
  const { engine } = await fixture(t, { stagedHead: "3".repeat(40) });
  await assert.rejects(engine.stage({ currentSha: CURRENT, targetSha: TARGET }), /does not match the pinned target SHA/u);
  assert.equal(await engine.readActive(), null);
  const [receiptFile] = await fs.readdir(engine.paths.receiptsRoot);
  const receipt = JSON.parse(await fs.readFile(path.join(engine.paths.receiptsRoot, receiptFile), "utf8"));
  assert.equal(receipt.status, "failed"); assert.match(receipt.lastError, /pinned target SHA/u);
});

test("validation failure is durable and preserves staging evidence", async (t) => {
  const { engine } = await fixture(t, { failValidation: true });
  await assert.rejects(engine.stage({ currentSha: CURRENT, targetSha: TARGET }), /synthetic staged validation failure/u);
  assert.equal(await engine.readActive(), null);
  const [receiptFile] = await fs.readdir(engine.paths.receiptsRoot);
  const receipt = JSON.parse(await fs.readFile(path.join(engine.paths.receiptsRoot, receiptFile), "utf8"));
  assert.equal(receipt.status, "failed"); assert.equal(receipt.stage, "validation"); assert.equal(receipt.lastError.includes("\n"), false);
  assert.equal((await fs.readdir(engine.paths.stagingRoot)).length, 1);
});

test("invalid SHA and no-op target are rejected before transaction ownership", async (t) => {
  const { engine } = await fixture(t);
  await assert.rejects(engine.begin({ currentSha: "bad", targetSha: TARGET }), /Current SHA/u);
  await assert.rejects(engine.begin({ currentSha: CURRENT, targetSha: CURRENT }), /already matches/u);
  assert.equal(await engine.readActive(), null);
});


test("verified failed rollback archives only its owned lock and preserves original forensic receipt", async (t) => {
  const { engine } = await fixture(t);
  await engine.initializeSourcePointer();
  const initial = await engine.begin({ currentSha: CURRENT, targetSha: TARGET });
  await engine.markRollbackFailed(initial.transactionId, "original failed WPF restart");
  const original = await engine.readReceipt(initial.transactionId);
  await assert.rejects(engine.releaseStagedLock(initial.transactionId), /still active/u);
  await assert.rejects(engine.archiveVerifiedFailedRollbackLock(initial.transactionId, { currentSha: TARGET, targetSha: CURRENT }), /identity/u);
  assert.equal((await engine.readActive()).status, "rollback_failed");
  const archived = await engine.archiveVerifiedFailedRollbackLock(initial.transactionId, { currentSha: CURRENT, targetSha: TARGET });
  assert.equal(archived.archived, true);
  assert.equal(await engine.readActive(), null);
  assert.deepEqual(await engine.readReceipt(initial.transactionId), original);
  const archive = JSON.parse(await fs.readFile(path.join(engine.paths.transactionRoot, "archived-failed-locks", `${initial.transactionId}.json`), "utf8"));
  assert.equal(archive.transactionId, initial.transactionId);
  assert.equal(archive.currentSha, CURRENT);
  assert.equal(archive.targetSha, TARGET);
  await assert.rejects(engine.archiveVerifiedFailedRollbackLock(initial.transactionId, { currentSha: CURRENT, targetSha: TARGET }), /identity/u);
});

test("failed rollback recovery refuses altered or missing pointer without moving original lock", async (t) => {
  const { engine } = await fixture(t);
  await engine.initializeSourcePointer();
  const initial = await engine.begin({ currentSha: CURRENT, targetSha: TARGET });
  await engine.markRollbackFailed(initial.transactionId, "native failed");
  await fs.rm(engine.paths.sourcePointerPath);
  await assert.rejects(engine.archiveVerifiedFailedRollbackLock(initial.transactionId, { currentSha: CURRENT, targetSha: TARGET }));
  assert.equal((await engine.readActive()).status, "rollback_failed");
});

test("Main transaction fails closed on receipt/lock SHA mismatch", async (t) => {
  const { engine } = await fixture(t);
  const initial = await engine.begin({ currentSha: CURRENT, targetSha: TARGET });
  const receiptPath = path.join(engine.paths.receiptsRoot, `${initial.transactionId}.json`);
  const modified = { ...initial, targetSha: "3".repeat(40) };
  await fs.writeFile(receiptPath, JSON.stringify(modified));
  await assert.rejects(engine.readActive(), /identities disagree/u);
  assert.equal(JSON.parse(await fs.readFile(engine.paths.lockPath, "utf8")).transactionId, initial.transactionId);
});

test("Main update lock and receipt reject symlinks without reading or replacing foreign state", async (t) => {
  const { engine, sourceRoot } = await fixture(t);
  const receipt = await engine.begin({ currentSha: CURRENT, targetSha: TARGET });
  const receiptPath = path.join(engine.paths.receiptsRoot, receipt.transactionId + ".json");
  const foreign = path.join(engine.paths.transactionRoot,"foreign-state.json");
  await fs.writeFile(foreign, JSON.stringify(receipt));
  const originalBytes = await fs.readFile(foreign);
  for (const protectedPath of [engine.paths.lockPath,receiptPath]) {
    const realContents = await fs.readFile(protectedPath);
    await fs.unlink(protectedPath);
    await fs.symlink(foreign, protectedPath);
    let opened = false;
    const mockFs = Object.create(fs);
    mockFs.open = async (candidate,...args) => {
      if (candidate === protectedPath) opened = true;
      return fs.open(candidate,...args);
    };
    const alternate = createEquinoxLocalMainUpdateTransactionEngine({
      sourceRoot,
      transactionRoot:engine.paths.transactionRoot,
      fsImpl:mockFs,
    });
    await assert.rejects(alternate.readActive(), /normal, non-symlink file/u);
    assert.equal(opened,false,"symlink must be rejected before opening");
    assert.equal((await fs.lstat(protectedPath)).isSymbolicLink(),true);
    assert.deepEqual(await fs.readFile(foreign),originalBytes);
    await fs.unlink(protectedPath);
    await fs.writeFile(protectedPath,realContents,{mode:0o600});
  }
  assert.equal((await engine.readActive()).transactionId,receipt.transactionId);
});

test("Main update lock and receipt reject hard links to foreign state before opening", async (t) => {
  const { engine, sourceRoot } = await fixture(t);
  const receipt = await engine.begin({ currentSha: CURRENT, targetSha: TARGET });
  const receiptPath = path.join(engine.paths.receiptsRoot, `${receipt.transactionId}.json`);
  for (const protectedPath of [engine.paths.lockPath, receiptPath]) {
    const original = await fs.readFile(protectedPath);
    const foreign = path.join(engine.paths.transactionRoot, `outside-${path.basename(protectedPath)}`);
    await fs.writeFile(foreign, original);
    await fs.unlink(protectedPath);
    try {
      await fs.link(foreign, protectedPath);
    } catch (error) {
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
        t.skip("The filesystem does not support regular file hard links.");
        return;
      }
      throw error;
    }
    assert.equal((await fs.stat(protectedPath)).nlink, 2);
    let opened = false;
    const mockFs = Object.create(fs);
    mockFs.open = async (candidate, ...args) => {
      if (candidate === protectedPath) opened = true;
      return fs.open(candidate, ...args);
    };
    const isolated = createEquinoxLocalMainUpdateTransactionEngine({
      sourceRoot, transactionRoot: engine.paths.transactionRoot, fsImpl: mockFs,
    });
    await assert.rejects(isolated.readActive(), /normal, non-symlink file|hard.link/u);
    assert.equal(opened, false, "Foreign-inode hard links must fail before open");
    assert.deepEqual(await fs.readFile(foreign), original, "Foreign contents stay intact");
    await fs.unlink(protectedPath);
    await fs.writeFile(protectedPath, original, { mode: 0o600 });
    await fs.unlink(foreign);
  }
  assert.equal((await engine.readActive()).transactionId, receipt.transactionId);
});

test("Main update forensic lock refuses changed inode between lstat and opened descriptor", async(t)=>{
  const { engine, sourceRoot } = await fixture(t);
  const receipt = await engine.begin({currentSha:CURRENT,targetSha:TARGET});
  const beforeBytes = await fs.readFile(engine.paths.lockPath);
  const mockFs = Object.create(fs);
  mockFs.lstat = async (candidate) => {
    const stat = await fs.lstat(candidate);
    if(candidate !== engine.paths.lockPath)return stat;
    return new Proxy(stat,{
      get(target,prop,receiver){
        if(prop === "ino")return target.ino+1;
        return Reflect.get(target,prop,receiver);
      },
    });
  };
  const alternate = createEquinoxLocalMainUpdateTransactionEngine({
    sourceRoot,
    transactionRoot:engine.paths.transactionRoot,
    fsImpl:mockFs,
  });
  await assert.rejects(alternate.readActive(),/changed while opening/u);
  assert.deepEqual(await fs.readFile(engine.paths.lockPath),beforeBytes);
  assert.equal((await engine.readActive()).transactionId,receipt.transactionId);
});
