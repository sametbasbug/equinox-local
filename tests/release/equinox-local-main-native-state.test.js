import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  equinoxLocalMainNativeStatePaths,
  inspectEquinoxLocalMainNativeStoredRelease,
  promoteEquinoxLocalMainNativeCandidate,
  readEquinoxLocalMainNativePointer,
  writeEquinoxLocalMainNativePointer,
} from "../../src/equinox-local-main-native-state.js";

const SHA = "a".repeat(40);
const TARGET = "darwin-arm64";
const DIGEST = "b".repeat(64);
const TX = `main-${"c".repeat(32)}`;
const ARTIFACT = "d".repeat(64);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-native-state-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "staging", TX, "native-candidate");
  const releaseDir = path.join(candidateRoot, "release");
  await fs.mkdir(releaseDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(releaseDir, "payload.bin"), "native payload");
  const candidate = { sourceSha: SHA, target: TARGET, transactionId: TX, runtimeContractSha256: DIGEST, artifactSha256: ARTIFACT, artifactBytes: 123, payloadVersion: "5.2.1", releaseDir };
  const validateRelease = async (dir, { target }) => ({ version: "5.2.1", target, releaseDir: dir, tree: { entryCount: 1, totalBytes: 14 } });
  return { root, candidateRoot, releaseDir, candidate, validateRelease };
}

test("Main native candidate promotes into exact target+SHA durable store and survives staging cleanup", async (t) => {
  const f = await fixture(t);
  const promoted = await promoteEquinoxLocalMainNativeCandidate({ candidate: f.candidate, transactionRoot: f.root, transactionId: TX, validateRelease: f.validateRelease });
  const paths = equinoxLocalMainNativeStatePaths({ transactionRoot: f.root, sourceSha: SHA, target: TARGET });
  assert.equal(promoted.reused, false);
  assert.equal(promoted.releaseDir, paths.releaseDir);
  await assert.rejects(fs.lstat(f.candidateRoot), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(paths.releaseDir, "payload.bin"), "utf8"), "native payload");
  const inspected = await inspectEquinoxLocalMainNativeStoredRelease({ transactionRoot: f.root, sourceSha: SHA, target: TARGET, expectedRuntimeContractSha256: DIGEST, validateRelease: f.validateRelease });
  assert.equal(inspected.manifest.artifactSha256, ARTIFACT);
  assert.match(inspected.manifest.releaseFingerprint.sha256, /^[a-f0-9]{64}$/u);
});

test("Main native durable promotion recovers idempotently after candidate rename completed", async (t) => {
  const f = await fixture(t);
  const first = await promoteEquinoxLocalMainNativeCandidate({ candidate: f.candidate, transactionRoot: f.root, transactionId: TX, validateRelease: f.validateRelease });
  const replay = await promoteEquinoxLocalMainNativeCandidate({ candidate: f.candidate, transactionRoot: f.root, transactionId: TX, validateRelease: f.validateRelease });
  assert.equal(first.reused, false);
  assert.equal(replay.reused, true);
  assert.equal(replay.releaseDir, first.releaseDir);
});

test("Main native stored release fails closed when durable payload bytes drift", async (t) => {
  const f = await fixture(t);
  const promoted = await promoteEquinoxLocalMainNativeCandidate({ candidate: f.candidate, transactionRoot: f.root, transactionId: TX, validateRelease: f.validateRelease });
  await fs.writeFile(path.join(promoted.releaseDir, "payload.bin"), "tampered payload");
  await assert.rejects(
    inspectEquinoxLocalMainNativeStoredRelease({ transactionRoot: f.root, sourceSha: SHA, target: TARGET, expectedRuntimeContractSha256: DIGEST, validateRelease: f.validateRelease }),
    /fingerprint mismatch/u,
  );
});

test("Main native pointer advances only to an exact verified durable payload", async (t) => {
  const f = await fixture(t);
  const promoted = await promoteEquinoxLocalMainNativeCandidate({ candidate: f.candidate, transactionRoot: f.root, transactionId: TX, validateRelease: f.validateRelease });
  const pointerPath = path.join(f.root, "current-native.json");
  const written = await writeEquinoxLocalMainNativePointer(pointerPath, {
    schemaVersion: 1, channel: "main", sourceSha: SHA, target: TARGET, runtimeContractSha256: DIGEST,
  }, { transactionRoot: f.root, validateRelease: f.validateRelease });
  assert.equal(written.sourceSha, SHA);
  assert.equal(written.target, TARGET);
  assert.equal(written.runtimeContractSha256, DIGEST);
  assert.equal(written.releaseDir, promoted.releaseDir);
  assert.equal(written.payloadVersion, "5.2.1");
  const raw = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  assert.deepEqual(Object.keys(raw).sort(), ["channel", "runtimeContractSha256", "schemaVersion", "sourceSha", "target"].sort());
  const reread = await readEquinoxLocalMainNativePointer(pointerPath, { transactionRoot: f.root, validateRelease: f.validateRelease });
  assert.equal(reread.releaseDir, promoted.releaseDir);
  await assert.rejects(
    writeEquinoxLocalMainNativePointer(pointerPath, { schemaVersion: 1, channel: "main", sourceSha: SHA, target: TARGET, runtimeContractSha256: "e".repeat(64) }, { transactionRoot: f.root, validateRelease: f.validateRelease }),
    /runtime contract mismatch/u,
  );
  await assert.rejects(readEquinoxLocalMainNativePointer(path.join(f.root, "other.json"), { transactionRoot: f.root, validateRelease: f.validateRelease }), /outside canonical/u);
});
