import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";

import { registerDiagnosisTools } from "../../src/diagnosis-tools.js";

test("diagnosis module registers the v4.0.1 read-only tool set", async () => {
  const tools = new Map();
  const registerTextTool = (name, config, handler, options) => {
    tools.set(name, { config, handler, options });
  };
  const calls = [];
  const diagnosisEngine = {
    diagnose: async (args) => {
      calls.push({ kind: "diagnose", args });
      return { incidentCount: 0, incidents: [] };
    },
    incidentReport: async (args) => {
      calls.push({ kind: "report", args });
      return { incident: { incidentId: args.incidentId } };
    },
  };

  const state = await registerDiagnosisTools({
    registerTextTool,
    z,
    diagnosisEngine,
    projectIdSchema: z.enum(["local", "status"]),
    processJsonResult: (value) => value,
    errorResult: (error) => ({ error: error.message }),
  });

  assert.deepEqual([...tools.keys()], ["diagnose_issue", "incident_report"]);
  assert.equal(state.toolCount, 2);
  assert.equal(tools.get("diagnose_issue").config.annotations.readOnlyHint, true);
  assert.equal(tools.get("incident_report").config.annotations.destructiveHint, false);
  assert.equal(tools.get("diagnose_issue").options.projectAware, false);

  const diagnosed = await tools.get("diagnose_issue").handler({
    window_minutes: 30,
    project_id: "local",
    component: "workflow",
    include_resolved: false,
    limit: 5,
  });
  assert.equal(diagnosed.incidentCount, 0);
  assert.deepEqual(calls[0], {
    kind: "diagnose",
    args: {
      windowMs: 1_800_000,
      projectId: "local",
      component: "workflow",
      includeResolved: false,
      limit: 5,
    },
  });

  await tools.get("incident_report").handler({
    incident_id: "inc-test-abc",
    window_minutes: 60,
  });
  assert.deepEqual(calls[1], {
    kind: "report",
    args: {
      incidentId: "inc-test-abc",
      windowMs: 3_600_000,
    },
  });
});

test("diagnosis tool schemas enforce read-only scope, bounded inputs and no unintended project access", async () => {
  const tools = new Map();
  await registerDiagnosisTools({
    registerTextTool: (name, config, handler, options) => tools.set(name, { config, handler, options }),
    z,
    diagnosisEngine: {
      diagnose: async () => ({}),
      incidentReport: async () => ({}),
    },
    projectIdSchema: z.enum(["selected", "status"]),
    processJsonResult: (value) => value,
    errorResult: (error) => ({ error: String(error) }),
  });

  assert.deepEqual([...tools.keys()], ["diagnose_issue", "incident_report"]);
  const diagnose = tools.get("diagnose_issue");
  const report = tools.get("incident_report");
  const parse = (entry, input) => z.object(entry.config.inputSchema).safeParse(input);

  for (const entry of [diagnose, report]) {
    assert.deepEqual(entry.config.annotations, {
      title: entry === diagnose ? "Runtime sorununu teşhis et" : "Incident kanıt raporunu göster",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.deepEqual(entry.options, { projectAware: false });
    assert.match(entry.config.description, /Repair|mutation/u);
  }

  assert.deepEqual(parse(diagnose, {}).data, {
    window_minutes: 60,
    include_resolved: true,
    limit: 20,
  });
  assert.equal(parse(diagnose, { window_minutes: 1, limit: 1, component: "chrome", project_id: "selected", include_resolved: false }).success, true);
  assert.equal(parse(diagnose, { window_minutes: 10_080, limit: 50, component: "agent-browser" }).success, true);
  for (const bad of [
    { window_minutes: 0 }, { window_minutes: 10_081 }, { window_minutes: -1 },
    { window_minutes: 1.2 }, { window_minutes: "60" }, { limit: 0 }, { limit: 51 },
    { limit: 1.5 }, { project_id: "../../private" }, { project_id: "unknown" },
    { component: "credential-store" }, { include_resolved: "false" },
  ]) assert.equal(parse(diagnose, bad).success, false, JSON.stringify(bad));

  assert.equal(parse(report, { incident_id: "inc-a1234" }).success, true);
  assert.deepEqual(parse(report, { incident_id: "inc-a1234" }).data, {
    incident_id: "inc-a1234",
    window_minutes: 1440,
  });
  for (const bad of [
    {}, { incident_id: "inc-" }, { incident_id: "INC-UPPERCASE" },
    { incident_id: "inc-../../private" }, { incident_id: "inc-" + "a".repeat(180) },
    { incident_id: "inc-a1234", window_minutes: 0 }, { incident_id: "inc-a1234", window_minutes: 10_081 },
    { incident_id: "inc-a1234", window_minutes: 1.5 },
  ]) assert.equal(parse(report, bad).success, false, JSON.stringify(bad));
});

test("diagnosis reports delegate only to read-only engine methods and fail closed through error formatting", async () => {
  const tools = new Map();
  const calls = [];
  const diagnosisEngine = {
    diagnose: async (args) => {
      calls.push(["diagnose", args]);
      throw new Error("diagnosis unavailable");
    },
    incidentReport: async (args) => {
      calls.push(["incidentReport", args]);
      throw new Error("report unavailable");
    },
    repair: () => { throw new Error("forbidden repair"); },
    restart: () => { throw new Error("forbidden restart"); },
  };
  await registerDiagnosisTools({
    registerTextTool: (name, config, handler) => tools.set(name, handler),
    z, diagnosisEngine, projectIdSchema: z.enum(["allowed"]),
    processJsonResult: (value) => value,
    errorResult: (error) => ({ status: "unavailable", message: error.message }),
  });

  const noProject = await tools.get("diagnose_issue")({
    window_minutes: 60, limit: 20, include_resolved: true,
  });
  assert.deepEqual(noProject, { status: "unavailable", message: "diagnosis unavailable" });
  const incident = await tools.get("incident_report")({
    incident_id: "inc-a1234", window_minutes: 1440,
  });
  assert.deepEqual(incident, { status: "unavailable", message: "report unavailable" });
  assert.deepEqual(calls, [
    ["diagnose", { windowMs: 3_600_000, projectId: null, component: null, includeResolved: true, limit: 20 }],
    ["incidentReport", { incidentId: "inc-a1234", windowMs: 86_400_000 }],
  ]);
});

test("diagnosis serialization failures route through the original error formatter without retries", async () => {
  const tools = new Map();
  let count = 0;
  const diagnosisEngine = {
    diagnose: async () => { count += 1; return { incidents: [] }; },
    incidentReport: async () => { count += 1; return { incident: null }; },
  };
  await registerDiagnosisTools({
    registerTextTool: (name, config, handler) => tools.set(name, handler),
    z, diagnosisEngine, projectIdSchema: z.enum(["local"]),
    processJsonResult: () => { throw new Error("formatter rejected output"); },
    errorResult: (error) => ({ status: "error", reason: error.message }),
  });
  assert.deepEqual(await tools.get("diagnose_issue")({
    window_minutes: 1, project_id: "local", component: "runtime", include_resolved: false, limit: 1,
  }), { status: "error", reason: "formatter rejected output" });
  assert.deepEqual(await tools.get("incident_report")({
    incident_id: "inc-abc123", window_minutes: 1,
  }), { status: "error", reason: "formatter rejected output" });
  assert.equal(count, 2);
});
