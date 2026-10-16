import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installManagedEquinoxRelease } from "../../src/equinox-local-first-install.js";
import { readManagedCurrentRelease, waitForEquinoxLocalVersion } from "../../src/equinox-local-update-activation.js";
import { equinoxLocalManagedSourcePaths } from "../../src/equinox-local-managed-source-installation.js";
import { fingerprintEquinoxLocalNativeState } from "../../src/equinox-local-native-state-fingerprint.js";
import { managedSupervisorPaths } from "../../src/equinox-local-supervisor.js";
import { equinoxLocalReleaseRuntimeContract } from "../../src/equinox-local-release-runtime-contract.js";

const VERSION = "5.2.1";
const SOURCE = "b".repeat(40); // Deliberately not the first-enrollment bootstrap SHA.
const INSTALLER = new URL("../../src/equinox-local-first-install.js", import.meta.url).href;
const exists = async (name) => fs.lstat(name).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});

async function fixture(t, platform = "darwin") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "same-version-repair-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "User Home");
  await fs.mkdir(homeDir);
  const arch = "x64";
  const target = `${platform}-${arch}`;
  const env = { ...process.env, LOCALAPPDATA: path.join(root, "Local App Data") };
  const paths = managedSupervisorPaths(homeDir, { platform, arch, env });
  const mainPaths = equinoxLocalManagedSourcePaths({ platform, arch, homeDir, env });
  const stagedReleaseDir = path.join(paths.installRoot, "staging", "first", "release");
  const targetRelease = path.join(paths.releasesRoot, VERSION);
  const backupRoot = path.join(paths.installRoot, ".stable-repair-backup");
  await fs.mkdir(stagedReleaseDir, { recursive: true, mode: 0o700 });
  const contract = equinoxLocalReleaseRuntimeContract({ target, version: VERSION });
  const files = [...contract.runtimeExecutables, ...contract.runtimeDocuments, ...contract.requiredReleaseFiles, ...contract.nativeShellFiles];
  if (platform === "darwin") files.push("runtime/app/applet", "runtime/app/EquinoxLocal.png", "runtime/app/native-app.json");
  for (const name of files) {
    const file = path.join(stagedReleaseDir, name);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `signed-stable:${name}\n`, { mode: 0o700 });
  }
  await fs.writeFile(path.join(stagedReleaseDir, "release.json"), JSON.stringify({
    schemaVersion: 1, version: VERSION, target, sourceSha: "c".repeat(40),
    nodeVersion: "26.10.0", tunnelClientVersion: "0.0.16", serverEntry: "server.js",
    ...(platform === "darwin" ? { nativeAppShellVersion: 1 } : {}),
  }), { mode: 0o600 });
  await fs.mkdir(paths.releasesRoot, { recursive: true, mode: 0o700 });
  await fs.cp(stagedReleaseDir, targetRelease, { recursive: true });
  await fs.writeFile(path.join(targetRelease, "server.js"), "old-numbered-main\n");
  await fs.writeFile(path.join(targetRelease, "main-only.js"), "must not leak into Stable\n");
  if (platform === "darwin") await fs.symlink(`releases/${VERSION}`, paths.currentLink);
  else await fs.writeFile(paths.currentPointer, JSON.stringify({ schemaVersion: 1, target, version: VERSION }));
  await fs.mkdir(mainPaths.mainTransactionRoot, { recursive: true, mode: 0o700 });
  const stamp = JSON.stringify({ schemaVersion: 1, channel: "main", repository: "sametbasbug/equinox-local", branch: "main", bootstrapSha: "a".repeat(40) });
  await fs.writeFile(mainPaths.installStampPath, stamp, { mode: 0o600 });
  const nativePayloadRoot = path.join(mainPaths.mainTransactionRoot, "native-store", target, SOURCE);
  const nativeRelease = path.join(nativePayloadRoot, "release");
  await fs.cp(targetRelease, nativeRelease, { recursive: true });
  await fs.writeFile(path.join(nativeRelease, "server.js"), "exact-old-native-store\n");
  const releaseFingerprint = await fingerprintEquinoxLocalNativeState(nativeRelease);
  await fs.writeFile(path.join(nativePayloadRoot, "native-store.json"), JSON.stringify({
    schemaVersion: 1, channel: "main", sourceSha: SOURCE, target,
    runtimeContractSha256: "d".repeat(64), artifactSha256: "e".repeat(64), artifactBytes: 123,
    payloadVersion: VERSION, releaseFingerprint,
  }), { mode: 0o600 });
  await fs.writeFile(path.join(mainPaths.mainTransactionRoot, "current-native.json"), JSON.stringify({
    schemaVersion: 1, channel: "main", sourceSha: SOURCE, target, runtimeContractSha256: "d".repeat(64),
  }), { mode: 0o600 });
  const preserved = new Map();
  for (const name of ["config.json", "secrets/openai-runtime-key", "tunnel/profile.json", "browser/profile/Preferences", "workspace/user.txt", "main-update/current-source.conf"]) {
    const file = path.join(paths.installRoot, name);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const content = `user-owned:${name}\n`;
    await fs.writeFile(file, content, { mode: 0o600 });
    preserved.set(file, content);
  }
  const stableFingerprint = await fingerprintEquinoxLocalNativeState(stagedReleaseDir);
  const oldFingerprint = await fingerprintEquinoxLocalNativeState(targetRelease);
  return { root, homeDir, platform, arch, target, env, paths, mainPaths, stagedReleaseDir, targetRelease,
    backupRoot, nativeRelease, stamp, preserved, stableFingerprint, oldFingerprint };
}

function options(f, overrides = {}) {
  return {
    stagedReleaseDir: f.stagedReleaseDir, homeDir: f.homeDir, platform: f.platform,
    arch: f.arch, target: f.target, uid: process.getuid?.() ?? 501, env: f.env,
    bootstrapImpl: async () => { throw new Error("same-version repair must not bootstrap or alter user configuration"); },
    initializeOnboardingImpl: async () => { throw new Error("existing onboarding must be preserved"); },
    enrollManagedSourceImpl: async () => { throw new Error("repair cannot enroll Main"); },
    execFileImpl: async () => ({ stdout: "", stderr: "" }),
    stopWindowsShellImpl: async () => {},
    launchWindowsShellImpl: async () => {},
    syncManagedShellImpl: async (_installation, release) => {
      const stable = release.releaseDir === f.targetRelease;
      assert.equal(stable ? release.previousReleaseDir : release.releaseDir, f.nativeRelease);
      await fs.writeFile(path.join(f.root, "shell"), stable ? "Stable" : "Main");
      await fs.writeFile(path.join(f.root, "native-messaging"), release.releaseDir);
    },
    waitForVersionImpl: async (version, budget) => {
      assert.equal(version, VERSION);
      assert.equal(budget.attempts, f.platform === "win32" ? 180 : 120);
      const isMain = await exists(f.mainPaths.installStampPath);
      assert.equal(budget.expectedInstallationKind, isMain ? "managed-source" : "managed");
      assert.equal(await fs.readFile(path.join(f.root, "shell"), "utf8"), isMain ? "Main" : "Stable");
    },
    ...overrides,
  };
}

async function assertPreserved(f) {
  for (const [file, content] of f.preserved) assert.equal(await fs.readFile(file, "utf8"), content);
}

async function freshStage(f) {
  const dir = path.join(f.paths.installRoot, "staging", "retry", "release");
  await fs.cp(f.nativeRelease, dir, { recursive: true });
  await fs.writeFile(path.join(dir, "server.js"), "new-signed-stable\n");
  await fs.rm(path.join(dir, "main-only.js"));
  return dir;
}

for (const platform of ["darwin", "win32"]) {
  const skip = platform === "win32" && process.platform !== "win32";
  test(`${platform} same-version Main repair replaces the full tree and verifies managed Stable`, { skip }, async (t) => {
    const f = await fixture(t, platform);
    const result = await installManagedEquinoxRelease(options(f));
    assert.equal(result.status, "activated");
    assert.deepEqual(await fingerprintEquinoxLocalNativeState(f.targetRelease), f.stableFingerprint);
    assert.equal(await exists(f.backupRoot), false);
    assert.equal(await exists(f.mainPaths.installStampPath), false);
    assert.equal(await exists(`${f.mainPaths.installStampPath}.stable-install-backup`), false);
    assert.equal(await fs.readFile(path.join(f.root, "native-messaging"), "utf8"), f.targetRelease);
    await assertPreserved(f);
  });

  test(`${platform} same-version Stable failure restores numbered Main, stamp and exact old native-store`, { skip }, async (t) => {
    const f = await fixture(t, platform);
    const original = options(f);
    const events = [];
    await assert.rejects(installManagedEquinoxRelease({ ...original,
      waitForVersionImpl: async (version, budget) => {
        await original.waitForVersionImpl(version, budget);
        events.push(budget.expectedInstallationKind);
        if (budget.expectedInstallationKind === "managed") throw new Error("injected bad Stable health");
      },
    }), /rolled back to Main/u);
    assert.deepEqual(events, ["managed", "managed-source"]);
    assert.deepEqual(await fingerprintEquinoxLocalNativeState(f.targetRelease), f.oldFingerprint);
    assert.equal(await fs.readFile(f.mainPaths.installStampPath, "utf8"), f.stamp);
    assert.equal(await fs.readFile(path.join(f.root, "native-messaging"), "utf8"), f.nativeRelease);
    assert.equal(await exists(f.backupRoot), false);
    await assertPreserved(f);
  });
}

test("same-version Stable health rejects an equally healthy, same-version Main process", async () => {
  for (const kind of ["managed-source", undefined]) {
    await assert.rejects(waitForEquinoxLocalVersion(VERSION, {
      attempts: 1, expectedInstallationKind: "managed",
      fetchImpl: async () => ({ ok: true, json: async () => ({ status: {
        server: { version: VERSION }, health: { state: "HEALTHY" }, installation: { kind },
      } }) }),
    }), /did not become healthy/u);
  }
  await waitForEquinoxLocalVersion(VERSION, {
    attempts: 1, expectedInstallationKind: "managed",
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: {
      server: { version: VERSION }, health: { state: "HEALTHY" }, installation: { kind: "managed" },
    } }) }),
  });
});

// These are real process deaths, not exceptions that execute the installer's
// catch/rollback path. Every mutation before the exit is on the actual FS.
const WORKER = `
import fs from 'node:fs/promises';
import path from 'node:path';
import { installManagedEquinoxRelease } from ${JSON.stringify(INSTALLER)};
const f = JSON.parse(process.argv[1]);
const point = process.argv[2];
const old = path.join(f.backupRoot, 'release');
const saved = f.mainPaths.installStampPath + '.stable-install-backup';
const die = (at) => { if (point === at) process.exit(73); };
await installManagedEquinoxRelease({
  stagedReleaseDir: f.stagedReleaseDir, homeDir: f.homeDir, platform: f.platform,
  arch: f.arch, target: f.target, uid: f.uid, env: f.env,
  fsImpl: { ...fs,
    rename: async (from, to) => {
      await fs.rename(from, to);
      if (to === path.join(f.backupRoot, 'repair.json')) die('prepared');
      if (to === old) die('rename-gap');
      if (from === f.stagedReleaseDir) die('promoted');
      if (to === saved) die('parked');
      if (to === path.join(f.backupRoot, 'failed-release')) die('rollback-gap');
      if (from === old) die('old-restored');
      if (from === saved) die('stamp-restored');
    },
    rm: async (name, opts) => {
      if (name === old && point === 'cleanup-partial') {
        await fs.rm(path.join(old, 'server.js')); process.exit(73);
      }
      if (name === path.join(f.backupRoot, 'failed-release') && point === 'rollback-cleanup') {
        await fs.rm(path.join(name, 'server.js')); process.exit(73);
      }
      await fs.rm(name, opts);
      if (name === saved) die('committed');
      if (name === path.join(f.backupRoot, 'repair.json')) die('record-removed');
    },
  },
  bootstrapImpl: async () => { throw new Error('unexpected bootstrap'); },
  execFileImpl: async (_cmd, args) => { if (args[0] === 'bootstrap') die('restarted'); return {stdout:'',stderr:''}; },
  stopWindowsShellImpl: async () => {},
  launchWindowsShellImpl: async () => die('restarted'),
  syncManagedShellImpl: async (_installation, release) => {
    const stable = release.releaseDir === f.targetRelease;
    await fs.writeFile(path.join(f.root, 'shell'), stable ? 'Stable' : 'Main');
    if (stable) die('partial-native');
    await fs.writeFile(path.join(f.root, 'native-messaging'), release.releaseDir);
    if (stable) die('native-synced');
  },
  waitForVersionImpl: async (_version, budget) => {
    if (budget.expectedInstallationKind === 'managed') {
      if (['rollback-gap', 'old-restored', 'stamp-restored', 'rollback-cleanup'].includes(point)) throw new Error('bad B');
      die('healthy');
    }
  },
});
throw new Error('interruption point was not reached');
`;

function interrupt(f, point) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", WORKER,
    JSON.stringify({ ...f, preserved: undefined, uid: process.getuid?.() ?? 501 }), point], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 73, `${point}: ${result.stderr}`);
}

for (const point of ["prepared", "rename-gap", "promoted", "parked", "partial-native", "native-synced", "restarted", "healthy", "rollback-gap", "old-restored", "stamp-restored", "rollback-cleanup"]) {
  test(`interrupted same-version repair recovers Main before readCurrentImpl: ${point}`, async (t) => {
    const f = await fixture(t, process.platform === "win32" ? "win32" : "darwin");
    interrupt(f, point);
    let reads = 0;
    const stagedReleaseDir = await freshStage(f);
    // Stop at the current-release boundary: recovery must already have fully
    // restored Main, even when the numbered target was missing on entry.
    await assert.rejects(installManagedEquinoxRelease(options(f, {
      stagedReleaseDir,
      readCurrentImpl: async (installation) => {
        reads++;
        assert.equal(await exists(f.backupRoot), false);
        assert.equal(await fs.readFile(f.mainPaths.installStampPath, "utf8"), f.stamp);
        assert.deepEqual(await fingerprintEquinoxLocalNativeState(f.targetRelease), f.oldFingerprint);
        assert.equal(await fs.readFile(path.join(f.root, "native-messaging"), "utf8"), f.nativeRelease);
        await readManagedCurrentRelease(installation);
        throw new Error("recovery boundary reached");
      },
    })), /recovery boundary reached/u);
    assert.equal(reads, 1);
    // Repeated invocation after recovery performs a normal full Stable swap.
    assert.equal((await installManagedEquinoxRelease(options(f, { stagedReleaseDir }))).status, "activated");
    assert.equal(await exists(f.backupRoot), false);
    await assertPreserved(f);
  });
}

for (const point of ["committed", "cleanup-partial"]) {
  test(`post-HEALTHY cleanup resumes Stable without resurrecting Main: ${point}`, async (t) => {
    const f = await fixture(t, process.platform === "win32" ? "win32" : "darwin");
    interrupt(f, point);
    assert.equal(await exists(f.mainPaths.installStampPath), false);
    assert.equal(await exists(`${f.mainPaths.installStampPath}.stable-install-backup`), false);
    const result = await installManagedEquinoxRelease(options(f, {
      // The original staging tree is already consumed. Committed recovery
      // must not need a fresh download or resolve an incomplete old release.
      readCurrentImpl: async () => { throw new Error("committed recovery must happen first"); },
    }));
    assert.equal(result.status, "activated");
    assert.deepEqual(await fingerprintEquinoxLocalNativeState(f.targetRelease), f.stableFingerprint);
    assert.equal(await exists(f.backupRoot), false);
    assert.equal(await exists(f.mainPaths.installStampPath), false);
    await assertPreserved(f);
  });
}

test("foreign backup entries, changed target and conflicting stamps fail closed before current resolution", async (t) => {
  for (const mutation of ["foreign-entry", "target-drift", "duplicate-stamp", "native-drift", "backup-symlink", "pointer-drift"]) {
    await t.test(mutation, async (t) => {
      const f = await fixture(t, process.platform === "win32" ? "win32" : "darwin");
      interrupt(f, "parked");
      if (mutation === "foreign-entry") await fs.writeFile(path.join(f.backupRoot, "unexpected"), "foreign");
      if (mutation === "target-drift") await fs.writeFile(path.join(f.targetRelease, "server.js"), "foreign");
      if (mutation === "duplicate-stamp") await fs.writeFile(f.mainPaths.installStampPath, f.stamp);
      if (mutation === "native-drift") await fs.writeFile(path.join(f.nativeRelease, "server.js"), "foreign");
      if (mutation === "backup-symlink") {
        await fs.rename(f.backupRoot, `${f.backupRoot}-actual`);
        await fs.symlink(`${f.backupRoot}-actual`, f.backupRoot, "junction");
      }
      if (mutation === "pointer-drift") {
        if (f.platform === "win32") await fs.writeFile(f.paths.currentPointer, JSON.stringify({ schemaVersion: 1, target: f.target, version: "5.2.0" }));
        else { await fs.rm(f.paths.currentLink); await fs.symlink("releases/5.2.0", f.paths.currentLink); }
      }
      let actions = 0;
      await assert.rejects(installManagedEquinoxRelease(options(f, {
        readCurrentImpl: async () => { actions++; throw new Error("must not read current"); },
        execFileImpl: async () => { actions++; throw new Error("must not touch runtime"); },
        syncManagedShellImpl: async () => { actions++; throw new Error("must not touch shell"); },
      })));
      assert.equal(actions, 0);
      assert.equal(await exists(f.backupRoot), true);
      await assertPreserved(f);
    });
  }
});
