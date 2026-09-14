import assert from "node:assert/strict";
import test from "node:test";

import { deriveEquinoxLocalPresentationState } from "../../src/equinox-local-presentation-state.js";

const NOW = Date.parse("2026-09-12T18:00:00.000Z");

function baseStatus(overrides = {}) {
  return {
    health: { state: "HEALTHY" },
    agentControl: { state: "ACTIVE", paused: false, activeWork: { terminals: 0, processes: 0, total: 0 } },
    browser: { contexts: { agent: { ready: true } } },
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    taskId: "task-example-1",
    title: "Build native presentation foundation",
    status: "active",
    checkpointRevision: 2,
    updatedAt: "2026-09-12T17:59:00.000Z",
    completedAt: null,
    continuation: null,
    freshResume: null,
    ...overrides,
  };
}

test("presentation state prioritizes emergency stop over active task work", () => {
  const presentation = deriveEquinoxLocalPresentationState({
    status: baseStatus({
      agentControl: { state: "PAUSED", paused: true, activeWork: { terminals: 0, processes: 0, total: 0 } },
    }),
    tasks: [task()],
    now: NOW,
  });

  assert.equal(presentation.state, "emergency_stopped");
  assert.equal(presentation.runtime.paused, true);
  assert.equal(presentation.task.taskId, "task-example-1");
  assert.equal(presentation.notification, null);
});

test("active task alone remains idle while preserving bounded task context", () => {
  const presentation = deriveEquinoxLocalPresentationState({ status: baseStatus(), tasks: [task()], now: NOW });

  assert.equal(presentation.state, "idle");
  assert.equal(presentation.label, "Idle");
  assert.equal(presentation.browser.agentReady, true);
  assert.equal(presentation.task.title, "Build native presentation foundation");
});

test("managed active work drives working state independently of task lifetime", () => {
  const presentation = deriveEquinoxLocalPresentationState({
    status: baseStatus({
      agentControl: { state: "ACTIVE", paused: false, activeWork: { terminals: 1, processes: 0, total: 1 } },
    }),
    tasks: [task()],
    now: NOW,
  });

  assert.equal(presentation.state, "working");
  assert.equal(presentation.label, "Working");
  assert.equal(presentation.detail, "1 managed operation active");
  assert.equal(presentation.task.title, "Build native presentation foundation");
});

test("presentation state marks pending continuation as waiting", () => {
  const presentation = deriveEquinoxLocalPresentationState({
    status: baseStatus(),
    tasks: [task({ continuation: { status: "armed" } })],
    now: NOW,
  });

  assert.equal(presentation.state, "waiting");
  assert.equal(presentation.task.continuationStatus, "armed");
});

test("ambiguous Fresh Chat Resume becomes attention state and notification candidate", () => {
  const presentation = deriveEquinoxLocalPresentationState({
    status: baseStatus(),
    tasks: [task({ freshResume: { status: "ambiguous", resumeId: "resume-example" } })],
    now: NOW,
  });

  assert.equal(presentation.state, "needs_attention");
  assert.equal(presentation.notification.kind, "fresh_resume_attention");
  assert.equal(presentation.notification.taskId, "task-example-1");
  assert.match(presentation.notification.id, /^fresh-resume-attention:/u);
});

test("recent task completion produces transient success state and stable notification id", () => {
  const completed = task({
    status: "completed",
    updatedAt: "2026-09-12T17:59:40.000Z",
    completedAt: "2026-09-12T17:59:40.000Z",
  });
  const first = deriveEquinoxLocalPresentationState({ status: baseStatus(), tasks: [completed], now: NOW });
  const second = deriveEquinoxLocalPresentationState({ status: baseStatus(), tasks: [completed], now: NOW + 5_000 });

  assert.equal(first.state, "success");
  assert.equal(first.notification.kind, "task_completed");
  assert.equal(first.notification.id, second.notification.id);
});

test("old task completion returns idle without stale notification", () => {
  const completed = task({
    status: "completed",
    updatedAt: "2026-09-12T17:40:00.000Z",
    completedAt: "2026-09-12T17:40:00.000Z",
  });
  const presentation = deriveEquinoxLocalPresentationState({ status: baseStatus(), tasks: [completed], now: NOW });

  assert.equal(presentation.state, "idle");
  assert.equal(presentation.notification, null);
  assert.equal(presentation.task, null);
});
