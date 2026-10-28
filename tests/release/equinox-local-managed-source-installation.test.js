import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveEquinoxLocalInstallation } from "../../src/equinox-local-installation.js";
import {createSignedMainInstallPointer,validateSignedMainInstallPointer} from "../../src/equinox-local-main-install-pointer.js";

import {
  equinoxLocalManagedSourcePaths,
  resolveEquinoxLocalManagedSourceInstallation,
} from "../../src/equinox-local-managed-source-installation.js";

const SHA = "a".repeat(40);

function base(root) {
  return {
    kind: "managed",
    managed: true,
    selfUpdateSupported: true,
    platform: "darwin",
    arch: "arm64",
    target: "darwin-arm64",
    installRoot: root,
    releaseDir: path.join(root, "releases", "5.2.0"),
  };
}

test("server startup upgrades a trusted managed base installation to managed-source identity", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const server = await fs.readFile(path.join(root, "src", "server.js"), "utf8");
  assert.match(server, /resolveEquinoxLocalManagedSourceInstallation/u);
  assert.match(server, /const equinoxLocalBaseInstallation = resolveEquinoxLocalInstallation/u);
  assert.match(server, /const equinoxLocalInstallation = await resolveEquinoxLocalManagedSourceInstallation/u);
  assert.match(server, /baseInstallation: equinoxLocalBaseInstallation/u);
});

test("server routes managed-source Main check/apply without changing Stable routing", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const server = await fs.readFile(path.join(root, "src", "server.js"), "utf8");
  assert.match(server, /createEquinoxLocalMainApplyController/u);
  assert.match(server, /\["source", "managed-source"\]\.includes\(equinoxLocalInstallation\.kind\)/u);
  assert.match(server, /equinoxLocalMainApplyController\.resetError\(\)/u);
  assert.match(server, /kind === "managed-source"[\s\S]*equinoxLocalMainApplyController\.apply\(\)[\s\S]*equinoxLocalUpdateCoordinator\.apply\(\)/u);
  assert.match(server, /\.\.\.await equinoxLocalMainApplyController\.reconcile\(\)/u);
});

test("Windows Main native-store bootstrap is owned, but foreign and malformed releases cannot claim it", () => {
  const home = String.raw`C:\Users\Example`;
  const local = String.raw`C:\Users\Example\AppData\Local`;
  const install = String.raw`C:\Users\Example\AppData\Local\Equinox Local`;
  const sha = "b".repeat(40);
  const native = String.raw`C:\Users\Example\AppData\Local\Equinox Local\state\main-update\native-store\win32-x64`
    + `\\${sha}\\release`;
  const identity = (release) => resolveEquinoxLocalInstallation({
    platform: "win32", arch: "x64", homeDir: home,
    env: { LOCALAPPDATA: local, EQUINOX_LOCAL_INSTALL_ROOT: install, EQUINOX_LOCAL_RELEASE_DIR: release },
  });
  const main = identity(native);
  assert.equal(main.kind, "managed");
  assert.equal(main.releaseDir, native);
  assert.equal(main.mainNativeSha, sha);
  for (const release of [
    native + String.raw`\evil`,
    native.replace("win32-x64", "win32-arm64"),
    native.replace(sha, "non-sha"),
    String.raw`C:\Windows\System32`,
  ]) assert.equal(identity(release).kind, "unsupported", release);
});

test("managed-source paths stay product-owned on macOS and Windows", () => {
  const mac = equinoxLocalManagedSourcePaths({ platform: "darwin", arch: "arm64", homeDir: "/Users/example", env: {} });
  assert.equal(mac.mainTransactionRoot, "/Users/example/Library/Application Support/Equinox Local/main-update");
  assert.equal(mac.installStampPath, mac.mainTransactionRoot + "/install.json");

  const win = equinoxLocalManagedSourcePaths({
    platform: "win32",
    arch: "x64",
    homeDir: String.raw`C:\Users\Example`,
    env: { LOCALAPPDATA: String.raw`C:\Users\Example\AppData\Local` },
  });
  assert.equal(win.mainTransactionRoot, String.raw`C:\Users\Example\AppData\Local\Equinox Local\state\main-update`);
  assert.equal(win.sourcePointerPath, String.raw`C:\Users\Example\AppData\Local\Equinox Local\state\main-update\current-source.conf`);
});

test("managed-source resolver requires a private canonical stamp and exact source pointer", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-managed-source-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const installRoot = path.join(home, "Library", "Application Support", "Equinox Local");
  const paths = equinoxLocalManagedSourcePaths({ platform: "darwin", arch: "arm64", homeDir: home, env: {} });
  await fs.mkdir(paths.mainTransactionRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.mainTransactionRoot, 0o700);
  await fs.writeFile(paths.installStampPath, JSON.stringify({
    schemaVersion: 1,
    channel: "main",
    repository: "sametbasbug/equinox-local",
    branch: "main",
    bootstrapSha: SHA,
  }) + "\n", { mode: 0o600 });
  const sourceRoot = path.join(paths.mainTransactionRoot, "sources", SHA);

  const resolved = await resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: base(installRoot),
    platform: "darwin",
    arch: "arm64",
    homeDir: home,
    env: {},
    readPointerImpl: async (pointerPath) => {
      assert.equal(pointerPath, paths.sourcePointerPath);
      return { sourceRoot, sha: SHA };
    },
  });

  assert.equal(resolved.kind, "managed-source");
  assert.equal(resolved.channel, "main");
  assert.equal(resolved.mainUpdateSupported, true);
  assert.equal(resolved.sourceRoot, sourceRoot);
  assert.equal(resolved.sourceSha, SHA);
  assert.equal(resolved.mainTransactionRoot, paths.mainTransactionRoot);
  assert.equal(resolved.mainInstallStamp.bootstrapSha, SHA);
});

test("managed-source resolver prefers exact product-owned Git when the M8 toolchain is present", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-managed-source-toolchain-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const installRoot = path.join(home, "Library", "Application Support", "Equinox Local");
  const paths = equinoxLocalManagedSourcePaths({ platform: "darwin", arch: "arm64", homeDir: home, env: {} });
  const managedGit = path.join(installRoot, "runtime", "toolchain", "git", "2.56.0-1", "darwin-arm64", "bin", "git");
  const managedNode = path.join(installRoot, "runtime", "toolchain", "node", "26.12.1", "darwin-arm64", "bin", "node");
  const managedNpm = path.join(installRoot, "runtime", "toolchain", "node", "26.12.1", "darwin-arm64", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  await fs.mkdir(path.dirname(managedGit), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(managedNode), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(managedNpm), { recursive: true, mode: 0o700 });
  await fs.writeFile(managedGit, "fixture\n", { mode: 0o700 });
  await fs.writeFile(managedNode, "fixture\n", { mode: 0o700 });
  await fs.writeFile(managedNpm, "fixture\n", { mode: 0o600 });
  await fs.mkdir(paths.mainTransactionRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(paths.installStampPath, JSON.stringify({
    schemaVersion: 1, channel: "main", repository: "sametbasbug/equinox-local", branch: "main", bootstrapSha: SHA,
  }) + "\n", { mode: 0o600 });

  const resolved = await resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: base(installRoot),
    platform: "darwin",
    arch: "arm64",
    homeDir: home,
    env: {},
    readPointerImpl: async (pointerPath, options) => {
      assert.equal(pointerPath, paths.sourcePointerPath);
      assert.equal(options.gitPath, managedGit);
      return { sourceRoot: path.join(paths.mainTransactionRoot, "sources", SHA), sha: SHA };
    },
  });
  assert.equal(resolved.gitPath, managedGit);
  assert.match(resolved.nodePath, /runtime\/toolchain\/node\/26\.12\.1\/darwin-arm64\/bin\/node$/u);
  assert.match(resolved.npmPath, /npm-cli\.js$/u);
  assert.equal(resolved.shellPath, null);
});

test("managed-source resolver preserves Stable identity when no stamp exists and fails closed on unsafe stamp", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-managed-source-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const installRoot = path.join(home, "Library", "Application Support", "Equinox Local");
  const original = base(installRoot);
  const paths = equinoxLocalManagedSourcePaths({ platform: "darwin", arch: "arm64", homeDir: home, env: {} });

  assert.equal(await resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: original, platform: "darwin", arch: "arm64", homeDir: home, env: {},
  }), original);

  await fs.mkdir(paths.mainTransactionRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(paths.installStampPath, "{}\n", { mode: 0o644 });
  await assert.rejects(resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: original, platform: "darwin", arch: "arm64", homeDir: home, env: {},
  }), /install stamp is not private/u);
});

test("signed Stable ignores leftover incomplete Main toolchain but enrolled Main rejects it", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-stable-toolchain-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const installRoot = path.join(home, "Library", "Application Support", "Equinox Local");
  const original = base(installRoot);
  const paths = equinoxLocalManagedSourcePaths({ platform: "darwin", arch: "arm64", homeDir: home, env: {} });
  const leftoverGit = path.join(installRoot, "runtime", "toolchain", "git", "2.56.0-1", "darwin-arm64", "bin", "git");
  await fs.mkdir(path.dirname(leftoverGit), { recursive: true });
  await fs.writeFile(leftoverGit, "old product-owned leftover\n", { mode: 0o700 });
  await fs.mkdir(paths.mainTransactionRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.mainTransactionRoot, 0o700);

  // A repaired Stable must start without touching the residual old Main bits.
  assert.equal(await resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: original, platform: "darwin", arch: "arm64", homeDir: home, env: {},
  }), original);
  assert.equal(await fs.readFile(leftoverGit, "utf8"), "old product-owned leftover\n");

  // An actual enrolled Main still rejects an incomplete product-owned toolchain.
  await fs.writeFile(paths.installStampPath, JSON.stringify({
    schemaVersion: 1, channel: "main", repository: "sametbasbug/equinox-local", branch: "main", bootstrapSha: SHA,
  }) + "\n", { mode: 0o600 });
  await assert.rejects(resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: original, platform: "darwin", arch: "arm64", homeDir: home, env: {},
  }), /Managed product-owned toolchain is incomplete/u);
});

test("Main native-backed resolver rejects missing or mismatched owned release path before Main enrollment", async (t) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-native-bootstrap-identity-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const installRoot = path.join(home, "Library", "Application Support", "Equinox Local");
  const paths = equinoxLocalManagedSourcePaths({platform:"darwin",arch:"arm64",homeDir:home,env:{}});
  await fs.mkdir(paths.mainTransactionRoot,{recursive:true,mode:0o700});
  await fs.writeFile(paths.installStampPath,JSON.stringify({
    schemaVersion:1,channel:"main",repository:"sametbasbug/equinox-local",branch:"main",bootstrapSha:SHA,
  })+"\n",{mode:0o600});
  const stampBefore=await fs.readFile(paths.installStampPath);
  const releaseDir=path.join(installRoot,"releases","5.2.0");
  let pointerReads=0,nativeReads=0;
  const options={
    platform:"darwin",arch:"arm64",homeDir:home,env:{},
    readPointerImpl:async()=>{pointerReads++;return{sourceRoot:path.join(paths.mainTransactionRoot,"sources",SHA),sha:SHA}},
    readNativePointerImpl:async()=>{nativeReads++;return{sourceSha:SHA,target:"darwin-arm64",releaseDir}},
  };
  for(const baseInstallation of [
    {...base(installRoot),mainNativeSha:SHA,releaseDir:undefined},
    {...base(installRoot),mainNativeSha:SHA,releaseDir:"/foreign/release"},
  ]) {
    await assert.rejects(resolveEquinoxLocalManagedSourceInstallation({
      ...options,baseInstallation,
    }),/native runtime does not match the authenticated native-store pointer/u);
  }
  assert.equal(pointerReads,2);
  assert.equal(nativeReads,2);
  assert.deepEqual(await fs.readFile(paths.installStampPath),stampBefore);
  assert.equal((await fs.lstat(paths.mainTransactionRoot)).isDirectory(),true);
});

test("enrolled Main rejects symlinked product Git while preserving the signed Stable state", async(t)=>{
  const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"equinox-source-toolchain-symlink-")));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const installRoot=path.join(home,"Library","Application Support","Equinox Local");
  const paths=equinoxLocalManagedSourcePaths({platform:"darwin",arch:"arm64",homeDir:home,env:{}});
  const managedGit=path.join(installRoot,"runtime","toolchain","git","2.56.0-1","darwin-arm64","bin","git");
  const managedNode=path.join(installRoot,"runtime","toolchain","node","26.12.1","darwin-arm64","bin","node");
  const managedNpm=path.join(installRoot,"runtime","toolchain","node","26.12.1","darwin-arm64","lib","node_modules","npm","bin","npm-cli.js");
  for(const executable of [managedGit,managedNode,managedNpm]) await fs.mkdir(path.dirname(executable),{recursive:true});
  const foreign=path.join(home,"foreign-git");
  await fs.writeFile(foreign,"foreign executable",{mode:0o700});
  await fs.symlink(foreign,managedGit);
  await fs.writeFile(managedNode,"owned node",{mode:0o700});
  await fs.writeFile(managedNpm,"owned npm",{mode:0o600});
  await fs.mkdir(paths.mainTransactionRoot,{recursive:true,mode:0o700});
  await fs.writeFile(paths.installStampPath,JSON.stringify({
    schemaVersion:1,channel:"main",repository:"sametbasbug/equinox-local",branch:"main",bootstrapSha:SHA,
  })+"\n",{mode:0o600});
  let attemptedPointer=false;
  await assert.rejects(resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation:base(installRoot),platform:"darwin",arch:"arm64",homeDir:home,env:{},
    readPointerImpl:async()=>{attemptedPointer=true;return {sourceRoot:"/foreign",sha:SHA}},
  }),/Managed Git executable is unsafe/u);
  assert.equal(attemptedPointer,false);
  assert.equal((await fs.lstat(managedGit)).isSymbolicLink(),true);
  assert.equal(await fs.readFile(foreign,"utf8"),"foreign executable");
  assert.equal(JSON.parse(await fs.readFile(paths.installStampPath,"utf8")).bootstrapSha,SHA);
});


test("Mac base installation recognizes exact full-SHA native-store release and refuses arbitrary native paths",()=>{
 const home="/Users/example";
 const root=home+"/Library/Application Support/Equinox Local";
 const sha="b".repeat(40);
 const candidate=root+"/main-update/native-store/darwin-arm64/"+sha+"/release";
 const resolve=release=>resolveEquinoxLocalInstallation({
  homeDir:home,platform:"darwin",arch:"arm64",
  env:{EQUINOX_LOCAL_INSTALL_ROOT:root,EQUINOX_LOCAL_RELEASE_DIR:release},
 });
 const admitted=resolve(candidate);
 assert.equal(admitted.kind,"managed");
 assert.equal(admitted.mainNativeSha,sha);
 for(const foreign of [candidate+"/subdirectory",candidate.replace("darwin-arm64","darwin-x64"),
  candidate.replace(sha,"bad-sha"),home+"/Downloads/foreign"]){
  assert.equal(resolve(foreign).kind,"unsupported",foreign);
 }
});

test("Git-free Main boot requires original Ed25519 selector, exact durable SHA/contract and matching running native release",async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),"equinox-native-main-direct-"));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const root=path.join(home,"Library","Application Support","Equinox Local");
 const state=equinoxLocalManagedSourcePaths({platform:"darwin",arch:"arm64",homeDir:home,env:{}});
 await fs.mkdir(state.mainTransactionRoot,{recursive:true,mode:0o700});
 await fs.chmod(state.mainTransactionRoot,0o700);
 const sourceSha="b".repeat(40),contract="c".repeat(64);
 const target="darwin-arm64";
 const installedDir=path.join(state.mainTransactionRoot,"native-store",target,sourceSha,"release");
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const keyId="test-ephemeral-only";
 const signed=createSignedMainInstallPointer({
  sourceSha,version:"6.2.1",publishedAt:"2026-10-27T22:00:00.000Z",keyId,privateKey,
  nativeManifests:["darwin-arm64","darwin-x64","win32-arm64","win32-x64"].map(tgt=>({
   schemaVersion:1,channel:"main",sourceSha,target:tgt,runtimeContractSha256:contract,
   artifact:{name:"equinox-local-main-"+sourceSha+"-"+tgt+(tgt.startsWith("win32-")?".zip":".tar.gz"),
    sha256:"f".repeat(64),bytes:12345},
  })),
 });
 const verifySignedPointerImpl=(raw,opts)=>validateSignedMainInstallPointer(raw,{
  ...opts,publicKeys:{[keyId]:publicKey.export({type:"spki",format:"pem"})},
 });
 const native={sourceSha,target,runtimeContractSha256:contract,
  releaseDir:installedDir,payloadVersion:"6.2.1"};
 const baseInstallation={...base(root),releaseDir:installedDir,mainNativeSha:sourceSha};
 const input={baseInstallation,platform:"darwin",arch:"arm64",homeDir:home,env:{},
  verifySignedPointerImpl,readNativePointerImpl:async()=>native};
 await assert.rejects(resolveEquinoxLocalManagedSourceInstallation(input),/no verified Main install stamp or signed native selector/u);
 const selectorPath=path.join(path.dirname(installedDir),"signed-selector.json");
 await fs.mkdir(path.dirname(selectorPath),{recursive:true,mode:0o700});
 await fs.writeFile(selectorPath,JSON.stringify(signed),{mode:0o600});
 const installed=await resolveEquinoxLocalManagedSourceInstallation(input);
 assert.equal(installed.kind,"managed-main");
 assert.equal(installed.sourceSha,sourceSha);
 assert.equal(installed.mainNativeSha,sourceSha);
 assert.equal(installed.mainUpdateSupported,false);
 assert.equal(installed.gitPath,null);
 assert.equal(installed.nodePath,null);
 await assert.rejects(resolveEquinoxLocalManagedSourceInstallation({...input,
  verifySignedPointerImpl:undefined,
 }),/trusted|signature|signing key/u);
 for(const nativeChange of [
  {sourceSha:"d".repeat(40)}, {target:"darwin-x64"},
  {runtimeContractSha256:"d".repeat(64)},{payloadVersion:"6.2.0"},
  {releaseDir:installedDir+"/different"},
 ]){
  await assert.rejects(resolveEquinoxLocalManagedSourceInstallation({...input,
   readNativePointerImpl:async()=>({...native,...nativeChange}),
  }),/differs from its exact durable SHA pointer/u);
 }
 await fs.chmod(selectorPath,0o644);
 await assert.rejects(resolveEquinoxLocalManagedSourceInstallation(input),/selector is not private/u);
 await fs.chmod(selectorPath,0o600);
 assert.equal((await fs.readdir(state.mainTransactionRoot)).includes("install.json"),false,
   "Git-free native identity must never create old source stamps or tooling");
});


test("server reports exact Git-free Main native SHA and prohibits obsolete Stable update execution",async()=>{
 const source=await fs.readFile(new URL("../../src/server.js",import.meta.url),"utf8");
 assert.match(source,/equinoxLocalInstallation\.kind === "managed-main"[\s\S]*selfUpdateSupported: false/u);
 assert.match(source,/sourceSha: \["managed-source", "managed-main"\]\.includes\(equinoxLocalInstallation\.kind\)/u);
 assert.match(source,/mainNativeSha: equinoxLocalInstallation\.mainNativeSha/u);
 assert.match(source,/target: equinoxLocalInstallation\.target/u);
 assert.match(source,/equinoxLocalInstallation\.kind === "managed-main"[\s\S]*?legacy Stable activation is disabled/u);
 assert.match(source,/if \(equinoxLocalInstallation\.kind === "managed-main"\) \{\s*\/\/ This is a BOUNDED read-only/u);
});
