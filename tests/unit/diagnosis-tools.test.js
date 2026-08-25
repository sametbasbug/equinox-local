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
