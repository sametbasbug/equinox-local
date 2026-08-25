import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";

const execFile = promisify(execFileCallback);
const START_DELAY_MS = 1_500;
const NATIVE_HOST_NAME = "dev.equinox.browser";

function parseMode(argv) {
  if (argv.length !== 2 || argv[0] !== "--uninstall") {
    throw new Error("Usage: equinox-local-uninstall-helper.js --uninstall --preserve-user-data|--remove-user-data");
  }
  if (argv[1] === "--preserve-user-data") return false;
  if (argv[1] === "--remove-user-data") return true;
  throw new Error("Unknown Equinox Local uninstall mode.");
}

async function removeIfExists(target, { recursive = false, fsImpl = fs } = {}) {
  try {
    await fsImpl.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await fsImpl.rm(target, { recursive, force: false });
  return true;
}

async function removeOwnedNativeHostManifest({ homeDir, installRoot, fsImpl = fs }) {
  const manifestPath = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    `${NATIVE_HOST_NAME}.json`,
  );
  try {
    const stat = await fsImpl.lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 16 * 1024) return false;
    const manifest = JSON.parse(await fsImpl.readFile(manifestPath, "utf8"));
    if (path.resolve(manifest?.path || "") !== path.join(installRoot, "equinox-browser-native-host")) return false;
    await fsImpl.rm(manifestPath, { force: false });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
}

export async function runEquinoxLocalUninstallHelper({
  argv = process.argv.slice(2),
  env = process.env,
  homeDir = env.HOME,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  execFileImpl = execFile,
  fsImpl = fs,
} = {}) {
  const removeUserData = parseMode(argv);
  const installation = resolveEquinoxLocalInstallation({ homeDir, env });
  if (!installation.managed || !installation.selfUpdateSupported) {
    throw new Error("Uninstall helper requires a managed Equinox Local installation.");
  }
  if (!Number.isInteger(uid) || uid <= 0) throw new Error("A non-root user id is required for Equinox Local uninstall.");

  await sleepImpl(START_DELAY_MS);
  await execFileImpl("/bin/launchctl", [
    "bootout",
    `gui/${uid}/${installation.launchAgentLabel}`,
  ], { timeout: 15_000, maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: "", stderr: "" }));

  await removeOwnedNativeHostManifest({ homeDir, installRoot: installation.installRoot, fsImpl });
  await removeIfExists(installation.launchAgentPath, { fsImpl });
  for (const logName of ["Equinox Local.log", "Equinox Local.error.log"]) {
    await removeIfExists(path.join(homeDir, "Library", "Logs", logName), { fsImpl });
  }

  if (removeUserData) {
    await removeIfExists(installation.installRoot, { recursive: true, fsImpl });
  } else {
    for (const target of [
      installation.currentLink,
      installation.releasesRoot,
      installation.stagingRoot,
      path.join(installation.installRoot, "secrets"),
      path.join(installation.installRoot, "transport.json"),
      path.join(installation.installRoot, "tunnel-profile"),
      path.join(installation.installRoot, "equinox-browser-native-host"),
      path.join(installation.installRoot, "update-state.json"),
    ]) {
      await removeIfExists(target, {
        recursive: target === installation.releasesRoot || target === installation.stagingRoot || target.endsWith("/secrets") || target.endsWith("/tunnel-profile"),
        fsImpl,
      });
    }
  }

  return Object.freeze({
    uninstalled: true,
    userDataRemoved: removeUserData,
    userDataPreserved: !removeUserData,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  runEquinoxLocalUninstallHelper().catch(() => {
    process.exitCode = 1;
  });
}
