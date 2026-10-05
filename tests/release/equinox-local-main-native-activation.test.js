import assert from "node:assert/strict";
import test from "node:test";

import { prepareEquinoxLocalMainNativeLifecycle } from "../../src/equinox-local-main-native-activation.js";

const A = "1".repeat(40);
const B = "2".repeat(40);
const DA = "a".repeat(64);
const DB = "b".repeat(64);
const TX = `main-${"c".repeat(32)}`;
const ROOT = "/private/tmp/equinox-main-state";

function transition(target) {
  return { mode: "artifact_required", target, currentSha: A, targetSha: B, currentRuntimeContractSha256: DA, targetRuntimeContractSha256: DB };
}
function candidate(target, releaseDir) {
  return { sourceSha: B, target, transactionId: TX, runtimeContractSha256: DB, artifactSha256: "d".repeat(64), artifactBytes: 42, payloadVersion: "5.2.1", releaseDir };
}

test("Darwin Main native lifecycle snapshots before activation and advances pointer only on commit", async () => {
  const events = [];
  const target = "darwin-arm64";
  const durable = `${ROOT}/native-store/${target}/${B}/release`;
  const lifecycle = await prepareEquinoxLocalMainNativeLifecycle({
    transition: transition(target), candidate: candidate(target, `${ROOT}/staging/${TX}/native-candidate/release`), transactionRoot: ROOT, transactionId: TX,
    installation: { managed: true, selfUpdateSupported: true, target, installRoot: "/Users/test/Library/Application Support/Equinox Local", releaseDir: "/stable/5.2.0" },
    promoteCandidateImpl: async () => ({ sourceSha: B, target, runtimeContractSha256: DB, releaseDir: durable }),
    readPointerImpl: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    snapshotDarwinImpl: async (value) => events.push(["snapshot", value]),
    writeRecoveryDescriptorImpl: async (value) => events.push(["recovery-descriptor", value]),
    activateDarwinImpl: async (value) => events.push(["activate", value]),
    restoreDarwinImpl: async (value) => events.push(["rollback", value]),
    writePointerImpl: async (_path, value) => { events.push(["commit", value]); return value; },
  });
  assert.deepEqual(events.map(([name]) => name), ["snapshot", "recovery-descriptor"]);
  await lifecycle.activate();
  await lifecycle.commit();
  await lifecycle.rollback();
  assert.deepEqual(events.map(([name]) => name), ["snapshot", "recovery-descriptor", "activate", "commit", "rollback"]);
  assert.equal(events[2][1].releaseDir, durable);
  assert.equal(events[3][1].sourceSha, B);
});

test("Windows Main native lifecycle keeps shell and Native Messaging on the same durable release", async () => {
  const events = [];
  const target = "win32-x64";
  const durable = `C:\\State\\native-store\\${target}\\${B}\\release`;
  const previous = `C:\\State\\native-store\\${target}\\${A}\\release`;
  const launcher = (releaseDir) => `${releaseDir}\\runtime\\browser\\host.exe`;
  const lifecycle = await prepareEquinoxLocalMainNativeLifecycle({
    transition: transition(target), candidate: candidate(target, `C:\\State\\staging\\${TX}\\native-candidate\\release`), transactionRoot: ROOT, transactionId: TX,
    installation: { managed: true, selfUpdateSupported: true, target, releaseDir: "C:\\Stable\\5.2.0", programRoot: "C:\\Program\\Equinox Local", nativeMessagingManifestRoot: "C:\\State\\manifest" },
    promoteCandidateImpl: async () => ({ sourceSha: B, target, runtimeContractSha256: DB, releaseDir: durable }),
    readPointerImpl: async () => ({ sourceSha: A, target, runtimeContractSha256: DA, releaseDir: previous }),
    snapshotWindowsImpl: async (value) => events.push(["snapshot", value]),
    writeRecoveryDescriptorImpl: async (value) => events.push(["recovery-descriptor", value]),
    activateWindowsImpl: async (value) => { events.push(["shell-target", value]); return {}; },
    restoreWindowsImpl: async (value) => { events.push(["shell-rollback", value]); return {}; },
    assertWindowsNativeHostImpl: async (value) => events.push(["ownership", value]),
    registerWindowsNativeHostImpl: async (value) => events.push(["register", value]),
    windowsLauncherPathImpl: launcher,
    writePointerImpl: async (_path, value) => { events.push(["commit", value]); return value; },
  });
  await lifecycle.activate();
  await lifecycle.commit();
  await lifecycle.rollback();
  assert.deepEqual(events.map(([name]) => name), ["snapshot", "recovery-descriptor", "ownership", "shell-target", "register", "commit", "shell-rollback", "register"]);
  assert.equal(events[3][1].previousReleaseDir, previous);
  assert.equal(events[4][1].launcherPath, launcher(durable));
  assert.equal(events[7][1].launcherPath, launcher(previous));
});

test("Main native lifecycle rejects a stale native pointer before platform mutation", async () => {
  const target = "darwin-arm64";
  let mutated = false;
  await assert.rejects(prepareEquinoxLocalMainNativeLifecycle({
    transition: transition(target), candidate: candidate(target, `${ROOT}/staging/${TX}/native-candidate/release`), transactionRoot: ROOT, transactionId: TX,
    installation: { managed: true, selfUpdateSupported: true, target, installRoot: "/Users/test/Library/Application Support/Equinox Local", releaseDir: "/stable/5.2.0" },
    promoteCandidateImpl: async () => ({ sourceSha: B, target, runtimeContractSha256: DB, releaseDir: `${ROOT}/native-store/${target}/${B}/release` }),
    readPointerImpl: async () => ({ sourceSha: A, target, runtimeContractSha256: "e".repeat(64), releaseDir: "/old" }),
    snapshotDarwinImpl: async () => { mutated = true; },
  }), /does not match the current source runtime contract/u);
  assert.equal(mutated, false);
});
