import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupEquinoxLocalMainUpdateWorkerOwnership,
  inspectEquinoxLocalMainUpdateWorkerOwnership,
  inspectWindowsMainUpdateWorkerProcess,
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
  assert.equal(calls[0].command, "powershell.exe");
  assert.deepEqual(calls[0].args.slice(-3), ["4242", ownership.startTimeUtcTicks, ownership.nodePath]);

  const reused = await inspectWindowsMainUpdateWorkerProcess(ownership, {
    execFileImpl: async () => ({ stdout: "mismatch" }),
  });
  assert.deepEqual(reused, { running: false, stale: true, uncertain: false });

  const unknown = await inspectWindowsMainUpdateWorkerProcess(ownership, {
    execFileImpl: async () => ({ stdout: "unknown" }),
  });
  assert.deepEqual(unknown, { running: false, stale: false, uncertain: true });
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
