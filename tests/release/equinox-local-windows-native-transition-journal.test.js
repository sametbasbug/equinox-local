import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createEquinoxLocalWindowsNativeTransitionJournal,
  validateEquinoxLocalWindowsNativeTransitionJournal,
} from "../../src/equinox-local-windows-native-transition-journal.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const CONTRACT = "f".repeat(64);
const TX = `main-${"7".repeat(32)}`;
const STARTED = "2026-10-11T17:03:29.137Z";
const ROOT_TIME = "2026-10-11T18:00:00.000Z";
const PREVIOUS = Object.freeze({ kind: "stable", version: "6.0.4" });
const input = Object.freeze({
  transactionId: TX, target: "win32-arm64", currentSha: A, targetSha: B,
  receiptStartedAt: STARTED, previousNative: PREVIOUS,
  targetRuntimeContractSha256: CONTRACT,
});

async function fixture(t, options = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-windows-guardian-")));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const transactionRoot = path.join(root, "main-update");
  await fs.mkdir(transactionRoot);
  let receipt = { ...input, startedAt: STARTED, status: "promoting" };
  const calls = [];
  const journal = createEquinoxLocalWindowsNativeTransitionJournal({
    transactionRoot,
    now: () => ROOT_TIME,
    inspectOwningReceipt: async (data) => {
      calls.push(["receipt", data.stage]);
      return receipt;
    },
    verifyMilestone: async () => true,
    ...options,
  });
  return { root, transactionRoot, journal, calls, changeReceipt: (change) => { receipt = { ...receipt, ...change }; } };
}

test("Windows durable guardian journal is created once and safely reloaded without reset", async (t) => {
  const f = await fixture(t);
  const created = await f.journal.create(input);
  assert.equal(created.stage, "prepared");
  assert.equal(created.sequence, 0);
  assert.equal(created.currentSha, A);
  assert.deepEqual(await f.journal.read(TX, { currentSha: A, targetSha: B }), created);
  await assert.rejects(f.journal.create(input), { code: "EEXIST" });
  assert.deepEqual(await f.journal.read(TX), created);
});

test("Windows guardian journal advances only after authenticated Main receipt and exact generation", async (t) => {
  const f = await fixture(t);
  await f.journal.create(input);
  const states = ["native_staged", "shell_stopped", "switched", "restarted", "healthy", "committed"];
  let previous = "prepared";
  let sequence = 0;
  for (const state of states) {
    if (state === "committed") f.changeReceipt({ status: "succeeded" });
    const next = await f.journal.advance(TX, { from: previous, to: state, sequence });
    sequence += 1;
    assert.equal(next.sequence, sequence);
    assert.equal(next.stage, state);
    assert.equal((await f.journal.read(TX)).stage, state);
    previous = state;
  }
  await assert.rejects(f.journal.advance(TX, { from: "committed", to: "rollback_started", sequence }), /unsafe/u);
  assert.equal(f.calls.length, states.length + 1);
});

test("Windows journal supports explicit verified rollback and no self-declared success", async (t) => {
  const f = await fixture(t);
  await f.journal.create(input);
  await assert.rejects(f.journal.advance(TX, { from: "prepared", to: "healthy", sequence: 0 }), /unsafe/u);
  const states = ["native_staged", "shell_stopped", "switched", "rollback_started", "rollback_native_restored", "rollback_healthy", "rolled_back"];
  let prev = "prepared";
  for (let i = 0; i < states.length; ++i) {
    if (states[i] === "rolled_back") f.changeReceipt({ status: "rolled_back" });
    const result = await f.journal.advance(TX, { from: prev, to: states[i], sequence: i });
    assert.equal(result.stage, states[i]);
    prev = states[i];
  }
  await assert.rejects(f.journal.advance(TX, { from: "rolled_back", to: "committed", sequence: states.length }), /unsafe/u);
});

test("restart after interruption reuses durable journal and never repeats an already committed mutation", async (t) => {
  const f = await fixture(t);
  await f.journal.create(input);
  await f.journal.advance(TX, { from: "prepared", to: "native_staged", sequence: 0 });
  const recovered = createEquinoxLocalWindowsNativeTransitionJournal({
    transactionRoot: f.transactionRoot,
    now: () => ROOT_TIME,
    inspectOwningReceipt: async () => ({ ...input, startedAt: STARTED, status: "promoting" }),
    verifyMilestone: async () => true,
  });
  assert.equal((await recovered.read(TX)).stage, "native_staged");
  await assert.rejects(recovered.advance(TX, { from: "prepared", to: "native_staged", sequence: 0 }), /stale or unsafe/u);
  assert.equal((await recovered.advance(TX, { from: "native_staged", to: "shell_stopped", sequence: 1 })).sequence, 2);
});

test("mismatched receipt identity or changed status must fail closed without journal rewrite", async (t) => {
  const f = await fixture(t);
  await f.journal.create(input);
  const before = await f.journal.read(TX);
  for (const change of [{ currentSha: B }, { targetSha: A }, { startedAt: "2026-10-11T17:00:00.000Z" }, { status: "rollback_failed" }]) {
    f.changeReceipt(change);
    await assert.rejects(f.journal.advance(TX, { from: "prepared", to: "native_staged", sequence: 0 }), /transaction ownership/u);
    assert.deepEqual(await f.journal.read(TX), before);
    f.changeReceipt({ currentSha: A, targetSha: B, startedAt: STARTED, status: "promoting" });
  }
});

test("stale or concurrently owned writer lock never gets auto-reclaimed", async (t) => {
  const f = await fixture(t);
  await f.journal.create(input);
  const guard = path.join(f.journal.root, `.${TX}.writer-lock`);
  await fs.writeFile(guard, "foreign concurrent owner");
  await assert.rejects(f.journal.advance(TX, { from: "prepared", to: "native_staged", sequence: 0 }), { code: "EEXIST" });
  assert.equal(await fs.readFile(guard, "utf8"), "foreign concurrent owner");
  assert.equal((await f.journal.read(TX)).stage, "prepared");
});

test("journal fails closed on changed identity, unsupported version, malformed state, and symlinks", async (t) => {
  const f = await fixture(t);
  const created = await f.journal.create(input);
  for (const change of [
    { currentSha: B }, { stage: "invented" }, { sequence: -1 },
    { previousNative: { kind: "stable", version: "6.0" } },
    { previousNative: { kind: "main", sourceSha: B, runtimeContractSha256: CONTRACT } },
    { createdAt: "yesterday" }, { anything: "unrecognized" },
    { stage: "native_staged", sequence: 77 }, { stage: "committed", sequence: 2 },
  ]) assert.throws(() => validateEquinoxLocalWindowsNativeTransitionJournal({ ...created, ...change }), /invalid|does not match/u);
  await assert.rejects(f.journal.read(TX, { currentSha: B }), /does not match/u);
  const recordPath = path.join(f.journal.root, `${TX}.json`);
  await fs.rm(recordPath);
  await fs.symlink(path.join(f.root, "foreign-file"), recordPath);
  await assert.rejects(f.journal.read(TX));
});

test("Windows x64 and ARM64 are the only admitted native journal targets", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.journal.create({ ...input, target: "darwin-arm64" }), /invalid/u);
  assert.equal((await f.journal.create({ ...input, target: "win32-x64" })).target, "win32-x64");
});

test("journal rejects missing or symlinked transaction root and traversal transaction IDs", async (t) => {
  const f = await fixture(t);
  const foreign = createEquinoxLocalWindowsNativeTransitionJournal({ transactionRoot: path.join(f.root, "missing"), inspectOwningReceipt: async () => ({}), verifyMilestone: async () => true });
  await assert.rejects(foreign.create(input), { code: "ENOENT" });
  await assert.rejects(f.journal.read("../foreign"), /invalid/u);
  const fakeRoot = path.join(f.root, "symlinked");
  await fs.symlink(f.transactionRoot, fakeRoot, "dir");
  const throughLink = createEquinoxLocalWindowsNativeTransitionJournal({ transactionRoot: fakeRoot, inspectOwningReceipt: async () => ({}), verifyMilestone: async () => true });
  await assert.rejects(throughLink.create(input), /normal owned directory/u);
});


test("unproven native milestone and missing independent verifier never advance a durable journal", async (t) => {
  const f = await fixture(t, { verifyMilestone: async () => false });
  await f.journal.create(input);
  await assert.rejects(f.journal.advance(TX, { from: "prepared", to: "native_staged", sequence: 0 }), /not independently verified/u);
  assert.equal((await f.journal.read(TX)).stage, "prepared");
  assert.throws(() => createEquinoxLocalWindowsNativeTransitionJournal({ transactionRoot: f.transactionRoot, inspectOwningReceipt: async () => ({}) }), /requires a canonical root/u);
});

test("success and rollback terminals require corresponding durable Main receipt state", async (t) => {
  const f = await fixture(t);
  await f.journal.create(input);
  let stage = "prepared";
  for (const [index, next] of ["native_staged", "shell_stopped", "switched", "restarted", "healthy"].entries()) {
    await f.journal.advance(TX, { from: stage, to: next, sequence: index });
    stage = next;
  }
  await assert.rejects(f.journal.advance(TX, { from: "healthy", to: "committed", sequence: 5 }), /transaction ownership/u);
  f.changeReceipt({ status: "succeeded" });
  assert.equal((await f.journal.advance(TX, { from: "healthy", to: "committed", sequence: 5 })).stage, "committed");
});


test("Windows ACL boundary is verified before state reading and cannot be bypassed by a normal file", async (t) => {
  const f = await fixture(t, { platform: "win32", protectWindowsAcl: async () => ({ safe: true }), verifyWindowsAcl: async ({ type }) => ({ safe: type === "directory" }) });
  await assert.rejects(f.journal.create(input), /file ACL protection cannot be verified/u);
  await assert.rejects(f.journal.read(TX), /file ACL ownership cannot be verified/u);
});

test("Windows ACL rejection refuses even an otherwise healthy owned Main receipt", async (t) => {
  const f = await fixture(t, { platform: "win32", protectWindowsAcl: async () => ({ safe: true }), verifyWindowsAcl: async () => ({ safe: false }) });
  await assert.rejects(f.journal.create(input), /ACL ownership cannot be verified/u);
  await assert.rejects(f.journal.read(TX), /ACL ownership cannot be verified/u);
});
