import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { equinoxLocalUpdateTarget } from "../../src/equinox-local-updater.js";
import {
  inspectSourceTunnelRuntime,
  readSourceRuntimeConfig,
  updateSourceRuntimeTunnelClient,
} from "../../src/equinox-local-source-runtime.js";
import { EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION } from "../../src/equinox-local-runtime-versions.js";
import { installPinnedTunnelRuntime } from "./package-managed-release.mjs";

function modeBits(stat) {
  return stat.mode & 0o777;
}

async function ensurePrivateDirectory(directory, { fsImpl = fs, uid } = {}) {
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Developer tunnel runtime directory is unsafe.");
  if (Number.isInteger(uid) && stat.uid !== uid) throw new Error("Developer tunnel runtime directory ownership is invalid.");
  if ((modeBits(stat) & 0o022) !== 0) throw new Error("Developer tunnel runtime directory must not be group/world writable.");
}

function developerTunnelLayout({ homeDir, target }) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) throw new Error("A trusted user home directory is required for source tunnel synchronization.");
  const developerRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local Developer");
  const runtimeRoot = path.join(developerRoot, "runtime");
  const tunnelRoot = path.join(runtimeRoot, "tunnel");
  const versionsRoot = path.join(tunnelRoot, "versions");
  const versionDir = path.join(versionsRoot, `${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-${target}`);
  return Object.freeze({ developerRoot, runtimeRoot, tunnelRoot, versionsRoot, versionDir });
}

export async function syncSourceTunnelRuntime({
  configPath,
  fsImpl = fs,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  homeDir = process.env.HOME,
  target = equinoxLocalUpdateTarget(),
  installPinnedTunnelRuntimeImpl = installPinnedTunnelRuntime,
  inspectImpl = inspectSourceTunnelRuntime,
  updateConfigImpl = updateSourceRuntimeTunnelClient,
} = {}) {
  const loaded = await readSourceRuntimeConfig({ configPath, fsImpl, uid });
  if (!loaded.configured) throw new Error("Developer runtime config is missing.");

  const layout = developerTunnelLayout({ homeDir, target });
  for (const directory of [layout.developerRoot, layout.runtimeRoot, layout.tunnelRoot, layout.versionsRoot]) {
    await ensurePrivateDirectory(directory, { fsImpl, uid });
  }
  const versionDir = layout.versionDir;
  const versionsRoot = layout.versionsRoot;
  const managedTunnelClient = path.join(versionDir, "tunnel-client");

  if (loaded.config.tunnelClient === managedTunnelClient) {
    const before = await inspectImpl({ configPath, fsImpl, uid });
    if (before.synchronized) {
      return Object.freeze({ changed: false, version: EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION });
    }
  }

  const transaction = await fsImpl.mkdtemp(path.join(versionsRoot, ".sync-"));
  const releaseDir = path.join(transaction, "release");
  try {
    await installPinnedTunnelRuntimeImpl(target, releaseDir);
    const sourceRuntime = path.join(releaseDir, "runtime", "tunnel");
    const sourceStat = await fsImpl.lstat(sourceRuntime);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Pinned tunnel runtime output is unsafe.");
    await fsImpl.rm(versionDir, { recursive: true, force: true });
    await fsImpl.rename(sourceRuntime, versionDir);
  } finally {
    await fsImpl.rm(transaction, { recursive: true, force: true });
  }

  await updateConfigImpl(loaded.configPath, managedTunnelClient, { fsImpl, uid });
  const after = await inspectImpl({ configPath: loaded.configPath, fsImpl, uid });
  if (!after.synchronized) throw new Error("Developer tunnel-client synchronization did not produce the pinned version.");
  return Object.freeze({ changed: true, version: EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  syncSourceTunnelRuntime()
    .then((result) => process.stdout.write(`Developer tunnel-client ${result.changed ? "synchronized" : "already synchronized"} at ${result.version}.\n`))
    .catch((error) => {
      process.stderr.write(`Equinox Local source tunnel sync: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
