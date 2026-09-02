import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { installManagedEquinoxRelease } from "../../src/equinox-local-first-install.js";
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

async function main() {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const target = equinoxLocalUpdateTarget();
  const artifact = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(rootDir, "backups", "local-packages", `equinox-local-${EQUINOX_LOCAL_VERSION}-${target}.tar.gz`);
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-managed-smoke-"));
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
    const installResult = await installManagedEquinoxRelease({
      stagedReleaseDir: path.join(stagedRoot, "release"),
      homeDir,
      uid: typeof process.getuid === "function" ? process.getuid() : 501,
      platform: "darwin",
      target,
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
      waitForVersionImpl: async () => true,
    });
    assert.equal(installResult.status, "installed");
    assert.equal(installResult.version, EQUINOX_LOCAL_VERSION);
    assert.equal(installResult.configCreated, true);
    assert.equal(await fs.readlink(current), `releases/${EQUINOX_LOCAL_VERSION}`);
    assert.equal(await fs.realpath(current), await fs.realpath(releaseDir));

    const launchAgent = path.join(homeDir, "Library", "LaunchAgents", "dev.equinox.local.plist");
    await execFile(PLUTIL, ["-lint", launchAgent], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    const configPath = path.join(installRoot, "config.json");
    await setControlCenterPort(configPath);

    assert.equal(await commandText(node, ["--version"]), "v24.20.0");
    assert.match(await commandText(tunnel, ["--version"]), /^0\.0\.13\+/u);
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
    const onboarding = await waitForJson(`http://127.0.0.1:${CONTROL_CENTER_PORT}/api/v1/onboarding`);
    assert.equal(onboarding.onboarding.available, true);
    assert.equal(onboarding.onboarding.managed, true);
    assert.equal(onboarding.onboarding.transportConfigured, false);
    assert.equal(onboarding.onboarding.supervisorMode, "local-only");
    assert.equal(onboarding.onboarding.connectedThroughTunnel, false);
    assert.equal(Object.hasOwn(onboarding.onboarding, "runtimeKey"), false);
    const doctor = await waitForJson(`http://127.0.0.1:${CONTROL_CENTER_PORT}/api/v1/doctor`);
    assert.equal(doctor.doctor.managed, true);
    assert.equal(doctor.doctor.installationKind, "managed");
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
      nodeVersion: "24.20.0",
      tunnelClientVersion: "0.0.13",
      controlCenterPort: CONTROL_CENTER_PORT,
      controlCenterHealth: status.status.health?.state ?? null,
      artifact,
    }, null, 2)}\n`);
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
