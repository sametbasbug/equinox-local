import assert from "node:assert/strict";
import test from "node:test";

import { planEquinoxMainR2Retention } from "../../scripts/release/prune-main-r2.mjs";

const SHAS = Array.from({ length: 12 }, (_, i) => i.toString(16).padStart(40, "0"));
const TARGETS = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
const NOW = new Date("2026-10-27T12:00:00.000Z");
function snapshot(sha, index, { partial = false, ageHours = index * 30 } = {}) {
  const timestamp = new Date(NOW.getTime() - ageHours * 3600_000).toISOString();
  const files = TARGETS.flatMap((target) => {
    const name = "equinox-local-main-" + sha + "-" + target;
    return [name + ".json", name + (target.startsWith("win32") ? ".zip" : ".tar.gz")];
  });
  return (partial ? files.slice(0, 5) : files).map((name) => ({
    Key: "snapshots/" + sha + "/" + name, Size: name.endsWith(".json") ? 2000 : 200000000,
    LastModified: timestamp,
  }));
}
function fixture() {
  return SHAS.flatMap((sha, index) => snapshot(sha, index));
}
test("R2 prune retains newest eight complete snapshots, Main/tag pointer, and deletes only full old groups", () => {
  const input = fixture();
  const plan = planEquinoxMainR2Retention(input, { mainSha: SHAS[0], snapshotSha: SHAS[10], now: NOW });
  assert.equal(plan.keepCount, 9);
  assert.equal(plan.deleteCount, 3);
  assert.equal(plan.deleteKeys.length, 24);
  assert.equal(plan.objectCount, 96);
  assert.ok(plan.protectedShas.includes(SHAS[10]));
  for (const sha of [...SHAS.slice(0, 8), SHAS[10]])
    assert.ok(!plan.deleteKeys.some((key) => key.includes(sha)));
});

test("R2 prune never removes snapshots newer than the 24-hour grace period, even beyond latest eight", () => {
  const input = SHAS.flatMap((sha, index) => snapshot(sha, index, { ageHours: index }));
  const plan = planEquinoxMainR2Retention(input, { mainSha: SHAS[0], snapshotSha: SHAS[0], now: NOW });
  assert.equal(plan.deleteCount, 0);
});

test("R2 prune preserves incomplete or unknown snapshot groups and never includes their bytes in reclaimed estimate", () => {
  const input = fixture().filter((object) => !object.Key.includes(SHAS[11]));
  input.push(...snapshot(SHAS[11], 11, { partial: true }));
  const plan = planEquinoxMainR2Retention(input, { mainSha: SHAS[0], snapshotSha: SHAS[0], now: NOW });
  assert.equal(plan.deleteCount, 3); // index 8,9,10; incomplete 11 is protected
  assert.ok(!plan.deleteKeys.some((key) => key.includes(SHAS[11])));
});

test("R2 prune aborts if inventory is malformed, tampered, duplicated or incomplete", () => {
  const input = fixture();
  const args = { mainSha: SHAS[0], snapshotSha: SHAS[1], now: NOW };
  assert.throws(() => planEquinoxMainR2Retention([], args), /Complete bounded/u);
  assert.throws(() => planEquinoxMainR2Retention([...input, input[0]], args), /duplicate/u);
  assert.throws(() => planEquinoxMainR2Retention([{...input[0], Key: "other-bucket/x"}, ...input.slice(1)], args), /Unexpected/u);
  assert.throws(() => planEquinoxMainR2Retention([{...input[0], LastModified: "bad"}, ...input.slice(1)], args), /date/u);
  assert.throws(() => planEquinoxMainR2Retention(input, { ...args, mainSha: "not-a-sha" }), /regular expression/u);
});

test("R2 prune fails closed on extra future sidecars and keeps that entire SHA group", () => {
  const input = fixture();
  const oldest = SHAS[11];
  input.push({Key: "snapshots/" + oldest + "/sidecar-v2.json", Size: 123, LastModified: input.at(-1).LastModified});
  const plan = planEquinoxMainR2Retention(input, {mainSha: SHAS[0], snapshotSha: SHAS[0], now: NOW});
  assert.ok(!plan.deleteKeys.some((key) => key.includes(oldest)));
  assert.equal(plan.deleteCount, 3);
});
