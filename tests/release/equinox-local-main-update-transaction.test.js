import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEquinoxLocalMainUpdateTransactionEngine } from "../../src/equinox-local-main-update-transaction.js";
import { EQUINOX_LOCAL_MAIN_REMOTE } from "../../src/equinox-local-main-update.js";

const CURRENT = "1".repeat(40);
const TARGET = "2".repeat(40);

async function fixture(t, { failValidation = false, stagedHead = TARGET } = {}) {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "equinox-m6-"));
  const sourceRoot = path.join(parent, "active");
  const transactionRoot = path.join(parent, "state");
  await fs.mkdir(sourceRoot);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const calls = [];
  const execFileImpl = async (command, args, options = {}) => {
    calls.push({ command, args: [...args], cwd: options.cwd ?? null });
    const joined = args.join(" ");
    if (command === "git" && joined === `-C ${sourceRoot} rev-parse --show-toplevel`) return { stdout: `${sourceRoot}\n`, stderr: "" };
    if (command === "git" && joined === `-C ${sourceRoot} rev-parse HEAD`) return { stdout: `${CURRENT}\n`, stderr: "" };
    if (command === "git" && joined === `-C ${sourceRoot} symbolic-ref --quiet --short HEAD`) return { stdout: "main\n", stderr: "" };
    if (command === "git" && joined === `-C ${sourceRoot} remote get-url origin`) return { stdout: `${EQUINOX_LOCAL_MAIN_REMOTE}\n`, stderr: "" };
    if (command === "git" && joined === `-C ${sourceRoot} status --porcelain=v1 --untracked-files=normal`) return { stdout: "", stderr: "" };
    if (command === "git" && args[0] === "clone") { await fs.mkdir(args.at(-1), { recursive: true }); return { stdout: "", stderr: "" }; }
    if (command === "git" && args.includes("checkout")) return { stdout: "", stderr: "" };
    if (command === "git" && args[0] === "-C" && args[2] === "rev-parse" && args[3] === "--show-toplevel") return { stdout: `${args[1]}\n`, stderr: "" };
    if (command === "git" && args[0] === "-C" && args[2] === "rev-parse" && args[3] === "HEAD") return { stdout: `${stagedHead}\n`, stderr: "" };
    if (command === "git" && args[0] === "-C" && args[2] === "symbolic-ref") return { stdout: "main\n", stderr: "" };
    if (command === "git" && args[0] === "-C" && args[2] === "remote") return { stdout: `${EQUINOX_LOCAL_MAIN_REMOTE}\n`, stderr: "" };
    if (command === "git" && args[0] === "-C" && args[2] === "status") return { stdout: "", stderr: "" };
    throw new Error(`unexpected command: ${command} ${joined}`);
  };
  const installs = [];
  const validations = [];
  const engine = createEquinoxLocalMainUpdateTransactionEngine({
    sourceRoot, transactionRoot, execFileImpl,
    now: (() => { let n = 0; return () => new Date(1_800_000_000_000 + n++ * 1000); })(),
    randomBytesImpl: () => Buffer.alloc(16, 0xab),
    installDependencies: async (value) => installs.push(value),
    validateStagedSource: async (value) => { validations.push(value); if (failValidation) throw new Error("synthetic staged validation failure\nsecond line"); },
  });
  return { sourceRoot, calls, installs, validations, engine };
}

test("transaction state must live outside the active checkout", () => {
  assert.throws(() => createEquinoxLocalMainUpdateTransactionEngine({ sourceRoot: "/Users/example/equinox-local", transactionRoot: "/Users/example/equinox-local/.updates" }), /must not overlap/u);
});

test("transaction state cannot contain the active checkout either", () => {
  assert.throws(() => createEquinoxLocalMainUpdateTransactionEngine({ sourceRoot: "/Users/example/state/active", transactionRoot: "/Users/example/state" }), /must not overlap/u);
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
