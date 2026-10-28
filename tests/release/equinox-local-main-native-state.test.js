import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {createEquinoxLocalMainNativePointerTransition} from "../../src/equinox-local-main-native-pointer-transition.js";

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
  const validateRelease = async (dir, { target }) => ({
    version:"5.2.1",target,releaseDir:dir,metadata:{version:"5.2.1",sourceSha:SHA},
    tree:{entryCount:1,totalBytes:14},
  });
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

test("Main native state rejects foreign candidate staging paths without moving or deleting payload", async (t) => {
  const f = await fixture(t);
  const foreignRoot = path.join(f.root, "foreign", "native-candidate");
  const foreignRelease = path.join(foreignRoot, "release");
  await fs.mkdir(foreignRelease, { recursive: true });
  await fs.writeFile(path.join(foreignRelease, "foreign.bin"), "keep");
  await assert.rejects(
    promoteEquinoxLocalMainNativeCandidate({
      candidate: { ...f.candidate, releaseDir: foreignRelease },
      transactionRoot: f.root,
      transactionId: TX,
      validateRelease: f.validateRelease,
    }),
    /not transaction-owned/,
  );
  assert.equal(await fs.readFile(path.join(foreignRelease, "foreign.bin"), "utf8"), "keep");
  await assert.rejects(fs.lstat(path.join(f.root, "native-store", TARGET, SHA)), { code: "ENOENT" });
});

test("Main native state rejects symlinked staging before native promotion", async (t) => {
  const f = await fixture(t);
  const actualCandidate = path.join(f.root, "real-native-candidate");
  await fs.rename(f.candidateRoot, actualCandidate);
  await fs.symlink(actualCandidate, f.candidateRoot, "dir");
  await assert.rejects(
    promoteEquinoxLocalMainNativeCandidate({
      candidate: f.candidate,
      transactionRoot: f.root,
      transactionId: TX,
      validateRelease: f.validateRelease,
    }),
    /state directory is unsafe/,
  );
  assert.equal(await fs.readFile(path.join(actualCandidate, "release", "payload.bin"), "utf8"), "native payload");
});

test("Main native pointer retains authenticated previous bytes when atomic publish rename fails", async (t) => {
  const f = await fixture(t);
  await promoteEquinoxLocalMainNativeCandidate({ candidate: f.candidate, transactionRoot: f.root, transactionId: TX, validateRelease: f.validateRelease });
  const pointerPath = path.join(f.root, "current-native.json");
  const pointer = { schemaVersion: 1, channel: "main", sourceSha: SHA, target: TARGET, runtimeContractSha256: DIGEST };
  await writeEquinoxLocalMainNativePointer(pointerPath, pointer, { transactionRoot: f.root, validateRelease: f.validateRelease });
  const before = await fs.readFile(pointerPath);
  const failingFs = {
    ...fs,
    rename: async (source, destination) => {
      if (destination === pointerPath) throw new Error("Injected atomic native pointer rename failure");
      return fs.rename(source, destination);
    },
  };
  await assert.rejects(
    writeEquinoxLocalMainNativePointer(pointerPath, pointer, {
      transactionRoot: f.root, validateRelease: f.validateRelease, fsImpl: failingFs,
    }),
    /Injected atomic native pointer rename failure/,
  );
  assert.deepEqual(await fs.readFile(pointerPath), before);
  assert.deepEqual(
    (await fs.readdir(f.root)).filter((name) => name.startsWith(".main-native-")),
    [],
    "unpublished temporary pointer files must be cleaned",
  );
});

test("Main native store refuses extra manifest fields without accepting durable payload", async (t) => {
  const f = await fixture(t);
  const promoted = await promoteEquinoxLocalMainNativeCandidate({ candidate: f.candidate, transactionRoot: f.root, transactionId: TX, validateRelease: f.validateRelease });
  const paths = equinoxLocalMainNativeStatePaths({ transactionRoot: f.root, sourceSha: SHA, target: TARGET });
  const original = JSON.parse(await fs.readFile(paths.manifestPath, "utf8"));
  await fs.writeFile(paths.manifestPath, JSON.stringify({ ...original, privileged: true }), { mode: 0o600 });
  await assert.rejects(
    inspectEquinoxLocalMainNativeStoredRelease({
      transactionRoot: f.root, sourceSha: SHA, target: TARGET,
      validateRelease: f.validateRelease, expectedRuntimeContractSha256: DIGEST,
    }),
    /missing or unsupported fields/,
  );
  assert.equal(await fs.readFile(path.join(promoted.releaseDir, "payload.bin"), "utf8"), "native payload");
});

test("Main native durable store refuses a different signed source SHA even at same presentation version", async t=>{
 const f=await fixture(t);
 const wrongValidate=async(dir,{target})=>({
   version:"5.2.1",target,releaseDir:dir,metadata:{version:"5.2.1",sourceSha:"f".repeat(40)},
   tree:{entryCount:1,totalBytes:14},
 });
 await assert.rejects(promoteEquinoxLocalMainNativeCandidate({
   candidate:f.candidate,transactionRoot:f.root,transactionId:TX,validateRelease:wrongValidate,
 }),/candidate source SHA does not match/u);
 assert.equal((await fs.stat(f.releaseDir)).isDirectory(),true);
 await assert.rejects(fs.stat(path.join(f.root,"native-store")),{code:"ENOENT"});
 const stored=await promoteEquinoxLocalMainNativeCandidate({
   candidate:f.candidate,transactionRoot:f.root,transactionId:TX,validateRelease:f.validateRelease,
 });
 await assert.rejects(inspectEquinoxLocalMainNativeStoredRelease({
   transactionRoot:f.root,sourceSha:SHA,target:TARGET,expectedRuntimeContractSha256:DIGEST,
   validateRelease:wrongValidate,
 }),/stored release source SHA does not match/u);
 assert.equal((await fs.stat(stored.releaseDir)).isDirectory(),true);
 await assert.rejects(fs.stat(path.join(f.root,"current-native.json")),{code:"ENOENT"});
});

test("same-version Main A to B advances by signed full SHA and rollback restores A's durable runtime",async t=>{
 const f=await fixture(t);
 const secondSha="e".repeat(40);
 const secondTx="main-"+"f".repeat(32);
 const secondRelease=path.join(f.root,"staging",secondTx,"native-candidate","release");
 await fs.mkdir(secondRelease,{recursive:true,mode:0o700});
 await fs.writeFile(path.join(f.releaseDir,"release.json"),JSON.stringify({
   version:"5.2.1",sourceSha:SHA,
 }));
 await fs.writeFile(path.join(secondRelease,"release.json"),JSON.stringify({
   version:"5.2.1",sourceSha:secondSha,
 }));
 await fs.writeFile(path.join(secondRelease,"payload.bin"),"replacement native B");
 const validateRelease=async (releaseDir,{target})=>({
   version:"5.2.1",target,releaseDir,
   metadata:JSON.parse(await fs.readFile(path.join(releaseDir,"release.json"),"utf8")),
   tree:{entryCount:2,totalBytes:100},
 });
 const storedA=await promoteEquinoxLocalMainNativeCandidate({
   candidate:f.candidate,transactionRoot:f.root,transactionId:TX,validateRelease,
 });
 const storedB=await promoteEquinoxLocalMainNativeCandidate({
   candidate:{...f.candidate,sourceSha:secondSha,transactionId:secondTx,
     releaseDir:secondRelease,artifactSha256:"e".repeat(64)},transactionRoot:f.root,
   transactionId:secondTx,validateRelease,
 });
 assert.equal(storedA.payloadVersion,storedB.payloadVersion);
 const identityA={schemaVersion:1,channel:"main",sourceSha:SHA,target:TARGET,runtimeContractSha256:DIGEST};
 const identityB={schemaVersion:1,channel:"main",sourceSha:secondSha,target:TARGET,runtimeContractSha256:DIGEST};
 const pointerPath=path.join(f.root,"current-native.json");
 await writeEquinoxLocalMainNativePointer(pointerPath,identityA,{transactionRoot:f.root,validateRelease});
 const transition=createEquinoxLocalMainNativePointerTransition({
   pointerPath,transactionRoot:f.root,previous:identityA,target:identityB,
   readPointer:(pointer,options)=>readEquinoxLocalMainNativePointer(pointer,{...options,validateRelease}),
   writePointer:(pointer,next,options)=>writeEquinoxLocalMainNativePointer(pointer,next,{...options,validateRelease}),
 });
 const selected=await transition.selectTarget();
 assert.equal(selected.sourceSha,secondSha);
 assert.equal((await transition.requireTarget()).releaseDir,storedB.releaseDir);
 await transition.selectTarget(); // Idempotent even at the same semantic version
 const restored=await transition.restorePrevious();
 assert.equal(restored.sourceSha,SHA);
 assert.equal(restored.releaseDir,storedA.releaseDir);
 assert.equal(await fs.readFile(path.join(storedA.releaseDir,"payload.bin"),"utf8"),"native payload");
 assert.equal(await fs.readFile(path.join(storedB.releaseDir,"payload.bin"),"utf8"),"replacement native B");
});
