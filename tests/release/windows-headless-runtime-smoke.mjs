import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION,
  TUNNEL_CLIENT_DISTRIBUTIONS,
} from "../../src/equinox-local-runtime-versions.js";
import { createWindowsJobObjectLease } from "../../src/equinox-local-windows-job-object.js";
import { createEquinoxLocalRuntime } from "../../src/server.js";

const execFile = promisify(execFileCallback);

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`Windows headless smoke requires win32-x64; got ${process.platform}-${process.arch}.`);
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200, `${pathname} returned HTTP ${response.status}`);
  return await response.json();
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitFor(predicate, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function verifyWindowsJobObjectContainment(root) {
  const gatePath = path.join(root, "job gate.txt");
  const childPidPath = path.join(root, "job child pid.txt");
  const script = [
    "while (-not (Test-Path -LiteralPath $env:EQUINOX_JOB_GATE)) { Start-Sleep -Milliseconds 25 }",
    "$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden",
    "[IO.File]::WriteAllText($env:EQUINOX_JOB_CHILD_PID, [string]$child.Id)",
    "Start-Sleep -Seconds 60",
  ].join("; ");
  const parent = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, EQUINOX_JOB_GATE: gatePath, EQUINOX_JOB_CHILD_PID: childPidPath },
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  assert.ok(Number.isInteger(parent.pid) && parent.pid > 0, "Windows Job Object fixture parent did not start");

  const lease = await createWindowsJobObjectLease();
  let childPid = null;
  try {
    const assigned = await lease.assign(parent.pid);
    assert.ok(assigned.activeProcesses >= 1, "assigned Job Object did not report its parent");
    await fs.writeFile(gatePath, "go", { flag: "wx" });
    childPid = await waitFor(async () => {
      const text = await fs.readFile(childPidPath, "utf8").catch(() => "");
      const value = Number.parseInt(text.trim(), 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    }, "Windows Job Object fixture did not create its descendant");
    assert.equal(pidExists(parent.pid), true, "Job Object parent disappeared before termination");
    assert.equal(pidExists(childPid), true, "Job Object descendant disappeared before termination");
    const status = await lease.status();
    assert.ok(status.activeProcesses >= 2, `Job Object expected parent + descendant; got ${status.activeProcesses}`);

    await lease.terminate(73);
    await waitFor(() => !pidExists(parent.pid) && !pidExists(childPid), "Windows Job Object did not drain parent + descendant after termination");
    return Object.freeze({ parentPid: parent.pid, childPid, activeBeforeTerminate: status.activeProcesses, drained: true });
  } finally {
    await lease.close().catch(() => {});
    if (pidExists(parent.pid)) parent.kill();
    if (Number.isInteger(childPid) && pidExists(childPid)) {
      try { process.kill(childPid); } catch {}
    }
  }
}

async function verifyPinnedWindowsTunnelClient(root) {
  const distribution = TUNNEL_CLIENT_DISTRIBUTIONS["win32-x64"];
  assert.ok(distribution, "win32-x64 tunnel-client metadata is missing");
  const url = `https://github.com/openai/tunnel-client/releases/download/v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}/${distribution.filename}`;
  const response = await fetch(url, {
    redirect: "follow",
    cache: "no-store",
    credentials: "omit",
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.ok, true, `tunnel-client download returned HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  assert.ok(archive.length > 0 && archive.length <= 128 * 1024 * 1024, "tunnel-client archive size is invalid");
  assert.equal(createHash("sha256").update(archive).digest("hex"), distribution.sha256, "tunnel-client checksum mismatch");

  const archivePath = path.join(root, distribution.filename);
  const extractDir = path.join(root, "tunnel-runtime");
  await fs.writeFile(archivePath, archive, { flag: "wx" });
  await fs.mkdir(extractDir, { recursive: true });
  await execFile("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Expand-Archive -LiteralPath $env:EQUINOX_TUNNEL_ZIP -DestinationPath $env:EQUINOX_TUNNEL_DIR -Force",
  ], {
    env: { ...process.env, EQUINOX_TUNNEL_ZIP: archivePath, EQUINOX_TUNNEL_DIR: extractDir },
    timeout: 30_000,
    windowsHide: true,
  });

  const expectedFiles = [
    "LICENSE",
    "NOTICE",
    "cloudflared-manifest.json",
    "cloudflared.exe",
    "tunnel-client.exe",
    `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-${distribution.assetTag}-licenses.txt`,
    `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-${distribution.assetTag}.spdx.json`,
  ].sort();
  assert.deepEqual((await fs.readdir(extractDir)).sort(), expectedFiles, "tunnel-client archive contents drifted");

  const tunnel = await execFile(path.join(extractDir, "tunnel-client.exe"), ["--version"], { timeout: 10_000, windowsHide: true });
  assert.match(tunnel.stdout, new RegExp(`^${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION.replaceAll(".", "\\.")}\\+`, "u"));
  const cloudflared = await execFile(path.join(extractDir, "cloudflared.exe"), ["--version"], { timeout: 10_000, windowsHide: true });
  assert.match(cloudflared.stdout, /cloudflared version/iu);

  return Object.freeze({
    version: EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION,
    sha256: distribution.sha256,
    tunnelVersion: tunnel.stdout.trim(),
    cloudflaredVersion: cloudflared.stdout.trim(),
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-windows-headless-"));
const homeDir = path.join(root, "User Home Ş");
const localAppData = path.join(homeDir, "AppData", "Local");
const stateDir = path.join(localAppData, "Equinox Local");
const workspaceDir = path.join(root, "Workspace Ö");
const downloadsDir = path.join(homeDir, "Downloads");
const configPath = path.join(stateDir, "config.json");
const port = await reserveLoopbackPort();

const config = {
  version: 1,
  defaultProject: "workspace",
  runtime: {
    workspaceProject: "workspace",
    downloadsRoot: "downloads",
  },
  projects: {
    workspace: {
      name: "Windows Smoke Workspace",
      root: workspaceDir,
      worktrees: false,
    },
  },
  fileRoots: {
    downloads: {
      name: "Downloads",
      root: downloadsDir,
      access: "read-only",
    },
  },
  agentAccess: {
    files: "selected",
    terminal: false,
    desktop: false,
    browser: false,
  },
  controlCenter: {
    enabled: true,
    port,
  },
};

const runtimeEnv = {
  ...process.env,
  HOME: homeDir,
  USERPROFILE: homeDir,
  LOCALAPPDATA: localAppData,
  EQUINOX_LOCAL_CONFIG_PATH: configPath,
  EQUINOX_LOCAL_SUPERVISOR_MODE: "local-only",
  EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE: `windows-smoke-${process.pid}`,
};

const transport = {
  started: false,
  onclose: undefined,
  onerror: undefined,
  onmessage: undefined,
  async start() { this.started = true; },
  async send() {},
  async close() { this.onclose?.(); },
};

let runtime = null;
let lifecycle = null;
try {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(downloadsDir, { recursive: true });
  await execFile("git.exe", ["init", "--quiet", workspaceDir], { timeout: 10_000, windowsHide: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });

  runtime = await createEquinoxLocalRuntime({
    platform: process.platform,
    arch: process.arch,
    env: runtimeEnv,
    homeDir,
  });
  lifecycle = await runtime.start({ transport });

  assert.equal(transport.started, true, "MCP transport did not start");
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.started, true, "runtime did not enter started state");
  assert.equal(snapshot.browser.active, false, "Windows Browser IPC must remain inactive until W4");
  assert.equal(snapshot.controlCenter?.active, true, "Control Center did not start");
  assert.equal(snapshot.controlCenter?.port, port, "Control Center started on an unexpected port");

  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await getJson(baseUrl, "/api/v1/health");
  assert.equal(health.ok, true);

  const status = await getJson(baseUrl, "/api/v1/status");
  assert.equal(status.ok, true);

  const doctor = await getJson(baseUrl, "/api/v1/doctor");
  assert.equal(doctor.ok, true);
  assert.equal(doctor.doctor?.host?.target, "win32-x64");
  assert.equal(doctor.doctor?.host?.platform, "win32");
  assert.equal(doctor.doctor?.managed, false);
  assert.equal(doctor.doctor?.state, "HEALTHY");

  const tunnel = await verifyPinnedWindowsTunnelClient(root);
  const jobObject = await verifyWindowsJobObjectContainment(root);

  const htmlResponse = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  assert.match(html, /Equinox Local/u);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: "win32-x64",
    controlCenterPort: port,
    doctorState: doctor.doctor?.state ?? null,
    browserIpcActive: snapshot.browser.active,
    tunnel,
    jobObject,
  }, null, 2)}\n`);
} finally {
  if (lifecycle) await lifecycle.shutdown().catch(() => {});
  else if (runtime) await runtime.shutdown({ reason: "windows-smoke-cleanup" }).catch(() => {});
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}
