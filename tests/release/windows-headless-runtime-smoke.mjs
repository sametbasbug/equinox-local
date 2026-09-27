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
import { createAgentControlController } from "../../src/equinox-local-agent-control.js";
import { createProcessManager } from "../../src/process-manager.js";
import { createTerminalManager } from "../../src/terminal-manager.js";
import { createEquinoxLocalRuntime } from "../../src/server.js";
import { createEquinoxBrowserNativeHostRuntime } from "../../src/equinox-browser-native-host-runtime.js";
import { equinoxBrowserIpcEndpoint } from "../../src/equinox-browser-socket.js";
import { EQUINOX_BROWSER_EXTENSION_ID } from "../../src/equinox-browser-bridge.js";
import {
  createEquinoxAgentBrowser,
  discoverWindowsChrome,
  parseWindowsAgentBrowserMainPids,
} from "../../src/equinox-agent-browser.js";

const execFile = promisify(execFileCallback);

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`Windows headless smoke requires win32-x64; got ${process.platform}-${process.arch}.`);
}

function encodeNativeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
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

async function verifyWindowsAgentBrowserLifecycle(root) {
  const profileRoot = path.join(root, "Agent Browser Profile Ü");
  await fs.mkdir(profileRoot, { recursive: true });
  await fs.writeFile(path.join(profileRoot, ".equinox-agent-browser-ready"), "ready\n", { flag: "wx" });

  let agentReady = false;
  let pairing = null;
  const bridge = {
    readyFor(context) { assert.equal(context, "agent"); return agentReady; },
    expectContext(context) { assert.equal(context, "agent"); pairing = { context: "agent" }; return pairing; },
    cancelExpectedContext() { const previous = pairing; pairing = null; return previous; },
    async waitUntilReady() { throw new Error("Native Messaging registry is intentionally deferred until the next W4 checkpoint"); },
    snapshotContext(context) { assert.equal(context, "agent"); return { context: "agent", ready: agentReady, connectedAt: null, extension: null }; },
    snapshot() { return { pairing }; },
  };

  const manager = createEquinoxAgentBrowser({
    bridge,
    homeDir: process.env.USERPROFILE,
    profileRoot,
    platform: "win32",
    env: process.env,
    execFileAsync: execFile,
  });
  const chromePath = await discoverWindowsChrome({ env: process.env });
  const launched = await manager.launch({ setup: false });
  assert.equal(launched.supported, true);
  assert.equal(launched.isolated, true);
  assert.equal(launched.lastLaunchSetup, false);
  assert.equal(path.win32.normalize(launched.chromePath).toLowerCase(), path.win32.normalize(chromePath).toLowerCase());

  const processQuery = "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  let lastInventory = "";
  let lastDiagnostics = [];
  const processId = await waitFor(async () => {
    const { stdout = "" } = await execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", processQuery], { timeout: 5_000, windowsHide: true });
    lastInventory = stdout;
    let decoded = [];
    try {
      const raw = stdout.trim() ? JSON.parse(stdout) : [];
      decoded = Array.isArray(raw) ? raw : [raw];
    } catch {}
    const normalizedChrome = path.win32.normalize(chromePath).toLowerCase();
    const normalizedProfile = path.win32.normalize(profileRoot).toLowerCase();
    lastDiagnostics = decoded.filter((row) => row && typeof row === "object").map((row) => {
      const executable = typeof row.ExecutablePath === "string" ? path.win32.normalize(row.ExecutablePath).toLowerCase() : "";
      const command = String(row.CommandLine || "").toLowerCase();
      const profileIndex = command.indexOf("--user-data-dir");
      return {
        pid: Number(row.ProcessId) || null,
        executableMatch: executable === normalizedChrome,
        hasUserDataDir: profileIndex >= 0,
        hasProfileText: command.includes(normalizedProfile),
        hasTypeFlag: /(?:^|\s)--type=/u.test(command.replaceAll('"', "")),
        userDataDirFragment: profileIndex >= 0 ? command.slice(profileIndex, profileIndex + 220) : null,
      };
    });
    const pids = parseWindowsAgentBrowserMainPids(stdout, profileRoot, chromePath);
    return pids.length === 1 ? pids[0] : null;
  }, `Windows Agent Browser exact isolated Chrome main process did not appear; inventory=${JSON.stringify(lastDiagnostics)}`, 10_000).catch((error) => {
    process.stdout.write(`[windows-agent-browser] diagnostics ${JSON.stringify(lastDiagnostics)}\n`);
    throw error;
  });
  assert.equal(pidExists(processId), true);

  const stopped = await manager.shutdown({ timeoutMs: 8_000 });
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.alreadyStopped, false);
  assert.equal(stopped.processId, processId);
  await waitFor(() => !pidExists(processId), "Windows Agent Browser main process survived bounded shutdown", 8_000);
  return Object.freeze({ chromePath, processId, isolatedProfile: true, stopped: true });
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

async function verifyWindowsJobObjectHelperLoss(root) {
  const gatePath = path.join(root, "helper loss gate.txt");
  const childPidPath = path.join(root, "helper loss child pid.txt");
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
  const lease = await createWindowsJobObjectLease();
  let childPid = null;
  try {
    assert.ok(Number.isInteger(lease.helperPid) && lease.helperPid > 0, "Windows Job Object helper PID is missing");
    await lease.assign(parent.pid);
    await fs.writeFile(gatePath, "go", { flag: "wx" });
    childPid = await waitFor(async () => {
      const text = await fs.readFile(childPidPath, "utf8").catch(() => "");
      const value = Number.parseInt(text.trim(), 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    }, "Windows helper-loss fixture did not create a descendant");
    const status = await lease.status();
    assert.ok(status.activeProcesses >= 2, "helper-loss Job Object did not contain parent + descendant");

    process.kill(lease.helperPid);
    await waitFor(() => !pidExists(lease.helperPid), "Windows Job Object helper did not exit after forced loss");
    await waitFor(() => !pidExists(parent.pid) && !pidExists(childPid), "KILL_ON_JOB_CLOSE did not drain parent + descendant after helper loss");
    await assert.rejects(() => lease.status(), /not available|exited unexpectedly/u);
    return Object.freeze({ helperLossDrainedOwnedTree: true });
  } finally {
    await lease.close().catch(() => {});
    if (pidExists(parent.pid)) parent.kill();
    if (Number.isInteger(childPid) && pidExists(childPid)) {
      try { process.kill(childPid); } catch {}
    }
  }
}

async function verifyWindowsManagedProcessLifecycle(root) {
  const manager = createProcessManager({ platform: "win32", arch: "x64", groupPollMs: 50 });
  const descendantScript = [
    "$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden",
    "Write-Output ('DESCENDANT=' + $child.Id)",
  ].join("; ");
  const started = await manager.start({
    projectId: "windows-smoke",
    projectName: "Windows Smoke",
    cwd: root,
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", descendantScript],
    purpose: "background",
    env: process.env,
    label: "windows-job-descendant",
  });
  const logs = await manager.readLogs({ processId: started.processId, cursor: 0, waitMs: 3_000 });
  const match = logs.output.match(/DESCENDANT=(\d+)/u);
  assert.ok(match, `managed Windows process did not report descendant PID: ${logs.output}`);
  const descendantPid = Number.parseInt(match[1], 10);
  await waitFor(() => !pidExists(started.pid), "Windows managed gate leader did not exit after user command completed");
  const retained = await manager.waitForExit({ processId: started.processId, waitMs: 250 });
  assert.equal(retained.running, true, "process manager finalized while a Job Object descendant was still alive");
  assert.equal(pidExists(descendantPid), true, "managed descendant disappeared before stop");
  const stopped = await manager.stop({ processId: started.processId, timeoutMs: 2_500 });
  assert.equal(stopped.running, false, "Windows managed process did not finalize after Job Object stop");
  await waitFor(() => !pidExists(descendantPid), "Windows managed process stop did not drain the descendant");

  const natural = await manager.start({
    projectId: "windows-smoke",
    projectName: "Windows Smoke",
    cwd: root,
    command: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output 'NATURAL_OK'"],
    purpose: "terminal_exec",
    env: process.env,
    label: "windows-natural-exit",
  });
  const naturalExit = await manager.waitForExit({ processId: natural.processId, waitMs: 5_000 });
  assert.equal(naturalExit.running, false, "Windows managed natural exit did not finalize");
  const naturalLogs = await manager.readLogs({ processId: natural.processId, cursor: 0 });
  assert.match(naturalLogs.output, /NATURAL_OK/u);
  await manager.shutdown();
  return Object.freeze({ waitTimeoutPreservedOwnedTree: true, descendantRetainedAfterLeaderExit: true, stopDrainedDescendant: true, naturalExit: true });
}

async function withWindowsConPtyStage(label, operation, timeoutMs = 12_000) {
  const startedAt = Date.now();
  process.stdout.write(`[windows-conpty] START ${label}\n`);
  let timer = null;
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Windows ConPTY stage timed out: ${label} after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    process.stdout.write(`[windows-conpty] PASS ${label} ${Date.now() - startedAt}ms\n`);
    return result;
  } catch (error) {
    process.stderr.write(`[windows-conpty] FAIL ${label} ${Date.now() - startedAt}ms: ${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readTerminalUntil(manager, sessionId, pattern, timeoutMs = 8_000) {
  let cursor = 0;
  let combined = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await manager.read({ sessionId, cursor, maxChars: 40_000, stripAnsiCodes: true, waitMs: 500 });
    cursor = chunk.nextCursor;
    combined += chunk.output;
    if (pattern.test(combined)) return combined;
    if (!chunk.session.running && !chunk.output) break;
  }
  throw new Error(`Windows ConPTY output did not match ${pattern}: ${combined}`);
}

async function verifyWindowsConPtyLifecycle(root) {
  const manager = createTerminalManager({ platform: "win32", arch: "x64" });
  const stopPidPath = path.join(root, "conpty stop child pid.txt");
  const naturalPidPath = path.join(root, "conpty natural child pid.txt");
  let stopChildPid = null;
  let naturalChildPid = null;
  const watchdog = setTimeout(() => {
    process.stderr.write("[windows-conpty] FATAL lifecycle watchdog exceeded 70s\n");
    process.exit(124);
  }, 70_000);
  try {
    const started = await withWindowsConPtyStage("explicit:start", () => manager.start({
      projectId: "windows-smoke",
      projectName: "Windows Smoke",
      cwd: root,
      shell: "powershell.exe",
      shellArgs: ["-NoLogo", "-NoProfile"],
      env: { ...process.env, EQUINOX_PTY_CHILD_PID: stopPidPath },
      cols: 100,
      rows: 28,
      label: "windows-conpty-stop",
    }));
    assert.equal(started.running, true, "Windows ConPTY did not start");
    assert.ok(Number.isInteger(started.pid) && started.pid > 0, "Windows ConPTY gate PID is missing");

    const startupOutput = await withWindowsConPtyStage("explicit:startup-buffer", () => manager.read({
      sessionId: started.sessionId, cursor: 0, maxChars: 20_000, stripAnsiCodes: true, waitMs: 0,
    }), 4_000);
    assert.doesNotMatch(startupOutput.output, /__EQUINOX_INNER_PTY_READY__/u, "internal ConPTY readiness marker leaked to terminal output");

    manager.write({ sessionId: started.sessionId, data: "Write-Output ([string]::Concat('__EQUINOX_','CONPTY_OK__'))", key: "enter" });
    await withWindowsConPtyStage("explicit:interactive-io", () => readTerminalUntil(manager, started.sessionId, /__EQUINOX_CONPTY_OK__/u), 10_000);

    await withWindowsConPtyStage("explicit:resize", async () => {
      const resized = manager.resize({ sessionId: started.sessionId, cols: 137, rows: 41 });
      assert.equal(resized.cols, 137);
      assert.equal(resized.rows, 41);
    }, 4_000);

    const childCommand = [
      "$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden",
      "[IO.File]::WriteAllText($env:EQUINOX_PTY_CHILD_PID, [string]$child.Id)",
      "Write-Output '__EQUINOX_PTY_CHILD_READY__'",
    ].join("; ");
    manager.write({ sessionId: started.sessionId, data: childCommand, key: "enter" });
    await withWindowsConPtyStage("explicit:child-command-output", () => readTerminalUntil(manager, started.sessionId, /__EQUINOX_PTY_CHILD_READY__/u), 10_000);
    stopChildPid = await withWindowsConPtyStage("explicit:child-pid", () => waitFor(async () => {
      const text = await fs.readFile(stopPidPath, "utf8").catch(() => "");
      const value = Number.parseInt(text.trim(), 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    }, "Windows ConPTY stop fixture did not create a descendant"), 10_000);
    assert.equal(pidExists(stopChildPid), true, "Windows ConPTY descendant disappeared before stop");

    const stopped = await withWindowsConPtyStage("explicit:stop", () => manager.stop({ sessionId: started.sessionId, timeoutMs: 2_500 }), 8_000);
    assert.equal(stopped.running, false, "Windows ConPTY stop did not finalize");
    assert.equal(stopped.cleanupVerified, true, "Windows ConPTY stop did not verify Job Object cleanup");
    await withWindowsConPtyStage("explicit:descendant-drain", () => waitFor(() => !pidExists(stopChildPid), "Windows ConPTY stop did not drain its descendant"), 10_000);

    const natural = await withWindowsConPtyStage("natural:start", () => manager.start({
      projectId: "windows-smoke",
      projectName: "Windows Smoke",
      cwd: root,
      shell: "powershell.exe",
      shellArgs: ["-NoLogo", "-NoProfile"],
      env: { ...process.env, EQUINOX_PTY_CHILD_PID: naturalPidPath },
      cols: 90,
      rows: 24,
      label: "windows-conpty-natural",
    }));
    const naturalCommand = [
      "$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden",
      "[IO.File]::WriteAllText($env:EQUINOX_PTY_CHILD_PID, [string]$child.Id)",
      "Write-Output '__EQUINOX_PTY_NATURAL__'",
      "exit",
    ].join("; ");
    manager.write({ sessionId: natural.sessionId, data: naturalCommand, key: "enter" });
    await withWindowsConPtyStage("natural:command-output", () => readTerminalUntil(manager, natural.sessionId, /__EQUINOX_PTY_NATURAL__/u), 10_000);
    naturalChildPid = await withWindowsConPtyStage("natural:child-pid", () => waitFor(async () => {
      const text = await fs.readFile(naturalPidPath, "utf8").catch(() => "");
      const value = Number.parseInt(text.trim(), 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    }, "Windows ConPTY natural-exit fixture did not create a descendant"), 10_000);
    const finalNatural = await withWindowsConPtyStage("natural:finalize", () => waitFor(() => {
      const state = manager.list().find((item) => item.sessionId === natural.sessionId);
      return state && !state.running ? state : null;
    }, "Windows ConPTY natural exit did not finalize"), 10_000);
    assert.equal(finalNatural.cleanupVerified, true, "Windows ConPTY natural exit did not verify Job Object cleanup");
    await withWindowsConPtyStage("natural:descendant-drain", () => waitFor(() => !pidExists(naturalChildPid), "Windows ConPTY natural exit did not drain its descendant"), 10_000);

    return Object.freeze({
      interactiveIo: true,
      resize: true,
      stopDrainedDescendant: true,
      naturalExitDrainedDescendant: true,
    });
  } finally {
    clearTimeout(watchdog);
    await withWindowsConPtyStage("manager:shutdown", () => manager.shutdown(), 8_000).catch((error) => {
      process.stderr.write(`[windows-conpty] shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    for (const pid of [stopChildPid, naturalChildPid]) {
      if (Number.isInteger(pid) && pidExists(pid)) {
        try { process.kill(pid); } catch {}
      }
    }
  }
}

async function verifyWindowsEmergencyStop(root) {
  const processManager = createProcessManager({ platform: "win32", arch: "x64", groupPollMs: 50 });
  const terminalManager = createTerminalManager({ platform: "win32", arch: "x64" });
  const terminalPidPath = path.join(root, "emergency terminal child pid.txt");
  let processChildPid = null;
  let terminalChildPid = null;
  try {
    const managed = await processManager.start({
      projectId: "windows-smoke",
      projectName: "Windows Smoke",
      cwd: root,
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", [
        "$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden",
        "Write-Output ('EMERGENCY_PROCESS_CHILD=' + $child.Id)",
        "Start-Sleep -Seconds 60",
      ].join("; ")],
      purpose: "background",
      env: process.env,
      label: "windows-emergency-process",
    });
    const processLogs = await processManager.readLogs({ processId: managed.processId, cursor: 0, waitMs: 3_000 });
    const processMatch = processLogs.output.match(/EMERGENCY_PROCESS_CHILD=(\d+)/u);
    assert.ok(processMatch, `Emergency Stop process fixture did not report descendant: ${processLogs.output}`);
    processChildPid = Number.parseInt(processMatch[1], 10);

    const terminal = await terminalManager.start({
      projectId: "windows-smoke",
      projectName: "Windows Smoke",
      cwd: root,
      shell: "powershell.exe",
      shellArgs: ["-NoLogo", "-NoProfile"],
      env: { ...process.env, EQUINOX_PTY_CHILD_PID: terminalPidPath },
      cols: 100,
      rows: 28,
      label: "windows-emergency-terminal",
    });
    terminalManager.write({ sessionId: terminal.sessionId, data: [
      "$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden",
      "[IO.File]::WriteAllText($env:EQUINOX_PTY_CHILD_PID, [string]$child.Id)",
      "Write-Output '__EQUINOX_EMERGENCY_PTY_READY__'",
    ].join("; "), key: "enter" });
    await readTerminalUntil(terminalManager, terminal.sessionId, /__EQUINOX_EMERGENCY_PTY_READY__/u);
    terminalChildPid = await waitFor(async () => {
      const text = await fs.readFile(terminalPidPath, "utf8").catch(() => "");
      const value = Number.parseInt(text.trim(), 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    }, "Emergency Stop ConPTY fixture did not create a descendant");

    const control = createAgentControlController({ terminalManager, processManager });
    const paused = await control.pause({ reason: "windows_w3_acceptance" });
    assert.equal(paused.state, "PAUSED");
    assert.equal(paused.activeWork.total, 0, "Emergency Stop left managed work active");
    assert.equal(paused.lastStop.failureCount, 0, "Emergency Stop reported cleanup failures");
    await waitFor(
      () => !pidExists(managed.pid) && !pidExists(processChildPid) && !pidExists(terminal.pid) && !pidExists(terminalChildPid),
      "Emergency Stop did not drain all Windows Job-owned process trees",
    );
    return Object.freeze({ jobOwnedProcessAndConPtyDrained: true });
  } finally {
    await terminalManager.shutdown().catch(() => {});
    await processManager.shutdown().catch(() => {});
    for (const pid of [processChildPid, terminalChildPid]) {
      if (Number.isInteger(pid) && pidExists(pid)) {
        try { process.kill(pid); } catch {}
      }
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
let nativeHost = null;
let nativeInput = null;
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
  assert.equal(snapshot.browser.active, true, "Windows Browser named-pipe bridge did not start");
  assert.equal(snapshot.browser.transportKind, "named-pipe");
  assert.equal(snapshot.controlCenter?.active, true, "Control Center did not start");
  assert.equal(snapshot.controlCenter?.port, port, "Control Center started on an unexpected port");

  const browserEndpoint = equinoxBrowserIpcEndpoint({ platform: "win32", namespace: runtimeEnv.EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE });
  nativeInput = new (await import("node:stream")).PassThrough();
  const nativeOutput = new (await import("node:stream")).PassThrough();
  const nativeError = new (await import("node:stream")).PassThrough();
  nativeHost = createEquinoxBrowserNativeHostRuntime({
    bridgeEndpoint: browserEndpoint,
    origin: `chrome-extension://${EQUINOX_BROWSER_EXTENSION_ID}/`,
    input: nativeInput,
    output: nativeOutput,
    errorOutput: nativeError,
    reconnectDelayMs: 25,
  });
  nativeHost.start();
  nativeInput.write(encodeNativeMessage({
    type: "extension.hello",
    extensionId: EQUINOX_BROWSER_EXTENSION_ID,
    extensionVersion: "0.7.1-windows-smoke",
    protocolVersion: 1,
    capabilities: ["ping"],
    instanceId: "11111111-1111-4111-8111-111111111111",
    browserContext: "user",
  }));
  const browserReady = await waitFor(() => runtime.snapshot().browser?.contexts?.user?.ready === true, "Windows Native Messaging runtime did not connect through named pipe");
  assert.equal(browserReady, true);

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
  const helperLoss = await verifyWindowsJobObjectHelperLoss(root);
  const managedProcess = await verifyWindowsManagedProcessLifecycle(root);
  const conpty = await verifyWindowsConPtyLifecycle(root);
  const emergencyStop = await verifyWindowsEmergencyStop(root);
  const agentBrowser = await verifyWindowsAgentBrowserLifecycle(root);

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
    browserNamedPipeReady: runtime.snapshot().browser?.contexts?.user?.ready === true,
    tunnel,
    jobObject,
    helperLoss,
    managedProcess,
    conpty,
    emergencyStop,
    agentBrowser,
  }, null, 2)}\n`);
} finally {
  process.stdout.write("[windows-smoke] START runtime-shutdown\n");
  nativeHost?.close();
  nativeInput?.end();
  if (lifecycle) await lifecycle.shutdown().catch(() => {});
  else if (runtime) await runtime.shutdown({ reason: "windows-smoke-cleanup" }).catch(() => {});
  process.stdout.write("[windows-smoke] PASS runtime-shutdown\n");
  process.stdout.write("[windows-smoke] START temp-root-remove\n");
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  process.stdout.write("[windows-smoke] PASS temp-root-remove\n");
}
