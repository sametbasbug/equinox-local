import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {generateKeyPairSync} from "node:crypto";
import test from "node:test";

import { prepareEquinoxLocalMainNativeLifecycle } from "../../src/equinox-local-main-native-activation.js";
import { createSignedMainInstallPointer, validateSignedMainInstallPointer } from "../../src/equinox-local-main-install-pointer.js";

const A = "1".repeat(40);
const B = "2".repeat(40);
const DA = "a".repeat(64);
const DB = "b".repeat(64);
const TX = `main-${"c".repeat(32)}`;
const ROOT = "/private/tmp/equinox-main-state";

test("hosted native smoke reports bounded discovery failures before exact-target assertions", async () => {
  const source = await fs.readFile(new URL("./smoke-main-upgrade-macos.mjs", import.meta.url), "utf8");
  assert.match(source, /checkError=\$\{boundedDiagnostic\(main\?\.lastError\)\}/u);
  assert.match(source, /reason=\$\{boundedDiagnostic\(main\?\.reason\)\}/u);
  assert.match(source, /const discovery = await jsonApi\("\/api\/v1\/update"\);\s*if \(discovery\.update\?\.main\?\.targetSha !== targetSha \|\| discovery\.update\?\.main\?\.applyAvailable !== true\) \{\s*await printApplyFailureEvidence\(transactionRoot\);\s*\}\s*assert\.equal\(discovery\.update\?\.main\?\.targetSha, targetSha/u);
});

function transition(target) {
  return { mode: "artifact_required", target, currentSha: A, targetSha: B, currentRuntimeContractSha256: DA, targetRuntimeContractSha256: DB };
}
function candidate(target, releaseDir) {
  return { sourceSha: B, target, transactionId: TX, runtimeContractSha256: DB, artifactSha256: "d".repeat(64), artifactBytes: 42, payloadVersion: "5.2.1", releaseDir };
}

function admittedWindowsSupervisor(target = "win32-x64") {
  return {
    admitted: true,
    journal: { read: async () => null, advance: async () => null },
    record: { transactionId: TX, target, currentSha: A, targetSha: B,
      targetRuntimeContractSha256: DB, receiptStartedAt: "2026-10-21T00:00:00.000Z" },
    supervisor: { independentNativeOwner: true, assertWorkerOwnership: async () => true,
      shutdownOwnedWpf: async () => true, quiesceOwnedB: async () => true, verifyNativeMessaging: async () => true,
      verifySustainedHealth: async () => true },
  };
}

test("Darwin Main native lifecycle snapshots before activation and advances pointer only on commit", async () => {
  const events = [];
  const target = "darwin-arm64";
  const durable = `${ROOT}/native-store/${target}/${B}/release`;
  const lifecycle = await prepareEquinoxLocalMainNativeLifecycle({
    transition: transition(target), candidate: candidate(target, `${ROOT}/staging/${TX}/native-candidate/release`), transactionRoot: ROOT, transactionId: TX,
    installation: { managed: true, selfUpdateSupported: true, target, installRoot: "/Users/test/Library/Application Support/Equinox Local", releaseDir: "/stable/5.2.0" },
    promoteCandidateImpl: async () => ({ sourceSha: B, target, runtimeContractSha256: DB, releaseDir: durable }),
    readPointerImpl: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    snapshotDarwinImpl: async (value) => events.push(["snapshot", value]),
    writeRecoveryDescriptorImpl: async (value) => events.push(["recovery-descriptor", value]),
    activateDarwinImpl: async (value) => events.push(["activate", value]),
    restoreDarwinImpl: async (value) => events.push(["rollback", value]),
    writePointerImpl: async (_path, value) => { events.push(["commit", value]); return value; },
  });
  assert.deepEqual(events.map(([name]) => name), ["snapshot", "recovery-descriptor"]);
  await lifecycle.activate();
  await lifecycle.commit();
  await lifecycle.rollback();
  assert.deepEqual(events.map(([name]) => name), ["snapshot", "recovery-descriptor", "activate", "commit", "rollback"]);
  assert.equal(events[2][1].releaseDir, durable);
  assert.equal(events[2][1].requirePayloadIdentity, true);
  assert.equal(events[3][1].sourceSha, B);
});

test("Windows Main native lifecycle refuses absent and unowned supervisor before promotion", async () => {
  const target = "win32-x64";
  for (const windowsAdmission of [null, { admitted: true, ownerOnly: true },
    { ...admittedWindowsSupervisor(), supervisor: { independentNativeOwner: true } },
    { ...admittedWindowsSupervisor(), record: { ...admittedWindowsSupervisor().record, targetSha: A } }]) {
    const operations = [];
    await assert.rejects(prepareEquinoxLocalMainNativeLifecycle({
      transition: transition(target), candidate: candidate(target, "C:\\Staging\\native-candidate"),
      transactionRoot: ROOT, transactionId: TX,
      installation: { managed: true, selfUpdateSupported: true, target }, windowsAdmission,
      promoteCandidateImpl: async () => { operations.push("promote"); throw Error("must not promote"); },
      readPointerImpl: async () => { operations.push("pointer"); throw Error("must not read pointer"); },
      snapshotWindowsImpl: async () => { operations.push("snapshot"); throw Error("must not snapshot WPF"); },
      writeRecoveryDescriptorImpl: async () => { operations.push("descriptor"); throw Error("must not write recovery descriptor"); },
      createBoundWindowsABImpl: () => { operations.push("bound"); throw Error("must not create lifecycle"); },
    }), /independent supervisor ownership and exact journal identity/u);
    assert.deepEqual(operations, []);
  }
});

test("Main native lifecycle rejects a stale native pointer before platform mutation", async () => {
  const target = "darwin-arm64";
  let mutated = false;
  await assert.rejects(prepareEquinoxLocalMainNativeLifecycle({
    transition: transition(target), candidate: candidate(target, `${ROOT}/staging/${TX}/native-candidate/release`), transactionRoot: ROOT, transactionId: TX,
    installation: { managed: true, selfUpdateSupported: true, target, installRoot: "/Users/test/Library/Application Support/Equinox Local", releaseDir: "/stable/5.2.0" },
    promoteCandidateImpl: async () => ({ sourceSha: B, target, runtimeContractSha256: DB, releaseDir: `${ROOT}/native-store/${target}/${B}/release` }),
    readPointerImpl: async () => ({ sourceSha: A, target, runtimeContractSha256: "e".repeat(64), releaseDir: "/old" }),
    snapshotDarwinImpl: async () => { mutated = true; },
  }), /does not match the current source runtime contract/u);
  assert.equal(mutated, false);
});

test("native activation rejects mismatched candidate before durable native promotion", async () => {
  const target = "darwin-arm64";
  const good = candidate(target, ROOT + "/staging/" + TX + "/native-candidate/release");
  for (const wrong of [
    {...good, sourceSha: A},
    {...good, target: "darwin-x64"},
    {...good, runtimeContractSha256: DA},
  ]) {
    const calls = [];
    await assert.rejects(
      prepareEquinoxLocalMainNativeLifecycle({
        transition: transition(target), candidate: wrong, transactionRoot: ROOT, transactionId: TX,
        installation: {managed:true,selfUpdateSupported:true,target,installRoot:"/Users/test/Library/Application Support/Equinox Local"},
        promoteCandidateImpl: async () => {calls.push("promote"); throw new Error("unexpected native mutation");},
      }), /candidate identity does not match/u,
    );
    assert.deepEqual(calls, [], "unadmitted candidate must not touch native store");
  }
});

test("existing Darwin snapshot must pass independent inspection before descriptor publication", async () => {
  const target = "darwin-arm64";
  const calls = [];
  await assert.rejects(
    prepareEquinoxLocalMainNativeLifecycle({
      transition: transition(target),candidate:candidate(target,ROOT+"/staging/"+TX+"/native-candidate/release"),
      transactionRoot:ROOT,transactionId:TX,
      installation:{managed:true,selfUpdateSupported:true,target,installRoot:"/Users/test/Library/Application Support/Equinox Local",releaseDir:"/stable/5.2.0"},
      promoteCandidateImpl:async()=>({sourceSha:B,target,runtimeContractSha256:DB,releaseDir:ROOT+"/native-store/"+target+"/"+B+"/release"}),
      readPointerImpl:async()=>{throw Object.assign(new Error("missing"),{code:"ENOENT"});},
      snapshotDarwinImpl:async()=>{calls.push("snapshot");throw Object.assign(new Error("existing snapshot"),{code:"EEXIST"});},
      inspectDarwinSnapshotImpl:async()=>{calls.push("inspect");throw new Error("unverified old macOS snapshot");},
      writeRecoveryDescriptorImpl:async()=>{calls.push("descriptor");},
      activateDarwinImpl:async()=>{calls.push("activate");},
    }),/unverified old macOS snapshot/u,
  );
  assert.deepEqual(calls,["snapshot","inspect"],"old recovery snapshot must never be replaced or admitted without validation");
});

test("Windows Main accepted supervisor can reach only the journal-bound native lifecycle", async () => {
  const target = "win32-x64";
  const calls = [];
  const lifecycle = { target, activate: async () => {}, rollback: async () => {}, commit: async () => {} };
  const admission = admittedWindowsSupervisor(target);
  const result = await prepareEquinoxLocalMainNativeLifecycle({
    transition: transition(target), candidate: candidate(target, "C:\\Staging\\native-candidate"),
    transactionRoot: ROOT, transactionId: TX,
    installation: { managed: true, selfUpdateSupported: true, target, releaseDir: "C:\\Stable\\5.2.0",
      programRoot: "C:\\Program\\Equinox Local", nativeMessagingManifestRoot: "C:\\State\\manifest" },
    windowsAdmission: admission,
    promoteCandidateImpl: async () => { calls.push("promote"); return { sourceSha: B, target, runtimeContractSha256: DB, releaseDir: "C:\\Native\\B" }; },
    readPointerImpl: async () => { calls.push("pointer"); return null; },
    snapshotWindowsImpl: async () => { calls.push("legacy-snapshot"); },
    writeRecoveryDescriptorImpl: async () => { calls.push("descriptor"); },
    createBoundWindowsABImpl: (args) => {
      calls.push("supervisor-lifecycle");
      assert.equal(args.windowsAdmission, admission);
      assert.equal(args.transactionId, TX);
      assert.equal(args.transition.targetSha, B);
      assert.equal(args.stored.sourceSha, B);
      return lifecycle;
    },
  });
  assert.equal(result, lifecycle);
  assert.deepEqual(calls, ["promote", "pointer", "descriptor", "supervisor-lifecycle"]);
});


function signedDurableFixture(target="darwin-arm64"){
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const signedPointer=createSignedMainInstallPointer({
  sourceSha:B,version:"5.2.1",publishedAt:"2026-10-27T22:00:00.000Z",
  nativeManifests:["darwin-arm64","darwin-x64","win32-arm64","win32-x64"].map(arch=>({
   schemaVersion:1,channel:"main",sourceSha:B,target:arch,runtimeContractSha256:DB,
   artifact:{name:"equinox-local-main-"+B+"-"+arch+(arch.startsWith("win32-")?".zip":".tar.gz"),
    sha256:"d".repeat(64),bytes:42},
  })),keyId:"unit-temporary",privateKey,
 });
 const verifySignedPointerImpl=(raw,opts)=>validateSignedMainInstallPointer(raw,{
  ...opts,publicKeys:{"unit-temporary":publicKey.export({type:"spki",format:"pem"})},
 });
 const storedCandidate={sourceSha:B,target,runtimeContractSha256:DB,
  artifactSha256:"d".repeat(64),artifactBytes:42,payloadVersion:"5.2.1"};
 const releaseDir=ROOT+"/native-store/"+target+"/"+B+"/release";
 const durable={sourceSha:B,target,runtimeContractSha256:DB,releaseDir,payloadVersion:"5.2.1",
  manifest:{artifactSha256:"d".repeat(64),artifactBytes:42}};
 return {signedPointer,verifySignedPointerImpl,storedCandidate,durable};
}

test("macOS native A/B lifecycle accepts ONLY production-root signed pre-staged immutable B without re-promoting or switching prematurely",async()=>{
 const f=signedDurableFixture();
 const events=[];
 const options={
  transition:transition("darwin-arm64"),
  storedCandidate:f.storedCandidate,signedPointer:f.signedPointer,
  verifySignedPointerImpl:f.verifySignedPointerImpl,
  transactionRoot:ROOT,transactionId:TX,
  installation:{managed:true,selfUpdateSupported:true,target:"darwin-arm64",
    installRoot:"/Users/test/Library/Application Support/Equinox Local",releaseDir:"/stable/5.2.0"},
  inspectStoredImpl:async()=>{events.push("read-store");return f.durable},
  promoteCandidateImpl:async()=>assert.fail("pre-staged B must not be promoted again"),
  readPointerImpl:async()=>{throw Object.assign(new Error("not yet Main"),{code:"ENOENT"})},
  snapshotDarwinImpl:async()=>{events.push("snapshot")},
  writeRecoveryDescriptorImpl:async()=>{events.push("recovery")},
  activateDarwinImpl:async()=>{events.push("activate")},
  restoreDarwinImpl:async()=>{events.push("restore")},
  writePointerImpl:async()=>{events.push("commit");return f.durable},
 };
 const lifecycle=await prepareEquinoxLocalMainNativeLifecycle(options);
 assert.deepEqual(events,["read-store","snapshot","recovery"]);
 await lifecycle.activate();
 await lifecycle.commit();
 assert.deepEqual(events,["read-store","snapshot","recovery","activate","commit"]);
 await lifecycle.rollback();
 assert.equal(events.at(-1),"restore");
});

test("pre-staged native A/B rejects unsigned, forged, wrong-SHA/bytes/version BEFORE native mutation",async()=>{
 const f=signedDurableFixture();
 const events=[];
 const opts={
  transition:transition("darwin-arm64"),
  storedCandidate:f.storedCandidate,signedPointer:f.signedPointer,
  transactionRoot:ROOT,transactionId:TX,
  installation:{managed:true,selfUpdateSupported:true,target:"darwin-arm64",
   installRoot:"/Users/test/Library/Application Support/Equinox Local",releaseDir:"/stable/5.2.0"},
  inspectStoredImpl:async()=>{events.push("read-store");return f.durable},
  snapshotDarwinImpl:async()=>{events.push("snapshot")},
 };
 await assert.rejects(prepareEquinoxLocalMainNativeLifecycle(opts),/trusted|signature|signing key/u);
 assert.deepEqual(events,[]);
 for(const change of [
  {storedCandidate:{...f.storedCandidate,sourceSha:A}},
  {storedCandidate:{...f.storedCandidate,artifactSha256:"e".repeat(64)}},
  {storedCandidate:{...f.storedCandidate,artifactBytes:43}},
  {storedCandidate:{...f.storedCandidate,payloadVersion:"5.2.0"}},
 ]){
  await assert.rejects(prepareEquinoxLocalMainNativeLifecycle({
   ...opts,verifySignedPointerImpl:f.verifySignedPointerImpl,...change,
  }),/Signed Main stored native candidate differs/u);
 }
 assert.deepEqual(events,[]);
 await assert.rejects(prepareEquinoxLocalMainNativeLifecycle({
  ...opts,verifySignedPointerImpl:f.verifySignedPointerImpl,
  inspectStoredImpl:async()=>({...f.durable,manifest:{...f.durable.manifest,artifactBytes:43}}),
 }),/durable native manifest does not match/u);
 assert.deepEqual(events,[]);
});

test("Windows pre-staged B remains UNACTIVATABLE without independent signed Guardian ownership, even with correct Ed25519 selector",async()=>{
 const f=signedDurableFixture("win32-x64");
 const events=[];
 await assert.rejects(prepareEquinoxLocalMainNativeLifecycle({
  transition:transition("win32-x64"),
  storedCandidate:f.storedCandidate,signedPointer:f.signedPointer,
  verifySignedPointerImpl:f.verifySignedPointerImpl,
  transactionRoot:ROOT,transactionId:TX,
  installation:{managed:true,selfUpdateSupported:true,target:"win32-x64"},
  inspectStoredImpl:async()=>{events.push("store");return f.durable},
 }),/independent supervisor ownership and exact journal identity/u);
 assert.deepEqual(events,[]);
});
