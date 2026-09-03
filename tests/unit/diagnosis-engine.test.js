import assert from "node:assert/strict";
import test from "node:test";

import { createDiagnosisEngine } from "../../src/diagnosis-engine.js";

function event({
  id,
  ms,
  component,
  type,
  severity = "info",
  status = null,
  projectId = "local",
  correlationId = null,
  message = null,
  details = {},
}) {
  return {
    schemaVersion: 1,
    eventId: `evt-${id}`,
    timestampMs: ms,
    timestamp: new Date(ms).toISOString(),
    component,
    type,
    severity,
    status,
    projectId,
    correlationId,
    message,
    details,
  };
}

function fakeObservability(events, nowMs) {
  return {
    query: async () => events,
    scan: async ({ sinceMs = 0, untilMs = nowMs }) => events.filter((item) => item.timestampMs >= sinceMs && item.timestampMs <= untilMs),
    health: async () => ({ state: "HEALTHY", reasons: [], recentEventCount: events.length }),
  };
}

test("diagnosis identifies a live release preview port collision", async () => {
  const nowMs = 1_800_000_000_000;
  const events = [
    event({
      id: "port",
      ms: nowMs - 2_000,
      component: "release-gate",
      type: "release-gate.port_collision",
      severity: "warn",
      status: "degraded",
      correlationId: "wf-port",
      details: { requestedPort: 43200 },
    }),
    event({
      id: "wf",
      ms: nowMs - 1_000,
      component: "workflow",
      type: "workflow.failed",
      severity: "error",
      status: "failed",
      correlationId: "wf-port",
      message: "preview failed",
    }),
  ];
  const engine = createDiagnosisEngine({
    observability: fakeObservability(events, nowMs),
    inspectPort: async (port) => ({
      probe: { host: "127.0.0.1", port, listening: true },
      listeners: [{ pid: 99, command: "node", endpoint: "127.0.0.1:43200" }],
      managedProcesses: [{
        processId: "proc-port",
        label: "preview holder",
        projectId: "local",
        running: true,
        pid: 99,
        expectedPorts: [43200],
        args: ["--token=must-not-leak"],
      }],
    }),
    now: () => nowMs,
  });

  const result = await engine.diagnose({ windowMs: 60_000, component: "workflow" });
  assert.equal(result.incidentCount, 1);
  assert.equal(result.incidents[0].code, "PREVIEW_PORT_OCCUPIED");
  assert.equal(result.incidents[0].state, "ACTIVE");
  assert.equal(result.incidents[0].details.livePort.probe.listening, true);
  assert.equal(result.incidents[0].severity, "error");
  assert.equal(result.incidents[0].firstSeen, new Date(nowMs - 2_000).toISOString());
  assert.equal(result.incidents[0].details.livePort.managedProcesses[0].processId, "proc-port");
  assert.equal("args" in result.incidents[0].details.livePort.managedProcesses[0], false);
});

test("workflow failure correlates a crashed child process", async () => {
  const nowMs = 1_800_000_100_000;
  const workflowId = "wf-child";
  const events = [
    event({
      id: "process",
      ms: nowMs - 3_000,
      component: "process",
      type: "process.crashed",
      severity: "error",
      status: "failed",
      correlationId: "proc-child",
      details: { label: `workflow:${workflowId}:test`, exitCode: 2 },
    }),
    event({
      id: "workflow",
      ms: nowMs - 2_000,
      component: "workflow",
      type: "workflow.failed",
      severity: "error",
      status: "failed",
      correlationId: workflowId,
      message: "test failed",
      details: { recipeId: "checks" },
    }),
  ];
  const engine = createDiagnosisEngine({
    observability: fakeObservability(events, nowMs),
    workflowManager: {
      status: () => ({
        workflowId,
        status: "failed",
        recipeId: "checks",
        steps: [{ id: "test", label: "npm run test", status: "failed", attempts: 1, error: "exit 2" }],
      }),
    },
    now: () => nowMs,
  });

  const result = await engine.diagnose({ windowMs: 60_000, component: "workflow" });
  assert.equal(result.incidentCount, 1);
  assert.equal(result.incidents[0].code, "WORKFLOW_CHILD_PROCESS_CRASH");
  assert.deepEqual(result.incidents[0].details.childProcessIds, ["proc-child"]);
  assert.equal(result.incidents[0].state, "ACTIVE");
});

test("recovered Peekaboo transport failure remains diagnosable as resolved", async () => {
  const nowMs = 1_800_000_200_000;
  const events = [
    event({
      id: "close",
      ms: nowMs - 4_000,
      component: "peekaboo",
      type: "peekaboo.unexpected_close",
      severity: "warn",
      status: "degraded",
      projectId: null,
    }),
    event({
      id: "start",
      ms: nowMs - 1_000,
      component: "peekaboo",
      type: "peekaboo.started",
      severity: "info",
      status: "healthy",
      projectId: null,
    }),
  ];
  const engine = createDiagnosisEngine({
    observability: fakeObservability(events, nowMs),
    getBridgeSnapshot: () => ({ peekaboo: { active: true } }),
    now: () => nowMs,
  });

  const result = await engine.diagnose({ windowMs: 60_000, includeResolved: true });
  assert.equal(result.incidentCount, 1);
  assert.equal(result.incidents[0].code, "PEEKABOO_TRANSPORT_FAILURE");
  assert.equal(result.incidents[0].state, "RESOLVED");
  assert.equal(result.incidents[0].firstSeen, new Date(nowMs - 4_000).toISOString());

  const report = await engine.incidentReport({
    incidentId: result.incidents[0].incidentId,
    windowMs: 60_000,
  });
  assert.equal(report.timeline.length, 2);
  assert.equal(report.currentEvidence.bridgeSnapshot.peekaboo.active, true);
});

test("diagnosis log evidence redacts bearer-like secrets", async () => {
  const nowMs = 1_800_000_300_000;
  const workflowId = "wf-secret";
  const events = [
    event({
      id: "wf-secret",
      ms: nowMs - 1_000,
      component: "workflow",
      type: "workflow.failed",
      severity: "error",
      status: "failed",
      correlationId: workflowId,
      message: "failed",
    }),
  ];
  const engine = createDiagnosisEngine({
    observability: fakeObservability(events, nowMs),
    workflowManager: {
      status: () => ({ workflowId, status: "failed", recipeId: "checks", steps: [] }),
      readLogs: async () => ({ output: "Authorization: Bearer super-secret-token\nfailed" }),
    },
    now: () => nowMs,
  });
  const diagnosis = await engine.diagnose({ windowMs: 60_000 });
  const report = await engine.incidentReport({
    incidentId: diagnosis.incidents[0].incidentId,
    windowMs: 60_000,
  });

  assert.doesNotMatch(report.currentEvidence.workflowLogTail, /super-secret-token/u);
  assert.match(report.currentEvidence.workflowLogTail, /\[REDACTED\]/u);
});

test("paused resumable workflow becomes a WORKFLOW_PAUSED incident", async () => {
  const nowMs = 1_800_000_400_000;
  const workflowId = "wf-paused12";
  const events = [
    event({
      id: "paused",
      ms: nowMs - 2_000,
      component: "workflow",
      type: "workflow.paused",
      severity: "info",
      status: "paused",
      correlationId: workflowId,
      details: { recipeId: "checks" },
    }),
  ];
  const engine = createDiagnosisEngine({
    observability: fakeObservability(events, nowMs),
    workflowManager: {
      status: () => ({
        workflowId,
        status: "paused",
        resumable: true,
        recipeId: "checks",
        steps: [{ id: "check", label: "npm run check", status: "pending", attempts: 0 }],
      }),
    },
    now: () => nowMs,
  });

  const result = await engine.diagnose({ windowMs: 60_000, component: "workflow" });
  assert.equal(result.incidentCount, 1);
  assert.equal(result.incidents[0].code, "WORKFLOW_PAUSED");
  assert.equal(result.incidents[0].state, "ACTIVE");
  assert.equal(result.incidents[0].details.resumable, true);
});


test("hard runtime interruption is diagnosed as an active paused workflow", async () => {
  const nowMs = 1_800_000_600_000;
  const workflowId = "wf-interrupted12";
  const events = [
    event({
      id: "interrupted",
      ms: nowMs - 1_000,
      component: "workflow",
      type: "workflow.interrupted",
      severity: "warn",
      status: "paused",
      correlationId: workflowId,
      details: { recipeId: "build", interruptionCount: 1 },
    }),
  ];
  const engine = createDiagnosisEngine({
    observability: fakeObservability(events, nowMs),
    workflowManager: {
      status: () => ({
        workflowId,
        status: "paused",
        resumable: true,
        recipeId: "build",
        steps: [{ id: "build", label: "npm run build", status: "pending", attempts: 1 }],
      }),
    },
    now: () => nowMs,
  });

  const result = await engine.diagnose({ windowMs: 60_000, component: "workflow" });
  assert.equal(result.incidentCount, 1);
  assert.equal(result.incidents[0].code, "WORKFLOW_PAUSED");
  assert.equal(result.incidents[0].state, "ACTIVE");
  assert.equal(result.incidents[0].details.resumable, true);
});
