import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_PAUSED_ERROR_CODE,
  createAgentControlController,
} from "../../src/equinox-local-agent-control.js";

function fakeManager(idKey, ids = []) {
  const state = new Map(ids.map((id) => [id, true]));
  const stops = [];
  return {
    stops,
    list: () => [...state].map(([id, running]) => ({ [idKey]: id, running })),
    stop: async (input) => {
      const id = input[idKey];
      stops.push(input);
      state.set(id, false);
      return { [idKey]: id, running: false };
    },
  };
}

test("emergency pause becomes effective before draining managed work", async () => {
  const terminalManager = fakeManager("sessionId", ["t1", "t2"]);
  const processManager = fakeManager("processId", ["p1"]);
  const events = [];
  const controller = createAgentControlController({
    terminalManager,
    processManager,
    onEvent: async (event) => events.push(event),
    now: () => Date.parse("2026-09-10T12:00:00.000Z"),
  });

  assert.equal(controller.snapshot().state, "ACTIVE");
  const paused = await controller.pause();
  assert.equal(paused.state, "PAUSED");
  assert.equal(paused.activeWork.total, 0);
  assert.equal(paused.lastStop.requestedTerminals, 2);
  assert.equal(paused.lastStop.requestedProcesses, 1);
  assert.equal(terminalManager.stops.length, 2);
  assert.equal(processManager.stops.length, 1);
  assert.equal(events[0].type, "agent.paused_by_user");
  assert.equal(events.at(-1).type, "agent.emergency_stop_completed");

  assert.throws(
    () => controller.assertMutationAllowed("terminal_exec"),
    (error) => error?.code === AGENT_PAUSED_ERROR_CODE && /paused by the user/u.test(error.message),
  );
});

test("resume re-enables mutations without restarting stopped work", async () => {
  const terminalManager = fakeManager("sessionId", ["t1"]);
  const processManager = fakeManager("processId", ["p1"]);
  const controller = createAgentControlController({ terminalManager, processManager });

  await controller.pause();
  const resumed = await controller.resume();
  assert.equal(resumed.state, "ACTIVE");
  assert.equal(resumed.activeWork.total, 0);
  assert.doesNotThrow(() => controller.assertMutationAllowed("terminal_exec"));
});

test("pause and resume are idempotent", async () => {
  const terminalManager = fakeManager("sessionId");
  const processManager = fakeManager("processId");
  const controller = createAgentControlController({ terminalManager, processManager });

  const first = await controller.pause();
  const second = await controller.pause();
  assert.equal(first.pauseCount, 1);
  assert.equal(second.pauseCount, 1);
  await controller.resume();
  const secondResume = await controller.resume();
  assert.equal(secondResume.state, "ACTIVE");
});

test("emergency stop blocks mutations before any delayed worker stop completes", async () => {
  let started;
  const stopping = new Promise((resolve) => { started = resolve; });
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const terminalManager = {
    list: () => [{ sessionId: "t1", running: true }],
    stop: async (options) => {
      calls.push(options);
      started();
      await blocker;
      return { sessionId: options.sessionId, running: false };
    },
  };
  const processManager = fakeManager("processId");
  const controller = createAgentControlController({
    terminalManager,
    processManager,
    now: () => Date.parse("2026-10-20T00:00:00.000Z"),
  });
  const pendingPause = controller.pause({ reason: "user_emergency_stop" });
  await stopping;
  assert.throws(
    () => controller.assertMutationAllowed("terminal_exec"),
    (error) => error?.code === AGENT_PAUSED_ERROR_CODE && error.operation === "terminal_exec",
  );
  assert.equal(controller.snapshot().state, "PAUSED");
  assert.equal(controller.snapshot().lastStop, null);
  release();
  const finished = await pendingPause;
  assert.equal(finished.lastStop.requestedTerminals, 1);
  assert.equal(calls.length, 1);
  assert.equal(finished.state, "PAUSED");
});

test("rejected managed stops retain the PAUSED gate and record partial failures without exposing worker errors", async () => {
  const events = [];
  const terminalManager = {
    list: () => [{ sessionId: "t1", running: true }],
    stop: async () => { throw new Error("internal credential-like detail"); },
  };
  const processManager = fakeManager("processId", ["p1"]);
  const controller = createAgentControlController({
    terminalManager,
    processManager,
    onEvent: async (event) => { events.push(event); },
    now: () => Date.parse("2026-10-20T00:01:00.000Z"),
  });
  const paused = await controller.pause();
  assert.equal(paused.state, "PAUSED");
  assert.equal(paused.lastStop.failureCount, 1);
  assert.equal(paused.lastStop.requestedTerminals, 1);
  assert.equal(paused.lastStop.requestedProcesses, 1);
  assert.equal(events.at(-1).status, "partial");
  assert.equal(events.at(-1).severity, "warn");
  assert.doesNotMatch(JSON.stringify(events), /credential-like detail/u);
  assert.throws(() => controller.assertMutationAllowed("process_start"), (error) =>
    error?.code === AGENT_PAUSED_ERROR_CODE && error.operation === "process_start");
  assert.equal(Object.isFrozen(paused), true);
  assert.equal(Object.isFrozen(paused.lastStop), true);
});

test("concurrent pause and resume requests serialize without duplicated stops or out-of-order events", async () => {
  const terminalManager = fakeManager("sessionId", ["t1"]);
  const processManager = fakeManager("processId", ["p1"]);
  const events = [];
  const controller = createAgentControlController({
    terminalManager,
    processManager,
    onEvent: async (event) => { events.push(event.type); },
    now: () => Date.parse("2026-10-20T00:02:00.000Z"),
  });
  const results = await Promise.all([
    controller.pause(), controller.pause(), controller.resume(), controller.resume(),
  ]);
  assert.deepEqual(results.map((item) => item.state), ["PAUSED", "PAUSED", "ACTIVE", "ACTIVE"]);
  assert.equal(results[3].pauseCount, 1);
  assert.equal(terminalManager.stops.length, 1);
  assert.equal(processManager.stops.length, 1);
  assert.deepEqual(events, ["agent.paused_by_user", "agent.emergency_stop_completed", "agent.resumed_by_user"]);
  assert.doesNotThrow(() => controller.assertMutationAllowed("terminal_exec"));
});

test("agent control refuses missing manager authority and a non-callable event publisher", () => {
  const valid = { list: () => [], stop: async () => null };
  for (const options of [
    {}, { terminalManager: {}, processManager: valid },
    { terminalManager: valid, processManager: {} },
    { terminalManager: valid, processManager: valid, onEvent: 123 },
  ]) {
    assert.throws(() => createAgentControlController(options), /Agent control/u);
  }
});
