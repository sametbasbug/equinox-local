import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const TRANSACTION_ID_PATTERN = /^main-[a-f0-9]{32}$/u;
const LABEL_PREFIX = "dev.equinox.local.main-update.";

function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function assertAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be an absolute path.`);
  return path.resolve(value);
}
function assertTransactionId(value) {
  if (!TRANSACTION_ID_PATTERN.test(value ?? "")) throw new Error("Main update transaction id is invalid.");
  return value;
}
export function mainUpdateLaunchdLabel(transactionId) {
  return `${LABEL_PREFIX}${assertTransactionId(transactionId).slice(5)}`;
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

export async function scheduleEquinoxLocalMainUpdateWorker({
  transactionId,
  sourceRoot,
  transactionRoot,
  nodePath = process.env.EQUINOX_LOCAL_DEV_NODE || process.execPath,
  workerPath = path.join(sourceRoot ?? "", "src", "equinox-local-main-update-worker.js"),
  sourceEnv = process.env,
  uid = process.getuid?.(),
  fsImpl = fs,
  execFileImpl = execFile,
} = {}) {
  assertTransactionId(transactionId);
  const root = assertAbsolute(sourceRoot, "Main update source root");
  const stateRoot = assertAbsolute(transactionRoot, "Main update transaction root");
  const node = assertAbsolute(nodePath, "Main update Node runtime");
  const worker = assertAbsolute(workerPath, "Main update worker");
  if (!Number.isInteger(uid) || uid < 1) throw new Error("A non-root user id is required to schedule main update handoff.");
  if (typeof execFileImpl !== "function") throw new Error("Main update launchd scheduler requires an exec function.");
  for (const file of [node, worker]) {
    const stat = await fsImpl.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Main update worker executable/source is unsafe.");
  }
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
