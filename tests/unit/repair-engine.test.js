import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRepairEngine } from "../../src/repair-engine.js";

async function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "equinox-repair-test-"));
}

function makeIncident({
  incidentId = "inc-preview-port-occupied-test",
  code = "PREVIEW_PORT_OCCUPIED",
  state = "ACTIVE",
  projectId = "status",
  correlationId = "wf-test123",
  details = {},
} = {}) {
  return {
    incidentId,
    code,
    state,
    confidence: "HIGH",
    severity: "warn",
    component: code.startsWith("PEEKABOO") ? "peekaboo" : code.startsWith("CHROME") ? "chrome" : "release-gate",
    projectId,
    correlationId,
    firstSeen: "2026-08-03T20:00:00.000Z",
    lastSeen: "2026-08-03T20:00:01.000Z",
    details,
  };
}

function makeHarness({
  incident = makeIncident({ details: { requestedPort: 43220 } }),
  currentEvidence = {},
  processRecords = [],
  workflowRecords = {},
  inspectPort,
  restartPeekabooBridge = async () => {},
  getPeekabooStatus = async () => ({
    active: true,
    compatibility: { ok: true },
    permissionState: { screenRecording: true, accessibility: true },
    error: null,
    reconnectCount: 1,
  }),
  restartChromeBridge = async () => {},
  getChromeSnapshot = () => ({ active: true, connection: { status: "ACTIVE" } }),
  resumeWorkflowSafely,
} = {}) {
  const events = [];
  const stopCalls = [];
  const processes = processRecords.map((record) => ({ ...record }));
  const workflows = new Map(Object.entries(workflowRecords));
  let portInspector = inspectPort ?? (async () => ({
    probe: { listening: false },
    listeners: [],
    managedProcesses: [],
    lsofError: null,
  }));

  const diagnosisEngine = {
    async incidentReport() {
      return {
        incident,
        currentEvidence: {
          bridgeSnapshot: {},
          ...currentEvidence,
        },
      };
    },
  };
  const observability = {
    async record(event) {
      events.push(event);
      return event;
    },
  };
  const processManager = {
    list() {
      return processes.map((record) => ({ ...record }));
    },
    async stop({ processId, remove }) {
      stopCalls.push(processId);
      const record = processes.find((item) => item.processId === processId);
      if (!record) throw new Error("missing process");
      record.running = false;
      record.exitedAt = "2026-08-03T20:00:02.000Z";
      if (remove) {
        const index = processes.indexOf(record);
        processes.splice(index, 1);
      }
      return { ...record };
    },
  };
  const workflowManager = {
    status(workflowId) {
      const record = workflows.get(workflowId);
      if (!record) throw new Error("missing workflow");
      return { ...record };
    },
  };

  return {
    events,
    stopCalls,
    processes,
    workflows,
    diagnosisEngine,
    observability,
    processManager,
    workflowManager,
    setInspectPort(fn) {
      portInspector = fn;
    },
    dependencies: {
      diagnosisEngine,
      observability,
      processManager,
      workflowManager,
      inspectPort: (...args) => portInspector(...args),
      restartPeekabooBridge,
      getPeekabooStatus,
      restartChromeBridge,
      getChromeSnapshot,
      resumeWorkflowSafely: resumeWorkflowSafely ?? (async (workflowId) => {
        const record = workflows.get(workflowId);
        record.status = "running";
        record.resumable = false;
        return { ...record };
      }),
    },
  };
}

test("repair catalog exposes only fixed non-arbitrary recipes", async () => {
  const rootDir = await makeTempRoot();
  const harness = makeHarness();
  const engine = createRepairEngine({ rootDir, ...harness.dependencies });
  const recipes = engine.recipes();
  assert.deepEqual(recipes.map((item) => item.id), [
    "peekaboo_bridge_restart",
    "stale_preview_cleanup",
    "orphan_process_cleanup",
    "stale_workflow_recover",
  ]);
  assert.ok(recipes.every((item) => item.arbitraryCommand === false));
  assert.ok(recipes.every((item) => item.gitMutation === false));
  assert.ok(recipes.every((item) => item.deploymentMutation === false));
});

test("resolved incident is skipped without process mutation", async () => {
  const rootDir = await makeTempRoot();
  const harness = makeHarness({
    incident: makeIncident({ state: "RESOLVED", details: { requestedPort: 43220 } }),
  });
  const engine = createRepairEngine({ rootDir, ...harness.dependencies });
  const repair = await engine.repairIssue({
    incidentId: "inc-preview-port-occupied-test",
    recipeId: "stale_preview_cleanup",
  });
  assert.equal(repair.outcome, "RECOVERED");
  assert.equal(repair.actionStatus, "SKIPPED_ALREADY_RESOLVED");
  assert.deepEqual(harness.stopCalls, []);
});

test("stale preview cleanup requires exact managed PID and terminal workflow ownership", async () => {
  const rootDir = await makeTempRoot();
  const process = {
    processId: "proc-preview1",
    label: "workflow:wf-test123:preview",
    projectId: "status",
    pid: 4444,
    running: true,
    expectedPorts: [43220],
    createdAt: "2026-08-03T20:00:00.000Z",
  };
  const workflow = {
    workflowId: "wf-test123",
    recipeId: "release-gate",
    projectId: "status",
    projectRoot: "/tmp/status",
    status: "failed",
    resumable: true,
    currentStepIndex: 2,
    updatedAt: "2026-08-03T20:00:00.000Z",
  };
  let calls = 0;
  const harness = makeHarness({
    processRecords: [process],
    workflowRecords: { "wf-test123": workflow },
    inspectPort: async () => {
      calls += 1;
      return calls === 1
        ? {
            probe: { listening: true },
            listeners: [{ pid: 4444, command: "node", endpoint: "127.0.0.1:43220" }],
            managedProcesses: [{ ...process }],
            lsofError: null,
          }
        : {
            probe: { listening: false },
            listeners: [],
            managedProcesses: [],
            lsofError: null,
          };
    },
  });
  const engine = createRepairEngine({ rootDir, ...harness.dependencies });
  const repair = await engine.repairIssue({
    incidentId: "inc-preview-port-occupied-test",
    recipeId: "stale_preview_cleanup",
  });
  assert.equal(repair.outcome, "RECOVERED");
  assert.equal(repair.actionStatus, "STALE_PREVIEW_REMOVED");
  assert.deepEqual(harness.stopCalls, ["proc-preview1"]);
  assert.equal(harness.events.some((event) =>
    event.component === "release-gate" &&
    event.type === "release-gate.port_recovered" &&
    event.details?.incidentId === "inc-preview-port-occupied-test"
  ), true);
});

test("stale preview cleanup refuses unmanaged or ambiguous listener ownership", async () => {
  const rootDir = await makeTempRoot();
  const harness = makeHarness({
    inspectPort: async () => ({
      probe: { listening: true },
      listeners: [{ pid: 9999, command: "python", endpoint: "127.0.0.1:43220" }],
      managedProcesses: [],
      lsofError: null,
    }),
  });
  const engine = createRepairEngine({ rootDir, ...harness.dependencies });
  const repair = await engine.repairIssue({
    incidentId: "inc-preview-port-occupied-test",
    recipeId: "stale_preview_cleanup",
  });
  assert.equal(repair.outcome, "NEEDS_INTERVENTION");
  assert.equal(repair.actionStatus, "OWNERSHIP_UNPROVEN");
  assert.deepEqual(harness.stopCalls, []);
});

test("active workflow preview is never cleaned as stale", async () => {
  const rootDir = await makeTempRoot();
  const process = {
    processId: "proc-preview2",
    label: "workflow:wf-active12:preview",
    projectId: "status",
    pid: 4455,
    running: true,
    expectedPorts: [43220],
  };
  const harness = makeHarness({
    processRecords: [process],
    workflowRecords: {
      "wf-active12": {
        workflowId: "wf-active12",
        recipeId: "release-gate",
        projectId: "status",
        projectRoot: "/tmp/status",
        status: "running",
        resumable: false,
      },
    },
    inspectPort: async () => ({
      probe: { listening: true },
      listeners: [{ pid: 4455, command: "node", endpoint: "127.0.0.1:43220" }],
      managedProcesses: [{ ...process }],
      lsofError: null,
    }),
  });
  const engine = createRepairEngine({ rootDir, ...harness.dependencies });
  const repair = await engine.repairIssue({
    incidentId: "inc-preview-port-occupied-test",
    recipeId: "stale_preview_cleanup",
  });
  assert.equal(repair.outcome, "NEEDS_INTERVENTION");
  assert.equal(repair.actionStatus, "PREVIEW_NOT_PROVEN_STALE");
  assert.deepEqual(harness.stopCalls, []);
});

test("workflow resume refuses to run while owned child process is still alive", async () => {
  const rootDir = await makeTempRoot();
  const incident = makeIncident({
    incidentId: "inc-workflow-failure-test",
    code: "WORKFLOW_FAILURE",
    projectId: "status",
    correlationId: "wf-failed12",
    details: { workflowId: "wf-failed12" },
  });
  let resumeCalls = 0;
  const harness = makeHarness({
    incident,
    workflowRecords: {
      "wf-failed12": {
        workflowId: "wf-failed12",
        recipeId: "checks",
        projectId: "status",
        projectRoot: "/tmp/status",
        status: "failed",
        resumable: true,
      },
    },
    processRecords: [{
      processId: "proc-child1",
      label: "workflow:wf-failed12:npm-check",
      projectId: "status",
      pid: 5555,
      running: true,
      expectedPorts: [],
    }],
    resumeWorkflowSafely: async () => {
      resumeCalls += 1;
    },
  });
  const engine = createRepairEngine({ rootDir, ...harness.dependencies });
  const repair = await engine.repairIssue({
    incidentId: incident.incidentId,
    recipeId: "stale_workflow_recover",
  });
  assert.equal(repair.outcome, "NEEDS_INTERVENTION");
  assert.equal(repair.actionStatus, "ORPHAN_PROCESS_PRESENT");
  assert.equal(resumeCalls, 0);
});

test("workflow resume delegates to guarded resume backend and persists audit history", async () => {
  const rootDir = await makeTempRoot();
  const incident = makeIncident({
    incidentId: "inc-workflow-paused-test",
    code: "WORKFLOW_PAUSED",
    projectId: "status",
    correlationId: "wf-paused12",
    details: { workflowId: "wf-paused12" },
  });
  let resumeCalls = 0;
  const workflow = {
    workflowId: "wf-paused12",
    recipeId: "checks",
    projectId: "status",
    projectRoot: "/tmp/status",
    status: "paused",
    resumable: true,
  };
  const harness = makeHarness({
    incident,
    workflowRecords: { "wf-paused12": workflow },
    resumeWorkflowSafely: async () => {
      resumeCalls += 1;
      workflow.status = "running";
      workflow.resumable = false;
      return { ...workflow };
    },
  });
  const engine = createRepairEngine({ rootDir, ...harness.dependencies });
  const repair = await engine.repairIssue({
    incidentId: incident.incidentId,
    recipeId: "stale_workflow_recover",
  });
  assert.equal(repair.outcome, "RECOVERED");
  assert.equal(repair.actionStatus, "WORKFLOW_RESUMED");
  assert.equal(resumeCalls, 1);
  const history = await engine.history({ limit: 10 });
  assert.equal(history.length, 1);
  assert.equal(history[0].repairId, repair.repairId);
  const rootStat = await fs.stat(rootDir);
  const historyStat = await fs.stat(engine.historyPath);
  assert.equal(rootStat.mode & 0o777, 0o700);
  assert.equal(historyStat.mode & 0o777, 0o600);
});

test("orphan process cleanup only stops workflow-owned managed children", async () => {
  const rootDir = await makeTempRoot();
  const incident = makeIncident({
    incidentId: "inc-workflow-orphan-test",
    code: "WORKFLOW_FAILURE",
    projectId: "status",
    correlationId: "wf-orphan12",
    details: { workflowId: "wf-orphan12" },
  });
  const harness = makeHarness({
    incident,
    workflowRecords: {
      "wf-orphan12": {
        workflowId: "wf-orphan12",
        recipeId: "checks",
        projectId: "status",
        projectRoot: "/tmp/status",
        status: "failed",
        resumable: true,
      },
    },
    processRecords: [
      {
        processId: "proc-owned",
        label: "workflow:wf-orphan12:check",
        projectId: "status",
        pid: 6010,
        running: true,
        expectedPorts: [],
      },
      {
        processId: "proc-unrelated",
        label: "manual-server",
        projectId: "status",
        pid: 6020,
        running: true,
        expectedPorts: [],
      },
    ],
  });
  const engine = createRepairEngine({ rootDir, ...harness.dependencies });
  const repair = await engine.repairIssue({
    incidentId: incident.incidentId,
    recipeId: "orphan_process_cleanup",
  });
  assert.equal(repair.outcome, "RECOVERED");
  assert.deepEqual(harness.stopCalls, ["proc-owned"]);
  assert.equal(harness.processes.some((item) => item.processId === "proc-unrelated" && item.running), true);
});

test("Peekaboo recipe verifies health after its fixed restart callback", async () => {
  const peekRoot = await makeTempRoot();
  let peekRestart = 0;
  const peekHarness = makeHarness({
    incident: makeIncident({
      incidentId: "inc-peekaboo-transport-test",
      code: "PEEKABOO_TRANSPORT_FAILURE",
      projectId: null,
    }),
    restartPeekabooBridge: async () => { peekRestart += 1; },
  });
  const peekEngine = createRepairEngine({ rootDir: peekRoot, ...peekHarness.dependencies });
  const peekRepair = await peekEngine.repairIssue({
    incidentId: "inc-peekaboo-transport-test",
    recipeId: "peekaboo_bridge_restart",
  });
  assert.equal(peekRepair.outcome, "RECOVERED");
  assert.equal(peekRestart, 1);
  assert.equal(peekHarness.events
    .filter((event) => event.component === "repair")
    .every((event) => event.details?.incidentId === "inc-peekaboo-transport-test"), true);


});

test("recipe mismatch returns NEEDS_INTERVENTION without mutation", async () => {
  const rootDir = await makeTempRoot();
  let peekRestart = 0;
  const harness = makeHarness({
    restartPeekabooBridge: async () => { peekRestart += 1; },
  });
  const engine = createRepairEngine({ rootDir, ...harness.dependencies });
  const repair = await engine.repairIssue({
    incidentId: "inc-preview-port-occupied-test",
    recipeId: "peekaboo_bridge_restart",
  });
  assert.equal(repair.outcome, "NEEDS_INTERVENTION");
  assert.equal(repair.actionStatus, "RECIPE_INCIDENT_MISMATCH");
  assert.equal(peekRestart, 0);
});
