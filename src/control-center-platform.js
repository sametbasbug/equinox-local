import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const OSASCRIPT = "/usr/bin/osascript";
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
