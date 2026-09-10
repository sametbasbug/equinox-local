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
  assert.equal(inferCapabilityDomain("list_projects"), "files");
  assert.equal(inferCapabilityDomain("equinox_browser_click"), "browser");
  assert.equal(inferCapabilityDomain("deployment_status"), "services");
  assert.equal(inferCapabilityDomain("telegram_send_message"), "services");
  assert.equal(inferCapabilityDomain("system_doctor"), "runtime");
  assert.equal(inferCapabilityDomain("terminal_exec"), "runtime");
  for (const retired of [
    "apply_patch",
    "copy_between_projects",
    "create_directory",
    "create_file",
    "delete_file",
    "file_hash",
    "list_files",
    "move_file",
    "project_info",
    "read_file",
    "remove_empty_directory",
    "replace_text",
    "search_text",
    "write_file",
    "checkout_main",
    "checkout_work_branch",
    "cleanup_work_branch",
    "commit_changes",
    "create_branch",
    "git_diff",
    "git_head",
    "git_log",
    "git_show",
    "git_status",
    "list_work_branches",
    "push_branch",
    "revert_commit",
    "sync_main",
    "worktree_create",
    "worktree_list",
    "worktree_remove",
    "list_package_scripts",
    "npm_audit",
    "npm_ci",
    "npm_install_package",
    "npm_outdated",
    "npm_project_info",
    "npm_remove_package",
    "npm_view_package",
    "dns_status",
    "port_status",
    "run_build",
    "run_project_script",
    "workflow_cancel",
    "workflow_list",
    "workflow_logs",
    "workflow_recipes",
    "workflow_resume",
    "workflow_start",
    "workflow_status",
    "authenticated_command",
    "close_pull_request",
    "create_pull_request",
    "get_pull_request",
    "get_pull_request_checks",
    "merge_pull_request",
    "set_pull_request_draft",
    "update_pull_request",
    "cancel_workflow_run",
    "get_workflow_run",
    "list_workflow_runs",
    "rerun_failed_workflow",
    "delete_inbox_asset",
    "export_asset",
    "import_asset",
    "inspect_inbox_asset",
    "list_asset_inbox",
    "rollback_snapshot",
    "recovery_history",
    "recovery_policies",
    "repair_recipes",
  ]) {
    assert.equal(inferCapabilityDomain(retired), null, `${retired} must stay retired`);
  }
  for (const retiredPrefix of ["git_", "worktree_", "npm_", "workflow_"]) {
    assert.equal(
      inferCapabilityDomain(`${retiredPrefix}future_wrapper`),
      null,
      `${retiredPrefix} wrapper family must stay retired`,
    );
  }
  assert.equal(inferCapabilityDomain("desktop_call"), null);
  assert.equal(inferCapabilityDomain("visual_capture"), null);
  assert.equal(inferCapabilityDomain("visual_matrix"), null);
  assert.equal(inferCapabilityDomain("visual_compare"), null);
  assert.equal(inferCapabilityDomain("browser_call"), null);
});

test("terminal_exec is cataloged only under the runtime gateway", () => {
  const registry = createCapabilityRegistry();
  registry.register({
    name: "terminal_exec",
    config: {
      description: "Run a finite shell command",
      inputSchema: { command: z.string().min(1) },
      annotations: {
        title: "Terminal exec",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    invoke: async () => textResult("ok"),
  });

  assert.deepEqual(registry.catalog("runtime").operations.map((item) => item.name), ["terminal_exec"]);
  for (const domain of ["files", "git", "automation", "services", "browser"]) {
    assert.equal(registry.catalog(domain).operations.some((item) => item.name === "terminal_exec"), false);
  }
});

test("registry lists, describes, validates and invokes operations through live schemas", async () => {
  const registry = createCapabilityRegistry();
  const calls = [];

  registry.register({
    name: "list_projects",
    config: {
      description: "List projects",
      inputSchema: {
        project: z.string().default("demo"),
        path: z.string().min(1),
        limit: z.number().int().positive().default(10),
      },
      annotations: {
        title: "List projects",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    invoke: async (input) => {
      calls.push(input);
      return textResult(`list:${input.project}:${input.path}:${input.limit}`);
    },
  });

  const catalog = registry.catalog("files");
  assert.equal(catalog.count, 1);
  assert.deepEqual(catalog.operations[0], {
    name: "list_projects",
    title: "List projects",
    description: "List projects",
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
  });

  const descriptor = registry.describe("files", "list_projects");
  assert.equal(descriptor.domain, "files");
  assert.equal(descriptor.inputSchema.type, "object");
  assert.equal(descriptor.inputSchema.additionalProperties, false);
  assert.equal(descriptor.inputSchema.properties.path.type, "string");

  const result = await registry.invoke("files", "list_projects", { path: "README.md" });
  assert.equal(extractText(result), "list:demo:README.md:10");
  assert.deepEqual(calls, [{ project: "demo", path: "README.md", limit: 10 }]);

  await assert.rejects(
    registry.invoke("files", "list_projects", { path: "README.md", surprise: true }),
    /unrecognized|invalid|unknown/i,
  );
  await assert.rejects(
    registry.invoke("git", "list_projects", { path: "README.md" }),
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

test("stable gateways preserve MCP image content while normalizing structured output", async () => {
  const registry = createCapabilityRegistry();
  registry.register({
    name: "image_view",
    domain: "files",
    config: { inputSchema: {}, annotations: { readOnlyHint: true } },
    invoke: async () => ({
      content: [
        { type: "text", text: "image-ok" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
      structuredContent: { privateShape: true },
    }),
  });

  const registered = new Map();
  registerStableCapabilityGateways({
    registerTextTool: (name, config, handler, options) => registered.set(name, { config, handler, options }),
    registry,
    textResult,
  });
  const result = await registered.get("files_call").handler({ operation: "image_view", arguments: {} });
  assert.deepEqual(result.content, [
    { type: "text", text: "image-ok" },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ]);
  assert.deepEqual(result.structuredContent, { text: "image-ok" });
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
    name: "runtime_duplicate_probe",
    config: { inputSchema: {} },
    invoke: async () => textResult("ok"),
  };
  registry.register(registration);
  assert.throws(() => registry.register(registration), /zaten kayıtlı/);
});
