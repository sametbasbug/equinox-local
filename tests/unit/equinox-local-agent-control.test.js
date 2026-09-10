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
