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
      return { version: "5.2.1", target: TARGET, releaseDir, tree: { entryCount: 12, totalBytes: 345 }, metadata: { version: "5.2.1", target: TARGET, sourceSha: SHA } };
    },
  });
  assert.equal(result.sourceSha, SHA);
  assert.equal(result.target, TARGET);
  assert.equal(result.runtimeContractSha256, DIGEST);
  assert.equal(result.payloadVersion, "5.2.1");
  assert.equal(result.reused, false);
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

test("Main native candidate preparation reuses a previously validated candidate after an interrupted extraction", async (t) => {
  const f = await fixture(t);
  const candidateRelease = path.join(f.transactionDir, "native-candidate", "release");
  await fs.mkdir(candidateRelease, { recursive: true });
  let archiveMutated = false;
  const result = await prepareEquinoxLocalMainNativeCandidate({
    sourceSha: SHA,
    target: TARGET,
    expectedRuntimeContractSha256: DIGEST,
    transactionRoot: f.root,
    transactionId: TX,
    inspectStagedArtifact: async () => stagedArtifact(f.artifactPath),
    inspectArchive: async () => { archiveMutated = true; },
    validateRelease: async (releaseDir, options) => ({ version: "5.2.1", target: options.target, releaseDir, tree: {}, metadata: {version:"5.2.1",sourceSha:SHA} }),
  });
  assert.equal(result.reused, true);
  assert.equal(result.releaseDir, candidateRelease);
  assert.equal(archiveMutated, false);
});

test("Main native candidate rejects symlinked candidate directory without touching foreign files", async (t) => {
  const f = await fixture(t);
  const foreign = path.join(f.root, "foreign-release");
  await fs.mkdir(foreign);
  const canary = path.join(foreign, "important.txt");
  await fs.writeFile(canary, "must remain unchanged");
  const candidateRoot = path.join(f.transactionDir, "native-candidate");
  await fs.symlink(foreign, candidateRoot, "dir");
  const actions = [];
  await assert.rejects(prepareEquinoxLocalMainNativeCandidate({
    sourceSha: SHA, target: TARGET, expectedRuntimeContractSha256: DIGEST,
    transactionRoot: f.root, transactionId: TX,
    inspectStagedArtifact: async () => stagedArtifact(f.artifactPath),
    inspectArchive: async () => actions.push("inspect"),
    extractArchive: async () => actions.push("extract"),
    validateRelease: async () => actions.push("validate"),
  }), /not a canonical normal directory/u);
  assert.deepEqual(actions, []);
  assert.equal((await fs.lstat(candidateRoot)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(canary, "utf8"), "must remain unchanged");
  assert.equal(await fs.readFile(f.artifactPath, "utf8"), "artifact");
});

test("Main native candidate refuses reusing an unrelated release without replacing its bytes", async (t) => {
  const f = await fixture(t);
  const candidateRelease = path.join(f.transactionDir, "native-candidate", "release");
  await fs.mkdir(candidateRelease, { recursive: true });
  const canary = path.join(candidateRelease, "existing.bin");
  await fs.writeFile(canary, "original");
  const actions = [];
  await assert.rejects(prepareEquinoxLocalMainNativeCandidate({
    sourceSha: SHA, target: TARGET, expectedRuntimeContractSha256: DIGEST,
    transactionRoot: f.root, transactionId: TX,
    inspectStagedArtifact: async () => stagedArtifact(f.artifactPath),
    inspectArchive: async () => actions.push("inspect"),
    extractArchive: async () => actions.push("extract"),
    validateRelease: async (releaseDir) => {
      actions.push("validate");
      return { target: "win32-x64", releaseDir, version: "5.2.1" };
    },
  }), /release provenance does not match exact signed source SHA/u);
  assert.deepEqual(actions, ["validate"]);
  assert.equal(await fs.readFile(canary, "utf8"), "original");
  assert.equal(await fs.readFile(f.artifactPath, "utf8"), "artifact");
});

test("Main native candidate cleans own new candidate after post-rename validation drift", async (t) => {
  const f = await fixture(t);
  let validations = 0;
  await assert.rejects(prepareEquinoxLocalMainNativeCandidate({
    sourceSha: SHA, target: TARGET, expectedRuntimeContractSha256: DIGEST,
    transactionRoot: f.root, transactionId: TX,
    inspectStagedArtifact: async () => stagedArtifact(f.artifactPath),
    inspectArchive: async () => {},
    extractArchive: async (_archive, dest) => {
      await fs.mkdir(path.join(dest, "release"), { recursive: true });
      await fs.writeFile(path.join(dest, "release", "native.bin"), "new native");
    },
    validateRelease: async (releaseDir) => {
      validations += 1;
      return {
        version: "5.2.1", target: TARGET,
        releaseDir: validations === 2 ? "/foreign-release" : releaseDir,
        metadata: {version:"5.2.1",sourceSha:SHA}, tree: {},
      };
    },
  }), /final validation drifted/u);
  assert.equal(validations, 2);
  await assert.rejects(fs.lstat(path.join(f.transactionDir, "native-candidate")), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.artifactPath, "utf8"), "artifact");
});

test("Main native candidate rejects same-version artifact from a different commit before durable staging", async (t) => {
  const f = await fixture(t);
  let validations = 0;
  const releaseSha = "f".repeat(40);
  await assert.rejects(prepareEquinoxLocalMainNativeCandidate({
    sourceSha: SHA, target:TARGET, expectedRuntimeContractSha256:DIGEST,
    transactionRoot:f.root, transactionId:TX,
    inspectStagedArtifact:async()=>stagedArtifact(f.artifactPath),
    inspectArchive:async()=>{},
    extractArchive:async (_archive,destination)=>fs.mkdir(path.join(destination,"release"),{recursive:true}),
    validateRelease:async releaseDir=>{
      validations++;
      return {version:"5.2.1",target:TARGET,releaseDir,
        metadata:{version:"5.2.1",sourceSha:releaseSha},tree:{}};
    },
  }),/release provenance does not match exact signed source SHA/u);
  assert.equal(validations,1);
  await assert.rejects(fs.lstat(path.join(f.transactionDir,"native-candidate")),{code:"ENOENT"});
  assert.equal(await fs.readFile(f.artifactPath,"utf8"),"artifact");
});
