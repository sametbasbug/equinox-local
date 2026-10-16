import fs from "node:fs/promises";
import path from "node:path";

import { readEquinoxLocalMainSourcePointer } from "./equinox-local-main-source-pointer.js";
import { readEquinoxLocalMainNativePointer } from "./equinox-local-main-native-state.js";
import { equinoxLocalToolchainContract } from "./equinox-local-toolchain-contract.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { readManagedCurrentRelease } from "./equinox-local-update-activation.js";
import { assertWindowsStableShellOwnedByRelease } from "./equinox-local-windows-stable-shell.js";
import { assertWindowsNativeMessagingHostOwnership } from "./equinox-browser-windows-native-messaging.js";

const SHA = /^[a-f0-9]{40}$/u;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const TX = /^main-[a-f0-9]{32}$/u;
const RETRYABLE = new Set(["EACCES", "EBUSY", "EPERM", "ENOTEMPTY"]);

function normal(api, a, b, platform) {
  const first = api.normalize(a);
  const second = api.normalize(b);
  return platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}

async function safeDirectory(directory, { fsImpl, platform, optional = false }) {
  let stat;
  try { stat = await fsImpl.lstat(directory); }
  catch (error) {
    if (optional && error?.code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      !normal(platform === "win32" ? path.win32 : path.posix, await fsImpl.realpath(directory), directory, platform)) {
    throw new Error("Main storage cleanup refuses an unsafe or redirected directory.");
  }
  return true;
}

// Only the live, committed Main B runtime can reclaim A. Never run from the
// detached update worker: it may still own A's Node executable during handoff.
// Settings, profiles, toolchains, receipts and private credentials are excluded.
export async function pruneVerifiedMainLargeStorage({
  installation,
  platform = process.platform,
  fsImpl = fs,
  processExecutable = process.execPath,
  runtimeVersion,
  readSource = readEquinoxLocalMainSourcePointer,
  readNative = readEquinoxLocalMainNativePointer,
} = {}) {
  if (installation?.kind !== "managed-source" || installation.managed !== true ||
      !["win32", "darwin"].includes(platform)) throw new Error("Only a managed-source runtime may reclaim Main storage.");
  const api = platform === "win32" ? path.win32 : path.posix;
  const install = api.resolve(installation.installRoot ?? "");
  const transaction = api.join(install, platform === "win32" ? "state" : "", "main-update");
  if (!api.isAbsolute(installation.installRoot ?? "") ||
      !normal(api, installation.mainTransactionRoot, transaction, platform)) {
    throw new Error("Main storage root is not owned by this managed installation.");
  }
  await safeDirectory(transaction, { fsImpl, platform });
  const activeLock = api.join(transaction, "active.json");
  async function ensureUnowned() {
    try { await fsImpl.lstat(activeLock); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    throw new Error("An active Main update prevents pruning its rollback slots.");
  }
  async function identities() {
    await ensureUnowned();
    // Main source pointers must be authenticated by the product-owned Git,
    // not by whatever ambient 'git' happens to be on Windows PATH.
    const source = await readSource(api.join(transaction, "current-source.conf"), {
      ...(installation.gitPath ? { gitPath: installation.gitPath } : {}),
    });
    const native = await readNative(api.join(transaction, "current-native.json"), { transactionRoot: transaction });
    if (!SHA.test(source.sha) || !SHA.test(native.sourceSha) ||
        native.target !== installation.target ||
        source.sha !== installation.sourceSha ||
        !normal(api, source.sourceRoot, installation.sourceRoot, platform) ||
        !normal(api, native.releaseDir, installation.releaseDir, platform)) {
      throw new Error("Committed Main runtime pointer identity changed; refusing cleanup.");
    }
    const expectedExec = api.join(native.releaseDir, "runtime", "node", "bin", platform === "win32" ? "node.exe" : "node");
    if (!normal(api, processExecutable, expectedExec, platform)) {
      throw new Error("Old bootstrap is still executing; retaining all rollback-capable versions.");
    }
    return { source, native };
  }
  const admitted = await identities();
  const versionPath = api.join(admitted.source.sourceRoot, "src", "equinox-local-version.js");
  const versionStat = await fsImpl.lstat(versionPath);
  if (!versionStat.isFile() || versionStat.isSymbolicLink() || versionStat.size < 25 || versionStat.size > 1024) {
    throw new Error("Active Main version declaration is unsafe.");
  }
  const declaration = await fsImpl.readFile(versionPath, "utf8");
  const match = /^export const EQUINOX_LOCAL_VERSION = "(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)";$/mu.exec(declaration);
  if (!match || runtimeVersion !== `${match[1]}.${match[2]}.${match[3]}`) {
    throw new Error("Active runtime version is not the committed Main source version.");
  }
  const clean = { releases: [], sources: [], native: [], staging: [], toolchains: [], pending: [] };
  async function prune(root, bucket, accept, protectedName = null) {
    if (!await safeDirectory(root, { fsImpl, platform, optional: true })) return;
    for (const entry of await fsImpl.readdir(root, { withFileTypes: true })) {
      if (!await accept(entry.name) || entry.name === protectedName ||
          !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const current = await identities();
      if (current.source.sha !== admitted.source.sha || current.native.sourceSha !== admitted.native.sourceSha) {
        throw new Error("Main identity changed while pruning.");
      }
      const candidate = api.join(root, entry.name);
      if (!await safeDirectory(candidate, { fsImpl, platform })) continue;
      try {
        await fsImpl.rm(candidate, { recursive: true, force: false });
        clean[bucket].push(entry.name);
      } catch (error) {
        if (!RETRYABLE.has(error?.code)) throw error;
        // A live Windows worker can hold A briefly. Do not mark cleanup
        // complete and retry on the next healthy runtime start.
        clean.pending.push(`${bucket}/${entry.name}`);
      }
    }
  }
  await prune(api.join(install, "releases"), "releases", (name) => VERSION.test(name));
  await prune(api.join(transaction, "sources"), "sources", (name) => SHA.test(name), admitted.source.sha);
  await prune(api.join(transaction, "native-store", installation.target), "native", (name) => SHA.test(name), admitted.native.sourceSha);
  // A genuinely healthy, running B with no active Main transaction has no
  // pending rollback to A. Old succeeded, failed, rolled_back or abandoned
  // staging trees are all superseded; keep only the small immutable receipts.
  await prune(api.join(transaction, "staging"), "staging", (name) => TX.test(name));
  const contract = equinoxLocalToolchainContract({
    runtimeRoot: api.join(install, "runtime"), target: installation.target,
  });
  // Only prune old product-owned Git/Node toolchains if the B server is
  // actually using BOTH exact current versioned distributions. Never touch
  // arbitrary ambient runtimes, the active pinned versions or other apps.
  if (installation.gitPath &&
      normal(api, installation.gitPath, contract.gitPath, platform) &&
      normal(api, installation.nodePath, contract.nodePath, platform) &&
      normal(api, installation.npmPath, contract.npmPath, platform)) {
    for (const component of [contract.git, contract.node]) {
      await prune(api.join(contract.toolchainRoot, component.component), "toolchains",
        (name) => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(name),
        component.version);
    }
  }
  return Object.freeze(clean);
}

// A classic signed reinstall may replace Main entirely after exact B health.
// At that point old Main source/native payloads and pinned toolchains are no
// longer required; reclaim them from the running Stable B process, never from
// the A handoff worker. Keep small receipts and all private user state intact.
export async function pruneDisenrolledWindowsMainLargeStorage({
  installation,
  runtimeVersion,
  processExecutable = process.execPath,
  fsImpl = fs,
  readStable = readManagedCurrentRelease,
  verifyShell = assertWindowsStableShellOwnedByRelease,
  verifyNativeHost = assertWindowsNativeMessagingHostOwnership,
} = {}) {
  if (installation?.kind !== "managed" || installation.managed !== true ||
      installation.platform !== "win32" || installation.selfUpdateSupported !== true) {
    throw new Error("Only a running managed Windows Stable runtime can retire old Main payloads.");
  }
  const api = path.win32;
  const install = api.resolve(installation.installRoot ?? "");
  const releases = api.join(install, "releases");
  const tx = api.join(install, "state", "main-update");
  if (!api.isAbsolute(installation.installRoot ?? "") ||
      !normal(api, installation.releasesRoot, releases, "win32") ||
      !normal(api, installation.releaseDir, api.join(releases, runtimeVersion), "win32") ||
      !VERSION.test(runtimeVersion ?? "") ||
      installation.target !== `win32-${installation.arch}`) {
    throw new Error("Stable Main-retirement location does not belong to the installed product.");
  }
  const expectedNode = api.join(installation.releaseDir, "runtime", "node", "bin", "node.exe");
  if (!normal(api, processExecutable, expectedNode, "win32")) {
    throw new Error("An older Main worker is still executing; refusing to reclaim native payloads.");
  }
  if (!await safeDirectory(tx, { fsImpl, platform: "win32", optional: true })) {
    return Object.freeze({ sources: [], native: [], staging: [], toolchains: [], pointers: [], pending: [] });
  }
  const markerNames = [
    "install.json", "install.json.stable-install-backup", "active.json", "classic-repair.json",
  ];
  const ensureStable = async () => {
    for (const marker of markerNames) {
      try { await fsImpl.lstat(api.join(tx, marker)); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      throw new Error("Main install or repair remains active; native retirement is not safe.");
    }
    try { await fsImpl.lstat(api.join(install, ".stable-repair-backup")); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    // An explicit source of truth on every delete prevents pruning after a
    // concurrent updater switches the current stable release.
    const current = await readStable(installation);
    if (current.version !== runtimeVersion || !normal(api, current.releaseDir, installation.releaseDir, "win32")) {
      throw new Error("Stable release identity drifted during Main retirement.");
    }
    return current;
  };
  await ensureStable();
  const shell = await verifyShell({ releaseDir: installation.releaseDir, programRoot: installation.programRoot });
  if (shell?.owned !== true ||
      !normal(api, shell.shellExecutable, api.join(installation.programRoot, "EquinoxLocal.exe"), "win32")) {
    throw new Error("Active Stable WPF ownership is unverified.");
  }
  const expectedLauncher = api.join(installation.releaseDir, "runtime", "browser", "equinox-browser-native-host.exe");
  const host = await verifyNativeHost({
    manifestRoot: installation.nativeMessagingManifestRoot, acceptedLauncherPaths: [expectedLauncher],
  });
  if (!normal(api, host?.launcherPath, expectedLauncher, "win32")) {
    throw new Error("Active Stable Native Messaging ownership is unverified.");
  }
  const result = { sources: [], native: [], staging: [], toolchains: [], pointers: [], pending: [] };
  async function prune(root, bucket, accepts, protectedName = null) {
    if (!await safeDirectory(root, { fsImpl, platform: "win32", optional: true })) return;
    for (const entry of await fsImpl.readdir(root, { withFileTypes: true })) {
      if (!accepts(entry.name) || entry.name === protectedName || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      await ensureStable();
      const candidate = api.join(root, entry.name);
      if (!await safeDirectory(candidate, { fsImpl, platform: "win32" })) continue;
      try {
        await fsImpl.rm(candidate, { recursive: true, force: false });
        result[bucket].push(entry.name);
      } catch (error) {
        if (!RETRYABLE.has(error?.code)) throw error;
        result.pending.push(`${bucket}/${entry.name}`);
      }
    }
  }
  await prune(api.join(tx, "sources"), "sources", (name) => SHA.test(name));
  await prune(api.join(tx, "native-store", installation.target), "native", (name) => SHA.test(name));
  await prune(api.join(tx, "staging"), "staging", (name) => TX.test(name));
  const contract = equinoxLocalToolchainContract({
    runtimeRoot: api.join(install, "runtime"), target: installation.target,
  });
  for (const component of [contract.git, contract.node]) {
    await prune(api.join(contract.toolchainRoot, component.component), "toolchains",
      (name) => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(name),
      component.version);
  }
  // Former Main pointers are metadata, not credentials. Leaving them aimed at
  // reclaimed SHAs would cause a later explicit Main enrollment to bootstrap
  // the wrong native A. Retire only exact previously owned metadata records.
  async function retirePointer(name, validate) {
    const filePath = api.join(tx, name);
    let file;
    try {
      file = await readBoundedNormalFile(filePath, {
        fsImpl, platform: "win32", minBytes: 2, maxBytes: 8192,
        encoding: "utf8", label: "Retired Main identity pointer",
      });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (!validate(file.data)) throw new Error("Retired Main pointer was not an exact product-owned record.");
    await ensureStable();
    await fsImpl.unlink(filePath);
    result.pointers.push(name);
  }
  await retirePointer("current-source.conf", (data) => {
    const match = /^schemaVersion=1\r?\nsourceRoot=(.+)\r?\nsha=([a-f0-9]{40})\r?\n?$/u.exec(data);
    return Boolean(match && normal(api, match[1], api.join(tx, "sources", match[2]), "win32"));
  });
  await retirePointer("current-native.json", (data) => {
    let value;
    try { value = JSON.parse(data); } catch { return false; }
    return value?.schemaVersion === 1 && value.channel === "main" &&
      value.target === installation.target && SHA.test(value.sourceSha ?? "") &&
      /^[a-f0-9]{64}$/u.test(value.runtimeContractSha256 ?? "") &&
      Object.keys(value).sort().join(",") ===
        ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"].sort().join(",");
  });
  return Object.freeze(result);
}
