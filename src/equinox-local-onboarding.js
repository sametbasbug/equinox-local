import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  managedSupervisorPaths,
  readSupervisorTransport,
  TUNNEL_ID_PATTERN,
} from "./equinox-local-supervisor.js";

const MAX_RUNTIME_KEY_BYTES = 4 * 1024;
const MIN_RUNTIME_KEY_CHARS = 16;

function assertManagedInstallation(installation) {
  if (
    !installation?.managed ||
    !installation?.selfUpdateSupported ||
    typeof installation.installRoot !== "string" ||
    typeof installation.releaseDir !== "string"
  ) {
    throw new Error("Tunnel onboarding is available only for a managed Equinox Local installation.");
  }
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Equinox Local onboarding directory is unsafe.");
  }
  await fs.chmod(directory, 0o700);
}

async function readOptionalNormalFile(filePath, { maxBytes = MAX_RUNTIME_KEY_BYTES } = {}) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) {
      throw new Error("Existing onboarding file is unsafe.");
    }
    return await fs.readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(filePath, contents, mode = 0o600) {
  const parent = path.dirname(filePath);
  await ensurePrivateDirectory(parent);
  const temp = path.join(parent, `.equinox-onboarding-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temp, contents, { flag: "wx", mode });
    await fs.rename(temp, filePath);
    await fs.chmod(filePath, mode);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function validateRuntimeKey(value) {
  if (typeof value !== "string") throw new Error("Runtime API key must be text.");
  if (value.length < MIN_RUNTIME_KEY_CHARS || Buffer.byteLength(value, "utf8") > MAX_RUNTIME_KEY_BYTES) {
    throw new Error("Runtime API key has an invalid length.");
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Runtime API key contains unsupported whitespace or control characters.");
  }
  return value;
}

export function validateTunnelOnboardingInput(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Tunnel onboarding body must be a JSON object.");
  }
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "runtimeKey" || keys[1] !== "tunnelId") {
    throw new Error("Tunnel onboarding accepts only tunnelId and runtimeKey.");
  }
  if (typeof body.tunnelId !== "string" || !TUNNEL_ID_PATTERN.test(body.tunnelId)) {
    throw new Error("Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters.");
  }
  return Object.freeze({
    tunnelId: body.tunnelId,
    runtimeKey: validateRuntimeKey(body.runtimeKey),
  });
}

export async function getManagedOnboardingStatus({
  installation,
  homeDir = process.env.HOME,
  supervisorMode = process.env.EQUINOX_LOCAL_SUPERVISOR_MODE || null,
} = {}) {
  if (!installation?.managed || !installation?.selfUpdateSupported) {
    return Object.freeze({
      available: false,
      managed: false,
      transportConfigured: false,
      supervisorMode: "source",
      connectedThroughTunnel: false,
      needsAttention: false,
    });
  }
  const paths = managedSupervisorPaths(homeDir);
  if (path.resolve(paths.installRoot) !== path.resolve(installation.installRoot)) {
    throw new Error("Managed onboarding root does not match the active installation.");
  }

  let transport = null;
  let transportError = null;
  try {
    transport = await readSupervisorTransport(paths);
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
  }
  const normalizedMode = supervisorMode === "tunnel" ? "tunnel" : "local-only";
  return Object.freeze({
    available: true,
    managed: true,
    transportConfigured: Boolean(transport),
    tunnelId: transport?.tunnelId ?? null,
    supervisorMode: normalizedMode,
    connectedThroughTunnel: Boolean(transport && normalizedMode === "tunnel"),
    needsAttention: Boolean(transportError || (transport && normalizedMode !== "tunnel")),
    issue: transportError ? "Tunnel configuration needs attention." : null,
  });
}

export async function configureManagedTunnel({
  installation,
  homeDir = process.env.HOME,
  tunnelId,
  runtimeKey,
} = {}) {
  assertManagedInstallation(installation);
  const input = validateTunnelOnboardingInput({ tunnelId, runtimeKey });
  const paths = managedSupervisorPaths(homeDir);
  if (path.resolve(paths.installRoot) !== path.resolve(installation.installRoot)) {
    throw new Error("Managed onboarding root does not match the active installation.");
  }

  await ensurePrivateDirectory(paths.installRoot);
  await ensurePrivateDirectory(path.dirname(paths.runtimeKeyPath));

  const previousKey = await readOptionalNormalFile(paths.runtimeKeyPath);
  const previousConfig = await readOptionalNormalFile(paths.transportConfigPath, { maxBytes: 16 * 1024 });
  const transport = `${JSON.stringify({
    version: 1,
    mode: "openai-tunnel",
    tunnelId: input.tunnelId,
  }, null, 2)}\n`;

  try {
    await atomicWrite(paths.runtimeKeyPath, input.runtimeKey, 0o600);
    await atomicWrite(paths.transportConfigPath, transport, 0o600);
  } catch (error) {
    try {
      if (previousKey) await atomicWrite(paths.runtimeKeyPath, previousKey, 0o600);
      else await fs.rm(paths.runtimeKeyPath, { force: true });
      if (previousConfig) await atomicWrite(paths.transportConfigPath, previousConfig, 0o600);
      else await fs.rm(paths.transportConfigPath, { force: true });
    } catch {
      // Preserve the original failure; the next status read will fail closed if rollback also failed.
    }
    throw error;
  }

  return Object.freeze({
    configured: true,
    tunnelId: input.tunnelId,
    restartRequired: true,
  });
}
