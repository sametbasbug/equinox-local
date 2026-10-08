// Explicit, opt-in genuine hosted-macOS native Main update acceptance.
// Never run beside someone's existing dev.equinox.local LaunchAgent.
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { installManagedEquinoxRelease } from "../../src/equinox-local-first-install.js";
import { readEquinoxLocalMainSourcePointer } from "../../src/equinox-local-main-source-pointer.js";
import { equinoxLocalToolchainContract } from "../../src/equinox-local-toolchain-contract.js";
import { equinoxLocalUpdateTarget } from "../../src/equinox-local-updater.js";

const execFile = promisify(execFileCallback);
const SHA = /^[a-f0-9]{40}$/u;
const BASE = "http://127.0.0.1:24891";
const LABEL = "dev.equinox.local";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(check, label, timeoutMs = 90_000) {
  const started = Date.now();
  let last = "not checked";
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { last = error?.message ?? String(error); }
    await sleep(500);
  }
  throw new Error(`${label} timed out: ${last}`);
}

async function jsonApi(route, { mutate = false, token = null } = {}) {
  const response = await fetch(`${BASE}${route}`, {
    method: mutate ? "POST" : "GET",
    headers: mutate ? { origin: BASE, "x-equinox-csrf": token, "content-type": "application/json" } : {},
    body: mutate ? "{}" : undefined,
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok || body.ok !== true) throw new Error(`Control Center ${route} HTTP ${response.status}: ${String(body.error || "unknown").slice(0, 350)}`);
  return body;
}

async function awaitHealthy(expectedSha, { kind = "managed-source", timeoutMs = 120_000 } = {}) {
  return await poll(async () => {
    const { status } = await jsonApi("/api/v1/status");
    return status.health?.state === "HEALTHY" && status.installation?.kind === kind &&
      (status.installation?.sourceSha ?? null) === expectedSha ? status : null;
  }, `HEALTHY ${kind} ${expectedSha ?? "Stable"}`, timeoutMs);
}

async function run() {
  if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true" ||
      !process.env.RUNNER_TEMP) throw new Error("This destructive native-host smoke may run only in an isolated hosted macOS Actions runner.");
  const [artifact, previousSha, targetSha] = process.argv.slice(2);
  if (typeof artifact !== "string" || !path.isAbsolute(artifact) || !SHA.test(previousSha ?? "") || !SHA.test(targetSha ?? "") || previousSha === targetSha) {
    throw new Error("Usage: smoke-main-upgrade-macos.mjs /absolute/old-release.tar.gz <admitted-A-SHA> <admitted-B-SHA>");
  }
  assert.equal(process.arch, "arm64", "run on a native macOS ARM64 hosted runner");
  // Ensure tests never bootout or replace an existing user's instance. An
  // occupied port or managed LaunchAgent means this machine isn't isolated.
  const uid = process.getuid();
  const service = `gui/${uid}/${LABEL}`;
  const prior = await execFile("/bin/launchctl", ["print", service], { timeout: 5_000 }).then(() => true, () => false);
  if (prior) throw new Error("Refusing test: Equinox Local LaunchAgent is already registered on this host.");
  const portBusy = await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  if (portBusy) throw new Error("Refusing test: the real Control Center port is already in use.");

  const runnerReal = await fs.realpath(process.env.RUNNER_TEMP);
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(runnerReal, "equinox-main-installed-")));
  const homeDir = path.join(scratch, "isolated-home");
  const installRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local");
  const transactionRoot = path.join(installRoot, "main-update");
  const env = { ...process.env, HOME: homeDir };
  // The historically admitted A Swift app gets its runtime wrapper path from
  // FileManager.homeDirectoryForCurrentUser (the OS account home), not $HOME.
  // Preserve its exact binary/provenance and bridge only that fixed pathname to
  // the isolated managed install on a dedicated ephemeral hosted runner.
  const accountHome = os.userInfo().homedir;
  if (path.resolve(process.env.HOME || "") !== accountHome || accountHome === homeDir) {
    throw new Error("Refusing native host shim outside an isolated runner account HOME.");
  }
  const nativeHostDirectory = path.join(accountHome, "Library", "Application Support", "Equinox Local");
  const nativeHostWrapperAlias = path.join(nativeHostDirectory, "equinox-local-app-runtime");
  const actualWrapper = path.join(installRoot, "equinox-local-app-runtime");
  const ownedService = { started: false, transactionId: null, wrapperAlias: false };
  const trackedExecFile = async (command, args, options = {}) => {
    if (command === "/bin/launchctl" && args[0] === "bootstrap" && args[1] === `gui/${uid}`) {
      ownedService.started = true;
    }
    return await execFile(command, args, options);
  };
  try {
    await fs.mkdir(homeDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(nativeHostDirectory, { recursive: true, mode: 0o700 });
    if ((await fs.readdir(nativeHostDirectory)).length !== 0) {
      throw new Error("Refusing native host shim: the runner account already has Equinox Local files.");
    }
    await fs.symlink(actualWrapper, nativeHostWrapperAlias);
    ownedService.wrapperAlias = true;
    const staging = path.join(installRoot, "staging", "native-acceptance");
    await fs.mkdir(staging, { recursive: true, mode: 0o700 });
    await execFile("/usr/bin/tar", ["-xzf", artifact, "-C", staging], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const release = path.join(staging, "release");
    const metadata = JSON.parse(await fs.readFile(path.join(release, "release.json"), "utf8"));
    assert.equal(metadata.sourceSha, previousSha);
    assert.equal(metadata.target, equinoxLocalUpdateTarget());
    const result = await installManagedEquinoxRelease({
      stagedReleaseDir: release, homeDir, env, uid,
      execFileImpl: trackedExecFile,
      waitForVersionImpl: async () => { ownedService.started = true; await awaitHealthy(null, { kind: "managed" }); return true; },
      waitForManagedSourceImpl: async (_version, sha) => { await awaitHealthy(sha); return true; },
    });
    ownedService.started = true;
    assert.equal(result.managedSourceSha, previousSha);
    const before = await awaitHealthy(previousSha);
    assert.equal(before.installation?.kind, "managed-source");
    const toolchain = equinoxLocalToolchainContract({ runtimeRoot: path.join(installRoot, "runtime"), target: equinoxLocalUpdateTarget() });
    const getPointer = () => readEquinoxLocalMainSourcePointer(path.join(transactionRoot, "current-source.conf"), { gitPath: toolchain.gitPath });
    assert.equal((await getPointer()).sha, previousSha);
    const { csrfToken } = await jsonApi("/api/v1/session");
    await jsonApi("/api/v1/update/check", { mutate: true, token: csrfToken });
    const discovery = await jsonApi("/api/v1/update");
    assert.equal(discovery.update?.main?.targetSha, targetSha, "the separately admitted Main snapshot must be the exact target");
    assert.equal(discovery.update?.main?.applyAvailable, true);
    const response = await jsonApi("/api/v1/update/apply", { mutate: true, token: csrfToken });
    assert.equal(response.result?.targetSha, targetSha);
    const transactionId = response.result.transactionId;
    assert.match(transactionId, /^main-[a-f0-9]{32}$/u);
    ownedService.transactionId = transactionId;
    const receiptPath = path.join(transactionRoot, "receipts", `${transactionId}.json`);
    const receipt = await poll(async () => {
      const data = JSON.parse(await fs.readFile(receiptPath, "utf8"));
      if (data.status === "failed" || data.status === "rollback_failed" || data.status === "rolled_back") {
        throw new Error(`Main updater did not accept B: ${data.status}: ${data.lastError}`);
      }
      return data.status === "succeeded" ? data : null;
    }, "detached native Main updater completion", 240_000);
    assert.equal(receipt.targetSha, targetSha);
    assert.equal((await getPointer()).sha, targetSha);
    const after = await awaitHealthy(targetSha, { timeoutMs: 60_000 });
    assert.equal(after.installation?.kind, "managed-source");
    assert.equal((await fs.lstat(path.join(installRoot, "current"))).isSymbolicLink(), true);
    process.stdout.write(`${JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, from: previousSha, to: targetSha, nativeMode: response.result.nativeTransition?.mode, restartHealth: after.health?.state, receipt: receipt.status })}\n`);
  } finally {
    if (ownedService.started) await execFile("/bin/launchctl", ["bootout", service], { timeout: 15_000 }).catch(() => {});
    if (ownedService.transactionId) {
      const workerService = `gui/${uid}/dev.equinox.local.main-update.${ownedService.transactionId.slice(5)}`;
      await execFile("/bin/launchctl", ["bootout", workerService], { timeout: 15_000 }).catch(() => {});
    }
    await sleep(1500);
    if (ownedService.wrapperAlias) {
      const alias = await fs.lstat(nativeHostWrapperAlias);
      if (!alias.isSymbolicLink() || await fs.readlink(nativeHostWrapperAlias) !== actualWrapper) {
        throw new Error("Native host test alias identity changed during cleanup.");
      }
      await fs.unlink(nativeHostWrapperAlias);
    }
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
