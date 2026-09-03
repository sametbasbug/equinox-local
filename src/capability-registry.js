import * as z from "zod/v4";

export const STABLE_CAPABILITY_DOMAINS = Object.freeze({
  files: Object.freeze({
    label: "Files & projects",
    catalogTool: "files_tools",
    callTool: "files_call",
    openWorldHint: false,
  }),
  git: Object.freeze({
    label: "Git & GitHub",
    catalogTool: "git_tools",
    callTool: "git_call",
    openWorldHint: true,
  }),
  browser: Object.freeze({
    label: "Equinox Browser",
    catalogTool: "browser_tools",
    callTool: "browser_call",
    openWorldHint: true,
    usageHint: "Browser operations default to the agent's isolated Agent Browser. Use target=user only when the user's personal Chrome profile is explicitly required. The two contexts never silently fall back to each other.",
  }),
  automation: Object.freeze({
    label: "Automation & release",
    catalogTool: "automation_tools",
    callTool: "automation_call",
    openWorldHint: true,
  }),
  services: Object.freeze({
    label: "Services & integrations",
    catalogTool: "services_tools",
    callTool: "services_call",
    openWorldHint: true,
  }),
  runtime: Object.freeze({
    label: "Runtime & diagnostics",
    catalogTool: "runtime_tools",
    callTool: "runtime_call",
    openWorldHint: false,
  }),
});

const FILE_OPERATION_NAMES = new Set([
  "apply_patch",
  "copy_between_projects",
  "create_directory",
  "create_file",
  "delete_file",
  "delete_inbox_asset",
  "export_asset",
  "file_hash",
  "import_asset",
  "inspect_inbox_asset",
  "list_asset_inbox",
  "list_files",
  "move_file",
  "project_info",
  "read_file",
  "list_projects",
  "remove_empty_directory",
  "replace_text",
  "search_text",
  "write_file",
]);

const GIT_OPERATION_NAMES = new Set([
  "checkout_main",
  "checkout_work_branch",
  "cleanup_work_branch",
  "close_pull_request",
  "commit_changes",
  "create_branch",
  "create_pull_request",
  "get_pull_request",
  "get_pull_request_checks",
  "list_work_branches",
  "merge_pull_request",
  "push_branch",
  "revert_commit",
  "rollback_snapshot",
  "set_pull_request_draft",
  "sync_main",
  "update_pull_request",
]);

const AUTOMATION_OPERATION_NAMES = new Set([
  "baseline_promote",
  "cancel_workflow_run",
  "get_workflow_run",
  "list_workflow_runs",
  "rerun_failed_workflow",
  "run_build",
  "run_project_script",
]);

const SERVICE_OPERATION_NAMES = new Set([
  "list_package_scripts",
  "telegram_send_message",
]);

const EXCLUDED_PREFIXES = Object.freeze([
  "desktop_",
   "visual_",
]);

function isStableGatewayName(name) {
  return Object.values(STABLE_CAPABILITY_DOMAINS).some(
    (domain) => domain.catalogTool === name || domain.callTool === name,
  );
}

export function inferCapabilityDomain(name) {
  if (typeof name !== "string" || !name) return null;
  if (isStableGatewayName(name)) return null;
  if (EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) return null;

  if (name.startsWith("equinox_browser_")) return "browser";
  if (FILE_OPERATION_NAMES.has(name)) return "files";
  if (name.startsWith("git_") || name.startsWith("worktree_") || GIT_OPERATION_NAMES.has(name)) {
    return "git";
  }
  if (
    name.startsWith("workflow_") ||
    name.startsWith("release_") ||
    name.startsWith("visual_") ||
    AUTOMATION_OPERATION_NAMES.has(name)
  ) {
    return "automation";
  }
  if (name.startsWith("deployment_") || name.startsWith("npm_") || SERVICE_OPERATION_NAMES.has(name)) {
    return "services";
  }

  return "runtime";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function serializeInputSchema(schema) {
  try {
    return cloneJson(z.toJSONSchema(schema));
  } catch (error) {
    return {
      type: "object",
      additionalProperties: false,
      schemaSerializationError:
        error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeAnnotations(annotations = {}) {
  return {
    title: typeof annotations.title === "string" && annotations.title.trim()
      ? annotations.title.trim()
      : null,
    readOnly: annotations.readOnlyHint === true,
    destructive: annotations.destructiveHint === true,
    idempotent: annotations.idempotentHint === true,
    openWorld: annotations.openWorldHint === true,
  };
}

function publicSummary(record) {
  return {
    name: record.name,
    title: record.annotations.title ?? record.name,
    description: record.description,
    readOnly: record.annotations.readOnly,
    destructive: record.annotations.destructive,
    idempotent: record.annotations.idempotent,
    openWorld: record.annotations.openWorld,
  };
}

function publicDescriptor(record) {
  return {
    ...publicSummary(record),
    domain: record.domain,
    inputSchema: serializeInputSchema(record.inputObjectSchema),
  };
}

export function createCapabilityRegistry({ inferDomain = inferCapabilityDomain } = {}) {
  const records = new Map();

  function register({ name, config = {}, inputSchema, invoke, domain } = {}) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_.-]{0,159}$/.test(name)) {
      throw new Error(`Capability operation adı geçersiz: ${String(name)}`);
    }
    if (typeof invoke !== "function") {
      throw new Error(`Capability invoke handler eksik: ${name}`);
    }
    if (records.has(name)) {
      throw new Error(`Capability operation zaten kayıtlı: ${name}`);
    }

    const resolvedDomain = domain ?? inferDomain(name);
    if (resolvedDomain === null) {
      return { registered: false, name, domain: null };
    }
    if (!Object.hasOwn(STABLE_CAPABILITY_DOMAINS, resolvedDomain)) {
      throw new Error(`Bilinmeyen capability domain: ${resolvedDomain}`);
    }

    const rawShape = inputSchema ?? config.inputSchema ?? {};
    const inputObjectSchema = z.strictObject(rawShape);
    const record = Object.freeze({
      name,
      domain: resolvedDomain,
      description:
        typeof config.description === "string" && config.description.trim()
          ? config.description.trim()
          : "",
      annotations: Object.freeze(normalizeAnnotations(config.annotations)),
      inputObjectSchema,
      invoke,
    });

    records.set(name, record);
    return { registered: true, name, domain: resolvedDomain };
  }

  function getRecord(domain, name) {
    if (!Object.hasOwn(STABLE_CAPABILITY_DOMAINS, domain)) {
      throw new Error(`Bilinmeyen capability domain: ${domain}`);
    }
    const record = records.get(name);
    if (!record || record.domain !== domain) {
      throw new Error(`${domain} capability kataloğunda operation bulunamadı: ${name}`);
    }
    return record;
  }

  function catalog(domain) {
    if (!Object.hasOwn(STABLE_CAPABILITY_DOMAINS, domain)) {
      throw new Error(`Bilinmeyen capability domain: ${domain}`);
    }
    const operations = [...records.values()]
      .filter((record) => record.domain === domain)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(publicSummary);
    return {
      domain,
      label: STABLE_CAPABILITY_DOMAINS[domain].label,
      count: operations.length,
      operations,
    };
  }

  function describe(domain, name) {
    return publicDescriptor(getRecord(domain, name));
  }

  async function invoke(domain, name, rawArguments = {}) {
    const record = getRecord(domain, name);
    const parsedArguments = await record.inputObjectSchema.parseAsync(rawArguments ?? {});
    return record.invoke(parsedArguments);
  }

  function summary() {
    const domains = Object.keys(STABLE_CAPABILITY_DOMAINS).map((domain) => {
      const count = [...records.values()].filter((record) => record.domain === domain).length;
      return {
        domain,
        label: STABLE_CAPABILITY_DOMAINS[domain].label,
        count,
        catalogTool: STABLE_CAPABILITY_DOMAINS[domain].catalogTool,
        callTool: STABLE_CAPABILITY_DOMAINS[domain].callTool,
      };
    });
    return {
      operationCount: domains.reduce((total, domain) => total + domain.count, 0),
      domains,
    };
  }

  return Object.freeze({
    register,
    catalog,
    describe,
    invoke,
    summary,
  });
}

function normalizeGatewayInvocationResult(result, textResult) {
  if (!result || result.isError) return result;

  const text = Array.isArray(result.content)
    ? result.content
      .filter((item) => item && item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
    : "";

  if (text) return textResult(text);

  if (result.structuredContent !== undefined) {
    return textResult(JSON.stringify(result.structuredContent, null, 2));
  }

  return textResult(JSON.stringify(result, null, 2));
}

export function registerStableCapabilityGateways({
  registerTextTool,
  registry,
  textResult,
} = {}) {
  if (typeof registerTextTool !== "function" || !registry || typeof textResult !== "function") {
    throw new Error("Stable capability gateway registration bağımlılıkları eksik.");
  }

  for (const [domain, definition] of Object.entries(STABLE_CAPABILITY_DOMAINS)) {
    registerTextTool(
      definition.catalogTool,
      {
        description:
          `${definition.label} için Equinox Local'in o an desteklediği dinamik operation kataloğunu listeler. ` +
          "Yeni runtime sürümlerindeki operation'lar bu sabit MCP tool şeması değişmeden görünür. Belirli bir operation adı verilirse güncel JSON giriş şeması döner." +
          (definition.usageHint ? ` ${definition.usageHint}` : ""),
        inputSchema: {
          operation: z
            .string()
            .min(1)
            .max(160)
            .optional()
            .describe("İsteğe bağlı operation adı; verilirse tam güncel giriş şeması döner"),
        },
        annotations: {
          title: `${definition.label} capability kataloğu`,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ operation }) => textResult(JSON.stringify(
        operation ? registry.describe(domain, operation) : registry.catalog(domain),
        null,
        2,
      )),
      {
        projectAware: false,
        mutationScopes: [],
        mcpExposed: true,
        capability: false,
      },
    );

    registerTextTool(
      definition.callTool,
      {
        description:
          `${definition.label} dinamik kataloğundaki tek bir operation'ı çağırır. ` +
          `Önce ${definition.catalogTool} ile operation ve güncel giriş şemasını keşfet. ` +
          "Operation adları bu MCP tool'un şemasında enum değildir; Equinox Local güncellendiğinde yeni operation'lar kullanıcıdan ChatGPT Eklentiler > Yenile istemeden çağrılabilir." +
          (definition.usageHint ? ` ${definition.usageHint}` : ""),
        inputSchema: {
          operation: z
            .string()
            .min(1)
            .max(160)
            .describe("Çağrılacak dinamik Equinox Local operation adı"),
          arguments: z
            .record(z.string(), z.unknown())
            .default({})
            .describe("Seçilen operation'ın güncel JSON giriş şemasına uyan argümanlar"),
        },
        annotations: {
          title: `${definition.label} capability çağrısı`,
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: definition.openWorldHint,
        },
      },
      async ({ operation, arguments: operationArguments }) => {
        const result = await registry.invoke(domain, operation, operationArguments);
        return normalizeGatewayInvocationResult(result, textResult);
      },
      {
        projectAware: false,
        mutationScopes: [],
        mcpExposed: true,
        capability: false,
      },
    );
  }
}
