import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const FILE_PATH = "/usr/bin/file";
const NATIVE_SOURCE_DIR = "equinox-local-app";
const NATIVE_OUTPUT_DIR = path.join("runtime", "app");

export const EQUINOX_LOCAL_NATIVE_APP_SHELL_VERSION = 2;
export const EQUINOX_LOCAL_NATIVE_APP_EXECUTABLE = "applet";
export const EQUINOX_LOCAL_NATIVE_APP_ICON = "EquinoxLocal.png";
export const EQUINOX_LOCAL_NATIVE_APP_METADATA = "native-app.json";

function targetTriple(target) {
  if (target === "darwin-arm64") return "arm64-apple-macos13.0";
  if (target === "darwin-x64") return "x86_64-apple-macos13.0";
  throw new Error(`Unsupported Equinox Local native app target: ${target}.`);
}

function fileArchitecture(target) {
  if (target === "darwin-arm64") return "arm64";
  if (target === "darwin-x64") return "x86_64";
  throw new Error(`Unsupported Equinox Local native app target: ${target}.`);
}

async function sha256File(filePath) {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function assertNormalFile(filePath, label) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a safe normal file.`);
  return stat;
}

const MACHO_64_MAGIC = 0xfeedfacf;
const LC_UUID = 0x1b;
const MACHO_64_HEADER_BYTES = 32;

export function normalizeMachOUuidBytes(input) {
  const data = Buffer.from(input);
  if (data.length < MACHO_64_HEADER_BYTES || data.readUInt32LE(0) !== MACHO_64_MAGIC) {
    throw new Error("Equinox Local native app executable is not a supported 64-bit Mach-O binary.");
  }
  const commandCount = data.readUInt32LE(16);
  const commandBytes = data.readUInt32LE(20);
  const commandLimit = MACHO_64_HEADER_BYTES + commandBytes;
  if (commandCount > 4096 || commandLimit > data.length) throw new Error("Equinox Local native app Mach-O load commands are invalid.");

  let offset = MACHO_64_HEADER_BYTES;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > commandLimit) throw new Error("Equinox Local native app Mach-O load command is truncated.");
    const command = data.readUInt32LE(offset);
    const commandSize = data.readUInt32LE(offset + 4);
    if (commandSize < 8 || offset + commandSize > commandLimit) throw new Error("Equinox Local native app Mach-O load command size is invalid.");
    if (command === LC_UUID) {
      if (commandSize < 24) throw new Error("Equinox Local native app LC_UUID command is invalid.");
      const uuidOffset = offset + 8;
      data.fill(0, uuidOffset, uuidOffset + 16);
      const uuid = Buffer.from(createHash("sha256").update(data).digest().subarray(0, 16));
      uuid[6] = (uuid[6] & 0x0f) | 0x50;
      uuid[8] = (uuid[8] & 0x3f) | 0x80;
      uuid.copy(data, uuidOffset);
      return data;
    }
    offset += commandSize;
  }
  throw new Error("Equinox Local native app executable has no LC_UUID command.");
}

async function normalizeMachOUuid(filePath) {
  const data = normalizeMachOUuidBytes(await fs.readFile(filePath));
  await fs.writeFile(filePath, data);
}

export async function buildEquinoxLocalNativeAppArtifacts({
  rootDir,
  releaseDir,
  target,
  execFileImpl = execFile,
} = {}) {
  const root = path.resolve(rootDir);
  const releaseRoot = path.resolve(releaseDir);
  const source = path.join(root, NATIVE_SOURCE_DIR, "EquinoxLocalApp.swift");
  const icon = path.join(root, NATIVE_SOURCE_DIR, EQUINOX_LOCAL_NATIVE_APP_ICON);
  await assertNormalFile(source, "Equinox Local native app source");
  await assertNormalFile(icon, "Equinox Local native app icon");

  const outputRoot = path.join(releaseRoot, NATIVE_OUTPUT_DIR);
  await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const executable = path.join(outputRoot, EQUINOX_LOCAL_NATIVE_APP_EXECUTABLE);
  const outputIcon = path.join(outputRoot, EQUINOX_LOCAL_NATIVE_APP_ICON);

  await execFileImpl("/usr/bin/xcrun", [
    "swiftc",
    "-O",
    "-whole-module-optimization",
    "-target", targetTriple(target),
    "-module-name", "EquinoxLocalApp",
    source,
    "-o", executable,
    "-framework", "AppKit",
    "-framework", "WebKit",
  ], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  await normalizeMachOUuid(executable);
  await fs.chmod(executable, 0o755);

  const { stdout: fileOutput } = await execFileImpl(FILE_PATH, [executable], { timeout: 5_000, maxBuffer: 1024 * 1024 });
  if (!String(fileOutput).includes(fileArchitecture(target))) {
    throw new Error(`Equinox Local native app architecture does not match ${target}.`);
  }

  await fs.copyFile(icon, outputIcon);
  const metadata = Object.freeze({
    schemaVersion: 1,
    shellVersion: EQUINOX_LOCAL_NATIVE_APP_SHELL_VERSION,
    target,
    executable: EQUINOX_LOCAL_NATIVE_APP_EXECUTABLE,
    executableSha256: await sha256File(executable),
    icon: EQUINOX_LOCAL_NATIVE_APP_ICON,
    iconSha256: await sha256File(outputIcon),
  });
  await fs.writeFile(path.join(outputRoot, EQUINOX_LOCAL_NATIVE_APP_METADATA), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
  return metadata;
}

export function equinoxLocalNativeAppArtifactPaths(releaseDir) {
  const root = path.join(path.resolve(releaseDir), NATIVE_OUTPUT_DIR);
  return Object.freeze({
    root,
    executable: path.join(root, EQUINOX_LOCAL_NATIVE_APP_EXECUTABLE),
    icon: path.join(root, EQUINOX_LOCAL_NATIVE_APP_ICON),
    metadata: path.join(root, EQUINOX_LOCAL_NATIVE_APP_METADATA),
  });
}
