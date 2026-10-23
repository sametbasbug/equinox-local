import { pathToFileURL } from "node:url";

import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { activatePreparedEquinoxRelease, readManagedCurrentRelease } from "./equinox-local-update-activation.js";
import { pruneInactiveManagedStableReleases } from "./equinox-local-release-retention.js";
import { parseEquinoxVersion } from "./equinox-local-updater.js";
import { bridgeActivatedStableToMain } from "./equinox-local-stable-main-bridge.js";
import { runMacStableMainBridgeWorker } from "./equinox-local-mac-main-bridge.js";

type Installation = ReturnType<typeof resolveEquinoxLocalInstallation>;
type ManagedActivationInstallation = NonNullable<NonNullable<Parameters<typeof activatePreparedEquinoxRelease>[0]>["installation"]>;
type ManagedBridgeInstallation = NonNullable<NonNullable<Parameters<typeof bridgeActivatedStableToMain>[0]>["installation"]>;
type ManagedMacBridgeInstallation = NonNullable<NonNullable<Parameters<typeof runMacStableMainBridgeWorker>[0]>["installation"]>;
type AdmittedInstallation = Installation & ManagedActivationInstallation & ManagedBridgeInstallation & ManagedMacBridgeInstallation;
type Delay = (ms:number)=>Promise<unknown>;
type HelperOptions = {
  argv?:unknown;
  env?:NodeJS.ProcessEnv;
  homeDir?:string;
  sleepImpl?:Delay;
  activateImpl?:typeof activatePreparedEquinoxRelease;
  bridgeImpl?:typeof bridgeActivatedStableToMain;
  macBridgeWorkerImpl?:typeof runMacStableMainBridgeWorker;
  pruneStableImpl?:(value:Installation)=>Promise<Awaited<ReturnType<typeof pruneInactiveManagedStableReleases>>>;
};
function failureMessage(error:unknown):string {
  if (error !== null && typeof error === "object" && "message" in error &&
      error.message !== null && error.message !== undefined) return String(error.message);
  return String(error);
}

const START_DELAY_MS = 1_500;

export async function runEquinoxLocalUpdateHelper({
  argv = process.argv.slice(2),
  env = process.env,
  homeDir = env.USERPROFILE ?? env.HOME,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  activateImpl = activatePreparedEquinoxRelease,
  bridgeImpl = bridgeActivatedStableToMain,
  macBridgeWorkerImpl = runMacStableMainBridgeWorker,
  pruneStableImpl = (value) => pruneInactiveManagedStableReleases(value, { readCurrent: readManagedCurrentRelease }),
}:HelperOptions = {}) {
  if (!Array.isArray(argv) || argv.length !== 2 || !["--activate", "--bridge-after-upgrade"].includes(argv[0])) {
    throw new Error("Usage: equinox-local-update-helper.js --activate|--bridge-after-upgrade <version>");
  }
  const targetVersion = parseEquinoxVersion(argv[1]).text;
  const installation = resolveEquinoxLocalInstallation({homeDir:homeDir!,env});
  if (!installation.selfUpdateSupported) {
    throw new Error("Update helper requires a managed Equinox Local installation.");
  }

  // The installation resolver already applies runtime managed/ownership checks.
  // Its union result retains nullable fields for unsupported source installations.
  const admitted = installation as AdmittedInstallation;
  if (argv[0] === "--bridge-after-upgrade") {
    if (installation.platform !== "darwin") throw new Error("Stable Main startup bridge is macOS-only.");
    return macBridgeWorkerImpl({installation:admitted,version:targetVersion,homeDir:homeDir!});
  }
  await sleepImpl(START_DELAY_MS);
  const activation = await activateImpl({ installation:admitted, targetVersion });
  if (activation?.status === "activated" || activation?.status === "already-active") {
    // The *new*, signed Stable release helper is the bridge for previously
    // installed Stable clients. The old updater has no dependency on this code.
    const bridge = await bridgeImpl({installation:admitted,version:targetVersion,homeDir:homeDir!,env});
    // The old numbered Stable versions are no longer needed after the new
    // Stable runtime AND Main bridge have both been confirmed. Deleting them
    // before either health gate succeeds would remove rollback protection.
    let releaseCleanup;
    try { releaseCleanup = await pruneStableImpl(installation); }
    catch (error) {
      // An already healthy installation must never be rolled back because an
      // obsolete Windows directory remains locked. Surface the cleanup error
      // so the next guarded maintenance pass can retry it.
      releaseCleanup = { pending: true, reason: failureMessage(error).slice(0, 240) };
    }
    return Object.freeze({ ...activation, mainBridge: bridge.status, releaseCleanup });
  }
  return activation;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  runEquinoxLocalUpdateHelper().catch(() => {
    process.exitCode = 1;
  });
}
