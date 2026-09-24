import assert from "node:assert/strict";
import test from "node:test";

import { createMcpToolReplayGuard } from "../../src/mcp-tool-replay-guard.js";

function extra(requestId, { sessionId = "session-a", signal } = {}) {
  return {
    requestId,
    sessionId,
    signal: signal ?? new AbortController().signal,
  };
}

test("same MCP request id reuses the original invocation promise and result", async () => {
  const replays = [];
  const guard = createMcpToolReplayGuard({ onReplay: (event) => replays.push(event) });
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const firstExtra = extra("req-1");

  const first = guard.run({
    toolName: "runtime_call",
    input: { operation: "terminal_exec", arguments: { command: "npm test" } },
    extra: firstExtra,
    invoke: async () => {
      calls += 1;
      await pending;
      return { processId: "proc-1" };
    },
  });
  const replay = guard.run({
    toolName: "runtime_call",
    input: { operation: "terminal_exec", arguments: { command: "npm test" } },
    extra: firstExtra,
    invoke: async () => {
      calls += 1;
      return { processId: "proc-2" };
    },
  });

  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { processId: "proc-1" });
  assert.deepEqual(await replay, { processId: "proc-1" });
  assert.equal(calls, 1);
  assert.equal(replays.length, 1);
  assert.equal(replays[0].mode, "request_id");
});

test("a recycled request id with different arguments executes as a new invocation", async () => {
  const guard = createMcpToolReplayGuard();
  let calls = 0;

  assert.equal(await guard.run({
    toolName: "runtime_call",
    input: { operation: "terminal_exec", arguments: { command: "echo one" } },
    extra: extra(7),
    invoke: async () => ++calls,
  }), 1);

  assert.equal(await guard.run({
    toolName: "runtime_call",
    input: { operation: "terminal_exec", arguments: { command: "echo two" } },
    extra: extra(7),
    invoke: async () => ++calls,
  }), 2);
  assert.equal(calls, 2);
});

test("a settled request id recycled for identical arguments executes again with a new transport signal", async () => {
  const guard = createMcpToolReplayGuard();
  let calls = 0;
  const input = { operation: "terminal_exec", arguments: { command: "echo same" } };

  assert.equal(await guard.run({
    toolName: "runtime_call",
    input,
    extra: extra("recycled"),
    invoke: async () => ++calls,
  }), 1);

  assert.equal(await guard.run({
    toolName: "runtime_call",
    input,
    extra: extra("recycled"),
    invoke: async () => ++calls,
  }), 2);
  assert.equal(calls, 2);
});

test("an in-flight invocation still deduplicates when request id is redelivered with a new signal", async () => {
  const guard = createMcpToolReplayGuard();
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const input = { operation: "terminal_exec", arguments: { command: "long task" } };

  const first = guard.run({
    toolName: "runtime_call",
    input,
    extra: extra("req-inflight"),
    invoke: async () => {
      calls += 1;
      await pending;
      return "done";
    },
  });
  const replay = guard.run({
    toolName: "runtime_call",
    input,
    extra: extra("req-inflight"),
    invoke: async () => {
      calls += 1;
      return "duplicate";
    },
  });

  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal(await first, "done");
  assert.equal(await replay, "done");
  assert.equal(calls, 1);
});

test("a new intentional identical request executes again when the prior transport was not aborted", async () => {
  const guard = createMcpToolReplayGuard();
  let calls = 0;
  const input = { operation: "terminal_exec", arguments: { command: "echo hi" } };

  assert.equal(await guard.run({
    toolName: "runtime_call",
    input,
    extra: extra("req-1"),
    invoke: async () => ++calls,
  }), 1);
  assert.equal(await guard.run({
    toolName: "runtime_call",
    input,
    extra: extra("req-2"),
    invoke: async () => ++calls,
  }), 2);
  assert.equal(calls, 2);
});

test("same semantic call with a new request id reuses an aborted transport invocation", async () => {
  let currentTime = 1_000;
  const replays = [];
  const guard = createMcpToolReplayGuard({
    now: () => currentTime,
    onReplay: (event) => replays.push(event),
  });
  const controller = new AbortController();
  let calls = 0;
  const input = { operation: "runtime_call", arguments: { command: "long task" } };

  assert.equal(await guard.run({
    toolName: "runtime_call",
    input,
    extra: extra("req-1", { sessionId: "old", signal: controller.signal }),
    invoke: async () => ++calls,
  }), 1);

  controller.abort();
  currentTime += 1_000;
  assert.equal(await guard.run({
    toolName: "runtime_call",
    input,
    extra: extra("req-2", { sessionId: "new" }),
    invoke: async () => ++calls,
  }), 1);
  assert.equal(calls, 1);
  assert.equal(replays.at(-1).mode, "aborted_semantic");
});
