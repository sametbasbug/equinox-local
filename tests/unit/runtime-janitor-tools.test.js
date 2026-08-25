import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerRuntimeJanitorTools } from "../../src/runtime-janitor-tools.js";

test("runtime janitor module registers the v4.0.4 bounded tool set", async () => {
  const tools = [];
  const registerTextTool = (name, config, handler, options = {}) => {
    tools.push({ name, config, handler, options });
  };
  const janitor = {
    categories: () => [
      { id: "terminal_records" },
      { id: "process_records" },
      { id: "workflow_records" },
      { id: "visual_regression" },
      { id: "release_runs" },
      { id: "release_baseline_sets" },
      { id: "release_candidates" },
      { id: "rollback_bundles" },
      { id: "stale_worktrees" },
      { id: "observability_segments" },
    ],
    report: async () => ({ mode: "DRY_RUN" }),
    status: () => ({ enabled: true, active: false, intervalMs: 21_600_000 }),
    history: async () => [],
  };

  await registerRuntimeJanitorTools({
    registerTextTool,
    z,
    janitor,
    processJsonResult: (value) => value,
    errorResult: (error) => ({ error: error.message }),
  });

  assert.deepEqual(tools.map((tool) => tool.name), [
    "janitor_report",
    "janitor_status",
    "janitor_history",
  ]);
  assert.equal(tools[0].config.annotations.readOnlyHint, true);
  assert.equal(tools[1].config.annotations.readOnlyHint, true);
  assert.equal(tools[1].config.annotations.destructiveHint, false);
  assert.deepEqual(tools[1].options, { projectAware: false });
  assert.equal(tools[2].config.annotations.readOnlyHint, true);
});
