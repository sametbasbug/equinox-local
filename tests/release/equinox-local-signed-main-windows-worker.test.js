import assert from "node:assert/strict";
import {createHmac,generateKeyPairSync} from "node:crypto";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import fs from "node:fs/promises";
import {collectManagedReleaseSourceFiles} from "../../scripts/release/package-managed-release.mjs";
import {startEquinoxWindowsMainWorkerProof} from "../../src/equinox-local-windows-main-worker-proof.js";
import test from "node:test";

import {
 inspectSignedWindowsNativeWorkerPreflight,
 runEquinoxLocalSignedWindowsNativeWorker,
} from "../../src/equinox-local-signed-main-windows-worker.js";
import {
 createSignedMainInstallPointer,validateSignedMainInstallPointer,
} from "../../src/equinox-local-main-install-pointer.js";

const SHA="b".repeat(40),A="a".repeat(40),CONTRACT="c".repeat(64);
const ID="main-"+ "f".repeat(32);
const target="win32-x64";
const env={LOCALAPPDATA:"C:\\Users\\Example\\AppData\\Local"};
const install=path.win32.join(env.LOCALAPPDATA,"Equinox Local");
const root=path.win32.join(install,"state","main-update");
const release=path.win32.join(root,"native-store",target,SHA,"release");
const workerPath=path.win32.join(release,"equinox-local-main-update-worker.js");
const nodePath=path.win32.join(release,"runtime","node","bin","node.exe");
const guardianPath=path.win32.join(install,"runtime","guardian","EquinoxLocalGuardian.exe");
const args=["--signed-native","--transaction-id",ID,"--transaction-root",root];

function fixture(){
 const calls=[];
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const keyId="ephemeral-windows-worker-unit";
 const signed=createSignedMainInstallPointer({
  sourceSha:SHA,version:"6.2.1",publishedAt:"2026-10-28T03:00:00.000Z",
  keyId,privateKey,
  nativeManifests:["darwin-arm64","darwin-x64","win32-arm64","win32-x64"].map(t=>({
   schemaVersion:1,channel:"main",sourceSha:SHA,target:t,runtimeContractSha256:CONTRACT,
   artifact:{name:"equinox-local-main-"+SHA+"-"+t+(t.startsWith("win32")?".zip":".tar.gz"),
    sha256:"d".repeat(64),bytes:12345},
  })),
 });
 const files=new Set([workerPath,nodePath,guardianPath]);
 const opts={
  argv:args,workerPath,nodePath,platform:"win32",arch:"x64",env,
  fsImpl:{
   lstat:async file=>{
    calls.push(["lstat",file]);if(!files.has(file))throw Error("foreign file "+file);
    return {isFile:()=>true,isSymbolicLink:()=>false,nlink:1};
   },
   realpath:async file=>file,
  },
  readDescriptorImpl:async input=>{
   calls.push(["descriptor",input]);
   return {targetSha:SHA,target,targetRuntimeContractSha256:CONTRACT,
    previous:{kind:"main",sourceSha:A,target,runtimeContractSha256:"f".repeat(64)}};
  },
  inspectStoredImpl:async input=>{
   calls.push(["stored",input]);
   return {sourceSha:SHA,target,releaseDir:release,runtimeContractSha256:CONTRACT,
    payloadVersion:"6.2.1",manifest:{artifactSha256:"d".repeat(64),artifactBytes:12345}};
  },
  readSelectorImpl:async (filename,options)=>{
   calls.push(["selector",filename]);
   assert.equal(filename,path.win32.join(root,"native-store",target,SHA,"signed-selector.json"));
   assert.equal(options.platform,"win32");
   return {data:JSON.stringify(signed)};
  },
  verifyPointerImpl:(raw,options)=>{
   calls.push(["sig",options]);
   return validateSignedMainInstallPointer(raw,{
    publicKeys:{[keyId]:publicKey.export({type:"spki",format:"pem"})},
    expectedSourceSha:options.expectedSourceSha,
   });
  },
  auditGuardianImpl:async input=>{
   calls.push(["guardian",input]);
   assert.equal(input.guardianPath,guardianPath);
   assert.equal(input.transactionId,ID);
   assert.equal(input.env.LOCALAPPDATA,env.LOCALAPPDATA);
  },
 };
 return {opts,calls,signed};
}

test("existing packaged worker's Windows signed-native preflight proves exact sourceSHA, target, signed selector, immutable B, original Guardian; NO OS mutation",async()=>{
 const f=fixture();
 const receipt=await inspectSignedWindowsNativeWorkerPreflight(f.opts);
 assert.deepEqual(receipt,{
  status:"guardian_os_handoff_required",transactionId:ID,sourceSha:SHA,target,
  version:"6.2.1",runtimeContractSha256:CONTRACT,
 });
 assert.deepEqual(f.calls.filter(x=>x[0]==="lstat").map(x=>x[1]),[workerPath,nodePath,guardianPath]);
 assert.deepEqual(f.calls.filter(x=>x[0]==="guardian").map(x=>x[1].guardianPath),[guardianPath]);
 assert.equal(f.calls.some(x=>x[0]==="stored"),true);
 assert.equal(f.calls.some(x=>x[0]==="sig"),true);
 assert.equal(f.calls.some(x=>x[0]==="write"||x[0]==="restart"),false);
});

test("same original worker performs fresh Guardian kernel/HMAC read-only audit, closes its pipe and STILL refuses A/B activation",async()=>{
 const f=fixture();
 let opened=0,closed=0,audits=0;
 await assert.rejects(runEquinoxLocalSignedWindowsNativeWorker({
  ...f.opts,env:{...env,EQUINOX_LOCAL_MAIN_WORKER_TOKEN:"e".repeat(64)},
  startProofImpl:async(input)=>{
   opened++;assert.equal(input.transactionId,ID);
   assert.equal(input.workerToken,"e".repeat(64));
   assert.equal(input.platform,"win32");
   return {close:async()=>{closed++;}};
  },
  auditProofImpl:async(input)=>{
   audits++;assert.equal(input.guardianPath,guardianPath);
   assert.equal(input.env.LOCALAPPDATA,env.LOCALAPPDATA);
  },
 }),/read-only Guardian kernel HMAC.*not authorized/u);
 assert.equal(opened,1);
 assert.equal(audits,1);
 assert.equal(closed,1);
 assert.equal(f.calls.filter(x=>x[0]==="guardian").length,1);
});

test("signed Windows native worker must NOT start OS pipe if WPF launch token absent/malformed",async()=>{
 const f=fixture();
 let opens=0;
 for(const token of [undefined,"x".repeat(64),"f".repeat(63),"F".repeat(64)]){
  await assert.rejects(runEquinoxLocalSignedWindowsNativeWorker({
   ...f.opts,env:{...env,...(token===undefined?{}:{EQUINOX_LOCAL_MAIN_WORKER_TOKEN:token})},
   startProofImpl:async()=>{opens++;throw Error("unexpected pipe launch");},
  }),/WPF-issued launch token/u);
 }
 assert.equal(opens,0);
});

test("signed Windows Guardian HMAC failure MUST close the live worker pipe and cannot change current A or B",async()=>{
 const f=fixture();
 let closes=0;
 await assert.rejects(runEquinoxLocalSignedWindowsNativeWorker({
  ...f.opts,env:{...env,EQUINOX_LOCAL_MAIN_WORKER_TOKEN:"e".repeat(64)},
  startProofImpl:async()=>({close:async()=>{closes++;}}),
  auditProofImpl:async()=>{throw Error("Guardian original kernel PID mismatch");},
 }),/Guardian original kernel PID mismatch/u);
 assert.equal(closes,1);
});

test("signed native Windows worker refuses foreign argv, CPU, transaction root, wrong Node or worker before reading a selector",async()=>{
 const f=fixture();
 for(const wrong of [
  {platform:"darwin"},
  {arch:"ia32"},
  {argv:[...args,"--bypass"]},
  {argv:["--signed-native","--transaction-id","main-"+"f".repeat(31),"--transaction-root",root]},
  {argv:["--signed-native","--transaction-id",ID,"--transaction-root","C:\\Foreign"]},
  {env:{LOCALAPPDATA:"relative"}},
  {workerPath:"C:\\Somewhere\\worker.js"},
  {nodePath:"C:\\Python\\python.exe"},
  {nodePath:path.win32.join(release,"runtime","node","bin","node-v2.exe")},
 ]){
  await assert.rejects(inspectSignedWindowsNativeWorkerPreflight({...f.opts,...wrong}));
 }
 assert.equal(f.calls.some(x=>x[0]==="guardian"),false);
});

test("worker rejects B store or descriptor drift, forged Ed25519, same sourceSHA A and foreign Guardian",async()=>{
 const f=fixture();
 for(const wrong of [
  {readDescriptorImpl:async()=>({
   targetSha:SHA,target,targetRuntimeContractSha256:CONTRACT,
   previous:{kind:"none"},
  })},
  {readDescriptorImpl:async()=>({
   targetSha:SHA,target,targetRuntimeContractSha256:CONTRACT,
   previous:{kind:"main",sourceSha:SHA,target,runtimeContractSha256:CONTRACT},
  })},
  {inspectStoredImpl:async()=>({
   sourceSha:SHA,target,releaseDir:release,runtimeContractSha256:CONTRACT,
   payloadVersion:"6.2.1",manifest:{artifactSha256:"e".repeat(64),artifactBytes:12345},
  })},
  {readSelectorImpl:async()=>({data:JSON.stringify({...f.signed,version:"6.2.2"})})},
  {fsImpl:{...f.opts.fsImpl,realpath:async name=>name===guardianPath?"C:\\Foreign.exe":name}},
 ]){
  await assert.rejects(inspectSignedWindowsNativeWorkerPreflight({...f.opts,...wrong}));
 }
 assert.equal(f.calls.filter(x=>x[0]==="guardian").length,0,
  "any drift must fail BEFORE original Guardian OS query");
});

test("same original packaged Main worker script dispatches native Windows B to distinct fail-closed path, never to Git or Mac worker",async()=>{
 const code=await fs.readFile(new URL("../../src/equinox-local-main-update-worker.ts",import.meta.url),"utf8");
 assert.match(code,/process\.argv\[2\] === "--signed-native"/u);
 assert.match(code,/process\.platform==="win32"/u);
 assert.match(code,/import\("\.\/equinox-local-signed-main-windows-worker\.js"\)/u);
 assert.match(code,/runEquinoxLocalSignedWindowsNativeWorker\(\)/u);
 const safety=await fs.readFile(new URL("../../src/equinox-local-signed-main-windows-worker.ts",import.meta.url),"utf8");
 assert.match(safety,/guardian_os_handoff_required/u);
 assert.match(safety,/production-signed journal and B release fingerprint/u);
 assert.match(safety,/--audit-signed-native-worker-argv/u);
 assert.match(safety,/--audit-signed-native-worker-pipe/u);
 assert.match(safety,/startEquinoxWindowsMainWorkerProof/u);
 assert.match(safety,/finally\{\s*await proof\.close\(\);/u);
 assert.match(safety,/original native OS mutation session is not authorized/u);
 assert.doesNotMatch(safety,/writeEquinoxLocalMainNativePointer|switchNative|stopWindowsShell|registerWindowsNativeMessagingHost|runEquinoxLocalMainUpdateWorker/u);
});


test("original packaged native Main worker reuses original Guardian OS argv audit and implicit signed B journal instead of hashing B twice",async()=>{
 const rootDir=path.resolve(path.dirname(new URL(import.meta.url).pathname),"../..");
 const files=await collectManagedReleaseSourceFiles(rootDir);
 assert.ok(files.includes("src/equinox-local-signed-main-windows-worker.js"));
 assert.ok(files.includes("src/equinox-local-main-update-worker.js"));
 assert.equal(files.filter(item=>item==="src/equinox-local-signed-main-windows-worker.js").length,1);
 const code=await fs.readFile(new URL("../../src/equinox-local-signed-main-windows-worker.ts",import.meta.url),"utf8");
 assert.match(code,/execFile\(guardianPath,\["--audit-signed-native-worker-argv"\]/u);
 assert.doesNotMatch(code,/execFile\(guardianPath,\["--audit-signed-native-journal"\]/u);
 assert.match(code,/timeout:15_000,windowsHide:true,maxBuffer:4096/u);
 assert.doesNotMatch(code,/--hold-native|--stop-wpf|--activate-signed-native/u);
});


test("same original Windows worker HMAC pipe completes a real fresh nonce challenge over a disposable socket, then closes; STILL no A/B action",async()=>{
 const f=fixture();
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),"eq-signed-win-hmac-"));
 const socket=path.join(temp,"native.sock");
 const token="d".repeat(64);
 try{
  await assert.rejects(runEquinoxLocalSignedWindowsNativeWorker({
   ...f.opts,env:{...env,EQUINOX_LOCAL_MAIN_WORKER_TOKEN:token},
   startProofImpl:input=>startEquinoxWindowsMainWorkerProof({...input,
    platform:"test",fixtureSocketPath:socket}),
   auditProofImpl:async()=>{
    const challenge="f".repeat(64)+"\n";
    const reply=await new Promise((resolve,reject)=>{
     const client=net.createConnection(socket);
     let output="";
     client.on("connect",()=>client.write(challenge));
     client.on("data",chunk=>output+=chunk.toString("ascii"));
     client.on("end",()=>resolve(output));
     client.on("error",reject);
    });
    const expected=createHmac("sha256",Buffer.from(token,"hex"))
     .update(Buffer.from("equinox-local-native-main-proof-v1:","ascii"))
     .update(Buffer.from("f".repeat(64),"hex")).digest("hex")+"\n";
    assert.equal(reply,expected);
   },
  }),/original native OS mutation session is not authorized/u);
  await assert.rejects(fs.lstat(socket),{code:"ENOENT"});
 }finally{await fs.rm(temp,{recursive:true,force:true});}
});
