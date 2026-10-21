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


test("incomplete managed onboarding becomes shared setup-required presentation", () => {
  const presentation = deriveEquinoxLocalPresentationState({
    status: baseStatus(),
    onboarding: { available: true, setupComplete: false, needsAttention: false, connectedThroughTunnel: false },
    now: NOW,
  });

  assert.equal(presentation.state, "setup_required");
  assert.equal(presentation.label, "Setup Required");
  assert.equal(presentation.detail, "Open Control Center to finish first-time setup");
  assert.deepEqual(presentation.setup, { available: true, complete: false, needsAttention: false });
});

test("setup attention uses shared presentation without overriding emergency stop", () => {
  const onboarding = { available: true, setupComplete: false, needsAttention: true, issue: "Tunnel configuration needs attention." };
  const attention = deriveEquinoxLocalPresentationState({ status: baseStatus(), onboarding, now: NOW });
  assert.equal(attention.state, "needs_attention");
  assert.equal(attention.detail, "Tunnel configuration needs attention.");

  const stopped = deriveEquinoxLocalPresentationState({
    status: baseStatus({
      agentControl: { state: "PAUSED", paused: true, activeWork: { terminals: 0, processes: 0, total: 0 } },
    }),
    onboarding,
    now: NOW,
  });
  assert.equal(stopped.state, "emergency_stopped");
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

test("presentation never exposes unbounded task titles in notifications or task summaries", () => {
  const longTitle = "private-task-prefix:" + "x".repeat(500) + ":private-tail";
  const item = task({ title: longTitle, freshResume: { status: "ambiguous", resumeId: "resume-1" } });
  const output = deriveEquinoxLocalPresentationState({
    status: baseStatus(), tasks: [item], now: NOW,
  });
  assert.equal(output.state, "needs_attention");
  assert.equal(output.task.title.length, 120);
  assert.ok(output.task.title.endsWith("…"));
  assert.equal(output.notification.kind, "fresh_resume_attention");
  assert.equal(output.notification.body.length, 120 + " needs Fresh Chat Resume recovery.".length);
  assert.doesNotMatch(JSON.stringify(output), /private-tail/u);
  assert.equal(Object.isFrozen(output), true);
  assert.equal(Object.isFrozen(output.runtime), true);
  assert.equal(Object.isFrozen(output.task), true);
  assert.equal(Object.isFrozen(output.notification), true);
});

test("presentation preserves emergency-stop priority over all other attention, setup and work signals", () => {
  const output = deriveEquinoxLocalPresentationState({
    status: baseStatus({
      health: { state: "CRITICAL" },
      agentControl: { state: "PAUSED", paused: true, activeWork: { terminals: 8, processes: 3, total: 11 } },
      browser: { contexts: { agent: { ready: false } } },
    }),
    tasks: [task({ freshResume: { status: "ambiguous", resumeId: "resume-attention" } })],
    onboarding: { available: true, setupComplete: false, needsAttention: true, issue: "Needs maintenance" },
    now: NOW,
  });
  assert.equal(output.state, "emergency_stopped");
  assert.equal(output.runtime.paused, true);
  assert.equal(output.runtime.healthState, "CRITICAL");
  assert.equal(output.runtime.activeWorkCount, 11);
  assert.equal(output.browser.agentReady, false);
  assert.equal(output.notification.kind, "fresh_resume_attention");
  assert.equal(output.setup.needsAttention, true);
});

test("presentation treats invalid collections, stale completion and missing health as attention without inventing task data", () => {
  for (const tasks of [null, "malformed", 42, {}, [null, undefined, 2, "text"]]) {
    const output = deriveEquinoxLocalPresentationState({
      status: { health: { state: "HEALTHY" } }, tasks, now: NOW,
    });
    assert.equal(output.task, null);
    assert.equal(output.notification, null);
    assert.equal(output.state, "idle");
  }
  const unknown = deriveEquinoxLocalPresentationState({ tasks: null, now: NOW });
  assert.equal(unknown.runtime.healthState, "UNKNOWN");
  assert.equal(unknown.state, "needs_attention");
  assert.equal(unknown.notification, null);
});

test("presentation transient success and notifications honor inclusive time windows and never recur after expiry", () => {
  const done = task({
    status: "completed", completedAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
  });
  const boundary = deriveEquinoxLocalPresentationState({status: baseStatus(), tasks:[done], now:NOW});
  assert.equal(boundary.state, "success");
  assert.equal(boundary.notification.kind, "task_completed");
  const expired = deriveEquinoxLocalPresentationState({status: baseStatus(), tasks:[done], now:NOW+1});
  assert.equal(expired.state, "idle");
  assert.equal(expired.task, null);
  assert.equal(expired.notification.kind, "task_completed", "completion notification lasts longer than transient success state");
  const fullyExpired = deriveEquinoxLocalPresentationState({status: baseStatus(), tasks:[done], now:NOW+5*60_000});
  assert.equal(fullyExpired.notification, null);
});

test("presentation does not let negative or malformed active work counts fabricate negative operation totals", () => {
  const variants = [
    [{ total: -10, terminals: 4, processes: 2 }, 0],
    [{ terminals: -3, processes: -8 }, 0],
    [{ total: "7", terminals: 2, processes: 1 }, 3],
    [{ total: 2.5, terminals: 1, processes: 2 }, 3],
    [{ total: 4, terminals: 90, processes: 90 }, 4],
  ];
  for (const [activeWork, expectedCount] of variants) {
    const output = deriveEquinoxLocalPresentationState({
      status: baseStatus({ agentControl: { state: "ACTIVE", paused: false, activeWork } }),
      now: NOW,
    });
    assert.equal(output.runtime.activeWorkCount, expectedCount);
    assert.equal(output.state, expectedCount === 0 ? "idle" : "working");
  }
});
