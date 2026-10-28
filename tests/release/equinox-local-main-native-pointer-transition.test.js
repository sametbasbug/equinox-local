import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import test from "node:test";
import { createEquinoxLocalMainNativePointerTransition, createEquinoxLocalMainMacCurrentLinkTransition } from "../../src/equinox-local-main-native-pointer-transition.js";

const A = { sourceSha: "a".repeat(40), target: "win32-x64", runtimeContractSha256: "1".repeat(64) };
const B = { sourceSha: "b".repeat(40), target: "win32-x64", runtimeContractSha256: "2".repeat(64) };
const path = "/virtual/current-native.json";
function fixture(previous) {
  let onDisk = previous;
  const events = [];
  const options = {
    pointerPath: path,
    transactionRoot: "/virtual",
    target: B,
    previous,
    readPointer: async () => onDisk ?? Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
    writePointer: async (_path, identity) => {
      events.push(["write", identity.sourceSha]);
      onDisk = identity;
      return identity;
    },
    fsImpl: {
      unlink: async () => { events.push(["unlink"]); onDisk = null; },
    },
  };
  return { events, get current() { return onDisk; }, transition: createEquinoxLocalMainNativePointerTransition(options) };
}

test("Windows B native pointer is selected before WPF restart and idempotently committed", async () => {
  const f = fixture(A);
  await f.transition.selectTarget();
  assert.equal(f.current.sourceSha, B.sourceSha);
  await f.transition.selectTarget();
  await f.transition.requireTarget();
  assert.deepEqual(f.events, [["write", B.sourceSha]]);
  await f.transition.restorePrevious();
  assert.equal(f.current.sourceSha, A.sourceSha);
  await f.transition.restorePrevious();
  assert.deepEqual(f.events, [["write", B.sourceSha], ["write", A.sourceSha]]);
});

test("first Main native upgrade restores absent A pointer instead of leaving B selected", async () => {
  const f = fixture(null);
  await f.transition.selectTarget();
  assert.equal(f.current.sourceSha, B.sourceSha);
  await f.transition.restorePrevious();
  assert.equal(f.current, null);
  assert.deepEqual(f.events, [["write", B.sourceSha], ["unlink"]]);
});

test("unexpected third-party pointer identity prevents B selection, commit and rollback", async () => {
  const outsider = { sourceSha: "c".repeat(40), target: "win32-x64", runtimeContractSha256: "3".repeat(64) };
  const f = fixture(A);
  const fOutsider = createEquinoxLocalMainNativePointerTransition({
    pointerPath: path, transactionRoot: "/virtual", target: B, previous: A,
    readPointer: async () => outsider,
    writePointer: async () => assert.fail("Foreign native pointer must never be replaced"),
  });
  await assert.rejects(fOutsider.selectTarget(), /switched away/u);
  await assert.rejects(fOutsider.restorePrevious(), /no longer belongs/u);
  await assert.rejects(fOutsider.requireTarget(), /not durably selected/u);
  await assert.rejects(fOutsider.assertRollbackAdmitted(),/neither admitted A nor B/u);
  assert.deepEqual(f.events, []);
});

test("native pointer transition propagates read errors other than missing files without write or removal", async () => {
  const attempted = [];
  const transition = createEquinoxLocalMainNativePointerTransition({
    pointerPath: path, transactionRoot: "/virtual", previous: A, target: B,
    readPointer: async () => { throw Object.assign(new Error("state access denied"), { code: "EACCES" }); },
    writePointer: async () => { attempted.push("write"); assert.fail("must not write"); },
    fsImpl: { unlink: async () => { attempted.push("unlink"); assert.fail("must not unlink"); } },
  });
  await assert.rejects(transition.selectTarget(), /state access denied/u);
  await assert.rejects(transition.restorePrevious(), /state access denied/u);
  await assert.rejects(transition.requireTarget(), /state access denied/u);
  assert.deepEqual(attempted, []);
});

test("failed B pointer publish retains A and never commits or deletes rollback identity", async () => {
  let onDisk = A;
  const actions = [];
  const transition = createEquinoxLocalMainNativePointerTransition({
    pointerPath: path, transactionRoot: "/virtual", previous: A, target: B,
    readPointer: async () => onDisk,
    writePointer: async () => {
      actions.push("attempted-write");
      throw new Error("durable pointer publish rejected");
    },
    fsImpl: { unlink: async () => { actions.push("unlink"); } },
  });
  await assert.rejects(transition.selectTarget(), /durable pointer publish rejected/u);
  assert.deepEqual(onDisk, A);
  assert.deepEqual(await transition.restorePrevious(), A);
  await assert.rejects(transition.requireTarget(), /not durably selected/u);
  assert.deepEqual(actions, ["attempted-write"]);
});

test("native pointer refuses rollback when another owner changes B to an unadmitted SHA", async () => {
  let onDisk = A;
  const changes = [];
  const transition = createEquinoxLocalMainNativePointerTransition({
    pointerPath: path, transactionRoot: "/virtual", previous: A, target: B,
    readPointer: async () => onDisk,
    writePointer: async (_path, next) => { changes.push(next.sourceSha); onDisk = next; return next; },
    fsImpl: { unlink: async () => { changes.push("unlink"); } },
  });
  await transition.selectTarget();
  onDisk = { ...B, sourceSha: "c".repeat(40) };
  await assert.rejects(transition.restorePrevious(), /no longer belongs/u);
  await assert.rejects(transition.requireTarget(), /not durably selected/u);
  assert.deepEqual(changes, [B.sourceSha]);
});


async function nativeMacFixture(t){
 const folder=await fs.realpath(await fs.mkdtemp(nodePath.join(os.tmpdir(),"equinox-mac-native-current-")));
 t.after(()=>fs.rm(folder,{recursive:true,force:true}));
 const root=nodePath.join(folder,"Library","Application Support","Equinox Local");
 const releaseA=nodePath.join(root,"main-update","native-store","darwin-arm64","a".repeat(40),"release");
 const releaseB=nodePath.join(root,"main-update","native-store","darwin-arm64","b".repeat(40),"release");
 const stable=nodePath.join(root,"releases","6.2.1");
 await Promise.all([fs.mkdir(releaseA,{recursive:true,mode:0o700}),
   fs.mkdir(releaseB,{recursive:true,mode:0o700}),fs.mkdir(stable,{recursive:true,mode:0o700})]);
 await fs.writeFile(nodePath.join(releaseA,"identity"),"native A commit");
 await fs.writeFile(nodePath.join(releaseB,"identity"),"native B commit");
 return {root,releaseA,releaseB,stable,pointer:nodePath.join(root,"current"),
  target:{sourceSha:"b".repeat(40),target:"darwin-arm64",runtimeContractSha256:"f".repeat(64)}};
}

test("Mac native Main switches the owned Stable A symlink to immutable B and idempotently restores A",async t=>{
 const f=await nativeMacFixture(t);
 await fs.symlink(nodePath.relative(f.root,f.stable),f.pointer);
 const transition=createEquinoxLocalMainMacCurrentLinkTransition({
  installRoot:f.root,target:f.target,previousReleaseDir:f.stable,
 });
 assert.equal(await transition.current(),f.stable);
 assert.equal(await transition.selectTarget(),f.releaseB);
 assert.equal(await fs.realpath(f.pointer),f.releaseB);
 await transition.selectTarget(); // Already selected; never create a duplicate A/B move.
 assert.equal(await transition.restorePrevious(),f.stable);
 await transition.restorePrevious();
 assert.equal(await fs.realpath(f.pointer),f.stable);
 assert.equal(await fs.readFile(nodePath.join(f.releaseB,"identity"),"utf8"),"native B commit");
 assert.equal((await fs.readdir(f.root)).filter(name=>name.startsWith(".current-main-")).length,0);
});

test("Mac native A to B with identical displayed version rolls back by full source SHA",async t=>{
 const f=await nativeMacFixture(t);
 await fs.symlink(nodePath.relative(f.root,f.releaseA),f.pointer);
 const transition=createEquinoxLocalMainMacCurrentLinkTransition({
  installRoot:f.root,target:f.target,previousReleaseDir:f.releaseA,
 });
 assert.equal(await transition.selectTarget(),f.releaseB);
 assert.equal(await fs.realpath(f.pointer),f.releaseB);
 assert.equal(await transition.restorePrevious(),f.releaseA);
 assert.equal(await fs.realpath(f.pointer),f.releaseA);
 assert.equal(await fs.readFile(nodePath.join(f.releaseA,"identity"),"utf8"),"native A commit");
 assert.equal(await fs.readFile(nodePath.join(f.releaseB,"identity"),"utf8"),"native B commit");
});

test("Mac first signed native install creates only B symlink and rollback removes just B",async t=>{
 const f=await nativeMacFixture(t);
 const transition=createEquinoxLocalMainMacCurrentLinkTransition({
  installRoot:f.root,target:f.target,previousReleaseDir:null,
 });
 assert.equal(await transition.current(),null);
 await transition.selectTarget();
 assert.equal(await fs.realpath(f.pointer),f.releaseB);
 assert.equal(await transition.restorePrevious(),null);
 await assert.rejects(fs.lstat(f.pointer),{code:"ENOENT"});
 assert.equal(await fs.readFile(nodePath.join(f.releaseB,"identity"),"utf8"),"native B commit");
});

test("Mac native pointer refuses foreign owner, broken link and ordinary file without replacing A or B",async t=>{
 const f=await nativeMacFixture(t);
 const transition=createEquinoxLocalMainMacCurrentLinkTransition({
  installRoot:f.root,target:f.target,previousReleaseDir:f.stable,
 });
 const foreign=nodePath.join(f.root,"foreign");
 await fs.mkdir(foreign,{recursive:true});
 await fs.symlink("foreign",f.pointer);
 await assert.rejects(transition.selectTarget(),/outside admitted A\/B releases/u);
 await assert.rejects(transition.restorePrevious(),/outside admitted A\/B releases/u);
 assert.equal(await fs.readlink(f.pointer),"foreign");
 await fs.unlink(f.pointer);
 await fs.symlink("releases/missing",f.pointer);
 await assert.rejects(transition.selectTarget(),/outside admitted A\/B releases/u);
 await fs.unlink(f.pointer);
 await fs.symlink(nodePath.relative(f.root,f.stable),f.pointer);
 await fs.rm(f.stable,{recursive:true});
 await assert.rejects(transition.selectTarget(),/ENOENT/u,"broken trusted A symlink is not an absent clean install");
 await fs.unlink(f.pointer);
 await fs.writeFile(f.pointer,"not an owned symlink");
 await assert.rejects(transition.selectTarget(),/not an owned symlink/u);
 assert.equal(await fs.readFile(f.pointer,"utf8"),"not an owned symlink");
});

test("Mac native pointer keeps A on failed atomic rename and blocks arbitrary predecessor and target",async t=>{
 const f=await nativeMacFixture(t);
 await fs.symlink(nodePath.relative(f.root,f.releaseA),f.pointer);
 const transition=createEquinoxLocalMainMacCurrentLinkTransition({
  installRoot:f.root,target:f.target,previousReleaseDir:f.releaseA,
  fsImpl:{...fs,rename:async()=>{throw new Error("atomic update rejected")}},
 });
 await assert.rejects(transition.selectTarget(),/atomic update rejected/u);
 assert.equal(await fs.realpath(f.pointer),f.releaseA);
 assert.equal((await fs.readdir(f.root)).filter(name=>name.startsWith(".current-main-")).length,0);
 assert.throws(()=>createEquinoxLocalMainMacCurrentLinkTransition({
  installRoot:f.root,target:f.target,previousReleaseDir:nodePath.join(f.root,"foreign"),
 }),/outside an owned Stable\/native release/u);
 assert.throws(()=>createEquinoxLocalMainMacCurrentLinkTransition({
  installRoot:f.root,target:{...f.target,sourceSha:"wrong"},previousReleaseDir:f.releaseA,
 }),/identity or install root is invalid/u);
});
