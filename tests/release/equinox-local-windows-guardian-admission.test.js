import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { equinoxLocalToolchainContract } from "../../src/equinox-local-toolchain-contract.js";
import { inspectEquinoxLocalWindowsGuardianAdmission } from "../../src/equinox-local-windows-guardian-admission.js";

const local = "C:\\Users\\Tester\\AppData\\Local";
const installRoot = path.win32.join(local, "Equinox Local");
const programRoot = path.win32.join(local, "Programs", "Equinox Local");
const transactionRoot = path.win32.join(installRoot, "state", "main-update");
const A = "a".repeat(40);
const B = "b".repeat(40);
const shaDigest = "f".repeat(64);
const stableRelease = path.win32.join(installRoot, "releases", "6.0.4");
const mainRelease = path.win32.join(transactionRoot, "native-store", "win32-x64", A, "release");
const installation = Object.freeze({
  platform: "win32", kind: "managed-source", managed: true, selfUpdateSupported: true,
  target: "win32-x64", sourceSha: A, installRoot, programRoot, releaseDir: stableRelease,
  currentPointer: path.win32.join(installRoot, "current-version.json"),
  mainTransactionRoot: transactionRoot, sourceRoot: path.win32.join(transactionRoot, "sources", A),
  gitPath: equinoxLocalToolchainContract({ runtimeRoot: path.win32.join(installRoot, "runtime"), target: "win32-x64" }).gitPath,
  nativeMessagingManifestRoot: path.win32.join(installRoot, "browser", "native-messaging"),
});
const executable = path.win32.join(programRoot, "EquinoxLocal.exe");

function fixture({ active = null, entries = [], nativePointer = null, ...overrides } = {}) {
  const calls = [];
  const exactLauncher = path.win32.join(nativePointer?.releaseDir ?? stableRelease, "runtime", "browser", "equinox-browser-native-host.exe");
  const deps = {
    installation,
    localAppData: local,
    engineFactory: ({ sourceRoot, transactionRoot: root, gitPath }) => {
      calls.push(["engine", sourceRoot, root, gitPath]);
      return { readActive: async () => { calls.push(["active"]); return active; } };
    },
    fsImpl: {
      readdir: async () => { calls.push(["handoff"]); return entries.map((name) => ({ name, isFile: () => true })); },
    },
    readPointer: async (file, { gitPath }) => { calls.push(["source", file, gitPath]); return { sourceRoot: installation.sourceRoot, sha: A }; },
    readCurrentRelease: async () => { calls.push(["stable"]); return { version: "6.0.4", releaseDir: stableRelease }; },
    readNativePointer: async () => {
      calls.push(["native"]);
      if (!nativePointer) throw Object.assign(new Error("none"), { code: "ENOENT" });
      return nativePointer;
    },
    verifyShell: async (args) => { calls.push(["shell", args]); return { owned: true, shellExecutable: executable }; },
    windowsLauncherPath: (releaseDir) => path.win32.join(releaseDir, "runtime", "browser", "equinox-browser-native-host.exe"),
    verifyNativeHost: async (args) => { calls.push(["host", args]); return { launcherPath: exactLauncher }; },
    ...overrides,
  };
  return { deps, calls };
}

test("read-only guardian admission checks exact Stable source, WPF, and Native Messaging in order", async () => {
  const f = fixture();
  const result = await inspectEquinoxLocalWindowsGuardianAdmission(f.deps);
  assert.deepEqual(result, {
    state: "admitted", sourceSha: A, target: "win32-x64", native: "stable",
    shellExecutable: executable, releaseDir: stableRelease,
  });
  assert.deepEqual(f.calls.map(([action]) => action), ["engine", "active", "handoff", "source", "stable", "native", "shell", "host"]);
  assert.deepEqual(f.calls.at(-2)[1], { releaseDir: stableRelease, programRoot });
  assert.deepEqual(f.calls.at(-1)[1], {
    manifestRoot: installation.nativeMessagingManifestRoot,
    acceptedLauncherPaths: [path.win32.join(stableRelease, "runtime", "browser", "equinox-browser-native-host.exe")],
  });
});

test("exact admitted Main native release is independently checked against its SHA slot", async () => {
  const nativePointer = { sourceSha: A, target: "win32-x64", runtimeContractSha256: shaDigest, releaseDir: mainRelease };
  const f = fixture({ nativePointer });
  const result = await inspectEquinoxLocalWindowsGuardianAdmission(f.deps);
  assert.equal(result.native, "main");
  assert.equal(result.releaseDir, mainRelease);
  assert.equal(f.calls.find(([action]) => action === "shell")[1].releaseDir, mainRelease);
});

test("guardian refuses active rollback_failed or even terminal active receipts before touching live shell", async () => {
  for (const state of ["rollback_failed", "promoting", "rolled_back", "succeeded"]) {
    const f = fixture({ active: { status: state, transactionId: `main-${"c".repeat(32)}` } });
    const result = await inspectEquinoxLocalWindowsGuardianAdmission(f.deps);
    assert.equal(result.state, "blocked");
    assert.equal(result.reason, "owned-transaction-requires-reconciliation");
    assert.deepEqual(f.calls.map(([name]) => name), ["engine", "active"]);
  }
});

test("orphaned worker identity blocks admission, even with no active transaction lock", async () => {
  const f = fixture({ entries: [`main-${"a".repeat(32)}.windows-worker.json`] });
  assert.equal((await inspectEquinoxLocalWindowsGuardianAdmission(f.deps)).reason, "orphaned-detached-worker-ownership");
  assert.deepEqual(f.calls.map(([action]) => action), ["engine", "active", "handoff"]);
});

test("ambiguous worker-like entry fails closed and does not activate the shell", async () => {
  const f = fixture({ entries: ["evil.windows-worker.json"] });
  await assert.rejects(inspectEquinoxLocalWindowsGuardianAdmission(f.deps), /unrecognized detached worker/u);
  assert.equal(f.calls.some(([name]) => name === "shell"), false);
});

test("nonexistent handoff dir means no worker; permission errors do not", async () => {
  const f = fixture({ fsImpl: { readdir: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } } });
  assert.equal((await inspectEquinoxLocalWindowsGuardianAdmission(f.deps)).state, "admitted");
  const denied = fixture({ fsImpl: { readdir: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } } });
  await assert.rejects(inspectEquinoxLocalWindowsGuardianAdmission(denied.deps), /denied/u);
});

test("every identity and product-owned path is checked before inspecting runtime state", async () => {
  for (const changed of [
    { platform: "darwin" }, { kind: "managed" }, { managed: false },
    { target: "win32-ia32" }, { sourceSha: B },
    { installRoot: "C:\\Other" }, { programRoot: "C:\\Other\\Programs" },
    { mainTransactionRoot: "C:\\Other\\state\\main-update" },
    { sourceRoot: "C:\\Other\\sources\\" + A },
    { nativeMessagingManifestRoot: "C:\\Other\\browser" },
    { releaseDir: "C:\\Other\\6.0.4" },
    { currentPointer: "C:\\Other\\current-version.json" },
    { gitPath: "git.exe" },
  ]) {
    const f = fixture({ installation: { ...installation, ...changed } });
    await assert.rejects(inspectEquinoxLocalWindowsGuardianAdmission(f.deps));
    assert.equal(f.calls.length, 0);
  }
});

test("foreign source pointer and switched Stable baseline are denied", async () => {
  for (const opts of [
    { readPointer: async () => ({ sourceRoot: installation.sourceRoot, sha: B }) },
    { readPointer: async () => ({ sourceRoot: "C:\\Other", sha: A }) },
    { readCurrentRelease: async () => ({ releaseDir: "C:\\Other\\6.0.4" }) },
  ]) {
    const f = fixture(opts);
    await assert.rejects(inspectEquinoxLocalWindowsGuardianAdmission(f.deps));
    assert.equal(f.calls.some(([name]) => name === "shell"), false);
  }
});

test("stale Main SHA, wrong architecture and arbitrary native Main path are denied", async () => {
  for (const changed of [
    { sourceSha: B },
    { target: "win32-arm64" },
    { runtimeContractSha256: "invalid" },
    { releaseDir: "C:\\Other\\release" },
  ]) {
    const pointer = { sourceSha: A, target: "win32-x64", runtimeContractSha256: shaDigest, releaseDir: mainRelease, ...changed };
    const f = fixture({ nativePointer: pointer });
    await assert.rejects(inspectEquinoxLocalWindowsGuardianAdmission(f.deps));
    assert.equal(f.calls.some(([name]) => name === "shell"), false);
  }
});

test("foreign WPF executable or Native Messaging host refuses to admit even a signed Stable release", async () => {
  for (const opts of [
    { verifyShell: async () => ({ owned: false, shellExecutable: executable }) },
    { verifyShell: async () => ({ owned: true, shellExecutable: "C:\\Other\\EquinoxLocal.exe" }) },
    { verifyNativeHost: async () => ({ launcherPath: "C:\\Other\\host.exe" }) },
  ]) {
    await assert.rejects(inspectEquinoxLocalWindowsGuardianAdmission(fixture(opts).deps));
  }
});

test("ownership exceptions and unreadable Main native pointer never silently downgrade to Stable", async () => {
  const f = fixture({ readNativePointer: async () => { throw Object.assign(new Error("foreign native pointer"), { code: "EACCES" }); } });
  await assert.rejects(inspectEquinoxLocalWindowsGuardianAdmission(f.deps), /foreign native pointer/u);
  assert.equal(f.calls.some(([name]) => name === "shell"), false);
});


test("guardian refuses an otherwise valid foreign-user LOCALAPPDATA root", async () => {
  const f = fixture({ localAppData: "C:\\Users\\Other\\AppData\\Local" });
  await assert.rejects(inspectEquinoxLocalWindowsGuardianAdmission(f.deps), /foreign installed/u);
  assert.deepEqual(f.calls, []);
});
