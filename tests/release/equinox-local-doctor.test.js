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
      developmentTunnel: { configured: true, expectedVersion: "0.0.15", actualVersion: "0.0.15", synchronized: true },
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
      host: { platform: "win32", arch: "x64", target: "win32-x64", displayName: "Windows", supported: true },
      now: () => new Date("2026-09-27T00:00:00.000Z"),
    });
    assert.deepEqual(result.host, { platform: "win32", arch: "x64", target: "win32-x64", displayName: "Windows", supported: true });
    assert.equal(result.state, "HEALTHY");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doctor keeps Your Browser required state separate from healthy Agent Browser state", async () => {
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
      developmentTunnel: { configured: true, expectedVersion: "0.0.15", actualVersion: "0.0.15", synchronized: true },
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
      developmentTunnel: { configured: true, expectedVersion: "0.0.15", actualVersion: "0.0.12", synchronized: false },
      browser: { ready: false },
      peekaboo: { active: false },
    });
    const tunnel = result.checks.find((item) => item.id === "development-tunnel");
    assert.equal(result.state, "ATTENTION");
    assert.equal(tunnel?.status, "attention");
    assert.match(tunnel?.detail || "", /0\.0\.12.*0\.0\.15/u);
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
      developmentTunnel: { configured: true, expectedVersion: "0.0.15", actualVersion: "0.0.15", synchronized: true },
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

test("future Windows managed Doctor model never applies LaunchAgent checks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-doctor-windows-managed-"));
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { mode: 0o700 });
    const result = await getEquinoxLocalDoctorStatus({
      installation: {
        kind: "managed",
        managed: true,
        selfUpdateSupported: true,
        lifecycleKind: "windows-user",
        installRoot: "C:\\Users\\Example\\AppData\\Local\\Equinox Local",
      },
      config: { version: 1, runtime: { workspaceProject: "workspace" }, projects: { workspace: { root: workspace } } },
      runtimeHealthState: "HEALTHY",
      runtimeVersion: "5.2.1",
      browser: { ready: true, consentAccepted: true, controlEnabled: true },
      peekaboo: {},
      update: { selfUpdateSupported: true, configured: true },
      onboarding: { connectedThroughTunnel: true },
      host: { platform: "win32", arch: "x64", target: "win32-x64", displayName: "Windows", supported: true },
      homeDir: "C:\\Users\\Example",
      readCurrentReleaseImpl: async () => ({ version: "5.2.1" }),
      now: () => new Date("2026-09-27T00:00:00.000Z"),
    });
    assert.equal(result.checks.some((item) => item.id === "launch-agent"), false);
    assert.equal(result.checks.some((item) => item.id === "windows-lifecycle"), true);
    assert.equal(result.checks.find((item) => item.id === "windows-lifecycle").status, "attention");
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
    assert.equal(result.checks.find((item) => item.id === "browser")?.status, "attention");
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
