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

test("same in-flight semantic call with a new request id reuses the original invocation", async () => {
  let currentTime = 1_000;
  const replays = [];
  const guard = createMcpToolReplayGuard({
    now: () => currentTime,
    onReplay: (event) => replays.push(event),
  });
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const input = { operation: "terminal_exec", arguments: { project: "/tmp/repo", command: "npm run gate:full" } };

  const first = guard.run({
    toolName: "runtime_call",
    input,
    extra: extra("req-original", { sessionId: "session-old" }),
    invoke: async () => {
      calls += 1;
      await pending;
      return { processId: "proc-original", exitCode: 0 };
    },
  });
  await Promise.resolve();
  assert.equal(calls, 1);

  currentTime += 2 * 60 * 1000;
  const replay = guard.run({
    toolName: "runtime_call",
    input,
    extra: extra("req-replayed", { sessionId: "session-new" }),
    invoke: async () => {
      calls += 1;
      return { processId: "proc-duplicate", exitCode: 0 };
    },
  });
  await Promise.resolve();
  assert.equal(calls, 1, "transport replay must not spawn a second semantic terminal invocation");

  release();
  assert.deepEqual(await first, { processId: "proc-original", exitCode: 0 });
  assert.deepEqual(await replay, { processId: "proc-original", exitCode: 0 });
  assert.equal(calls, 1);
  assert.equal(replays.at(-1).mode, "inflight_semantic");
});

test("in-flight semantic dedup expires so a stale invocation cannot suppress a later call forever", async () => {
  let currentTime = 1_000;
  const guard = createMcpToolReplayGuard({ now: () => currentTime, inFlightReplayWindowMs: 1_000 });
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const input = { operation: "terminal_exec", arguments: { command: "long task" } };
  const first = guard.run({
    toolName: "runtime_call",
    input,
    extra: extra("req-old"),
    invoke: async () => { calls += 1; await pending; return "old"; },
  });
  await Promise.resolve();
  currentTime += 1_001;
  const second = guard.run({
    toolName: "runtime_call",
    input,
    extra: extra("req-new"),
    invoke: async () => { calls += 1; return "new"; },
  });
  assert.equal(await second, "new");
  assert.equal(calls, 2);
  release();
  assert.equal(await first, "old");
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

test("replay telemetry throwing synchronously does not repeat a side effect or break the original result",async()=>{
  let calls=0;
  const guard=createMcpToolReplayGuard({
    onReplay:()=>{throw Error("observability unavailable: private diagnostics")},
  });
  const firstExtra=extra("once",{sessionId:"session-owned"});
  const invocation={toolName:"runtime_call",
    input:{operation:"terminal_exec",arguments:{command:"mutating command"}},
    extra:firstExtra};
  const first=guard.run({...invocation,invoke:async()=>{calls++;return{operationId:"owned"}}});
  const replay=guard.run({...invocation,invoke:async()=>{calls++;return{operationId:"duplicate"}}});
  assert.equal(first,replay);
  assert.deepEqual(await replay,{operationId:"owned"});
  assert.equal(calls,1);
});

test("canonical equivalent arguments replay while different argument values and sessions remain intentional calls after settlement",async()=>{
  const observed=[];
  const guard=createMcpToolReplayGuard({onReplay:event=>observed.push(event)});
  let calls=0;
  let resolve;
  const barrier=new Promise(r=>{resolve=r});
  const first=guard.run({toolName:"integrations_call",
    input:{arguments:{mode:"replace",details:{z:1,a:2},extra:undefined},operation:"save"},
    extra:extra("delivery-1",{sessionId:"one"}),
    invoke:async()=>{calls++;await barrier;return"first"}});
  const replay=guard.run({toolName:"integrations_call",
    input:{operation:"save",arguments:{details:{a:2,z:1},mode:"replace"}},
    extra:extra("delivery-2",{sessionId:"two"}),
    invoke:async()=>{calls++;return"should not repeat"}});
  resolve();
  assert.equal(await first,"first");
  assert.equal(await replay,"first");
  assert.equal(calls,1);
  assert.equal(observed.at(-1).mode,"inflight_semantic");
  const intentional=await guard.run({toolName:"integrations_call",
    input:{operation:"save",arguments:{details:{a:2,z:1},mode:"replace"}},
    extra:extra("new-intent",{sessionId:"three"}),
    invoke:async()=>{calls++;return"new"}});
  assert.equal(intentional,"new");
  assert.equal(calls,2);
});

test("settled replay records expire and aborted semantic replay window does not suppress a later new invocation",async()=>{
  let now=1_000,calls=0;
  const controller=new AbortController();
  const guard=createMcpToolReplayGuard({
    now:()=>now,settledTtlMs:100,abortReplayWindowMs:60,maxRecords:2,
  });
  const op={toolName:"runtime_call",input:{operation:"terminal_exec",arguments:{command:"verify"}}};
  const first=await guard.run({...op,extra:extra("original",{signal:controller.signal}),
    invoke:async()=>++calls});
  assert.equal(first,1);
  controller.abort();
  now+=61;
  const newCall=await guard.run({...op,extra:extra("fresh"),
    invoke:async()=>++calls});
  assert.equal(newCall,2);
  now+=101;
  assert.equal(await guard.run({...op,extra:extra("after-expiry"),
    invoke:async()=>++calls}),3);
  assert.equal(calls,3);
  assert.ok(guard.snapshot().records<=2);
});
