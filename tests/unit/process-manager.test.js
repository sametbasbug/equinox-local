import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer } from "node:net";

import {
  createProcessManager,
  parseLsofFieldOutput,
  probeTcpPort,
} from "../../src/process-manager.js";

function makeFakeProcess(pid = 4100) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    queueMicrotask(() => {
      child.emit("exit", null, signal);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", null, signal);
    });
    return true;
  };
  return child;
}

test("process manager starts, captures logs and stops a process group", async () => {
  const child = makeFakeProcess(4200);
  const killCalls = [];
  const manager = createProcessManager({
    spawnImpl: (command, args, options) => {
      assert.equal(command, "npm");
      assert.deepEqual(args, ["run", "dev"]);
      assert.equal(options.cwd, "/tmp/project");
      assert.equal(options.detached, true);
      assert.equal(options.shell, false);
      assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
      return child;
    },
    killImpl: (pid, signal) => {
      killCalls.push({ pid, signal });
      queueMicrotask(() => {
        child.emit("exit", 0, signal);
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, signal);
      });
    },
    randomId: () => "test0001",
  });

  const started = manager.start({
    projectId: "blog",
    projectName: "Ana Blog",
    cwd: "/tmp/project",
    command: "npm",
    args: ["run", "dev"],
    expectedPorts: [4321],
  });

  assert.equal(started.processId, "proc-test0001");
  assert.equal(started.running, true);
  assert.deepEqual(started.expectedPorts, [4321]);

  child.stdout.write("ready\n");
  child.stderr.write("warning\n");

  const logs = await manager.readLogs({
    processId: started.processId,
  });

  assert.match(logs.output, /\[stdout\] ready/u);
  assert.match(logs.output, /\[stderr\] warning/u);
  assert.equal(logs.hasMore, false);

  const stopped = await manager.stop({
    processId: started.processId,
  });

  assert.equal(stopped.running, false);
  assert.deepEqual(killCalls, [
    { pid: -4200, signal: "SIGTERM" },
  ]);
});

test("process manager exposes bounded separate and ordered output snapshots", async () => {
  const child = makeFakeProcess(4240);
  const manager = createProcessManager({
    spawnImpl: () => child,
    randomId: () => "snapshot1",
  });
  const started = manager.start({
    projectId: "local",
    projectName: "Equinox Local",
    cwd: "/tmp",
    command: "node",
    args: ["script.js"],
  });

  child.stdout.write("one\n");
  child.stderr.write("two\n");
  const snapshot = manager.snapshotOutput({
    processId: started.processId,
    maxChars: 1000,
    stripAnsiCodes: true,
  });
  assert.equal(snapshot.stdout, "one\n");
  assert.equal(snapshot.stderr, "two\n");
  assert.equal(snapshot.combinedOutput, "[stdout] one\n[stderr] two\n");
  assert.equal(snapshot.nextCursor, snapshot.process.cursor);
  assert.equal(snapshot.combinedOutputTruncated, false);

  child.emit("exit", 0, null);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  const exited = await manager.waitForExit({ processId: started.processId, waitMs: 100 });
  assert.equal(exited.running, false);
  assert.equal(exited.exitCode, 0);
  await manager.shutdown();
});

test("process wait expiry leaves the exact managed process running", async () => {
  const child = makeFakeProcess(4245);
  const manager = createProcessManager({
    spawnImpl: () => child,
    randomId: () => "waitkeep1",
  });
  const started = manager.start({
    projectId: "local",
    projectName: "Equinox Local",
    cwd: "/tmp",
    command: "node",
    args: ["slow.js"],
  });
  const afterWait = await manager.waitForExit({
    processId: started.processId,
    waitMs: 5,
  });
  assert.equal(afterWait.processId, started.processId);
  assert.equal(afterWait.pid, started.pid);
  assert.equal(afterWait.running, true);
  child.emit("exit", 0, null);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  await manager.shutdown();
});

test("process manager keeps descendants managed after the group leader exits", async () => {
  const child = makeFakeProcess(4250);
  const killCalls = [];
  let groupAlive = true;
  const manager = createProcessManager({
    spawnImpl: () => child,
    killImpl: (pid, signal) => {
      killCalls.push({ pid, signal });
      groupAlive = false;
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0, null);
      });
    },
    groupExistsImpl: () => groupAlive,
    groupPollMs: 5,
    randomId: () => "group001",
  });

  const started = manager.start({
    projectId: "local",
    projectName: "Equinox Local",
    cwd: "/tmp",
    command: "node",
    args: ["leader.js"],
  });

  child.emit("exit", 0, null);
  await new Promise((resolve) => setImmediate(resolve));

  const afterLeaderExit = manager.list().find(
    (item) => item.processId === started.processId,
  );
  assert.equal(afterLeaderExit.running, true);

  const stopped = await manager.stop({
    processId: started.processId,
    timeoutMs: 100,
  });

  assert.equal(stopped.running, false);
  assert.deepEqual(killCalls, [{ pid: -4250, signal: "SIGTERM" }]);
});

test("process manager finalizes after the last descendant exits naturally", async () => {
  const child = makeFakeProcess(4260);
  let groupAlive = true;
  const manager = createProcessManager({
    spawnImpl: () => child,
    groupExistsImpl: () => groupAlive,
    groupPollMs: 5,
    randomId: () => "group002",
  });

  const started = manager.start({
    projectId: "local",
    projectName: "Equinox Local",
    cwd: "/tmp",
    command: "node",
    args: ["leader.js"],
  });

  child.emit("exit", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.list()[0].running, true);

  groupAlive = false;
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = manager.list().find((item) => item.processId === started.processId);
    if (!current?.running) {
      assert.equal(current.exitCode, 0);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.fail("Descendant process group was not reaped after becoming empty.");
});

test("process manager retains late stdout after exit until close", async () => {
  const child = makeFakeProcess(4270);
  const manager = createProcessManager({
    spawnImpl: () => child,
    groupExistsImpl: () => false,
    randomId: () => "lateout1",
  });

  const started = manager.start({
    projectId: "local",
    projectName: "Equinox Local",
    cwd: "/tmp",
    command: "node",
    args: ["leader.js"],
  });

  child.emit("exit", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.list().find((item) => item.processId === started.processId).running, true);

  child.stdout.write("late-output\n");
  const beforeClose = await manager.readLogs({ processId: started.processId });
  assert.match(beforeClose.output, /late-output/u);
  assert.equal(beforeClose.process.running, true);

  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.list().find((item) => item.processId === started.processId).running, false);
});

test("process log cursors remain stable and report dropped data", async () => {
  const child = makeFakeProcess(4300);
  const manager = createProcessManager({
    spawnImpl: () => child,
    maxBufferChars: 24,
    randomId: () => "test0002",
  });

  const started = manager.start({
    projectId: "workspace",
    projectName: "Selene Workspace",
    cwd: "/tmp",
    command: "node",
    args: ["server.js"],
  });

  child.stdout.write("\u001b[31m12345678901234567890\u001b[0m");

  const logs = await manager.readLogs({
    processId: started.processId,
    cursor: 0,
  });

  assert.equal(logs.cursorWasDropped, true);
  assert.ok(logs.effectiveCursor > 0);
  assert.doesNotMatch(logs.output, /\u001b/u);

  child.emit("exit", 0, null);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 0, null);
  await manager.shutdown();
});

test("process manager enforces active process limit and port lookup", () => {
  let nextPid = 4400;
  const manager = createProcessManager({
    spawnImpl: () => makeFakeProcess(nextPid++),
    maxActiveProcesses: 1,
    randomId: (() => {
      let counter = 0;
      return () => `limit${counter += 1}`;
    })(),
  });

  manager.start({
    projectId: "ai",
    projectName: "AI Sitesi",
    cwd: "/tmp",
    command: "npm",
    args: ["run", "dev"],
    expectedPorts: [4173, 4321, 4321],
  });

  assert.equal(manager.findByPort(4321).length, 1);
  assert.deepEqual(
    manager.findByPort(4321)[0].expectedPorts,
    [4173, 4321],
  );

  assert.throws(
    () => manager.start({
      projectId: "ai",
      projectName: "AI Sitesi",
      cwd: "/tmp",
      command: "npm",
      args: ["run", "preview"],
    }),
    /en fazla 1/u,
  );
});

test("terminal_exec-purpose non-zero exit is a command result, not a runtime crash", async () => {
  const child = makeFakeProcess(4440);
  const events = [];
  const manager = createProcessManager({
    spawnImpl: () => child,
    randomId: () => "cmdexit1",
    onEvent: (event) => events.push(event),
  });
  const started = manager.start({
    projectId: "local",
    projectName: "Equinox Local",
    cwd: "/tmp",
    command: "/bin/zsh",
    args: ["-lc", "rg no-match"],
    purpose: "terminal_exec",
  });
  child.emit("exit", 1, null);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 1, null);
  await manager.waitForExit({ processId: started.processId, waitMs: 100 });

  const exited = events.find((event) => event.type === "process.exited");
  assert.ok(exited);
  assert.equal(events.some((event) => event.type === "process.crashed"), false);
  assert.equal(events[0].details.command, "/bin/zsh");
  assert.equal(events[0].details.purpose, "terminal_exec");
  assert.equal("args" in events[0].details, false);
});

test("process lifecycle emits observability events without command arguments", async () => {
  const child = makeFakeProcess(4450);
  const events = [];
  const manager = createProcessManager({
    spawnImpl: () => child,
    randomId: () => "events01",
    onEvent: (event) => events.push(event),
  });

  const started = manager.start({
    projectId: "local",
    projectName: "Equinox Local",
    cwd: "/tmp",
    command: "node",
    args: ["--secret-looking-argument"],
  });
  child.emit("exit", 7, null);
  child.stdout.end();
  child.stderr.end();
  child.emit("close", 7, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events[0].type, "process.started");
  assert.equal(events[0].details.argumentCount, 1);
  assert.equal("args" in events[0].details, false);
  const crashed = events.find((event) => event.type === "process.crashed");
  assert.ok(crashed);
  assert.equal(crashed.correlationId, started.processId);
  assert.equal(crashed.details.exitCode, 7);
});

test("lsof field output is parsed into listener records", () => {
  const records = parseLsofFieldOutput([
    "p123",
    "cnode",
    "n127.0.0.1:4321",
    "p456",
    "cpython3",
    "n*:8000",
    "",
  ].join("\n"));

  assert.deepEqual(records, [
    {
      pid: 123,
      command: "node",
      endpoint: "127.0.0.1:4321",
    },
    {
      pid: 456,
      command: "python3",
      endpoint: "*:8000",
    },
  ]);
});

test("TCP port probe distinguishes listening and closed ports", async () => {
  const server = createServer();
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");

  const open = await probeTcpPort({
    host: "127.0.0.1",
    port: address.port,
    timeoutMs: 1000,
  });

  assert.equal(open.listening, true);

  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });

  const closed = await probeTcpPort({
    host: "127.0.0.1",
    port: address.port,
    timeoutMs: 1000,
  });

  assert.equal(closed.listening, false);
});

test("real managed foreground wait preserves one PID through continuation", async () => {
  const manager = createProcessManager();
  const started = manager.start({
    projectId: "local",
    projectName: "Equinox Local",
    cwd: process.cwd(),
    command: process.execPath,
    args: [
      "-e",
      "console.log('continuation-start'); setTimeout(() => console.log('continuation-end'), 250)",
    ],
    label: "real-continuation-test",
  });

  const first = await manager.waitForExit({
    processId: started.processId,
    waitMs: 25,
  });
  assert.equal(first.running, true);
  assert.equal(first.processId, started.processId);
  assert.equal(first.pid, started.pid);

  const firstSnapshot = manager.snapshotOutput({
    processId: started.processId,
    maxChars: 10_000,
  });
  assert.equal(firstSnapshot.process.pid, started.pid);

  const completed = await manager.waitForExit({
    processId: started.processId,
    waitMs: 2_000,
  });
  assert.equal(completed.running, false);
  assert.equal(completed.processId, started.processId);
  assert.equal(completed.pid, started.pid);
  assert.equal(completed.exitCode, 0);

  const finalSnapshot = manager.snapshotOutput({
    processId: started.processId,
    maxChars: 10_000,
  });
  assert.match(finalSnapshot.combinedOutput, /continuation-start/u);
  assert.match(finalSnapshot.combinedOutput, /continuation-end/u);
  await manager.stop({ processId: started.processId, remove: true });
  assert.equal(manager.list().some((item) => item.processId === started.processId), false);
});

test("real managed process produces output and exits", async () => {
  const manager = createProcessManager();
  const started = manager.start({
    projectId: "local",
    projectName: "Equinox Local",
    cwd: process.cwd(),
    command: process.execPath,
    args: [
      "-e",
      "console.log('process-manager-real-ok')",
    ],
    label: "real-node-test",
  });

  const logs = await manager.readLogs({
    processId: started.processId,
    waitMs: 3000,
  });

  assert.match(logs.output, /process-manager-real-ok/u);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = manager.list().find(
      (item) => item.processId === started.processId,
    );

    if (!current?.running) {
      assert.equal(current.exitCode, 0);
      await manager.shutdown();
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  await manager.shutdown();
  assert.fail("Gerçek süreç zamanında kapanmadı.");
});
