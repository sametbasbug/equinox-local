import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { equinoxLocalUpdateTarget, parseEquinoxVersion } from "./equinox-local-updater.js";

const execFile = promisify(execFileCallback);
const TRANSPORT_CONFIG_VERSION = 1;
const TRANSPORT_MODE = "openai-tunnel";
const PROFILE_NAME = "equinox-local";
const MAX_TRANSPORT_CONFIG_BYTES = 16 * 1024;
const MAX_RUNTIME_KEY_BYTES = 4 * 1024;
export const TUNNEL_ID_PATTERN = /^tunnel_[a-f0-9]{32}$/u;

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function boundedMessage(value) {
  return String(value ?? "")
    .replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 400);
}

function log(message) {
  process.stderr.write(`[Equinox Local supervisor] ${boundedMessage(message)}\n`);
}

export function managedSupervisorPaths(homeDir = os.homedir()) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    throw new Error("A trusted absolute HOME is required for the managed supervisor.");
  }
  const installRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local");
  return Object.freeze({
    homeDir,
    installRoot,
    releasesRoot: path.join(installRoot, "releases"),
    currentLink: path.join(installRoot, "current"),
    transportConfigPath: path.join(installRoot, "transport.json"),
    runtimeKeyPath: path.join(installRoot, "secrets", "openai-runtime-key"),
    profileDir: path.join(installRoot, "tunnel-profile"),
  });
}

async function assertNormalFile(filePath, label, { executable = false, maxBytes = null } = {}) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a normal file.`);
  if (Number.isFinite(maxBytes) && (stat.size < 1 || stat.size > maxBytes)) {
    throw new Error(`${label} has an invalid size.`);
  }
  if (executable && (stat.mode & 0o111) === 0) throw new Error(`${label} must be executable.`);
  return stat;
}

export async function resolveSupervisorRelease(paths) {
  const link = await fs.lstat(paths.currentLink);
  if (!link.isSymbolicLink()) throw new Error("Managed current pointer must be a symbolic link.");
  const releasesRoot = await fs.realpath(paths.releasesRoot);
  const releaseDir = await fs.realpath(paths.currentLink);
  if (!inside(releasesRoot, releaseDir) || path.dirname(releaseDir) !== releasesRoot) {
    throw new Error("Managed current pointer escaped the releases root.");
  }
  const version = path.basename(releaseDir);
  parseEquinoxVersion(version);
  const metadataPath = path.join(releaseDir, "release.json");
  const { data: metadataText } = await readBoundedNormalFile(metadataPath, {
    minBytes: 1,
    maxBytes: 16 * 1024,
    encoding: "utf8",
    label: "Release metadata",
  });
  const metadata = JSON.parse(metadataText);
  const expectedTarget = equinoxLocalUpdateTarget();
  if (
    metadata?.schemaVersion !== 1 ||
    metadata?.version !== version ||
    metadata?.target !== expectedTarget ||
    metadata?.serverEntry !== "server.js"
  ) {
    throw new Error(`Managed release metadata is invalid for ${expectedTarget}.`);
  }
  for (const relative of [
    path.join("runtime", "node", "bin", "node"),
    path.join("runtime", "tunnel", "tunnel-client"),
    path.join("runtime", "tunnel", "cloudflared"),
  ]) {
    await assertNormalFile(path.join(releaseDir, relative), `Runtime ${relative}`, { executable: true });
  }
  await assertNormalFile(path.join(releaseDir, "server.js"), "Equinox Local server");
  return Object.freeze({ version, releaseDir, metadata: Object.freeze({ ...metadata }) });
}

export async function readSupervisorTransport(paths) {
  let text;
  try {
    ({ data: text } = await readBoundedNormalFile(paths.transportConfigPath, {
      minBytes: 1,
      maxBytes: MAX_TRANSPORT_CONFIG_BYTES,
      encoding: "utf8",
      label: "Transport configuration",
    }));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Transport configuration must be a bounded normal file.");
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Transport configuration is not valid JSON.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Transport configuration must be an object.");
  const keys = Object.keys(raw).sort();
  const expectedKeys = ["mode", "tunnelId", "version"];
  if (keys.length !== expectedKeys.length || keys.some((value, index) => value !== expectedKeys[index])) {
    throw new Error("Transport configuration contains missing or unsupported fields.");
  }
  if (raw.version !== TRANSPORT_CONFIG_VERSION || raw.mode !== TRANSPORT_MODE || !TUNNEL_ID_PATTERN.test(raw.tunnelId)) {
    throw new Error("Transport configuration is invalid.");
  }
  const keyStat = await assertNormalFile(paths.runtimeKeyPath, "OpenAI runtime key", { maxBytes: MAX_RUNTIME_KEY_BYTES });
  if ((keyStat.mode & 0o077) !== 0) throw new Error("OpenAI runtime key permissions must not allow group or other access.");
  return Object.freeze({ version: raw.version, mode: raw.mode, tunnelId: raw.tunnelId });
}

export function shellQuote(value) {
  const text = String(value);
  return `'${text.replaceAll("'", `'\"'\"'`)}'`;
}

export function supervisorChildEnvironment({ paths, releaseDir, sourceEnv = process.env }) {
  const env = {
    HOME: paths.homeDir,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
    EQUINOX_LOCAL_INSTALL_ROOT: paths.installRoot,
    EQUINOX_LOCAL_RELEASE_DIR: releaseDir,
  };
  for (const key of ["USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SSH_AUTH_SOCK"]) {
    if (typeof sourceEnv[key] === "string" && sourceEnv[key]) env[key] = sourceEnv[key];
  }
  return Object.freeze(env);
}

export function tunnelInitArguments({ paths, releaseDir, transport }) {
  const nodeBinary = path.join(releaseDir, "runtime", "node", "bin", "node");
  const serverPath = path.join(releaseDir, "server.js");
  const mcpCommand = `${shellQuote(nodeBinary)} ${shellQuote(serverPath)}`;
  return Object.freeze([
    "init",
    "--force",
    "--sample", "sample_mcp_stdio_local",
    "--profile", PROFILE_NAME,
    "--profile-dir", paths.profileDir,
    "--tunnel-id", transport.tunnelId,
    "--mcp-command", mcpCommand,
    "--control-plane-api-key-ref", `file:${paths.runtimeKeyPath}`,
    "--health-listen-addr", "127.0.0.1:0",
  ]);
}

async function runChild(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawnChild(command, args, options);
    let terminatingSignal = null;
    const forward = (signal) => {
      terminatingSignal = signal;
      if (!child.killed) child.kill(signal);
    };
    process.once("SIGTERM", forward);
    process.once("SIGINT", forward);
    child.once("error", (error) => {
      process.removeListener("SIGTERM", forward);
      process.removeListener("SIGINT", forward);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      process.removeListener("SIGTERM", forward);
      process.removeListener("SIGINT", forward);
      resolve(Object.freeze({ code, signal, terminatingSignal }));
    });
  });
}

export async function runManagedSupervisor({
  homeDir = os.homedir(),
  sourceEnv = process.env,
  execFileImpl = execFile,
  runChildImpl = runChild,
} = {}) {
  if (process.platform !== "darwin") throw new Error("Managed Equinox Local supervisor is supported only on macOS.");
  const paths = managedSupervisorPaths(homeDir);
  const configuredRoot = sourceEnv.EQUINOX_LOCAL_INSTALL_ROOT;
  if (configuredRoot && path.resolve(configuredRoot) !== paths.installRoot) {
    throw new Error("Managed supervisor install root does not match the per-user Equinox Local location.");
  }
  const release = await resolveSupervisorRelease(paths);
  const logicalReleaseDir = path.join(paths.releasesRoot, release.version);
  const env = supervisorChildEnvironment({ paths, releaseDir: logicalReleaseDir, sourceEnv });
  const tunnelEnv = Object.freeze({ ...env, EQUINOX_LOCAL_SUPERVISOR_MODE: "tunnel" });
  const localOnlyEnv = Object.freeze({ ...env, EQUINOX_LOCAL_SUPERVISOR_MODE: "local-only" });
  const nodeBinary = path.join(release.releaseDir, "runtime", "node", "bin", "node");
  const serverPath = path.join(release.releaseDir, "server.js");
  const tunnelBinary = path.join(release.releaseDir, "runtime", "tunnel", "tunnel-client");

  let transport = null;
  try {
    transport = await readSupervisorTransport(paths);
  } catch (error) {
    log(`Tunnel configuration needs attention; starting local-only Control Center: ${error instanceof Error ? error.message : error}`);
  }

  if (transport) {
    try {
      await fs.mkdir(paths.profileDir, { recursive: true, mode: 0o700 });
      await fs.chmod(paths.profileDir, 0o700).catch(() => {});
      await execFileImpl(tunnelBinary, tunnelInitArguments({ paths, releaseDir: release.releaseDir, transport }), {
        env,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      log(`Starting Equinox Local ${release.version} through the OpenAI tunnel transport.`);
      const result = await runChildImpl(tunnelBinary, ["run", "--profile", PROFILE_NAME, "--profile-dir", paths.profileDir], {
        env: tunnelEnv,
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (result.terminatingSignal) return Object.freeze({ mode: "tunnel", ...result });
      log(`Tunnel transport exited (${result.signal || result.code || "unknown"}); falling back to local-only Control Center.`);
    } catch (error) {
      log(`Tunnel transport could not start; falling back to local-only Control Center: ${error instanceof Error ? error.message : error}`);
    }
  } else {
    log(`No tunnel transport is configured; starting Equinox Local ${release.version} in local-only onboarding mode.`);
  }

  const result = await runChildImpl(nodeBinary, [serverPath], {
    env: localOnlyEnv,
    stdio: ["pipe", "inherit", "inherit"],
  });
  return Object.freeze({ mode: "local-only", ...result });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && path.basename(invokedPath) === path.basename(fileURLToPath(import.meta.url))) {
  runManagedSupervisor().catch((error) => {
    log(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
