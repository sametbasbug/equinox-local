import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  equinoxLocalMainNativeRecoveryDescriptor,
  readEquinoxLocalMainNativeRecoveryDescriptor,
  recoverEquinoxLocalMainNativeLifecycle,
  writeEquinoxLocalMainNativeRecoveryDescriptor,
  beginEquinoxLocalSignedNativeMacOwner,
  assertEquinoxLocalSignedNativeMacOwner,
  readEquinoxLocalSignedNativeMacReceipt,
  writeEquinoxLocalSignedNativeMacReceipt,
  releaseEquinoxLocalSignedNativeMacOwner,
} from "../../src/equinox-local-main-native-recovery.js";
import { createSignedMainInstallPointer,validateSignedMainInstallPointer } from "../../src/equinox-local-main-install-pointer.js";
import { createEquinoxLocalMainUpdateTransactionEngine } from "../../src/equinox-local-main-update-transaction.js";
import { runEquinoxLocalSignedMacNativeHandoff } from "../../src/equinox-local-main-update-worker.js";

const A = "1".repeat(40);
const B = "2".repeat(40);
const DA = "a".repeat(64);
const DB = "b".repeat(64);
const TX = `main-${"c".repeat(32)}`;
function transition(target) { return { mode: "artifact_required", target, currentSha: A, targetSha: B, currentRuntimeContractSha256: DA, targetRuntimeContractSha256: DB }; }

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

async function scratch(t) {
  const raw = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "equinox-main-native-recovery-"));
  t.after(() => fs.rm(raw, { recursive: true, force: true }));
  await fs.mkdir(path.join(raw, "staging", TX, "native-rollback"), { recursive: true, mode: 0o700 });
  return raw;
}

test("native recovery descriptor stores identities without arbitrary release paths", () => {
  const main = equinoxLocalMainNativeRecoveryDescriptor({ transition: transition("darwin-arm64"), previousPointer: { sourceSha: A, target: "darwin-arm64", runtimeContractSha256: DA, releaseDir: "/do/not/persist" }, installation: { releaseDir: "/stable/5.2.0" } });
  assert.deepEqual(main.previous, { kind: "main", sourceSha: A, target: "darwin-arm64", runtimeContractSha256: DA });
  assert.equal(JSON.stringify(main).includes("/do/not/persist"), false);
  const stable = equinoxLocalMainNativeRecoveryDescriptor({ transition: transition("darwin-arm64"), previousPointer: null, installation: { releaseDir: "/stable/5.2.0" } });
  assert.deepEqual(stable.previous, { kind: "stable", version: "5.2.0" });
});

test("native recovery descriptor is immutable-once-created and exact-identity bound", async (t) => {
  const root = await scratch(t);
  const args = { transition: transition("darwin-arm64"), previousPointer: null, installation: { releaseDir: "/stable/5.2.0" }, transactionRoot: root, transactionId: TX };
  const first = await writeEquinoxLocalMainNativeRecoveryDescriptor(args);
  const second = await writeEquinoxLocalMainNativeRecoveryDescriptor(args);
  assert.deepEqual(second, first);
  const file = path.join(root, "staging", TX, "native-rollback", "native-recovery.json");
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(readEquinoxLocalMainNativeRecoveryDescriptor({ transactionRoot: root, transactionId: TX, expected: { targetSha: A } }), /target SHA mismatch/u);
  assert.equal(await fs.readFile(file, "utf8"), before);
  await assert.rejects(writeEquinoxLocalMainNativeRecoveryDescriptor({ ...args, previousPointer: { sourceSha: A, target: "darwin-arm64", runtimeContractSha256: DA } }), /immutable identity mismatch/u);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("Darwin recovery reconstructs Stable baseline and exact target without current-native pointer", async () => {
  const events = [];
  const target = "darwin-arm64";
  const root = "/private/tmp/equinox-recovery-state";
  const stored = `${root}/native-store/${target}/${B}/release`;
  const lifecycle = await recoverEquinoxLocalMainNativeLifecycle({
    transition: transition(target), transactionRoot: root, transactionId: TX,
    installation: { managed: true, selfUpdateSupported: true, target, platform: "darwin", installRoot: "/Users/test/Library/Application Support/Equinox Local", releasesRoot: "/Users/test/Library/Application Support/Equinox Local/releases", releaseDir: "/Users/test/Library/Application Support/Equinox Local/releases/5.2.0" },
    readDescriptorImpl: async () => ({ schemaVersion: 1, channel: "main", targetSha: B, target, targetRuntimeContractSha256: DB, previous: { kind: "stable", version: "5.2.0" } }),
    inspectStoredReleaseImpl: async (value) => { events.push(["stored", value]); return { releaseDir: stored, sourceSha: B, target, runtimeContractSha256: DB }; },
    inspectDarwinSnapshotImpl: async (value) => events.push(["snapshot", value]),
    activateDarwinImpl: async (value) => events.push(["activate", value]),
    restoreDarwinImpl: async (value) => events.push(["rollback", value]),
    writePointerImpl: async (_file, value) => { events.push(["commit", value]); return value; },
  });
  await lifecycle.activate(); await lifecycle.rollback(); await lifecycle.commit();
  assert.deepEqual(events.map(([name]) => name), ["stored", "snapshot", "activate", "rollback", "commit"]);
  assert.equal(events[2][1].releaseDir, stored);
  assert.equal(events[2][1].requirePayloadIdentity, true);
  assert.equal(events[4][1].sourceSha, B);
});

test("Windows native crash recovery rejects absent supervisor before reading descriptor or payload", async () => {
  const target = "win32-x64";
  for (const windowsAdmission of [null, { admitted: true, ownerOnly: true },
    { ...admittedWindowsSupervisor(), record: { ...admittedWindowsSupervisor().record, currentSha: B } }]) {
    const reads = [];
    await assert.rejects(recoverEquinoxLocalMainNativeLifecycle({
      transition: transition(target), transactionRoot: "/private/tmp/equinox-win-recovery-state", transactionId: TX,
      installation: { managed: true, selfUpdateSupported: true, target }, windowsAdmission,
      readDescriptorImpl: async () => { reads.push("descriptor"); throw Error("must not read descriptor"); },
      inspectStoredReleaseImpl: async () => { reads.push("release"); throw Error("must not inspect payload"); },
      inspectWindowsSnapshotImpl: async () => { reads.push("snapshot"); throw Error("must not inspect WPF"); },
    }), /independent supervisor ownership and exact journal identity/u);
    assert.deepEqual(reads, []);
  }
});

test("Windows native crash recovery delegates exact A/B identities to independent supervisor lifecycle", async () => {
  const target = "win32-x64";
  const admitted = admittedWindowsSupervisor(target);
  const reads = [];
  const expected = { activate: async () => {}, rollback: async () => {}, commit: async () => {} };
  const result = await recoverEquinoxLocalMainNativeLifecycle({
    transition: transition(target), transactionRoot: "/private/tmp/equinox-win-recovery-state", transactionId: TX,
    installation: { managed: true, selfUpdateSupported: true, target, releasesRoot: "C:\\Stable",
      programRoot: "C:\\Program\\Equinox Local", nativeMessagingManifestRoot: "C:\\State\\manifest" },
    windowsAdmission: admitted,
    readDescriptorImpl: async () => ({ targetSha: B, target, targetRuntimeContractSha256: DB,
      previous: { kind: "main", sourceSha: A, target, runtimeContractSha256: DA } }),
    inspectStoredReleaseImpl: async ({sourceSha}) => {
      reads.push(sourceSha);
      return { releaseDir: `C:\\Native\\${sourceSha}`, sourceSha, target, runtimeContractSha256: sourceSha === A ? DA : DB };
    },
    readPointerImpl: async () => null,
    inspectWindowsSnapshotImpl: async () => { reads.push("legacy-snapshot"); },
    createBoundWindowsABImpl: (args) => {
      assert.equal(args.windowsAdmission, admitted);
      assert.equal(args.transactionId, TX);
      assert.equal(args.previousReleaseDir, `C:\\Native\\${A}`);
      assert.equal(args.stored.sourceSha, B);
      return expected;
    },
  });
  assert.equal(result, expected);
  assert.deepEqual(reads, [B, A]);
});

test("native recovery descriptor rejects malformed JSON, extra identity keys and changed payload without mutating it", async (t) => {
  const root = await scratch(t);
  const args = {
    transition: transition("darwin-arm64"), previousPointer: null,
    installation: { releaseDir: "/stable/5.2.0" }, transactionRoot: root, transactionId: TX,
  };
  await writeEquinoxLocalMainNativeRecoveryDescriptor(args);
  const file = path.join(root, "staging", TX, "native-rollback", "native-recovery.json");
  const original = JSON.parse(await fs.readFile(file, "utf8"));
  for (const invalid of [
    "{ definitely not valid JSON",
    JSON.stringify({ ...original, unauthorized: true }),
    JSON.stringify({ ...original, previous: { ...original.previous, arbitraryPath: "/elsewhere" } }),
    JSON.stringify({ ...original, targetRuntimeContractSha256: "e".repeat(64) }),
  ]) {
    await fs.writeFile(file, invalid, { mode: 0o600 });
    const before = await fs.readFile(file);
    await assert.rejects(readEquinoxLocalMainNativeRecoveryDescriptor({
      transactionRoot: root, transactionId: TX,
      expected: { targetSha: B, target: "darwin-arm64", targetRuntimeContractSha256: DB },
    }), /valid JSON|missing or unsupported fields|runtime contract mismatch/u);
    await assert.rejects(writeEquinoxLocalMainNativeRecoveryDescriptor(args));
    assert.deepEqual(await fs.readFile(file), before, "invalid existing descriptor must remain forensic evidence");
  }
});

test("native recovery descriptor refuses symlinked state file and preserves foreign contents", async (t) => {
  const root = await scratch(t);
  const file = path.join(root, "staging", TX, "native-rollback", "native-recovery.json");
  const foreign = path.join(root, "external.json");
  await fs.writeFile(foreign, '{"canary":"unchanged"}', { mode: 0o600 });
  await fs.symlink(foreign, file);
  const args = {
    transition: transition("darwin-arm64"), previousPointer: null,
    installation: { releaseDir: "/stable/5.2.0" }, transactionRoot: root, transactionId: TX,
  };
  await assert.rejects(readEquinoxLocalMainNativeRecoveryDescriptor({transactionRoot: root,transactionId: TX}));
  await assert.rejects(writeEquinoxLocalMainNativeRecoveryDescriptor(args));
  assert.equal(await fs.readFile(foreign, "utf8"), '{"canary":"unchanged"}');
  assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
});

test("Main native recovery refuses descriptor SHA drift before inspecting stored payload or snapshot", async () => {
  const target = "win32-x64";
  const actions = [];
  await assert.rejects(recoverEquinoxLocalMainNativeLifecycle({
    transition: transition(target), transactionRoot: "/private/tmp/eq-guard", transactionId: TX,
    windowsAdmission: admittedWindowsSupervisor(target),
    installation: { managed: true, selfUpdateSupported: true, target, platform: "win32", releasesRoot: "C:\\Stable", programRoot: "C:\\Program\\Equinox Local", nativeMessagingManifestRoot: "C:\\State\\manifest" },
    readDescriptorImpl: async () => { actions.push("read descriptor"); throw new Error("Main native recovery target SHA mismatch."); },
    inspectStoredReleaseImpl: async () => { actions.push("inspect payload"); throw new Error("must never inspect before descriptor"); },
    inspectWindowsSnapshotImpl: async () => { actions.push("inspect snapshot"); throw new Error("must never activate"); },
    activateWindowsImpl: async () => { actions.push("activate"); throw new Error("must never activate"); },
  }), /target SHA mismatch/u);
  assert.deepEqual(actions, ["read descriptor"]);
});


test("signed native crash recovery replays a half-selected B to both exact Mac pointers, then A rollback",async t=>{
 const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"equinox-signed-recovery-")));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const target="darwin-arm64",root=path.join(home,"Library","Application Support","Equinox Local");
 const txRoot=path.join(root,"main-update"),nativeB=path.join(txRoot,"native-store",target,B,"release");
 const stable=path.join(root,"releases","5.2.0"),nativePath=path.join(txRoot,"current-native.json");
 await fs.mkdir(nativeB,{recursive:true,mode:0o700});
 await fs.mkdir(stable,{recursive:true,mode:0o700});
 await fs.symlink(path.relative(root,stable),path.join(root,"current"));
 const keyId="ephemeral-native-crash-test";
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const signed=createSignedMainInstallPointer({
  sourceSha:B,version:"5.2.1",publishedAt:"2026-10-28T01:00:00.000Z",keyId,privateKey,
  nativeManifests:["darwin-arm64","darwin-x64","win32-arm64","win32-x64"].map(arch=>({
   schemaVersion:1,channel:"main",sourceSha:B,target:arch,runtimeContractSha256:DB,
   artifact:{name:"equinox-local-main-"+B+"-"+arch+(arch.startsWith("win32-")?".zip":".tar.gz"),
    sha256:"d".repeat(64),bytes:42},
  })),
 });
 const selectorPath=path.join(path.dirname(nativeB),"signed-selector.json");
 await fs.writeFile(selectorPath,JSON.stringify(signed),{mode:0o600});
 const events=[];
 const opts={
  transition:transition(target),transactionRoot:txRoot,transactionId:TX,
  installation:{managed:true,selfUpdateSupported:true,target,platform:"darwin",
   installRoot:root,releasesRoot:path.join(root,"releases"),releaseDir:stable},
  readDescriptorImpl:async()=>({schemaVersion:1,channel:"main",
   targetSha:B,target,targetRuntimeContractSha256:DB,previous:{kind:"stable",version:"5.2.0"}}),
  inspectStoredReleaseImpl:async()=>({releaseDir:nativeB,sourceSha:B,target,
   runtimeContractSha256:DB,payloadVersion:"5.2.1",manifest:{artifactSha256:"d".repeat(64),artifactBytes:42}}),
  inspectDarwinSnapshotImpl:async()=>events.push("verified-A-snapshot"),
  verifySignedPointerImpl:(raw,options)=>validateSignedMainInstallPointer(raw,{
   ...options,publicKeys:{[keyId]:publicKey.export({type:"spki",format:"pem"})},
  }),
  readPointerImpl:async file=>JSON.parse(await fs.readFile(file,"utf8")),
  writePointerImpl:async(file,value)=>{
   await fs.writeFile(file,JSON.stringify(value),{mode:0o600});
   return value;
  },
  activateDarwinImpl:async()=>{
   events.push("app-B");
   assert.equal((await fs.realpath(path.join(root,"current"))),nativeB);
   assert.equal(JSON.parse(await fs.readFile(nativePath,"utf8")).sourceSha,B);
  },
  restoreDarwinImpl:async()=>{
   events.push("app-A");
   assert.equal(await fs.realpath(path.join(root,"current")),stable);
   await assert.rejects(fs.lstat(nativePath),{code:"ENOENT"});
  },
 };
 // Simulate crash after exact native pointer B write but before current B.
 await fs.writeFile(nativePath,JSON.stringify({
  schemaVersion:1,channel:"main",sourceSha:B,target,runtimeContractSha256:DB,
 }),{mode:0o600});
 const recovered=await recoverEquinoxLocalMainNativeLifecycle(opts);
 assert.deepEqual(events,["verified-A-snapshot"]);
 await recovered.activate();
 assert.equal(await fs.realpath(path.join(root,"current")),nativeB);
 await recovered.commit();
 await recovered.rollback();
 await recovered.rollback();
 assert.equal(await fs.realpath(path.join(root,"current")),stable);
 await assert.rejects(fs.stat(nativePath),{code:"ENOENT"});
 assert.deepEqual(events,["verified-A-snapshot","app-B","app-A","app-A"]);
 // The real production verifier MUST refuse a user-invented key, even if
 // all package names, SHA and metadata appear otherwise admissible.
 await assert.rejects(recoverEquinoxLocalMainNativeLifecycle({...opts,
  verifySignedPointerImpl:undefined,
 }),/signing key|signature|trusted/u);
 assert.equal(await fs.realpath(path.join(root,"current")),stable);
 // A malicious selector symlink must not downgrade to legacy recovery.
 await fs.rm(selectorPath);
 await fs.symlink(path.join(home,"foreign"),selectorPath);
 await assert.rejects(recoverEquinoxLocalMainNativeLifecycle(opts),/not a private normal file/u);
});


test("signed native activation uses the SAME exclusive Main active.json lock as the legacy source updater",async t=>{
 const root=await scratch(t);
 const input={transactionRoot:root,transactionId:TX,sourceSha:B,
  target:"darwin-arm64",runtimeContractSha256:DB};
 await writeEquinoxLocalMainNativeRecoveryDescriptor({
  transition:transition("darwin-arm64"),previousPointer:null,
  installation:{releaseDir:"/owned/release/5.2.0"},
  transactionRoot:root,transactionId:TX,
 });
 const owned=await beginEquinoxLocalSignedNativeMacOwner(input);
 assert.equal(owned.kind,"signed-native");
 assert.deepEqual(await assertEquinoxLocalSignedNativeMacOwner(input),owned);
 assert.equal((await readEquinoxLocalSignedNativeMacReceipt(input)).status,"admitted");
 await writeEquinoxLocalSignedNativeMacReceipt({...input,status:"activating"});
 await writeEquinoxLocalSignedNativeMacReceipt({...input,status:"rolling_back"});
 await writeEquinoxLocalSignedNativeMacReceipt({...input,status:"rolled_back"});
 assert.equal((await readEquinoxLocalSignedNativeMacReceipt(input)).status,"rolled_back");
 await assert.rejects(writeEquinoxLocalSignedNativeMacReceipt({...input,status:"activating"}),
  /cannot advance from its durable terminal/u);
 const lock=path.join(root,"active.json");
 assert.equal((await fs.stat(lock)).mode&0o777,0o600);
 assert.equal((await fs.stat(lock)).nlink,1);
 await assert.rejects(beginEquinoxLocalSignedNativeMacOwner(input),{code:"EEXIST"});
 for(const invalid of [
  {sourceSha:A},{transactionId:"main-"+ "d".repeat(32)},
  {runtimeContractSha256:DA},{target:"darwin-x64"},
 ]){
  await assert.rejects(assertEquinoxLocalSignedNativeMacOwner({...input,...invalid}),
    /differs from the exact active transaction/u);
 }
 const sourceEngine=createEquinoxLocalMainUpdateTransactionEngine({
  sourceRoot:"/owned/main/source",transactionRoot:root,
  inspectCheckoutImpl:async()=>assert.fail("legacy Git must never run on a native-owned lock"),
 });
 await assert.rejects(sourceEngine.begin({currentSha:A,targetSha:B}),
  /missing or unsupported fields|Main update lock marker/u);
 assert.deepEqual(await assertEquinoxLocalSignedNativeMacOwner(input),owned,
  "legacy Main admission must not replace signed native ownership");
});

test("signed native lock refuses private-root drift, forged owner symlinks and mismatched recovery descriptor",async t=>{
 const root=await scratch(t);
 const input={transactionRoot:root,transactionId:TX,sourceSha:B,
  target:"darwin-arm64",runtimeContractSha256:DB};
 await writeEquinoxLocalMainNativeRecoveryDescriptor({
  transition:transition("darwin-arm64"),previousPointer:null,
  installation:{releaseDir:"/owned/release/5.2.0"},
  transactionRoot:root,transactionId:TX,
 });
 const external=path.join(root,"outside.json");
 await fs.writeFile(external,'{"secret":"untouched"}',{mode:0o600});
 const lock=path.join(root,"active.json");
 await fs.symlink(external,lock);
 await assert.rejects(assertEquinoxLocalSignedNativeMacOwner(input),/private normal lock/u);
 await assert.rejects(beginEquinoxLocalSignedNativeMacOwner(input),{code:"EEXIST"});
 assert.equal(await fs.readFile(external,"utf8"),'{"secret":"untouched"}');
 await fs.unlink(lock);
 await assert.rejects(beginEquinoxLocalSignedNativeMacOwner({...input,sourceSha:A}),/target SHA mismatch/u);
 await fs.chmod(root,0o755);
 await assert.rejects(beginEquinoxLocalSignedNativeMacOwner(input),/private owned directory/u);
 await assert.rejects(fs.lstat(lock),{code:"ENOENT"});
});


test("signed native durable receipt refuses forged identity and symlink without damaging foreign contents",async t=>{
 const root=await scratch(t);
 const input={transactionRoot:root,transactionId:TX,sourceSha:B,
  target:"darwin-arm64",runtimeContractSha256:DB};
 await writeEquinoxLocalMainNativeRecoveryDescriptor({
  transition:transition("darwin-arm64"),previousPointer:null,
  installation:{releaseDir:"/owned/release/5.2.0"},
  transactionRoot:root,transactionId:TX,
 });
 await beginEquinoxLocalSignedNativeMacOwner(input);
 await writeEquinoxLocalSignedNativeMacReceipt({...input,status:"activating"});
 await writeEquinoxLocalSignedNativeMacReceipt({...input,status:"rolling_back"});
 await writeEquinoxLocalSignedNativeMacReceipt({...input,status:"rollback_failed"});
 await assert.rejects(writeEquinoxLocalSignedNativeMacReceipt({...input,status:"rolled_back"}),
  /cannot advance from its durable terminal/u);
 const file=path.join(root,"receipts",TX+".signed-native.json");
 const before=await fs.readFile(file);
 const corrupted=JSON.parse(before.toString("utf8"));
 corrupted.sourceSha=A;
 await fs.writeFile(file,JSON.stringify(corrupted),{mode:0o600});
 await assert.rejects(readEquinoxLocalSignedNativeMacReceipt(input),/differs from active transaction/u);
 await assert.rejects(writeEquinoxLocalSignedNativeMacReceipt({...input,status:"healthy"}),
  /differs from active transaction/u);
 await fs.unlink(file);
 const foreign=path.join(root,"foreign");
 await fs.writeFile(foreign,"foreign",{mode:0o600});
 await fs.symlink(foreign,file);
 await assert.rejects(readEquinoxLocalSignedNativeMacReceipt(input),/not a private normal file/u);
 assert.equal(await fs.readFile(foreign,"utf8"),"foreign");
});


test("native signed terminal owner archives exact hardlink inode, releases global Main lock and survives repeated calls",async t=>{
 const root=await scratch(t);
 const identity={transactionRoot:root,transactionId:TX,sourceSha:B,
  target:"darwin-arm64",runtimeContractSha256:DB};
 await writeEquinoxLocalMainNativeRecoveryDescriptor({
  transition:transition("darwin-arm64"),previousPointer:null,
  installation:{releaseDir:"/owned/release/5.2.0"},
  transactionRoot:root,transactionId:TX,
 });
 await beginEquinoxLocalSignedNativeMacOwner(identity);
 const active=path.join(root,"active.json");
 const before=await fs.stat(active);
 await assert.rejects(releaseEquinoxLocalSignedNativeMacOwner(identity),/cannot be released before verified/u);
 assert.equal((await fs.stat(active)).ino,before.ino);
 await writeEquinoxLocalSignedNativeMacReceipt({...identity,status:"activating"});
 await writeEquinoxLocalSignedNativeMacReceipt({...identity,status:"healthy"});
 const result=await releaseEquinoxLocalSignedNativeMacOwner(identity);
 assert.equal(result.released,true);
 assert.equal(result.alreadyReleased,false);
 await assert.rejects(fs.lstat(active),{code:"ENOENT"});
 const archived=path.join(root,"receipts",TX+".signed-native-owner.json");
 const archiveStat=await fs.stat(archived);
 assert.equal(archiveStat.ino,before.ino);
 assert.equal(archiveStat.nlink,1);
 assert.equal((await fs.stat(archived)).mode&0o777,0o600);
 assert.deepEqual(await releaseEquinoxLocalSignedNativeMacOwner(identity),{
  released:true,alreadyReleased:true,transactionId:TX,
 });
 await assert.rejects(releaseEquinoxLocalSignedNativeMacOwner({...identity,sourceSha:A}),
  /archived owner does not match/u);
 assert.equal((await fs.stat(archived)).ino,before.ino);
});

test("native terminal owner safely resumes after crash between archive hardlink and active.json unlink",async t=>{
 const root=await scratch(t);
 const identity={transactionRoot:root,transactionId:TX,sourceSha:B,
  target:"darwin-arm64",runtimeContractSha256:DB};
 await writeEquinoxLocalMainNativeRecoveryDescriptor({
  transition:transition("darwin-arm64"),previousPointer:null,
  installation:{releaseDir:"/owned/release/5.2.0"},
  transactionRoot:root,transactionId:TX,
 });
 await beginEquinoxLocalSignedNativeMacOwner(identity);
 await writeEquinoxLocalSignedNativeMacReceipt({...identity,status:"activating"});
 await writeEquinoxLocalSignedNativeMacReceipt({...identity,status:"rolling_back"});
 await writeEquinoxLocalSignedNativeMacReceipt({...identity,status:"rolled_back"});
 const active=path.join(root,"active.json");
 const archived=path.join(root,"receipts",TX+".signed-native-owner.json");
 await fs.link(active,archived);
 assert.equal((await fs.stat(active)).nlink,2);
 assert.equal((await fs.stat(archived)).ino,(await fs.stat(active)).ino);
 assert.equal((await readEquinoxLocalSignedNativeMacReceipt(identity)).status,"rolled_back");
 assert.equal((await releaseEquinoxLocalSignedNativeMacOwner(identity)).alreadyReleased,false);
 await assert.rejects(fs.lstat(active),{code:"ENOENT"});
 assert.equal((await releaseEquinoxLocalSignedNativeMacOwner(identity)).alreadyReleased,true);
});

test("native terminal lock release refuses forged archive, active symlink, failed A and foreign receipts",async t=>{
 const root=await scratch(t);
 const identity={transactionRoot:root,transactionId:TX,sourceSha:B,
  target:"darwin-arm64",runtimeContractSha256:DB};
 await writeEquinoxLocalMainNativeRecoveryDescriptor({
  transition:transition("darwin-arm64"),previousPointer:null,
  installation:{releaseDir:"/owned/release/5.2.0"},
  transactionRoot:root,transactionId:TX,
 });
 await beginEquinoxLocalSignedNativeMacOwner(identity);
 await writeEquinoxLocalSignedNativeMacReceipt({...identity,status:"activating"});
 await writeEquinoxLocalSignedNativeMacReceipt({...identity,status:"rolling_back"});
 await writeEquinoxLocalSignedNativeMacReceipt({...identity,status:"rollback_failed"});
 const active=path.join(root,"active.json");
 await assert.rejects(releaseEquinoxLocalSignedNativeMacOwner(identity),/cannot be released before verified/u);
 const fakeArchive=path.join(root,"receipts",TX+".signed-native-owner.json");
 await fs.writeFile(fakeArchive,"foreign",{mode:0o600});
 await assert.rejects(releaseEquinoxLocalSignedNativeMacOwner(identity),/cannot be released before verified/u);
 await fs.unlink(fakeArchive);
 await fs.unlink(active);
 const external=path.join(root,"external.txt");
 await fs.writeFile(external,"safe",{mode:0o600});
 await fs.symlink(external,active);
 await assert.rejects(releaseEquinoxLocalSignedNativeMacOwner(identity),/not a private normal lock/u);
 assert.equal(await fs.readFile(external,"utf8"),"safe");
});


test("real filesystem detached-native handoff rolls back half-selected B, verifies Stable A and releases shared Main lock",async t=>{
 const raw=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"equinox-mac-detached-native-")));
 t.after(()=>fs.rm(raw,{recursive:true,force:true}));
 const root=path.join(raw,"Library","Application Support","Equinox Local");
 const state=path.join(root,"main-update"),target="darwin-arm64",version="5.2.1";
 const b=path.join(state,"native-store",target,B,"release");
 const stable=path.join(root,"releases","5.2.0");
 await fs.mkdir(b,{recursive:true,mode:0o700});
 await fs.mkdir(stable,{recursive:true,mode:0o700});
 await fs.symlink(path.relative(root,stable),path.join(root,"current"));
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const keyId="ephemeral-native-detached-handoff";
 const signed=createSignedMainInstallPointer({
  sourceSha:B,version,keyId,privateKey,publishedAt:"2026-10-28T01:00:00.000Z",
  nativeManifests:["darwin-arm64","darwin-x64","win32-arm64","win32-x64"].map(arch=>({
   schemaVersion:1,channel:"main",sourceSha:B,target:arch,runtimeContractSha256:DB,
   artifact:{name:"equinox-local-main-"+B+"-"+arch+(arch.startsWith("win32-")?".zip":".tar.gz"),
    sha256:"d".repeat(64),bytes:42},
  })),
 });
 await fs.writeFile(path.join(path.dirname(b),"signed-selector.json"),JSON.stringify(signed),{mode:0o600});
 const installation={managed:true,selfUpdateSupported:true,target,platform:"darwin",
  installRoot:root,releasesRoot:path.join(root,"releases"),releaseDir:stable};
 const tr=transition(target),owner={transactionRoot:state,transactionId:TX,
  sourceSha:B,target,runtimeContractSha256:DB};
 await writeEquinoxLocalMainNativeRecoveryDescriptor({
  transition:tr,previousPointer:null,installation,transactionRoot:state,transactionId:TX,
 });
 await beginEquinoxLocalSignedNativeMacOwner(owner);
 const pointer=path.join(state,"current-native.json");
 // Crash after native pointer B switch, before LaunchAgent current B switch.
 await fs.writeFile(pointer,JSON.stringify({
  schemaVersion:1,channel:"main",sourceSha:B,target,runtimeContractSha256:DB,
 }),{mode:0o600});
 await writeEquinoxLocalSignedNativeMacReceipt({...owner,status:"activating"});
 const readNative=async f=>JSON.parse(await fs.readFile(f,"utf8"));
 const recovery=await recoverEquinoxLocalMainNativeLifecycle({
  transition:tr,transactionRoot:state,transactionId:TX,installation,
  inspectStoredReleaseImpl:async()=>({releaseDir:b,sourceSha:B,target,runtimeContractSha256:DB,
   payloadVersion:version,manifest:{artifactSha256:"d".repeat(64),artifactBytes:42}}),
  verifySignedPointerImpl:(raw,opts)=>validateSignedMainInstallPointer(raw,{
   ...opts,publicKeys:{[keyId]:publicKey.export({type:"spki",format:"pem"})},
  }),
  readPointerImpl:readNative,
  writePointerImpl:async(f,value)=>{await fs.writeFile(f,JSON.stringify(value),{mode:0o600});return value},
  inspectDarwinSnapshotImpl:async()=>{},
  restoreDarwinImpl:async()=>{},
  activateDarwinImpl:async()=>assert.fail("activating replay must never blindly start B"),
 });
 assert.equal(recovery.previousPointer,null,"a Stable A has no SHA-addressed native pointer");
 const events=[];
 const result=await runEquinoxLocalSignedMacNativeHandoff({...owner,lifecycle:recovery,
  version,previousVersion:"5.2.0",
  assertWorkerImpl:async()=>events.push("verified-detached-launchd-process"),
  restartImpl:async()=>events.push("restart-A"),
  verifyNativeImpl:async()=>{events.push("verify-exact-B");return false},
  verifyStableImpl:async(v,opts)=>{
   events.push("verify-stable-A");
   assert.equal(v,"5.2.0");
   assert.equal(opts.expectedInstallationKind,"managed");
   assert.equal(await fs.realpath(path.join(root,"current")),stable);
   await assert.rejects(fs.lstat(pointer),{code:"ENOENT"});
   return true;
  },
 });
 assert.equal(result.status,"rolled_back");
 assert.deepEqual(events,["verified-detached-launchd-process","verify-exact-B","restart-A","verify-stable-A"]);
 await assert.rejects(fs.lstat(path.join(state,"active.json")),{code:"ENOENT"});
 assert.equal(await fs.realpath(path.join(root,"current")),stable);
 const archived=JSON.parse(await fs.readFile(path.join(state,"receipts",TX+".signed-native.json"),"utf8"));
 assert.equal(archived.status,"rolled_back");
 assert.equal(archived.sourceSha,B);
 const originalArchive=JSON.parse(await fs.readFile(path.join(state,"receipts",TX+".signed-native-owner.json"),"utf8"));
 assert.equal(originalArchive.transactionId,TX);
});
