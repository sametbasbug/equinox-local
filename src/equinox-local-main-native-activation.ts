import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  assertWindowsNativeMessagingHostOwnership,
  registerWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from "./equinox-browser-windows-native-messaging.js";
import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { validateTrustedMainInstallPointer } from "./equinox-local-main-install-pointer.js";
import {
  promoteEquinoxLocalMainNativeCandidate,
  inspectEquinoxLocalMainNativeStoredRelease,
  readEquinoxLocalMainNativePointer,
  writeEquinoxLocalMainNativePointer,
} from "./equinox-local-main-native-state.js";
import {
  inspectEquinoxLocalNativeAppHostSnapshot,
  restoreEquinoxLocalNativeAppHostSnapshot,
  snapshotEquinoxLocalNativeAppHost,
  synchronizeEquinoxLocalAppHostForRelease,
} from "./equinox-local-native-app-host.js";
import { writeEquinoxLocalMainNativeRecoveryDescriptor } from "./equinox-local-main-native-recovery.js";
import { bootstrapManagedEquinoxUser, appRuntimeWrapper, launchAgentPlist, nativeHostManifest, nativeHostWrapper, EQUINOX_BROWSER_NATIVE_HOST_NAME, EQUINOX_LOCAL_LAUNCH_AGENT_LABEL } from "./equinox-local-bootstrap.js";
import { equinoxLocalAppPath, equinoxLocalAppExecutablePath, equinoxLocalAppRuntimeWrapperPath } from "./equinox-local-app-host.js";
import { assertEquinoxLocalFreshNativeAppHostOwned } from "./equinox-local-native-app-host.js";
import { createEquinoxLocalMainMacCurrentLinkTransition, createEquinoxLocalMainNativePointerTransition } from "./equinox-local-main-native-pointer-transition.js";
import { createSupervisorBoundWindowsNativeABLifecycle, requireWindowsNativeABSupervisor } from "./equinox-local-windows-native-ab-supervisor-bound.js";

type NativeFilesystem = typeof fs;
type NativeExec = typeof execFile;
type Installation = ReturnType<typeof resolveEquinoxLocalInstallation>;
type NativeTransition = {
  mode: string; target: string; currentSha: string; targetSha: string;
  currentRuntimeContractSha256: string; targetRuntimeContractSha256: string;
};
type NativeCandidate = {
  sourceSha: string; target: string; transactionId: string;
  runtimeContractSha256: string; artifactSha256: string;
  artifactBytes: number; payloadVersion: string; releaseDir: string;
};
type NativeStore = {
  sourceSha: string; target: string; runtimeContractSha256: string; releaseDir: string;
};
type SignedStoredCandidate = Readonly<{
  sourceSha:string;target:string;runtimeContractSha256:string;artifactSha256:string;
  artifactBytes:number;payloadVersion:string;
}>;
type NativePointer = Readonly<{
  sourceSha: string; target: string; runtimeContractSha256: string; releaseDir?: string;
}>;
type PromoteCandidate = (options: {
  candidate: NativeCandidate; transactionRoot: string; transactionId: string; fsImpl: NativeFilesystem;
}) => Promise<NativeStore>;
type ReadNativePointer = typeof readEquinoxLocalMainNativePointer;
type SnapshotDarwin = (options: {
  homeDir: string; snapshotPath: string; fsImpl: NativeFilesystem; execFileImpl: NativeExec;
}) => Promise<unknown>;
type RecoveryDescriptorWriter = typeof writeEquinoxLocalMainNativeRecoveryDescriptor;
type NativeActivationOptions = {
  transition?: NativeTransition; candidate?: NativeCandidate;
  storedCandidate?: SignedStoredCandidate; signedPointer?: unknown;
  transactionRoot?: string; transactionId?: string;
  installation?: Installation; fsImpl?: NativeFilesystem;
  execFileImpl?: NativeExec; env?: NodeJS.ProcessEnv; windowsAdmission?: unknown;
  createBoundWindowsABImpl?: (options: Record<string, unknown>) => unknown;
  promoteCandidateImpl?: PromoteCandidate;
  inspectStoredImpl?: typeof inspectEquinoxLocalMainNativeStoredRelease;
  verifySignedPointerImpl?: typeof validateTrustedMainInstallPointer;
  readPointerImpl?: ReadNativePointer;
  writePointerImpl?: typeof writeEquinoxLocalMainNativePointer;
  snapshotDarwinImpl?: SnapshotDarwin;
  inspectDarwinSnapshotImpl?: typeof inspectEquinoxLocalNativeAppHostSnapshot;
  activateDarwinImpl?: typeof synchronizeEquinoxLocalAppHostForRelease;
  restoreDarwinImpl?: typeof restoreEquinoxLocalNativeAppHostSnapshot;
  assertWindowsNativeHostImpl?: typeof assertWindowsNativeMessagingHostOwnership;
  registerWindowsNativeHostImpl?: typeof registerWindowsNativeMessagingHost;
  windowsLauncherPathImpl?: typeof windowsNativeMessagingLauncherPath;
  writeRecoveryDescriptorImpl?: RecoveryDescriptorWriter;
  createPointerTransitionImpl?: typeof createEquinoxLocalMainNativePointerTransition;
  createMacLinkTransitionImpl?: typeof createEquinoxLocalMainMacCurrentLinkTransition;
};
function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

const execFile = promisify(execFileCallback);

function requireAbsolute(value: unknown, label: string, pathApi: typeof path = path): string {
  if (typeof value !== "string" || !pathApi.isAbsolute(value)) throw new Error(`${label} must be absolute.`);
  return pathApi.resolve(value);
}

async function readPreviousPointer(pointerPath: string, options: {transactionRoot: string; fsImpl: NativeFilesystem}, readPointerImpl: ReadNativePointer): Promise<NativePointer | null> {
  try {
    return await readPointerImpl(pointerPath, options);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

// The SAME immutable native B pointer/link and original managed bootstrap
// work on a genuinely empty macOS A. This is a lifecycle, not a second
// installer/engine: the existing signed owner, receipt, worker and exact SHA
// health protocol decide commit vs rollback.
export async function createEquinoxLocalMainMacFreshFirstLifecycle({
  transactionRoot, target, sourceSha, runtimeContractSha256, releaseDir,
  homeDir, uid=process.getuid?.(),fsImpl=fs,execFileImpl=execFile,
  bootstrapImpl=bootstrapManagedEquinoxUser,
  assertAppOwnedImpl=assertEquinoxLocalFreshNativeAppHostOwned,
  createPointerImpl=createEquinoxLocalMainNativePointerTransition,
  createLinkImpl=createEquinoxLocalMainMacCurrentLinkTransition,
}:{
  transactionRoot:string;target:string;sourceSha:string;runtimeContractSha256:string;
  releaseDir:string;homeDir:string;uid?:number|null;
  fsImpl?:NativeFilesystem;execFileImpl?:NativeExec;
  bootstrapImpl?:typeof bootstrapManagedEquinoxUser;
  assertAppOwnedImpl?:typeof assertEquinoxLocalFreshNativeAppHostOwned;
  createPointerImpl?:typeof createEquinoxLocalMainNativePointerTransition;
  createLinkImpl?:typeof createEquinoxLocalMainMacCurrentLinkTransition;
}){
  const installRoot=path.posix.join(homeDir,"Library","Application Support","Equinox Local");
  if(process.platform!=="darwin" || !["darwin-arm64","darwin-x64"].includes(target) ||
     !/^[a-f0-9]{40}$/u.test(sourceSha) ||
     !/^[a-f0-9]{64}$/u.test(runtimeContractSha256) ||
     !path.posix.isAbsolute(homeDir) || path.posix.normalize(homeDir)!==homeDir ||
     transactionRoot!==path.posix.join(installRoot,"main-update") ||
     releaseDir!==path.posix.join(transactionRoot,"native-store",target,sourceSha,"release") ||
     !Number.isSafeInteger(uid)||uid===null||uid===undefined||uid<1){
    throw new Error("Clean native Main first-install lifecycle has an inauthentic OS and B identity.");
  }
  const pointerValue={schemaVersion:1 as const,channel:"main" as const,
    sourceSha,target,runtimeContractSha256};
  const native=createPointerImpl({pointerPath:path.posix.join(transactionRoot,"current-native.json"),
    transactionRoot,target:pointerValue,previous:null,fsImpl});
  const link=createLinkImpl({installRoot,target:pointerValue,previousReleaseDir:null,fsImpl});
  const agentPath=path.posix.join(homeDir,"Library","LaunchAgents",
    EQUINOX_LOCAL_LAUNCH_AGENT_LABEL+".plist");
  const service="gui/"+uid+"/"+EQUINOX_LOCAL_LAUNCH_AGENT_LABEL;
  const nativeHostPath=path.posix.join(homeDir,"Library","Application Support",
    "Google","Chrome","NativeMessagingHosts",EQUINOX_BROWSER_NATIVE_HOST_NAME+".json");
  const wrapperPath=equinoxLocalAppRuntimeWrapperPath(homeDir);
  const nativeWrapperPath=path.posix.join(installRoot,"equinox-browser-native-host");
  const generatedFiles=[
    {name:agentPath,text:launchAgentPlist({homeDir,installRoot})},
    {name:wrapperPath,text:appRuntimeWrapper({installRoot})},
    {name:nativeWrapperPath,text:nativeHostWrapper({installRoot})},
    {name:nativeHostPath,text:nativeHostManifest(nativeWrapperPath)},
  ];
  const originalLaunchAgentAbsent=async()=>{
    try{
      await execFileImpl("/bin/launchctl",["print",service],{
        timeout:5000,maxBuffer:65536,
      });
      throw new Error("Clean native Main cannot replace an existing loaded user LaunchAgent.");
    }catch(error){
      const e=error as {code?:unknown;stderr?:unknown};
      if(e.code!==113 || !String(e.stderr??"").includes(
        'Could not find service "'+EQUINOX_LOCAL_LAUNCH_AGENT_LABEL+'" in domain for user gui: '+uid)){
        throw new Error("Clean native Main LaunchAgent absence is not explicitly proven.");
      }
    }
    await execFileImpl("/bin/launchctl",["print","gui/"+uid],{
      timeout:5000,maxBuffer:65536,
    });
  };
  const statOrNull=async(name:string)=>{
    try{return await fsImpl.lstat(name);}
    catch(error){if(hasErrorCode(error,"ENOENT"))return null;throw error;}
  };
  const assertGenerated=async()=>{
    for(const file of generatedFiles){
      const stat=await statOrNull(file.name);
      if(!stat)continue; // interrupted bootstrap, not a foreign file
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||
         (await fsImpl.readFile(file.name,"utf8"))!==file.text){
        throw new Error("Clean native Main generated artifact changed outside this signed install.");
      }
    }
    if(await statOrNull(equinoxLocalAppPath(homeDir))){
      await assertAppOwnedImpl({homeDir,releaseDir,fsImpl,execFileImpl});
    }
  };
  const assertNoOriginalArtifacts=async()=>{
    for(const file of [...generatedFiles.map(value=>value.name),equinoxLocalAppPath(homeDir)]){
      if(await statOrNull(file)){
        throw new Error("Clean native Main would overwrite a pre-existing user app/LaunchAgent/Native Messaging artifact.");
      }
    }
  };
  return Object.freeze({
    previousPointer:null,firstInstall:true,stored:{releaseDir,sourceSha,target,runtimeContractSha256},
    async activate(){
      // Recheck independent launchd ownership and original nonexistence
      // BEFORE the B pointer changes, not only in HTTP installer admission.
      await assertNoOriginalArtifacts();
      await originalLaunchAgentAbsent();
      await native.selectTarget();
      await link.selectTarget();
      await bootstrapImpl({homeDir,platform:"darwin",arch:target.slice(7),fsImpl});
      await assertGenerated();
      // This is the FIRST launch of the original managed LaunchAgent, so
      // kickstart alone cannot work. Later worker restart validates B health.
      await execFileImpl("/bin/launchctl",["bootstrap","gui/"+uid,agentPath],{
        timeout:15000,maxBuffer:1024*1024,
      });
    },
    async rollback(){
      // Fail CLOSED if any bootstrap path was replaced by user/foreign bytes.
      // Preserve config, workspace, downloads and all user-generated data.
      await native.assertRollbackAdmitted();
      const current=await link.current();
      if(current!==null && current!==link.targetReleaseDir){
        throw new Error("Clean native Main rollback current symlink is foreign.");
      }
      await assertGenerated();
      let running=false;
      try{
        const status=await execFileImpl("/bin/launchctl",["print",service],{
          timeout:5000,maxBuffer:65536,
        });
        const output=String(status.stdout??"");
        const appExe=equinoxLocalAppExecutablePath(homeDir);
        if(!output.includes(appExe) || !(await statOrNull(agentPath))){
          throw new Error("Clean native Main cannot bootout an unauthenticated LaunchAgent.");
        }
        running=true;
      }catch(error){
        const e=error as {code?:unknown;stderr?:unknown};
        if(e.code!==113||!String(e.stderr??"").includes(
          'Could not find service "'+EQUINOX_LOCAL_LAUNCH_AGENT_LABEL+'" in domain for user gui: '+uid)){
          throw error;
        }
      }
      if(running){
        await execFileImpl("/bin/launchctl",["bootout",service],{
          timeout:15000,maxBuffer:1024*1024,
        });
      }
      await originalLaunchAgentAbsent();
      // Deleting foreign or modified bytes is categorically forbidden.
      await assertGenerated();
      for(const file of generatedFiles){
        if(await statOrNull(file.name))await fsImpl.unlink(file.name);
      }
      const app=equinoxLocalAppPath(homeDir);
      if(await statOrNull(app))await fsImpl.rm(app,{recursive:true,force:false});
      await link.restorePrevious();
      await native.restorePrevious();
      if(await link.current()!==null){
        throw new Error("Clean native Main rollback failed to clear B current link.");
      }
      return Object.freeze({restoredEmptyA:true});
    },
    async commit(){
      await native.requireTarget();
      if(await link.current()!==link.targetReleaseDir){
        throw new Error("Clean native Main first install has no committed B symlink.");
      }
      await assertGenerated();
      return Object.freeze({sourceSha,target,releaseDir});
    },
  });
}

export async function prepareEquinoxLocalMainNativeLifecycle({
  transition,
  candidate,
  storedCandidate,
  signedPointer,
  transactionRoot,
  transactionId,
  installation = resolveEquinoxLocalInstallation(),
  fsImpl = fs,
  execFileImpl = execFile,
  env = process.env,
  windowsAdmission = null,
  createBoundWindowsABImpl = createSupervisorBoundWindowsNativeABLifecycle,
  promoteCandidateImpl = promoteEquinoxLocalMainNativeCandidate,
  inspectStoredImpl = inspectEquinoxLocalMainNativeStoredRelease,
  verifySignedPointerImpl = validateTrustedMainInstallPointer,
  readPointerImpl = readEquinoxLocalMainNativePointer,
  writePointerImpl = writeEquinoxLocalMainNativePointer,
  snapshotDarwinImpl = snapshotEquinoxLocalNativeAppHost,
  inspectDarwinSnapshotImpl = inspectEquinoxLocalNativeAppHostSnapshot,
  activateDarwinImpl = synchronizeEquinoxLocalAppHostForRelease,
  restoreDarwinImpl = restoreEquinoxLocalNativeAppHostSnapshot,
  assertWindowsNativeHostImpl = assertWindowsNativeMessagingHostOwnership,
  registerWindowsNativeHostImpl = registerWindowsNativeMessagingHost,
  windowsLauncherPathImpl = windowsNativeMessagingLauncherPath,
  writeRecoveryDescriptorImpl = writeEquinoxLocalMainNativeRecoveryDescriptor,
  createPointerTransitionImpl = createEquinoxLocalMainNativePointerTransition,
  createMacLinkTransitionImpl = createEquinoxLocalMainMacCurrentLinkTransition,
}: NativeActivationOptions = {}) {
  if (transition?.mode !== "artifact_required") throw new Error("Main native lifecycle requires an artifact-required transition.");
  if (Boolean(candidate) === Boolean(storedCandidate)) {
    throw new Error("Main native lifecycle requires exactly one transient or signed durable candidate.");
  }
  if (candidate && (candidate.sourceSha !== transition.targetSha || candidate.target !== transition.target ||
      candidate.runtimeContractSha256 !== transition.targetRuntimeContractSha256)) {
    throw new Error("Main native lifecycle candidate identity does not match the exact transition.");
  }
  if (storedCandidate) {
    // The independent external installer previously admitted this inactive
    // immutable release. Reauthenticate the ORIGINAL production-root selector
    // before touching any running WPF/app, pointer or rollback snapshot.
    const signed = verifySignedPointerImpl(signedPointer, {expectedSourceSha:transition.targetSha});
    const selected = signed.targets.find(entry=>entry.target===transition.target);
    if (!selected || storedCandidate.sourceSha !== signed.sourceSha ||
        storedCandidate.target !== transition.target ||
        storedCandidate.runtimeContractSha256 !== selected.runtimeContractSha256 ||
        storedCandidate.runtimeContractSha256 !== transition.targetRuntimeContractSha256 ||
        storedCandidate.artifactSha256 !== selected.artifact.sha256 ||
        storedCandidate.artifactBytes !== selected.artifact.bytes ||
        storedCandidate.payloadVersion !== signed.version) {
      throw new Error("Signed Main stored native candidate differs from exact production selector.");
    }
  }
  if (!installation?.managed || !installation?.selfUpdateSupported || installation.target !== transition.target) {
    throw new Error("Main native lifecycle requires the matching managed Equinox Local installation.");
  }
  // A native-impact Windows detached worker always has a journal admission.
  // Refuse absence of a separate OS supervisor before promoting even the
  // inactive payload; never fall back to the legacy ephemeral A backup.
  const id = transactionId!;
  if (transition.target.startsWith("win32-")) {
    // A verified detached Node worker is not an independent native WPF owner.
    // Refuse legacy A/B promotion BEFORE writing any inactive release content.
    requireWindowsNativeABSupervisor({ windowsAdmission, transition, transactionId: id });
  }
  const root = requireAbsolute(transactionRoot, "Main native transaction root");
  const durable = storedCandidate
    ? await inspectStoredImpl({transactionRoot:root,sourceSha:storedCandidate.sourceSha,
      target:storedCandidate.target,
      expectedRuntimeContractSha256:storedCandidate.runtimeContractSha256,fsImpl})
    : null;
  if (storedCandidate && durable && (
      durable.manifest.artifactSha256 !== storedCandidate.artifactSha256 ||
      durable.manifest.artifactBytes !== storedCandidate.artifactBytes ||
      durable.payloadVersion !== storedCandidate.payloadVersion)) {
    throw new Error("Signed Main durable native manifest does not match authenticated archive/version.");
  }
  const stored = durable ?? await promoteCandidateImpl({ candidate: candidate!, transactionRoot: root, transactionId: id, fsImpl });
  if (stored.sourceSha !== transition.targetSha || stored.target !== transition.target || stored.runtimeContractSha256 !== transition.targetRuntimeContractSha256) {
    throw new Error("Main native durable payload identity drifted from the exact transition.");
  }

  const pointerPath = path.join(root, "current-native.json");
  const previousPointer = await readPreviousPointer(pointerPath, { transactionRoot: root, fsImpl }, readPointerImpl);
  if (previousPointer && (previousPointer.target !== transition.target ||
      previousPointer.sourceSha !== transition.currentSha ||
      previousPointer.runtimeContractSha256 !== transition.currentRuntimeContractSha256)) {
    throw new Error("Installed Main native pointer does not match the current source SHA/runtime contract.");
  }
  // The exact SAME signed native Main owner can first-install on an empty
  // machine without a fake Stable A. No snapshot exists for a nonexistent A;
  // original bootstrap and clean no-A rollback live in this same lifecycle.
  if(storedCandidate && transition.target.startsWith("darwin-") &&
     previousPointer===null && installation.releaseDir===null){
    await writeRecoveryDescriptorImpl({transition,previousPointer,installation,
      transactionRoot:root,transactionId:id,fsImpl});
    const homeDir=path.posix.dirname(path.posix.dirname(path.posix.dirname(
      path.posix.resolve(installation.installRoot!))));
    const fresh=await createEquinoxLocalMainMacFreshFirstLifecycle({
      transactionRoot:root,target:transition.target,
      sourceSha:transition.targetSha,
      runtimeContractSha256:transition.targetRuntimeContractSha256,
      releaseDir:stored.releaseDir,homeDir,fsImpl,execFileImpl,
    });
    return Object.freeze({...fresh,target:transition.target,stored,
      previousPointer:null,rollbackPath:null});
  }
  const previousReleaseDir = previousPointer?.releaseDir ?? installation.releaseDir;
  if (typeof previousReleaseDir !== "string") throw new Error("Previous managed native release is unavailable.");

  const rollbackRoot = path.join(root, "staging", id, "native-rollback");
  const pointerValue = Object.freeze({
    schemaVersion: 1,
    channel: "main",
    sourceSha: transition.targetSha,
    target: transition.target,
    runtimeContractSha256: transition.targetRuntimeContractSha256,
  });

  if (transition.target.startsWith("darwin-")) {
    const homeDir = requireAbsolute(installation.installRoot, "Managed installation root").replace(/\/Library\/Application Support\/Equinox Local$/u, "");
    if (!homeDir || path.join(homeDir, "Library", "Application Support", "Equinox Local") !== path.resolve(requireAbsolute(installation.installRoot, "Managed installation root"))) {
      throw new Error("Managed macOS installation root cannot be mapped to the user home directory.");
    }
    const snapshotPath = path.join(rollbackRoot, "Equinox Local.app");
    try {
      await snapshotDarwinImpl({ homeDir, snapshotPath, fsImpl, execFileImpl });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      await inspectDarwinSnapshotImpl({ snapshotPath, fsImpl, execFileImpl });
    }
    await writeRecoveryDescriptorImpl({ transition, previousPointer, installation, transactionRoot: root, transactionId: id, fsImpl });
    if (storedCandidate) {
      // The external signed installer installs a Git-free native process.
      // BOTH pointers must select B before LaunchAgent restart, otherwise
      // the supervisor cannot verify the exact source SHA. Keep the existing
      // transient Git-backed worker's post-health commit semantics unchanged.
      const nativePointer = createPointerTransitionImpl({
        pointerPath, transactionRoot:root, target:pointerValue,
        previous:previousPointer, fsImpl, readPointer:readPointerImpl, writePointer:writePointerImpl,
      });
      const macLink = createMacLinkTransitionImpl({
        installRoot:installation.installRoot!,target:pointerValue,
        previousReleaseDir,fsImpl,
      });
      return Object.freeze({
        target:transition.target,stored,previousPointer,rollbackPath:snapshotPath,
        activate:async()=>{
          await nativePointer.selectTarget();
          await macLink.selectTarget();
          await activateDarwinImpl({installation,releaseDir:stored.releaseDir,fsImpl,execFileImpl,requirePayloadIdentity:true});
        },
        rollback:async()=>{
          // Strict reverse of A->B ownership. Every step is idempotent for
          // interrupted journal replay, and foreign pointer drift aborts.
          // Preflight BOTH pointers before mutating either: foreign owners
          // cannot trick partial rollback into mixing A and another SHA.
          const observedLink=await macLink.current();
          if(observedLink!==previousReleaseDir && observedLink!==macLink.targetReleaseDir){
            throw new Error("Signed native Mac rollback link is outside admitted A/B.");
          }
          await nativePointer.assertRollbackAdmitted();
          await macLink.restorePrevious();
          await nativePointer.restorePrevious();
          await restoreDarwinImpl({homeDir,snapshotPath,fsImpl,execFileImpl});
        },
        commit:async()=>{
          await nativePointer.requireTarget();
          if(await macLink.current()!==macLink.targetReleaseDir){
            throw new Error("Signed native B macOS runtime link is not durably selected.");
          }
          return stored;
        },
      });
    }
    return Object.freeze({
      target: transition.target,
      stored,
      previousPointer,
      rollbackPath: snapshotPath,
      activate: async () => activateDarwinImpl({ installation, releaseDir: stored.releaseDir, fsImpl, execFileImpl, requirePayloadIdentity: true }),
      rollback: async () => restoreDarwinImpl({ homeDir, snapshotPath, fsImpl, execFileImpl }),
      commit: async () => writePointerImpl(pointerPath, pointerValue, { transactionRoot: root, fsImpl }),
    });
  }

  if (!transition.target.startsWith("win32-")) throw new Error("Main native lifecycle target is unsupported.");
  const programRoot = requireAbsolute(installation.programRoot, "Managed Windows program root", path.win32);
  const manifestRoot = requireAbsolute(installation.nativeMessagingManifestRoot, "Managed Windows Native Messaging root", path.win32);
  const previousRelease = requireAbsolute(previousReleaseDir, "Previous Windows native release", path.win32);
  const targetRelease = requireAbsolute(stored.releaseDir, "Target Windows native release", path.win32);
  // The independent native supervisor owns exactly one A/B rollback slot.
  // Preserve the source receipt's recovery identity, but do not snapshot the
  // old WPF tree or create a second legacy pointer-transition state machine.
  await writeRecoveryDescriptorImpl({ transition, previousPointer, installation, transactionRoot: root, transactionId: id, fsImpl });
  return createBoundWindowsABImpl({ windowsAdmission, transition, transactionId: id, stored, previousPointer,
    previousReleaseDir: previousRelease, programRoot, manifestRoot, transactionRoot: root, pointerPath,
    fsImpl, execFileImpl, env, writePointerImpl, assertNativeHostImpl: assertWindowsNativeHostImpl,
    registerNativeHostImpl: registerWindowsNativeHostImpl, launcherPathImpl: windowsLauncherPathImpl });
}
