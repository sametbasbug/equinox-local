import test from "node:test";
import assert from "node:assert/strict";

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
