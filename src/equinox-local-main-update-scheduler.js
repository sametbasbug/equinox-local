import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { readBoundedNormalFile } from "./equinox-local-safe-file.js";

import { requestWindowsShellMainUpdateHandoff } from "./equinox-local-windows-shell-control.js";

const execFile = promisify(execFileCallback);

const TRANSACTION_ID_PATTERN = /^main-[a-f0-9]{32}$/u;
const LABEL_PREFIX = "dev.equinox.local.main-update.";
const WINDOWS_WORKER_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const WINDOWS_START_TICKS_PATTERN = /^[0-9]{1,19}$/u;
const MAX_WINDOWS_OWNERSHIP_BYTES = 8 * 1024;
const WINDOWS_PROCESS_IDENTITY_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$p=Get-Process -Id ([int]$args[0]) -ErrorAction SilentlyContinue",
  "if($null -eq $p){[Console]::Out.Write('missing');exit 0}",
  "$ticks=$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)",
  "if($ticks -ne $args[1]){[Console]::Out.Write('mismatch');exit 0}",
  "try{$exe=$p.Path}catch{[Console]::Out.Write('unknown');exit 0}",
  "if($exe -ine $args[2]){[Console]::Out.Write('mismatch');exit 0}",
  "[Console]::Out.Write('running')",
].join(";");


function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function assertAbsolute(value, label, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (typeof value !== "string" || !pathApi.isAbsolute(value) || /[\r\n\0]/u.test(value)) throw new Error(label + " must be an absolute path.");
  return pathApi.resolve(value);
}
function assertTransactionId(value) {
  if (!TRANSACTION_ID_PATTERN.test(value ?? "")) throw new Error("Main update transaction id is invalid.");
  return value;
}
export function mainUpdateLaunchdLabel(transactionId) {
  return `${LABEL_PREFIX}${assertTransactionId(transactionId).slice(5)}`;
}
export function windowsMainUpdateWorkerOwnershipPath(transactionRoot, transactionId) {
  const root = assertAbsolute(transactionRoot, "Main update transaction root", "win32");
  return path.win32.join(root, "handoff", assertTransactionId(transactionId) + ".windows-worker.json");
}
export function parseWindowsMainUpdateWorkerOwnership(value, { transactionId } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Windows Main worker ownership is invalid.");
  const keys = Object.keys(value).sort();
  const expected = ["nodePath", "pid", "schemaVersion", "startTimeUtcTicks", "token", "transactionId"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("Windows Main worker ownership contains missing or unsupported fields.");
  if (value.schemaVersion !== 1 || value.transactionId !== assertTransactionId(transactionId ?? value.transactionId)) throw new Error("Windows Main worker ownership identity is invalid.");
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error("Windows Main worker ownership PID is invalid.");
  if (!WINDOWS_START_TICKS_PATTERN.test(value.startTimeUtcTicks ?? "")) throw new Error("Windows Main worker ownership start identity is invalid.");
  if (!WINDOWS_WORKER_TOKEN_PATTERN.test(value.token ?? "")) throw new Error("Windows Main worker ownership token is invalid.");
  const nodePath = assertAbsolute(value.nodePath, "Windows Main worker Node path", "win32");
  return Object.freeze({ ...value, nodePath });
}
export async function readWindowsMainUpdateWorkerOwnership({ transactionId, transactionRoot, fsImpl = fs } = {}) {
  const ownershipPath = windowsMainUpdateWorkerOwnershipPath(transactionRoot, transactionId);
  try {
    const file = await readBoundedNormalFile(ownershipPath, {
      fsImpl,
      platform: "win32",
      minBytes: 2,
      maxBytes: MAX_WINDOWS_OWNERSHIP_BYTES,
      encoding: "utf8",
      label: "Windows Main worker ownership",
    });
    return Object.freeze({
      ownershipPath,
      ownership: parseWindowsMainUpdateWorkerOwnership(JSON.parse(file.data), { transactionId }),
    });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ ownershipPath, ownership: null });
    throw error;
  }
}
export async function inspectWindowsMainUpdateWorkerProcess(ownership, { execFileImpl = execFile } = {}) {
  const parsed = parseWindowsMainUpdateWorkerOwnership(ownership);
  const result = await execFileImpl("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    WINDOWS_PROCESS_IDENTITY_SCRIPT,
    String(parsed.pid),
    parsed.startTimeUtcTicks,
    parsed.nodePath,
  ], { timeout: 5_000, maxBuffer: 4 * 1024, windowsHide: true });
  const state = String(result?.stdout ?? "").trim();
  if (state === "running") return Object.freeze({ running: true, stale: false, uncertain: false });
  if (state === "missing" || state === "mismatch") return Object.freeze({ running: false, stale: true, uncertain: false });
  return Object.freeze({ running: false, stale: false, uncertain: true });
}
export function mainUpdateWorkerEnvironment(sourceEnv = process.env) {
  const env = {
    HOME: sourceEnv.HOME,
    USER: sourceEnv.USER,
    LOGNAME: sourceEnv.LOGNAME,
    TMPDIR: sourceEnv.TMPDIR,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: sourceEnv.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG,
    EQUINOX_LOCAL_DEV_NODE: sourceEnv.EQUINOX_LOCAL_DEV_NODE,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string" && value.length > 0));
}
export function renderMainUpdateLaunchdPlist({ label, nodePath, workerPath, sourceRoot, transactionRoot, transactionId, logPath, environment }) {
  const args = [nodePath, workerPath, "--transaction-id", transactionId, "--source-root", sourceRoot, "--transaction-root", transactionRoot];
  const envXml = Object.entries(environment).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xml(label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n${envXml}\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <false/>\n  <key>ProcessType</key>\n  <string>Background</string>\n  <key>StandardOutPath</key>\n  <string>${xml(logPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xml(logPath)}</string>\n</dict>\n</plist>\n`;
}


export async function inspectEquinoxLocalMainUpdateWorkerOwnership({
  transactionId,
  transactionRoot,
  platform = process.platform,
  uid = process.getuid?.(),
  fsImpl = fs,
  execFileImpl = execFile,
  readWindowsOwnershipImpl = readWindowsMainUpdateWorkerOwnership,
  inspectWindowsProcessImpl = inspectWindowsMainUpdateWorkerProcess,
} = {}) {
  assertTransactionId(transactionId);
  if (platform === "win32") {
    try {
      const record = await readWindowsOwnershipImpl({ transactionId, transactionRoot, fsImpl });
      if (!record?.ownership) {
        return Object.freeze({
          loaded: false,
          running: false,
          stale: false,
          uncertain: false,
          platform: "win32",
          ownershipPath: record?.ownershipPath ?? windowsMainUpdateWorkerOwnershipPath(transactionRoot, transactionId),
        });
      }
      const identity = await inspectWindowsProcessImpl(record.ownership, { execFileImpl });
      return Object.freeze({
        loaded: true,
        platform: "win32",
        ownershipPath: record.ownershipPath,
        ownership: record.ownership,
        ...identity,
      });
    } catch (error) {
      return Object.freeze({
        loaded: true,
        running: false,
        stale: false,
        uncertain: true,
        platform: "win32",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (!Number.isInteger(uid) || uid < 1) return Object.freeze({ loaded: false, running: false });
  const label = mainUpdateLaunchdLabel(transactionId);
  try {
    const result = await execFileImpl("/bin/launchctl", ["print", `gui/${uid}/${label}`], { timeout: 5_000, maxBuffer: 64 * 1024 });
    const output = String(result?.stdout ?? "");
    const running = /(?:^|\n)\s*state\s*=\s*running\s*(?:\n|$)/u.test(output);
    return Object.freeze({ loaded: true, running, label });
  } catch {
    return Object.freeze({ loaded: false, running: false, label });
  }
}

export async function cleanupEquinoxLocalMainUpdateWorkerOwnership({
  transactionId,
  transactionRoot,
  platform = process.platform,
  uid = process.getuid?.(),
  fsImpl = fs,
  execFileImpl = execFile,
  ownershipToken = process.env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN,
  inspectWorkerImpl = inspectEquinoxLocalMainUpdateWorkerOwnership,
  readWindowsOwnershipImpl = readWindowsMainUpdateWorkerOwnership,
} = {}) {
  assertTransactionId(transactionId);
  const stateRoot = assertAbsolute(transactionRoot, "Main update transaction root", platform);
  if (platform === "win32") {
    const record = await readWindowsOwnershipImpl({ transactionId, transactionRoot: stateRoot, fsImpl });
    if (!record?.ownership) {
      return Object.freeze({
        cleaned: true,
        platform: "win32",
        ownershipPath: record?.ownershipPath ?? windowsMainUpdateWorkerOwnershipPath(stateRoot, transactionId),
      });
    }
    if (typeof ownershipToken === "string"
      && WINDOWS_WORKER_TOKEN_PATTERN.test(ownershipToken)
      && record.ownership.token === ownershipToken) {
      await fsImpl.rm(record.ownershipPath, { force: true });
      return Object.freeze({ cleaned: true, owner: true, platform: "win32", ownershipPath: record.ownershipPath });
    }
    const inspected = await inspectWorkerImpl({
      transactionId,
      transactionRoot: stateRoot,
      platform: "win32",
      fsImpl,
      execFileImpl,
    });
    if (inspected?.running) return Object.freeze({ cleaned: false, running: true, platform: "win32", ownershipPath: record.ownershipPath });
    if (inspected?.uncertain) return Object.freeze({ cleaned: false, uncertain: true, platform: "win32", ownershipPath: record.ownershipPath });
    await fsImpl.rm(record.ownershipPath, { force: true });
    return Object.freeze({ cleaned: true, stale: true, platform: "win32", ownershipPath: record.ownershipPath });
  }
  if (!Number.isInteger(uid) || uid < 1) return Object.freeze({ cleaned: false });
  const label = mainUpdateLaunchdLabel(transactionId);
  const plistPath = path.join(stateRoot, "handoff", `${transactionId}.plist`);
  await execFileImpl("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { timeout: 5_000, maxBuffer: 64 * 1024 }).catch(() => {});
  await fsImpl.rm(plistPath, { force: true }).catch(() => {});
  return Object.freeze({ cleaned: true, label, plistPath });
}

export async function scheduleEquinoxLocalMainUpdateWorker({
  transactionId,
  sourceRoot,
  transactionRoot,
  platform = process.platform,
  nodePath = process.env.EQUINOX_LOCAL_DEV_NODE || process.execPath,
  workerPath = path.join(sourceRoot ?? "", "src", "equinox-local-main-update-worker.js"),
  sourceEnv = process.env,
  uid = process.getuid?.(),
  fsImpl = fs,
  execFileImpl = execFile,
  requestWindowsHandoffImpl = requestWindowsShellMainUpdateHandoff,
} = {}) {
  assertTransactionId(transactionId);
  const root = assertAbsolute(sourceRoot, "Main update source root", platform);
  const stateRoot = assertAbsolute(transactionRoot, "Main update transaction root", platform);
  const worker = assertAbsolute(workerPath, "Main update worker", platform);
  const workerStat = await fsImpl.lstat(worker);
  if (!workerStat.isFile() || workerStat.isSymbolicLink()) throw new Error("Main update worker executable/source is unsafe.");
  if (platform === "win32") {
    const handoff = await requestWindowsHandoffImpl(transactionId, { platform: "win32" });
    return Object.freeze({ scheduled: true, platform: "win32", transactionId, handoff });
  }
  if (platform !== "darwin") throw new Error("Main update worker handoff is unsupported on this platform.");
  const node = assertAbsolute(nodePath, "Main update Node runtime", platform);
  if (!Number.isInteger(uid) || uid < 1) throw new Error("A non-root user id is required to schedule main update handoff.");
  if (typeof execFileImpl !== "function") throw new Error("Main update launchd scheduler requires an exec function.");
  const nodeStat = await fsImpl.lstat(node);
  if (!nodeStat.isFile() || nodeStat.isSymbolicLink()) throw new Error("Main update worker executable/source is unsafe.");
  const schedulerRoot = path.join(stateRoot, "handoff");
  await fsImpl.mkdir(schedulerRoot, { recursive: true, mode: 0o700 });
  const schedulerReal = await fsImpl.realpath(schedulerRoot);
  if (schedulerReal !== schedulerRoot) throw new Error("Main update handoff directory is unsafe.");
  const label = mainUpdateLaunchdLabel(transactionId);
  const plistPath = path.join(schedulerRoot, `${transactionId}.plist`);
  const logPath = path.join(schedulerRoot, `${transactionId}.log`);
  const environment = mainUpdateWorkerEnvironment(sourceEnv);
  const plist = renderMainUpdateLaunchdPlist({ label, nodePath: node, workerPath: worker, sourceRoot: root, transactionRoot: stateRoot, transactionId, logPath, environment });
  const handle = await fsImpl.open(plistPath, "wx", 0o600);
  try { await handle.writeFile(plist, "utf8"); await handle.sync(); } finally { await handle.close(); }
  let bootstrapped = false;
  try {
    await execFileImpl("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath], { timeout: 10_000, maxBuffer: 64 * 1024 });
    bootstrapped = true;
    await execFileImpl("/bin/launchctl", ["print", `gui/${uid}/${label}`], { timeout: 5_000, maxBuffer: 64 * 1024 });
  } catch (error) {
    if (bootstrapped) await execFileImpl("/bin/launchctl", ["bootout", `gui/${uid}/${label}`], { timeout: 5_000, maxBuffer: 64 * 1024 }).catch(() => {});
    await fsImpl.rm(plistPath, { force: true }).catch(() => {});
    throw error;
  }
  return Object.freeze({ scheduled: true, label, plistPath, logPath });
}
