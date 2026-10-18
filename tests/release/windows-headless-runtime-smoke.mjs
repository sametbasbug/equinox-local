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
import { createBackgroundProcessOwnershipAdapter } from "../../src/equinox-local-process-ownership.js";
import { compileWindowsJobObjectHelper } from "../../scripts/release/package-managed-release-windows.mjs";
import { createAgentControlController } from "../../src/equinox-local-agent-control.js";
import { createProcessManager } from "../../src/process-manager.js";
import { equinoxLocalFiniteShell, equinoxLocalWindowsPowerShell7Path } from "../../src/equinox-local-platform.js";
import { probeWindowsTerminalExecution } from "../../src/equinox-local-windows-terminal-health.js";
import { createTerminalManager } from "../../src/terminal-manager.js";
import { createEquinoxLocalRuntime } from "../../src/server.js";
import { createEquinoxBrowserNativeHostRuntime } from "../../src/equinox-browser-native-host-runtime.js";
import { equinoxBrowserIpcEndpoint } from "../../src/equinox-browser-socket.js";
import { EQUINOX_BROWSER_EXTENSION_ID } from "../../src/equinox-browser-bridge.js";
import {
  createEquinoxAgentBrowser,
  discoverWindowsChrome,
  parseWindowsAgentBrowserMainPids,
  queryWindowsChromeProcessInventory,
} from "../../src/equinox-agent-browser.js";

const execFile = promisify(execFileCallback);
const jobHelperRoot = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-job-helper-"));
const jobHelperPath = await compileWindowsJobObjectHelper({
  outputDir: jobHelperRoot,
  target: `win32-${process.arch}`,
});
const jobHelperImage = await fs.readFile(jobHelperPath);
const jobPeOffset = jobHelperImage.readUInt32LE(0x3c);
const jobSubsystemOffset = jobPeOffset + 24 + 68;
assert.equal(jobHelperImage.readUInt16LE(jobSubsystemOffset), 2,
  "Windows Job Object helper must be a GUI-subsystem PE to avoid console windows");

const gateMarker = path.join(jobHelperRoot, "owned-process-gate-v1.marker");
assert.equal((await fs.readFile(gateMarker, "utf8")).trim(), "equinox-owned-process-gate-v1");
process.env.EQUINOX_WINDOWS_JOB_OBJECT_HELPER_PATH = jobHelperPath;
const probeNativeGate = createBackgroundProcessOwnershipAdapter({ platform: "win32", arch: process.arch });
const nativeGateSpec = probeNativeGate.spawnSpec("powershell.exe", ["-NoProfile"], process.env);
assert.equal(nativeGateSpec.command, jobHelperPath, "managed finite commands must bypass the PowerShell process gate");
assert.deepEqual(nativeGateSpec.args, ["--owned-process-gate", "powershell.exe", "-NoProfile"]);


const WINDOWS_ARCH = process.arch === "x64" || process.arch === "arm64" ? process.arch : null;
const WINDOWS_TARGET = WINDOWS_ARCH ? `win32-${WINDOWS_ARCH}` : null;

if (process.platform !== "win32" || WINDOWS_ARCH === null) {
  throw new Error(`Windows headless smoke requires native win32-x64 or win32-arm64; got ${process.platform}-${process.arch}.`);
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

  let lastInventory = "";
  let lastDiagnostics = [];
  const processId = await waitFor(async () => {
    const stdout = await queryWindowsChromeProcessInventory(execFile, process.env);
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
    await assert.rejects(() => lease.status(), /not available|exited unexpectedly|input failed/u);
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
  const manager = createProcessManager({ platform: "win32", arch: WINDOWS_ARCH, groupPollMs: 50 });
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
  // ARM64 hosted runners may take longer to launch the nested PowerShell child
  // under concurrent native-package CI work. Poll the same managed log rather
  // than treating one empty 3-second read as a process-lifecycle failure.
  let latestOutput = "";
  let descendantPid;
  try {
    descendantPid = await waitFor(async () => {
      const logs = await manager.readLogs({ processId: started.processId, cursor: 0, waitMs: 2_000 });
      latestOutput = logs.output;
      const match = latestOutput.match(/DESCENDANT=(\d+)/u);
      return match ? Number.parseInt(match[1], 10) : null;
    }, "Windows managed process did not report descendant PID", 15_000);
  } catch (error) {
    throw new Error(`managed Windows process did not report descendant PID: ${latestOutput}`, { cause: error });
  }
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
  const cases = [
    { command: "Write-Output 'EQUINOX_STDOUT'; [Console]::Error.WriteLine('EQUINOX_STDERR')", expectedExit: 0,
      stdout: /EQUINOX_STDOUT/u, stderr: /EQUINOX_STDERR/u },
    { command: "Write-Output 'EQUINOX_EXIT17'; exit 17", expectedExit: 17,
      stdout: /EQUINOX_EXIT17/u },
    { command: "& $env:ComSpec /d /c 'echo EQUINOX_CMD & exit /b 23'; exit $LASTEXITCODE", expectedExit: 23,
      stdout: /EQUINOX_CMD/u },
  ];
  const shell = equinoxLocalFiniteShell({ platform: "win32", arch: WINDOWS_ARCH, env: process.env });
  for (const [index, item] of cases.entries()) {
    const command = await manager.start({
      projectId: "windows-smoke", projectName: "Windows Smoke", cwd: root,
      command: shell.command, args: shell.argsFor(item.command),
      purpose: "terminal_exec", env: process.env, label: `windows-finite-${index}`,
    });
    const result = await manager.waitForExit({ processId: command.processId, waitMs: 8_000 });
    const logs = await manager.readLogs({ processId: command.processId, cursor: 0 });
    assert.equal(result.running, false, `Windows shell command ${index} did not finish`);
    assert.equal(result.exitCode, item.expectedExit, `Windows shell command ${index} returned ${result.exitCode}; output ${logs.output}`);
    assert.match(logs.output, item.stdout);
    if (item.stderr) assert.match(logs.output, item.stderr);
  }
  // CMD is explicit and finite-only, and must not dispatch via the PS5
  // NativeCommandProcessor that flashes Terminal on physical Windows.
  const cmdShell = equinoxLocalFiniteShell({
    platform: "win32", arch: WINDOWS_ARCH, env: process.env, shell: "cmd",
  });
  const cmdFinite = await manager.start({
    projectId: "windows-smoke", projectName: "Windows Smoke", cwd: root,
    command: cmdShell.command, args: cmdShell.argsFor("echo EQUINOX_FINITE_CMD_OK & exit /b 27"),
    purpose: "terminal_exec", env: process.env, label: "windows-finite-explicit-cmd",
  });
  const cmdFinished = await manager.waitForExit({ processId: cmdFinite.processId, waitMs: 8_000 });
  const cmdFiniteLogs = await manager.readLogs({ processId: cmdFinite.processId, cursor: 0 });
  assert.equal(cmdFinished.running, false, "finite explicit CMD did not finish");
  assert.equal(cmdFinished.exitCode, 27, "finite CMD exit status was lost: " + cmdFiniteLogs.output);
  assert.match(cmdFiniteLogs.output, /EQUINOX_FINITE_CMD_OK/u);

  const terminalDoctor = await probeWindowsTerminalExecution({ processManager: manager, cwd: root, env: process.env, arch: WINDOWS_ARCH });
  assert.equal(terminalDoctor.healthy, true, 'On-demand Windows Doctor terminal probe must detect true stdout and exit 17.');
  await manager.shutdown();
  return Object.freeze({ waitTimeoutPreservedOwnedTree: true, descendantRetainedAfterLeaderExit: true, stopDrainedDescendant: true, naturalExit: true, terminalDoctor: true });
}

async function verifyOptionalWindowsPowerShell7(root) {
  const pwsh = equinoxLocalWindowsPowerShell7Path(process.env);
  if (!pwsh) return { installed: false, skipped: true };
  const manager = createProcessManager({ platform: "win32", arch: WINDOWS_ARCH });
  let processId = null;
  try {
    const selected = equinoxLocalFiniteShell({ platform: "win32", arch: WINDOWS_ARCH, env: process.env, shell: "pwsh" });
    assert.equal(selected.command, pwsh);
    const started = await manager.start({
      projectId: "windows-smoke", projectName: "Windows Smoke", cwd: root,
      command: selected.command, args: selected.argsFor("Write-Output ('PWSH' + $PSVersionTable.PSVersion.Major + '_FINITE_MAJOR'); exit 17"),
      purpose: "terminal_exec", env: process.env, label: "optional-pwsh7-finite",
    });
    processId = started.processId;
    const ended = await manager.waitForExit({ processId, waitMs: 12_000 });
    const output = await manager.readLogs({ processId, cursor: 0 });
    assert.equal(ended.running, false);
    assert.equal(ended.exitCode, 17, "PowerShell 7 finite exit status was lost");
    assert.match(output.output, /PWSH7_FINITE_MAJOR/u, "finite command must actually run in PowerShell 7");
  } finally {
    if (processId) await manager.stop({ processId, force: true, remove: true }).catch(() => {});
    await manager.shutdown();
  }
  const terminalManager = createTerminalManager({ platform: "win32", arch: WINDOWS_ARCH });
  let sessionId = null;
  try {
    const started = await terminalManager.start({
      projectId: "windows-smoke", projectName: "Windows Smoke", cwd: root,
      shell: pwsh, shellArgs: ["-NoLogo", "-NoProfile"], env: process.env,
      cols: 80, rows: 24, label: "optional-pwsh7-conpty",
    });
    sessionId = started.sessionId;
    assert.equal(started.running, true);
    terminalManager.write({ sessionId, data: "Write-Output ('PWSH' + $PSVersionTable.PSVersion.Major + '_CONPTY_MAJOR')", key: "enter" });
    await readTerminalUntil(terminalManager, sessionId, /PWSH7_CONPTY_MAJOR/u, 10_000);
  } finally {
    if (sessionId) await terminalManager.stop({ sessionId, force: true }).catch(() => {});
  }
  return { installed: true, finite: true, conpty: true };
}

async function verifyWindowsIndependentProcessCommands(root) {
  // process_start/process_logs/process_wait/process_stop must not rely on
  // the finite PowerShell shell or its EncodedCommand escape path.
  const manager = createProcessManager({ platform: "win32", arch: WINDOWS_ARCH, groupPollMs: 50 });
  const cases = [
    { marker: "DIRECT_NODE_OK", code: 0 },
    { marker: "DIRECT_NODE_EXIT31", code: 31 },
  ];
  try {
    for (const { marker, code } of cases) {
      const started = await manager.start({
        projectId: "windows-smoke", projectName: "Windows Smoke", cwd: root,
        command: process.execPath,
        args: ["-e", `console.log(${JSON.stringify(marker)});console.error("DIRECT_STDERR");process.exit(${code});`],
        purpose: "background", env: process.env, label: "independent-direct-node",
      });
      const finished = await manager.waitForExit({ processId: started.processId, waitMs: 10_000 });
      const logs = await manager.readLogs({ processId: started.processId, cursor: 0, stripAnsiCodes: true });
      assert.equal(finished.running, false, `direct background process never exited: ${marker}`);
      assert.equal(finished.exitCode, code, `direct background process returned ${finished.exitCode}: ${logs.output}`);
      const snapshot = manager.snapshotOutput({ processId: started.processId });
      assert.match(snapshot.stdout, new RegExp(marker, "u"));
      assert.match(snapshot.stderr, /DIRECT_STDERR/u);
      const tail = await manager.readLogs({ processId: started.processId, cursor: logs.nextCursor });
      assert.equal(tail.output, "", "direct command log cursor repeated output");
      const waited = manager.snapshotOutput({ processId: started.processId });
      assert.equal(waited.process.exitCode, code, "process_wait/snapshot disagrees about direct command exit");
      await manager.stop({ processId: started.processId, force: true, remove: true });
    }

    // Executing a native Windows command directly through process_start must
    // not depend on terminal_exec's PowerShell -EncodedCommand path either.
    const nativeCmd = await manager.start({
      projectId: "windows-smoke", projectName: "Windows Smoke", cwd: root,
      command: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/c", "echo DIRECT_CMD_OK & exit /b 29"],
      purpose: "background", env: process.env, label: "independent-direct-cmd",
    });
    const cmdFinished = await manager.waitForExit({ processId: nativeCmd.processId, waitMs: 10_000 });
    const cmdLogs = await manager.readLogs({ processId: nativeCmd.processId, cursor: 0 });
    assert.equal(cmdFinished.running, false, "independent direct CMD did not finish");
    assert.equal(cmdFinished.exitCode, 29, `independent CMD exit status must be 29: ${cmdLogs.output}`);
    assert.match(cmdLogs.output, /DIRECT_CMD_OK/u);
    await manager.stop({ processId: nativeCmd.processId, force: true, remove: true });

    // Windows workflow commands often resolve to npm.cmd / batch wrappers;
    // native ProcessStartInfo cannot directly launch a .cmd file.
    const batchPath = path.join(root, "native command with spaces.cmd");
    await fs.writeFile(batchPath, "@echo off\r\necho DIRECT_BATCH_OK\r\necho FIRST=[%~1]\r\necho SECOND=[%~2]\r\nexit /b 37\r\n");
    const batch = await manager.start({
      projectId: "windows-smoke", projectName: "Windows Smoke", cwd: root,
      command: batchPath, args: ["alpha beta", "--port=3777"], purpose: "background",
      env: process.env, label: "independent-direct-batch",
    });
    const batchEnd = await manager.waitForExit({ processId: batch.processId, waitMs: 10_000 });
    const batchLogs = await manager.readLogs({ processId: batch.processId, cursor: 0 });
    assert.equal(batchEnd.running, false, "native batch command did not finish");
    assert.equal(batchEnd.exitCode, 37, `batch wrapper exit status must be 37: ${batchLogs.output}`);
    assert.match(batchLogs.output, /DIRECT_BATCH_OK/u);
    assert.match(batchLogs.output, /FIRST=\[alpha beta\]/u, "quoted Windows batch arguments must preserve spaces");
    assert.match(batchLogs.output, /SECOND=\[--port=3777\]/u, "Windows batch flags must preserve values");
    await manager.stop({ processId: batch.processId, force: true, remove: true });

    const injectionRejected = await manager.start({
      projectId: "windows-smoke", projectName: "Windows Smoke", cwd: root,
      command: batchPath, args: ["%COMSPEC%"], purpose: "background",
      env: process.env, label: "independent-batch-expansion-rejection",
    });
    const rejectedEnd = await manager.waitForExit({ processId: injectionRejected.processId, waitMs: 10_000 });
    const rejectedLogs = await manager.readLogs({ processId: injectionRejected.processId, cursor: 0 });
    assert.equal(rejectedEnd.running, false, "rejected batch argument never finished");
    assert.equal(rejectedEnd.exitCode, 127, "Windows batch expansion must fail closed");
    assert.match(rejectedLogs.output, /unsupported CMD expansion or quoting characters/u);
    assert.doesNotMatch(rejectedLogs.output, /DIRECT_BATCH_OK/u);
    await manager.stop({ processId: injectionRejected.processId, force: true, remove: true });

    // The background tool also manages indefinite processes. Ensure process_stop
    // drains the entire owned Windows Job Object without killing the caller.
    const live = await manager.start({
      projectId: "windows-smoke", projectName: "Windows Smoke", cwd: root,
      command: process.execPath,
      args: ["-e", 'console.log("DIRECT_READY");setInterval(()=>{},1000);'],
      purpose: "background", env: process.env, label: "independent-long-running-node",
    });
    const ready = await waitFor(async () => {
      const logs = await manager.readLogs({ processId: live.processId, cursor: 0, waitMs: 400 });
      return logs.output.includes("DIRECT_READY");
    }, "direct long-running process did not report readiness", 10_000);
    assert.equal(ready, true);
    const before = await manager.waitForExit({ processId: live.processId, waitMs: 100 });
    assert.equal(before.running, true, "background process terminated before process_stop");
    const stopped = await manager.stop({ processId: live.processId, timeoutMs: 3_000, remove: true });
    assert.equal(stopped.running, false, "background process_stop failed to drain owned Job Object");
    await waitFor(() => !pidExists(live.pid), "direct background process still running after process_stop", 4_000);
    return Object.freeze({ directExit0: true, directExit31: true, directCmd29: true, directBatch37: true, separateLogs: true, cursor: true, stopDrained: true });
  } finally {
    await manager.shutdown();
  }
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
  const manager = createTerminalManager({ platform: "win32", arch: WINDOWS_ARCH });
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
  const processManager = createProcessManager({ platform: "win32", arch: WINDOWS_ARCH, groupPollMs: 50 });
  const terminalManager = createTerminalManager({ platform: "win32", arch: WINDOWS_ARCH });
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
  const distribution = TUNNEL_CLIENT_DISTRIBUTIONS[WINDOWS_TARGET];
  assert.ok(distribution, `${WINDOWS_TARGET} tunnel-client metadata is missing`);
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
  assert.equal(doctor.doctor?.host?.target, WINDOWS_TARGET);
  assert.equal(doctor.doctor?.host?.platform, "win32");
  assert.equal(doctor.doctor?.managed, false);
  // Headless source smoke has no packaged winapp native binary. Windows
  // desktop is required, so Doctor must expose the absence as Attention.
  assert.equal(doctor.doctor?.state, "ATTENTION");
  assert.equal(doctor.doctor?.checks?.find((item) => item.id === "desktop")?.status, "attention");

  const tunnel = await verifyPinnedWindowsTunnelClient(root);
  const jobObject = await verifyWindowsJobObjectContainment(root);
  const helperLoss = await verifyWindowsJobObjectHelperLoss(root);
  const managedProcess = await verifyWindowsManagedProcessLifecycle(root);
  const independentProcessCommands = await verifyWindowsIndependentProcessCommands(root);
  const optionalPowerShell7 = await verifyOptionalWindowsPowerShell7(root);
  const conpty = await verifyWindowsConPtyLifecycle(root);
  const emergencyStop = await verifyWindowsEmergencyStop(root);
  const agentBrowser = await verifyWindowsAgentBrowserLifecycle(root);

  const htmlResponse = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  assert.match(html, /Equinox Local/u);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    target: WINDOWS_TARGET,
    controlCenterPort: port,
    doctorState: doctor.doctor?.state ?? null,
    browserIpcActive: snapshot.browser.active,
    browserNamedPipeReady: runtime.snapshot().browser?.contexts?.user?.ready === true,
    tunnel,
    jobObject,
    helperLoss,
    managedProcess,
    independentProcessCommands,
    optionalPowerShell7,
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
  await fs.rm(jobHelperRoot, { recursive: true, force: true }).catch(() => {});
  process.stdout.write("[windows-smoke] PASS temp-root-remove\n");
}
