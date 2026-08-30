import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION } from "./equinox-local-runtime-versions.js";

const execFile = promisify(execFileCallback);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(ROOT, ".equinox-local-dev-runtime.conf");
const MAX_CONFIG_BYTES = 16 * 1024;

export function parseSourceRuntimeConfig(text) {
  const values = new Map();
  for (const rawLine of String(text).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) throw new Error("Developer runtime config is malformed.");
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    if (!new Set(["launchAgentLabel", "tunnelRuntime", "tunnelClient"]).has(key)) {
      throw new Error("Developer runtime config contains an unsupported field.");
    }
    if (values.has(key)) throw new Error("Developer runtime config contains a duplicate field.");
    values.set(key, value);
  }
  const tunnelClient = values.get("tunnelClient") || "";
  if (!path.isAbsolute(tunnelClient)) throw new Error("Developer tunnel-client path is invalid.");
  return Object.freeze({
    launchAgentLabel: values.get("launchAgentLabel") || "",
    tunnelRuntime: values.get("tunnelRuntime") || "",
    tunnelClient,
  });
}

export async function readSourceRuntimeConfig({
  configPath = process.env.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG || DEFAULT_CONFIG,
  fsImpl = fs,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  const resolvedConfigPath = path.resolve(configPath);
  try {
    const { data, stat } = await readBoundedNormalFile(resolvedConfigPath, {
      fsImpl,
      maxBytes: MAX_CONFIG_BYTES,
      encoding: "utf8",
      label: "Developer runtime config",
    });
    const mode = stat.mode & 0o777;
    if (Number.isInteger(uid) && stat.uid !== uid) throw new Error("Developer runtime config ownership is invalid.");
    if (mode !== 0o600 && mode !== 0o400) throw new Error("Developer runtime config permissions are invalid.");
    return Object.freeze({ configured: true, configPath: resolvedConfigPath, config: parseSourceRuntimeConfig(data) });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ configured: false, configPath: resolvedConfigPath, config: null });
    throw error;
  }
}

export async function updateSourceRuntimeTunnelClient(configPath, tunnelClient, {
  fsImpl = fs,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (typeof configPath !== "string" || !path.isAbsolute(configPath)) throw new Error("Developer runtime config path is invalid.");
  if (typeof tunnelClient !== "string" || !path.isAbsolute(tunnelClient)) throw new Error("Developer tunnel-client path is invalid.");
  const { data, stat } = await readBoundedNormalFile(configPath, {
    fsImpl,
    maxBytes: MAX_CONFIG_BYTES,
    encoding: "utf8",
    label: "Developer runtime config",
  });
  const mode = stat.mode & 0o777;
  if (Number.isInteger(uid) && stat.uid !== uid) throw new Error("Developer runtime config ownership is invalid.");
  if (mode !== 0o600 && mode !== 0o400) throw new Error("Developer runtime config permissions are invalid.");

  let replacements = 0;
  const next = data.split(/\r?\n/u).map((line) => {
    if (!line.startsWith("tunnelClient=")) return line;
    replacements += 1;
    return `tunnelClient=${tunnelClient}`;
  }).join("\n");
  if (replacements !== 1) throw new Error("Developer runtime config must contain exactly one tunnelClient field.");

  const parent = path.dirname(configPath);
  const parentStat = await fsImpl.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Developer runtime config parent is unsafe.");
  if (Number.isInteger(uid) && parentStat.uid !== uid) throw new Error("Developer runtime config parent ownership is invalid.");
  if ((parentStat.mode & 0o022) !== 0) throw new Error("Developer runtime config parent must not be group/world writable.");

  const temporary = path.join(parent, `.equinox-local-dev-runtime-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await fsImpl.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(next, "utf8");
    await handle.sync();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
  try {
    await fsImpl.rename(temporary, configPath);
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function parseTunnelClientVersion(text) {
  const match = String(text).trim().match(/^(\d+\.\d+\.\d+)(?:\+|\s|$)/u);
  return match ? match[1] : null;
}

export async function inspectSourceTunnelRuntime({
  configPath,
  fsImpl = fs,
  execFileImpl = execFile,
  expectedVersion = EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  try {
    const loaded = await readSourceRuntimeConfig({ configPath, fsImpl, uid });
    if (!loaded.configured) {
      return Object.freeze({
        configured: false,
        expectedVersion,
        actualVersion: null,
        synchronized: null,
        needsAttention: false,
      });
    }
    let actualVersion = null;
    try {
      const binaryStat = await fsImpl.lstat(loaded.config.tunnelClient);
      if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) throw new Error("Developer tunnel-client is unsafe.");
      if (Number.isInteger(uid) && binaryStat.uid !== uid) throw new Error("Developer tunnel-client ownership is invalid.");
      if ((binaryStat.mode & 0o022) !== 0) throw new Error("Developer tunnel-client must not be group/world writable.");
      const { stdout = "" } = await execFileImpl(loaded.config.tunnelClient, ["--version"], {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      actualVersion = parseTunnelClientVersion(stdout);
    } catch {
      // Keep diagnostics bounded and do not expose the configured executable path.
    }
    return Object.freeze({
      configured: true,
      expectedVersion,
      actualVersion,
      synchronized: actualVersion === expectedVersion,
      needsAttention: actualVersion !== expectedVersion,
    });
  } catch {
    return Object.freeze({
      configured: true,
      expectedVersion,
      actualVersion: null,
      synchronized: false,
      needsAttention: true,
    });
  }
}
