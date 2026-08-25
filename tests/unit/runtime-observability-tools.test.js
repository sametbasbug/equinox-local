import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";

import { registerRuntimeObservabilityTools } from "../../src/runtime-observability-tools.js";

test("runtime observability module registers the v4.0.0 read-only tool set", () => {
  const names = [];
  const observability = {
    query: async () => [],
    metrics: async () => ({ totalEvents: 0 }),
    health: async () => ({ state: "HEALTHY" }),
  };

  registerRuntimeObservabilityTools({
    registerTextTool: (name) => names.push(name),
    z,
    observability,
    getRuntimeSnapshot: async () => ({}),
    processJsonResult: (value) => value,
    errorResult: (error) => ({ error: String(error) }),
  });

  assert.deepEqual(names, [
    "runtime_events",
    "runtime_metrics",
    "runtime_health",
  ]);
});
