import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getEquinoxLocalDoctorStatus,
  registerSystemDoctorTool,
} from "../../src/equinox-local-doctor.js";

async function createManagedFixture() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-"));
  const installRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local");
  const releasesRoot = path.join(installRoot, "releases");
  const releaseDir = path.join(releasesRoot, "4.2.0");
  const launchAgentPath = path.join(homeDir, "Library", "LaunchAgents", "dev.equinox.local.plist");
  const workspace = path.join(installRoot, "workspace");
  const nativeHostRoot = path.join(homeDir, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");

  await fs.mkdir(releaseDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(launchAgentPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await fs.mkdir(nativeHostRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(launchAgentPath, "plist", { mode: 0o600 });
  await fs.writeFile(path.join(installRoot, "config.json"), "{}\n", { mode: 0o600 });
  await fs.writeFile(path.join(installRoot, "equinox-browser-native-host"), "#!/bin/bash\n", { mode: 0o700 });
  await fs.writeFile(path.join(nativeHostRoot, "dev.equinox.browser.json"), "{}\n", { mode: 0o600 });

  const installation = Object.freeze({
    kind: "managed",
    managed: true,
    selfUpdateSupported: true,
    installRoot,
    releasesRoot,
    releaseDir,
    currentLink: path.join(installRoot, "current"),
    stagingRoot: path.join(installRoot, "staging"),
    launchAgentPath,
    launchAgentLabel: "dev.equinox.local",
  });
  const config = Object.freeze({
    version: 1,
    runtime: Object.freeze({ workspaceProject: "workspace" }),
    projects: Object.freeze({
      workspace: Object.freeze({ root: workspace }),
    }),
  });
  return { homeDir, installation, config, releaseDir };
}

test("source checkout doctor stays healthy without requiring managed-only files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-source-"));
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { mode: 0o700 });
    const result = await getEquinoxLocalDoctorStatus({
      installation: { kind: "source", managed: false, selfUpdateSupported: false },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root: workspace } } },
      runtimeHealthState: "HEALTHY",
      runtimeVersion: "4.2.0",
      sourceCheckoutVersion: "4.2.0",
      developmentTunnel: { configured: true, expectedVersion: "0.0.16", actualVersion: "0.0.16", synchronized: true },
      developmentPeekaboo: { configured: true, expectedVersion: "4.3.0", actualVersion: "4.3.0", synchronized: true },
      browser: { ready: false },
      peekaboo: { active: false },
      now: () => new Date("2026-08-25T00:00:00.000Z"),
    });

    assert.equal(result.state, "HEALTHY");
    assert.equal(result.installationKind, "source");
    assert.equal(result.host.target, process.arch === "x64" ? "darwin-x64" : "darwin-arm64");
    assert.equal(result.host.platform, "darwin");
    assert.equal(result.summary.attention, 0);
    assert.equal(result.checks.find((item) => item.id === "installation")?.status, "pass");
    assert.equal(result.checks.find((item) => item.id === "source-version")?.status, "pass");
    assert.equal(result.checks.find((item) => item.id === "development-tunnel")?.status, "pass");
    assert.equal(result.checks.find((item) => item.id === "development-peekaboo")?.status, "pass");
    assert.equal(result.checks.find((item) => item.id === "browser")?.status, "optional");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Windows Doctor marks failed terminal output or exit status as attention only when explicitly probed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-terminal-"));
  try {
    const args = {
      installation: { kind: "source", managed: false, selfUpdateSupported: false },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root } } },
      runtimeHealthState: "HEALTHY", runtimeVersion: "6.1.0", browser: {},
      host: { platform: "win32", arch: "x64", target: "win32-x64", displayName: "Windows" },
    };
    const routine = await getEquinoxLocalDoctorStatus(args);
    assert.equal(routine.checks.find((item) => item.id === "desktop")?.status, "attention");
    assert.equal(routine.state, "ATTENTION");
    const winappReady = await getEquinoxLocalDoctorStatus({ ...args, desktop: { engine: "winapp", active: true, compatibility: { ok: true }, version: "0.7.1" } });
    assert.equal(winappReady.checks.find((item) => item.id === "desktop")?.status, "pass");
    assert.equal(routine.checks.some((item) => item.id === "windows-terminal-execution"), false);
    const failed = await getEquinoxLocalDoctorStatus({ ...args, terminalExecution: { healthy: false } });
    assert.equal(failed.state, "ATTENTION");
    assert.equal(failed.checks.find((item) => item.id === "windows-terminal-execution")?.status, "attention");
    const healthy = await getEquinoxLocalDoctorStatus({ ...args, terminalExecution: { healthy: true } });
    assert.equal(healthy.checks.find((item) => item.id === "windows-terminal-execution")?.status, "pass");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doctor data model accepts an explicit supported Windows host descriptor without claiming runtime parity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-windows-model-"));
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { mode: 0o700 });
    const result = await getEquinoxLocalDoctorStatus({
      installation: { kind: "source", managed: false, selfUpdateSupported: false },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root: workspace } } },
      runtimeHealthState: "HEALTHY",
      runtimeVersion: "5.2.1",
      browser: { ready: false },
      peekaboo: {},
      desktop: { engine: "winapp", active: true, compatibility: { ok: true }, version: "0.7.1" },
      host: { platform: "win32", arch: "x64", target: "win32-x64", displayName: "Windows", supported: true },
      now: () => new Date("2026-09-27T00:00:00.000Z"),
    });
    assert.deepEqual(result.host, { platform: "win32", arch: "x64", target: "win32-x64", displayName: "Windows", supported: true });
    assert.equal(result.state, "HEALTHY");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doctor treats a disconnected personal Chrome as optional without masking actual Agent Browser failures", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-browser-contexts-"));
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { mode: 0o700 });
    const result = await getEquinoxLocalDoctorStatus({
      installation: { kind: "source", managed: false, selfUpdateSupported: false },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root: workspace } } },
      runtimeHealthState: "HEALTHY",
      runtimeVersion: "5.2.1",
      browser: {
        contexts: {
          agent: { ready: true, consentAccepted: true, controlEnabled: true },
          user: { ready: false, consentAccepted: null, controlEnabled: null },
        },
        agentBrowser: { supported: true, setupComplete: true, pairing: false },
      },
      peekaboo: {},
      host: { platform: "win32", arch: "x64", target: "win32-x64", displayName: "Windows", supported: true },
    });
    assert.equal(result.checks.find((item) => item.id === "browser")?.status, "optional");
    assert.match(result.checks.find((item) => item.id === "browser")?.detail || "", /normal when personal Chrome is closed/u);
    assert.match(result.checks.find((item) => item.id === "browser")?.label || "", /Your Browser/u);
    assert.equal(result.checks.find((item) => item.id === "agent-browser")?.status, "pass");
    assert.match(result.checks.find((item) => item.id === "agent-browser")?.detail || "", /isolated default/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doctor treats a configured but closed Agent Browser as healthy instead of substituting Your Browser", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-agent-closed-"));
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { mode: 0o700 });
    const result = await getEquinoxLocalDoctorStatus({
      installation: { kind: "source", managed: false, selfUpdateSupported: false },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root: workspace } } },
      runtimeHealthState: "HEALTHY",
      runtimeVersion: "5.2.1",
      browser: {
        contexts: { agent: { ready: false }, user: { ready: true, consentAccepted: true, controlEnabled: true } },
        agentBrowser: { supported: true, setupComplete: true, pairing: false },
      },
      peekaboo: {},
      host: { platform: "win32", arch: "x64", target: "win32-x64", displayName: "Windows", supported: true },
    });
    assert.equal(result.checks.find((item) => item.id === "browser")?.status, "pass");
    assert.equal(result.checks.find((item) => item.id === "agent-browser")?.status, "pass");
    assert.match(result.checks.find((item) => item.id === "agent-browser")?.detail || "", /currently closed/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("source checkout doctor detects a stale running process after source version changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-source-version-drift-"));
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { mode: 0o700 });
    const result = await getEquinoxLocalDoctorStatus({
      installation: { kind: "source", managed: false, selfUpdateSupported: false },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root: workspace } } },
      runtimeHealthState: "HEALTHY",
      runtimeVersion: "4.2.2",
      sourceCheckoutVersion: "4.2.3",
      developmentTunnel: { configured: true, expectedVersion: "0.0.16", actualVersion: "0.0.16", synchronized: true },
      browser: { ready: false },
      peekaboo: { active: false },
    });
    const sourceVersion = result.checks.find((item) => item.id === "source-version");
    assert.equal(result.state, "ATTENTION");
    assert.equal(sourceVersion?.status, "attention");
    assert.match(sourceVersion?.detail || "", /4\.2\.3.*4\.2\.2/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("source checkout doctor surfaces a stale developer tunnel runtime without exposing its path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-source-drift-"));
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { mode: 0o700 });
    const result = await getEquinoxLocalDoctorStatus({
      installation: { kind: "source", managed: false, selfUpdateSupported: false },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root: workspace } } },
      runtimeHealthState: "HEALTHY",
      runtimeVersion: "4.3.0",
      developmentTunnel: { configured: true, expectedVersion: "0.0.16", actualVersion: "0.0.12", synchronized: false },
      browser: { ready: false },
      peekaboo: { active: false },
    });
    const tunnel = result.checks.find((item) => item.id === "development-tunnel");
    assert.equal(result.state, "ATTENTION");
    assert.equal(tunnel?.status, "attention");
    assert.match(tunnel?.detail || "", /0\.0\.12.*0\.0\.16/u);
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("source checkout doctor surfaces a stale developer Peekaboo runtime without exposing its path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-source-peekaboo-drift-"));
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { mode: 0o700 });
    const result = await getEquinoxLocalDoctorStatus({
      installation: { kind: "source", managed: false, selfUpdateSupported: false },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root: workspace } } },
      runtimeHealthState: "HEALTHY",
      runtimeVersion: "4.3.1",
      developmentTunnel: { configured: true, expectedVersion: "0.0.16", actualVersion: "0.0.16", synchronized: true },
      developmentPeekaboo: { configured: true, expectedVersion: "4.3.0", actualVersion: "4.1.0", synchronized: false },
      browser: { ready: false },
      peekaboo: { active: false },
    });
    const peekaboo = result.checks.find((item) => item.id === "development-peekaboo");
    assert.equal(result.state, "ATTENTION");
    assert.equal(peekaboo?.status, "attention");
    assert.match(peekaboo?.detail || "", /4\.1\.0.*4\.3\.0/u);
    assert.equal(JSON.stringify(result).includes(root), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("managed Windows Doctor validates the accepted per-user lifecycle without LaunchAgent checks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-windows-managed-"));
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { mode: 0o700 });
    const releaseDir = "C:\\Users\\Example\\AppData\\Local\\Equinox Local\\releases\\5.2.1";
    const programRoot = "C:\\Users\\Example\\AppData\\Local\\Programs\\Equinox Local";
    const nativeMessagingManifestRoot = "C:\\Users\\Example\\AppData\\Local\\Equinox Local\\browser\\native-messaging";
    const calls = [];
    const result = await getEquinoxLocalDoctorStatus({
      installation: {
        kind: "managed",
        managed: true,
        selfUpdateSupported: true,
        lifecycleKind: "windows-user",
        installRoot: "C:\\Users\\Example\\AppData\\Local\\Equinox Local",
        releaseDir,
        programRoot,
        nativeMessagingManifestRoot,
      },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root: workspace } } },
      runtimeHealthState: "HEALTHY",
      runtimeVersion: "5.2.1",
      browser: { ready: true, consentAccepted: true, controlEnabled: true },
      peekaboo: {},
      desktop: { engine: "winapp", active: true, version: "0.7.1", compatibility: { ok: true } },
      update: { selfUpdateSupported: true, configured: true },
      onboarding: { connectedThroughTunnel: true },
      host: { platform: "win32", arch: "x64", target: "win32-x64", displayName: "Windows", supported: true },
      homeDir: "C:\\Users\\Example",
      runtimeEnv: { SystemRoot: "C:\\Windows", OPENAI_API_KEY: "must-not-leak" },
      readCurrentReleaseImpl: async () => ({ version: "5.2.1", releaseDir }),
      assertWindowsStableShellImpl: async (options) => {
        calls.push(["shell", options]);
        return { owned: true };
      },
      readWindowsStartupImpl: async (options) => {
        calls.push(["startup", options]);
        return { enabled: false, expectedCommand: options.expectedCommand };
      },
      assertWindowsNativeHostImpl: async (options) => {
        calls.push(["native-host", options]);
        return { manifestPath: path.win32.join(nativeMessagingManifestRoot, "dev.equinox.browser.json") };
      },
      now: () => new Date("2026-09-30T00:00:00.000Z"),
    });

    assert.equal(result.state, "HEALTHY");
    assert.equal(result.summary.attention, 0);
    assert.equal(result.checks.some((item) => item.id === "launch-agent"), false);
    assert.equal(result.checks.find((item) => item.id === "windows-shell")?.status, "pass");
    assert.equal(result.checks.find((item) => item.id === "desktop")?.status, "pass");
    assert.match(result.checks.find((item) => item.id === "desktop")?.detail || "", /winapp 0\.7\.1/u);
    assert.equal(result.checks.some((item) => item.id === "peekaboo"), false);
    assert.equal(result.checks.find((item) => item.id === "windows-startup")?.status, "pass");
    assert.match(result.checks.find((item) => item.id === "windows-startup")?.detail || "", /disabled/u);
    assert.equal(result.checks.find((item) => item.id === "native-host")?.status, "pass");
    assert.equal(calls[0][0], "shell");
    assert.deepEqual(calls[0][1], { releaseDir, programRoot, fsImpl: fs });
    assert.equal(calls[1][0], "startup");
    assert.equal(calls[1][1].expectedCommand, `"${path.win32.join(programRoot, "EquinoxLocal.exe")}" --startup`);
    assert.deepEqual(calls[1][1].env, {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      PATH: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Windows\\System32;C:\\Windows",
    });
    assert.equal(Object.hasOwn(calls[1][1].env, "OPENAI_API_KEY"), false);
    assert.equal(calls[2][0], "native-host");
    assert.deepEqual(calls[2][1].acceptedLauncherPaths, [path.win32.join(releaseDir, "runtime", "browser", "equinox-browser-native-host.exe")]);
    assert.deepEqual(calls[2][1].env, calls[1][1].env);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Windows Doctor verifies active Main native store rather than stale Stable A (and refuses corrupt pointers)", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-main-native-"));
  try {
    const installRoot = "C:\\Users\\Example\\AppData\\Local\\Equinox Local";
    const legacyRelease = path.win32.join(installRoot, "releases", "6.1.0");
    const activeRelease = path.win32.join(installRoot, "state", "main-update", "native-store", "win32-x64", "a".repeat(40), "release");
    const transactionRoot = path.win32.join(installRoot, "state", "main-update");
    const pointerPath = path.win32.join(transactionRoot, "current-native.json");
    const programRoot = "C:\\Users\\Example\\AppData\\Local\\Programs\\Equinox Local";
    const manifestRoot = path.win32.join(installRoot, "browser", "native-messaging");
    const seen = [];
    const fixtureFs = { ...fs, lstat: (p) => p === pointerPath ? Promise.resolve({ isFile: () => true }) : fs.lstat(p) };
    const options = {
      installation: { managed: true, selfUpdateSupported: true, lifecycleKind: "windows-user", installRoot,
        releaseDir: legacyRelease, programRoot, nativeMessagingManifestRoot: manifestRoot },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root: temp } } },
      runtimeHealthState: "HEALTHY", runtimeVersion: "6.1.1",
      browser: { contexts: { user: { ready: false }, agent: { ready: true, consentAccepted: true, controlEnabled: true } }, agentBrowser: { setupComplete: true } },
      update: { selfUpdateSupported: true, configured: true }, onboarding: { connectedThroughTunnel: true },
      host: { platform: "win32", arch: "x64", target: "win32-x64", displayName: "Windows" },
      runtimeEnv: { SystemRoot: "C:\\Windows" },
      fsImpl: fixtureFs,
      readCurrentReleaseImpl: async () => ({ version: "6.1.0", releaseDir: legacyRelease }),
      readMainNativePointerImpl: async (file, args) => {
        assert.equal(file, pointerPath);
        assert.equal(args.transactionRoot, transactionRoot);
        return { target: "win32-x64", releaseDir: activeRelease };
      },
      assertWindowsStableShellImpl: async ({ releaseDir }) => { seen.push(releaseDir); assert.equal(releaseDir, activeRelease); },
      assertWindowsNativeHostImpl: async ({ acceptedLauncherPaths }) => {
        assert.deepEqual(acceptedLauncherPaths, [path.win32.join(activeRelease, "runtime", "browser", "equinox-browser-native-host.exe")]);
      },
      readWindowsStartupImpl: async () => ({ enabled: false }),
    };
    const good = await getEquinoxLocalDoctorStatus(options);
    assert.equal(seen.length, 1);
    assert.equal(good.checks.find((item) => item.id === "windows-shell")?.status, "pass");
    assert.equal(good.checks.find((item) => item.id === "native-host")?.status, "pass");
    assert.equal(good.checks.find((item) => item.id === "browser")?.status, "optional");
    const corrupt = await getEquinoxLocalDoctorStatus({ ...options,
      readMainNativePointerImpl: async () => { throw new Error("Main native fingerprint is corrupt"); },
    });
    assert.equal(corrupt.checks.find((item) => item.id === "windows-shell")?.status, "attention");
    assert.equal(corrupt.checks.find((item) => item.id === "native-host")?.status, "attention");
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("managed Main Doctor authenticates current source and native store even after Stable A was reclaimed", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-main-release-"));
  try {
    const installRoot = "C:\\Users\\Example\\AppData\\Local\\Equinox Local";
    const transactionRoot = path.win32.join(installRoot, "state", "main-update");
    const legacyDir = path.win32.join(installRoot, "releases", "6.1.0");
    const sha = "b".repeat(40);
    const sourceRoot = path.win32.join(transactionRoot, "sources", sha);
    const nativeRelease = path.win32.join(transactionRoot, "native-store", "win32-x64", sha, "release");
    const shellRoot = "C:\\Users\\Example\\AppData\\Local\\Programs\\Equinox Local";
    const pointer = path.win32.join(transactionRoot, "current-native.json");
    let nativeReads = 0;
    const options = {
      installation: {
        kind: "managed-source", managed: true, selfUpdateSupported: true,
        lifecycleKind: "windows-user", installRoot, releaseDir: nativeRelease,
        releasesRoot: path.win32.join(installRoot, "releases"),
        programRoot: shellRoot, nativeMessagingManifestRoot: path.win32.join(installRoot, "browser", "native-messaging"),
        sourceRoot, sourceSha: sha, mainNativeSha: sha, mainTransactionRoot: transactionRoot,
        gitPath: path.win32.join(installRoot, "runtime", "git.exe"),
      },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root: temp } } },
      runtimeHealthState: "HEALTHY", runtimeVersion: "6.1.2",
      host: { platform: "win32", arch: "x64", target: "win32-x64", displayName: "Windows" },
      browser: { contexts: { user: { ready: false }, agent: { ready: true, consentAccepted: true, controlEnabled: true } }, agentBrowser: { setupComplete: true } },
      update: { selfUpdateSupported: true, configured: true }, onboarding: { connectedThroughTunnel: true },
      runtimeEnv: { SystemRoot: "C:\\Windows" },
      fsImpl: { ...fs, lstat: async (candidate) => candidate === pointer ? { isFile: () => true } : fs.lstat(candidate) },
      readCurrentReleaseImpl: async () => { throw new Error("Stable 6.1.0 was already reclaimed"); },
      readMainSourcePointerImpl: async (file, options) => {
        assert.equal(file, path.win32.join(transactionRoot, "current-source.conf"));
        assert.equal(options.gitPath, path.win32.join(installRoot, "runtime", "git.exe"));
        return { sha, sourceRoot };
      },
      readMainNativePointerImpl: async (file, opts) => {
        nativeReads++;
        assert.equal(file, pointer);
        assert.equal(opts.transactionRoot, transactionRoot);
        return { sourceSha: sha, target: "win32-x64", releaseDir: nativeRelease, payloadVersion: "6.1.2" };
      },
      assertWindowsStableShellImpl: async ({ releaseDir }) => assert.equal(releaseDir, nativeRelease),
      assertWindowsNativeHostImpl: async ({ acceptedLauncherPaths }) =>
        assert.deepEqual(acceptedLauncherPaths, [path.win32.join(nativeRelease, "runtime", "browser", "equinox-browser-native-host.exe")]),
      readWindowsStartupImpl: async () => ({ enabled: false }),
    };
    const good = await getEquinoxLocalDoctorStatus(options);
    assert.equal(good.checks.find((item) => item.id === "release")?.status, "pass");
    assert.match(good.checks.find((item) => item.id === "release")?.detail ?? "", /Main b{12} and native 6\.1\.2/u);
    assert.equal(good.checks.find((item) => item.id === "windows-shell")?.status, "pass");
    assert.equal(good.checks.find((item) => item.id === "native-host")?.status, "pass");
    assert.equal(nativeReads, 1, "The expensive native fingerprint must be reused for Doctor ownership.");
    const badSource = await getEquinoxLocalDoctorStatus({ ...options,
      readMainSourcePointerImpl: async () => ({ sha: "a".repeat(40), sourceRoot }),
    });
    assert.equal(badSource.checks.find((item) => item.id === "release")?.status, "attention");
    const badNative = await getEquinoxLocalDoctorStatus({ ...options,
      readMainNativePointerImpl: async () => { throw new Error("fingerprint mismatch"); },
    });
    assert.equal(badNative.checks.find((item) => item.id === "release")?.status, "attention");
    assert.equal(badNative.checks.find((item) => item.id === "windows-shell")?.status, "attention");
    assert.equal(badNative.checks.find((item) => item.id === "native-host")?.status, "attention");
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("managed Windows Doctor fails closed on foreign lifecycle ownership without exposing local paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-windows-foreign-"));
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { mode: 0o700 });
    const releaseDir = "C:\\Users\\Secret Person\\AppData\\Local\\Equinox Local\\releases\\5.2.1";
    const result = await getEquinoxLocalDoctorStatus({
      installation: {
        kind: "managed",
        managed: true,
        selfUpdateSupported: true,
        lifecycleKind: "windows-user",
        installRoot: "C:\\Users\\Secret Person\\AppData\\Local\\Equinox Local",
        releaseDir,
        programRoot: "C:\\Users\\Secret Person\\AppData\\Local\\Programs\\Equinox Local",
        nativeMessagingManifestRoot: "C:\\Users\\Secret Person\\AppData\\Local\\Equinox Local\\browser\\native-messaging",
      },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root: workspace } } },
      runtimeHealthState: "HEALTHY",
      runtimeVersion: "5.2.1",
      browser: { ready: true, consentAccepted: true, controlEnabled: true },
      peekaboo: {},
      update: { selfUpdateSupported: true, configured: true },
      onboarding: { connectedThroughTunnel: true },
      host: { platform: "win32", arch: "x64", target: "win32-x64", displayName: "Windows", supported: true },
      runtimeEnv: { SystemRoot: "C:\\Windows", OPENAI_API_KEY: "must-not-leak" },
      readCurrentReleaseImpl: async () => ({ version: "5.2.1", releaseDir }),
      assertWindowsStableShellImpl: async () => { throw new Error(`foreign shell at ${releaseDir}`); },
      readWindowsStartupImpl: async () => { throw new Error("foreign startup owner"); },
      assertWindowsNativeHostImpl: async () => { throw new Error("foreign native host owner"); },
    });

    assert.equal(result.state, "ATTENTION");
    assert.equal(result.checks.find((item) => item.id === "windows-shell")?.status, "attention");
    assert.equal(result.checks.find((item) => item.id === "windows-startup")?.status, "attention");
    assert.equal(result.checks.find((item) => item.id === "native-host")?.status, "attention");
    assert.equal(JSON.stringify(result).includes("Secret Person"), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("managed doctor reports a healthy product install when required files, updater and tunnel are ready", async () => {
  const fixture = await createManagedFixture();
  try {
    const result = await getEquinoxLocalDoctorStatus({
      installation: fixture.installation,
      config: fixture.config,
      runtimeHealthState: "HEALTHY",
      runtimeVersion: "4.2.0",
      browser: { ready: true, consentAccepted: true, controlEnabled: true },
      peekaboo: { active: true },
      update: { selfUpdateSupported: true, configured: true },
      onboarding: { connectedThroughTunnel: true, transportConfigured: true, needsAttention: false },
      homeDir: fixture.homeDir,
      readCurrentReleaseImpl: async () => ({ version: "4.2.0", releaseDir: fixture.releaseDir }),
      now: () => new Date("2026-08-25T00:00:00.000Z"),
    });

    assert.equal(result.state, "HEALTHY");
    assert.equal(result.managed, true);
    assert.equal(result.summary.attention, 0);
    assert.equal(result.checks.find((item) => item.id === "native-host")?.status, "pass");
    assert.equal(result.checks.find((item) => item.id === "updates")?.status, "pass");
    assert.equal(result.checks.find((item) => item.id === "chatgpt-connection")?.status, "pass");
    assert.equal(JSON.stringify(result).includes(fixture.homeDir), false);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("managed doctor fails closed when stable updates or first-run tunnel setup are incomplete", async () => {
  const fixture = await createManagedFixture();
  try {
    const result = await getEquinoxLocalDoctorStatus({
      installation: fixture.installation,
      config: fixture.config,
      runtimeHealthState: "HEALTHY",
      runtimeVersion: "4.2.0",
      browser: { ready: false },
      peekaboo: { active: false },
      update: { selfUpdateSupported: true, configured: false },
      onboarding: { connectedThroughTunnel: false, transportConfigured: false, needsAttention: false },
      homeDir: fixture.homeDir,
      readCurrentReleaseImpl: async () => ({ version: "4.2.0", releaseDir: fixture.releaseDir }),
    });

    assert.equal(result.state, "ATTENTION");
    assert.equal(result.checks.find((item) => item.id === "updates")?.status, "attention");
    assert.equal(result.checks.find((item) => item.id === "chatgpt-connection")?.status, "attention");
    assert.equal(result.checks.find((item) => item.id === "browser")?.status, "optional");
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("system_doctor registration preserves formatting and project-independent routing", async () => {
  const registrations = new Map();
  registerSystemDoctorTool({
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    getDoctorStatus: async () => ({
      state: "ATTENTION",
      summary: { pass: 2, attention: 1, optional: 1 },
      checks: [
        { status: "pass", label: "Runtime", detail: "healthy" },
        { status: "attention", label: "Update", detail: "needs attention" },
        { status: "optional", label: "Browser", detail: "not connected" },
      ],
    }),
    textResult: (text) => ({ text }),
    errorResult: (error) => ({ error: error instanceof Error ? error.message : String(error) }),
  });

  const registration = registrations.get("system_doctor");
  assert.ok(registration);
  assert.equal(registration.options.projectAware, false);
  assert.equal(registration.config.annotations.readOnlyHint, true);

  const result = await registration.handler({});
  assert.match(result.text, /Equinox Local system doctor: ATTENTION/u);
  assert.match(result.text, /Checks: 2 passed, 1 need attention, 1 optional\./u);
  assert.match(result.text, /OK \| Runtime \| healthy/u);
  assert.match(result.text, /ATTENTION \| Update \| needs attention/u);
  assert.match(result.text, /OPTIONAL \| Browser \| not connected/u);
});

test("Doctor reports symlinked managed config and Native Messaging file as attention without revealing paths",async()=>{
  const fixture=await createManagedFixture();
  try{
    const configFile=path.join(fixture.installation.installRoot,"config.json");
    const outside=path.join(fixture.homeDir,"private-sentinel");
    await fs.writeFile(outside,"synthetic-private-content\n");
    await fs.rm(configFile);
    await fs.symlink(outside,configFile);
    const result=await getEquinoxLocalDoctorStatus({
      installation:fixture.installation,config:fixture.config,
      runtimeHealthState:"HEALTHY",runtimeVersion:"6.1.2",
      browser:{ready:false},peekaboo:{ready:false},
      update:{selfUpdateSupported:true,configured:true},
      onboarding:{connectedThroughTunnel:true},
      homeDir:fixture.homeDir,
      readCurrentReleaseImpl:async()=>({version:"4.2.0",releaseDir:fixture.releaseDir}),
    });
    assert.equal(result.state,"ATTENTION");
    assert.equal(result.checks.find(item=>item.id==="config-file")?.status,"attention");
    assert.equal(JSON.stringify(result).includes(outside),false);
    assert.equal(JSON.stringify(result).includes("synthetic-private-content"),false);
    assert.equal(await fs.readFile(outside,"utf8"),"synthetic-private-content\n");
  }finally{await fs.rm(fixture.homeDir,{recursive:true,force:true})}
});

test("Doctor requires consent and Browser Control for connected managed Your Browser independently from isolated Agent Browser",async()=>{
  const fixture=await createManagedFixture();
  try{
    const base={
      installation:fixture.installation,config:fixture.config,
      runtimeHealthState:"HEALTHY",runtimeVersion:"4.2.0",
      update:{selfUpdateSupported:true,configured:true},
      onboarding:{connectedThroughTunnel:true},
      homeDir:fixture.homeDir,
      readCurrentReleaseImpl:async()=>({version:"4.2.0",releaseDir:fixture.releaseDir}),
    };
    for(const user of [
      {ready:true,consentAccepted:false,controlEnabled:true},
      {ready:true,consentAccepted:true,controlEnabled:false},
    ]){
      const result=await getEquinoxLocalDoctorStatus({...base,browser:{
        contexts:{user,agent:{ready:true,consentAccepted:true,controlEnabled:true}},
      }});
      assert.equal(result.state,"ATTENTION");
      assert.equal(result.checks.find(item=>item.id==="browser")?.status,"attention");
      assert.equal(result.checks.find(item=>item.id==="agent-browser")?.status,"pass");
    }
    const disconnected=await getEquinoxLocalDoctorStatus({...base,browser:{
      contexts:{user:{ready:false},agent:{ready:true,consentAccepted:false,controlEnabled:true}},
    }});
    assert.equal(disconnected.checks.find(item=>item.id==="browser")?.status,"optional");
    assert.equal(disconnected.checks.find(item=>item.id==="agent-browser")?.status,"attention");
  }finally{await fs.rm(fixture.homeDir,{recursive:true,force:true})}
});

test("Doctor fails closed for missing trusted Windows SystemRoot without invoking registry or Native Messaging inspector",async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"equinox-doctor-os-root-"));
  try{
    const installRoot="C:\\Users\\Fixture\\AppData\\Local\\Equinox Local";
    let startup=0,native=0,shell=0;
    const result=await getEquinoxLocalDoctorStatus({
      installation:{kind:"managed",managed:true,selfUpdateSupported:true,lifecycleKind:"windows-user",
        installRoot,releaseDir:installRoot+"\\releases\\7.0.0",
        programRoot:"C:\\Users\\Fixture\\Programs\\Equinox Local",
        nativeMessagingManifestRoot:installRoot+"\\browser\\native-messaging"},
      config:{version:1,runtime:{workspaceProject:"workspace"},projects:{workspace:{root:home}}},
      host:{platform:"win32",arch:"x64",target:"win32-x64",displayName:"Windows"},
      runtimeHealthState:"HEALTHY",runtimeVersion:"7.0.0",
      runtimeEnv:{SystemRoot:"relative\\Windows",PATH:"C:\\untrusted",OPENAI_API_KEY:"fixture-secret"},
      readCurrentReleaseImpl:async()=>({version:"7.0.0",releaseDir:installRoot+"\\releases\\7.0.0"}),
      assertWindowsStableShellImpl:async()=>{shell++;},
      readWindowsStartupImpl:async()=>{startup++;return {enabled:true}},
      assertWindowsNativeHostImpl:async()=>{native++;},
    });
    assert.equal(shell,1);
    assert.equal(startup,0);
    assert.equal(native,0);
    assert.equal(result.checks.find(x=>x.id==="windows-startup")?.status,"attention");
    assert.equal(result.checks.find(x=>x.id==="native-host")?.status,"attention");
    assert.equal(JSON.stringify(result).includes("fixture-secret"),false);
  }finally{await fs.rm(home,{recursive:true,force:true})}
});

test("Doctor tool registration returns bounded errors through the injected error boundary without invoking diagnostic side effects",async()=>{
  const registered=new Map();
  let inspected=0;
  registerSystemDoctorTool({
    registerTextTool:(name,config,handler,options)=>registered.set(name,{config,handler,options}),
    getDoctorStatus:async()=>{inspected++;throw Error("synthetic-diagnostic-failure")},
    textResult:text=>({text}),
    errorResult:error=>({isError:true,error:error.message}),
  });
  const tool=registered.get("system_doctor");
  assert.equal(tool.config.annotations.readOnlyHint,true);
  assert.equal(tool.config.annotations.destructiveHint,false);
  assert.equal(tool.options.projectAware,false);
  const response=await tool.handler();
  assert.deepEqual(response,{isError:true,error:"synthetic-diagnostic-failure"});
  assert.equal(inspected,1);
});
