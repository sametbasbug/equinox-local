// Native-OS disposable filesystem acceptance: actual managed current pointer,
// exact signed metadata read, source identity commit and recovery. Never touches
// native user app registration; separate installed WPF/launchd E2E still needed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { bridgeActivatedStableToMain } from "../../src/equinox-local-stable-main-bridge.js";
import { readManagedCurrentRelease } from "../../src/equinox-local-update-activation.js";
import { writeEquinoxLocalCurrentVersionPointer } from "../../src/equinox-local-current-release.js";

const OS_SUPPORTED = ["darwin","win32"].includes(process.platform) && ["x64","arm64"].includes(process.arch);
const nativeTest = OS_SUPPORTED ? test : test.skip;
const VERSION = "6.0.4";
const SHA = "f".repeat(40);

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-native-bridge-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const installRoot = path.join(home, "Equinox Local");
  const releasesRoot = path.join(installRoot, "releases");
  const releaseDir = path.join(releasesRoot, VERSION);
  const managedState = path.join(home, "main-identity");
  await fs.mkdir(releaseDir, { recursive: true });
  await fs.mkdir(managedState);
  await fs.writeFile(path.join(releaseDir,"release.json"),JSON.stringify({
    schemaVersion:1,version:VERSION,target:`${process.platform}-${process.arch}`,sourceSha:SHA,
    nodeVersion:"26.11.1",tunnelClientVersion:"0.0.14",serverEntry:"server.js",
  }),{mode:0o600});
  // Use regular native host filesystem entries and product-required binary
  // shape, not an injected metadata reader that could miss a real defect.
  const executables = process.platform === "win32" ? [
    "runtime/node/bin/node.exe", "runtime/tunnel/tunnel-client.exe", "runtime/tunnel/cloudflared.exe",
    "runtime/winapp/winapp.exe", "runtime/winapp/libHarfBuzzSharp.dll", "runtime/winapp/libSkiaSharp.dll",
  ] : [
    "runtime/node/bin/node", "runtime/tunnel/tunnel-client", "runtime/tunnel/cloudflared",
    "runtime/peekaboo/peekaboo", "runtime/peekaboo/libswiftCompatibilitySpan.dylib",
  ];
  for (const relative of executables) {
    const binary = path.join(releaseDir,relative);
    await fs.mkdir(path.dirname(binary),{recursive:true});
    await fs.writeFile(binary,"HOST_NATIVE_FIXTURE",{mode:0o755});
  }
  const installation = {
    kind:"managed",managed:true,selfUpdateSupported:true,platform:process.platform,arch:process.arch,
    target:`${process.platform}-${process.arch}`,installRoot,releasesRoot,releaseDir,
    currentPointer:path.join(installRoot,"current-version.json"),currentLink:path.join(installRoot,"current"),
  };
  if (process.platform === "win32") {
    await writeEquinoxLocalCurrentVersionPointer(installation.currentPointer, {
      version:VERSION,target:installation.target,platform:"win32",
    });
  } else {
    await fs.symlink(`releases/${VERSION}`,installation.currentLink,"dir");
  }
  const userSecret = path.join(home,"secrets","runtime-key");
  const tunnelProfile = path.join(home,"tunnel-profile","config.yml");
  await fs.mkdir(path.dirname(userSecret));
  await fs.mkdir(path.dirname(tunnelProfile));
  await fs.writeFile(userSecret,"USER_SECRET_STAYS_UNTOUCHED",{mode:0o600});
  await fs.writeFile(tunnelProfile,"USER_PROFILE_STAYS_UNTOUCHED",{mode:0o600});
  const files = {
    stamp:path.join(managedState,"install.json"),
    pointer:path.join(managedState,"current-source.conf"),
    userSecret,tunnelProfile,
  };
  return {home,installation,managedState,files};
}

nativeTest("real native managed release pointer passes exact-source bridge; successful state survives restart", async (t) => {
  const f=await fixture(t);
  let current=await readManagedCurrentRelease(f.installation);
  assert.equal(current.version,VERSION);
  assert.equal(current.releaseDir,f.installation.releaseDir);
  let restarts=0;
  const result=await bridgeActivatedStableToMain({
    installation:f.installation,version:VERSION,homeDir:f.home,env:{},
    inspectInstallationImpl:async()=>({kind:"managed"}),
    enrollImpl:async({bootstrapSha,target})=>{
      assert.equal(bootstrapSha,SHA);
      assert.equal(target,f.installation.target);
      await fs.writeFile(f.files.pointer,SHA,{mode:0o600});
      await fs.writeFile(f.files.stamp,JSON.stringify({bootstrapSha:SHA,channel:"main"}),{mode:0o600});
      return {status:"enrolled",bootstrapSha:SHA};
    },
    restartImpl:async()=>{restarts++;},
    waitForMainImpl:async(version,sha)=>{
      assert.equal(version,VERSION);
      assert.equal(sha,await fs.readFile(f.files.pointer,"utf8"));
      assert.equal(JSON.parse(await fs.readFile(f.files.stamp,"utf8")).bootstrapSha,sha);
    },
    rollbackImpl:async()=>assert.fail("healthy Main must not roll back"),
  });
  assert.equal(result.status,"main-activated");
  assert.equal(restarts,1);
  assert.equal((await readManagedCurrentRelease(f.installation)).version,VERSION);
  assert.equal(await fs.readFile(f.files.userSecret,"utf8"),"USER_SECRET_STAYS_UNTOUCHED");
  assert.equal(await fs.readFile(f.files.tunnelProfile,"utf8"),"USER_PROFILE_STAYS_UNTOUCHED");
});

nativeTest("failed native Main health rolls back only guarded metadata, preserves installed Stable and keys", async (t) => {
  const f=await fixture(t);
  let restarts=0;
  const result=bridgeActivatedStableToMain({
    installation:f.installation,version:VERSION,homeDir:f.home,env:{},
    inspectInstallationImpl:async()=>({kind:"managed"}),
    enrollImpl:async()=>{
      await fs.writeFile(f.files.pointer,SHA,{mode:0o600});
      await fs.writeFile(f.files.stamp,JSON.stringify({bootstrapSha:SHA}),{mode:0o600});
      return {status:"enrolled",bootstrapSha:SHA};
    },
    restartImpl:async()=>{restarts++;},
    waitForMainImpl:async()=>{throw Error("SIMULATED_BAD_MAIN_HEALTH");},
    rollbackImpl:async({bootstrapSha})=>{
      assert.equal(bootstrapSha,SHA);
      assert.equal(await fs.readFile(f.files.pointer,"utf8"),SHA);
      await fs.rm(f.files.stamp);
      await fs.rm(f.files.pointer);
      return {rolledBack:true};
    },
    waitForStableImpl:async(version)=>{
      assert.equal(version,VERSION);
      assert.equal((await readManagedCurrentRelease(f.installation)).version,VERSION);
      await assert.rejects(fs.access(f.files.pointer),{code:"ENOENT"});
    },
  });
  await assert.rejects(result,/signed Stable baseline was restored/u);
  assert.equal(restarts,2);
  assert.equal(await fs.readFile(f.files.userSecret,"utf8"),"USER_SECRET_STAYS_UNTOUCHED");
  assert.equal(await fs.readFile(f.files.tunnelProfile,"utf8"),"USER_PROFILE_STAYS_UNTOUCHED");
  assert.equal((await readManagedCurrentRelease(f.installation)).version,VERSION);
});
