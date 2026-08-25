import assert from "node:assert/strict";
import test from "node:test";

import { registerRepairTools } from "../../src/repair-tools.js";

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
    activeRepairCount: 0,
    recipes: () => [],
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

  assert.equal(result.toolCount, 3);
  assert.deepEqual(registered.map((item) => item.name), [
    "repair_recipes",
    "repair_issue",
    "repair_history",
  ]);
  assert.equal(registered[0].schema.annotations.readOnlyHint, true);
  assert.equal(registered[1].schema.annotations.readOnlyHint, false);
  assert.deepEqual(registered[1].options.mutationScopes, ["global"]);
  assert.equal(registered[2].schema.annotations.readOnlyHint, true);
});
