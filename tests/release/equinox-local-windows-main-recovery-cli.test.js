import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { runWindowsMainFailedRollbackRecovery } from "../../scripts/diagnostics/recover-windows-main-update.mjs";
import { equinoxLocalPlatformPaths } from "../../src/equinox-local-platform.js";

const homeDir = "C:\\Users\\Tester";
const env = { LOCALAPPDATA: "C:\\Users\\Tester\\AppData\\Local", APPDATA: "C:\\Users\\Tester\\AppData\\Roaming" };
const sha = "a".repeat(40);
const layout = equinoxLocalPlatformPaths({ platform: "win32", arch: "arm64", homeDir, env });
const releaseDir = path.win32.join(layout.releasesRoot, "6.0.4");

function fixture(overrides = {}) {
  const calls = [];
  const opts = {
    platform: "win32", arch: "arm64", homeDir, env,
    args: [],
    readRelease: async (base) => {
      calls.push(["read-release", base]);
      return { releaseDir, version: "6.0.4" };
    },
    resolveInstallation: async ({ baseInstallation, platform, arch, homeDir }) => {
      calls.push(["resolve", baseInstallation, platform, arch, homeDir]);
      return { ...baseInstallation, kind: "managed-source", channel: "main", sourceRoot: path.win32.join(layout.stateRoot, "main-update", "sources", sha), sourceSha: sha, mainTransactionRoot: path.win32.join(layout.stateRoot, "main-update"), gitPath: path.win32.join(layout.runtimeRoot, "toolchain", "git.exe") };
    },
    recover: async ({ installation, apply }) => {
      calls.push(["recover", installation, apply]);
      return { status: apply ? "recovered" : "verified_dry_run" };
    },
    ...overrides,
  };
  return { opts, calls };
}

test("Windows operator recovery is dry-run by default and resolves only owned managed release layout", async () => {
  const f = fixture();
  const result = await runWindowsMainFailedRollbackRecovery(f.opts);
  assert.equal(result.status, "verified_dry_run");
  assert.deepEqual(f.calls.map(([action]) => action), ["read-release", "resolve", "recover"]);
  assert.deepEqual(f.calls[0][1], {
    kind: "managed", managed: true, selfUpdateSupported: true,
    platform: "win32", arch: "arm64", target: "win32-arm64",
    installRoot: layout.appDataRoot, releasesRoot: layout.releasesRoot,
    currentPointer: layout.currentPointer, programRoot: layout.programRoot,
    nativeMessagingManifestRoot: layout.nativeMessagingManifestRoot,
  });
  assert.equal(f.calls[2][2], false);
  assert.equal(f.calls[2][1].releaseDir, releaseDir);
});

test("the one exact --apply flag authorizes forwarding a mutation request but no other arguments do", async () => {
  const f = fixture({ args: ["--apply"] });
  assert.equal((await runWindowsMainFailedRollbackRecovery(f.opts)).status, "recovered");
  assert.equal(f.calls[2][2], true);
  for (const args of [["--apply", "--apply"], ["--force"], ["--apply=true"], ["--apply", "--force"], ["--dry-run"]]) {
    const invalid = fixture({ args });
    await assert.rejects(runWindowsMainFailedRollbackRecovery(invalid.opts), /optional --apply/u);
    assert.deepEqual(invalid.calls, []);
  }
});

test("wrong OS, unsupported architecture or noncanonical Windows home fail before reading installation state", async () => {
  for (const overrides of [{ platform: "darwin" }, { arch: "ia32" }, { homeDir: "C:\\Users\\..\\Tester" }, { homeDir: "/home/user" }]) {
    const f = fixture(overrides);
    await assert.rejects(runWindowsMainFailedRollbackRecovery(f.opts), /Windows|Unsupported/u);
    assert.deepEqual(f.calls, []);
  }
});

test("wrong, substituted or foreign managed release identity aborts before recovery", async () => {
  for (const released of ["C:\\Other\\6.0.4", path.win32.join(layout.releasesRoot, "..", "6.0.4")]) {
    const f = fixture({ readRelease: async () => ({ releaseDir: released }) });
    // The second path is absolute inside the app root but not in releasesRoot.
    await assert.rejects(runWindowsMainFailedRollbackRecovery(f.opts), /owned releases directory/u);
    assert.equal(f.calls.some(([kind]) => kind === "recover"), false);
  }
});

test("non-managed-source or incomplete provenance refuses the dangerous apply even if a release exists", async () => {
  const cases = [
    { kind: "managed" },
    { managed: false },
    { selfUpdateSupported: false },
    { sourceSha: "b".repeat(40) },
    { mainTransactionRoot: "C:\\Other\\State" },
    { sourceRoot: undefined },
    { gitPath: undefined },
    { releaseDir: "C:\\Foreign\\6.0.4" },
  ];
  for (const change of cases) {
    const f = fixture({ args: ["--apply"], resolveInstallation: async ({ baseInstallation }) => ({ ...baseInstallation, kind: "managed-source", sourceRoot: path.win32.join(layout.stateRoot, "main-update", "sources", sha), sourceSha: sha, mainTransactionRoot: path.win32.join(layout.stateRoot, "main-update"), gitPath: "C:\\Toolchain\\git.exe", ...change }) });
    await assert.rejects(runWindowsMainFailedRollbackRecovery(f.opts), /refuses non-managed-source/u);
    assert.equal(f.calls.some(([kind]) => kind === "recover"), false);
  }
});

test("a Windows x64 host resolves a different exact target without using ambient tools", async () => {
  const actual = equinoxLocalPlatformPaths({ platform: "win32", arch: "x64", homeDir, env });
  const f = fixture({
    arch: "x64", readRelease: async (base) => ({ releaseDir: path.win32.join(base.releasesRoot, "6.0.4") }),
    resolveInstallation: async ({ baseInstallation }) => ({ ...baseInstallation, kind: "managed-source", sourceRoot: path.win32.join(layout.stateRoot, "main-update", "sources", sha), sourceSha: sha, mainTransactionRoot: path.win32.join(layout.stateRoot, "main-update"), gitPath: "C:\\ProductOwned\\git.exe" }),
  });
  assert.equal((await runWindowsMainFailedRollbackRecovery(f.opts)).status, "verified_dry_run");
  assert.equal(f.calls.at(-1)[1].target, actual.host.target);
});

test("Windows recovery refuses missing or substituted native shell and messaging ownership before apply", async () => {
  for (const changed of [
    { programRoot: undefined },
    { programRoot: "C:\\Foreign\\Programs" },
    { nativeMessagingManifestRoot: undefined },
    { nativeMessagingManifestRoot: "C:\\Foreign\\NativeMessagingHosts" },
  ]) {
    const f = fixture({
      args: ["--apply"],
      resolveInstallation: async ({ baseInstallation }) => ({
        ...baseInstallation,
        kind: "managed-source", channel: "main",
        sourceRoot: path.win32.join(layout.stateRoot, "main-update", "sources", sha),
        sourceSha: sha,
        mainTransactionRoot: path.win32.join(layout.stateRoot, "main-update"),
        gitPath: "C:\\ProductOwned\\git.exe",
        ...changed,
      }),
    });
    await assert.rejects(runWindowsMainFailedRollbackRecovery(f.opts), /refuses non-managed-source/u);
    assert.equal(f.calls.some(([kind]) => kind === "recover"), false);
  }
});
