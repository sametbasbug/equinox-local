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

test("janitor tools preserve read-only authority and reject unsupported categories, outcomes and limits", async () => {
  const tools = new Map();
  const categories = [{ id: "terminal_records" }, { id: "release_candidates" }];
  await registerRuntimeJanitorTools({
    registerTextTool: (name, config, handler, options) => tools.set(name, { config, handler, options }),
    z,
    janitor: {
      categories: () => categories,
      report: async () => ({ mode: "DRY_RUN" }),
      status: () => ({ active: false }),
      history: async () => [],
      // Deliberately offer no cleanup mutation in the injected janitor contract.
    },
    processJsonResult: (value) => value,
    errorResult: (error) => ({ error: error.message }),
  });

  const parse = (name, input) => z.object(tools.get(name).config.inputSchema).safeParse(input);
  assert.deepEqual([...tools.keys()], ["janitor_report", "janitor_status", "janitor_history"]);
  for (const name of tools.keys()) {
    const entry = tools.get(name);
    assert.equal(entry.config.annotations.readOnlyHint, true);
    assert.equal(entry.config.annotations.destructiveHint, false);
    assert.equal(entry.config.annotations.idempotentHint, true);
    assert.equal(entry.config.annotations.openWorldHint, false);
    assert.deepEqual(entry.options, { projectAware: false });
  }
  assert.deepEqual(parse("janitor_report", {}).data, { include_protected: false, limit: 100 });
  assert.deepEqual(parse("janitor_history", {}).data, { limit: 50 });
  assert.equal(parse("janitor_status", {}).success, true);
  for (const limit of [0, -1, 501, 1.5, "500", null]) {
    assert.equal(parse("janitor_report", { limit }).success, false, `report ${limit}`);
    assert.equal(parse("janitor_history", { limit }).success, false, `history ${limit}`);
  }
  for (const name of ["janitor_report", "janitor_history"]) {
    assert.equal(parse(name, { category: "terminal_records" }).success, true);
    assert.equal(parse(name, { category: "release_candidates" }).success, true);
    for (const category of ["../credentials", "stale_worktrees", "TERMINAL_RECORDS", ""]) {
      assert.equal(parse(name, { category }).success, false, `${name}: ${category}`);
    }
  }
  assert.equal(parse("janitor_report", { include_protected: "true" }).success, false);
  for (const outcome of ["CLEANED", "SKIPPED_ALREADY_CLEAN", "REFUSED_STALE_PREVIEW", "PARTIAL", "FAILED"]) {
    assert.equal(parse("janitor_history", { outcome }).success, true);
  }
  for (const outcome of ["PURGED", "CLEANING", "successful", "../secrets"]) {
    assert.equal(parse("janitor_history", { outcome }).success, false);
  }
});

test("janitor report, status and history delegate only to injected read-only methods with bounded scope", async () => {
  const tools = new Map();
  const calls = [];
  const janitor = {
    categories: () => [{ id: "terminal_records" }],
    report: async (input) => { calls.push(["report", input]); return { plan: "dry-run" }; },
    status: () => { calls.push(["status"]); return { active: false }; },
    history: async (input) => { calls.push(["history", input]); return [{ outcome: "CLEANED" }]; },
    cleanup: () => { throw new Error("cleanup must never be invoked"); },
    start: () => { throw new Error("scheduler must never start"); },
  };
  await registerRuntimeJanitorTools({
    registerTextTool: (name, config, handler) => tools.set(name, handler),
    z, janitor,
    processJsonResult: (value) => ({ wrapped: value }),
    errorResult: (error) => ({ error: error.message }),
  });

  assert.deepEqual(await tools.get("janitor_report")({
    include_protected: false, limit: 100,
  }), { wrapped: { plan: "dry-run" } });
  assert.deepEqual(await tools.get("janitor_status")({}), { wrapped: { active: false } });
  assert.deepEqual(await tools.get("janitor_history")({
    limit: 12, category: "terminal_records", outcome: "CLEANED",
  }), { wrapped: { history: [{ outcome: "CLEANED" }] } });
  assert.deepEqual(calls, [
    ["report", { category: null, includeProtected: false, limit: 100 }],
    ["status"],
    ["history", { limit: 12, category: "terminal_records", outcome: "CLEANED" }],
  ]);
});

test("janitor tool engine and formatter failures are returned once without triggering cleanup", async () => {
  const tools = new Map();
  let reports = 0;
  let statuses = 0;
  let histories = 0;
  const janitor = {
    categories: () => [{ id: "terminal_records" }],
    report: async () => { reports++; throw new Error("report unavailable"); },
    status: () => { statuses++; throw new Error("status unavailable"); },
    history: async () => { histories++; return [{ outcome: "CLEANED" }]; },
    cleanup: () => { throw new Error("cleanup forbidden"); },
  };
  await registerRuntimeJanitorTools({
    registerTextTool: (name, config, handler) => tools.set(name, handler),
    z, janitor,
    processJsonResult: () => { throw new Error("formatter unavailable"); },
    errorResult: (error) => ({ status: "error", message: error.message }),
  });
  assert.deepEqual(await tools.get("janitor_report")({
    include_protected: false, limit: 1,
  }), { status: "error", message: "report unavailable" });
  assert.deepEqual(await tools.get("janitor_status")({}), { status: "error", message: "status unavailable" });
  assert.deepEqual(await tools.get("janitor_history")({ limit: 1 }), { status: "error", message: "formatter unavailable" });
  assert.equal(reports, 1);
  assert.equal(statuses, 1);
  assert.equal(histories, 1);
});
