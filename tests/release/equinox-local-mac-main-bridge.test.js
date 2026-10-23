import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { maybeScheduleMacStableMainBridge, runMacStableMainBridgeWorker } from "../../src/equinox-local-mac-main-bridge.js";

async function fixture(t) {
  const installRoot=await fs.mkdtemp(path.join(os.tmpdir(),"mac-main-bridge-"));
  t.after(()=>fs.rm(installRoot,{recursive:true,force:true}));
  const releasesRoot=path.join(installRoot,"releases");
  await fs.mkdir(releasesRoot);
  const current=path.join(releasesRoot,"6.0.4");
  await fs.mkdir(current);
  const installation={platform:"darwin",arch:"arm64",kind:"managed",managed:true,selfUpdateSupported:true,
    target:"darwin-arm64",installRoot,releasesRoot,releaseDir:current};
  return {installation,installRoot,releasesRoot,current};
}

test("macOS Stable first install never races public installer's own Main enrollment",async(t)=>{
  const f=await fixture(t);
  const result=await maybeScheduleMacStableMainBridge({installation:f.installation,platform:"darwin",
    launchHelperImpl:async()=>assert.fail("First install must not spawn a second bridge")});
  assert.deepEqual(result,{scheduled:false,reason:"first-install"});
});

test("old macOS updater activation spawns the NEW signed helper with minimal env and only once",async(t)=>{
  const f=await fixture(t);
  await fs.mkdir(path.join(f.releasesRoot,"6.0.3"));
  await fs.writeFile(path.join(f.installRoot,"update-state.json"),JSON.stringify({status:"activated",version:"6.0.3"}));
  const calls=[];
  const result=await maybeScheduleMacStableMainBridge({installation:f.installation,platform:"darwin",nodePath:"/owned/node",
    env:{HOME:"/Users/test",EQUINOX_LOCAL_RUNTIME_KEY:"never-leak",PATH:"/untrusted"},
    launchHelperImpl:async(args)=>calls.push(args),
  });
  assert.equal(result.scheduled,true);
  assert.equal(calls.length,1);
  assert.equal(calls[0].command,"/owned/node");
  assert.deepEqual(calls[0].args,[path.join(f.current,"equinox-local-update-helper.js"),"--bridge-after-upgrade","6.0.4"]);
  assert.deepEqual(calls[0].options.env,{
    HOME:"/Users/test",PATH:"/usr/bin:/bin:/usr/sbin:/sbin",EQUINOX_LOCAL_INSTALL_ROOT:f.installRoot,EQUINOX_LOCAL_RELEASE_DIR:f.current,
  });
  await fs.writeFile(path.join(f.installRoot,"update-state.json"),JSON.stringify({status:"activated",version:"6.0.4"}));
  const fastActivation=await maybeScheduleMacStableMainBridge({installation:f.installation,platform:"darwin",launchHelperImpl:async()=>calls.push({fast:true})});
  assert.equal(fastActivation.scheduled,true);
  await fs.writeFile(path.join(f.installRoot,"main-bridge-6.0.4.json"),JSON.stringify({schemaVersion:1,version:"6.0.4",status:"attempted"}));
  const again=await maybeScheduleMacStableMainBridge({installation:f.installation,platform:"darwin",launchHelperImpl:async()=>assert.fail("Existing receipt prevents another bridge")});
  assert.equal(again.scheduled,false);
});

test("Mac signed bridge worker waits for old updater's completed Stable activation",async(t)=>{
  const f=await fixture(t);
  const calls=[];
  let slept=0;
  await fs.writeFile(path.join(f.installRoot,"update-state.json"),JSON.stringify({status:"activated",version:"6.0.3"}));
  const result=await runMacStableMainBridgeWorker({installation:f.installation,version:"6.0.4",homeDir:"/Users/test",
    sleepImpl:async(ms)=>{calls.push("wait:"+ms);slept++;if(slept===1)await fs.writeFile(path.join(f.installRoot,"update-state.json"),JSON.stringify({status:"activated",version:"6.0.4",previousVersion:"6.0.3"}));},
    bridgeImpl:async({installation,version})=>{calls.push("bridge:"+version);assert.equal(installation,f.installation);return {status:"main-activated"};},
  });
  assert.deepEqual(result,{status:"main-activated"});
  assert.deepEqual(calls,["wait:1000","bridge:6.0.4"]);
  const marker=JSON.parse(await fs.readFile(path.join(f.installRoot,"main-bridge-6.0.4.json"),"utf8"));
  assert.deepEqual(marker,{schemaVersion:1,version:"6.0.4",status:"main-activated"});
  const duplicate=await runMacStableMainBridgeWorker({installation:f.installation,version:"6.0.4",bridgeImpl:async()=>assert.fail("Duplicate must not bridge")});
  assert.equal(duplicate.status,"already-attempted");
});

test("Mac worker fails closed when Stable activation rolled back and leaves no attempt marker",async(t)=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.installRoot,"update-state.json"),JSON.stringify({status:"rolled-back",version:"6.0.3"}));
  const result=await runMacStableMainBridgeWorker({installation:f.installation,version:"6.0.4",sleepImpl:async()=>{},bridgeImpl:async()=>assert.fail("must never bridge on rollback")});
  assert.equal(result.status,"not-activated");
  await assert.rejects(fs.lstat(path.join(f.installRoot,"main-bridge-6.0.4.json")),{code:"ENOENT"});
});

test("Mac bridge failure remains on signed Stable and attempt receipt blocks a restart loop",async(t)=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.installRoot,"update-state.json"),JSON.stringify({status:"activated",version:"6.0.4",previousVersion:"6.0.3"}));
  const result=await runMacStableMainBridgeWorker({installation:f.installation,version:"6.0.4",bridgeImpl:async()=>{throw Error("secret cannot leak");}});
  assert.equal(result.status,"stable-recovery-needs-attention");
  assert.equal(JSON.parse(await fs.readFile(path.join(f.installRoot,"main-bridge-6.0.4.json"),"utf8")).status,"stable-recovery-needs-attention");
});

test("Mac signed bridge rejects symlinked attempt receipt without touching foreign user data",async(t)=>{
  const f=await fixture(t);
  await fs.mkdir(path.join(f.releasesRoot,"6.0.3"));
  const foreign=path.join(f.installRoot,"foreign-owned.json");
  const privateBytes=JSON.stringify({privateToken:"never-read-or-replace"});
  await fs.writeFile(foreign,privateBytes);
  const receipt=path.join(f.installRoot,"main-bridge-6.0.4.json");
  await fs.symlink(foreign,receipt);
  await assert.rejects(maybeScheduleMacStableMainBridge({
    installation:f.installation,platform:"darwin",
    launchHelperImpl:async()=>assert.fail("symlink receipt must not spawn")
  }),{code:"ELOOP"});
  await fs.writeFile(path.join(f.installRoot,"update-state.json"),
    JSON.stringify({status:"activated",version:"6.0.4",previousVersion:"6.0.3"}));
  const result2=await runMacStableMainBridgeWorker({
    installation:f.installation,version:"6.0.4",bridgeImpl:async()=>assert.fail("receipt already owned")
  });
  assert.equal(result2.status,"already-attempted");
  assert.equal((await fs.lstat(receipt)).isSymbolicLink(),true);
  assert.equal(await fs.readFile(foreign,"utf8"),privateBytes);
});

test("Mac signed bridge refuses symlinked or oversized activation state before creating attempt marker",async(t)=>{
  const f=await fixture(t);
  const activation=path.join(f.installRoot,"update-state.json");
  const target=path.join(f.installRoot,"unrelated-user-data.json");
  await fs.writeFile(target,JSON.stringify({privateToken:"not-for-bridge"}));
  await fs.symlink(target,activation);
  await assert.rejects(runMacStableMainBridgeWorker({
    installation:f.installation,version:"6.0.4",
    bridgeImpl:async()=>assert.fail("must not read symlink data"),
    sleepImpl:async()=>{},
  }));
  await fs.unlink(activation);
  await fs.writeFile(activation,"x".repeat(4097));
  await assert.rejects(runMacStableMainBridgeWorker({
    installation:f.installation,version:"6.0.4",
    bridgeImpl:async()=>assert.fail("oversized update-state must not authorize bridge"),
    sleepImpl:async()=>{},
  }),/Stable migration state is unavailable or unsafe/u);
  await assert.rejects(fs.lstat(path.join(f.installRoot,"main-bridge-6.0.4.json")),{code:"ENOENT"});
  assert.equal(await fs.readFile(target,"utf8"),JSON.stringify({privateToken:"not-for-bridge"}));
});

test("Mac signed bridge allowlists outcome and never writes private error bytes into receipt",async(t)=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.installRoot,"update-state.json"),
    JSON.stringify({status:"activated",version:"6.0.4",previousVersion:"6.0.3"}));
  const result=await runMacStableMainBridgeWorker({
    installation:f.installation,version:"6.0.4",
    bridgeImpl:async()=>({status:"private-password-secret"}),
  });
  assert.deepEqual(result,{status:"stable-recovery-needs-attention"});
  const receipt=await fs.readFile(path.join(f.installRoot,"main-bridge-6.0.4.json"),"utf8");
  assert.equal(receipt,JSON.stringify({schemaVersion:1,version:"6.0.4",status:"stable-recovery-needs-attention"})+"\n");
  assert.doesNotMatch(receipt,/private-password-secret/u);
});
