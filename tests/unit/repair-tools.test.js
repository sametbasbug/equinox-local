import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { registerRepairTools, __test } from "../../src/repair-tools.js";

function fakeZ() {
  const chain = {
    min: () => chain,
    max: () => chain,
    regex: () => chain,
    optional: () => chain,
    default: () => chain,
    int: () => chain,
  };
  return {
    string: () => chain,
    number: () => chain,
    enum: () => chain,
  };
}

test("repair module registers the v4.0.2 fixed tool set", async () => {
  const registered = [];
  const repairEngine = {
    repairIssue: async () => ({ outcome: "RECOVERED" }),
    history: async () => [],
  };
  const result = await registerRepairTools({
    registerTextTool: (name, schema, handler, options) => {
      registered.push({ name, schema, handler, options });
    },
    z: fakeZ(),
    repairEngine,
    processJsonResult: (value) => value,
    errorResult: (error) => ({ error: error.message }),
  });

  assert.equal(result.toolCount, 2);
  assert.deepEqual(registered.map((item) => item.name), [
    "repair_issue",
    "repair_history",
  ]);
  assert.equal(registered[0].schema.annotations.readOnlyHint, false);
  assert.deepEqual(registered[0].options.mutationScopes, ["global"]);
  assert.equal(registered[1].schema.annotations.readOnlyHint, true);
});

test("repair tool schemas preserve exact global-mutation admission, fixed recipe enum and read-only audit metadata", async () => {
  const tools = new Map();
  await registerRepairTools({
    registerTextTool: (name, definition, handler, options) => tools.set(name, {definition, handler, options}),
    z,
    repairEngine: {repairIssue: async () => null, history: async () => []},
    processJsonResult: (value) => value,
    errorResult: (error) => ({error: String(error)}),
  });
  assert.deepEqual([...tools.keys()], ["repair_issue", "repair_history"]);
  assert.deepEqual([...__test.REPAIR_OUTCOMES], ["RECOVERED", "FAILED", "NEEDS_INTERVENTION"]);
  assert.deepEqual([...__test.REPAIR_RECIPE_IDS], [
    "peekaboo_bridge_restart",
    "stale_preview_cleanup",
    "orphan_process_cleanup",
    "stale_workflow_recover",
  ]);
  const repair = tools.get("repair_issue");
  const history = tools.get("repair_history");
  assert.deepEqual(repair.options, {projectAware: false, mutationScopes: ["global"]});
  assert.deepEqual(history.options, {projectAware: false});
  assert.deepEqual(repair.definition.annotations, {
    title: "Incident için güvenli repair çalıştır",
    readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false,
  });
  assert.deepEqual(history.definition.annotations, {
    title: "Repair geçmişini göster",
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  assert.match(repair.definition.description, /koşul değişmişse mutasyon yapmaz/u);
  assert.match(history.definition.description, /credential/u);
  const parse = (entry, input) => z.object(entry.definition.inputSchema).safeParse(input);
  assert.equal(parse(repair, {incident_id: "inc-a1234", recipe_id: "peekaboo_bridge_restart"}).success, true);
  assert.deepEqual(parse(history, {}).data, {limit: 50});
  assert.equal(parse(history, {limit: 1, outcome: "NEEDS_INTERVENTION"}).success, true);
  assert.equal(parse(history, {limit: 500, recipe_id: "stale_workflow_recover"}).success, true);
  for (const bad of [
    {}, {incident_id:"inc-"}, {incident_id:"inc-../../secret"},
    {incident_id:"inc-ABCDEF"}, {incident_id:"inc-"+"a".repeat(178)},
    {incident_id:"inc-a1234",recipe_id:"shell_exec"},
    {incident_id:"inc-a1234",recipe_id:"private-token"},
  ]) {
    assert.equal(parse(repair,bad).success,false,JSON.stringify(bad));
  }
  for (const bad of [
    {limit: 0}, {limit:501}, {limit:1.5}, {limit:"50"},
    {outcome:"PURGED"}, {recipe_id:"arbitrary_command"},
    {incident_id:"inc-../../private"}, {incident_id:"inc-ABCDEF"},
  ]) {
    assert.equal(parse(history,bad).success,false,JSON.stringify(bad));
  }
});

test("repair dispatch delegates only the validated fixed incident/recipe pair and audit filters", async () => {
  const tools = new Map();
  const effects = [];
  await registerRepairTools({
    registerTextTool: (name, definition, handler) => tools.set(name, handler),
    z,
    repairEngine: {
      repairIssue: async (input) => {effects.push(["repairIssue",input]);return {outcome:"RECOVERED"};},
      history: async (input) => {effects.push(["history",input]);return [{outcome:"FAILED"}];},
      arbitraryCommand: () => {throw Error("never allowed");},
      restartRuntime: () => {throw Error("never allowed");},
    },
    processJsonResult: (value) => {effects.push(["format",value]);return {wrapped:value};},
    errorResult: (error) => ({error:error.message}),
  });
  assert.deepEqual(await tools.get("repair_issue")({
    incident_id:"inc-a1234",recipe_id:"stale_preview_cleanup",
  }),{wrapped:{repair:{outcome:"RECOVERED"}}});
  assert.deepEqual(await tools.get("repair_history")({limit:50}),{wrapped:{repairs:[{outcome:"FAILED"}]}});
  assert.deepEqual(await tools.get("repair_history")({
    limit:1,recipe_id:"orphan_process_cleanup",outcome:"NEEDS_INTERVENTION",incident_id:"inc-a1234",
  }),{wrapped:{repairs:[{outcome:"FAILED"}]}});
  assert.deepEqual(effects, [
    ["repairIssue",{incidentId:"inc-a1234",recipeId:"stale_preview_cleanup"}],
    ["format",{repair:{outcome:"RECOVERED"}}],
    ["history",{limit:50,recipeId:null,outcome:null,incidentId:null}],
    ["format",{repairs:[{outcome:"FAILED"}]}],
    ["history",{limit:1,recipeId:"orphan_process_cleanup",outcome:"NEEDS_INTERVENTION",incidentId:"inc-a1234"}],
    ["format",{repairs:[{outcome:"FAILED"}]}],
  ]);
});

test("repair engine errors and result-formatter failures route once through the original error formatter", async () => {
  const tools = new Map();
  let repairCount=0,historyCount=0;
  await registerRepairTools({
    registerTextTool: (name, definition, handler) => tools.set(name, handler),
    z,
    repairEngine: {
      repairIssue: async () => {repairCount++;throw Error("repair refused");},
      history: async () => {historyCount++;return []},
    },
    processJsonResult: () => {throw Error("format failed")},
    errorResult: (error) => ({status:"error",message:error.message}),
  });
  assert.deepEqual(await tools.get("repair_issue")({
    incident_id:"inc-a1234",recipe_id:"peekaboo_bridge_restart",
  }),{status:"error",message:"repair refused"});
  assert.deepEqual(await tools.get("repair_history")({limit:1}),{status:"error",message:"format failed"});
  assert.equal(repairCount,1,"must not repeat a mutation after failure");
  assert.equal(historyCount,1);
});
