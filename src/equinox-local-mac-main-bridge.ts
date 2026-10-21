import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { launchDetachedHelper } from "./equinox-local-detached-helper.js";
import { bridgeActivatedStableToMain } from "./equinox-local-stable-main-bridge.js";
import { parseEquinoxVersion, compareEquinoxVersions } from "./equinox-local-updater.js";

type BridgeFs = typeof fs;
type BridgeInstallation = {
  kind?:string;
  managed?:boolean;
  selfUpdateSupported?:boolean;
  platform:string;
  arch:string;
  target:string;
  installRoot:string;
  releaseDir:string;
  releasesRoot:string;
};
type HelperLauncher = typeof launchDetachedHelper;
type MainBridge = typeof bridgeActivatedStableToMain;
type StateRecord = Record<string,unknown>;
type ScheduleOptions = {
  installation?:BridgeInstallation;
  platform?:string;
  env?:NodeJS.ProcessEnv;
  nodePath?:string;
  spawnImpl?:typeof spawn;
  fsImpl?:BridgeFs;
  launchHelperImpl?:HelperLauncher;
};
type WorkerOptions = {
  installation?:BridgeInstallation;
  version?:string;
  homeDir?:string;
  fsImpl?:BridgeFs;
  sleepImpl?:(ms:number)=>Promise<unknown>;
  bridgeImpl?:MainBridge;
};
function hasCode(error:unknown,code:string):boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
function stateOrNull(value:unknown):StateRecord|null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as StateRecord : null;
}

const MAX_STATE_BYTES = 4 * 1024;
const WAIT_ATTEMPTS = 90;

async function readSmallJson(filePath:string,fsImpl:BridgeFs = fs):Promise<StateRecord|null> {
  let handle;
  try {handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));}
  catch (error) {if (hasCode(error,"ENOENT")) return null;throw error;}
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_STATE_BYTES) {
      throw new Error("Stable migration state is unavailable or unsafe.");
    }
    return stateOrNull(JSON.parse(await handle.readFile("utf8")));
  } finally {await handle.close();}
}

export async function maybeScheduleMacStableMainBridge({
  installation,
  platform = process.platform,
  env = process.env,
  nodePath = process.execPath,
  spawnImpl = spawn,
  fsImpl = fs,
  launchHelperImpl = launchDetachedHelper,
}:ScheduleOptions = {}) {
  if (platform !== "darwin" || installation?.kind !== "managed" || !installation.selfUpdateSupported) {
    return Object.freeze({scheduled:false,reason:"not-legacy-mac-stable"});
  }
  // A *fresh* Stable install runs installer-owned enrollment; only a signed
  // update with an older release on disk needs this legacy-Mac worker.
  const releases = await fsImpl.readdir(installation.releasesRoot, {withFileTypes:true});
  if (!releases.some(entry => entry.isDirectory() && entry.name !== path.basename(installation.releaseDir))) {
    return Object.freeze({scheduled:false,reason:"first-install"});
  }
  // Do not skip if the old updater has already written `activated` before
  // this startup hook fires. It can win that race on a fast machine.
  // The per-version receipt below is the one-shot migration guard.
  const targetVersion = parseEquinoxVersion(path.basename(installation.releaseDir)).text;
  const receiptPath = path.join(installation.installRoot,`main-bridge-${targetVersion}.json`);
  if (await readSmallJson(receiptPath,fsImpl)) return Object.freeze({scheduled:false,reason:"bridge-already-attempted"});
  const environment:Record<string,string> = Object.fromEntries(Object.entries({
    HOME:env.HOME, USER:env.USER, LOGNAME:env.LOGNAME, TMPDIR:env.TMPDIR,
    PATH:"/usr/bin:/bin:/usr/sbin:/sbin",
    EQUINOX_LOCAL_INSTALL_ROOT:installation.installRoot,
    EQUINOX_LOCAL_RELEASE_DIR:installation.releaseDir,
  }).filter((entry):entry is [string,string] => typeof entry[1] === "string" && entry[1].length>0));
  await launchHelperImpl({
    spawnImpl,
    command:nodePath,
    args:[path.join(installation.releaseDir,"equinox-local-update-helper.js"),"--bridge-after-upgrade",targetVersion],
    options:{cwd:installation.releaseDir,detached:true,stdio:"ignore",env:environment},
    label:"Equinox Local macOS Stable-to-Main bridge",
  });
  return Object.freeze({scheduled:true,version:targetVersion});
}

export async function runMacStableMainBridgeWorker({
  installation,
  version,
  homeDir,
  fsImpl = fs,
  sleepImpl = ms => new Promise(resolve=>setTimeout(resolve,ms)),
  bridgeImpl = bridgeActivatedStableToMain,
}:WorkerOptions = {}) {
  if (installation?.platform !== "darwin" || !installation.managed || !installation.selfUpdateSupported) {
    throw new Error("macOS signed Stable migration requires managed product installation.");
  }
  const currentVersion = parseEquinoxVersion(version).text;
  const statePath = path.join(installation.installRoot,"update-state.json");
  let activated = false;
  for(let attempt=0;attempt<WAIT_ATTEMPTS;attempt++) {
    const state = await readSmallJson(statePath,fsImpl);
    if (state?.status === "activated" && state.version === currentVersion &&
      typeof state.previousVersion === "string" && compareEquinoxVersions(state.previousVersion,currentVersion)<0) {
      activated=true;
      break;
    }
    if(attempt+1<WAIT_ATTEMPTS) await sleepImpl(1000);
  }
  if(!activated) return Object.freeze({status:"not-activated"});
  const receiptPath = path.join(installation.installRoot,`main-bridge-${currentVersion}.json`);
  const attempted={schemaVersion:1,version:currentVersion,status:"attempted"};
  let handle;
  try {handle=await fsImpl.open(receiptPath,"wx",0o600);await handle.writeFile(JSON.stringify(attempted)+"\n");await handle.sync();}
  catch(error) {if(hasCode(error,"EEXIST")) return Object.freeze({status:"already-attempted"});throw error;}
  finally {await handle?.close();}
  let status:string;
  try {
    const result = await bridgeImpl({installation,version:currentVersion,homeDir:homeDir!});
    status = result.status;
  } catch {
    // Recovery happens in bridgeImpl. The attempted marker intentionally
    // blocks a restart loop, even after a failed/repeated native restart.
    status = "stable-recovery-needs-attention";
  }
  // Store only the allowlisted outcome, never raw error messages or keys.
  if (!["main-activated","already-enrolled","stable-recovery-needs-attention"].includes(status)) {
    status = "stable-recovery-needs-attention";
  }
  const temporary = `${receiptPath}.outcome-${process.pid}`;
  await fsImpl.writeFile(temporary,JSON.stringify({schemaVersion:1,version:currentVersion,status})+"\n",{mode:0o600,flag:"wx"});
  await fsImpl.rename(temporary,receiptPath);
  return Object.freeze({status});
}
