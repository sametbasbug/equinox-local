import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const OSASCRIPT = "/usr/bin/osascript";

function normalizeOpenUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("URL is invalid.");
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) throw new Error("Only credential-free HTTP(S) URLs can be opened.");
  return url.href;
}

export async function openLocalUrl({
  url,
  platform = process.platform,
  execFileAsync = execFile,
} = {}) {
  const normalized = normalizeOpenUrl(url);
  if (platform === "darwin") {
    await execFileAsync("/usr/bin/open", [normalized], { timeout: 10_000, maxBuffer: 8 * 1024 });
    return normalized;
  }
  if (platform === "win32") {
    await execFileAsync("explorer.exe", [normalized], { timeout: 10_000, maxBuffer: 8 * 1024, windowsHide: true });
    return normalized;
  }
  const error = new Error(`Opening URLs is unsupported on ${platform}.`);
  error.statusCode = 501;
  throw error;
}

export async function revealLocalPath({
  targetPath,
  kind = "file",
  platform = process.platform,
  execFileAsync = execFile,
} = {}) {
  if (!new Set(["file", "directory"]).has(kind)) throw new Error("Reveal path kind must be file or directory.");
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (typeof targetPath !== "string" || !pathApi.isAbsolute(targetPath)) throw new Error("Reveal path must be absolute.");
  const normalized = pathApi.normalize(targetPath);
  if (platform === "darwin") {
    await execFileAsync("/usr/bin/open", kind === "file" ? ["-R", normalized] : [normalized], { timeout: 10_000, maxBuffer: 8 * 1024 });
    return normalized;
  }
  if (platform === "win32") {
    const args = kind === "file" ? ["/select,", normalized] : [normalized];
    await execFileAsync("explorer.exe", args, { timeout: 10_000, maxBuffer: 8 * 1024, windowsHide: true });
    return normalized;
  }
  const error = new Error(`Revealing paths is unsupported on ${platform}.`);
  error.statusCode = 501;
  throw error;
}

const PICK_FOLDER_SCRIPT = [
  "try",
  "POSIX path of (choose folder with prompt \"Choose a folder for Equinox Local\")",
  "on error number -128",
  "return \"\"",
  "end try",
].join("\n");

export async function chooseLocalFolder({
  platform = process.platform,
  execFileAsync = execFile,
} = {}) {
  if (platform !== "darwin") {
    const error = new Error("Visual folder selection is currently available on macOS only.");
    error.statusCode = 501;
    throw error;
  }

  const result = await execFileAsync(OSASCRIPT, ["-e", PICK_FOLDER_SCRIPT], {
    timeout: 120_000,
    maxBuffer: 8 * 1024,
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME || "",
    },
  });
  const selected = String(result?.stdout || "").trim();
  if (!selected) return null;
  if (!path.isAbsolute(selected)) {
    throw new Error("Folder picker returned a non-absolute path.");
  }

  const realPath = await fs.realpath(selected);
  const stat = await fs.lstat(realPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Selected folder is not a safe local directory.");
  }
  if (realPath === path.parse(realPath).root) {
    throw new Error("The filesystem root cannot be granted to Equinox Local.");
  }
  return realPath;
}

export const __test = Object.freeze({
  OSASCRIPT,
  PICK_FOLDER_SCRIPT,
});
