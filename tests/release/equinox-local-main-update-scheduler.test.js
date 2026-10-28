import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { equinoxLocalWindowsPowerShellPath } from "../../src/equinox-local-platform.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupEquinoxLocalMainUpdateWorkerOwnership,
  inspectEquinoxLocalMainUpdateWorkerOwnership,
  assertEquinoxLocalSignedMacWorkerNeverStarted,
  inspectWindowsMainUpdateWorkerProcess,
  inspectWindowsOwnedWpfProcess,
  mainUpdateWorkerEnvironment,
  parseWindowsMainUpdateWorkerOwnership,
  scheduleEquinoxLocalMainUpdateWorker,
  windowsMainUpdateWorkerOwnershipPath,
} from "../../src/equinox-local-main-update-scheduler.js";

const TX = `main-${"a".repeat(32)}`;

test("main update worker environment is minimal and credential-free", () => {
  const env = mainUpdateWorkerEnvironment({ HOME: "/Users/example", USER: "example", LOGNAME: "example", TMPDIR: "/tmp/x", EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: "/private/runtime.conf", EQUINOX_LOCAL_DEV_NODE: "/runtime/node", OPENAI_API_KEY: "secret", GITHUB_TOKEN: "secret" });
  assert.deepEqual(env, { HOME: "/Users/example", USER: "example", LOGNAME: "example", TMPDIR: "/tmp/x", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: "/private/runtime.conf", EQUINOX_LOCAL_DEV_NODE: "/runtime/node" });
});

test("launchd detached Main worker keeps exact non-secret managed installation identity for native artifact transitions", () => {
  const HOME = "/Users/isolated/home";
  const EQUINOX_LOCAL_INSTALL_ROOT = `${HOME}/Library/Application Support/Equinox Local`;
  const EQUINOX_LOCAL_RELEASE_DIR = `${EQUINOX_LOCAL_INSTALL_ROOT}/releases/5.2.1`;
  const env = mainUpdateWorkerEnvironment({
    HOME, USER: "runner", LOGNAME: "runner",
    EQUINOX_LOCAL_INSTALL_ROOT, EQUINOX_LOCAL_RELEASE_DIR,
    OPENAI_API_KEY: "private", GITHUB_TOKEN: "private", NODE_OPTIONS: "--import=/dangerous/hook",
  });
  assert.equal(env.EQUINOX_LOCAL_INSTALL_ROOT, EQUINOX_LOCAL_INSTALL_ROOT);
  assert.equal(env.EQUINOX_LOCAL_RELEASE_DIR, EQUINOX_LOCAL_RELEASE_DIR);
  assert.equal(env.HOME, HOME);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
});

test("main update handoff is transferred to a one-shot launchd-owned worker", async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "equinox-scheduler-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const stateRoot = path.join(root, "state");
  const nodePath = path.join(root, "node");
  const workerPath = path.join(sourceRoot, "src", "equinox-local-main-update-worker.js");
  await fs.mkdir(path.dirname(workerPath), { recursive: true });
  await fs.writeFile(nodePath, "node", { mode: 0o700 });
  await fs.writeFile(workerPath, "worker", { mode: 0o600 });
  const calls = [];
  const result = await scheduleEquinoxLocalMainUpdateWorker({ transactionId: TX, sourceRoot, transactionRoot: stateRoot, nodePath, workerPath, uid: 501, sourceEnv: { HOME: "/Users/example", OPENAI_API_KEY: "secret" }, execFileImpl: async (command, args) => { calls.push([command, ...args]); return { stdout: "", stderr: "" }; } });
  assert.equal(result.scheduled, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 3), ["/bin/launchctl", "bootstrap", "gui/501"]);
  assert.match(calls[1].join(" "), /dev\.equinox\.local\.main-update\./u);
  const plist = await fs.readFile(result.plistPath, "utf8");
  assert.match(plist, /<key>KeepAlive<\/key>\n  <false\/>/u);
  assert.match(plist, /<key>RunAtLoad<\/key>\n  <true\/>/u);
  assert.match(plist, new RegExp(TX));
  assert.equal(plist.includes("OPENAI_API_KEY"), false);
  assert.equal((await fs.stat(result.plistPath)).mode & 0o077, 0);
});

test("Windows Main handoff sends only transaction identity to the trusted shell", async () => {
  const calls = [];
  const result = await scheduleEquinoxLocalMainUpdateWorker({
    transactionId: TX,
    sourceRoot: "C:\\Users\\Example\\AppData\\Local\\Equinox Local\\state\\main-update\\sources\\1111111111111111111111111111111111111111",
    transactionRoot: "C:\\Users\\Example\\AppData\\Local\\Equinox Local\\state\\main-update",
    workerPath: "C:\\Users\\Example\\AppData\\Local\\Equinox Local\\state\\main-update\\sources\\2222222222222222222222222222222222222222\\src\\equinox-local-main-update-worker.js",
    platform: "win32",
    fsImpl: { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }) },
    execFileImpl: async () => assert.fail("Windows scheduler must not invoke launchctl or arbitrary commands"),
    requestWindowsHandoffImpl: async (...args) => { calls.push(args); return { requested: true, transactionId: TX }; },
  });
  assert.equal(result.scheduled, true);
  assert.equal(result.platform, "win32");
  assert.deepEqual(calls, [[TX, { platform: "win32" }]]);
});

test("Windows worker ownership contract binds transaction, PID, start identity, token and Node path", () => {
  const stateRoot = "C:\\Users\\Example\\AppData\\Local\\Equinox Local\\state\\main-update";
  const nodePath = "C:\\Users\\Example\\AppData\\Local\\Equinox Local\\releases\\5.2.0\\runtime\\node\\bin\\node.exe";
  assert.equal(
    windowsMainUpdateWorkerOwnershipPath(stateRoot, TX),
    stateRoot + "\\handoff\\" + TX + ".windows-worker.json",
  );
  const ownership = parseWindowsMainUpdateWorkerOwnership({
    schemaVersion: 1,
    transactionId: TX,
    pid: 4242,
    startTimeUtcTicks: "638953728000000000",
    token: "b".repeat(64),
    nodePath,
  }, { transactionId: TX });
  assert.equal(ownership.pid, 4242);
  assert.equal(ownership.nodePath, nodePath);
  assert.throws(() => parseWindowsMainUpdateWorkerOwnership({ ...ownership, extra: true }, { transactionId: TX }), /unsupported fields/u);
  assert.throws(() => parseWindowsMainUpdateWorkerOwnership({ ...ownership, startTimeUtcTicks: "bad" }, { transactionId: TX }), /start identity/u);
  assert.throws(() => parseWindowsMainUpdateWorkerOwnership({ ...ownership, token: "c".repeat(63) }, { transactionId: TX }), /token/u);
});

test("Windows worker process inspection distinguishes exact identity, PID reuse and uncertain inspection", async () => {
  const ownership = {
    schemaVersion: 1,
    transactionId: TX,
    pid: 4242,
    startTimeUtcTicks: "638953728000000000",
    token: "b".repeat(64),
    nodePath: "C:\\Equinox\\runtime\\node\\bin\\node.exe",
  };
  const calls = [];
  const exact = await inspectWindowsMainUpdateWorkerProcess(ownership, {
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: "running" };
    },
  });
  assert.deepEqual(exact, { running: true, stale: false, uncertain: false });
  assert.match(calls[0].command, /^[A-Z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu);
  assert.deepEqual(calls[0].args.slice(0, 6),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand"]);
  assert.equal(calls[0].args.length, 7, "EncodedCommand must be the final PowerShell 5.1 argument");
  const source = Buffer.from(calls[0].args[6], "base64").toString("utf16le");
  assert.match(source, /\$env:EQUINOX_LOCAL_CHECK_WORKER_PID/u);
  assert.match(source, /\$env:EQUINOX_LOCAL_CHECK_WORKER_TICKS/u);
  assert.match(source, /\$env:EQUINOX_LOCAL_CHECK_WORKER_NODE/u);
  assert.doesNotMatch(source, /4242|638953728000000000/u, "No identity may be interpolated into script source");
  assert.equal(calls[0].options.env.EQUINOX_LOCAL_CHECK_WORKER_PID, "4242");
  assert.equal(calls[0].options.env.EQUINOX_LOCAL_CHECK_WORKER_TICKS, ownership.startTimeUtcTicks);
  assert.equal(calls[0].options.env.EQUINOX_LOCAL_CHECK_WORKER_NODE, ownership.nodePath);

  const native = await inspectWindowsMainUpdateWorkerProcess(ownership, {
    nativeHelperPath: String.raw`C:\native-candidate\release\runtime\job\equinox-local-job-object-helper.exe`,
    execFileImpl: async (command, args, options) => {
      assert.match(command, /equinox-local-job-object-helper\.exe$/u);
      assert.deepEqual(args, ["--inspect-process"]);
      assert.equal(options.timeout, 5000);
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.EQUINOX_LOCAL_CHECK_WORKER_NODE, ownership.nodePath);
      assert.equal(options.env.EQUINOX_LOCAL_CHECK_WORKER_TICKS, ownership.startTimeUtcTicks);
      return { stdout: "running" };
    },
  });
  assert.deepEqual(native, { running: true, stale: false, uncertain: false });
  let nativeCalls = 0;
  await assert.rejects(inspectWindowsMainUpdateWorkerProcess(ownership, {
    nativeHelperPath: String.raw`C:\native-candidate\release\runtime\job\equinox-local-job-object-helper.exe`,
    execFileImpl: async () => {
      nativeCalls++;
      throw Object.assign(new Error("native timeout"), { code: "ETIMEDOUT", killed: true });
    },
  }), /inspection failed/u);
  assert.equal(nativeCalls, 1, "native helper timeout must fail closed without a retry");

  const reused = await inspectWindowsMainUpdateWorkerProcess(ownership, {
    execFileImpl: async () => ({ stdout: "mismatch" }),
  });
  assert.deepEqual(reused, { running: false, stale: true, uncertain: false });

  const unknown = await inspectWindowsMainUpdateWorkerProcess(ownership, {
    execFileImpl: async () => ({ stdout: "unknown" }),
  });
  assert.deepEqual(unknown, { running: false, stale: false, uncertain: true });

  let timeoutAttempts = 0;
  const cold = await inspectWindowsMainUpdateWorkerProcess(ownership, {
    execFileImpl: async (_exe, _argv, options) => {
      assert.equal(options.timeout, 15_000);
      assert.equal(options.windowsHide, true);
      timeoutAttempts++;
      if (timeoutAttempts === 1) throw Object.assign(new Error("temporary cold-start"), {
        code: "ETIMEDOUT", killed: true, signal: "SIGTERM",
      });
      return { stdout: "running" };
    },
  });
  assert.deepEqual(cold, { running: true, stale: false, uncertain: false });
  assert.equal(timeoutAttempts, 2, "only transient OS launch timeout gets one bounded retry");
  let rejectionAttempts = 0;
  await assert.rejects(inspectWindowsMainUpdateWorkerProcess(ownership, {
    execFileImpl: async () => {
      rejectionAttempts++;
      throw Object.assign(new Error("Command failed: -EncodedCommand SECRET"), {
        code: 1, killed: false, stderr: "sensitive command stderr",
      });
    },
  }), (error) => {
    assert.match(error.message, /status=1;signal=none;stderrBytes=/u);
    assert.doesNotMatch(error.message, /SECRET|sensitive/u);
    return true;
  });
  assert.equal(rejectionAttempts, 1, "a real PowerShell exit failure must fail closed without retry");
});

test("native Windows Main worker PID birthtime executable identity survives PowerShell 5.1 encoding", {
  skip: process.platform !== "win32",
}, async () => {
  const execFileNative = promisify(execFileCallback);
  const pid = process.pid;
  const powershell = equinoxLocalWindowsPowerShellPath();
  // Obtain the real OS/.NET StartTime ticks for THIS Node process, without
  // guessing timezones or mocking the very process-inspection API under test.
  const source = [
    "$ErrorActionPreference='Stop'",
    "$p=Get-Process -Id ([int]$env:EQUINOX_LOCAL_CHECK_WORKER_PID) -ErrorAction Stop",
    "[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture))",
  ].join(";");
  const { stdout: ticks } = await execFileNative(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
    "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64"),
  ], {
    timeout: 10_000, windowsHide: true,
    env: { ...process.env, EQUINOX_LOCAL_CHECK_WORKER_PID: String(pid) },
  });
  assert.match(ticks.trim(), /^[0-9]{1,19}$/u);
  const identity = {
    schemaVersion: 1, transactionId: TX, pid,
    startTimeUtcTicks: ticks.trim(), token: "b".repeat(64),
    nodePath: process.execPath,
  };
  const exact = await inspectWindowsMainUpdateWorkerProcess(identity);
  assert.deepEqual(exact, { running: true, stale: false, uncertain: false },
    "Actual running Node PID/start ticks/executable must be admitted on native Windows PowerShell 5.1");
  const wrongBirth = await inspectWindowsMainUpdateWorkerProcess({
    ...identity, startTimeUtcTicks: (BigInt(identity.startTimeUtcTicks) + 1n).toString(),
  });
  assert.deepEqual(wrongBirth, { running: false, stale: true, uncertain: false },
    "Reused PID with a different birth time must never be admitted");
  const wrongExe = await inspectWindowsMainUpdateWorkerProcess({
    ...identity, nodePath: "C:\\Windows\\System32\\not-product-node.exe",
  });
  assert.deepEqual(wrongExe, { running: false, stale: true, uncertain: false },
    "A foreign executable path must never be admitted");
  const absent = await inspectWindowsMainUpdateWorkerProcess({ ...identity, pid: 2147483647 });
  assert.deepEqual(absent, { running: false, stale: true, uncertain: false },
    "An exited or never-existing PID must never be admitted");
});

test("Windows ownership inspection fails closed when durable ownership cannot be validated", async () => {
  const stateRoot = "C:\\Equinox\\state\\main-update";
  const uncertain = await inspectEquinoxLocalMainUpdateWorkerOwnership({
    transactionId: TX,
    transactionRoot: stateRoot,
    platform: "win32",
    readWindowsOwnershipImpl: async () => { throw new Error("ownership corrupt"); },
  });
  assert.equal(uncertain.running, false);
  assert.equal(uncertain.uncertain, true);
  assert.match(uncertain.reason, /ownership corrupt/u);

  const absent = await inspectEquinoxLocalMainUpdateWorkerOwnership({
    transactionId: TX,
    transactionRoot: stateRoot,
    platform: "win32",
    readWindowsOwnershipImpl: async () => ({ ownershipPath: "marker", ownership: null }),
  });
  assert.deepEqual(
    { loaded: absent.loaded, running: absent.running, stale: absent.stale, uncertain: absent.uncertain },
    { loaded: false, running: false, stale: false, uncertain: false },
  );
});

test("Windows ownership cleanup is token-owned, removes verified stale records, and refuses a live foreign worker", async () => {
  const stateRoot = "C:\\Equinox\\state\\main-update";
  const ownershipPath = "C:\\Equinox\\state\\main-update\\handoff\\owner.json";
  const ownership = {
    schemaVersion: 1,
    transactionId: TX,
    pid: 4242,
    startTimeUtcTicks: "638953728000000000",
    token: "b".repeat(64),
    nodePath: "C:\\Equinox\\node.exe",
  };

  const ownerRemovals = [];
  const owner = await cleanupEquinoxLocalMainUpdateWorkerOwnership({
    transactionId: TX,
    transactionRoot: stateRoot,
    platform: "win32",
    ownershipToken: ownership.token,
    fsImpl: { rm: async (...args) => ownerRemovals.push(args) },
    readWindowsOwnershipImpl: async () => ({ ownershipPath, ownership }),
    inspectWorkerImpl: async () => assert.fail("exact owner cleanup must not inspect its own live process"),
  });
  assert.equal(owner.cleaned, true);
  assert.equal(owner.owner, true);
  assert.deepEqual(ownerRemovals, [[ownershipPath, { force: true }]]);

  const staleRemovals = [];
  const stale = await cleanupEquinoxLocalMainUpdateWorkerOwnership({
    transactionId: TX,
    transactionRoot: stateRoot,
    platform: "win32",
    fsImpl: { rm: async (...args) => staleRemovals.push(args) },
    readWindowsOwnershipImpl: async () => ({ ownershipPath, ownership }),
    inspectWorkerImpl: async () => ({ running: false, stale: true, uncertain: false }),
  });
  assert.equal(stale.cleaned, true);
  assert.equal(stale.stale, true);
  assert.equal(staleRemovals.length, 1);

  const liveRemovals = [];
  const live = await cleanupEquinoxLocalMainUpdateWorkerOwnership({
    transactionId: TX,
    transactionRoot: stateRoot,
    platform: "win32",
    fsImpl: { rm: async (...args) => liveRemovals.push(args) },
    readWindowsOwnershipImpl: async () => ({ ownershipPath, ownership }),
    inspectWorkerImpl: async () => ({ running: true, stale: false, uncertain: false }),
  });
  assert.equal(live.cleaned, false);
  assert.equal(live.running, true);
  assert.deepEqual(liveRemovals, []);
});

test("signed native Guardian retires its own worker record; Node waits and never unlinks a live or orphaned original owner", async () => {
  const root = "C:\\Equinox\\state\\main-update";
  const handoff = root + "\\handoff\\" + TX + ".windows-worker.json";
  const guard = root + "\\guardian-journal\\." + TX + ".guardian-session-lock";
  const owner = { transactionId: TX, token: "b".repeat(64) };
  let remaining = new Set([guard, handoff]);
  const removed = [];
  const fsImpl = {
    lstat: async (file) => {
      if (!remaining.has(file)) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return { isFile: () => true, isSymbolicLink: () => false, nlink: 1 };
    },
    rm: async (file) => { removed.push(file); remaining.delete(file); },
  };
  let polls = 0;
  const success = await cleanupEquinoxLocalMainUpdateWorkerOwnership({
    transactionId: TX, transactionRoot: root, platform: "win32",
    ownershipToken: owner.token, fsImpl,
    readWindowsOwnershipImpl: async () => assert.fail("Node must not reopen Guardian-owned worker handoff"),
    sleepImpl: async () => { polls++; if (polls === 2) remaining.clear(); },
  });
  assert.equal(success.cleaned, true);
  assert.equal(success.nativeOwner, true);
  assert.deepEqual(removed, []);

  remaining = new Set([guard, handoff]);
  let waits = 0;
  const orphan = await cleanupEquinoxLocalMainUpdateWorkerOwnership({
    transactionId: TX, transactionRoot: root, platform: "win32",
    ownershipToken: owner.token, fsImpl,
    readWindowsOwnershipImpl: async () => assert.fail("Node must not delete an orphan native owner"),
    sleepImpl: async () => { waits++; },
  });
  assert.equal(orphan.cleaned, false);
  assert.equal(orphan.pendingNativeOwner, true);
  assert.equal(waits, 59);
  assert.deepEqual([...remaining].sort(), [guard, handoff].sort());
  assert.deepEqual(removed, []);
});

test("launchd bootstrap failure removes the unpublished worker plist", async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "equinox-scheduler-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const stateRoot = path.join(root, "state");
  const nodePath = path.join(root, "node");
  const workerPath = path.join(sourceRoot, "worker.js");
  await fs.mkdir(sourceRoot); await fs.writeFile(nodePath, "node"); await fs.writeFile(workerPath, "worker");
  await assert.rejects(scheduleEquinoxLocalMainUpdateWorker({ transactionId: TX, sourceRoot, transactionRoot: stateRoot, nodePath, workerPath, uid: 501, execFileImpl: async () => { throw new Error("bootstrap failed"); } }), /bootstrap failed/u);
  const handoffRoot = path.join(stateRoot, "handoff");
  assert.deepEqual(await fs.readdir(handoffRoot), []);
});

test("launchd print failure boots out the partially registered worker and removes plist", async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "equinox-scheduler-print-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const stateRoot = path.join(root, "state");
  const nodePath = path.join(root, "node");
  const workerPath = path.join(sourceRoot, "worker.js");
  await fs.mkdir(sourceRoot); await fs.writeFile(nodePath, "node"); await fs.writeFile(workerPath, "worker");
  const calls = [];
  await assert.rejects(
    scheduleEquinoxLocalMainUpdateWorker({
      transactionId: TX, sourceRoot, transactionRoot: stateRoot, nodePath, workerPath, uid: 501,
      execFileImpl: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "print") throw new Error("print failed");
        return { stdout: "", stderr: "" };
      },
    }),
    /print failed/u,
  );
  assert.equal(calls.some((call) => call[1] === "bootout"), true);
  assert.deepEqual(await fs.readdir(path.join(stateRoot, "handoff")), []);
});

test("worker ownership inspection distinguishes a loaded running job from stale or absent launchd state", async () => {
  const { inspectEquinoxLocalMainUpdateWorkerOwnership } = await import("../../src/equinox-local-main-update-scheduler.js");
  const running = await inspectEquinoxLocalMainUpdateWorkerOwnership({ transactionId: TX, uid: 501, execFileImpl: async () => ({ stdout: "state = running\npid = 123\n" }) });
  assert.equal(running.loaded, true); assert.equal(running.running, true);
  const stale = await inspectEquinoxLocalMainUpdateWorkerOwnership({ transactionId: TX, uid: 501, execFileImpl: async () => ({ stdout: "state = exited\nlast exit code = 1\n" }) });
  assert.equal(stale.loaded, true); assert.equal(stale.running, false);
  const missing = await inspectEquinoxLocalMainUpdateWorkerOwnership({ transactionId: TX, uid: 501, execFileImpl: async () => { throw new Error("not found"); } });
  assert.equal(missing.loaded, false); assert.equal(missing.running, false);
});

test("Windows handoff rejects a symlink worker before contacting the native shell", async () => {
  let handoffCalled = false;
  await assert.rejects(
    scheduleEquinoxLocalMainUpdateWorker({
      transactionId: TX,
      sourceRoot: "C:\\Equinox\\sources\\old",
      transactionRoot: "C:\\Equinox\\state",
      workerPath: "C:\\Equinox\\sources\\new\\src\\equinox-local-main-update-worker.js",
      platform: "win32",
      fsImpl: { lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true }) },
      requestWindowsHandoffImpl: async () => { handoffCalled = true; return { requested: true }; },
    }), /worker executable\/source is unsafe/u,
  );
  assert.equal(handoffCalled, false);
});

test("Windows native worker helper never treats an unknown process or failed inspection as authenticated", async () => {
  const ownership = {
    schemaVersion: 1, transactionId: TX, pid: 4242,
    startTimeUtcTicks: "638953728000000000",
    token: "b".repeat(64), nodePath: "C:\\Equinox\\runtime\\node.exe",
  };
  const helper = "C:\\Equinox\\runtime\\trusted-helper.exe";
  let calls = 0;
  const unknown = await inspectWindowsMainUpdateWorkerProcess(ownership, {
    nativeHelperPath: helper,
    execFileImpl: async (command, args) => {
      assert.equal(command, helper);
      assert.deepEqual(args, ["--inspect-process"]);
      calls += 1;
      return { stdout: "unknown" };
    },
  });
  assert.deepEqual(unknown, { running: false, stale: false, uncertain: true });
  assert.equal(calls, 1);

  await assert.rejects(inspectWindowsMainUpdateWorkerProcess(ownership, {
    nativeHelperPath: helper,
    execFileImpl: async () => {
      calls += 1;
      throw Object.assign(new Error("native identity helper failed"), { code: "ETIMEDOUT" });
    },
  }), /inspection failed.*timeout=true/u);
  assert.equal(calls, 2, "native helper errors must never silently retry or authenticate a worker");
});

test("macOS scheduler refuses a symlinked handoff directory before launching a job", async (t) => {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "equinox-scheduler-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const stateRoot = path.join(root, "state");
  const foreign = path.join(root, "foreign");
  const nodePath = path.join(root, "node");
  const workerPath = path.join(sourceRoot, "worker.js");
  await fs.mkdir(sourceRoot);
  await fs.mkdir(stateRoot);
  await fs.mkdir(foreign);
  await fs.writeFile(nodePath, "node");
  await fs.writeFile(workerPath, "worker");
  await fs.symlink(foreign, path.join(stateRoot, "handoff"), "dir");
  await assert.rejects(
    scheduleEquinoxLocalMainUpdateWorker({
      transactionId: TX, sourceRoot, transactionRoot: stateRoot, nodePath, workerPath, uid: 501,
      execFileImpl: async () => assert.fail("foreign symlink handoff must not reach launchctl"),
    }), /handoff directory is unsafe/u,
  );
  assert.deepEqual(await fs.readdir(foreign), []);
});


test("signed native WPF witness verifies exact process identity without granting native update authority", async () => {
  const nativeHelperPath = String.raw`C:\owned\release\runtime\job\equinox-local-job-object-helper.exe`;
  const identity = { pid: 1425, startTimeUtcTicks: "638953728000000000" };
  const values = [];
  const env = { SystemRoot: String.raw`C:\Windows`, WINDIR: String.raw`C:\Windows`, USERPROFILE: String.raw`C:\Users\Test`,
    OPENAI_API_KEY: "private", GITHUB_TOKEN: "private", NODE_OPTIONS: "--import bad" };
  const inspect = (output) => inspectWindowsOwnedWpfProcess(identity, { nativeHelperPath, sourceEnv: env,
    execFileImpl: async (command, args, options) => {
      values.push([command, args, options]);
      return {stdout: output};
    } });
  assert.deepEqual(await inspect("running"), { running:true, stale:false, uncertain:false });
  assert.deepEqual(await inspect("missing"), { running:false, stale:true, uncertain:false });
  assert.deepEqual(await inspect("mismatch"), { running:false, stale:true, uncertain:false });
  for (const forged of ["unknown", "running-almost", "TRUE", "{\"running\":true}", ""]) {
    assert.deepEqual(await inspect(forged), { running:false, stale:false, uncertain:true });
  }
  assert.equal(values[0][0],nativeHelperPath);
  assert.deepEqual(values[0][1],["--inspect-owned-wpf"]);
  assert.equal(values[0][2].timeout,5000);
  assert.equal(values[0][2].windowsHide,true);
  assert.equal(values[0][2].env.EQUINOX_LOCAL_CHECK_WPF_PID,"1425");
  assert.equal(values[0][2].env.EQUINOX_LOCAL_CHECK_WPF_TICKS,identity.startTimeUtcTicks);
  for (const forbidden of ["OPENAI_API_KEY","GITHUB_TOKEN","NODE_OPTIONS","EQUINOX_LOCAL_CHECK_WPF_EXE"]) {
    assert.equal(values[0][2].env[forbidden],undefined);
  }
  assert.deepEqual(Object.keys(values[0][2].env).sort(),
    ["SystemRoot","WINDIR","USERPROFILE","EQUINOX_LOCAL_CHECK_WPF_PID","EQUINOX_LOCAL_CHECK_WPF_TICKS"].sort());
  for (const wrong of [null, {}, {pid: 0,startTimeUtcTicks:identity.startTimeUtcTicks},
    {pid: 1425,startTimeUtcTicks:"bad"},{...identity, executable:"C:\\malicious.exe"},
    {pid: 0xffffffff+1,startTimeUtcTicks:identity.startTimeUtcTicks}]) {
    await assert.rejects(inspectWindowsOwnedWpfProcess(wrong, {nativeHelperPath,
      execFileImpl: async () => assert.fail("invalid identity reached OS witness")}), /exact PID and process creation time/u);
  }
  await assert.rejects(inspectWindowsOwnedWpfProcess(identity, {nativeHelperPath:String.raw`C:\attacker\helper.exe`,
    execFileImpl:async()=>assert.fail("invalid native helper reached OS")}), /validated native release helper/u);
  await assert.rejects(inspectWindowsOwnedWpfProcess(identity, {nativeHelperPath,
    execFileImpl: async () => { throw new Error("GITHUB_TOKEN=secret; C:\\private\\user"); }}),
    (error) => !error.message.includes("secret") && !error.message.includes("private") && /unverified/u.test(error.message));
});

test("native WPF witness source binds OS current-logon SID/LUID and physical process creation identity", async () => {
  const text = await fs.readFile(new URL("../../native/windows/equinox-local-job-object-helper.cpp",import.meta.url),"utf8");
  assert.match(text,/--inspect-owned-wpf/u);
  assert.match(text,/SHGetKnownFolderPath\(FOLDERID_LocalAppData/u);
  assert.match(text,/GetTokenInformation\(shellToken, TokenStatistics/u);
  assert.match(text,/EqualSid\(/u);
  assert.match(text,/shellSession != ownSession/u);
  assert.match(text,/GetProcessTimes\(shell/u);
  // The opened WPF handle must grant SYNCHRONIZE or the real OS wait returns
  // WAIT_FAILED even for a living shell, hiding a valid owner as unknown.
  assert.match(text,/OpenProcess\(PROCESS_QUERY_LIMITED_INFORMATION \| SYNCHRONIZE, FALSE/u);
  // Other Job Object modes intentionally use terminate rights; the read-only
  // WPF witness must not acquire them.
  const witness = text.slice(text.indexOf("int InspectOwnedWpfProcess()"), text.indexOf("std::string EscapeJson"));
  assert.doesNotMatch(witness,/OpenProcess\(PROCESS_ALL_ACCESS|OpenProcess\(PROCESS_TERMINATE/u);
  assert.match(text,/firstWait != WAIT_TIMEOUT\) return finish\("unknown"\)/u);
  assert.match(text,/finalWait == WAIT_TIMEOUT \? "running"/u);
  assert.match(text,/WaitForSingleObject\(shell, 0\)/u);
  assert.doesNotMatch(text,/EQUINOX_LOCAL_CHECK_WPF_EXE/u);
});


test("same one-shot launchd scheduler starts signed-native B with its own Node and strict transaction-only CLI",async t=>{
 const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"equinox-signed-native-launchd-")));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const stateRoot=path.join(home,"Library","Application Support","Equinox Local","main-update");
 const target="darwin-arm64",sourceSha="b".repeat(40);
 const sourceRoot=path.join(stateRoot,"native-store",target,sourceSha,"release");
 const nodePath=path.join(sourceRoot,"runtime","node","bin","node");
 const workerPath=path.join(sourceRoot,"equinox-local-main-update-worker.js");
 await fs.mkdir(path.dirname(nodePath),{recursive:true,mode:0o700});
 await fs.writeFile(nodePath,"pinned B",{mode:0o700});
 await fs.writeFile(workerPath,"verified B worker",{mode:0o600});
 const calls=[];
 const opts={transactionId:TX,transactionRoot:stateRoot,sourceRoot,nodePath,workerPath,
  sourceSha,target,signedNative:true,platform:"darwin",uid:501,
  sourceEnv:{HOME:home,USER:"example",PATH:"/malicious/bin",
   OPENAI_API_KEY:"secret",EQUINOX_LOCAL_DEV_NODE:"/ambient/bad",
   EQUINOX_LOCAL_RELEASE_DIR:"/old/stable"},
  execFileImpl:async(...call)=>{calls.push(call);return {stdout:"state = running",stderr:""}},
 };
 const result=await scheduleEquinoxLocalMainUpdateWorker(opts);
 assert.equal(result.scheduled,true);
 assert.equal(calls.length,2);
 assert.deepEqual(calls.map(v=>v[1][0]),["bootstrap","print"]);
 const plist=await fs.readFile(result.plistPath,"utf8");
 assert.ok(plist.includes("<string>--signed-native</string>"));
 assert.ok(plist.includes("<string>--transaction-id</string>"));
 assert.ok(plist.includes("<string>--transaction-root</string>"));
 assert.ok(plist.includes("<string>"+workerPath+"</string>"));
 assert.ok(plist.includes("<string>"+nodePath+"</string>"));
 assert.equal(plist.includes("<string>--source-root</string>"),false);
 assert.equal(plist.includes("OPENAI_API_KEY"),false);
 assert.equal(plist.includes("EQUINOX_LOCAL_DEV_NODE"),false);
 assert.equal(plist.includes("EQUINOX_LOCAL_RELEASE_DIR"),false);
 assert.equal(plist.includes("/malicious/bin"),false);
 assert.match(plist,/\/usr\/bin:\/bin:\/usr\/sbin:\/sbin/u);
 assert.equal((await fs.stat(result.plistPath)).mode&0o777,0o600);
});

test("signed-native scheduler refuses ambient Node, different release SHA and Windows fallback before creating plist",async t=>{
 const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"equinox-signed-native-schedule-")));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const stateRoot=path.join(home,"Library","Application Support","Equinox Local","main-update");
 const sourceSha="b".repeat(40),target="darwin-arm64";
 const sourceRoot=path.join(stateRoot,"native-store",target,sourceSha,"release");
 const nodePath=path.join(sourceRoot,"runtime","node","bin","node");
 const workerPath=path.join(sourceRoot,"equinox-local-main-update-worker.js");
 await fs.mkdir(path.dirname(nodePath),{recursive:true,mode:0o700});
 await fs.writeFile(nodePath,"node",{mode:0o700});
 await fs.writeFile(workerPath,"worker",{mode:0o600});
 const base={transactionId:TX,transactionRoot:stateRoot,sourceRoot,nodePath,workerPath,
  sourceSha,target,signedNative:true,platform:"darwin",uid:501,sourceEnv:{HOME:home},
  execFileImpl:async()=>assert.fail("invalid native B must never reach launchctl"),
 };
 for(const patch of [
  {sourceSha:"c".repeat(40)},
  {nodePath:process.execPath},
  {workerPath:nodePath},
  {sourceRoot:path.join(home,"wrong")},
  {platform:"win32"},
  {target:"win32-x64"},
  {sourceEnv:{HOME:"/wrong"}},
 ]){
  await assert.rejects(scheduleEquinoxLocalMainUpdateWorker({...base,...patch}));
 }
 await assert.rejects(fs.lstat(path.join(stateRoot,"handoff",TX+".plist")),{code:"ENOENT"});
});


test("signed native A/B abandoned launchd admission requires TWO exact service-not-found responses and a healthy user service table",async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"equinox-native-absence-")));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const label="dev.equinox.local.main-update."+TX.slice(5);
 const calls=[];
 const absentError=Object.assign(new Error("missing"),{
  code:113,stderr:'Bad request.\nCould not find service "'+label+'" in domain for user gui: 501\n',
 });
 const execFileImpl=async(_file,args)=>{
  calls.push(args.join(" "));
  if(args[0]==="print" && args[1]==="gui/501/"+label)throw absentError;
  if(args[0]==="print" && args[1]==="gui/501")return {stdout:"domain = gui/501"};
  if(args[0]==="list")return {stdout:"PID\tStatus\tLabel\n-\t0\tcom.apple.SafariHistoryServiceAgent\n"};
  throw Error("unexpected command");
 };
 const result=await assertEquinoxLocalSignedMacWorkerNeverStarted({
  transactionId:TX,transactionRoot:root,uid:501,currentUid:501,execFileImpl,
  sleepImpl:async()=>{},
 });
 assert.equal(result.absent,true);
 assert.equal(calls.length,6,"service, domain, list repeated twice");
 assert.deepEqual(calls.slice(0,3),["print gui/501/"+label,"print gui/501","list"]);
});

test("signed native launchd absence fails closed for loaded/running/uncertain services and ambiguous command errors",async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"equinox-native-absence-denial-")));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const label="dev.equinox.local.main-update."+TX.slice(5);
 const absent=Object.assign(new Error("missing"),{code:113,
  stderr:'Could not find service "'+label+'" in domain for user gui: 501',
 });
 const base={transactionId:TX,transactionRoot:root,uid:501,currentUid:501,
  sleepImpl:async()=>{}};
 for(const failure of ["loaded","permission","generic","listed","malformed","changed"]){
  let calls=0;
  const execFileImpl=async(_file,args)=>{
   calls++;
   if(args[0]==="print" && args[1]==="gui/501/"+label){
    if(failure==="loaded")return {stdout:"state = running"};
    if(failure==="permission")throw Object.assign(Error("permission"),{code:1,
      stderr:"Permission denied"});
    if(failure==="generic")throw Object.assign(Error("error"),{code:113,stderr:"Bad request"});
    if(failure==="changed" && calls>3)return {stdout:"state = running"};
    throw absent;
   }
   if(args[0]==="print" && args[1]==="gui/501")return {stdout:"domain = gui/501"};
   if(args[0]==="list")return {stdout:failure==="malformed"?"unexpected":
    "PID\tStatus\tLabel\n"+(failure==="listed"?"-\t0\t"+label+"\n":"")};
   throw Error("unexpected");
  };
  await assert.rejects(assertEquinoxLocalSignedMacWorkerNeverStarted({...base,execFileImpl}),
   /cancellation forbidden|not conclusively absent|not unambiguously readable/u);
 }
 const handoff=path.join(root,"handoff",TX+".plist");
 await fs.mkdir(path.dirname(handoff),{recursive:true});
 await fs.writeFile(handoff,"plisted",{mode:0o600});
 await assert.rejects(assertEquinoxLocalSignedMacWorkerNeverStarted({...base,
  execFileImpl:async()=>assert.fail("existing plist prohibits probes"),
 }),/plist still exists/u);
 await assert.rejects(assertEquinoxLocalSignedMacWorkerNeverStarted({...base,uid:502,
  execFileImpl:async()=>assert.fail("foreign uid must not probe"),
 }),/owning non-root launchd/u);
});
