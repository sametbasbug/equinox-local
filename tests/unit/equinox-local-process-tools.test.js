import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";

import { registerProcessTools } from "../../src/equinox-local-process-tools.js";

function createHarness(overrides = {}) {
  const registrations = new Map();
  const calls = [];
  const manager = {
    start(input) {
      calls.push(["start", input]);
      return { processId: "proc-1" };
    },
    async readLogs(input) {
      calls.push(["readLogs", input]);
      return {
        process: { processId: input.processId, running: true },
        output: "ready",
        nextCursor: 5,
      };
    },
    list() {
      calls.push(["list"]);
      return [
        { processId: "proc-1", running: true },
        { processId: "proc-2", running: false },
      ];
    },
    async waitForExit(input) {
      calls.push(["waitForExit", input]);
      if (input.processId === "missing") {
        throw new Error("Bilinmeyen süreç kimliği: missing");
      }
      return {
        processId: input.processId,
        running: input.processId === "proc-running",
        exitCode: input.processId === "proc-signal" ? null : 7,
        signal: input.processId === "proc-signal" ? "SIGTERM" : null,
      };
    },
    snapshotOutput(input) {
      calls.push(["snapshotOutput", input]);
      const running = input.processId === "proc-running";
      return {
        process: {
          processId: input.processId,
          running,
          exitCode: running || input.processId === "proc-signal" ? null : 7,
          signal: input.processId === "proc-signal" ? "SIGTERM" : null,
          spawnError: null,
        },
        nextCursor: 12,
        stdout: "out",
        stderr: "err",
        combinedOutput: "[stdout] out[stderr] err",
        stdoutTruncated: false,
        stderrTruncated: false,
        combinedOutputTruncated: false,
        stdoutDroppedChars: 0,
        stderrDroppedChars: 0,
        combinedOutputDroppedChars: 0,
      };
    },
    async stop(input) {
      calls.push(["stop", input]);
      return { processId: input.processId, running: false };
    },
  };

  const textResult = (text) => ({ content: [{ type: "text", text }] });
  const errorResult = (error) => ({
    content: [{ type: "text", text: `Hata: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  });

  registerProcessTools({
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    z,
    processManager: manager,
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
    textResult,
    errorResult,
    ...overrides,
  });

  return { registrations, calls };
}

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

test("process tools preserve start routing, env projection and initial logs", async () => {
  const harness = createHarness();
  assert.deepEqual([...harness.registrations.keys()], [
    "process_start",
    "process_list",
    "process_logs",
    "process_wait",
    "process_stop",
  ]);

  const result = parseText(await harness.registrations.get("process_start").handler({
    command: "npm",
    args: ["run", "dev"],
    cwd: ".",
    env: { PORT: "3000", NPM_TOKEN: "should-not-leak", SAFE_FLAG: "yes" },
    label: "preview",
    expected_ports: [3000],
    startup_wait_ms: 750,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.initialOutput, "ready");
  assert.equal(result.nextCursor, 5);

  const [, startInput] = harness.calls[0];
  assert.equal(startInput.projectId, "local");
  assert.equal(startInput.cwd, "/tmp/project");
  assert.equal(startInput.command, "npm");
  assert.deepEqual(startInput.args, ["run", "dev"]);
  assert.deepEqual(startInput.expectedPorts, [3000]);
  assert.equal(startInput.env.PORT, "3000");
  assert.equal(startInput.env.SAFE_FLAG, "yes");
  assert.equal(startInput.env.OPENAI_API_KEY, undefined);
  assert.equal(startInput.env.GH_TOKEN, undefined);
  assert.equal(startInput.env.NPM_TOKEN, undefined);
  assert.equal(startInput.env.EQUINOX_PROJECT_ROOT, "/tmp/project");
  assert.equal(startInput.env.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/custom/bin");
  assert.deepEqual(harness.calls[1], [
    "readLogs",
    { processId: "proc-1", cursor: 0, maxChars: 20_000, stripAnsiCodes: true, waitMs: 750 },
  ]);
});

test("process list/logs/stop adapters preserve filtering and mutation scope", async () => {
  const harness = createHarness();
  const list = harness.registrations.get("process_list");
  assert.equal(list.options.projectAware, false);
  const running = parseText(await list.handler({ state: "running" }));
  assert.equal(running.count, 1);
  assert.equal(running.processes[0].processId, "proc-1");

  const logs = harness.registrations.get("process_logs");
  assert.deepEqual(parseText(await logs.handler({
    process_id: "proc-1",
    cursor: 2,
    max_chars: 500,
    strip_ansi: false,
    wait_ms: 25,
  })), {
    process: { processId: "proc-1", running: true },
    output: "ready",
    nextCursor: 5,
  });

  const stop = harness.registrations.get("process_stop");
  assert.deepEqual(stop.options, { projectAware: false, mutationScopes: ["global"] });
  assert.equal(parseText(await stop.handler({
    process_id: "proc-1",
    force: true,
    remove: false,
  })).process.running, false);
});


test("process wait reuses managed lifecycle, preserves timeout state and bounded output", async () => {
  const harness = createHarness();
  const wait = harness.registrations.get("process_wait");
  assert.equal(wait.options.projectAware, false);
  assert.equal(wait.config.annotations.readOnlyHint, true);

  const completed = parseText(await wait.handler({
    process_id: "proc-exited",
    wait_ms: 30_000,
    max_chars: 4_000,
    strip_ansi: true,
  }));
  assert.equal(completed.completed, true);
  assert.equal(completed.waitExpired, false);
  assert.equal(completed.process.exitCode, 7);
  assert.equal(completed.process.signal, null);
  assert.equal(completed.combinedOutput, "[stdout] out[stderr] err");
  assert.equal(completed.nextCursor, 12);
  assert.equal("stdout" in completed, false);
  assert.equal("stderr" in completed, false);
  assert.deepEqual(harness.calls.slice(-2), [
    ["waitForExit", { processId: "proc-exited", waitMs: 30_000 }],
    ["snapshotOutput", { processId: "proc-exited", maxChars: 4_000, stripAnsiCodes: true }],
  ]);

  const running = parseText(await wait.handler({
    process_id: "proc-running",
    wait_ms: 25,
    max_chars: 1_000,
    strip_ansi: false,
  }));
  assert.equal(running.completed, false);
  assert.equal(running.waitExpired, true);
  assert.equal(running.process.running, true);
  assert.equal(harness.calls.some(([name]) => name === "stop"), false);

  const nonblocking = parseText(await wait.handler({
    process_id: "proc-running",
    wait_ms: 0,
    max_chars: 1_000,
    strip_ansi: true,
  }));
  assert.equal(nonblocking.completed, false);
  assert.equal(nonblocking.waitExpired, false);

  const signaled = parseText(await wait.handler({
    process_id: "proc-signal",
    wait_ms: 1,
    max_chars: 1_000,
    strip_ansi: true,
  }));
  assert.equal(signaled.completed, true);
  assert.equal(signaled.process.exitCode, null);
  assert.equal(signaled.process.signal, "SIGTERM");

  const missing = await wait.handler({
    process_id: "missing",
    wait_ms: 1,
    max_chars: 1_000,
    strip_ansi: true,
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Bilinmeyen süreç kimliği/u);
});

test("process start fails closed when process access is disabled", async () => {
  const harness = createHarness({ agentAccess: { terminal: false } });
  const result = await harness.registrations.get("process_start").handler({
    command: "npm",
    args: [],
    cwd: ".",
    expected_ports: [],
    startup_wait_ms: 0,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Terminal ve süreç erişimi Control Center'da kapalı/u);
  assert.equal(harness.calls.length, 0);
});
