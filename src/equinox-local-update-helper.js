import { pathToFileURL } from "node:url";

import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { activatePreparedEquinoxRelease } from "./equinox-local-update-activation.js";
import { parseEquinoxVersion } from "./equinox-local-updater.js";
import { bridgeActivatedStableToMain } from "./equinox-local-stable-main-bridge.js";
import { runMacStableMainBridgeWorker } from "./equinox-local-mac-main-bridge.js";

const START_DELAY_MS = 1_500;

export async function runEquinoxLocalUpdateHelper({
  argv = process.argv.slice(2),
  env = process.env,
  homeDir = env.USERPROFILE ?? env.HOME,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  activateImpl = activatePreparedEquinoxRelease,
  bridgeImpl = bridgeActivatedStableToMain,
  macBridgeWorkerImpl = runMacStableMainBridgeWorker,
} = {}) {
  if (argv.length !== 2 || !["--activate", "--bridge-after-upgrade"].includes(argv[0])) {
    throw new Error("Usage: equinox-local-update-helper.js --activate|--bridge-after-upgrade <version>");
  }
  const targetVersion = parseEquinoxVersion(argv[1]).text;
  const installation = resolveEquinoxLocalInstallation({ homeDir, env });
  if (!installation.selfUpdateSupported) {
    throw new Error("Update helper requires a managed Equinox Local installation.");
  }

  if (argv[0] === "--bridge-after-upgrade") {
    if (installation.platform !== "darwin") throw new Error("Stable Main startup bridge is macOS-only.");
    return macBridgeWorkerImpl({installation,version:targetVersion,homeDir});
  }
  await sleepImpl(START_DELAY_MS);
  const activation = await activateImpl({ installation, targetVersion });
  if (activation?.status === "activated" || activation?.status === "already-active") {
    // The *new*, signed Stable release helper is the bridge for previously
    // installed Stable clients. The old updater has no dependency on this code.
    const bridge = await bridgeImpl({ installation, version: targetVersion, homeDir, env });
    return Object.freeze({ ...activation, mainBridge: bridge.status });
  }
  return activation;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  runEquinoxLocalUpdateHelper().catch(() => {
    process.exitCode = 1;
  });
}
