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

test("Agent Browser launch failures are diagnosed and resolved by a later successful launch request", async () => {
  const nowMs = 1_800_000_600_000;
  const failures = [event({ id: "browser-failed", ms: nowMs - 2000, component: "agent-browser", type: "launch_failed", message: "Chrome was not found" })];
  const engine = createDiagnosisEngine({ observability: fakeObservability(failures, nowMs), now: () => nowMs });
  const result = await engine.diagnose({ windowMs: 10000, component: "agent-browser" });
  assert.equal(result.incidentCount, 1);
  assert.equal(result.incidents[0].code, "AGENT_BROWSER_LAUNCH_FAILURE");
  assert.equal(result.incidents[0].state, "ACTIVE");
  failures.push(event({ id: "browser-launched", ms: nowMs - 1000, component: "agent-browser", type: "launch_requested" }));
  const recovered = await engine.diagnose({ windowMs: 10000 });
  assert.equal(recovered.incidents.find((item) => item.code === "AGENT_BROWSER_LAUNCH_FAILURE")?.state, "RESOLVED");
});

test("diagnosis caps an untrusted observability scan at the last 10,000 events and never starts repair",async()=>{
  const nowMs=1_800_000_700_000;
  const events=Array.from({length:10_080},(_,i)=>event({
    id:"bulk-"+i,ms:nowMs-20_000+i,component:"runtime",type:"runtime.heartbeat",
  }));
  const calls=[];
  const engine=createDiagnosisEngine({
    observability:{
      query:async()=>{throw Error("scan exists; query should not run")},
      scan:async args=>{calls.push(["scan",args]);return events},
      health:async options=>{calls.push(["health",options]);return {state:"HEALTHY"}},
    },
    workflowManager:{status:()=>{throw Error("unrelated workflow must not run")}},
    processManager:{list:()=>{throw Error("no incidents: no process inventory")}},
    inspectPort:async()=>{throw Error("no port collision")},
    now:()=>nowMs,
  });
  const result=await engine.diagnose({windowMs:40_000,limit:20});
  assert.equal(result.eventCount,10_000);
  assert.equal(result.incidentCount,0);
  assert.equal(result.health.state,"HEALTHY");
  assert.deepEqual(calls,[
    ["scan",{sinceMs:nowMs-40_000,untilMs:nowMs}],
    ["health",{windowMs:40_000}],
  ]);
});

test("diagnosis refuses to probe invalid or attacker-supplied preview ports",async()=>{
  const nowMs=1_800_000_800_000;
  const invalidPorts=[-1,0,65536,"text",null];
  const events=invalidPorts.map((port,i)=>event({
    id:"port-invalid-"+i,ms:nowMs-2_000+i,
    component:"release-gate",type:"release-gate.port_collision",
    projectId:"project-"+i,details:{requestedPort:port},
  }));
  let probes=0;
  const engine=createDiagnosisEngine({
    observability:fakeObservability(events,nowMs),
    inspectPort:async()=>{probes++;throw Error("not allowed")},
    now:()=>nowMs,
  });
  const result=await engine.diagnose({windowMs:10_000});
  assert.equal(result.incidentCount,5);
  assert.equal(probes,0);
  assert.ok(result.incidents.every(item=>item.code==="PREVIEW_PORT_OCCUPIED"));
  assert.ok(result.incidents.every(item=>item.state==="RESOLVED"));
});

test("diagnosis filters by exact project, optional bridge component and resolved state",async()=>{
  const nowMs=1_800_000_900_000;
  const events=[
    event({id:"own-failure",ms:nowMs-3000,component:"agent-browser",type:"launch_failed",projectId:"owned",severity:"error"}),
    event({id:"own-recovered",ms:nowMs-2000,component:"agent-browser",type:"launch_requested",projectId:"owned"}),
    event({id:"foreign-failure",ms:nowMs-1000,component:"agent-browser",type:"launch_failed",projectId:"foreign"}),
    event({id:"desktop-failure",ms:nowMs-500,component:"peekaboo",type:"peekaboo.permission_loss",projectId:"owned"}),
  ];
  const engine=createDiagnosisEngine({observability:fakeObservability(events,nowMs),now:()=>nowMs});
  const result=await engine.diagnose({projectId:"owned",component:"agent-browser",includeResolved:false,windowMs:10_000});
  assert.equal(result.eventCount,3);
  assert.equal(result.incidentCount,0);
  const recovered=await engine.diagnose({projectId:"owned",component:"agent-browser",includeResolved:true,windowMs:10_000});
  assert.equal(recovered.incidentCount,1);
  assert.equal(recovered.incidents[0].state,"RESOLVED");
  assert.equal(recovered.incidents[0].code,"AGENT_BROWSER_LAUNCH_FAILURE");
  const other=await engine.diagnose({projectId:"owned",component:"peekaboo",includeResolved:false,windowMs:10_000});
  assert.equal(other.incidentCount,1);
  assert.equal(other.incidents[0].code,"PEEKABOO_PERMISSION_LOSS");
});

test("incident report bounds workflow log reads and remains read-only when evidence cannot be fetched",async()=>{
  const nowMs=1_800_001_000_000,workflowId="wf-evidence-fixture";
  const events=[event({id:"wf-failure",ms:nowMs-500,component:"workflow",type:"workflow.failed",
    correlationId:workflowId,severity:"error",status:"failed",message:"synthetic workflow failure"})];
  const logCalls=[];
  const engine=createDiagnosisEngine({
    observability:fakeObservability(events,nowMs),now:()=>nowMs,
    workflowManager:{
      status:()=>({status:"failed",steps:[{id:"step",status:"failed",label:"fixture"}]}),
      readLogs:async args=>{logCalls.push(args);throw Error("synthetic unreadable logs")},
    },
    processManager:{
      list:()=>[],
      readLogs:async()=>{throw Error("no process ID evidence")},
    },
  });
  const diagnosed=await engine.diagnose({windowMs:10_000});
  const report=await engine.incidentReport({incidentId:diagnosed.incidents[0].incidentId,windowMs:10_000});
  assert.equal(report.incident.code,"WORKFLOW_FAILURE");
  assert.equal(report.timeline.length,1);
  assert.equal(report.currentEvidence.workflowLogTail,null);
  assert.deepEqual(logCalls,[{workflowId,cursor:Number.MAX_SAFE_INTEGER,maxBytes:1}]);
  await assert.rejects(engine.incidentReport({incidentId:"inc-nonexistent",windowMs:10_000}),/Incident seçilen retention/u);
});
