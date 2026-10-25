// Hosted Windows x64/ARM64-only, genuine public-installer -> native shell ->
// Control Center -> detached Main update acceptance. The public installer PS1
// owns machine state and cleanup. Never execute on someone's Windows PC.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readEquinoxLocalMainSourcePointer } from "../../src/equinox-local-main-source-pointer.js";
import { validateEquinoxLocalWindowsNativeTransitionJournal } from "../../src/equinox-local-windows-native-transition-journal.js";

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

// This is the existing genuine installed-host lane, not an artificial socket
// witness. A terminal Main receipt by itself does not prove the original
// signed Guardian actually stopped WPF A/B or retired its kernel OS lease.
async function readOriginalNativeProof(file) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const st = await handle.stat();
    const linked = await fs.lstat(file);
    assert.ok(st.isFile() && st.nlink === 1 && st.size >= 2 && st.size <= 8192 &&
      linked.isFile() && !linked.isSymbolicLink() && linked.dev === st.dev && linked.ino === st.ino,
      "native Guardian OS receipt must be one bounded original normal file");
    const bytes = await handle.readFile();
    assert.equal(bytes.length, st.size, "native Guardian OS receipt changed during read");
    return JSON.parse(bytes.toString("utf8"));
  } finally { await handle.close(); }
}

function assertOriginalExitReceipt(proof, kind, id, firstWpfPid = null) {
  const a = ["schemaVersion","transactionId","disposition","shellPid","shellStartTimeUtcTicks",
    "workerPid","workerStartTimeUtcTicks","guardianPid","preparedJournalSha256"];
  const b = ["schemaVersion","transactionId","disposition","stage","sequence","shellPid",
    "shellStartTimeUtcTicks","workerPid","workerStartTimeUtcTicks","guardianPid",
    "rollbackJournalSha256","handoffSha256"];
  assert.deepEqual(Object.keys(proof).sort(), (kind === "A" ? a : b).sort(), "original Guardian receipt schema differs");
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.transactionId, id);
  assert.equal(proof.disposition, kind === "A" ? "stable-shell-quiesced-only" : "b-shell-quiesced-only");
  for (const value of [proof.shellPid,proof.workerPid,proof.guardianPid])
    assert.ok(Number.isSafeInteger(value) && value > 0, "original signed OS process ID missing");
  for (const value of [proof.shellStartTimeUtcTicks,proof.workerStartTimeUtcTicks])
    assert.match(value, /^[0-9]{1,19}$/u, "original signed OS process birth missing");
  assert.match(kind === "A" ? proof.preparedJournalSha256 : proof.rollbackJournalSha256, /^[a-f0-9]{64}$/u);
  if (kind === "A") assert.equal(proof.shellPid, firstWpfPid, "signed Guardian did not stop the initially installed original A WPF");
  else {
    assert.equal(proof.stage, "rollback_started");
    assert.ok(Number.isSafeInteger(proof.sequence) && proof.sequence >= 3 && proof.sequence <= 6,
      "bad B original signed Guardian shutdown was not after physical A/B switch");
    assert.match(proof.handoffSha256, /^[a-f0-9]{64}$/u);
    assert.notEqual(proof.shellPid, firstWpfPid, "bad B shutdown reused the original A WPF process");
  }
}

export async function verifyOriginalSignedWindowsGuardianTerminal({transactionRoot,id,a,b,target,negative,firstWpfPid}) {
  assert.match(id, TRANSACTION);
  assert.ok(Number.isSafeInteger(firstWpfPid) && firstWpfPid > 0);
  const root = path.join(transactionRoot,"guardian-journal");
  const journal = validateEquinoxLocalWindowsNativeTransitionJournal(
    await readOriginalNativeProof(path.join(root,`${id}.json`)),
    {transactionId:id,target,currentSha:a,targetSha:b});
  assert.equal(journal.stage, negative ? "rolled_back" : "committed",
    "real installed Main terminal receipt lacks an original signed Guardian A/B terminal journal");
  if (negative) assert.ok(journal.sequence >= 4 && journal.sequence <= 9);
  else assert.equal(journal.sequence, 6);
  const oldExit = await readOriginalNativeProof(path.join(root,`${id}.stable-shell-quiesce.json`));
  assertOriginalExitReceipt(oldExit,"A",id,firstWpfPid);
  if (negative) {
    const bExit = await readOriginalNativeProof(path.join(root,`${id}.b-shell-quiesce.json`));
    assertOriginalExitReceipt(bExit,"B",id,firstWpfPid);
    assert.equal(bExit.guardianPid,oldExit.guardianPid,"rollback was not owned by the original signed Guardian");
    assert.equal(bExit.workerPid,oldExit.workerPid,"rollback was not owned by the original detached worker");
    assert.equal(bExit.workerStartTimeUtcTicks,oldExit.workerStartTimeUtcTicks,
      "rollback worker birth differs from original signed A exit");
  }
  // Guardian retains the signed prepared authority as immutable audit evidence.
  // Only its original OS lease and worker handoff are retired by exact handle.
  const authority = await readOriginalNativeProof(path.join(root,`${id}.native-authority.json`));
  assert.deepEqual(Object.keys(authority).sort(), ["schemaVersion","transactionId","stage","sequence",
    "workerPid","workerStartTimeUtcTicks","guardianPid","journalSha256","handoffSha256"].sort());
  assert.equal(authority.schemaVersion,1);
  assert.equal(authority.transactionId,id);
  assert.equal(authority.stage,"prepared");
  assert.equal(authority.sequence,0);
  assert.equal(authority.guardianPid,oldExit.guardianPid);
  assert.equal(authority.workerPid,oldExit.workerPid);
  assert.equal(authority.workerStartTimeUtcTicks,oldExit.workerStartTimeUtcTicks);
  for (const key of ["journalSha256","handoffSha256"]) assert.match(authority[key],/^[a-f0-9]{64}$/u);
  const retired = [path.join(root,`.${id}.guardian-session-lock`),
    path.join(transactionRoot,"handoff",`${id}.windows-worker.json`),
    path.join(transactionRoot,"active.json")];
  await poll(async () => {
    for (const file of retired) {
      try { await fs.lstat(file); return false; }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    return true;
  }, "original signed Guardian OS terminal lease/authority/worker retirement", 15_000);
  return journal;
}

async function main() {
  if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)
    || process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP) {
    throw new Error("Real installed Windows Main acceptance requires a disposable native GitHub-hosted Windows runner.");
  }
  const [installRoot, a, b, initialPidText] = process.argv.slice(2);
  const firstWpfPid = Number(initialPidText);
  if (!path.isAbsolute(installRoot ?? "") || !SHA.test(a ?? "") || !SHA.test(b ?? "") || a === b || !Number.isSafeInteger(firstWpfPid) || firstWpfPid < 1) {
    throw new Error("Usage: smoke-main-upgrade-windows.mjs <real-installed-Windows-root> <admitted-A-SHA> <admitted-B-SHA> <original-A-WPF-PID>");
  }
  const scenario = process.env.EQUINOX_WINDOWS_MAIN_ACCEPT_SCENARIO || "positive";
  if (!["positive", "target-crash"].includes(scenario)) throw new Error("Unsupported Windows native acceptance scenario.");
  const negative = scenario === "target-crash";
  const target = `win32-${process.arch}`;
  const transactionRoot = path.join(installRoot, "state", "main-update");
  const ownedGit = path.join(installRoot, "runtime", "toolchain", "git", "2.56.0-1", target, "cmd", "git.exe");
  const pointerPath = path.join(transactionRoot, "current-source.conf");
  const pointer = () => readEquinoxLocalMainSourcePointer(pointerPath, { gitPath: ownedGit });
  const ownedRelease = JSON.parse(await fs.readFile(path.join(installRoot, "current-version.json"), "utf8"));
  assert.match(ownedRelease.version, /^\d+\.\d+\.\d+$/u);
  const nativeNode = path.join(installRoot, "releases", ownedRelease.version, "runtime", "node", "bin", "node.exe");
  assert.equal((await fs.stat(nativeNode)).isFile(), true, "owned native release Node is missing");
  // The old A runtime uses its numbered release, but after promotion B runs
  // the freshly installed native-store Node. The crash fixture must select
  // only that B executable; targeting A cannot exercise rollback at all.
  const targetNativeNode = path.join(transactionRoot, "native-store", target, b, "release", "runtime", "node", "bin", "node.exe");
  let watchdog = null;
  let fault = null;
  assert.equal((await pointer()).sha, a, "installed pinned A pointer must match actual admitted A");
  await healthy(a);
  const { csrfToken } = await api("/api/v1/session");
  assert.ok(typeof csrfToken === "string" && csrfToken.length > 20, "real Control Center must provide valid CSRF token");
  await api("/api/v1/update/check", { csrfToken });
  const checked = await api("/api/v1/update");
  if (checked.update?.main?.targetSha !== b) {
    const update = checked.update?.main ?? {};
    const safe = (value) => String(value ?? "").replace(/https?:\/\/[^\s]+/gu, "[URL]")
      .replace(/(?:token|secret|password|credential|key)\s*[:=]\s*[^\s,;]+/giu, "[REDACTED]").slice(0, 180);
    console.error(JSON.stringify({ hostedOldMainDiscovery: {
      state: safe(update.state), reason: safe(update.reason), lastError: safe(update.lastError),
      applyAvailable: Boolean(update.applyAvailable), currentSha: update.currentSha === a,
    }}));
  }
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
        "-PointerPath", pointerPath, "-TargetSha", b, "-OwnedNodePath", targetNativeNode,
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
  assert.equal(applied.result.nativeTransition?.mode, "artifact_required",
    "installed A→B native shell test cannot pass as source-only/reused-native");
  await verifyOriginalSignedWindowsGuardianTerminal({
    transactionRoot,id,a,b,target,negative,firstWpfPid,
  });
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error?.stack ?? String(error)); process.exitCode = 1; });
}
