import { pathToFileURL } from "node:url";

import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { activatePreparedEquinoxRelease } from "./equinox-local-update-activation.js";
import { parseEquinoxVersion } from "./equinox-local-updater.js";

const START_DELAY_MS = 1_500;

export async function runEquinoxLocalUpdateHelper({
  argv = process.argv.slice(2),
  env = process.env,
  homeDir = env.HOME,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  activateImpl = activatePreparedEquinoxRelease,
} = {}) {
  if (argv.length !== 2 || argv[0] !== "--activate") {
    throw new Error("Usage: equinox-local-update-helper.js --activate <version>");
  }
  const targetVersion = parseEquinoxVersion(argv[1]).text;
  const installation = resolveEquinoxLocalInstallation({ homeDir, env });
  if (!installation.selfUpdateSupported) {
    throw new Error("Update helper requires a managed Equinox Local installation.");
  }

  await sleepImpl(START_DELAY_MS);
  return activateImpl({ installation, targetVersion });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  runEquinoxLocalUpdateHelper().catch(() => {
    process.exitCode = 1;
  });
}
