import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  writeWindowsClassicRepairJournal,
  readWindowsClassicRepairJournal,
  reconcileWindowsClassicRepairJournal,
} from "../../src/equinox-local-windows-classic-repair-journal.js";

const record = {
  schemaVersion: 1, target: "win32-x64",
  oldMainVersion: "6.1.1", oldSourceSha: "a".repeat(40),
  oldNativeSha: "b".repeat(40), oldStablePointerVersion: "6.1.0",
  targetVersion: "6.1.2", mainStamp: '{"schemaVersion":1,"main":"authenticated"}',
};
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-classic-journal-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const journalPath = path.join(root, "classic-repair.json");
  await writeWindowsClassicRepairJournal(journalPath, record);
  const events = [];
  let pointer = record.oldStablePointerVersion;
  let live = record.mainStamp;
  let parked = null;
  let mainHealthy = true;
  let stableHealthy = false;
  return {
    journalPath, events,
    setPointer: (value) => { pointer = value; },
    setStamps: (a, b) => { live = a; parked = b; },
    setHealth: (a, b) => { mainHealthy = a; stableHealthy = b; },
    options: {
      journalPath, expectedTarget: record.target,
      readStamp: async () => ({ live, parked }),
      readCurrentVersion: async () => pointer,
      verifyPrevious: async (value) => {
        events.push("verified");
        assert.deepEqual(value, record);
      },
      isPreviousMainHealthy: async () => mainHealthy,
      isCommittedStableHealthy: async () => stableHealthy,
      rollbackPreviousMain: async (value, state) => {
        events.push(["rollback", state.parked]);
        assert.deepEqual(value, record);
      },
    },
  };
}

test("durable Main->Stable journal restores parked Main on next installer invocation", async (t) => {
  const f = await fixture(t);
  f.setPointer(record.targetVersion);
  f.setStamps(null, record.mainStamp);
  const result = await reconcileWindowsClassicRepairJournal(f.options);
  assert.equal(result.status, "restored-main");
  assert.deepEqual(f.events, ["verified", ["rollback", true]]);
  assert.equal(await readWindowsClassicRepairJournal(f.journalPath), null);
});

test("record created before switch is safe to discard only with live matching Main and healthy source", async (t) => {
  const f = await fixture(t);
  const result = await reconcileWindowsClassicRepairJournal(f.options);
  assert.equal(result.status, "restored-main");
  assert.deepEqual(f.events, ["verified"]);
  assert.equal(await readWindowsClassicRepairJournal(f.journalPath), null);
});

test("terminal healthy Stable B is the only safe completion without a Main stamp", async (t) => {
  const f = await fixture(t);
  f.setPointer(record.targetVersion);
  f.setStamps(null, null);
  await assert.rejects(reconcileWindowsClassicRepairJournal(f.options), /lost its Main owner/u);
  assert.deepEqual(await readWindowsClassicRepairJournal(f.journalPath), record);
  f.setHealth(false, true);
  f.options.verifyPrevious = async () => assert.fail("Committed Stable B must not need now-reclaimed Main A");
  const result = await reconcileWindowsClassicRepairJournal(f.options);
  assert.deepEqual(result, { status: "activated", version: record.targetVersion });
  assert.equal(await readWindowsClassicRepairJournal(f.journalPath), null);
});

test("missing, foreign or ambiguous A/B ownership never clears recovery proof", async (t) => {
  const f = await fixture(t);
  f.setPointer("9.0.0");
  await assert.rejects(reconcileWindowsClassicRepairJournal(f.options), /authenticated A\/B range/u);
  f.setPointer(record.targetVersion);
  f.setStamps("foreign-owner", record.mainStamp);
  await assert.rejects(reconcileWindowsClassicRepairJournal(f.options), /two conflicting/u);
  assert.deepEqual(await readWindowsClassicRepairJournal(f.journalPath), record);
  await assert.rejects(writeWindowsClassicRepairJournal(f.journalPath, record), /earlier Windows classic repair/u);
});

test("unknown schema or invalid source SHA is rejected before creating a recovery file", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-classic-bad-journal-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(writeWindowsClassicRepairJournal(path.join(root, "bad.json"),
    { ...record, oldSourceSha: "wrong" }), /invalid/u);
  assert.deepEqual(await fs.readdir(root), []);
});
