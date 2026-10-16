import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { installManagedEquinoxRelease } from "../../src/equinox-local-first-install.js";
import { enrollEquinoxLocalManagedSource, rollbackEquinoxLocalManagedSourceEnrollment } from "../../src/equinox-local-managed-source-enrollment.js";
import { bridgeActivatedStableToMain } from "../../src/equinox-local-stable-main-bridge.js";
import { resolveEquinoxLocalInstallation } from "../../src/equinox-local-installation.js";
import { equinoxLocalToolchainContract } from "../../src/equinox-local-toolchain-contract.js";
import { EQUINOX_LOCAL_VERSION } from "../../src/equinox-local-version.js";
import { equinoxLocalUpdateTarget } from "../../src/equinox-local-updater.js";

const execFile = promisify(execFileCallback);
const CONTROL_CENTER_PORT = 34991;
const TAR = "/usr/bin/tar";
const PLUTIL = "/usr/bin/plutil";

async function waitForJson(url, attempts = 40) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function runRealLaunchAgentWrapperSmoke({ homeDir, installRoot, expectedVersion, expectedInstallationKind, expectedSourceSha = null }) {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") return;
  const uid = process.getuid();
  const label = `dev.equinox.local.release-smoke.${process.pid}`;
  const domain = `gui/${uid}`;
  const service = `${domain}/${label}`;
  const helper = path.join(homeDir, "launch-agent-runtime-host");
  const plist = path.join(homeDir, `${label}.plist`);
  const stdoutLog = path.join(homeDir, "launch-agent.stdout.log");
  const stderrLog = path.join(homeDir, "launch-agent.stderr.log");
  const wrapper = path.join(installRoot, "equinox-local-app-runtime");

  await fs.writeFile(helper, `#!/bin/bash\nset -euo pipefail\n${JSON.stringify(wrapper)}\n`, { mode: 0o700 });
  await fs.chmod(helper, 0o700);
  await fs.writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xmlEscape(label)}</string>
<key>ProgramArguments</key><array><string>${xmlEscape(helper)}</string></array>
<key>EnvironmentVariables</key><dict>
<key>HOME</key><string>${xmlEscape(homeDir)}</string>
<key>EQUINOX_LOCAL_INSTALL_ROOT</key><string>${xmlEscape(installRoot)}</string>
<key>EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE</key><string>release-smoke-${process.pid}</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xmlEscape(stdoutLog)}</string>
<key>StandardErrorPath</key><string>${xmlEscape(stderrLog)}</string>
</dict></plist>\n`, { mode: 0o600 });

  await execFile("/bin/launchctl", ["bootout", service], { timeout: 10_000, maxBuffer: 1024 * 1024 }).catch(() => {});
  try {
    await execFile("/bin/launchctl", ["bootstrap", domain, plist], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    await execFile("/bin/launchctl", ["kickstart", service], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    let status;
    try {
      status = await waitForJson(`http://127.0.0.1:${CONTROL_CENTER_PORT}/api/v1/status`, 120);
    } catch (error) {
      const launchState = await execFile("/bin/launchctl", ["print", service], { timeout: 5_000, maxBuffer: 1024 * 1024 })
        .then(({ stdout }) => stdout.slice(-8_000))
        .catch((launchError) => `launchctl print failed: ${launchError.message}`);
      const stderr = await fs.readFile(stderrLog, "utf8").then((value) => value.slice(-8_000)).catch(() => "(empty)");
      throw new Error(`Real LaunchAgent wrapper smoke did not become healthy: ${error instanceof Error ? error.message : error}\nLaunchAgent:\n${launchState}\nStderr:\n${stderr}`);
    }
    assert.equal(status.status.server.version, expectedVersion);
    assert.equal(status.status.health?.state, "HEALTHY");
    assert.equal(status.status.installation?.kind, expectedInstallationKind);
    assert.equal(status.status.installation?.sourceSha ?? null, expectedSourceSha);
    return status;
  } finally {
    await execFile("/bin/launchctl", ["bootout", service], { timeout: 15_000, maxBuffer: 1024 * 1024 }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function setControlCenterPort(configPath) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.deepEqual(config.agentAccess, {
    files: "full",
    terminal: true,
    desktop: true,
    browser: true,
  });
  config.controlCenter = { ...(config.controlCenter || {}), enabled: true, port: CONTROL_CENTER_PORT };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(configPath, 0o600);
}

// An opt-in real hosted-OS gate: the product's own launchd service handles the
// same-numbered Main -> Stable full-tree repair, health failure and rollback.
// The runner is disposable; NEVER load the real developer's service here.
async function runHostedMacSameVersionRepair({ homeDir, installRoot, releaseDir, target, sourceSha }) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.CI, "true");
  assert.equal(process.platform, "darwin");
  const uid = process.getuid();
  const service = `gui/${uid}/dev.equinox.local`;
  const launchAgent = path.join(homeDir, "Library", "LaunchAgents", "dev.equinox.local.plist");
  const current = path.join(installRoot, "current");
  const stamp = path.join(installRoot, "state", "main-update", "install.json");
  const agentStatusUrl = `http://127.0.0.1:${CONTROL_CENTER_PORT}/api/v1/status`;
  const launchctl = (...args) => execFile("/bin/launchctl", args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
  const proofs = [
    path.join(installRoot, "config.json"),
    path.join(installRoot, "secrets", "openai-runtime-key"),
    path.join(installRoot, "browser", "profile", "Preferences"),
    path.join(installRoot, "tunnel", "profile", "equinox-local.yaml"),
    path.join(installRoot, "workspace", "owned-workspace.txt"),
  ];
  for (const [index, proof] of proofs.entries()) {
    if (index !== 0) {
      await fs.mkdir(path.dirname(proof), { recursive: true, mode: 0o700 });
      await fs.writeFile(proof, `existing-owner-state-${index}\n`, { mode: 0o600, flag: "wx" });
    }
  }
  const digest = async (file) => createHash("sha256").update(await fs.readFile(file)).digest("hex");
  const before = await Promise.all(proofs.map(digest));
  const stampBefore = await fs.readFile(stamp, "utf8");
  const checkedHealth = async (kind) => {
    let actual;
    for (let i = 0; i < 120; i++) {
      try {
        const response = await fetch(agentStatusUrl, { signal: AbortSignal.timeout(2000), cache: "no-store" });
        if (response.ok) {
          const status = (await response.json())?.status;
          if (status?.server?.version === EQUINOX_LOCAL_VERSION &&
              status?.health?.state === "HEALTHY" && status?.installation?.kind === kind &&
              (kind !== "managed-source" || status?.installation?.sourceSha === sourceSha)) {
            actual = status;
            break;
          }
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(actual, `Real macOS LaunchAgent failed to start healthy ${kind}`);
    const { stdout } = await launchctl("print", service);
    assert.match(stdout, /state = running/u);
  };
  // Reload the enrolled Main using the exact product service, not the
  // independent short-lived wrapper smoke's synthetic launchd label.
  await launchctl("bootout", service).catch(() => {});
  try {
    await launchctl("bootstrap", `gui/${uid}`, launchAgent);
    await launchctl("kickstart", service);
    await checkedHealth("managed-source");
    const reinstall = async (label, forceFailure) => {
      const staging = path.join(installRoot, "staging", `native-${label}`, "release");
      await fs.mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
      await fs.cp(releaseDir, staging, { recursive: true, force: false, errorOnExist: true });
      return installManagedEquinoxRelease({
        stagedReleaseDir: staging, homeDir, uid, platform: "darwin", target,
        execFileImpl: execFile,
        waitForVersionImpl: async (version, { expectedInstallationKind }) => {
          assert.equal(version, EQUINOX_LOCAL_VERSION);
          await checkedHealth(expectedInstallationKind);
          if (forceFailure && expectedInstallationKind === "managed") {
            throw new Error("hosted injected unhealthy same-numbered Stable");
          }
        },
      });
    };
    await assert.rejects(reinstall("forced-failure", true), /rolled back to Main/u);
    await checkedHealth("managed-source");
    assert.equal(await fs.readFile(stamp, "utf8"), stampBefore);
    assert.equal(await fs.realpath(current), await fs.realpath(releaseDir));
    assert.deepEqual(await Promise.all(proofs.map(digest)), before);

    const result = await reinstall("success", false);
    assert.equal(result.status, "activated");
    await checkedHealth("managed");
    assert.equal(await fs.readFile(stamp, "utf8").then(() => true, () => false), false);
    assert.equal(await fs.realpath(current), await fs.realpath(releaseDir));
    assert.deepEqual(await Promise.all(proofs.map(digest)), before);
    process.stdout.write(`Real macOS ${target} same-version Main-to-Stable LaunchAgent reinstall, forced rollback and user-data preservation PASSED.\n`);
  } finally {
    await launchctl("bootout", service).catch(() => {});
  }
}

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const target = equinoxLocalUpdateTarget();
  const artifact = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(rootDir, "backups", "local-packages", `equinox-local-${EQUINOX_LOCAL_VERSION}-${target}.tar.gz`);
  const testRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-managed-smoke-")));
  const homeDir = path.join(testRoot, "Home With Space");
  const installRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local");
  const releasesRoot = path.join(installRoot, "releases");
  const releaseDir = path.join(releasesRoot, EQUINOX_LOCAL_VERSION);
  const current = path.join(installRoot, "current");
  const node = path.join(current, "runtime", "node", "bin", "node");
  const tunnel = path.join(current, "runtime", "tunnel", "tunnel-client");
  const cloudflared = path.join(current, "runtime", "tunnel", "cloudflared");
  const supervisor = path.join(current, "equinox-local-supervisor.js");
  let child = null;

  try {
    await fs.mkdir(homeDir, { recursive: true, mode: 0o700 });
    const stagedRoot = path.join(installRoot, "staging", "smoke");
    await fs.mkdir(stagedRoot, { recursive: true, mode: 0o700 });
    await execFile(TAR, ["-xzf", artifact, "-C", stagedRoot], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const stagedReleaseDir = path.join(stagedRoot, "release");
    const releaseMetadata = JSON.parse(await fs.readFile(path.join(stagedReleaseDir, "release.json"), "utf8"));
    const sourceSha = releaseMetadata.sourceSha;
    assert.match(sourceSha, /^[a-f0-9]{40}$/u);

    const canonicalRemote = path.join(testRoot, "canonical-main.git");
    await execFile("/usr/bin/git", ["init", "--bare", canonicalRemote], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    await execFile("/usr/bin/git", ["-C", rootDir, "push", "--force", canonicalRemote, `${sourceSha}:refs/heads/main`], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const mainRemote = pathToFileURL(canonicalRemote).href;
    const configPath = path.join(installRoot, "config.json");
    let stableHealth = null;
    let sourceHealth = null;

    const installResult = await installManagedEquinoxRelease({
      allowExistingStableToMainMigration: true,
      stagedReleaseDir,
      homeDir,
      uid: typeof process.getuid === "function" ? process.getuid() : 501,
      platform: "darwin",
      target,
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
      waitForVersionImpl: async (version) => {
        await setControlCenterPort(configPath);
        stableHealth = await runRealLaunchAgentWrapperSmoke({
          homeDir, installRoot, expectedVersion: version, expectedInstallationKind: "managed", expectedSourceSha: null,
        });
        return true;
      },
      enrollManagedSourceImpl: async (options) => enrollEquinoxLocalManagedSource({
        ...options,
        env: { ...options.env, PATH: "/ambient-tools-must-not-be-used" },
        execFileImpl: execFile,
        mainRemote,
      }),
      waitForManagedSourceImpl: async (version, sha) => {
        sourceHealth = await runRealLaunchAgentWrapperSmoke({
          homeDir, installRoot, expectedVersion: version, expectedInstallationKind: "managed-source", expectedSourceSha: sha,
        });
        return true;
      },
    });
    assert.equal(installResult.status, "installed");
    assert.equal(installResult.version, EQUINOX_LOCAL_VERSION);
    assert.equal(installResult.managedSourceSha, sourceSha);
    assert.equal(installResult.configCreated, true);
    assert.equal(stableHealth?.status?.installation?.kind, "managed");
    assert.equal(sourceHealth?.status?.installation?.kind, "managed-source");
    assert.equal(sourceHealth?.status?.installation?.sourceSha, sourceSha);

    // Hosted macOS ONLY: exercise a real running LaunchAgent around the
    // legacy Stable-to-Main bridge rather than trusting mocked health checks.
    // The packaged release remains unsigned in this smoke; it does NOT claim
    // to test the production signed 6.0.3 -> bridge updater handoff.
    if (process.env.GITHUB_ACTIONS === "true" && process.env.CI === "true") {
      const bridgeEnv = {
        HOME: homeDir, EQUINOX_LOCAL_INSTALL_ROOT: installRoot,
        EQUINOX_LOCAL_RELEASE_DIR: releaseDir, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      };
      const bridgeInstallation = resolveEquinoxLocalInstallation({ homeDir, env: bridgeEnv });
      assert.equal(bridgeInstallation.kind, "managed");
      const rollBackToStable = async () => {
        const reverted = await rollbackEquinoxLocalManagedSourceEnrollment({
          bootstrapSha: sourceSha, target, platform: "darwin", arch: process.arch, homeDir, env: bridgeEnv,
        });
        assert.equal(reverted.rolledBack, true);
        const stable = await runRealLaunchAgentWrapperSmoke({
          homeDir, installRoot, expectedVersion: EQUINOX_LOCAL_VERSION,
          expectedInstallationKind: "managed", expectedSourceSha: null,
        });
        assert.equal(stable.status.health.state, "HEALTHY");
      };
      const bridgeOptions = {
        installation: bridgeInstallation,
        version: EQUINOX_LOCAL_VERSION,
        homeDir, env: bridgeEnv,
        enrollImpl: (options) => enrollEquinoxLocalManagedSource({
          ...options, env: { ...options.env, PATH: "/ambient-tools-must-not-be-used" },
          execFileImpl: execFile, mainRemote,
        }),
        // Real hosted LaunchAgent startup, ownership and Control Center
        // health are checked by waitForMain/Stable below. The fixture's
        // dedicated label prevents touching the developer's app identity.
        restartImpl: async () => {},
        waitForMainImpl: async (version, sha) => {
          const real = await runRealLaunchAgentWrapperSmoke({
            homeDir, installRoot, expectedVersion: version,
            expectedInstallationKind: "managed-source", expectedSourceSha: sha,
          });
          assert.equal(real.status.health.state, "HEALTHY");
        },
        waitForStableImpl: async (version) => {
          const real = await runRealLaunchAgentWrapperSmoke({
            homeDir, installRoot, expectedVersion: version,
            expectedInstallationKind: "managed", expectedSourceSha: null,
          });
          assert.equal(real.status.health.state, "HEALTHY");
        },
      };
      await rollBackToStable();
      assert.equal((await bridgeActivatedStableToMain(bridgeOptions)).status, "main-activated");
      await rollBackToStable();
      await assert.rejects(
        bridgeActivatedStableToMain({ ...bridgeOptions,
          waitForMainImpl: async () => { throw new Error("hosted simulated unhealthy Main"); },
        }),
        /signed Stable baseline was restored/u,
      );
      assert.equal((await bridgeActivatedStableToMain(bridgeOptions)).status, "main-activated");
      assert.equal(await fs.readFile(path.join(installRoot, "secrets", "openai-runtime-key"), "utf8").then(() => false, (error) => error?.code === "ENOENT"), true,
        "Bridge must not add, delete or reset onboarding secrets");
      process.stdout.write("Hosted native macOS LaunchAgent Stable-to-Main bridge + forced Main health rollback PASSED.\n");
    }

    assert.equal(await fs.readlink(current), `releases/${EQUINOX_LOCAL_VERSION}`);
    assert.equal(await fs.realpath(current), await fs.realpath(releaseDir));

    const launchAgent = path.join(homeDir, "Library", "LaunchAgents", "dev.equinox.local.plist");
    await execFile(PLUTIL, ["-lint", launchAgent], { timeout: 5_000, maxBuffer: 1024 * 1024 });

    const toolchain = equinoxLocalToolchainContract({ runtimeRoot: path.join(installRoot, "runtime"), target });
    assert.equal(toolchain.ambientPathDiscovery, false);
    assert.match(await commandText(toolchain.gitPath, ["--version"]), /^git version 2\.53\.0\b/u);
    assert.equal(await commandText(toolchain.nodePath, ["--version"]), "v26.11.1");
    assert.match(await commandText(toolchain.nodePath, [toolchain.npmPath, "--version"]), /^\d+\.\d+\.\d+$/u);
    assert.equal(await commandText(node, ["--version"]), "v26.11.1");
    assert.match(await commandText(tunnel, ["--version"]), /^0\.0\.16\+/u);
    assert.match(await commandText(cloudflared, ["--version"]), /cloudflared version/u);

    const fakeKey = path.join(installRoot, "secrets", "openai-runtime-key");
    await fs.writeFile(fakeKey, "sk-fixture-not-a-real-key\n", { mode: 0o600 });
    const profileDir = path.join(testRoot, "profile");
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await execFile(tunnel, [
      "init",
      "--force",
      "--sample", "sample_mcp_stdio_local",
      "--profile", "equinox-local",
      "--profile-dir", profileDir,
      "--tunnel-id", "tunnel_0123456789abcdef0123456789abcdef",
      "--mcp-command", `'${node}' '${path.join(current, "server.js")}'`,
      "--control-plane-api-key-ref", `file:${fakeKey}`,
      "--health-listen-addr", "127.0.0.1:0",
    ], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    const profile = await fs.readFile(path.join(profileDir, "equinox-local.yaml"), "utf8");
    assert.match(profile, /tunnel_0123456789abcdef0123456789abcdef/u);
    assert.match(profile, /openai-runtime-key/u);

    // No transport.json: supervisor must stay local-only for first-run onboarding.
    child = spawn(node, [supervisor], {
      env: {
        HOME: homeDir,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        EQUINOX_LOCAL_INSTALL_ROOT: installRoot,
        EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE: `smoke-${process.pid}`,
      },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

    let status;
    try {
      status = await waitForJson(`http://127.0.0.1:${CONTROL_CENTER_PORT}/api/v1/status`);
    } catch (error) {
      throw new Error(`Managed supervisor did not expose Control Center: ${error instanceof Error ? error.message : error}\nSupervisor stderr:\n${stderr || "(empty)"}`);
    }
    assert.equal(status.status.server.version, EQUINOX_LOCAL_VERSION);
    assert.equal(status.status.installation?.kind, "managed-source");
    assert.equal(status.status.installation?.sourceSha, sourceSha);
    const onboarding = await waitForJson(`http://127.0.0.1:${CONTROL_CENTER_PORT}/api/v1/onboarding`);
    assert.equal(onboarding.onboarding.available, true);
    assert.equal(onboarding.onboarding.managed, true);
    assert.equal(onboarding.onboarding.transportConfigured, false);
    assert.equal(onboarding.onboarding.supervisorMode, "local-only");
    assert.equal(onboarding.onboarding.connectedThroughTunnel, false);
    assert.equal(onboarding.onboarding.setupComplete, false);
    assert.equal(onboarding.onboarding.legacyCompleted, false);
    assert.equal(onboarding.onboarding.browserRequired, true);
    assert.equal(onboarding.onboarding.agentCommandReceived, false);
    assert.equal(Object.hasOwn(onboarding.onboarding, "runtimeKey"), false);
    const doctor = await waitForJson(`http://127.0.0.1:${CONTROL_CENTER_PORT}/api/v1/doctor`);
    assert.equal(doctor.doctor.managed, true);
    assert.equal(doctor.doctor.installationKind, "managed-source");
    assert.equal(Array.isArray(doctor.doctor.checks), true);
    assert.equal(doctor.doctor.checks.some((item) => item.id === "runtime" && item.status === "pass"), true);
    assert.equal(doctor.doctor.checks.some((item) => item.id === "chatgpt-connection" && item.status === "attention"), true);
    assert.equal(JSON.stringify(doctor).includes("openai-runtime-key"), false);
    const shellResponse = await fetch(`http://127.0.0.1:${CONTROL_CENTER_PORT}/`, { cache: "no-store" });
    assert.equal(shellResponse.ok, true);
    assert.match(await shellResponse.text(), /Equinox Local Control Center/u);
    const logoResponse = await fetch(`http://127.0.0.1:${CONTROL_CENTER_PORT}/assets/equinox-local.png`, { cache: "no-store" });
    assert.equal(logoResponse.ok, true);
    assert.match(String(logoResponse.headers.get("content-type")), /^image\/png\b/u);
    const logoBytes = Buffer.from(await logoResponse.arrayBuffer());
    assert.equal(logoBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
    assert.match(stderr, /local-only onboarding mode/u);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      version: EQUINOX_LOCAL_VERSION,
      target,
      nodeVersion: "26.11.1",
      tunnelClientVersion: "0.0.16",
      controlCenterPort: CONTROL_CENTER_PORT,
      controlCenterHealth: status.status.health?.state ?? null,
      sourceSha,
      installationKind: status.status.installation?.kind ?? null,
      artifact,
    }, null, 2)}\n`);
    if (process.env.EQUINOX_MACOS_SAME_VERSION_REPAIR === "true") {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => {
          if (child.exitCode !== null) return resolve();
          const timer = setTimeout(resolve, 3_000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
        });
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      await runHostedMacSameVersionRepair({ homeDir, installRoot, releaseDir, target, sourceSha });
    }
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2_000);
        timer.unref?.();
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await fs.rm(testRoot, { recursive: true, force: true });
  }
}

// execFile helper with optional options while retaining concise call sites.
async function commandText(command, args, options = {}) {
  const { stdout } = await execFile(command, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024, ...options });
  return stdout.trim();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
