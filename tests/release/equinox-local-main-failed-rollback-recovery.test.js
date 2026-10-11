import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { recoverVerifiedWindowsMainFailedRollback } from "../../src/equinox-local-main-failed-rollback-recovery.js";

const A = "1".repeat(40);
const B = "2".repeat(40);
const TX = `main-${"a".repeat(32)}`;
const ROOT = "C:\\Users\\User\\AppData\\Local\\Equinox Local";
const STATE = path.win32.join(ROOT, "state", "main-update");
const OLD = path.win32.join(STATE, "sources", A);
const NEW = path.win32.join(STATE, "sources", B);
const RELEASE = path.win32.join(ROOT, "releases", "6.0.4");
const launcher = path.win32.join(RELEASE, "runtime", "browser", "equinox-browser-native-host.exe");
const shell = path.win32.join("C:\\Users\\User\\AppData\\Local\\Programs\\Equinox Local", "EquinoxLocal.exe");
const installation = {
  kind: "managed-source", managed: true, selfUpdateSupported: true, platform: "win32",
  gitPath: path.win32.join(ROOT, "runtime", "toolchain", "git.exe"),
  mainTransactionRoot: STATE, sourceRoot: OLD, sourceSha: A,
  programRoot: path.win32.dirname(shell), nativeMessagingManifestRoot: path.win32.join(ROOT, "browser", "native-messaging"),
  releaseDir: RELEASE,
};

function fixture(overrides = {}) {
  const calls = [];
  let active = {
    transactionId: TX, currentSha: A, rollbackSha: A, targetSha: B,
    rollbackSourceRoot: OLD, targetSourceRoot: NEW, status: "rollback_failed", stage: "rollback_failed",
  };
  const deps = {
    installation, engineFactory: () => ({
      paths: { sourcePointerPath: path.win32.join(STATE, "current-source.conf") },
      readActive: async () => active,
      archiveVerifiedFailedRollbackLock: async (id, sha) => { calls.push(["archive", id, sha]); return { archived: true }; },
    }),
    inspectWorker: async () => ({ running: false, stale: true, loaded: true, uncertain: false }),
    cleanupWorker: async () => { calls.push(["cleanup"]); return { cleaned: true }; },
    readPointer: async () => ({ sha: A, sourceRoot: OLD }),
    inspectCheckout: async () => ({ eligible: true, currentSha: A }),
    readRelease: async () => ({ version: "6.0.4", releaseDir: RELEASE }),
    verifyShell: async () => ({ owned: true, shellExecutable: shell }),
    verifyNativeHost: async () => ({ launcherPath: launcher }),
    verifyHealth: async () => true,
    ...overrides,
  };
  return { deps, calls, update: (next) => { active = { ...active, ...next }; } };
}

test("default dry-run audits rollback, native shell, messaging, health and worker without touching lock", async () => {
  const f = fixture();
  const result = await recoverVerifiedWindowsMainFailedRollback(f.deps);
  assert.deepEqual(result, { status: "verified_dry_run", transactionId: TX, originalSha: A, failedTargetSha: B });
  assert.deepEqual(f.calls, []);
});

test("explicit apply re-audits after worker cleanup and archives only failed lock", async () => {
  const f = fixture();
  const result = await recoverVerifiedWindowsMainFailedRollback({ ...f.deps, apply: true });
  assert.equal(result.status, "recovered");
  assert.deepEqual(f.calls, [["cleanup"], ["archive", TX, { currentSha: A, targetSha: B }]]);
});

test("refuses mutated pointer, runtime, WPF, Native Messaging and active worker before cleanup", async () => {
  const mutations = [
    { readPointer: async () => ({ sha: B, sourceRoot: NEW }) },
    { verifyHealth: async () => false },
    { verifyShell: async () => ({ owned: false, shellExecutable: shell }) },
    { verifyNativeHost: async () => ({ launcherPath: "C:\\Foreign\\host.exe" }) },
    { inspectWorker: async () => ({ running: true, uncertain: false }) },
    { inspectWorker: async () => ({ running: false, uncertain: true }) },
    { readRelease: async () => ({ releaseDir: "C:\\Foreign\\release" }) },
  ];
  for (const change of mutations) {
    const f = fixture(change);
    await assert.rejects(recoverVerifiedWindowsMainFailedRollback({ ...f.deps, apply: true }));
    assert.deepEqual(f.calls, []);
  }
});

test("rejects wrong receipt state, altered source ownership and active target commit", async () => {
  for (const change of [
    { status: "rolled_back" }, { rollbackSha: B }, { targetSourceRoot: "C:\\Foreign\\source" },
    { rollbackSourceRoot: "C:\\Foreign\\source" }, { targetSha: A },
  ]) {
    const f = fixture(); f.update(change);
    await assert.rejects(recoverVerifiedWindowsMainFailedRollback({ ...f.deps, apply: true }));
    assert.deepEqual(f.calls, []);
  }
});

test("refuses lock release if receipt changes during the second full audit", async () => {
  const f = fixture();
  let checks = 0;
  f.deps.cleanupWorker = async () => { f.calls.push(["cleanup"]); f.update({ targetSha: "3".repeat(40) }); return { cleaned: true }; };
  f.deps.verifyHealth = async () => { checks += 1; return true; };
  await assert.rejects(recoverVerifiedWindowsMainFailedRollback({ ...f.deps, apply: true }));
  assert.equal(checks, 1); // receipt changed before the second health check
  assert.deepEqual(f.calls, [["cleanup"]]);
});

test("requires Windows managed-source provenance and pinned Git", async () => {
  for (const change of [{ platform: "darwin" }, { kind: "managed" }, { gitPath: "git" }]) {
    const f = fixture();
    await assert.rejects(recoverVerifiedWindowsMainFailedRollback({ ...f.deps, installation: { ...installation, ...change } }));
    assert.deepEqual(f.calls, []);
  }
});
