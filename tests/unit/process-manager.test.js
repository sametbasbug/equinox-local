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
    queueMicrotask(() => child.emit("exit", null, signal));
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
      return child;
    },
    killImpl: (pid, signal) => {
      killCalls.push({ pid, signal });
      queueMicrotask(() => child.emit("exit", 0, signal));
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
