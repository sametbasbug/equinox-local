import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareEquinoxLocalMainNativeCandidate } from "../../src/equinox-local-main-native-candidate.js";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const TX = `main-${"c".repeat(32)}`;
const TARGET = "darwin-arm64";

async function fixture(t) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-native-candidate-"));
  const root = await fs.realpath(created);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionDir = path.join(root, "staging", TX);
  const nativeDir = path.join(transactionDir, "native");
  await fs.mkdir(nativeDir, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(nativeDir, `equinox-local-main-${SHA}-${TARGET}.tar.gz`);
  await fs.writeFile(artifactPath, "artifact");
  return { root, transactionDir, artifactPath };
}

function stagedArtifact(artifactPath) {
  return {
    sourceSha: SHA,
    target: TARGET,
    transactionId: TX,
    artifactPath,
    bytes: 8,
    sha256: "d".repeat(64),
    manifest: { runtimeContractSha256: DIGEST },
  };
}

test("Main native candidate preparation reuses bounded archive validation inside the exact transaction", async (t) => {
  const f = await fixture(t);
  const events = [];
  const result = await prepareEquinoxLocalMainNativeCandidate({
    sourceSha: SHA,
    target: TARGET,
    expectedRuntimeContractSha256: DIGEST,
    transactionRoot: f.root,
    transactionId: TX,
    inspectStagedArtifact: async (value) => { events.push(["artifact", value]); return stagedArtifact(f.artifactPath); },
    inspectArchive: async (archive, options) => events.push(["inspect", archive, options.target]),
    extractArchive: async (archive, destination, options) => {
      events.push(["extract", archive, destination, options.target]);
      await fs.mkdir(path.join(destination, "release"), { recursive: true });
    },
    validateRelease: async (releaseDir, options) => {
      events.push(["validate", releaseDir, options.target]);
      return { version: "5.2.1", target: TARGET, releaseDir, tree: { entryCount: 12, totalBytes: 345 }, metadata: { version: "5.2.1", target: TARGET } };
    },
  });
  assert.equal(result.sourceSha, SHA);
  assert.equal(result.target, TARGET);
  assert.equal(result.runtimeContractSha256, DIGEST);
  assert.equal(result.payloadVersion, "5.2.1");
  assert.equal(result.releaseDir, path.join(f.transactionDir, "native-candidate", "release"));
  assert.equal((await fs.lstat(result.releaseDir)).isDirectory(), true);
  await assert.rejects(fs.lstat(path.join(f.transactionDir, "native-candidate", "extracted")), { code: "ENOENT" });
  assert.deepEqual(events.map(([name]) => name), ["artifact", "inspect", "extract", "validate", "validate"]);
  assert.equal(events[0][1].sourceSha, SHA);
  assert.equal(events[0][1].expectedRuntimeContractSha256, DIGEST);
});

test("Main native candidate preparation removes only its candidate tree when extraction or validation fails", async (t) => {
  const f = await fixture(t);
  await assert.rejects(prepareEquinoxLocalMainNativeCandidate({
    sourceSha: SHA,
    target: TARGET,
    expectedRuntimeContractSha256: DIGEST,
    transactionRoot: f.root,
    transactionId: TX,
    inspectStagedArtifact: async () => stagedArtifact(f.artifactPath),
    inspectArchive: async () => {},
    extractArchive: async (_archive, destination) => fs.mkdir(path.join(destination, "release"), { recursive: true }),
    validateRelease: async () => { throw new Error("candidate invalid"); },
  }), /candidate invalid/u);
  await assert.rejects(fs.lstat(path.join(f.transactionDir, "native-candidate")), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.artifactPath, "utf8"), "artifact");
});

test("Main native candidate preparation refuses a pre-existing candidate destination before archive mutation", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.transactionDir, "native-candidate"));
  let mutated = false;
  await assert.rejects(prepareEquinoxLocalMainNativeCandidate({
    sourceSha: SHA,
    target: TARGET,
    expectedRuntimeContractSha256: DIGEST,
    transactionRoot: f.root,
    transactionId: TX,
    inspectStagedArtifact: async () => stagedArtifact(f.artifactPath),
    inspectArchive: async () => { mutated = true; },
  }), { code: "EEXIST" });
  assert.equal(mutated, false);
});
