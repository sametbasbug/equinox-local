import assert from "node:assert/strict";
import test from "node:test";

import { createEquinoxLocalMainApplyController } from "../../src/equinox-local-main-apply-controller.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

function discovery(value) {
  return { snapshot: () => value };
}

function installation(extra = {}) {
  return {
    kind: "managed-source",
    mainUpdateSupported: true,
    sourceRoot: "/owned/main-update/sources/current",
    mainTransactionRoot: "/owned/main-update",
    gitPath: "/owned/runtime/toolchain/git/bin/git",
    nodePath: "/owned/runtime/toolchain/node/bin/node",
    npmPath: "/owned/runtime/toolchain/node/npm-cli.js",
    ...extra,
  };
}

test("managed-source apply controller binds apply to the exact admitted discovery target", async () => {
  const calls = [];
  const value = discovery({
    checkSupported: true,
    state: "behind",
    currentSha: A,
    targetSha: B,
    dirty: false,
    remoteCanonical: true,
  });
  const controller = createEquinoxLocalMainApplyController({
    installation: installation(),
    discovery: value,
    applyImpl: async (input) => {
      calls.push(input);
      return { status: "scheduled", transactionId: "main-fixture", targetSha: B };
    },
  });

  assert.deepEqual(controller.snapshot(), {
    applySupported: true,
    applyAvailable: true,
    applying: false,
    restartScheduledFor: null,
    applyReason: null,
    applyError: null,
  });

  const result = await controller.apply();
  assert.equal(result.targetSha, B);
  assert.equal(controller.snapshot().restartScheduledFor, B);
  assert.deepEqual(calls, [{
    sourceRoot: "/owned/main-update/sources/current",
    transactionRoot: "/owned/main-update",
    currentSha: A,
    targetSha: B,
    engineOptions: {
      gitPath: "/owned/runtime/toolchain/git/bin/git",
      nodePath: "/owned/runtime/toolchain/node/bin/node",
      npmPath: "/owned/runtime/toolchain/node/npm-cli.js",
      shellPath: null,
    },
    schedulerOptions: { nodePath: "/owned/runtime/toolchain/node/bin/node" },
  }]);
});

test("Main apply remains unavailable for developer source and non-behind discovery states", async () => {
  const source = createEquinoxLocalMainApplyController({
    installation: { kind: "source" },
    discovery: discovery({ checkSupported: true, state: "behind", currentSha: A, targetSha: B, dirty: false, remoteCanonical: true }),
  });
  assert.equal(source.snapshot().applySupported, false);
  await assert.rejects(source.apply(), /managed-source/u);

  for (const state of ["up_to_date", "ahead", "diverged", "dirty", "unavailable"]) {
    const controller = createEquinoxLocalMainApplyController({
      installation: installation(),
      discovery: discovery({ checkSupported: true, state, currentSha: A, targetSha: B, dirty: state === "dirty", remoteCanonical: true }),
    });
    assert.equal(controller.snapshot().applyAvailable, false);
    await assert.rejects(controller.apply(), /newer eligible target/u);
  }
});

test("Main apply rejects unsafe identity and handoff drift", async () => {
  for (const invalid of [
    installation({ mainUpdateSupported: false, mainUpdateReason: "handoff unavailable" }),
    installation({ sourceRoot: "relative/source" }),
    installation({ mainTransactionRoot: "relative/state" }),
  ]) {
    const controller = createEquinoxLocalMainApplyController({
      installation: invalid,
      discovery: discovery({ checkSupported: true, state: "behind", currentSha: A, targetSha: B, dirty: false, remoteCanonical: true }),
    });
    assert.equal(controller.snapshot().applySupported, false);
  }

  const controller = createEquinoxLocalMainApplyController({
    installation: installation(),
    discovery: discovery({ checkSupported: true, state: "behind", currentSha: A, targetSha: B, dirty: false, remoteCanonical: true }),
    applyImpl: async () => ({ status: "scheduled", transactionId: "main-fixture", targetSha: "c".repeat(40) }),
  });
  await assert.rejects(controller.apply(), /target identity/u);
  assert.match(controller.snapshot().applyError, /target identity/u);
});

test("a successful Main re-check can clear a previous apply failure for retry", async () => {
  let fail = true;
  const controller = createEquinoxLocalMainApplyController({
    installation: installation(),
    discovery: discovery({ checkSupported: true, state: "behind", currentSha: A, targetSha: B, dirty: false, remoteCanonical: true }),
    applyImpl: async () => {
      if (fail) throw new Error("temporary handoff failure");
      return { status: "scheduled", transactionId: "main-retry", targetSha: B };
    },
  });
  await assert.rejects(controller.apply(), /temporary handoff failure/u);
  assert.equal(controller.snapshot().applyAvailable, false);
  controller.resetError();
  assert.equal(controller.snapshot().applyAvailable, true);
  fail = false;
  const retried = await controller.apply();
  assert.equal(retried.targetSha, B);
});

test("Main apply enforces single-flight scheduling and retains its admitted target during a pending handoff", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const calls = [];
  let selected = { checkSupported:true, state:"behind", currentSha:A, targetSha:B, dirty:false, remoteCanonical:true };
  const controller = createEquinoxLocalMainApplyController({
    installation: installation(),
    discovery: {snapshot:()=>selected},
    applyImpl:async (options)=>{
      calls.push(options);
      await pending;
      return {status:"scheduled",transactionId:"main-fixture",targetSha:B};
    },
  });
  const first = controller.apply();
  assert.equal(controller.snapshot().applying,true);
  await assert.rejects(controller.apply(),/already being prepared/u);
  selected = {...selected,targetSha:"c".repeat(40)};
  release();
  const outcome=await first;
  assert.equal(outcome.targetSha,B);
  assert.equal(calls.length,1);
  assert.equal(calls[0].targetSha,B);
  assert.equal(controller.snapshot().applying,false);
  assert.equal(controller.snapshot().restartScheduledFor,B);
});

test("Main apply never calls worker scheduling for untrusted snapshot SHA, remote, or dirty state",async()=>{
  let launched=0;
  const fixture=installation();
  for(const status of [
    {currentSha:A,targetSha:"A".repeat(40),dirty:false,remoteCanonical:true},
    {currentSha:A,targetSha:A,dirty:false,remoteCanonical:true},
    {currentSha:A,targetSha:B,dirty:true,remoteCanonical:true},
    {currentSha:A,targetSha:B,dirty:false,remoteCanonical:false},
    {currentSha:"f".repeat(39),targetSha:B,dirty:false,remoteCanonical:true},
    {currentSha:A,targetSha:B,dirty:false,remoteCanonical:true,state:"diverged"},
    {currentSha:A,targetSha:B,dirty:false,remoteCanonical:true,state:"unavailable"},
  ]){
    const controller=createEquinoxLocalMainApplyController({
      installation:fixture,
      discovery:discovery({checkSupported:true,state:"behind",...status}),
      applyImpl:async()=>{launched++;throw Error("must not schedule");},
    });
    assert.equal(controller.snapshot().applyAvailable,false);
    await assert.rejects(controller.apply(),/newer eligible target/u);
  }
  assert.equal(launched,0);
});

test("scheduled Main update reads exact failed detached receipt and stops misleading Restarting display", async () => {
  const tx = `main-${"1".repeat(32)}`;
  const options = { installation:installation(), discovery:discovery({checkSupported:true,state:"behind",currentSha:A,targetSha:B,dirty:false,remoteCanonical:true}) };
  let receipt = {transactionId:tx,currentSha:A,targetSha:B,status:"promoting",stage:"ready_to_switch",lastError:null};
  const c = createEquinoxLocalMainApplyController({...options,
    applyImpl:async()=>({status:"scheduled",transactionId:tx,targetSha:B}),
    readScheduledReceiptImpl:async({transactionId})=>{assert.equal(transactionId,tx);return receipt;},
  });
  await c.apply();
  assert.equal((await c.reconcile()).restartScheduledFor,B);
  receipt={...receipt,status:"failed",stage:"native_admission_failed",lastError:"Missing independent supervisor"};
  const after=await c.reconcile();
  assert.equal(after.restartScheduledFor,null);
  assert.match(after.applyError,/native_admission_failed.*independent supervisor/u);
  assert.equal(after.applyAvailable,false);
  c.resetError();
  assert.equal(c.snapshot().applyAvailable,true);
});

test("Main scheduled receipt status cannot be cleared by missing, foreign or still-active receipts",async()=>{
  const tx=`main-${"2".repeat(32)}`;
  let receipt={transactionId:tx,currentSha:A,targetSha:B,status:"promoting",stage:"ready_to_switch",lastError:null};
  const c=createEquinoxLocalMainApplyController({installation:installation(),discovery:discovery({checkSupported:true,state:"behind",currentSha:A,targetSha:B,dirty:false,remoteCanonical:true}),
    applyImpl:async()=>({status:"scheduled",transactionId:tx,targetSha:B}),
    readScheduledReceiptImpl:async()=>receipt,
  });
  await c.apply();
  for(const modified of [{...receipt,transactionId:`main-${"3".repeat(32)}`,status:"failed"}, {...receipt,currentSha:"c".repeat(40),status:"failed"}]){
    receipt=modified;
    assert.equal((await c.reconcile()).restartScheduledFor,B);
    assert.equal(c.snapshot().applyError,null);
  }
  receipt={...receipt,transactionId:tx,currentSha:A,status:"succeeded",stage:"healthy"};
  assert.equal((await c.reconcile()).restartScheduledFor,null);
  assert.equal(c.snapshot().applyError,null);
});
