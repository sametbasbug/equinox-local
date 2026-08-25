import { spawn as spawnChild } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_HELPER_PATH = fileURLToPath(new URL("./equinox-local-uninstall-helper.js", import.meta.url));

export function uninstallHelperEnvironment(installation, sourceEnv = process.env) {
  const env = {
    HOME: sourceEnv.HOME,
    USER: sourceEnv.USER,
    LOGNAME: sourceEnv.LOGNAME,
    TMPDIR: sourceEnv.TMPDIR,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    EQUINOX_LOCAL_INSTALL_ROOT: installation?.installRoot,
    EQUINOX_LOCAL_RELEASE_DIR: installation?.releaseDir,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string" && value.length > 0));
}

export function scheduleEquinoxLocalUninstall({
  installation,
  removeUserData = false,
  spawnImpl = spawnChild,
  nodePath = process.execPath,
  helperPath = DEFAULT_HELPER_PATH,
  sourceEnv = process.env,
} = {}) {
  if (!installation?.selfUpdateSupported || !installation?.managed) {
    throw new Error("A managed Equinox Local installation is required to schedule uninstall.");
  }
  if (typeof removeUserData !== "boolean") throw new Error("removeUserData must be boolean.");
  const mode = removeUserData ? "--remove-user-data" : "--preserve-user-data";
  const child = spawnImpl(nodePath, [helperPath, "--uninstall", mode], {
    detached: true,
    stdio: "ignore",
    env: uninstallHelperEnvironment(installation, sourceEnv),
  });
  if (!child || typeof child.unref !== "function") {
    throw new Error("Equinox Local uninstall helper failed to start.");
  }
  child.unref();
  return Object.freeze({ scheduled: true, removeUserData });
}
