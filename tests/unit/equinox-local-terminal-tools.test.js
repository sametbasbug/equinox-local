import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";

import { registerTerminalTools } from "../../src/equinox-local-terminal-tools.js";

function createHarness(overrides = {}) {
  const registrations = new Map();
  const calls = [];
  const events = [];
  const manager = {
    async start(input) {
      calls.push(["start", input]);
      return { sessionId: "term-1", cwd: input.cwd, shell: input.shell };
    },
    list() {
      calls.push(["list"]);
      return [{ sessionId: "term-1" }];
    },
    async read(input) {
      calls.push(["read", input]);
      return { nextCursor: 12, output: "hello" };
    },
    write(input) {
      calls.push(["write", input]);
      return { sessionId: input.sessionId };
    },
    resize(input) {
      calls.push(["resize", input]);
      return { sessionId: input.sessionId, cols: input.cols, rows: input.rows };
    },
    async stop(input) {
      calls.push(["stop", input]);
      return { sessionId: input.sessionId, running: false };
    },
  };
  let processSequence = 0;
  let processStarted = false;
  const processState = {
    processId: "proc-exec-1",
    projectId: "local",
    projectName: "Equinox Local",
    cwd: "/tmp/project",
    command: "/bin/zsh",
    args: [],
    purpose: "terminal_exec",
    running: true,
    exitCode: null,
    signal: null,
    spawnError: null,
  };
  const processManager = {
    start(input) {
      calls.push(["processStart", input]);
      processSequence += 1;
      processStarted = true;
      Object.assign(processState, {
        processId: `proc-exec-${processSequence}`,
        projectId: input.projectId,
        projectName: input.projectName,
        cwd: input.cwd,
        command: input.command,
        args: [...input.args],
        purpose: input.purpose,
        running: true,
        exitCode: null,
        signal: null,
        spawnError: null,
      });
      return { ...processState, args: [...processState.args] };
    },
    list() {
      calls.push(["processList"]);
      return processStarted ? [{ ...processState, args: [...processState.args] }] : [];
    },
    async waitForExit(input) {
      calls.push(["processWait", input]);
      processState.running = false;
      processState.exitCode = 0;
      return { ...processState };
    },
    snapshotOutput(input) {
      calls.push(["processSnapshot", input]);
      return {
        process: { ...processState },
        nextCursor: 12,
        stdout: "ok\n",
        stderr: "",
        combinedOutput: "[stdout] ok\n",
        stdoutTruncated: false,
        stderrTruncated: false,
        combinedOutputTruncated: false,
        stdoutDroppedChars: 0,
        stderrDroppedChars: 0,
        combinedOutputDroppedChars: 0,
      };
    },
    async stop(input) {
      calls.push(["processStop", input]);
      processState.running = false;
      if (input.remove) processStarted = false;
      return { ...processState, running: false };
    },
  };

  const textResult = (text) => ({ content: [{ type: "text", text }] });
  const errorResult = (error) => ({
    content: [{ type: "text", text: `Hata: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  });

  registerTerminalTools({
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    z,
    terminalManager: manager,
    processManager,
    agentAccess: { terminal: true },
    safeResolve: async (value) => `/tmp/project/${value === "." ? "" : value}`.replace(/\/$/u, ""),
    fsImpl: { stat: async () => ({ isDirectory: () => true }) },
    getActiveProjectId: () => "local",
    getActiveProjectName: () => "Equinox Local",
    getActiveProjectRoot: () => "/tmp/project",
    runtimeEnv: {
      PATH: "/custom/bin",
      HOME: "/tmp/home",
      OPENAI_API_KEY: "should-not-leak",
      GH_TOKEN: "should-not-leak",
    },
    recordEvent: async (event) => { events.push(event); },
    textResult,
    errorResult,
    ...overrides,
  });

  return { registrations, calls, manager, processManager, processState, events };
}

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

test("terminal tools preserve registration metadata and start routing", async () => {
  const harness = createHarness();
  assert.deepEqual([...harness.registrations.keys()], [
    "terminal_exec",
    "terminal_start",
    "terminal_list",
    "terminal_read",
    "terminal_write",
    "terminal_resize",
    "terminal_stop",
  ]);

  const exec = harness.registrations.get("terminal_exec");
  assert.equal(exec.config.annotations.openWorldHint, true);
  assert.equal(exec.config.annotations.destructiveHint, true);
  assert.deepEqual(exec.options, { mutationScopes: ["global"] });
  const execResult = parseText(await exec.handler({
    command: "git status && rg terminal src",
    cwd: ".",
    wait_ms: 30_000,
    max_output_chars: 40_000,
  }));
  assert.equal(execResult.ok, true);
  assert.equal(execResult.stdout, "ok\n");
  assert.equal(execResult.combinedOutput, "[stdout] ok\n");
  assert.equal(execResult.projectId, "local");
  assert.equal(execResult.projectName, "Equinox Local");
  assert.equal(execResult.initialCwd, "/tmp/project");
  assert.equal(execResult.completed, true);
  assert.equal(execResult.promoted, false);
  const processStart = harness.calls.find(([name]) => name === "processStart");
  assert.ok(processStart);
  assert.equal(processStart[1].cwd, "/tmp/project");
  assert.equal(processStart[1].command, "/bin/zsh");
  assert.deepEqual(processStart[1].args, ["-lc", "git status && rg terminal src"]);
  assert.equal(processStart[1].purpose, "terminal_exec");
  assert.equal(processStart[1].env.OPENAI_API_KEY, undefined);
  assert.equal(processStart[1].env.GH_TOKEN, undefined);
  assert.equal(processStart[1].env.PAGER, "cat");
  assert.equal(processStart[1].env.GIT_PAGER, "cat");
  assert.equal(processStart[1].env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(processStart[1].env.NO_COLOR, "1");
  assert.ok(harness.calls.some(([name, input]) => name === "processStop" && input.remove === true));
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].type, "terminal.exec_completed");
  assert.equal(harness.events[0].projectId, "local");
  assert.equal("command" in harness.events[0].details, false);
  assert.equal("cwd" in harness.events[0].details, false);
  assert.equal("stdout" in harness.events[0].details, false);

  const start = harness.registrations.get("terminal_start");
  assert.equal(start.config.annotations.openWorldHint, true);
  const result = parseText(await start.handler({
    cwd: ".",
    shell: "zsh",
    cols: 120,
    rows: 30,
    label: "audit",
  }));
  assert.equal(result.ok, true);
  assert.equal(result.session.shell, "/bin/zsh");

  const [, input] = harness.calls.find(([name]) => name === "start");
  assert.equal(input.projectId, "local");
  assert.equal(input.projectName, "Equinox Local");
  assert.equal(input.cwd, "/tmp/project");
  assert.equal(input.shell, "/bin/zsh");
  assert.deepEqual(input.shellArgs, ["-l"]);
  assert.equal(input.env.EQUINOX_PROJECT_ID, "local");
  assert.equal(input.env.EQUINOX_PROJECT_ROOT, "/tmp/project");
  assert.equal(input.env.OPENAI_API_KEY, undefined);
  assert.equal(input.env.GH_TOKEN, undefined);
  assert.equal(
    input.env.PATH,
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/custom/bin",
  );
});

test("terminal tools route Windows finite and interactive shells through the shared platform contract", async () => {
  const harness = createHarness({
    platform: "win32",
    arch: "x64",
    runtimeEnv: { PATH: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\Example" },
  });

  const exec = harness.registrations.get("terminal_exec");
  const execResult = parseText(await exec.handler({
    command: "Write-Output ok", cwd: ".", wait_ms: 30_000, max_output_chars: 40_000,
  }));
  assert.equal(execResult.ok, true);
  const processStart = harness.calls.find(([name]) => name === "processStart");
  assert.equal(processStart[1].command, "powershell.exe");
  assert.deepEqual(processStart[1].args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output ok"]);
  assert.equal(processStart[1].env.PATH, "C:\\Windows\\System32");

  const start = harness.registrations.get("terminal_start");
  const parsed = start.config.inputSchema.shell.safeParse("powershell");
  assert.equal(parsed.success, true);
  assert.equal(start.config.inputSchema.shell.safeParse("zsh").success, false);
  const result = parseText(await start.handler({ cwd: ".", shell: "powershell", cols: 120, rows: 30 }));
  assert.equal(result.ok, true);
  const terminalStart = harness.calls.find(([name]) => name === "start");
  assert.equal(terminalStart[1].shell, "powershell.exe");
  assert.deepEqual(terminalStart[1].shellArgs, ["-NoLogo", "-NoProfile"]);
  assert.equal(terminalStart[1].env.PATH, "C:\\Windows\\System32");
});

test("terminal_exec promotes an unfinished command without killing or restarting it", async () => {
  const harness = createHarness();
  harness.processManager.waitForExit = async (input) => {
    harness.calls.push(["processWait", input]);
    return { ...harness.processState, running: true };
  };

  const result = parseText(await harness.registrations.get("terminal_exec").handler({
    command: "npm test",
    cwd: ".",
    wait_ms: 25,
    max_output_chars: 5000,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.completed, false);
  assert.equal(result.promoted, true);
  assert.equal(result.processId, "proc-exec-1");
  assert.equal(result.nextCursor, 12);
  assert.match(result.next, /process_logs/u);
  assert.equal(harness.calls.filter(([name]) => name === "processStart").length, 1);
  assert.equal(harness.calls.some(([name]) => name === "processStop"), false);
  assert.equal(harness.events.at(-1).type, "terminal.exec_promoted");
});


test("terminal_exec reuses one promoted exact managed process across a replayed delivery", async () => {
  let currentTime = 1_000;
  const harness = createHarness({ now: () => currentTime });
  harness.processManager.waitForExit = async (input) => {
    harness.calls.push(["processWait", input]);
    return { ...harness.processState, running: true };
  };
  const exec = harness.registrations.get("terminal_exec");
  const input = { command: "npm run gate:public", cwd: ".", wait_ms: 120_000, max_output_chars: 5000 };

  const first = parseText(await exec.handler(input));
  assert.equal(first.promoted, true);
  assert.equal(first.processId, "proc-exec-1");

  currentTime += 2_000;
  const replay = parseText(await exec.handler(input));
  assert.equal(replay.promoted, true);
  assert.equal(replay.replayRecovered, true);
  assert.equal(replay.processId, "proc-exec-1");
  assert.equal(harness.calls.filter(([name]) => name === "processStart").length, 1);
  assert.equal(harness.calls.filter(([name]) => name === "processWait").length, 1);
});


test("terminal_exec replay lease expires even while an identical managed process is still running", async () => {
  let currentTime = 1_000;
  const harness = createHarness({ now: () => currentTime });
  harness.processManager.waitForExit = async (input) => {
    harness.calls.push(["processWait", input]);
    return { ...harness.processState, running: true };
  };
  const exec = harness.registrations.get("terminal_exec");
  const input = { command: "npm run gate:public", cwd: ".", wait_ms: 120_000, max_output_chars: 5000 };

  assert.equal(parseText(await exec.handler(input)).processId, "proc-exec-1");
  currentTime += 5 * 60 * 1000 + 1;
  assert.equal(parseText(await exec.handler(input)).processId, "proc-exec-2");
  assert.equal(harness.calls.filter(([name]) => name === "processStart").length, 2);
});

test("terminal_exec starts a fresh identical command after the promoted process has exited", async () => {
  let currentTime = 1_000;
  const harness = createHarness({ now: () => currentTime });
  harness.processManager.waitForExit = async (input) => {
    harness.calls.push(["processWait", input]);
    return { ...harness.processState, running: true };
  };
  const exec = harness.registrations.get("terminal_exec");
  const input = { command: "npm run gate:public", cwd: ".", wait_ms: 120_000, max_output_chars: 5000 };

  const first = parseText(await exec.handler(input));
  assert.equal(first.processId, "proc-exec-1");
  harness.processState.running = false;
  harness.processState.exitCode = 0;
  currentTime += 2_000;

  const second = parseText(await exec.handler(input));
  assert.equal(second.processId, "proc-exec-2");
  assert.equal(second.replayRecovered, undefined);
  assert.equal(harness.calls.filter(([name]) => name === "processStart").length, 2);
});

test("terminal read/write/resize/stop adapters preserve argument mapping and global mutation scopes", async () => {
  const harness = createHarness();

  const list = harness.registrations.get("terminal_list");
  assert.equal(list.options.projectAware, false);
  assert.deepEqual(parseText(await list.handler({})).sessions, [{ sessionId: "term-1" }]);

  const read = harness.registrations.get("terminal_read");
  assert.equal(read.options.projectAware, false);
  assert.deepEqual(parseText(await read.handler({
    session_id: "term-1",
    cursor: 4,
    max_chars: 500,
    strip_ansi: false,
    wait_ms: 25,
  })), { nextCursor: 12, output: "hello" });

  for (const name of ["terminal_write", "terminal_resize", "terminal_stop"]) {
    assert.deepEqual(harness.registrations.get(name).options, {
      projectAware: false,
      mutationScopes: ["global"],
    });
  }

  assert.equal(parseText(await harness.registrations.get("terminal_write").handler({
    session_id: "term-1",
    data: "pwd",
    key: "enter",
  })).ok, true);
  assert.equal(parseText(await harness.registrations.get("terminal_resize").handler({
    session_id: "term-1",
    cols: 100,
    rows: 25,
  })).session.cols, 100);
  assert.equal(parseText(await harness.registrations.get("terminal_stop").handler({
    session_id: "term-1",
    force: true,
    remove: false,
  })).session.running, false);

  assert.deepEqual(harness.calls.slice(-4), [
    ["read", { sessionId: "term-1", cursor: 4, maxChars: 500, stripAnsiCodes: false, waitMs: 25 }],
    ["write", { sessionId: "term-1", data: "pwd", key: "enter" }],
    ["resize", { sessionId: "term-1", cols: 100, rows: 25 }],
    ["stop", { sessionId: "term-1", force: true, remove: false }],
  ]);
});

test("terminal mutation adapters fail closed when terminal access is disabled", async () => {
  const harness = createHarness({ agentAccess: { terminal: false } });
  const exec = await harness.registrations.get("terminal_exec").handler({
    command: "echo nope",
    cwd: ".",
    wait_ms: 1000,
    max_output_chars: 5000,
  });
  const start = await harness.registrations.get("terminal_start").handler({
    cwd: ".",
    shell: "bash",
    cols: 120,
    rows: 30,
  });
  const write = await harness.registrations.get("terminal_write").handler({
    session_id: "term-1",
    data: "echo nope",
  });
  assert.equal(exec.isError, true);
  assert.equal(start.isError, true);
  assert.equal(write.isError, true);
  assert.match(start.content[0].text, /Terminal erişimi Control Center'da kapalı/u);
  assert.equal(harness.calls.length, 0);
});
