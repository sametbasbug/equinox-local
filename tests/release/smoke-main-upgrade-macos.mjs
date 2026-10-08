// Explicit, opt-in genuine hosted-macOS native Main update acceptance.
// Never run beside someone's existing dev.equinox.local LaunchAgent.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
    } catch (error) {
      if (error?.smokeTerminal === true) throw error;
      last = error?.message ?? String(error);
    }
    await sleep(500);
  }
  throw new Error(`${label} timed out: ${last}`);
}

async function jsonApi(route, { mutate = false, token = null, timeoutMs = 30_000 } = {}) {
  const response = await fetch(`${BASE}${route}`, {
    method: mutate ? "POST" : "GET",
    headers: mutate ? { origin: BASE, "x-equinox-csrf": token, "content-type": "application/json" } : {},
    body: mutate ? "{}" : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const body = await response.json();
  if (!response.ok || body.ok !== true) throw new Error(`Control Center ${route} HTTP ${response.status}: ${String(body.error || "unknown").slice(0, 350)}`);
  return body;
}

// Hosted-runner-only failure evidence. Preserve Control Center's generic HTTP
// 500 response for every real user; never log raw local files or credentials.
function boundedDiagnostic(value) {
  return String(value ?? "unknown")
    .replace(/\b(?:Bearer\s+\S+|github_pat_\w+|gh[pousr]_\w+)\b/giu, "[REDACTED]")
    .replace(/\b(?:token|secret|password|credential|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "[REDACTED]")
    .replace(/\bhttps?:\/\/[^\s]+/giu, "[REDACTED_URL]")
    .replace(/(?:\/Users\/|\/private\/|\/var\/|\/tmp\/)[^\s"'`;,]*/gu, "[REDACTED_PATH]")
    .replace(/[\r\n\x00-\x1f\x7f]+/gu, " ")
    .slice(0, 350);
}

// Disposable hosted-runner-only preload, inherited by a REAL launchd worker.
// It refuses only a verified healthy B observation so that the unmodified
// native worker performs actual restart, durable rollback and A health checks.
async function installTargetHealthFailurePreload({ scratch, targetSha, authPreloadUrl = null }) {
  const hook = path.join(scratch, "native-target-health-failure.mjs");
  const marker = path.join(scratch, "target-health-injection-observed");
  const code = String.raw`import fs from "node:fs/promises";
if (process.argv[1]?.endsWith("/equinox-local-main-update-worker.js")) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (!String(args[0]).endsWith("/api/v1/status") || !response.ok) return response;
    const body = await response.clone().json().catch(() => null);
    if (body?.status?.health?.state !== "HEALTHY" || body?.status?.installation?.sourceSha !== ${JSON.stringify(targetSha)}) return response;
    await fs.appendFile(${JSON.stringify(marker)}, "rejected-healthy-target\n", { mode: 0o600 });
    return new Response(JSON.stringify({ ...body, status: { ...body.status, health: { state: "UNHEALTHY" } } }), {
      status: response.status, headers: { "content-type": "application/json" },
    });
  };
}
`;
  await fs.writeFile(hook, code, { mode: 0o600, flag: "wx" });
  const imports = [authPreloadUrl, pathToFileURL(hook).href].filter(Boolean).map((url) => `--import=${url}`).join(" ");
  await execFile("/bin/launchctl", ["setenv", "NODE_OPTIONS", imports], { timeout: 5_000 });
  return marker;
}

async function printApplyFailureEvidence(transactionRoot) {
  try {
    const result = await jsonApi("/api/v1/update");
    const main = result.update?.main;
    console.error(`[M8 native diagnostic] checkError=${boundedDiagnostic(main?.lastError)} reason=${boundedDiagnostic(main?.reason)} applyError=${boundedDiagnostic(main?.applyError)} applyAvailable=${Boolean(main?.applyAvailable)} state=${boundedDiagnostic(main?.state)} transition=${boundedDiagnostic(main?.targetSha)}`);
  } catch { console.error("[M8 native diagnostic] updater snapshot unavailable"); }
  try {
    const root = path.join(transactionRoot, "receipts");
    const files = (await fs.readdir(root)).filter((name) => /^main-[a-f0-9]{32}\.json$/u.test(name)).slice(-4);
    for (const name of files) {
      const record = JSON.parse((await fs.readFile(path.join(root, name), "utf8")).slice(0, 65536));
      console.error(`[M8 native diagnostic] receipt status=${boundedDiagnostic(record.status)} stage=${boundedDiagnostic(record.stage)} error=${boundedDiagnostic(record.lastError)}`);
    }
  } catch { console.error("[M8 native diagnostic] no readable transaction receipts"); }
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
  assert.ok(["arm64", "x64"].includes(process.arch), "use a native macOS ARM64 or Intel x64 hosted runner");
  const scenario = process.env.M8_ACCEPTANCE_SCENARIO || "positive";
  if (!["positive", "target-health-failure"].includes(scenario)) throw new Error("Unsupported native M8 acceptance scenario.");
  const negative = scenario === "target-health-failure";
  const expectedNativeMode = process.env.M8_EXPECTED_NATIVE_MODE || "reuse_native";
  if (!["reuse_native", "artifact_required"].includes(expectedNativeMode)) throw new Error("Unsupported required M8 native transition mode.");
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
  const nativePointerPath = path.join(transactionRoot, "current-native.json");
  const nativeExecutable = path.join(homeDir, "Applications", "Equinox Local.app", "Contents", "MacOS", "applet");
  const nativeHash = async () => createHash("sha256").update(await fs.readFile(nativeExecutable)).digest("hex");
  const readNativePointer = async () => fs.readFile(nativePointerPath, "utf8").then((content) => JSON.parse(content), (error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const env = { ...process.env, HOME: homeDir };
  // Public GitHub API traffic from shared hosted-runner IPs can be rate-limited
  // (HTTP 403) before an actual Main rollback is exercised. Authenticate ONLY
  // the exact read-only Main discovery requests in this disposable hosted test,
  // leaving the shipped product API, native process and rollback unchanged.
  const githubReadToken = process.env.M8_GITHUB_READ_TOKEN;
  if (typeof githubReadToken !== "string" || githubReadToken.length < 10) {
    throw new Error("Hosted real Main acceptance requires the runner's scoped GitHub read token.");
  }
  const tokenFile = path.join(scratch, "github-discovery-read-token");
  const authHook = path.join(scratch, "github-discovery-read-auth.mjs");
  await fs.writeFile(tokenFile, githubReadToken, { flag: "wx", mode: 0o600 });
  const authCode = String.raw`import fs from "node:fs";
const original = globalThis.fetch;
const token = fs.readFileSync(${JSON.stringify(tokenFile)}, "utf8").trim();
globalThis.fetch = (resource, init = {}) => {
  let url;
  try { url = new URL(typeof resource === "string" ? resource : resource?.url); }
  catch { return original(resource, init); }
  if (url.origin !== "https://api.github.com" ||
      !/^\/repos\/sametbasbug\/equinox-local\/(?:git\/ref\/tags\/main-snapshot|compare\/)/u.test(url.pathname)) {
    return original(resource, init);
  }
  const headers = new Headers(init?.headers ?? resource?.headers ?? {});
  headers.set("authorization", \`Bearer \${token}\`);
  return original(resource, { ...init, headers });
};`;
  await fs.writeFile(authHook, authCode, { flag: "wx", mode: 0o600 });
  const authPreloadUrl = pathToFileURL(authHook).href;
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
  const ownedService = { started: false, transactionId: null, wrapperAlias: false, preload: false };
  const trackedExecFile = async (command, args, options = {}) => {
    if (command === "/bin/launchctl" && args[0] === "bootstrap" && args[1] === `gui/${uid}`) {
      ownedService.started = true;
    }
    return await execFile(command, args, options);
  };
  try {
    await execFile("/bin/launchctl", ["setenv", "NODE_OPTIONS", `--import=${authPreloadUrl}`], { timeout: 5_000 });
    ownedService.preload = true;
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
      allowExistingStableToMainMigration: true,
      stagedReleaseDir: release, homeDir, env, uid,
      execFileImpl: trackedExecFile,
      waitForVersionImpl: async () => { ownedService.started = true; await awaitHealthy(null, { kind: "managed" }); return true; },
      waitForManagedSourceImpl: async (_version, sha) => { await awaitHealthy(sha); return true; },
    });
    ownedService.started = true;
    assert.equal(result.managedSourceSha, previousSha);
    const before = await awaitHealthy(previousSha);
    const beforeNativeSha256 = await nativeHash();
    const beforeNativePointer = await readNativePointer();
    if (expectedNativeMode === "artifact_required") {
      // The initial real A package is native Stable with admitted Main source;
      // no previous Main native artifact has yet been installed.
      assert.equal(beforeNativePointer, null, "unexpected pre-existing Main native artifact pointer");
    }
    assert.equal(before.installation?.kind, "managed-source");
    const toolchain = equinoxLocalToolchainContract({ runtimeRoot: path.join(installRoot, "runtime"), target: equinoxLocalUpdateTarget() });
    const getPointer = () => readEquinoxLocalMainSourcePointer(path.join(transactionRoot, "current-source.conf"), { gitPath: toolchain.gitPath });
    assert.equal((await getPointer()).sha, previousSha);
    const { csrfToken } = await jsonApi("/api/v1/session");
    await jsonApi("/api/v1/update/check", { mutate: true, token: csrfToken });
    const discovery = await jsonApi("/api/v1/update");
    if (discovery.update?.main?.targetSha !== targetSha || discovery.update?.main?.applyAvailable !== true) {
      await printApplyFailureEvidence(transactionRoot);
    }
    assert.equal(discovery.update?.main?.targetSha, targetSha, "the separately admitted Main snapshot must be the exact target");
    assert.equal(discovery.update?.main?.applyAvailable, true);
    let injectionMarker = null;
    if (negative) {
      injectionMarker = await installTargetHealthFailurePreload({ scratch, targetSha, authPreloadUrl });
      ownedService.preload = true;
    }
    let response;
    try {
      response = await jsonApi("/api/v1/update/apply", { mutate: true, token: csrfToken, timeoutMs: 180_000 });
    } catch (error) {
      await printApplyFailureEvidence(transactionRoot);
      throw error;
    }
    assert.equal(response.result?.targetSha, targetSha);
    assert.equal(response.result?.nativeTransition?.mode, expectedNativeMode, "the real updater must require the selected native transition mode");
    const transactionId = response.result.transactionId;
    assert.match(transactionId, /^main-[a-f0-9]{32}$/u);
    ownedService.transactionId = transactionId;
    const receiptPath = path.join(transactionRoot, "receipts", `${transactionId}.json`);
    const receipt = await poll(async () => {
      const data = JSON.parse(await fs.readFile(receiptPath, "utf8"));
      if (["failed", "rollback_failed"].includes(data.status)
        || (negative && data.status === "succeeded")
        || (!negative && data.status === "rolled_back")) {
        const terminal = new Error(`Unexpected native Main result: ${data.status}: ${String(data.lastError || "no error").slice(0, 250)}`);
        terminal.smokeTerminal = true;
        throw terminal;
      }
      return data.status === (negative ? "rolled_back" : "succeeded") ? data : null;
    }, "detached native Main updater completion", 240_000);
    assert.equal(receipt.targetSha, targetSha);
    if (negative) {
      assert.equal(receipt.rollbackSha, previousSha);
      assert.equal((await getPointer()).sha, previousSha);
      const observations = await fs.readFile(injectionMarker, "utf8");
      assert.match(observations, /rejected-healthy-target/u,
        "the real B must become healthy before the hosted-only observation fault triggers");
      const rollback = await awaitHealthy(previousSha, { timeoutMs: 60_000 });
      assert.equal(rollback.installation?.kind, "managed-source");
      const recoveredNativeSha256 = await nativeHash();
      assert.equal(recoveredNativeSha256, beforeNativeSha256,
        "real macOS native app binary must be restored byte-for-byte on rollback");
      const rollbackNativePointer = await readNativePointer();
      assert.deepEqual(rollbackNativePointer, beforeNativePointer, "Main native artifact pointer must return to its exact original state");
      assert.equal((await fs.lstat(path.join(installRoot, "current"))).isSymbolicLink(), true);
      process.stdout.write(`${JSON.stringify({ ok: true, scenario, platform: process.platform, arch: process.arch, from: previousSha, refusedTarget: targetSha, rollbackSha: receipt.rollbackSha, nativeMode: expectedNativeMode, nativeBinaryRestored: recoveredNativeSha256 === beforeNativeSha256, nativePointerRestored: true, restartHealth: rollback.health?.state, receipt: receipt.status, injectedObservations: observations.trim().split("\n").length })}\n`);
    } else {
      assert.equal((await getPointer()).sha, targetSha);
      const after = await awaitHealthy(targetSha, { timeoutMs: 60_000 });
      assert.equal(after.installation?.kind, "managed-source");
      const afterNativeSha256 = await nativeHash();
      const afterNativePointer = await readNativePointer();
      if (expectedNativeMode === "artifact_required") {
        assert.notEqual(afterNativeSha256, beforeNativeSha256, "real native app binary must change on artifact_required");
        assert.equal(afterNativePointer?.channel, "main");
        assert.equal(afterNativePointer?.sourceSha, targetSha, "native artifact pointer must be exact admitted B");
        assert.equal(afterNativePointer?.target, equinoxLocalUpdateTarget());
        assert.match(afterNativePointer?.runtimeContractSha256 ?? "", /^[a-f0-9]{64}$/u);
      } else {
        assert.equal(afterNativeSha256, beforeNativeSha256, "native app must be reused for reuse_native");
        assert.deepEqual(afterNativePointer, beforeNativePointer);
      }
      assert.equal((await fs.lstat(path.join(installRoot, "current"))).isSymbolicLink(), true);
      process.stdout.write(`${JSON.stringify({ ok: true, scenario, platform: process.platform, arch: process.arch, from: previousSha, to: targetSha, nativeMode: response.result.nativeTransition?.mode, nativeBinaryChanged: afterNativeSha256 !== beforeNativeSha256, nativePointerSha: afterNativePointer?.sourceSha ?? null, restartHealth: after.health?.state, receipt: receipt.status })}\n`);
    }
  } finally {
    if (ownedService.preload) await execFile("/bin/launchctl", ["unsetenv", "NODE_OPTIONS"], { timeout: 5_000 }).catch(() => {});
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
