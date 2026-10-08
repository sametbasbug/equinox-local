// Hosted Windows x64/ARM64-only, genuine public-installer -> native shell ->
// Control Center -> detached Main update acceptance. The public installer PS1
// owns machine state and cleanup. Never execute on someone's Windows PC.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import { readEquinoxLocalMainSourcePointer } from "../../src/equinox-local-main-source-pointer.js";

const BASE = "http://127.0.0.1:24891";
const SHA = /^[a-f0-9]{40}$/u;
const TRANSACTION = /^main-[a-f0-9]{32}$/u;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(fn, label, timeout = 210_000) {
  const since = Date.now();
  let last = "not yet observed";
  while (Date.now() - since < timeout) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (error) {
      if (error?.terminal === true) throw error;
      last = String(error?.message ?? error).slice(0, 240);
    }
    await wait(750);
  }
  throw new Error(`${label} timeout: ${last}`);
}

async function api(route, { csrfToken = null, timeoutMs = 15_000 } = {}) {
  const write = csrfToken !== null;
  const response = await fetch(`${BASE}${route}`, {
    method: write ? "POST" : "GET", cache: "no-store",
    headers: write ? { origin: BASE, "x-equinox-csrf": csrfToken, "content-type": "application/json" } : {},
    body: write ? "{}" : undefined, signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (!response.ok || body.ok !== true) throw new Error(`Installed Control Center ${route} returned HTTP ${response.status}`);
  return body;
}

async function healthy(sha) {
  return await poll(async () => {
    const { status } = await api("/api/v1/status");
    return status?.health?.state === "HEALTHY"
      && status?.installation?.kind === "managed-source"
      && status?.installation?.sourceSha === sha ? status : null;
  }, `real installed Windows source ${sha} HEALTHY`, 90_000);
}

async function main() {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)
    || process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) {
    throw new Error("Real installed Windows Main acceptance requires a disposable native GitHub-hosted Windows runner.");
  }
  const [installRoot, a, b] = process.argv.slice(2);
  if (!path.isAbsolute(installRoot ?? "") || !SHA.test(a ?? "") || !SHA.test(b ?? "") || a === b) {
    throw new Error("Usage: smoke-main-upgrade-windows.mjs <real-installed-Windows-root> <admitted-A-SHA> <admitted-B-SHA>");
  }
  const scenario = process.env.EQUINOX_WINDOWS_MAIN_ACCEPT_SCENARIO || "positive";
  if (!["positive", "target-crash"].includes(scenario)) throw new Error("Unsupported Windows native acceptance scenario.");
  const negative = scenario === "target-crash";
  const target = `win32-${process.arch}`;
  const transactionRoot = path.join(installRoot, "state", "main-update");
  const ownedGit = path.join(installRoot, "runtime", "toolchain", "git", "2.53.0-4", target, "cmd", "git.exe");
  const pointerPath = path.join(transactionRoot, "current-source.conf");
  const pointer = () => readEquinoxLocalMainSourcePointer(pointerPath, { gitPath: ownedGit });
  const ownedRelease = JSON.parse(await fs.readFile(path.join(installRoot, "current-version.json"), "utf8"));
  assert.match(ownedRelease.version, /^\d+\.\d+\.\d+$/u);
  const nativeNode = path.join(installRoot, "releases", ownedRelease.version, "runtime", "node", "bin", "node.exe");
  assert.equal((await fs.stat(nativeNode)).isFile(), true, "owned native release Node is missing");
  let watchdog = null;
  let fault = null;
  assert.equal((await pointer()).sha, a, "installed pinned A pointer must match actual admitted A");
  await healthy(a);
  const { csrfToken } = await api("/api/v1/session");
  assert.ok(typeof csrfToken === "string" && csrfToken.length > 20, "real Control Center must provide valid CSRF token");
  await api("/api/v1/update/check", { csrfToken });
  const checked = await api("/api/v1/update");
  assert.equal(checked.update?.main?.targetSha, b, "exact separately admitted snapshot B must be offered");
  assert.equal(checked.update?.main?.applyAvailable, true);
  let applied;
  try {
    if (negative) {
      const directory = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, "equinox-windows-m8-crash-"));
      const args = {
        marker: path.join(directory, "b-runtime-crashes.txt"),
        ready: path.join(directory, "watchdog-ready.txt"),
        stop: path.join(directory, "watchdog-stop.txt"),
      };
      const watchdogScript = path.join(import.meta.dirname, "smoke-main-upgrade-windows-fault.ps1");
      watchdog = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", watchdogScript,
        "-PointerPath", pointerPath, "-TargetSha", b, "-OwnedNodePath", nativeNode,
        "-MarkerPath", args.marker, "-ReadyPath", args.ready, "-StopPath", args.stop],
      { cwd: directory, windowsHide: true, stdio: "ignore" });
      fault = { directory, ...args };
      await poll(async () => {
        await fs.access(args.ready);
        return true;
      }, "Windows native target-crash watchdog startup", 8_000);
    }
    // Native Windows staging runs pinned npm and prebuilt validation before
    // the detached worker is scheduled; do not abort legitimate work at 15s.
    applied = await api("/api/v1/update/apply", { csrfToken, timeoutMs: 180_000 });
  } catch (error) {
    const diagnostic = await api("/api/v1/update").catch(() => null);
    const message = String(diagnostic?.update?.main?.applyError ?? "none");
    console.error(`Hosted Windows Main apply diagnostic: ${message.replace(/[\r\n\x00-\x1f]+/gu, " ").replace(/(?:token|password|secret)\s*[:=]\s*\S+/giu, "[REDACTED]").slice(0, 230)}`);
    if (fault) await fs.writeFile(fault.stop, "stop").catch(() => {});
    if (watchdog) watchdog.kill();
    if (fault) await fs.rm(fault.directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  try {
    assert.equal(applied.result?.targetSha, b);
  const id = applied.result.transactionId;
  assert.match(id, TRANSACTION);
  const receiptFile = path.join(transactionRoot, "receipts", `${id}.json`);
  const receipt = await poll(async () => {
    const record = JSON.parse(await fs.readFile(receiptFile, "utf8"));
    if (["failed", "rollback_failed"].includes(record.status)
      || (negative && record.status === "succeeded")
      || (!negative && record.status === "rolled_back")) {
      const error = new Error(`Unexpected native Main receipt: ${record.status}; stage=${record.stage}; ${String(record.lastError ?? "").slice(0, 200)}`);
      error.terminal = true;
      throw error;
    }
    return record.status === (negative ? "rolled_back" : "succeeded") ? record : null;
  }, "native Windows detached update worker receipt", 240_000);
  assert.equal(receipt.targetSha, b);
  if (negative) {
    assert.equal(receipt.rollbackSha, a);
    assert.equal((await pointer()).sha, a);
    const stoppedB = await fs.readFile(fault.marker, "utf8");
    assert.match(stoppedB, /killed-b-server:\d+/u,
      "the test must actually kill an owned native B server; an unrelated failure cannot pass");
    const recovered = await healthy(a);
    console.log(JSON.stringify({ ok: true, scenario, target, from: a, refusedTarget: b,
      rollbackSha: receipt.rollbackSha, nativeMode: applied.result.nativeTransition?.mode,
      receipt: receipt.status, restartedHealth: recovered.health.state,
      killedBServers: stoppedB.trim().split("\n").length }));
  } else {
    assert.equal((await pointer()).sha, b);
    const statusB = await healthy(b);
    assert.equal(statusB.installation?.kind, "managed-source");
    console.log(JSON.stringify({ ok: true, scenario, target, from: a, to: b,
      nativeMode: applied.result.nativeTransition?.mode, receipt: receipt.status,
      restartedHealth: statusB.health.state }));
  }
  } finally {
    if (fault) await fs.writeFile(fault.stop, "stop").catch(() => {});
    if (watchdog) watchdog.kill();
    if (fault) await fs.rm(fault.directory, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
