// Hosted Windows x64/ARM64-only, genuine public-installer -> native shell ->
// Control Center -> detached Main update acceptance. The public installer PS1
// owns machine state and cleanup. Never execute on someone's Windows PC.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

async function api(route, { csrfToken = null } = {}) {
  const write = csrfToken !== null;
  const response = await fetch(`${BASE}${route}`, {
    method: write ? "POST" : "GET", cache: "no-store",
    headers: write ? { origin: BASE, "x-equinox-csrf": csrfToken, "content-type": "application/json" } : {},
    body: write ? "{}" : undefined, signal: AbortSignal.timeout(15_000),
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
  const target = `win32-${process.arch}`;
  const transactionRoot = path.join(installRoot, "state", "main-update");
  const ownedGit = path.join(installRoot, "runtime", "toolchain", "git", "2.53.0-4", target, "cmd", "git.exe");
  const pointerPath = path.join(transactionRoot, "current-source.conf");
  const pointer = () => readEquinoxLocalMainSourcePointer(pointerPath, { gitPath: ownedGit });
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
    applied = await api("/api/v1/update/apply", { csrfToken });
  } catch (error) {
    const diagnostic = await api("/api/v1/update").catch(() => null);
    const message = String(diagnostic?.update?.main?.applyError ?? "none");
    console.error(`Hosted Windows Main apply diagnostic: ${message.replace(/[\r\n\x00-\x1f]+/gu, " ").replace(/(?:token|password|secret)\s*[:=]\s*\S+/giu, "[REDACTED]").slice(0, 230)}`);
    throw error;
  }
  assert.equal(applied.result?.targetSha, b);
  const id = applied.result.transactionId;
  assert.match(id, TRANSACTION);
  const receiptFile = path.join(transactionRoot, "receipts", `${id}.json`);
  const receipt = await poll(async () => {
    const record = JSON.parse(await fs.readFile(receiptFile, "utf8"));
    if (["failed", "rollback_failed", "rolled_back"].includes(record.status)) {
      const error = new Error(`Real Windows Main updater did not reach B: ${record.status}; stage=${record.stage}; ${String(record.lastError ?? "").slice(0, 200)}`);
      error.terminal = true;
      throw error;
    }
    return record.status === "succeeded" ? record : null;
  }, "native Windows detached update worker receipt", 240_000);
  assert.equal(receipt.targetSha, b);
  assert.equal((await pointer()).sha, b);
  const statusB = await healthy(b);
  assert.equal(statusB.installation?.kind, "managed-source");
  console.log(JSON.stringify({ ok: true, scenario: "positive", target, from: a, to: b,
    nativeMode: applied.result.nativeTransition?.mode, receipt: receipt.status,
    restartedHealth: statusB.health.state }));
}

main().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
