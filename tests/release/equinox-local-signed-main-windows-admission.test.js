import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import test from "node:test";
import {Readable} from "node:stream";
import path from "node:path";
import {inspectSignedMainInstallerWindowsAdmission,resolveOriginalWindowsInstalledA,inspectInstalledOriginalWindowsGuardian,inspectInstalledOriginalWindowsShell} from "../../src/equinox-local-signed-main-windows-admission.js";
import {createSignedMainInstallPointer,validateSignedMainInstallPointer} from "../../src/equinox-local-main-install-pointer.js";

const SHA="b".repeat(40),A="a".repeat(40),CONTRACT="c".repeat(64);
const homeDir="C:\\Users\\Example";
const env={LOCALAPPDATA:"C:\\Users\\Example\\AppData\\Local"};
const installRoot=path.win32.join(env.LOCALAPPDATA,"Equinox Local");
const root=path.win32.join(installRoot,"state","main-update");
const target="win32-x64";
const newRelease=path.win32.join(root,"native-store",target,SHA,"release");
const oldStable=path.win32.join(installRoot,"releases","6.1.0");
const oldMain=path.win32.join(root,"native-store",target,A,"release");

function signed(){
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const keyId="test-win-real-signed-ed25519";
 const pointer=createSignedMainInstallPointer({
  sourceSha:SHA,version:"6.2.1",publishedAt:"2026-10-28T01:00:00.000Z",
  privateKey,keyId,nativeManifests:["darwin-arm64","darwin-x64","win32-arm64","win32-x64"].map(t=>({
   schemaVersion:1,channel:"main",sourceSha:SHA,target:t,runtimeContractSha256:CONTRACT,
   artifact:{name:"equinox-local-main-"+SHA+"-"+t+(t.startsWith("win32")?".zip":".tar.gz"),
    sha256:"d".repeat(64),bytes:42},
  })),
 });
 return {pointer,verifyPointerImpl:(value)=>validateSignedMainInstallPointer(value,{
  publicKeys:{[keyId]:publicKey.export({type:"spki",format:"pem"})},
 })};
}
function fixture(isNative=false){
 const original=signed();
 const releaseDir=isNative?oldMain:oldStable;
 const calls=[];
 const fsImpl={lstat:async name=>{calls.push(["lstat",name]);throw Object.assign(Error("no active owner"),{code:"ENOENT"});}};
 const opts={
  signedPointer:original.pointer,verifyPointerImpl:original.verifyPointerImpl,
  platform:"win32",arch:"x64",homeDir,env:{...env,EQUINOX_LOCAL_RELEASE_DIR:releaseDir},
  fsImpl,
  resolveActiveAImpl:async()=>({releaseDir,previousKind:isNative?"main":"stable"}),
  resolveInstallationImpl:()=>({
   kind:"managed",managed:true,selfUpdateSupported:true,platform:"win32",arch:"x64",
   target,installRoot,releaseDir,...(isNative?{mainNativeSha:A}:{}),
  }),
  resolveManagedImpl:async()=>isNative?{kind:"managed-main",sourceSha:A,mainNativeSha:A}:{kind:"managed"},
  readPointerImpl:async()=>({sourceSha:A,target,runtimeContractSha256:"f".repeat(64),
   releaseDir:oldMain,payloadVersion:"6.1.0"}),
  inspectGuardianImpl:async input=>{
   calls.push(["guardian",input]);
   assert.equal(input.releaseDir,releaseDir);
   return {trusted:true,sha256:"e".repeat(64),bytes:3072};
  },
  inspectShellImpl:async input=>{
   calls.push(["wpf",input]);
   assert.equal(input.releaseDir,releaseDir);
   return {trusted:true,sha256:"f".repeat(64),bytes:3072};
  },
  inspectStoredImpl:async input=>{
   calls.push(["B",input]);
   assert.equal(input.transactionRoot,root);
   assert.equal(input.sourceSha,SHA);
   return {releaseDir:newRelease,sourceSha:SHA,target,
    runtimeContractSha256:CONTRACT,payloadVersion:"6.2.1",
    manifest:{artifactSha256:"d".repeat(64),artifactBytes:42}};
  },
 };
 return {opts,calls};
}

test("Windows read-only original signed Ed25519 Main B preflight admits authentic Stable A only FOR independent WPF Guardian handoff, mutates nothing",async()=>{
 const f=fixture(false);
 const result=await inspectSignedMainInstallerWindowsAdmission(f.opts);
 assert.equal(result.status,"guardian_handoff_required");
 assert.equal(result.sourceSha,SHA);
 assert.equal(result.releaseDir,newRelease);
 assert.equal(result.previousKind,"stable");
 assert.equal(result.previousSha,null);
 assert.equal(result.originalGuardianSha256,"e".repeat(64));
 assert.equal(result.originalWpfSha256,"f".repeat(64));
 assert.equal(f.calls.filter(([name])=>name==="wpf").length,1);
 assert.equal(result.sameSha,false);
 assert.equal(f.calls.filter(([name])=>name==="guardian").length,1);
 assert.equal(f.calls.filter(([name])=>name==="B").length,1);
 assert.equal(f.calls.some(([name])=>name==="lstat"),true);
 assert.equal(f.calls.some(([name])=>name==="writeFile"||name==="rename"),false);
});

test("Windows native Main A->signed Main B requires exact A pointer, source SHA and native Guardian; no Git fallback",async()=>{
 const f=fixture(true);
 const accepted=await inspectSignedMainInstallerWindowsAdmission(f.opts);
 assert.equal(accepted.previousKind,"main");
 assert.equal(accepted.previousSha,A);
 assert.equal(accepted.previousRuntimeContractSha256,"f".repeat(64));
 for(const wrong of [
  {readPointerImpl:async()=>({sourceSha:"f".repeat(40),target,releaseDir:oldMain,runtimeContractSha256:CONTRACT})},
  {resolveManagedImpl:async()=>({kind:"managed-source"})},
  {resolveManagedImpl:async()=>({kind:"managed-main",sourceSha:"f".repeat(40),mainNativeSha:"f".repeat(40)})},
  {inspectGuardianImpl:async()=>({trusted:false})},
  {inspectShellImpl:async()=>({trusted:false})},
 ]){
  await assert.rejects(inspectSignedMainInstallerWindowsAdmission({...f.opts,...wrong}));
 }
});

test("Windows Main admission denies forged production signature, immutable B drift, foreign WPF roots and active transaction BEFORE activation",async()=>{
 const f=fixture();
 for(const wrong of [
  {signedPointer:{...f.opts.signedPointer,sourceSha:"f".repeat(40)}},
  {inspectStoredImpl:async()=>({
   releaseDir:newRelease,sourceSha:SHA,target,runtimeContractSha256:CONTRACT,
   payloadVersion:"6.2.1",manifest:{artifactSha256:"f".repeat(64),artifactBytes:42},
  })},
  {resolveInstallationImpl:()=>({kind:"unsupported",managed:false})},
  {fsImpl:{lstat:async()=>({isFile:()=>true})}},
  {env:{...env,EQUINOX_LOCAL_RELEASE_DIR:"C:\\Windows\\System32"}},
 ]){
  await assert.rejects(inspectSignedMainInstallerWindowsAdmission({...f.opts,...wrong}));
 }
});

test("Windows read-only native preflight rejects non-Windows environment, unsupported arch and unsigned no-A first install",async()=>{
 const f=fixture();
 for(const wrong of [
  {platform:"darwin"},
  {arch:"ia32"},
  {homeDir:"/Users/notWindows"},
  {env:{...env,EQUINOX_LOCAL_RELEASE_DIR:"C:\\Windows\\System32"}},
 ]){
  await assert.rejects(inspectSignedMainInstallerWindowsAdmission({...f.opts,...wrong}));
 }
});


test("Windows durable A resolver prefers exact current-native SHA and never falls back to a stale numbered Stable release",async()=>{
 const checked=[];
 const native=await resolveOriginalWindowsInstalledA({
  transactionRoot:root,installRoot,target,
  readPointerImpl:async(file)=>{
   checked.push(file);
   return {target,sourceSha:A,runtimeContractSha256:CONTRACT,releaseDir:oldMain};
  },
  readStableImpl:async()=>assert.fail("native A pointer must take precedence over older Stable"),
 });
 assert.equal(native.previousKind,"main");
 assert.equal(native.releaseDir,oldMain);
 assert.deepEqual(checked,[path.win32.join(root,"current-native.json")]);
 await assert.rejects(resolveOriginalWindowsInstalledA({
  transactionRoot:root,installRoot,target,
  readPointerImpl:async()=>({target,sourceSha:A,runtimeContractSha256:CONTRACT,
    releaseDir:"C:\\Windows\\System32"}),
  readStableImpl:async()=>assert.fail("a foreign native A must NEVER fall back"),
 }),/owning runtime/u);
});

test("Windows durable A resolver reads exact current-version Stable only when native A pointer is genuinely absent",async()=>{
 const stable=await resolveOriginalWindowsInstalledA({
  transactionRoot:root,installRoot,target,
  readPointerImpl:async()=>{throw Object.assign(Error("missing"),{code:"ENOENT"});},
  readStableImpl:async(file,opts)=>{
   assert.equal(file,path.win32.join(installRoot,"current-version.json"));
   assert.equal(opts.platform,"win32");
   assert.equal(opts.target,target);
   return {version:"6.1.0"};
  },
 });
 assert.equal(stable.previousKind,"stable");
 assert.equal(stable.releaseDir,oldStable);
 await assert.rejects(resolveOriginalWindowsInstalledA({
  transactionRoot:root,installRoot,target,
  readPointerImpl:async()=>{throw Object.assign(Error("unauthorized"),{code:"EPERM"});},
  readStableImpl:async()=>assert.fail("permission denied native A is not no A"),
 }),/unauthorized/u);
});


test("original installed Windows Guardian byte-level inspection is read-only, rejects foreign signed-release executable and a short file",async()=>{
 const opens=[],closed=[];
 const options=({different=false,short=false}={})=>({
  installRoot,releaseDir:oldMain,
  fsImpl:{
   open:async file=>{
    opens.push(file);
    const b=(different&&file.includes("runtime\\guardian")&&file.includes("native-store"))?0x67:0x66;
    const size=short?100:4096;
    return {
     stat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,nlink:1,size}),
     createReadStream:()=>Readable.from([Buffer.alloc(size,b)]),
     close:async()=>{closed.push(file);},
    };
   },
  },
 });
 const good=await inspectInstalledOriginalWindowsGuardian(options());
 assert.equal(good.trusted,true);
 assert.equal(good.bytes,4096);
 assert.equal(opens.length,2);
 assert.equal(closed.length,2);
 await assert.rejects(inspectInstalledOriginalWindowsGuardian(options({different:true})),
  /differs from original A signed release/u);
 await assert.rejects(inspectInstalledOriginalWindowsGuardian(options({short:true})),
  /not an owned bounded normal file/u);
 assert.equal(opens.length,6);
 assert.equal(closed.length,6);
});


test("original installed WPF executable must byte-match release A and its canonical user program directory; does not alter WPF",async()=>{
 const visits=[];
 const makeFs=({different=false,short=false}={})=>({
  open:async file=>{
   visits.push(file);
   const isSigned=file.includes(path.win32.join("runtime", "shell"));
   const size=short?20:4096;
   const byte=(different && isSigned)?0x77:0x66;
   return {
    stat:async()=>({isFile:()=>true,isSymbolicLink:()=>false,nlink:1,size}),
    createReadStream:()=>Readable.from([Buffer.alloc(size,byte)]),
    close:async()=>{},
   };
  },
 });
 const baseline=await inspectInstalledOriginalWindowsShell({
  installRoot,releaseDir:oldMain,fsImpl:makeFs(),
 });
 assert.equal(baseline.trusted,true);
 assert.equal(baseline.bytes,4096);
 assert.deepEqual(visits.slice(0,2),[
  path.win32.join(env.LOCALAPPDATA,"Programs","Equinox Local","EquinoxLocal.exe"),
  path.win32.join(oldMain,"runtime","shell","EquinoxLocal.exe"),
 ]);
 await assert.rejects(inspectInstalledOriginalWindowsShell({
  installRoot,releaseDir:oldMain,fsImpl:makeFs({different:true}),
 }),/differs from original A signed release/u);
 await assert.rejects(inspectInstalledOriginalWindowsShell({
  installRoot,releaseDir:oldMain,fsImpl:makeFs({short:true}),
 }),/owned bounded normal file/u);
 assert.equal(visits.length,6);
});
