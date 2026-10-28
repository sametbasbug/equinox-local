import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {repairEquinoxLocalSignedMainMacRuntime,recoverEquinoxLocalSignedMainMacRepair} from "../../src/equinox-local-signed-main-repair.js";
import {recoverAbandonedSignedMainMacAdmission} from "../../src/equinox-local-first-install.js";
import {beginEquinoxLocalSignedNativeMacOwner,writeEquinoxLocalMainNativeRecoveryDescriptor,
  writeEquinoxLocalSignedNativeMacReceipt} from "../../src/equinox-local-main-native-recovery.js";
import {resolveEquinoxLocalInstallation} from "../../src/equinox-local-installation.js";
import {launchAgentPlist,EQUINOX_LOCAL_LAUNCH_AGENT_LABEL} from "../../src/equinox-local-bootstrap.js";
import {equinoxLocalAppExecutablePath} from "../../src/equinox-local-app-host.js";

const SHA="a".repeat(40),CONTRACT="c".repeat(64);
async function fixture(t){
 const homeDir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"equinox-repair-native-")));
 t.after(()=>fs.rm(homeDir,{recursive:true,force:true}));
 const arch=process.arch==="arm64"?"arm64":"x64",target="darwin-"+arch;
 const installRoot=path.join(homeDir,"Library","Application Support","Equinox Local");
 const transactionRoot=path.join(installRoot,"main-update");
 const releaseDir=path.join(transactionRoot,"native-store",target,SHA,"release");
 await fs.mkdir(releaseDir,{recursive:true,mode:0o700});
 await fs.symlink(path.relative(installRoot,releaseDir),path.join(installRoot,"current"));
 const agentPath=path.join(homeDir,"Library","LaunchAgents",EQUINOX_LOCAL_LAUNCH_AGENT_LABEL+".plist");
 await fs.mkdir(path.dirname(agentPath),{recursive:true,mode:0o700});
 await fs.writeFile(agentPath,launchAgentPlist({homeDir,installRoot}),{mode:0o600});
 const events=[];
 let healthCalls=0;
 const inspection=Object.freeze({
  action:"verify_or_repair",target,sourceSha:SHA,version:"6.2.1",
  runtimeContractSha256:CONTRACT,transactionRoot,releaseDir,
  previousKind:"main",previousSha:SHA,previousVersion:null,previousReleaseDir:releaseDir,
 });
 const initial={schemaVersion:1,channel:"main",sourceSha:SHA,target,
  runtimeContractSha256:CONTRACT,payloadVersion:"6.2.1",releaseDir};
 const execFileImpl=async(_file,args)=>{
  events.push(args.join(" "));
  if(args[0]==="print"&&args[1]==="gui/"+process.getuid())return {stdout:"domain owned"};
  if(args[0]==="print")return {stdout:"state=running\nprogram="+equinoxLocalAppExecutablePath(homeDir)};
  if(args[0]==="kickstart"||args[0]==="bootstrap")return {stdout:""};
  throw Error("unexpected launchctl operation");
 };
 const opts={
  signedPointer:{signed:"ephemeral fixture"},homeDir,platform:"darwin",arch,
  uid:process.getuid(),transactionId:"main-"+"f".repeat(32),
  inspectImpl:async()=>inspection,
  verifyPointerImpl:()=>({sourceSha:SHA,version:"6.2.1",targets:[{target,runtimeContractSha256:CONTRACT}]}),
  readPointerImpl:async()=>initial,
  assertAppImpl:async({homeDir:home,releaseDir:release})=>{
   assert.equal(home,homeDir);assert.equal(release,releaseDir);events.push("signed apphost verified");
   return {owned:true};
  },
  execFileImpl,
  verifyHealthImpl:async()=>{healthCalls++;return healthCalls>1},
 };
 return {opts,events,homeDir,transactionRoot,releaseDir,agentPath,getHealthCalls:()=>healthCalls,inspection};
}

test("signed native SAME-SHA unhealthy service restart uses exclusive original owner, then exact health and terminal release",async t=>{
 const f=await fixture(t);
 const result=await repairEquinoxLocalSignedMainMacRuntime(f.opts);
 assert.equal(result.status,"repaired");
 assert.equal(result.sourceSha,SHA);
 assert.equal(result.transactionId,f.opts.transactionId);
 assert.equal(f.getHealthCalls(),2);
 assert.equal(f.events.filter(v=>v.startsWith("kickstart ")).length,1);
 assert.equal(f.events.filter(v=>v==="signed apphost verified").length,3);
 assert.equal(await fs.realpath(path.join(f.homeDir,"Library","Application Support","Equinox Local","current")),f.releaseDir);
 await assert.rejects(fs.lstat(path.join(f.transactionRoot,"active.json")),{code:"ENOENT"});
 const receipt=JSON.parse(await fs.readFile(path.join(f.transactionRoot,"receipts",f.opts.transactionId+".signed-native.json"),"utf8"));
 assert.equal(receipt.status,"healthy");
});

test("same-SHA healthy installation does not acquire owner or restart launchd",async t=>{
 const f=await fixture(t);
 const result=await repairEquinoxLocalSignedMainMacRuntime({...f.opts,verifyHealthImpl:async()=>true});
 assert.equal(result.status,"already_healthy");
 assert.equal(f.events.some(v=>v.startsWith("kickstart")),false);
 await assert.rejects(fs.lstat(path.join(f.transactionRoot,"active.json")),{code:"ENOENT"});
});

test("same-SHA unhealthy after bounded original-service restart retains activating owner instead of a fake rollback",async t=>{
 const f=await fixture(t);
 await assert.rejects(repairEquinoxLocalSignedMainMacRuntime({...f.opts,
  verifyHealthImpl:async()=>false,
 }),/original native owner remains locked/u);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.transactionRoot,"active.json"),"utf8")).sourceSha,SHA);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.transactionRoot,"receipts",f.opts.transactionId+".signed-native.json"),"utf8")).status,"activating");
 assert.equal(await fs.realpath(path.join(f.homeDir,"Library","Application Support","Equinox Local","current")),f.releaseDir);
 assert.equal(f.events.filter(v=>v.startsWith("kickstart")).length,1);
});

test("same-SHA repair fails closed for foreign LaunchAgent, current link and active competing native transaction before restart",async t=>{
 const f=await fixture(t);
 await fs.writeFile(f.agentPath,"foreign user plist",{mode:0o600});
 await assert.rejects(repairEquinoxLocalSignedMainMacRuntime(f.opts),/LaunchAgent differs/u);
 assert.equal(f.events.filter(v=>v.startsWith("kickstart")).length,0);
 await fs.writeFile(f.agentPath,launchAgentPlist({homeDir:f.homeDir,
  installRoot:path.dirname(f.transactionRoot)}),{mode:0o600});
 const link=path.join(f.homeDir,"Library","Application Support","Equinox Local","current");
 await fs.unlink(link);
 await fs.symlink(f.homeDir,link);
 await assert.rejects(repairEquinoxLocalSignedMainMacRuntime(f.opts),/current symlink changed/u);
 assert.equal(f.events.filter(v=>v.startsWith("kickstart")).length,0);
 await fs.unlink(link);
 await fs.symlink(path.relative(path.dirname(link),f.releaseDir),link);
 await fs.writeFile(path.join(f.transactionRoot,"active.json"),"foreign active transaction",{mode:0o600});
 await assert.rejects(repairEquinoxLocalSignedMainMacRuntime(f.opts),/EEXIST|exist/u);
 assert.equal(f.events.filter(v=>v.startsWith("kickstart")).length,0);
});

test("same-SHA repair refuses loaded foreign launchd service and preserves original A pointer",async t=>{
 const f=await fixture(t);
 await assert.rejects(repairEquinoxLocalSignedMainMacRuntime({...f.opts,
  execFileImpl:async(_file,args)=>{
   if(args[0]==="print")return {stdout:"program=/Applications/Foreign.app"};
   assert.fail("foreign launchd must not be restarted");
  },
 }),/original native owner remains locked/u);
 assert.equal(f.events.filter(v=>v.startsWith("kickstart")).length,0);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.transactionRoot,"active.json"),"utf8")).sourceSha,SHA);
});

test("same-SHA repair rechecks signed pointer identity before LaunchAgent mutation",async t=>{
 const f=await fixture(t);
 let calls=0;
 await assert.rejects(repairEquinoxLocalSignedMainMacRuntime({...f.opts,
  inspectImpl:async()=>{calls++;return calls>1
   ? {...f.inspection,sourceSha:"b".repeat(40)}
   : f.inspection;},
 }),/changed after same-SHA repair lock/u);
 assert.equal(f.events.filter(v=>v.startsWith("kickstart")).length,0);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.transactionRoot,"active.json"),"utf8")).sourceSha,SHA);
});


async function admittedRepairFixture(t,status="activating"){
 const f=await fixture(t);
 const {homeDir,transactionRoot,releaseDir,opts}=f;
 const installation=resolveEquinoxLocalInstallation({
  homeDir,platform:"darwin",arch:opts.arch,
  env:{EQUINOX_LOCAL_INSTALL_ROOT:path.dirname(transactionRoot),
       EQUINOX_LOCAL_RELEASE_DIR:releaseDir},
 });
 assert.equal(installation.releaseDir,releaseDir);
 const pointer={schemaVersion:1,channel:"main",sourceSha:SHA,
  target:"darwin-"+opts.arch,runtimeContractSha256:CONTRACT,
  releaseDir,payloadVersion:"6.2.1"};
 await writeEquinoxLocalMainNativeRecoveryDescriptor({
  transactionRoot,transactionId:opts.transactionId,
  transition:{mode:"artifact_required",target:pointer.target,
   targetSha:SHA,targetRuntimeContractSha256:CONTRACT},
  previousPointer:pointer,installation,
 });
 const owner={transactionRoot,transactionId:opts.transactionId,
  sourceSha:SHA,target:pointer.target,runtimeContractSha256:CONTRACT};
 await beginEquinoxLocalSignedNativeMacOwner({...owner,uid:process.getuid()});
 if(status==="activating")await writeEquinoxLocalSignedNativeMacReceipt({...owner,status:"activating"});
 // The original signed pointer remains PRIVATE inside the immutable store.
 const selector=path.join(path.dirname(releaseDir),"signed-selector.json");
 await fs.writeFile(selector,JSON.stringify({sourceSha:SHA,
  enoughContent:"x".repeat(250)}),{mode:0o600});
 return {...f,owner,selector};
}

test("crashed SAME-SHA activating repair can release original owner only after intact original A becomes healthy",async t=>{
 const f=await admittedRepairFixture(t);
 const result=await recoverEquinoxLocalSignedMainMacRepair({
  ...f.opts,verifyHealthImpl:async()=>true,
 });
 assert.equal(result.status,"repaired");
 assert.equal(result.recovered,true);
 await assert.rejects(fs.lstat(path.join(f.transactionRoot,"active.json")),{code:"ENOENT"});
 assert.equal(JSON.parse(await fs.readFile(path.join(f.transactionRoot,"receipts",f.opts.transactionId+".signed-native.json"),"utf8")).status,"healthy");
});

test("same-SHA admitted repair crash requires exact signed healthy runtime before advancing durable receipt",async t=>{
 const f=await admittedRepairFixture(t,"admitted");
 await assert.rejects(recoverEquinoxLocalSignedMainMacRepair({...f.opts,
  verifyHealthImpl:async()=>false,
 }),/remains unhealthy/u);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.transactionRoot,"receipts",f.opts.transactionId+".signed-native.json"),"utf8")).status,"admitted");
 const result=await recoverEquinoxLocalSignedMainMacRepair({...f.opts,
  verifyHealthImpl:async()=>true,
 });
 assert.equal(result.recovered,true);
 await assert.rejects(fs.lstat(path.join(f.transactionRoot,"active.json")),{code:"ENOENT"});
});

test("same-SHA time-out can recover later full-SHA health WITHOUT another restart",async t=>{
 const f=await fixture(t);
 await assert.rejects(repairEquinoxLocalSignedMainMacRuntime({...f.opts,
  verifyHealthImpl:async()=>false,
 }),/owner remains locked/u);
 assert.equal(f.events.filter(v=>v.startsWith("kickstart ")).length,1);
 const result=await recoverEquinoxLocalSignedMainMacRepair({...f.opts,verifyHealthImpl:async()=>true});
 assert.equal(result.recovered,true);
 assert.equal(f.events.filter(v=>v.startsWith("kickstart ")).length,1);
 await assert.rejects(fs.lstat(path.join(f.transactionRoot,"active.json")),{code:"ENOENT"});
 assert.equal(JSON.parse(await fs.readFile(path.join(f.transactionRoot,"receipts",
  f.opts.transactionId+".signed-native.json"),"utf8")).status,"healthy");
});

test("same-SHA recovery rejects foreign current link, mismatched descriptor and a claimed rollback failure",async t=>{
 const f=await admittedRepairFixture(t);
 const link=path.join(path.dirname(f.transactionRoot),"current");
 await fs.unlink(link);
 await fs.symlink(f.homeDir,link);
 await assert.rejects(recoverEquinoxLocalSignedMainMacRepair({...f.opts,
  verifyHealthImpl:async()=>true,
 }),/original native pointers were modified/u);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.transactionRoot,"active.json"),"utf8")).sourceSha,SHA);
 await fs.unlink(link);
 await fs.symlink(path.relative(path.dirname(link),f.releaseDir),link);
 await writeEquinoxLocalSignedNativeMacReceipt({...f.owner,status:"rolling_back"});
 await writeEquinoxLocalSignedNativeMacReceipt({...f.owner,status:"rollback_failed"});
 await assert.rejects(recoverEquinoxLocalSignedMainMacRepair({...f.opts,
  verifyHealthImpl:async()=>true,
 }),/cannot be automatically cleared/u);
 assert.equal(JSON.parse(await fs.readFile(path.join(f.transactionRoot,"active.json"),"utf8")).sourceSha,SHA);
});

test("existing original --recover-main dispatches same SHA repair receipt to same original Ed25519/health recovery instead of A->B cancellation",async t=>{
 const f=await admittedRepairFixture(t);
 let invoked=0;
 const result=await recoverAbandonedSignedMainMacAdmission({
  transactionId:f.opts.transactionId,homeDir:f.homeDir,
  platform:"darwin",arch:f.opts.arch,uid:process.getuid(),
  inspectImpl:f.opts.inspectImpl,
  verifyPointerImpl:f.opts.verifyPointerImpl,
  recoverRepairImpl:async input=>{
   invoked++;
   assert.equal(input.transactionId,f.opts.transactionId);
   assert.equal(input.homeDir,f.homeDir);
   assert.equal(input.signedPointer.sourceSha,SHA);
   return {status:"repaired",recovered:true};
  },
  proveAbsentImpl:async()=>assert.fail("sameSHA repair has no detached B worker to prove absent"),
 });
 assert.equal(invoked,1);
 assert.deepEqual(result,{status:"repaired",recovered:true});
 assert.equal(JSON.parse(await fs.readFile(path.join(f.transactionRoot,"active.json"),"utf8")).sourceSha,SHA,
  "mocked recovery does not release original owner");
});
