import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  equinoxLocalAppExecutablePath,
  equinoxLocalAppPath,
  validateEquinoxLocalAppHost,
} from "./equinox-local-app-host.js";
import { resolveEquinoxLocalInstallation } from "./equinox-local-installation.js";
import { kickstartEquinoxLocalLaunchAgent } from "./equinox-local-update-activation.js";

const execFile = promisify(execFileCallback);
const START_DELAY_MS = 1_250;
const GUI_STOP_ATTEMPTS = 40;
const GUI_START_ATTEMPTS = 40;
const GUI_POLL_MS = 100;

function parsePidList(value) {
  return String(value ?? "")
    .split(/\r?\n/u)
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isInteger(entry) && entry > 1);
}

async function launchAgentHostPid(installation, uid, execFileImpl) {
  try {
    const { stdout } = await execFileImpl(
      "/bin/launchctl",
      ["print", `gui/${uid}/${installation.launchAgentLabel}`],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    const match = String(stdout ?? "").match(/^\s*pid = (\d+)\s*$/mu);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function exactForegroundGuiPid(pid, { executablePath, uid, execFileImpl }) {
  try {
    const { stdout } = await execFileImpl(
      "/bin/ps",
      ["-p", String(pid), "-o", "uid=,command="],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 32 * 1024 },
    );
    const line = String(stdout ?? "").trim();
    const match = line.match(/^(\d+)\s+(.+)$/u);
    const command = match?.[2] ?? "";
    return Boolean(
      match
      && Number(match[1]) === uid
      && (command === executablePath || command.startsWith(`${executablePath} `))
    );
  } catch {
    return false;
  }
}

export async function captureEquinoxLocalForegroundGui({
  installation,
  homeDir,
  uid = process.getuid?.(),
  execFileImpl = execFile,
} = {}) {
  if (!Number.isInteger(uid) || uid < 1) throw new Error("A non-root user id is required to inspect the Equinox Local GUI.");
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) throw new Error("A trusted home directory is required to inspect the Equinox Local GUI.");
  const appPath = equinoxLocalAppPath(homeDir);
  const executablePath = equinoxLocalAppExecutablePath(homeDir);
  const hostPid = await launchAgentHostPid(installation, uid, execFileImpl);
  let candidates = [];
  try {
    const { stdout } = await execFileImpl(
      "/usr/bin/pgrep",
      ["-f", executablePath],
      { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 },
    );
    candidates = parsePidList(stdout);
  } catch {
    candidates = [];
  }
  const pids = [];
  for (const pid of candidates) {
    if (pid === hostPid) continue;
    if (await exactForegroundGuiPid(pid, { executablePath, uid, execFileImpl })) pids.push(pid);
  }
  return Object.freeze({ appPath, executablePath, pids: Object.freeze(pids) });
}

export async function refreshEquinoxLocalForegroundGui({
  installation,
  homeDir,
  foreground,
  uid = process.getuid?.(),
  execFileImpl = execFile,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const oldPids = Array.isArray(foreground?.pids) ? foreground.pids : [];
  if (oldPids.length === 0) return Object.freeze({ refreshed: false, pid: null });
  const appPath = equinoxLocalAppPath(homeDir);
  const executablePath = equinoxLocalAppExecutablePath(homeDir);
  await validateEquinoxLocalAppHost(appPath, { execFileImpl });

  for (const pid of oldPids) {
    if (!await exactForegroundGuiPid(pid, { executablePath, uid, execFileImpl })) continue;
    await execFileImpl("/bin/kill", ["-TERM", String(pid)], { timeout: 5_000, maxBuffer: 16 * 1024 }).catch(() => {});
  }
  for (const pid of oldPids) {
    let alive = true;
    for (let attempt = 0; attempt < GUI_STOP_ATTEMPTS; attempt += 1) {
      try {
        await execFileImpl("/bin/kill", ["-0", String(pid)], { timeout: 2_000, maxBuffer: 16 * 1024 });
        await sleepImpl(GUI_POLL_MS);
      } catch {
        alive = false;
        break;
      }
    }
    if (alive) throw new Error("Previous Equinox Local foreground GUI did not stop cleanly.");
  }

  await execFileImpl("/usr/bin/open", ["-gn", appPath, "--args", "--restart-shell"], { timeout: 10_000, maxBuffer: 64 * 1024 });
  for (let attempt = 0; attempt < GUI_START_ATTEMPTS; attempt += 1) {
    const current = await captureEquinoxLocalForegroundGui({ installation, homeDir, uid, execFileImpl });
    const nextPid = current.pids.find((pid) => !oldPids.includes(pid));
    if (nextPid) return Object.freeze({ refreshed: true, pid: nextPid });
    await sleepImpl(GUI_POLL_MS);
  }
  throw new Error("Equinox Local foreground GUI did not relaunch after restart.");
}

export async function runEquinoxLocalRestartHelper({
  argv = process.argv.slice(2),
  env = process.env,
  homeDir = env.HOME,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  kickstartImpl = kickstartEquinoxLocalLaunchAgent,
  captureForegroundGuiImpl = captureEquinoxLocalForegroundGui,
  refreshForegroundGuiImpl = refreshEquinoxLocalForegroundGui,
} = {}) {
  if (argv.length !== 1 || argv[0] !== "--restart") {
    throw new Error("Usage: equinox-local-restart-helper.js --restart");
  }
  const installation = resolveEquinoxLocalInstallation({ homeDir, env });
  if (!installation.selfUpdateSupported) {
    throw new Error("Restart helper requires a managed Equinox Local installation.");
  }
  await sleepImpl(START_DELAY_MS);
  const foreground = await captureForegroundGuiImpl({ installation, homeDir });
  await kickstartImpl(installation);
  const gui = await refreshForegroundGuiImpl({ installation, homeDir, foreground, sleepImpl });
  return Object.freeze({ restarted: true, foregroundShellRefreshed: gui.refreshed === true });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  runEquinoxLocalRestartHelper().catch(() => {
    process.exitCode = 1;
  });
}
