import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const WINDOWS_PRIVATE_STATE_HELPER = fileURLToPath(new URL("./equinox-local-windows-private-state.ps1", import.meta.url));
const WINDOWS_PRIVATE_STATE_TIMEOUT_MS = 15_000;

function fileType(stat) {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

function unixMode(mode) {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

function windowsPowerShellPath(env = process.env) {
  const root = env?.SystemRoot || env?.SYSTEMROOT;
  if (typeof root !== "string" || !path.win32.isAbsolute(root)) throw new Error("Windows SystemRoot is unavailable for private-state ACL verification.");
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function windowsPrivateStateEnvironment(env = process.env) {
  const entries = {
    SystemRoot: env?.SystemRoot || env?.SYSTEMROOT,
    WINDIR: env?.WINDIR || env?.SystemRoot || env?.SYSTEMROOT,
    USERPROFILE: env?.USERPROFILE,
    LOCALAPPDATA: env?.LOCALAPPDATA,
    TEMP: env?.TEMP,
    TMP: env?.TMP,
  };
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => typeof value === "string" && value.length > 0));
}

async function runWindowsPrivateStateAcl(action, { target, type, execFileAsync = execFile, env = process.env } = {}) {
  if (!['protect', 'verify'].includes(action)) throw new Error("Windows private-state ACL action is invalid.");
  if (type !== "file" && type !== "directory") throw new Error("Windows private-state ACL type is invalid.");
  if (typeof target !== "string" || !path.win32.isAbsolute(target) || target.includes("\0")) throw new Error("Windows private-state target must be an absolute path.");
  const { stdout } = await execFileAsync(windowsPowerShellPath(env), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", WINDOWS_PRIVATE_STATE_HELPER, "-Action", action, "-Target", target, "-Type", type,
  ], { windowsHide: true, timeout: WINDOWS_PRIVATE_STATE_TIMEOUT_MS, maxBuffer: 16 * 1024, env: windowsPrivateStateEnvironment(env) });
  let parsed;
  try { parsed = JSON.parse(String(stdout).trim()); }
  catch { throw new Error("Windows private-state ACL helper returned invalid JSON."); }
  if (typeof parsed?.safe !== "boolean") throw new Error("Windows private-state ACL helper returned an invalid result.");
  return Object.freeze({ safe: parsed.safe, reason: parsed.safe ? null : (typeof parsed.reason === "string" && parsed.reason ? parsed.reason : "acl-unverified") });
}

export async function verifyWindowsPrivateStateAcl(input = {}) {
  return runWindowsPrivateStateAcl("verify", input);
}

export async function protectWindowsPrivateStatePath(input = {}) {
  const result = await runWindowsPrivateStateAcl("protect", input);
  if (!result.safe) throw new Error(`Windows private-state ACL protection failed: ${result.reason}`);
  return result;
}

export async function inspectPrivateStatePath(target, {
  platform = process.platform,
  type,
  mode,
  fsImpl = fs,
  verifyWindowsAcl = null,
} = {}) {
  try {
    const stat = await fsImpl.lstat(target);
    const actualType = fileType(stat);
    if (actualType === "symlink") {
      return Object.freeze({ exists: true, safe: false, type: actualType, mode: null, security: platform === "win32" ? "windows-acl" : "posix", reason: "symlink" });
    }
    const typeSafe = actualType === type;
    if (platform === "darwin") {
      const actualMode = unixMode(stat.mode);
      return Object.freeze({
        exists: true,
        safe: typeSafe && (mode === undefined || actualMode === mode),
        type: actualType,
        mode: actualMode,
        security: "posix",
        reason: typeSafe && (mode === undefined || actualMode === mode) ? null : "type-or-mode",
      });
    }
    if (platform === "win32") {
      if (!typeSafe) {
        return Object.freeze({ exists: true, safe: false, type: actualType, mode: null, security: "windows-acl", reason: "type" });
      }
      if (typeof verifyWindowsAcl !== "function") {
        return Object.freeze({ exists: true, safe: false, type: actualType, mode: null, security: "windows-acl", reason: "acl-unverified" });
      }
      const verification = await verifyWindowsAcl({ target, type: actualType });
      const safe = verification === true || verification?.safe === true;
      return Object.freeze({
        exists: true,
        safe,
        type: actualType,
        mode: null,
        security: "windows-acl",
        reason: safe ? null : verification?.reason || "acl-unverified",
      });
    }
    return Object.freeze({ exists: true, safe: false, type: actualType, mode: null, security: "unsupported", reason: "unsupported-platform" });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ exists: false, safe: false, type: null, mode: null, security: platform === "win32" ? "windows-acl" : "posix", reason: "missing" });
    }
    return Object.freeze({ exists: false, safe: false, type: null, mode: null, security: platform === "win32" ? "windows-acl" : "posix", reason: "inspection-failed" });
  }
}
