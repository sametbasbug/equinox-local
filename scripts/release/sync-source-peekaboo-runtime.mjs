import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  inspectSourcePeekabooRuntime,
  readSourceRuntimeConfig,
  updateSourceRuntimePeekabooPath,
} from "../../src/equinox-local-source-runtime.js";
import { EQUINOX_LOCAL_PEEKABOO_VERSION } from "../../src/equinox-local-runtime-versions.js";
import { installPinnedPeekabooRuntime } from "./package-managed-release.mjs";

function modeBits(stat) {
  return stat.mode & 0o777;
}

async function ensurePrivateDirectory(directory, { fsImpl = fs, uid } = {}) {
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Developer Peekaboo runtime directory is unsafe.");
  if (Number.isInteger(uid) && stat.uid !== uid) throw new Error("Developer Peekaboo runtime directory ownership is invalid.");
  if ((modeBits(stat) & 0o022) !== 0) throw new Error("Developer Peekaboo runtime directory must not be group/world writable.");
}

export function developerPeekabooLayout({ homeDir }) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) throw new Error("A trusted user home directory is required for source Peekaboo synchronization.");
  const developerRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local Developer");
  const runtimeRoot = path.join(developerRoot, "runtime");
  const peekabooRoot = path.join(runtimeRoot, "peekaboo");
  const versionsRoot = path.join(peekabooRoot, "versions");
  const versionDir = path.join(versionsRoot, EQUINOX_LOCAL_PEEKABOO_VERSION);
  const binaryPath = path.join(versionDir, "peekaboo");
  return Object.freeze({ developerRoot, runtimeRoot, peekabooRoot, versionsRoot, versionDir, binaryPath });
}

export async function syncSourcePeekabooRuntime({
  configPath,
  fsImpl = fs,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  homeDir = process.env.HOME,
  installPinnedPeekabooRuntimeImpl = installPinnedPeekabooRuntime,
  inspectImpl = inspectSourcePeekabooRuntime,
  updateConfigImpl = updateSourceRuntimePeekabooPath,
} = {}) {
  const loaded = await readSourceRuntimeConfig({ configPath, fsImpl, uid });
  if (!loaded.configured) throw new Error("Developer runtime config is missing.");

  const layout = developerPeekabooLayout({ homeDir });
  for (const directory of [layout.developerRoot, layout.runtimeRoot, layout.peekabooRoot, layout.versionsRoot]) {
    await ensurePrivateDirectory(directory, { fsImpl, uid });
  }

  if (loaded.config.peekabooPath === layout.binaryPath) {
    const before = await inspectImpl({ configPath, fsImpl, uid });
    if (before.synchronized) return Object.freeze({ changed: false, version: EQUINOX_LOCAL_PEEKABOO_VERSION });
  }

  const transaction = await fsImpl.mkdtemp(path.join(layout.versionsRoot, ".sync-"));
  const releaseDir = path.join(transaction, "release");
  try {
    await installPinnedPeekabooRuntimeImpl(releaseDir);
    const sourceRuntime = path.join(releaseDir, "runtime", "peekaboo");
    const sourceStat = await fsImpl.lstat(sourceRuntime);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Pinned Peekaboo runtime output is unsafe.");
    await fsImpl.rm(layout.versionDir, { recursive: true, force: true });
    await fsImpl.rename(sourceRuntime, layout.versionDir);
  } finally {
    await fsImpl.rm(transaction, { recursive: true, force: true });
  }

  await updateConfigImpl(loaded.configPath, layout.binaryPath, { fsImpl, uid });
  const after = await inspectImpl({ configPath: loaded.configPath, fsImpl, uid });
  if (!after.synchronized) throw new Error("Developer Peekaboo synchronization did not produce the pinned version.");
  return Object.freeze({ changed: true, version: EQUINOX_LOCAL_PEEKABOO_VERSION });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  syncSourcePeekabooRuntime()
    .then((result) => process.stdout.write(`Developer Peekaboo ${result.changed ? "synchronized" : "already synchronized"} at ${result.version}.\n`))
    .catch((error) => {
      process.stderr.write(`Equinox Local source Peekaboo sync: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
