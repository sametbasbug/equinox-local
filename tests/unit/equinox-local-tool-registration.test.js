import assert from "node:assert/strict";
import test from "node:test";

import { createEquinoxLocalToolRegistrar } from "../../src/equinox-local-tool-registration.js";

function makeRegistrar(overrides = {}) {
  const calls = {
    registrations: [],
    capabilities: [],
    replay: [],
    locks: [],
    contexts: [],
    notes: 0,
    mutationChecks: [],
  };
  const server = {
    registerTool(name, config, handler) {
      const registration = { name, config, handler };
      calls.registrations.push(registration);
      return registration;
    },
  };
  const capabilityRegistry = {
    register(capability) {
      calls.capabilities.push(capability);
    },
  };
  const dependencies = {
    server,
    capabilityRegistry,
    runtimeRestartGuardError: () => null,
    errorResult: (error) => ({ isError: true, error: error.message }),
    agentControl: {
      assertMutationAllowed(name) {
        calls.mutationChecks.push(name);
      },
    },
    noteManagedAgentCommand: async () => { calls.notes += 1; },
    mcpToolReplayGuard: {
      run(request) {
        calls.replay.push(request);
        return request.invoke();
      },
    },
    getToolMutationScopes: (...args) => args,
    getMutationLockPlan: (scopes, context) => ({ scopes, context }),
    withMutationLockPlan: async (plan, invoke) => {
      calls.locks.push(plan);
      return invoke();
    },
    projectContextStorage: {
      run(context, invoke) {
        calls.contexts.push(context);
        return invoke();
      },
    },
    defaultProject: "default-project",
    projectIdSchema: { type: "project-id" },
    resolveProjectContext: async (project) => ({ project, resolved: true }),
    z: { string: () => ({ type: "string" }) },
    extractTextContent: (result) => result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
    ...overrides,
  };
  return { registrar: createEquinoxLocalToolRegistrar(dependencies), calls };
}

test("text registration adds project/default output schemas and preserves context, locks, result adaptation, and MCP extra", async () => {
  const { registrar, calls } = makeRegistrar();
  const config = {
    description: "Preserve tool metadata",
    inputSchema: { value: { type: "string" } },
    annotations: { title: "Text tool", readOnlyHint: false },
    customMetadata: { retained: true },
  };
  let handlerArgs;
  const registration = registrar.registerTextTool(
    "text_tool",
    config,
    async (...args) => {
      handlerArgs = args;
      return { content: [{ type: "text", text: "primary" }, { type: "image", data: "opaque" }] };
    },
    { mcpExposed: true, capabilityDomain: "fixture" },
  );
  const extra = { requestId: "mcp-extra" };
  const result = await registration.handler({ project: "chosen", value: "input" }, extra);

  assert.equal(registration, calls.registrations[0]);
  assert.equal(registration.config.description, config.description);
  assert.equal(registration.config.customMetadata, config.customMetadata);
  assert.equal(registration.config.annotations, config.annotations);
  assert.deepEqual(registration.config.inputSchema, {
    project: { type: "project-id" },
    value: { type: "string" },
  });
  assert.deepEqual(registration.config.outputSchema, { text: { type: "string" } });
  assert.deepEqual(handlerArgs, [{ value: "input" }, extra]);
  assert.deepEqual(calls.contexts, [{ project: "chosen", resolved: true }]);
  assert.equal(calls.locks.length, 1);
  assert.equal(calls.locks[0].context.project, "chosen");
  assert.equal(calls.replay[0].toolName, "text_tool");
  assert.deepEqual(calls.replay[0].input, { project: "chosen", value: "input" });
  assert.equal(calls.replay[0].extra, extra);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "primary" }, { type: "image", data: "opaque" }],
    structuredContent: { text: "primary" },
  });
  assert.equal(calls.capabilities[0].domain, "fixture");
  assert.equal(calls.capabilities[0].config, registration.config);
  assert.equal(registrar.registeredToolCount, 1);

  await registration.handler({ value: "defaulted" });
  assert.deepEqual(handlerArgs, [{ value: "defaulted" }]);
  assert.equal(calls.contexts[1].project, "default-project");
  assert.equal(calls.locks.length, 2);
});

test("raw registration preserves multimodal results and config without project injection or automatic locks", async () => {
  const { registrar, calls } = makeRegistrar();
  const config = {
    inputSchema: { payload: { type: "image" } },
    outputSchema: { content: { type: "array" } },
    annotations: { title: "Raw tool", readOnlyHint: false },
    extra: "unchanged",
  };
  const multimodal = {
    content: [
      { type: "image", data: "raw-image-data", mimeType: "image/png" },
      { type: "text", text: "raw result" },
    ],
    structuredContent: { opaque: true },
  };
  const registration = registrar.registerRawTool(
    "raw_tool",
    config,
    async (input, extra) => {
      assert.deepEqual(input, { payload: "image" });
      assert.equal(extra.requestId, "raw-extra");
      return multimodal;
    },
    { mcpExposed: true },
  );
  const extra = { requestId: "raw-extra" };
  const result = await registration.handler({ payload: "image" }, extra);

  assert.equal(registration.config, config);
  assert.equal(result, multimodal);
  assert.equal(calls.contexts.length, 0);
  assert.equal(calls.locks.length, 0);
  assert.deepEqual(calls.capabilities[0].inputSchema, config.inputSchema);
  assert.equal(calls.capabilities[0].config, config);
  assert.equal(calls.replay[0].input.payload, "image");
  assert.equal(calls.replay[0].extra, extra);
});

test("non-MCP registrations skip replay, command milestones, and MCP registration", async () => {
  const { registrar, calls } = makeRegistrar();
  registrar.registerRawTool("internal_tool", {}, async () => ({ ok: true }));
  assert.deepEqual(await calls.capabilities[0].invoke({}), { ok: true });

  assert.equal(calls.registrations.length, 0);
  assert.equal(calls.replay.length, 0);
  assert.equal(calls.notes, 0);
  assert.equal(registrar.registeredToolCount, 0);
  assert.equal(calls.capabilities.length, 1);
});

test("shared restart and pause guards return error results before invoking handlers", async () => {
  let restartPending = true;
  let pauseBlocked = false;
  const { registrar, calls } = makeRegistrar({
    runtimeRestartGuardError: (name) => restartPending ? new Error(`${name} restarting`) : null,
    agentControl: {
      assertMutationAllowed(name) {
        calls.mutationChecks.push(name);
        if (pauseBlocked) throw new Error(`${name} paused`);
      },
    },
  });
  let invoked = 0;
  const raw = registrar.registerRawTool("guarded", {}, async () => {
    invoked += 1;
    return { ok: true };
  }, { mcpExposed: true });

  assert.deepEqual(await raw.handler({}), { isError: true, error: "guarded restarting" });
  restartPending = false;
  pauseBlocked = true;
  assert.deepEqual(await raw.handler({}), { isError: true, error: "guarded paused" });
  assert.equal(invoked, 0);
  assert.equal(calls.notes, 0);
});

test("text handler awaits async failures and adapts them through errorResult", async () => {
  const { registrar, calls } = makeRegistrar();
  const registration = registrar.registerTextTool(
    "text_failure",
    { annotations: { title: "Read-only", readOnlyHint: true } },
    async () => {
      await Promise.resolve();
      throw new Error("handler failed");
    },
    { projectAware: false, mcpExposed: true },
  );
  const extra = { requestId: "failure-extra" };

  assert.deepEqual(await registration.handler({ value: 1 }, extra), {
    isError: true,
    error: "handler failed",
  });
  assert.equal(calls.locks.length, 1);
  assert.equal(calls.locks[0].context, undefined);
  assert.equal(calls.mutationChecks.length, 0);
  assert.equal(calls.notes, 1);
  assert.equal(calls.replay[0].extra, extra);
});
