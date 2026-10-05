import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mainUpdateWorkerEnvironment, scheduleEquinoxLocalMainUpdateWorker } from "../../src/equinox-local-main-update-scheduler.js";

const TX = `main-${"a".repeat(32)}`;

test("main update worker environment is minimal and credential-free", () => {
  const env = mainUpdateWorkerEnvironment({ HOME: "/Users/example", USER: "example", LOGNAME: "example", TMPDIR: "/tmp/x", EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: "/private/runtime.conf", EQUINOX_LOCAL_DEV_NODE: "/runtime/node", OPENAI_API_KEY: "secret", GITHUB_TOKEN: "secret" });
  assert.deepEqual(env, { HOME: "/Users/example", USER: "example", LOGNAME: "example", TMPDIR: "/tmp/x", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: "/private/runtime.conf", EQUINOX_LOCAL_DEV_NODE: "/runtime/node" });
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
