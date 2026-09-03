import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRecoveryPolicyController, __test } from "../../src/recovery-policy.js";

async function withTempDir(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-recovery-policy-"));
  try {
    await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function fakeObservability({ now }) {
  const events = [];
  let counter = 0;
  return {
    events,
    record: async (input) => {
      const timestampMs = now();
      const event = {
        schemaVersion: 1,
        eventId: `evt-${++counter}`,
        timestampMs,
        timestamp: new Date(timestampMs).toISOString(),
        ...input,
      };
      events.push(event);
      return event;
    },
    query: async ({ component = null, limit = 100, newestFirst = true } = {}) => {
      let output = events.filter((event) => !component || event.component === component);
      if (newestFirst) output = [...output].reverse();
      return output.slice(0, limit);
    },
  };
}

function incident({
  incidentId = "inc-test-12345678",
  code,
  component = "workflow",
  projectId = "orbit",
  correlationId = "wf-test-123456",
  details = {},
} = {}) {
  return {
    incidentId,
    code,
    state: "ACTIVE",
    confidence: "HIGH",
    severity: "warn",
    component,
    projectId,
    correlationId,
    firstSeen: "2026-08-04T00:00:00.000Z",
    lastSeen: "2026-08-04T00:00:01.000Z",
    details,
  };
}

function createController({ root, incidents, repairIssue, nowRef, maxFailures = 3 } = {}) {
  const observability = fakeObservability({ now: () => nowRef.value });
  const diagnosisEngine = {
    diagnose: async ({ projectId = null } = {}) => ({
      incidents: incidents.filter((item) => !projectId || !item.projectId || item.projectId === projectId),
    }),
  };
  const repairEngine = { repairIssue };
  const controller = createRecoveryPolicyController({
    rootDir: root,
    diagnosisEngine,
    repairEngine,
    observability,
    now: () => nowRef.value,
    delay: async () => {},
    maxFailures,
    failureWindowMs: 10 * 60 * 1000,
    circuitOpenMs: 30 * 60 * 1000,
  });
  return { controller, observability };
}


test("Peekaboo unexpected close triggers exactly one guarded automatic repair", async () => {
  await withTempDir(async (root) => {
    const nowRef = { value: 1_800_000_100_000 };
    const repairs = [];
    const item = incident({
      incidentId: "inc-peekaboo-12345678",
      code: "PEEKABOO_TRANSPORT_FAILURE",
      component: "peekaboo",
      projectId: null,
      correlationId: null,
    });
    const { controller, observability } = createController({
      root,
      incidents: [item],
      nowRef,
      repairIssue: async (args) => {
        repairs.push(args);
        return {
          ...args,
          repairId: "repair-peek",
          incidentCode: item.code,
          outcome: "RECOVERED",
          actionStatus: "RESTARTED_AND_VERIFIED",
          summary: "ok",
        };
      },
    });

    const [result] = await controller.handleEvent({
      eventId: "evt-peek-close",
      type: "peekaboo.unexpected_close",
      component: "peekaboo",
      projectId: null,
      correlationId: null,
    });
    assert.equal(result.status, "RECOVERED");
    assert.deepEqual(repairs, [{
      incidentId: item.incidentId,
      recipeId: "peekaboo_bridge_restart",
    }]);
    assert.equal(observability.events.some((event) => event.type === "recovery-policy.recovered"), true);
    const status = await controller.status();
    assert.equal(status.openCircuitCount, 0);
    assert.equal(status.circuits[0].lastOutcome, "RECOVERED");
  });
});

test("failed workflow automatic policy only cleans orphan children and never resumes", async () => {
  await withTempDir(async (root) => {
    const nowRef = { value: 1_800_000_200_000 };
    const repairs = [];
    const item = incident({
      incidentId: "inc-workflow-failure-12345678",
      code: "WORKFLOW_FAILURE",
      correlationId: "wf-failed-123456",
    });
    const { controller } = createController({
      root,
      incidents: [item],
      nowRef,
      repairIssue: async (args) => {
        repairs.push(args);
        return {
          ...args,
          repairId: "repair-orphan",
          incidentCode: item.code,
          outcome: "RECOVERED",
          actionStatus: "ORPHAN_PROCESSES_REMOVED",
          summary: "ok",
        };
      },
    });

    const [result] = await controller.handleEvent({
      eventId: "evt-workflow-failed",
      type: "workflow.failed",
      component: "workflow",
      projectId: "orbit",
      correlationId: "wf-failed-123456",
    });
    assert.equal(result.status, "RECOVERED");
    assert.deepEqual(repairs.map((repair) => repair.recipeId), ["orphan_process_cleanup"]);
    assert.equal(repairs.some((repair) => repair.recipeId === "stale_workflow_recover"), false);
  });
});

test("startup reconciliation runs cleanup then safe resume for interrupted workflow", async () => {
  await withTempDir(async (root) => {
    const nowRef = { value: 1_800_000_300_000 };
    const repairs = [];
    const item = incident({
      incidentId: "inc-workflow-paused-12345678",
      code: "WORKFLOW_PAUSED",
      correlationId: "wf-paused-123456",
    });
    const { controller } = createController({
      root,
      incidents: [item],
      nowRef,
      repairIssue: async (args) => {
        repairs.push(args);
        return {
          ...args,
          repairId: `repair-${repairs.length}`,
          incidentCode: item.code,
          outcome: "RECOVERED",
          actionStatus: args.recipeId === "orphan_process_cleanup" ? "SKIPPED_ALREADY_RESOLVED" : "WORKFLOW_RESUMED",
          summary: "ok",
        };
      },
    });

    const result = await controller.reconcile();
    assert.equal(result.attempted, 1);
    assert.equal(result.results[0].status, "RECOVERED");
    assert.deepEqual(repairs.map((repair) => repair.recipeId), [
      "orphan_process_cleanup",
      "stale_workflow_recover",
    ]);
  });
});

test("three failed automatic repairs open a persistent circuit and block the fourth", async () => {
  await withTempDir(async (root) => {
    const nowRef = { value: 1_800_000_400_000 };
    let repairCalls = 0;
    const item = incident({
      incidentId: "inc-peekaboo-circuit-12345678",
      code: "PEEKABOO_TRANSPORT_FAILURE",
      component: "peekaboo",
      projectId: null,
      correlationId: null,
    });
    const { controller, observability } = createController({
      root,
      incidents: [item],
      nowRef,
      repairIssue: async (args) => {
        repairCalls += 1;
        return {
          ...args,
          repairId: `repair-fail-${repairCalls}`,
          incidentCode: item.code,
          outcome: "FAILED",
          actionStatus: "TEST_FAILURE",
          summary: "failed",
        };
      },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [result] = await controller.handleEvent({
        eventId: `evt-close-${attempt}`,
        type: "peekaboo.unexpected_close",
        component: "peekaboo",
      });
      if (attempt < 2) assert.equal(result.status, "FAILED");
      else assert.equal(result.status, "CIRCUIT_OPEN");
      nowRef.value += 1_000;
    }

    const [blocked] = await controller.handleEvent({
      eventId: "evt-close-4",
      type: "peekaboo.unexpected_close",
      component: "peekaboo",
    });
    assert.equal(blocked.status, "CIRCUIT_OPEN");
    assert.equal(repairCalls, 3);
    const status = await controller.status();
    assert.equal(status.openCircuitCount, 1);
    assert.equal(status.circuits[0].failureCount, 3);
    assert.equal(observability.events.some((event) => event.type === "recovery-policy.circuit_open"), true);
    assert.equal(observability.events.some((event) => event.type === "recovery-policy.circuit_blocked"), true);

    const mode = (await fs.stat(controller.statePath)).mode & 0o777;
    assert.equal(mode, 0o600);

    const second = createController({
      root,
      incidents: [item],
      nowRef,
      repairIssue: async () => {
        throw new Error("persistent circuit should block before repair");
      },
    }).controller;
    await second.initialize();
    const persisted = await second.status();
    assert.equal(persisted.openCircuitCount, 1);
  });
});

test("event correlation prevents one workflow failure from repairing another workflow", async () => {
  await withTempDir(async (root) => {
    const nowRef = { value: 1_800_000_500_000 };
    const repairs = [];
    const other = incident({
      incidentId: "inc-other-workflow-12345678",
      code: "WORKFLOW_FAILURE",
      correlationId: "wf-other-123456",
    });
    const { controller } = createController({
      root,
      incidents: [other],
      nowRef,
      repairIssue: async (args) => {
        repairs.push(args);
        return { ...args, repairId: "unexpected", outcome: "RECOVERED", actionStatus: "OK" };
      },
    });
    const [result] = await controller.handleEvent({
      eventId: "evt-target",
      type: "workflow.failed",
      component: "workflow",
      projectId: "orbit",
      correlationId: "wf-target-123456",
    });
    assert.equal(result.status, "NO_ACTIVE_INCIDENT");
    assert.equal(repairs.length, 0);
  });
});

test("policy internals expose expected bounded defaults", () => {
  assert.equal(__test.DEFAULT_MAX_FAILURES, 3);
  assert.equal(__test.DEFAULT_FAILURE_WINDOW_MS, 10 * 60 * 1000);
  assert.equal(__test.DEFAULT_CIRCUIT_OPEN_MS, 30 * 60 * 1000);
  assert.equal(__test.POLICIES.length, 4);
});
