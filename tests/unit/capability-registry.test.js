import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod/v4";

import {
  STABLE_CAPABILITY_DOMAINS,
  createCapabilityRegistry,
  inferCapabilityDomain,
  registerStableCapabilityGateways,
} from "../../src/capability-registry.js";

function textResult(text) {
  return {
    content: [{ type: "text", text }],
  };
}

function extractText(result) {
  return result.content?.find((item) => item?.type === "text")?.text ?? "";
}

test("inferCapabilityDomain keeps broad stable domains and excludes already-dynamic bridges", () => {
  assert.equal(inferCapabilityDomain("read_file"), "files");
  assert.equal(inferCapabilityDomain("project_info"), "files");
  assert.equal(inferCapabilityDomain("git_status"), "git");
  assert.equal(inferCapabilityDomain("equinox_browser_click"), "browser");
  assert.equal(inferCapabilityDomain("workflow_start"), "automation");
  assert.equal(inferCapabilityDomain("deployment_status"), "services");
  assert.equal(inferCapabilityDomain("telegram_send_message"), "services");
  assert.equal(inferCapabilityDomain("system_doctor"), "runtime");
  assert.equal(inferCapabilityDomain("desktop_call"), null);
  assert.equal(inferCapabilityDomain("visual_capture"), null);
  assert.equal(inferCapabilityDomain("visual_matrix"), null);
  assert.equal(inferCapabilityDomain("visual_compare"), null);
  assert.equal(inferCapabilityDomain("browser_call"), null);
});

test("registry lists, describes, validates and invokes operations through live schemas", async () => {
  const registry = createCapabilityRegistry();
  const calls = [];

  registry.register({
    name: "read_file",
    config: {
      description: "Read a file",
      inputSchema: {
        project: z.string().default("demo"),
        path: z.string().min(1),
        limit: z.number().int().positive().default(10),
      },
      annotations: {
        title: "Read file",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    invoke: async (input) => {
      calls.push(input);
      return textResult(`read:${input.project}:${input.path}:${input.limit}`);
    },
  });

  const catalog = registry.catalog("files");
  assert.equal(catalog.count, 1);
  assert.deepEqual(catalog.operations[0], {
    name: "read_file",
    title: "Read file",
    description: "Read a file",
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  });

  const descriptor = registry.describe("files", "read_file");
  assert.equal(descriptor.domain, "files");
  assert.equal(descriptor.inputSchema.type, "object");
  assert.equal(descriptor.inputSchema.additionalProperties, false);
  assert.equal(descriptor.inputSchema.properties.path.type, "string");

  const result = await registry.invoke("files", "read_file", { path: "README.md" });
  assert.equal(extractText(result), "read:demo:README.md:10");
  assert.deepEqual(calls, [{ project: "demo", path: "README.md", limit: 10 }]);

  await assert.rejects(
    registry.invoke("files", "read_file", { path: "README.md", surprise: true }),
    /unrecognized|invalid|unknown/i,
  );
  await assert.rejects(
    registry.invoke("git", "read_file", { path: "README.md" }),
    /operation bulunamadı/,
  );
});

test("registry can gain a new operation without changing the stable gateway definition", async () => {
  const registry = createCapabilityRegistry();

  registry.register({
    name: "equinox_browser_status",
    config: {
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    invoke: async () => textResult("status"),
  });

  const before = registry.catalog("browser");
  assert.deepEqual(before.operations.map((item) => item.name), ["equinox_browser_status"]);

  registry.register({
    name: "equinox_browser_future_drag_drop",
    config: {
      inputSchema: {
        source_ref: z.string(),
        target_ref: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    invoke: async ({ source_ref, target_ref }) => textResult(`${source_ref}->${target_ref}`),
  });

  const after = registry.catalog("browser");
  assert.deepEqual(after.operations.map((item) => item.name), [
    "equinox_browser_future_drag_drop",
    "equinox_browser_status",
  ]);
  const invoked = await registry.invoke("browser", "equinox_browser_future_drag_drop", {
    source_ref: "@e1",
    target_ref: "@e2",
  });
  assert.equal(extractText(invoked), "@e1->@e2");
});

test("stable gateways use free-form operation strings and delegate to the registry", async () => {
  const registry = createCapabilityRegistry();
  registry.register({
    name: "equinox_browser_future_drag_drop",
    config: {
      description: "Future dynamic browser operation",
      inputSchema: {
        source_ref: z.string(),
        target_ref: z.string(),
      },
      annotations: {
        title: "Drag and drop",
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    invoke: async ({ source_ref, target_ref }) => textResult(`${source_ref}->${target_ref}`),
  });

  const registered = new Map();
  const registerTextTool = (name, config, handler, options) => {
    registered.set(name, { config, handler, options });
  };

  registerStableCapabilityGateways({ registerTextTool, registry, textResult });

  assert.equal(registered.size, Object.keys(STABLE_CAPABILITY_DOMAINS).length * 2);
  const browserTools = registered.get("browser_tools");
  const browserCall = registered.get("browser_call");
  assert.ok(browserTools);
  assert.ok(browserCall);
  assert.equal(browserTools.options.capability, false);
  assert.equal(browserTools.options.mcpExposed, true);
  assert.equal(browserCall.options.mcpExposed, true);
  assert.deepEqual(browserCall.options.mutationScopes, []);

  const arbitraryOperationName = "equinox_browser_operation_added_after_public_release";
  assert.equal(
    browserCall.config.inputSchema.operation.safeParse(arbitraryOperationName).success,
    true,
  );

  const catalogResult = await browserTools.handler({});
  const catalog = JSON.parse(extractText(catalogResult));
  assert.equal(catalog.count, 1);
  assert.equal(catalog.operations[0].name, "equinox_browser_future_drag_drop");

  const descriptorResult = await browserTools.handler({ operation: "equinox_browser_future_drag_drop" });
  const descriptor = JSON.parse(extractText(descriptorResult));
  assert.equal(descriptor.inputSchema.properties.source_ref.type, "string");

  const callResult = await browserCall.handler({
    operation: "equinox_browser_future_drag_drop",
    arguments: { source_ref: "@e4", target_ref: "@e8" },
  });
  assert.equal(extractText(callResult), "@e4->@e8");
});

test("stable gateways normalize custom structured results to their stable text output schema", async () => {
  const registry = createCapabilityRegistry();
  registry.register({
    name: "runtime_structured_probe",
    config: { inputSchema: {}, annotations: { readOnlyHint: true } },
    invoke: async () => ({
      content: [{ type: "text", text: "probe-ok" }],
      structuredContent: { status: "ok", nested: true },
    }),
  });

  const registered = new Map();
  registerStableCapabilityGateways({
    registerTextTool: (name, config, handler, options) => registered.set(name, { config, handler, options }),
    registry,
    textResult,
  });
  const result = await registered.get("runtime_call").handler({ operation: "runtime_structured_probe", arguments: {} });
  assert.equal(extractText(result), "probe-ok");
  assert.equal(result.structuredContent, undefined);
});

test("registry rejects duplicate operations", () => {
  const registry = createCapabilityRegistry();
  const registration = {
    name: "git_status",
    config: { inputSchema: {} },
    invoke: async () => textResult("ok"),
  };
  registry.register(registration);
  assert.throws(() => registry.register(registration), /zaten kayıtlı/);
});
