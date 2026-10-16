import fs from "node:fs/promises";
import path from "node:path";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function samePath(first, second, platform) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const a = api.normalize(first);
  const b = api.normalize(second);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Invoked only AFTER the newly selected Stable release has passed its runtime
// health and durable activation receipt. Never erase the authenticated active
// release or a foreign/junction entry. The Main channel has separate native
// and source pointers and must not use this Stable-only pruner for those stores.
export async function pruneInactiveManagedStableReleases(installation, {
  fsImpl = fs,
  readCurrent,
} = {}) {
  if (typeof readCurrent !== "function") throw new Error("Managed release cleanup requires the authenticated current-pointer reader.");
  const platform = installation?.platform;
  if (!["win32", "darwin"].includes(platform)) throw new Error("Unsupported managed release cleanup platform.");
  const api = platform === "win32" ? path.win32 : path.posix;
  const installRoot = api.resolve(installation.installRoot ?? "");
  const releasesRoot = api.resolve(installation.releasesRoot ?? "");
  if (!api.isAbsolute(installation.installRoot ?? "") ||
      !api.isAbsolute(installation.releasesRoot ?? "") ||
      !samePath(releasesRoot, api.join(installRoot, "releases"), platform)) {
    throw new Error("Managed release cleanup refuses a foreign directory.");
  }
  const rootStat = await fsImpl.lstat(releasesRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      !samePath(await fsImpl.realpath(releasesRoot), releasesRoot, platform)) {
    throw new Error("Managed release cleanup root is not a canonical normal directory.");
  }
  const active = await readCurrent(installation);
  if (!VERSION.test(active?.version ?? "") ||
      !samePath(active?.releaseDir ?? "", api.join(releasesRoot, active.version), platform)) {
    throw new Error("Managed release cleanup cannot verify the active pointer.");
  }
  const deleted = [];
  const entries = await fsImpl.readdir(releasesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!VERSION.test(entry.name) || entry.name === active.version) continue;
    // A junction or unknown filesystem object may be foreign. Fail closed
    // rather than recursively traversing an untrusted release location.
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = api.join(releasesRoot, entry.name);
    const checked = await fsImpl.lstat(candidate);
    if (!checked.isDirectory() || checked.isSymbolicLink() ||
        !samePath(await fsImpl.realpath(candidate), candidate, platform)) continue;
    const stillActive = await readCurrent(installation);
    if (stillActive.version !== active.version ||
        !samePath(stillActive.releaseDir, active.releaseDir, platform)) {
      throw new Error("Managed current release moved during cleanup; refusing to prune.");
    }
    await fsImpl.rm(candidate, { recursive: true, force: false });
    deleted.push(entry.name);
  }
  return Object.freeze({ active: active.version, deleted: Object.freeze(deleted) });
}
