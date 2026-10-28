import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {scheduleEquinoxLocalSignedNativeMacInstaller} from "../../src/equinox-local-signed-main-installer-handoff.js";

const SHA="a".repeat(40),DIGEST="c".repeat(64);
async function fixture(t){
  const homeDir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"equinox-native-main-ui-")));
  t.after(()=>fs.rm(homeDir,{recursive:true,force:true}));
  const installRoot=path.join(homeDir,"Library","Application Support","Equinox Local");
  const mainTransactionRoot=path.join(installRoot,"main-update");
  const target="darwin-"+(process.arch==="arm64"?"arm64":"x64");
  const releaseDir=path.join(mainTransactionRoot,"native-store",target,SHA,"release");
  const script=path.join(releaseDir,"scripts","install-equinox-local.sh");
  const selector=path.join(path.dirname(releaseDir),"signed-selector.json");
  await fs.mkdir(path.dirname(script),{recursive:true,mode:0o700});
  await fs.writeFile(script,"#!/bin/bash\nexit 0\n",{mode:0o700});
  await fs.writeFile(selector,JSON.stringify({sourceSha:SHA,pad:"x".repeat(250)}),{mode:0o600});
  const installation={kind:"managed-main",platform:"darwin",arch:target.slice(7),target,
    sourceSha:SHA,mainNativeSha:SHA,installRoot,releaseDir,mainTransactionRoot};
  const events=[];
  const params={
    installation,homeDir,sourceEnv:{USER:"test",LOGNAME:"test"},
    inspectStoredImpl:async()=>({
      releaseDir,sourceSha:SHA,target,runtimeContractSha256:DIGEST,payloadVersion:"6.2.0",
      manifest:{artifactSha256:"d".repeat(64),artifactBytes:42},
    }),
    readPointerImpl:async()=>({sourceSha:SHA,target,runtimeContractSha256:DIGEST,releaseDir}),
    verifyPointerImpl:()=>({
      sourceSha:SHA,version:"6.2.0",
      targets:[{target,runtimeContractSha256:DIGEST,
        artifact:{sha256:"d".repeat(64),bytes:42}}],
    }),
    launchHelperImpl:async args=>{
      events.push(args);
      assert.equal(args.command,"/bin/bash");
      assert.deepEqual(args.args,[script,"--activate-main"]);
      assert.equal(args.options.cwd,releaseDir);
      assert.equal(args.options.detached,true);
      assert.equal(args.options.env.HOME,homeDir);
      assert.deepEqual(Object.keys(args.options.env).sort(),["HOME","LOGNAME","PATH","TMPDIR","USER"]);
      assert.equal(args.options.stdio[1],args.options.stdio[2]);
      return {};
    },
  };
  return {params,installation,script,selector,homeDir,mainTransactionRoot,events};
}

test("managed native Main Control Center handoff spawns ONLY the original SHA-owned external .sh with a private log",async t=>{
  const f=await fixture(t);
  const result=await scheduleEquinoxLocalSignedNativeMacInstaller(f.params);
  assert.equal(result.scheduled,true);
  assert.equal(result.handoff,"original-signed-main-shell");
  assert.match(result.requestId,/^main-[0-9a-f]{32}$/u);
  assert.equal(f.events.length,1);
  const log=await fs.lstat(result.logPath);
  assert.equal(log.mode&0o777,0o600);
  assert.equal(log.isFile(),true);
  assert.equal(log.nlink,1);
  assert.equal(path.dirname(result.logPath),path.join(f.mainTransactionRoot,"handoff"));
});

test("native Main handoff never spawns for a foreign current SHA or already active transaction",async t=>{
  const f=await fixture(t);
  await assert.rejects(scheduleEquinoxLocalSignedNativeMacInstaller({...f.params,
    installation:{...f.installation,mainNativeSha:"b".repeat(40)},
  }),/exact installed signed Mac SHA/u);
  await fs.writeFile(path.join(f.mainTransactionRoot,"active.json"),"{}",{mode:0o600});
  await assert.rejects(scheduleEquinoxLocalSignedNativeMacInstaller(f.params),
    /transaction is already active/u);
  assert.equal(f.events.length,0);
});

test("native Main handoff rejects altered original script, wrong signed selector and pointer contract BEFORE spawn",async t=>{
  const f=await fixture(t);
  await fs.rm(f.script);
  await fs.symlink("/bin/bash",f.script);
  await assert.rejects(scheduleEquinoxLocalSignedNativeMacInstaller(f.params),
    /installer is not an owned, unchanged release file/u);
  await fs.rm(f.script);
  await fs.writeFile(f.script,"#!/bin/bash\n",{mode:0o600});
  await assert.rejects(scheduleEquinoxLocalSignedNativeMacInstaller({...f.params,
    verifyPointerImpl:()=>{throw Error("original Ed25519 invalid")},
  }),/original Ed25519 invalid/u);
  await assert.rejects(scheduleEquinoxLocalSignedNativeMacInstaller({...f.params,
    readPointerImpl:async()=>({sourceSha:"f".repeat(40),target:f.installation.target,
      runtimeContractSha256:DIGEST,releaseDir:f.installation.releaseDir}),
  }),/Current signed Main native SHA pointer/u);
  assert.equal(f.events.length,0);
});

test("native Main handoff refuses an unauthenticated foreign or mutable release and keeps user data unchanged",async t=>{
  const f=await fixture(t);
  const userFile=path.join(f.mainTransactionRoot,"preserve-user-data");
  await fs.writeFile(userFile,"saved",{mode:0o600});
  for(const invalid of [
    {...f.params,inspectStoredImpl:async()=>({...await f.params.inspectStoredImpl(),
      runtimeContractSha256:"f".repeat(64)})},
    {...f.params,installation:{...f.installation,releaseDir:f.homeDir}},
    {...f.params,installation:{...f.installation,kind:"managed-source"}},
  ]){
    await assert.rejects(scheduleEquinoxLocalSignedNativeMacInstaller(invalid));
  }
  assert.equal(f.events.length,0);
  assert.equal(await fs.readFile(userFile,"utf8"),"saved");
});


test("real macOS detached Bash execution uses only the isolated original-script argument and private per-request log",async t=>{
  const f=await fixture(t);
  await fs.writeFile(f.script,"#!/bin/bash\nprintf 'SAFE_TEMP_EXEC %s\\n' \"$1\"\nexit 0\n",{mode:0o700});
  const {launchHelperImpl,...args}=f.params;
  const receipt=await scheduleEquinoxLocalSignedNativeMacInstaller(args);
  assert.equal(receipt.scheduled,true);
  let result="";
  for(let i=0;i<40;i++){
    result=await fs.readFile(receipt.logPath,"utf8");
    if(result.includes("SAFE_TEMP_EXEC"))break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(result.trim(),"SAFE_TEMP_EXEC --activate-main");
  assert.equal((await fs.lstat(receipt.logPath)).mode&0o777,0o600);
});
