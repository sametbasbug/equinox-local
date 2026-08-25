import { pathToFileURL } from "node:url";

import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { kickstartEquinoxLocalLaunchAgent } from "./equinox-local-update-activation.js";

const START_DELAY_MS = 1_250;

export async function runEquinoxLocalRestartHelper({
  argv = process.argv.slice(2),
  env = process.env,
  homeDir = env.HOME,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  kickstartImpl = kickstartEquinoxLocalLaunchAgent,
} = {}) {
  if (argv.length !== 1 || argv[0] !== "--restart") {
    throw new Error("Usage: equinox-local-restart-helper.js --restart");
  }
  const installation = resolveEquinoxLocalInstallation({ homeDir, env });
  if (!installation.selfUpdateSupported) {
    throw new Error("Restart helper requires a managed Equinox Local installation.");
  }
  await sleepImpl(START_DELAY_MS);
  await kickstartImpl(installation);
  return Object.freeze({ restarted: true });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  runEquinoxLocalRestartHelper().catch(() => {
    process.exitCode = 1;
  });
}
