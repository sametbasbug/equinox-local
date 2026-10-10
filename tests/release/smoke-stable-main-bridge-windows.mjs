// Opt-in REAL hosted Windows x64/ARM64 shell and Control Center acceptance.
// Reuses the already-installed unsigned disposable test package, with its
// product-owned runtime and native WPF. Does NOT verify production signed
// 6.0.3 -> final bridge update; signing is an independent release gate.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveEquinoxLocalInstallation } from "../../src/equinox-local-installation.js";
import { readManagedCurrentRelease, waitForEquinoxLocalManagedSource, waitForEquinoxLocalVersion } from "../../src/equinox-local-update-activation.js";
import { rollbackEquinoxLocalManagedSourceEnrollment } from "../../src/equinox-local-managed-source-enrollment.js";
import { bridgeActivatedStableToMain } from "../../src/equinox-local-stable-main-bridge.js";
import { requestWindowsShellRuntimeRestart } from "../../src/equinox-local-windows-shell-control.js";

const SHA = /^[a-f0-9]{40}$/u;

async function main() {
  if (process.platform !== "win32" || !["x64","arm64"].includes(process.arch) ||
    process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) {
    throw new Error("Windows native Stable-to-Main bridge acceptance requires an isolated hosted Windows runner.");
  }
  const [installRoot,releaseDir,version,sourceSha]=process.argv.slice(2);
  const homeDir=process.env.USERPROFILE;
  if (!path.win32.isAbsolute(installRoot ?? "") || !path.win32.isAbsolute(releaseDir ?? "") ||
    !path.win32.isAbsolute(homeDir ?? "") || !/^\d+\.\d+\.\d+$/u.test(version ?? "") || !SHA.test(sourceSha ?? "")) {
    throw new Error("Native Windows Stable-to-Main bridge test requires an absolute owned install/release and exact identity.");
  }
  if (path.win32.dirname(releaseDir) !== path.win32.join(installRoot,"releases") ||
    path.win32.basename(releaseDir) !== version ||
    path.win32.normalize(installRoot).toLowerCase() !==
      path.win32.join(process.env.LOCALAPPDATA ?? "", "Equinox Local").toLowerCase()) {
    throw new Error("Refusing nonowned Windows installation bridge acceptance paths.");
  }
  const env={...process.env, EQUINOX_LOCAL_INSTALL_ROOT:installRoot,EQUINOX_LOCAL_RELEASE_DIR:releaseDir};
  const installation=resolveEquinoxLocalInstallation({homeDir,env});
  assert.equal(installation.kind,"managed");
  assert.equal(installation.target,`win32-${process.arch}`);
  assert.equal((await readManagedCurrentRelease(installation)).version,version);
  const stateRoot=path.join(installRoot,"state");
  const keyFile=path.join(installRoot,"secrets","openai-runtime-key");
  const keyBefore=await fs.readFile(keyFile).catch((error)=>error?.code==="ENOENT"?null:Promise.reject(error));
  const tunnelProfileDir=path.join(installRoot,"tunnel-profile");
  await fs.mkdir(tunnelProfileDir,{recursive:true});
  const profileMarker=path.join(tunnelProfileDir,"hosted-bridge-preserve.marker");
  const markerContent=`bridge-preserve-${process.pid}`;
  await fs.writeFile(profileMarker,markerContent,{flag:"wx",mode:0o600});
  const sourceCheckout=path.join(stateRoot,"main-update","sources",sourceSha);
  assert.ok((await fs.stat(path.join(sourceCheckout,"src","server.js"))).isFile());

  const healthyMain=async()=>waitForEquinoxLocalManagedSource(version,sourceSha,{attempts:180,delayMs:500});
  const healthyStable=async()=>waitForEquinoxLocalVersion(version,{attempts:180,delayMs:500,
    fetchImpl:async(...args)=>{
      const response=await fetch(...args);
      if (!response.ok) return response;
      const payload=await response.clone().json();
      if (payload?.status?.installation?.kind!=="managed") throw Error("Expected signed Stable runtime, not managed Main");
      return response;
    },
  });
  const revert=async()=>{
    const rollback=await rollbackEquinoxLocalManagedSourceEnrollment({
      bootstrapSha:sourceSha,target:installation.target,platform:"win32",arch:process.arch,homeDir,env,
    });
    assert.equal(rollback.rolledBack,true);
    await requestWindowsShellRuntimeRestart({platform:"win32"});
    await healthyStable();
  };

  await healthyMain();
  await revert();
  const options={installation,version,homeDir,env};
  assert.equal((await bridgeActivatedStableToMain(options)).status,"main-activated");
  await healthyMain();
  await revert();
  await assert.rejects(bridgeActivatedStableToMain({
    ...options,
    waitForMainImpl:async()=>{
      await healthyMain(); // Real native restart and Main health, then inject failure.
      throw Error("hosted test refuses otherwise healthy Main to exercise Stable rollback");
    },
  }),/signed Stable baseline was restored/u);
  await healthyStable();
  assert.equal((await bridgeActivatedStableToMain(options)).status,"main-activated");
  await healthyMain();
  const keyAfter=await fs.readFile(keyFile).catch((error)=>error?.code==="ENOENT"?null:Promise.reject(error));
  assert.deepEqual(keyAfter,keyBefore,"Windows runtime credential was altered during bridge and rollback");
  assert.equal(await fs.readFile(profileMarker,"utf8"),markerContent,
    "Windows owned tunnel-profile data was altered during bridge and rollback");
  assert.ok((await fs.stat(path.join(sourceCheckout,"src","server.js"))).isFile(),
    "rollback removed immutable managed source checkout");
  assert.equal((await readManagedCurrentRelease(installation)).version,version);
  process.stdout.write(JSON.stringify({ok:true,target:installation.target,version,bridge:"real-WPF-Control-Center",rollback:"recovered-Stable-then-rejoined-Main"})+"\n");
}
main().catch((error)=>{console.error(error instanceof Error?error.message:"Bridge acceptance failed");process.exitCode=1;});
