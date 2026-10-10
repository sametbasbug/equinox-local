import assert from "node:assert/strict";
import test from "node:test";
import { readVerifiedBridgeSourceIdentity, bridgeActivatedStableToMain } from "../../src/equinox-local-stable-main-bridge.js";

const SHA = "e".repeat(40);
const targetVersion = "6.0.4";
const install = (platform = "win32", arch = platform === "win32" ? "x64" : "arm64") => ({
  kind: "managed", managed: true, selfUpdateSupported: true, platform, arch,
  target: `${platform}-${arch}`,
  releaseDir: platform === "win32" ? String.raw`C:\Users\Example\AppData\Local\Equinox Local\releases\6.0.4` : "/Users/example/Library/Application Support/Equinox Local/releases/6.0.4",
});
const identity = (installation) => ({sourceSha: SHA, releaseDir: installation.releaseDir});
const opts = ({platform = "win32", arch = platform === "win32" ? "x64" : "arm64", overrides = {}} = {}) => {
  const steps = [];
  const installation = install(platform,arch);
  return {
    steps, installation,
    options: {
      installation, version: targetVersion, homeDir: platform === "win32" ? String.raw`C:\Users\Example` : "/Users/example", env: {},
      inspectInstallationImpl: async () => ({kind:"managed"}),
      readIdentityImpl: async (i, v) => {steps.push("identity");assert.equal(v,targetVersion);return identity(i);},
      enrollImpl: async (args) => {steps.push("enroll");assert.equal(args.bootstrapSha,SHA);assert.equal(args.target,installation.target);return {status:"enrolled",bootstrapSha:SHA};},
      restartImpl: async () => {steps.push("restart");},
      waitForMainImpl: async (v, sha,budget) => {steps.push("main healthy"); assert.equal(v,targetVersion);assert.equal(sha,SHA);assert.deepEqual(budget,{attempts:platform==="win32"?180:120,delayMs:500});},
      rollbackImpl: async (args) => {steps.push("rollback");assert.equal(args.bootstrapSha,SHA);return {rolledBack:true};},
      waitForStableImpl: async (v,budget) => {steps.push("stable healthy");assert.equal(v,targetVersion);assert.deepEqual(budget,{attempts:platform==="win32"?180:120,delayMs:500});},
      ...overrides,
    },
  };
};

test("bridge verifies exact active source version and target, forbids unowned release metadata", async () => {
  const installation = install("win32");
  const base = {
    readCurrentImpl: async () => ({ version:targetVersion,releaseDir:installation.releaseDir }),
    fsImpl: {open:async () => ({stat:async () => ({isFile:()=>true,size:180}),readFile:async () => JSON.stringify({version:targetVersion,target:installation.target,sourceSha:SHA}),close:async()=>{}})},
  };
  assert.deepEqual(await readVerifiedBridgeSourceIdentity(installation,targetVersion,base),identity(installation));
  await assert.rejects(readVerifiedBridgeSourceIdentity(installation,"6.0.5",base),/nonactive/u);
  await assert.rejects(readVerifiedBridgeSourceIdentity(installation,targetVersion,{ ...base,fsImpl:{ open:async () => ({stat:async () => ({isFile:()=>true,size:180}),readFile:async () => JSON.stringify({version:targetVersion,target:installation.target,sourceSha:"INVALID"}),close:async()=>{}}) }}),/matching, exact/u);
  await assert.rejects(readVerifiedBridgeSourceIdentity(installation,targetVersion,{ ...base,fsImpl:{ open:async () => ({stat:async () => ({isFile:()=>false,size:200}),readFile:async()=>assert.fail("must not read unsafe metadata"),close:async()=>{}}) }}),/unsafe/u);
});

test("after health, Windows bridge enrolls exact signed source, then restarts and verifies managed Main", async () => {
  const {steps,options} = opts();
  const res=await bridgeActivatedStableToMain(options);
  assert.deepEqual(res,{status:"main-activated",sourceSha:SHA});
  assert.deepEqual(steps,["identity","enroll","restart","main healthy"]);
});

test("macOS bridge follows the same guarded source and post-restart health contract", async () => {
  const {steps,options} = opts({platform:"darwin",overrides:{enrollImpl:async (args)=>{
    steps.push("enroll");assert.equal(Object.hasOwn(args,"windowsZipHelperPath"),false);assert.equal(args.platform,"darwin");return {status:"enrolled",bootstrapSha:SHA};
  }}});
  assert.equal((await bridgeActivatedStableToMain(options)).status,"main-activated");
  assert.deepEqual(steps,["identity","enroll","restart","main healthy"]);
});

test("one-time bridge honors all four native platform/arch identities without changing credentials", async () => {
  for (const [platform,arch] of [["win32","x64"],["win32","arm64"],["darwin","arm64"],["darwin","x64"]]) {
    const {steps,options}=opts({platform,arch,overrides:{enrollImpl:async ({platform:p,arch:a,target:t,bootstrapSha,...rest}) => {
      steps.push("enroll");
      assert.equal(p,platform);
      assert.equal(a,arch);
      assert.equal(t,`${platform}-${arch}`);
      assert.equal(bootstrapSha,SHA);
      assert.equal(rest.env.EQUINOX_LOCAL_RUNTIME_KEY, "should-stay-untouched");
      return {status:"enrolled",bootstrapSha:SHA};
    }}});
    options.env = { EQUINOX_LOCAL_RUNTIME_KEY:"should-stay-untouched" };
    assert.equal((await bridgeActivatedStableToMain(options)).status,"main-activated");
    assert.deepEqual(steps,["identity","enroll","restart","main healthy"]);
  }
});

test("already-enrolled Main install is idempotent and never changed to Stable", async () => {
  const {steps,options} = opts({overrides:{inspectInstallationImpl:async () => ({kind:"managed-source",sourceSha:SHA})}});
  assert.deepEqual(await bridgeActivatedStableToMain(options),{status:"already-enrolled",sourceSha:SHA});
  assert.deepEqual(steps,[]);
});

test("Main health failure restores the signed Stable runtime through guarded rollback and restart", async () => {
  const {steps,options} = opts({overrides:{waitForMainImpl:async () => {steps.push("main unhealthy");throw Error("fixture key must not be printed");}}});
  await assert.rejects(bridgeActivatedStableToMain(options), /signed Stable baseline was restored/u);
  assert.deepEqual(steps,["identity","enroll","restart","main unhealthy","rollback","restart","stable healthy"]);
});

test("failure to create source enrollment never mutates native shell or restarts the stable runtime", async () => {
  const {steps,options}=opts({overrides:{enrollImpl:async()=>{steps.push("enroll failed");throw Error("fixture secret must not leak");},rollbackImpl:async()=>{steps.push("rollback");return {rolledBack:false};}}});
  await assert.rejects(bridgeActivatedStableToMain(options),/signed Stable baseline remains installed/u);
  assert.deepEqual(steps,["identity","enroll failed","rollback"]);
});

test("failed rollback never claims healthy Stable and does not disclose enrollment errors", async () => {
  const {steps,options}=opts({overrides:{waitForMainImpl:async()=>{steps.push("main bad");throw Error("test-private-secret");},rollbackImpl:async()=>{steps.push("rollback bad");throw Error("rollback-private-secret");}}});
  await assert.rejects(bridgeActivatedStableToMain(options),/Stable recovery needs attention/u);
  assert.deepEqual(steps,["identity","enroll","restart","main bad","rollback bad"]);
});
