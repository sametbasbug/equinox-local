import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  pruneVerifiedMainLargeStorage,
  pruneDisenrolledWindowsMainLargeStorage,
} from "../../src/equinox-local-main-storage-retention.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const missing = () => Object.assign(Error("synthetic missing"), {code: "ENOENT"});

function windowsFixture(overrides = {}) {
  const api = path.win32;
  const root = "C:\\OwnedEquinox";
  const tx = api.join(root, "state", "main-update");
  const releaseDir = api.join(root, "releases", "6.1.1");
  const target = "win32-x64";
  const installation = {
    kind: "managed",
    managed: true,
    platform: "win32",
    selfUpdateSupported: true,
    arch: "x64",
    target,
    installRoot: root,
    releasesRoot: api.join(root, "releases"),
    releaseDir,
    programRoot: api.join(root, "Programs", "Equinox Local"),
    nativeMessagingManifestRoot: api.join(root, "browser", "native-messaging"),
    ...overrides,
  };
  const executable = api.join(releaseDir, "runtime", "node", "bin", "node.exe");
  const events = [];
  const fsImpl = {
    async lstat(name) {
      events.push(["lstat", name]);
      if (name.includes("active.json") || name.endsWith("install.json") ||
          name.endsWith("install.json.stable-install-backup") ||
          name.endsWith("classic-repair.json") || name.endsWith(".stable-repair-backup") ||
          name.endsWith("current-source.conf") || name.endsWith("current-native.json")) throw missing();
      return {isDirectory:()=>true,isSymbolicLink:()=>false,isFile:()=>false};
    },
    async realpath(name) {events.push(["realpath",name]);return name;},
    async readdir(name) {events.push(["readdir",name]);return [];},
    async rm(name,options) {events.push(["rm",name,options]);throw Error("unexpected deletion");},
    async unlink(name) {events.push(["unlink",name]);throw Error("unexpected unlink");},
  };
  let shellCalls = 0, hostCalls = 0;
  const options = {
    installation,fsImpl,runtimeVersion:"6.1.1",processExecutable:executable,
    readStable:async()=>{events.push(["readStable"]);return {version:"6.1.1",releaseDir};},
    verifyShell:async()=>{shellCalls++;events.push(["verifyShell"]);return {
      owned:true,shellExecutable:api.join(installation.programRoot, "EquinoxLocal.exe"),
    };},
    verifyNativeHost:async()=>{hostCalls++;events.push(["verifyHost"]);return {
      launcherPath:api.join(releaseDir,"runtime","browser","equinox-browser-native-host.exe"),
    };},
  };
  return {api,root,tx,releaseDir,events,fsImpl,options,
    get shellCalls(){return shellCalls},get hostCalls(){return hostCalls}};
}

test("Main pruning refuses arbitrary installation, mismatched roots and non-owned executable before filesystem access", async () => {
  const fx=windowsFixture();
  const base={...fx.options,platform:"win32"};
  for(const modification of [
    {installation:{...base.installation,kind:"portable"}},
    {installation:{...base.installation,managed:false}},
    {installation:{...base.installation,mainTransactionRoot:"C:\\Elsewhere"}},
    {installation:{...base.installation,installRoot:"relative-root"}},
    {installation:{...base.installation,target:"win32-arm64"}},
  ]) {
    const entry = {...base,...modification,
      readSource:async()=>{throw Error("untrusted Git must not run");},
      readNative:async()=>{throw Error("native pointer must not read");},
    };
    await assert.rejects(pruneVerifiedMainLargeStorage(entry),Error);
    assert.equal(fx.events.length,0);
  }
  for(const modification of [
    {installation:{...base.installation,kind:"managed-source",mainTransactionRoot:"C:\\Elsewhere"}},
    {installation:{...base.installation,kind:"managed-source",mainTransactionRoot:fx.api.join(fx.root,"state","main-update"),installRoot:"relative"}},
  ]){
    await assert.rejects(pruneVerifiedMainLargeStorage({...base,...modification}),/Main storage root/u);
    assert.equal(fx.events.length,0);
  }
  assert.equal(fx.events.some(([op])=>op==="rm"||op==="unlink"),false);
});

test("Windows Stable retirement rejects install markers, Symlink transaction roots and foreign ownership before any deletion", async () => {
  for(const scenario of ["active-marker","tx-symlink","wrong-release","foreign-shell","foreign-host","wrong-process"]){
    const f=windowsFixture();
    const original=f.fsImpl.lstat;
    if(scenario==="active-marker") f.fsImpl.lstat=async name=>{
      if(name.endsWith("active.json"))return {isDirectory:()=>false,isSymbolicLink:()=>false,isFile:()=>true};
      return original(name);
    };
    if(scenario==="tx-symlink")f.fsImpl.lstat=async name=>{
      if(name===f.tx)return {isDirectory:()=>true,isSymbolicLink:()=>true};
      return original(name);
    };
    if(scenario==="wrong-release")f.options.readStable=async()=>({version:"6.1.0",releaseDir:f.releaseDir});
    if(scenario==="foreign-shell")f.options.verifyShell=async()=>({owned:false,shellExecutable:"C:\\Other\\EquinoxLocal.exe"});
    if(scenario==="foreign-host")f.options.verifyNativeHost=async()=>({launcherPath:"C:\\Foreign\\native-host.exe"});
    if(scenario==="wrong-process")f.options.processExecutable="C:\\Other\\node.exe";
    await assert.rejects(pruneDisenrolledWindowsMainLargeStorage(f.options),Error,scenario);
    assert.equal(f.events.some(([op])=>op==="rm"||op==="unlink"),false,scenario);
  }
});

test("Windows Stable retirement marks locked obsolete source payload pending without forcing deletion or touching secrets", async () => {
  const f=windowsFixture();
  const sources=f.api.join(f.tx,"sources");
  const obsolete=f.api.join(sources,SHA_A);
  const native=f.api.join(f.tx,"native-store","win32-x64");
  f.fsImpl.readdir=async name=>{
    f.events.push(["readdir",name]);
    if(name===sources)return [
      {name:SHA_A,isDirectory:()=>true,isSymbolicLink:()=>false},
      {name:"secrets",isDirectory:()=>true,isSymbolicLink:()=>false},
      {name:"..",isDirectory:()=>true,isSymbolicLink:()=>false},
      {name:"UPPERCASE",isDirectory:()=>true,isSymbolicLink:()=>false},
    ];
    return [];
  };
  f.fsImpl.rm=async(name,options)=>{
    f.events.push(["rm",name,options]);
    if(name===obsolete)throw Object.assign(Error("synthetic file in use"),{code:"EBUSY"});
    throw Error("unexpected deletion");
  };
  const result=await pruneDisenrolledWindowsMainLargeStorage(f.options);
  assert.deepEqual(result.sources,[]);
  assert.deepEqual(result.pending,[`sources/${SHA_A}`]);
  assert.equal(Object.isFrozen(result),true);
  assert.deepEqual(f.events.filter(([op])=>op==="rm"),[["rm",obsolete,{recursive:true,force:false}]]);
  assert.equal(f.events.some(([op])=>op==="unlink"),false);
  assert.ok(f.events.filter(([op])=>op==="readStable").length>=2,
    "every candidate is reauthenticated against the signed Stable pointer");
  assert.ok(f.events.some(([op,name])=>op==="readdir"&&name===native));
});

test("Windows Stable retirement rejects release identity drift observed immediately before deletion", async () => {
  const f=windowsFixture();
  const sources=f.api.join(f.tx,"sources");
  let stableReads=0;
  f.options.readStable=async()=>{
    stableReads++;
    f.events.push(["readStable",stableReads]);
    return {version:stableReads===1?"6.1.1":"6.1.0",releaseDir:f.releaseDir};
  };
  f.fsImpl.readdir=async name=>{
    f.events.push(["readdir",name]);
    return name===sources?[{name:SHA_A,isDirectory:()=>true,isSymbolicLink:()=>false}]:[];
  };
  await assert.rejects(pruneDisenrolledWindowsMainLargeStorage(f.options),/Stable release identity drifted/u);
  assert.equal(f.events.some(([op])=>op==="rm"||op==="unlink"),false);
  assert.equal(stableReads,2);
});
