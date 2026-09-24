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
  assert.equal(inferCapabilityDomain("deployment_status"), "release");
  assert.equal(inferCapabilityDomain("telegram_send_message"), "integrations");
  assert.equal(inferCapabilityDomain("http_profiles"), "integrations");
  assert.equal(inferCapabilityDomain("http_profile_upsert"), "integrations");
  assert.equal(inferCapabilityDomain("http_profile_delete"), "integrations");
  assert.equal(inferCapabilityDomain("authenticated_http_request"), "integrations");
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
  for (const domain of ["files", "release", "integrations", "browser"]) {
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
    registry.invoke("release", "list_projects", { path: "README.md" }),
    /operation bulunamadı/,
  );
  assert.throws(() => registry.catalog("git"), /Bilinmeyen capability domain/u);
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
  assert.deepEqual(before.operations.map((item) => item.name), ["status"]);

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
    "future_drag_drop",
    "status",
  ]);
  const invoked = await registry.invoke("browser", "future_drag_drop", {
    source_ref: "@e1",
    target_ref: "@e2",
  });
  assert.equal(extractText(invoked), "@e1->@e2");
  const legacyInternalName = await registry.invoke("browser", "equinox_browser_future_drag_drop", {
    source_ref: "@e3",
    target_ref: "@e4",
  });
  assert.equal(extractText(legacyInternalName), "@e3->@e4");
});

test("unified discovery plus semantic call gateways expose the compact stable surface", async () => {
  const registry = createCapabilityRegistry();
  registry.register({
    name: "equinox_browser_future_drag_drop",
    config: {
      description: "Future dynamic browser operation",
      inputSchema: { source_ref: z.string(), target_ref: z.string() },
      annotations: { title: "Drag and drop", readOnlyHint: false, destructiveHint: false },
    },
    invoke: async ({ source_ref, target_ref }) => textResult(`${source_ref}->${target_ref}`),
  });

  const registered = new Map();
  const registerTextTool = (name, config, handler, options) => {
    registered.set(name, { config, handler, options });
  };
  const desktopProvider = {
    async summary() { return { count: 4 }; },
    async catalog() {
      return {
        domain: "desktop",
        label: "macOS desktop",
        count: 4,
        operations: [
          { name: "status", title: "Status", description: "Bridge status", readOnly: true, destructive: false },
          { name: "see", title: "see", description: "Inspect visible desktop UI", readOnly: false, destructive: false },
          { name: "refresh", title: "Refresh", description: "Refresh tool catalog", readOnly: false, destructive: false },
          { name: "restart", title: "Restart", description: "Restart bridge", readOnly: false, destructive: false },
        ],
      };
    },
    async describe(operation) {
      return { domain: "desktop", name: operation, inputSchema: { type: "object", additionalProperties: false } };
    },
  };

  registerStableCapabilityGateways({
    registerTextTool,
    registerRawTool: registerTextTool,
    registry,
    textResult,
    externalDomains: { desktop: desktopProvider },
  });

  assert.deepEqual([...registered.keys()].sort(), [
    "browser_call",
    "capabilities",
    "files_call",
    "integrations_call",
    "release_call",
    "runtime_call",
  ]);
  assert.equal(registered.has("browser_tools"), false);
  assert.equal(registered.has("git_call"), false);
  assert.equal(registered.has("automation_call"), false);
  assert.equal(registered.has("services_call"), false);

  const capabilities = registered.get("capabilities");
  const browserCall = registered.get("browser_call");
  const filesCall = registered.get("files_call");
  assert.equal(capabilities.options.mcpExposed, true);
  assert.equal(browserCall.options.mcpExposed, true);
  assert.deepEqual(browserCall.options.mutationScopes, []);
  assert.match(filesCall.config.description, /prefer image_view/u);
  assert.match(filesCall.config.description, /Do not use file_export/u);
  assert.equal(filesCall.config.outputSchema, undefined);

  const summary = JSON.parse(extractText(await capabilities.handler({})));
  assert.equal(summary.domains.some((item) => item.domain === "desktop" && item.count === 4), true);
  assert.equal(summary.domains.some((item) => item.domain === "git"), false);
  const filesSummary = summary.domains.find((item) => item.domain === "files");
  assert.match(filesSummary.usageHint, /image_view/u);
  assert.match(filesSummary.usageHint, /file_export/u);

  const filesCatalog = JSON.parse(extractText(await capabilities.handler({ domain: "files" })));
  assert.match(filesCatalog.usageHint, /image_view/u);
  assert.match(filesCatalog.usageHint, /container/u);

  const catalog = JSON.parse(extractText(await capabilities.handler({ domain: "browser" })));
  assert.equal(catalog.count, 1);
  assert.equal(catalog.operations[0].name, "future_drag_drop");

  const filteredDesktop = JSON.parse(extractText(await capabilities.handler({ domain: "desktop", query: "visible" })));
  assert.deepEqual(filteredDesktop.operations.map((item) => item.name), ["see"]);

  const descriptor = JSON.parse(extractText(await capabilities.handler({ domain: "browser", operation: "future_drag_drop" })));
  assert.equal(descriptor.name, "future_drag_drop");
  assert.equal(descriptor.inputSchema.properties.source_ref.type, "string");

  const callResult = await browserCall.handler({
    operation: "future_drag_drop",
    arguments: { source_ref: "@e4", target_ref: "@e8" },
  });
  assert.equal(extractText(callResult), "@e4->@e8");

  await assert.rejects(() => capabilities.handler({ query: "snapshot" }), /domain zorunludur/u);
  await assert.rejects(() => capabilities.handler({ domain: "browser", query: "snap", operation: "snapshot" }), /aynı anda/u);
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
    registerRawTool: (name, config, handler, options) => registered.set(name, { config, handler, options }),
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

test("stable files gateway exposes one native ChatGPT file parameter and injects it into dynamic operation arguments", async () => {
  const registry = createCapabilityRegistry();
  const calls = [];
  registry.register({
    name: "file_import",
    domain: "files",
    config: {
      inputSchema: {
        file: z.object({
          download_url: z.string(),
          file_id: z.string(),
          mime_type: z.string().optional(),
          file_name: z.string().optional(),
        }),
      },
      annotations: { readOnlyHint: false },
    },
    invoke: async (input) => {
      calls.push(input);
      return textResult("import-ok");
    },
  });

  const registered = new Map();
  registerStableCapabilityGateways({
    registerTextTool: (name, config, handler, options) => registered.set(name, { config, handler, options }),
    registerRawTool: (name, config, handler, options) => registered.set(name, { config, handler, options }),
    registry,
    textResult,
  });

  const filesCall = registered.get("files_call");
  const runtimeCall = registered.get("runtime_call");
  assert.deepEqual(filesCall.config._meta, { "openai/fileParams": ["file"] });
  assert.equal(filesCall.config.inputSchema.file.safeParse({
    download_url: "https://files.example.invalid/samet-test.txt",
    file_id: "file_123",
    mime_type: "text/plain",
    file_name: "samet-test.txt",
  }).success, true);
  assert.equal(runtimeCall.config._meta, undefined);
  assert.equal(runtimeCall.config.inputSchema.file, undefined);

  const file = {
    download_url: "https://files.example.invalid/samet-test.txt",
    file_id: "file_123",
    mime_type: "text/plain",
    file_name: "samet-test.txt",
  };
  const result = await filesCall.handler({
    operation: "file_import",
    arguments: {},
    file,
  });
  assert.equal(extractText(result), "import-ok");
  assert.deepEqual(calls, [{ file }]);
});

test("stable files gateway preserves embedded MCP resource content", async () => {
  const registry = createCapabilityRegistry();
  const resource = {
    type: "resource",
    resource: {
      uri: "equinox-local://file-export/selene-test.txt",
      mimeType: "text/plain",
      blob: "aGVsbG8=",
    },
    annotations: { audience: ["user"], priority: 1 },
  };
  registry.register({
    name: "file_export",
    domain: "files",
    config: { inputSchema: {}, annotations: { readOnlyHint: true } },
    invoke: async () => ({
      content: [{ type: "text", text: "file-ok" }, resource],
    }),
  });

  const registered = new Map();
  registerStableCapabilityGateways({
    registerTextTool: (name, config, handler, options) => registered.set(name, { config, handler, options }),
    registerRawTool: (name, config, handler, options) => registered.set(name, { config, handler, options }),
    registry,
    textResult,
  });
  const result = await registered.get("files_call").handler({ operation: "file_export", arguments: {} });
  assert.deepEqual(result.content, [{ type: "text", text: "file-ok" }, resource]);
  assert.deepEqual(result.structuredContent, { text: "file-ok" });
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
    registerRawTool: (name, config, handler, options) => registered.set(name, { config, handler, options }),
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

test("stable capability gateways route top-level calls through Turn Budget preparation and result decoration", async () => {
  const registry = createCapabilityRegistry();
  registry.register({
    name: "equinox_browser_status",
    config: { inputSchema: {}, annotations: { readOnlyHint: true } },
    invoke: async () => textResult("browser-ok"),
  });

  const events = [];
  const turnBudgetController = {
    async prepareInvocation(toolName, input) {
      events.push({ phase: "prepare", toolName, input });
      return { input, firstNotice: toolName === "capabilities", waitClamped: false };
    },
    decorateResult(result, context) {
      events.push({ phase: "decorate", context });
      return {
        ...result,
        content: result.content.map((item) => item.type === "text"
          ? { ...item, text: `${item.text}\nTURN-BUDGET` }
          : item),
      };
    },
  };

  const registered = new Map();
  registerStableCapabilityGateways({
    registerTextTool: (name, config, handler, options) => registered.set(name, { config, handler, options }),
    registerRawTool: (name, config, handler, options) => registered.set(name, { config, handler, options }),
    registry,
    textResult,
    turnBudgetController,
  });

  const capabilities = await registered.get("capabilities").handler({ domain: "browser" });
  assert.match(extractText(capabilities), /TURN-BUDGET/u);
  const browser = await registered.get("browser_call").handler({ operation: "status", arguments: {} });
  assert.equal(extractText(browser), "browser-ok\nTURN-BUDGET");
  assert.deepEqual(events.filter((item) => item.phase === "prepare").map((item) => item.toolName), [
    "capabilities",
    "browser_call",
  ]);
  assert.equal(events.filter((item) => item.phase === "decorate").length, 2);
});
