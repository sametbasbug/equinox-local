import assert from "node:assert/strict";
import test from "node:test";
import { registerRecoveryPolicyTools } from "../../src/recovery-policy-tools.js";

function fakeController() {
  return {
    status: async () => ({ enabled: true, policyCount: 1, activeJobCount: 0, openCircuitCount: 0, circuits: [] }),
  };
}

test("recovery policy module registers the v4.0.3 read-only tool set", async () => {
  const tools = [];
  const result = await registerRecoveryPolicyTools({
    registerTextTool: (name, definition, handler, options) => {
      tools.push({ name, definition, handler, options });
    },
    recoveryPolicyController: fakeController(),
    processJsonResult: (value) => value,
    errorResult: (error) => ({ error: error.message }),
  });

  assert.equal(result.toolCount, 1);
  assert.deepEqual(tools.map((tool) => tool.name), [
    "recovery_status",
  ]);
  assert.equal(tools.every((tool) => tool.definition.annotations.readOnlyHint === true), true);
  assert.equal(tools.every((tool) => tool.definition.annotations.destructiveHint === false), true);
  assert.equal(tools.every((tool) => tool.options.projectAware === false), true);
});
