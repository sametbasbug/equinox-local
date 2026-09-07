import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createTerminalManager,
  __test,
} from "../../src/terminal-manager.js";

class FakeTerminal {
  constructor(pid = 4242) {
    this.pid = pid;
    this.dataHandlers = [];
    this.exitHandlers = [];
    this.writes = [];
    this.resizes = [];
    this.kills = [];
  }

  onData(handler) {
    this.dataHandlers.push(handler);
  }

  onExit(handler) {
    this.exitHandlers.push(handler);
  }

  write(value) {
    this.writes.push(value);
  }

  resize(cols, rows) {
    this.resizes.push([cols, rows]);
  }

  kill(signal) {
    this.kills.push(signal);
    this.emitExit(0, signal === "SIGKILL" ? 9 : 1);
  }

  emitData(value) {
    for (const handler of this.dataHandlers) {
      handler(value);
    }
  }

  emitExit(exitCode = 0, signal = 0) {
    for (const handler of this.exitHandlers) {
      handler({ exitCode, signal });
    }
  }
}

function makeManager(options = {}) {
  const terminals = [];
  let tick = 1_000;

  const manager = createTerminalManager({
    ptyModuleLoader: async () => ({
      spawn: () => {
        const terminal = new FakeTerminal(4_000 + terminals.length);
        terminals.push(terminal);
        return terminal;
      },
    }),
    now: () => tick++,
    randomId: () => `id${terminals.length}`,
    resolveProcessTtyImpl: async () => "ttys999",
    listTtyProcessPidsImpl: async () => terminals.map((terminal) => terminal.pid),
    pidExistsImpl: (pid) => terminals.some((terminal) => terminal.pid === pid),
    ...options,
  });

  return { manager, terminals };
}

async function startFake(manager) {
  return manager.start({
    projectId: "workspace",
    projectName: "Selene Workspace",
    cwd: "/tmp/workspace",
    shell: "/bin/zsh",
    shellArgs: ["-l"],
    env: {},
    cols: 100,
    rows: 25,
  });
}

test("terminal manager starts, writes, resizes and stops a PTY", async () => {
  const { manager, terminals } = makeManager();
  const session = await startFake(manager);

  assert.equal(session.sessionId, "term-id0");
  assert.equal(session.running, true);
  assert.equal(session.pid, 4000);

  manager.write({
    sessionId: session.sessionId,
    data: "printf test",
    key: "enter",
  });

  assert.deepEqual(
    terminals[0].writes,
    ["printf test", "\r"],
  );

  manager.resize({
    sessionId: session.sessionId,
    cols: 140,
    rows: 40,
  });

  assert.deepEqual(terminals[0].resizes, [[140, 40]]);

  const stopped = await manager.stop({
    sessionId: session.sessionId,
  });

  assert.equal(stopped.running, false);
  assert.deepEqual(terminals[0].kills, ["SIGHUP"]);
});

test("terminal reads use stable cursors and strip ANSI codes", async () => {
  const { manager, terminals } = makeManager();
  const session = await startFake(manager);

  terminals[0].emitData("\u001b[31mhello\u001b[0m\r\nworld");

  const first = await manager.read({
    sessionId: session.sessionId,
    cursor: 0,
    maxChars: 10_000,
    stripAnsiCodes: true,
  });

  assert.equal(first.output, "hello\nworld");
  assert.equal(first.nextCursor, first.session.cursor);
  assert.equal(first.hasMore, false);

  terminals[0].emitData("!");

  const second = await manager.read({
    sessionId: session.sessionId,
    cursor: first.nextCursor,
    maxChars: 10,
    stripAnsiCodes: true,
  });

  assert.equal(second.output, "!");
});

test("terminal buffer reports dropped cursor data", async () => {
  const { manager, terminals } = makeManager({
    maxBufferChars: 5,
  });
  const session = await startFake(manager);

  terminals[0].emitData("123456789");

  const result = await manager.read({
    sessionId: session.sessionId,
    cursor: 0,
    maxChars: 20,
  });

  assert.equal(result.cursorWasDropped, true);
  assert.equal(result.effectiveCursor, 4);
  assert.equal(result.output, "56789");
});

test("terminal session limit is enforced", async () => {
  const { manager } = makeManager({
    maxActiveSessions: 1,
  });

  await startFake(manager);

  await assert.rejects(
    () => startFake(manager),
    /en fazla 1 terminal/u,
  );
});

test("terminal session limit reserves capacity across async PTY loading", async () => {
  let resolveLoader;
  const terminal = new FakeTerminal(5001);
  const manager = createTerminalManager({
    maxActiveSessions: 1,
    ptyModuleLoader: () => new Promise((resolve) => {
      resolveLoader = resolve;
    }),
    resolveProcessTtyImpl: async () => "ttys998",
    listTtyProcessPidsImpl: async () => [5001],
    pidExistsImpl: (pid) => pid === 5001,
    randomId: () => "reserve1",
  });

  const firstStart = startFake(manager);
  for (let attempt = 0; attempt < 20 && typeof resolveLoader !== "function"; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof resolveLoader, "function");

  await assert.rejects(
    () => startFake(manager),
    /en fazla 1 terminal/u,
  );

  resolveLoader({ spawn: () => terminal });
  const first = await firstStart;
  assert.equal(first.running, true);
  await manager.stop({ sessionId: first.sessionId });
});

test("terminal start reservation is released after spawn failure", async () => {
  let spawnAttempts = 0;
  const terminal = new FakeTerminal(5002);
  const manager = createTerminalManager({
    maxActiveSessions: 1,
    ptyModuleLoader: async () => ({
      spawn: () => {
        spawnAttempts += 1;
        if (spawnAttempts === 1) throw new Error("synthetic spawn failure");
        return terminal;
      },
    }),
    resolveProcessTtyImpl: async () => "ttys997",
    listTtyProcessPidsImpl: async () => [5002],
    pidExistsImpl: (pid) => pid === 5002,
    randomId: () => "reserve2",
  });

  await assert.rejects(
    () => startFake(manager),
    /synthetic spawn failure/u,
  );

  const second = await startFake(manager);
  assert.equal(second.running, true);
  await manager.stop({ sessionId: second.sessionId });
});

test("ANSI stripping removes CSI sequences", () => {
  assert.equal(
    __test.stripAnsi("a\u001b[2Kb\u001b[31mc\u001b[0m"),
    "abc",
  );
});

test("installed node-pty can spawn and interact with zsh", async () => {
  if (process.platform !== "darwin") {
    return;
  }

  const module = await import("node-pty");
  const spawn = module.spawn ?? module.default?.spawn;
  assert.equal(typeof spawn, "function");

  const terminal = spawn("/bin/zsh", ["-f"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: "/tmp",
    env: {
      ...process.env,
      TERM: "xterm-256color",
    },
  });

  let output = "";

  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      terminal.kill("SIGKILL");
      reject(new Error("node-pty smoke testi zaman aşımına uğradı."));
    }, 5_000);

    terminal.onData((data) => {
      output += data;
    });

    terminal.onExit(() => {
      clearTimeout(timer);
      resolve();
    });
  });

  terminal.write("printf '__EQUINOX_PTY_OK__\\n'; exit\r");
  await completed;

  assert.match(output, /__EQUINOX_PTY_OK__/u);
});


test("Darwin TTY parser selects only the requested PTY", () => {
  assert.deepEqual(
    __test.parseDarwinTtyProcessPids([
      " 100 ttys001",
      " 101 ttys001",
      " 200 ttys002",
      " garbage",
      " 102 /dev/ttys001",
      "",
    ].join("\n"), "ttys001"),
    [100, 101, 102],
  );
});

async function waitForPidFile(pidFile, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("PTY child pid file was not created in time.");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

async function createResistantPtyChildFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-pty-session-"));
  const childScript = path.join(root, "child.mjs");
  const pidFile = path.join(root, "child.pid");
  await fs.writeFile(childScript, [
    'import fs from "node:fs";',
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    'process.on("SIGHUP", () => {});',
    'process.on("SIGTERM", () => {});',
    'setInterval(() => {}, 1000);',
  ].join("\n"));
  return { root, childScript, pidFile };
}

test("real PTY stop drains a resistant background job from the owned controlling TTY", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS PTY process-session semantics are required");
    return;
  }

  const fixture = await createResistantPtyChildFixture();
  const manager = createTerminalManager();
  let childPid = null;
  try {
    const started = await manager.start({
      projectId: "local",
      projectName: "Equinox Local",
      cwd: fixture.root,
      shell: "/bin/zsh",
      shellArgs: ["-f"],
      env: process.env,
      cols: 100,
      rows: 25,
    });
    manager.write({
      sessionId: started.sessionId,
      data: `${shellQuote(process.execPath)} ${shellQuote(fixture.childScript)} &`,
      key: "enter",
    });
    childPid = await waitForPidFile(fixture.pidFile);

    const stopped = await manager.stop({
      sessionId: started.sessionId,
      timeoutMs: 300,
    });
    assert.equal(stopped.running, false);
    assert.equal(stopped.cleanupVerified, true);
    assert.throws(() => process.kill(childPid, 0), (error) => error?.code === "ESRCH");
  } finally {
    await manager.shutdown();
    if (Number.isInteger(childPid) && childPid > 0) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("natural PTY shell exit also drains resistant background jobs before finalizing", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS PTY process-session semantics are required");
    return;
  }

  const fixture = await createResistantPtyChildFixture();
  const manager = createTerminalManager({ ownershipMonitorMs: 40, naturalExitOwnershipFreshMs: 120 });
  let childPid = null;
  try {
    const started = await manager.start({
      projectId: "local",
      projectName: "Equinox Local",
      cwd: fixture.root,
      shell: "/bin/zsh",
      shellArgs: ["-f"],
      env: process.env,
      cols: 100,
      rows: 25,
    });
    manager.write({
      sessionId: started.sessionId,
      data: `${shellQuote(process.execPath)} ${shellQuote(fixture.childScript)} &`,
      key: "enter",
    });
    childPid = await waitForPidFile(fixture.pidFile);
    await new Promise((resolve) => setTimeout(resolve, 220));
    manager.write({ sessionId: started.sessionId, data: "disown %1; exit", key: "enter" });

    const deadline = Date.now() + 3000;
    let finalSession = null;
    while (Date.now() < deadline) {
      finalSession = manager.list().find((item) => item.sessionId === started.sessionId);
      if (finalSession && !finalSession.running) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(finalSession);
    assert.equal(finalSession.running, false);
    assert.equal(finalSession.cleanupVerified, true);
    assert.throws(() => process.kill(childPid, 0), (error) => error?.code === "ESRCH");
  } finally {
    await manager.shutdown();
    if (Number.isInteger(childPid) && childPid > 0) {
      try { process.kill(childPid, "SIGKILL"); } catch {}
    }
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
