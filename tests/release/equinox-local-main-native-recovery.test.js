import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  equinoxLocalMainNativeRecoveryDescriptor,
  readEquinoxLocalMainNativeRecoveryDescriptor,
  recoverEquinoxLocalMainNativeLifecycle,
  writeEquinoxLocalMainNativeRecoveryDescriptor,
} from "../../src/equinox-local-main-native-recovery.js";

const A = "1".repeat(40);
const B = "2".repeat(40);
const DA = "a".repeat(64);
const DB = "b".repeat(64);
const TX = `main-${"c".repeat(32)}`;
function transition(target) { return { mode: "artifact_required", target, currentSha: A, targetSha: B, currentRuntimeContractSha256: DA, targetRuntimeContractSha256: DB }; }

async function scratch(t) {
  const raw = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "equinox-main-native-recovery-"));
  t.after(() => fs.rm(raw, { recursive: true, force: true }));
  await fs.mkdir(path.join(raw, "staging", TX, "native-rollback"), { recursive: true, mode: 0o700 });
  return raw;
}

test("native recovery descriptor stores identities without arbitrary release paths", () => {
  const main = equinoxLocalMainNativeRecoveryDescriptor({ transition: transition("darwin-arm64"), previousPointer: { sourceSha: A, target: "darwin-arm64", runtimeContractSha256: DA, releaseDir: "/do/not/persist" }, installation: { releaseDir: "/stable/5.2.0" } });
  assert.deepEqual(main.previous, { kind: "main", sourceSha: A, target: "darwin-arm64", runtimeContractSha256: DA });
  assert.equal(JSON.stringify(main).includes("/do/not/persist"), false);
  const stable = equinoxLocalMainNativeRecoveryDescriptor({ transition: transition("darwin-arm64"), previousPointer: null, installation: { releaseDir: "/stable/5.2.0" } });
  assert.deepEqual(stable.previous, { kind: "stable", version: "5.2.0" });
});

test("native recovery descriptor is immutable-once-created and exact-identity bound", async (t) => {
  const root = await scratch(t);
  const args = { transition: transition("darwin-arm64"), previousPointer: null, installation: { releaseDir: "/stable/5.2.0" }, transactionRoot: root, transactionId: TX };
  const first = await writeEquinoxLocalMainNativeRecoveryDescriptor(args);
  const second = await writeEquinoxLocalMainNativeRecoveryDescriptor(args);
  assert.deepEqual(second, first);
  const file = path.join(root, "staging", TX, "native-rollback", "native-recovery.json");
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(readEquinoxLocalMainNativeRecoveryDescriptor({ transactionRoot: root, transactionId: TX, expected: { targetSha: A } }), /target SHA mismatch/u);
  assert.equal(await fs.readFile(file, "utf8"), before);
  await assert.rejects(writeEquinoxLocalMainNativeRecoveryDescriptor({ ...args, previousPointer: { sourceSha: A, target: "darwin-arm64", runtimeContractSha256: DA } }), /immutable identity mismatch/u);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("Darwin recovery reconstructs Stable baseline and exact target without current-native pointer", async () => {
  const events = [];
  const target = "darwin-arm64";
  const root = "/private/tmp/equinox-recovery-state";
  const stored = `${root}/native-store/${target}/${B}/release`;
  const lifecycle = await recoverEquinoxLocalMainNativeLifecycle({
    transition: transition(target), transactionRoot: root, transactionId: TX,
    installation: { managed: true, selfUpdateSupported: true, target, platform: "darwin", installRoot: "/Users/test/Library/Application Support/Equinox Local", releasesRoot: "/Users/test/Library/Application Support/Equinox Local/releases", releaseDir: "/Users/test/Library/Application Support/Equinox Local/releases/5.2.0" },
    readDescriptorImpl: async () => ({ schemaVersion: 1, channel: "main", targetSha: B, target, targetRuntimeContractSha256: DB, previous: { kind: "stable", version: "5.2.0" } }),
    inspectStoredReleaseImpl: async (value) => { events.push(["stored", value]); return { releaseDir: stored, sourceSha: B, target, runtimeContractSha256: DB }; },
    inspectDarwinSnapshotImpl: async (value) => events.push(["snapshot", value]),
    activateDarwinImpl: async (value) => events.push(["activate", value]),
    restoreDarwinImpl: async (value) => events.push(["rollback", value]),
    writePointerImpl: async (_file, value) => { events.push(["commit", value]); return value; },
  });
  await lifecycle.activate(); await lifecycle.rollback(); await lifecycle.commit();
  assert.deepEqual(events.map(([name]) => name), ["stored", "snapshot", "activate", "rollback", "commit"]);
  assert.equal(events[2][1].releaseDir, stored);
  assert.equal(events[4][1].sourceSha, B);
});

test("Windows recovery derives previous Main release only from exact durable identity", async () => {
  const events = [];
  const target = "win32-x64";
  const root = "/private/tmp/equinox-win-recovery-state";
  const targetRelease = `C:\\State\\native-store\\${target}\\${B}\\release`;
  const previousRelease = `C:\\State\\native-store\\${target}\\${A}\\release`;
  const launcher = (release) => `${release}\\runtime\\browser\\host.exe`;
  const lifecycle = await recoverEquinoxLocalMainNativeLifecycle({
    transition: transition(target), transactionRoot: root, transactionId: TX,
    installation: { managed: true, selfUpdateSupported: true, target, platform: "win32", releasesRoot: "C:\\Stable", programRoot: "C:\\Program\\Equinox Local", nativeMessagingManifestRoot: "C:\\State\\manifest" },
    readDescriptorImpl: async () => ({ schemaVersion: 1, channel: "main", targetSha: B, target, targetRuntimeContractSha256: DB, previous: { kind: "main", sourceSha: A, target, runtimeContractSha256: DA } }),
    inspectStoredReleaseImpl: async (value) => { events.push(["stored", value.sourceSha]); return { releaseDir: value.sourceSha === B ? targetRelease : previousRelease }; },
    inspectWindowsSnapshotImpl: async () => events.push(["snapshot"]),
    activateWindowsImpl: async (value) => { events.push(["activate", value]); return {}; },
    restoreWindowsImpl: async (value) => { events.push(["rollback", value]); return {}; },
    assertWindowsNativeHostImpl: async (value) => events.push(["ownership", value]),
    registerWindowsNativeHostImpl: async (value) => events.push(["register", value]),
    windowsLauncherPathImpl: launcher,
    writePointerImpl: async (_file, value) => { events.push(["commit", value]); return value; },
  });
  await lifecycle.activate(); await lifecycle.rollback(); await lifecycle.commit();
  assert.deepEqual(events.slice(0, 3).map(([name]) => name), ["stored", "stored", "snapshot"]);
  assert.deepEqual(events.slice(0, 2).map(([, sha]) => sha), [B, A]);
  assert.equal(events.find(([name]) => name === "activate")[1].previousReleaseDir, previousRelease);
  const registrations = events.filter(([name]) => name === "register").map(([, value]) => value.launcherPath);
  assert.deepEqual(registrations, [launcher(targetRelease), launcher(previousRelease)]);
});
