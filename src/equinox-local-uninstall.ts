import { spawn as spawnChild } from "node:child_process";
import { fileURLToPath } from "node:url";

import { launchDetachedHelper } from "./equinox-local-detached-helper.js";
import { requestWindowsShellManagedUninstall } from "./equinox-local-windows-shell-control.js";
import { projectDarwinDetachedHelperEnvironment } from "./equinox-local-darwin-helper-environment.js";

type UninstallInstallation = Readonly<{
  managed?: boolean;
  selfUpdateSupported?: boolean;
  platform?: string;
  installRoot?: string;
  releaseDir?: string;
}>;
type UninstallOptions = Readonly<{
  installation?: UninstallInstallation;
  removeUserData?: unknown;
  spawnImpl?: typeof spawnChild;
  nodePath?: string;
  helperPath?: string;
  sourceEnv?: NodeJS.ProcessEnv;
  requestWindowsUninstallImpl?: typeof requestWindowsShellManagedUninstall;
}>;

const DEFAULT_HELPER_PATH = fileURLToPath(new URL("./equinox-local-uninstall-helper.js", import.meta.url));

export function uninstallHelperEnvironment(installation: UninstallInstallation, sourceEnv: NodeJS.ProcessEnv = process.env): Record<string,string> {
  return projectDarwinDetachedHelperEnvironment({ installation, sourceEnv });
}

export async function scheduleEquinoxLocalUninstall({
  installation,
  removeUserData = false,
  spawnImpl = spawnChild,
  nodePath = process.execPath,
  helperPath = DEFAULT_HELPER_PATH,
  sourceEnv = process.env,
  requestWindowsUninstallImpl = requestWindowsShellManagedUninstall,
}: UninstallOptions = {}) {
  if (!installation?.selfUpdateSupported || !installation?.managed) {
    throw new Error("A managed Equinox Local installation is required to schedule uninstall.");
  }
  if (typeof removeUserData !== "boolean") throw new Error("removeUserData must be boolean.");
  if (installation.platform === "win32") {
    const acknowledgement = await requestWindowsUninstallImpl(removeUserData, { platform: "win32" });
    if (acknowledgement?.requested !== true) {
      throw new Error("Windows shell did not accept the managed uninstall request.");
    }
    return Object.freeze({ scheduled: true, removeUserData });
  }
  const mode = removeUserData ? "--remove-user-data" : "--preserve-user-data";
  await launchDetachedHelper({
    spawnImpl,
    command: nodePath,
    args: [helperPath, "--uninstall", mode],
    options: {
      detached: true,
      stdio: "ignore",
      env: uninstallHelperEnvironment(installation, sourceEnv),
    },
    label: "Equinox Local uninstall helper",
  });
  return Object.freeze({ scheduled: true, removeUserData });
}
