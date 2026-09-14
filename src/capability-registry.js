import * as z from "zod/v4";

export const STABLE_CAPABILITY_DOMAINS = Object.freeze({
  files: Object.freeze({
    label: "Projects & assets",
    callTool: "files_call",
    openWorldHint: false,
  }),
  browser: Object.freeze({
    label: "Equinox Browser",
    callTool: "browser_call",
    openWorldHint: true,
    usageHint: "Browser operations default to the agent's isolated Agent Browser. Use target=user only when the user's personal Chrome profile is explicitly required. The two contexts never silently fall back to each other.",
  }),
  release: Object.freeze({
    label: "Release & deployment",
    callTool: "release_call",
    openWorldHint: true,
  }),
  integrations: Object.freeze({
    label: "Integrations",
    callTool: "integrations_call",
    openWorldHint: true,
  }),
  runtime: Object.freeze({
    label: "Runtime & diagnostics",
    callTool: "runtime_call",
    openWorldHint: false,
  }),
});

export const EXTERNAL_CAPABILITY_DOMAINS = Object.freeze({
  desktop: Object.freeze({
    label: "macOS desktop",
    callTool: "desktop_call",
    usageHint: "Background-safe macOS automation through Peekaboo. Use browser_call for web content instead of desktop automation.",
  }),
});

export const CAPABILITY_DOMAIN_NAMES = Object.freeze([
  ...Object.keys(STABLE_CAPABILITY_DOMAINS),
  ...Object.keys(EXTERNAL_CAPABILITY_DOMAINS),
]);

const RETIRED_TERMINAL_FIRST_OPERATION_NAMES = new Set([
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
]);

const FILE_OPERATION_NAMES = new Set([
  "file_export",
  "file_import",
  "image_view",
  "list_projects",
]);


const RELEASE_OPERATION_NAMES = new Set([
  "baseline_promote",
]);

const INTEGRATION_OPERATION_NAMES = new Set([
  "credential_status",
  "telegram_send_message",
]);

const EXCLUDED_PREFIXES = Object.freeze([
  "desktop_",
  "visual_",
]);

const RETIRED_TERMINAL_FIRST_PREFIXES = Object.freeze([
  "git_",
  "worktree_",
  "npm_",
  "workflow_",
]);

const RETIRED_TOP_LEVEL_GATEWAY_NAMES = new Set([
  "desktop_status", "desktop_tools",
  "files_tools", "git_tools", "git_call",
  "browser_tools", "automation_tools", "automation_call",
  "services_tools", "services_call", "runtime_tools",
]);

function isStableGatewayName(name) {
  return name === "capabilities" ||
    Object.values(STABLE_CAPABILITY_DOMAINS).some((domain) => domain.callTool === name) ||
    Object.values(EXTERNAL_CAPABILITY_DOMAINS).some((domain) => domain.callTool === name) ||
    RETIRED_TOP_LEVEL_GATEWAY_NAMES.has(name);
}

export function inferCapabilityDomain(name) {
  if (typeof name !== "string" || !name) return null;
  if (isStableGatewayName(name)) return null;
  if (EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix))) return null;
  if (RETIRED_TERMINAL_FIRST_PREFIXES.some((prefix) => name.startsWith(prefix))) return null;
  if (RETIRED_TERMINAL_FIRST_OPERATION_NAMES.has(name)) return null;

  if (name.startsWith("equinox_browser_")) return "browser";
  if (FILE_OPERATION_NAMES.has(name)) return "files";
  if (
    name.startsWith("release_") ||
    name.startsWith("deployment_") ||
    RELEASE_OPERATION_NAMES.has(name)
  ) {
    return "release";
  }
  if (INTEGRATION_OPERATION_NAMES.has(name)) {
    return "integrations";
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

function publicOperationName(record) {
  if (record.domain === "browser" && record.name.startsWith("equinox_browser_")) {
    return record.name.slice("equinox_browser_".length);
  }
  return record.name;
}

function publicSummary(record) {
  const name = publicOperationName(record);
  return {
    name,
    title: record.annotations.title ?? name,
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
    const direct = records.get(name);
    if (direct?.domain === domain) return direct;
    const aliased = [...records.values()].find(
      (record) => record.domain === domain && publicOperationName(record) === name,
    );
    if (!aliased) {
      throw new Error(`${domain} capability kataloğunda operation bulunamadı: ${name}`);
    }
    return aliased;
  }

  function catalog(domain) {
    if (!Object.hasOwn(STABLE_CAPABILITY_DOMAINS, domain)) {
      throw new Error(`Bilinmeyen capability domain: ${domain}`);
    }
    const operations = [...records.values()]
      .filter((record) => record.domain === domain)
      .sort((a, b) => publicOperationName(a).localeCompare(publicOperationName(b)))
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
        callTool: STABLE_CAPABILITY_DOMAINS[domain].callTool,
        usageHint: STABLE_CAPABILITY_DOMAINS[domain].usageHint ?? null,
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

  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  const hasNonTextContent = content.some((item) => item && item.type !== "text");

  if (hasNonTextContent) {
    return {
      ...result,
      content,
      structuredContent: { text },
    };
  }

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
  externalDomains = {},
} = {}) {
  if (typeof registerTextTool !== "function" || !registry || typeof textResult !== "function") {
    throw new Error("Stable capability gateway registration bağımlılıkları eksik.");
  }

  const compactCatalog = (catalog, query) => {
    const normalizedQuery = typeof query === "string" ? query.trim().toLocaleLowerCase("en-US") : "";
    const operations = (catalog.operations ?? [])
      .filter((operation) => {
        if (!normalizedQuery) return true;
        return [operation.name, operation.title, operation.description]
          .filter((value) => typeof value === "string")
          .some((value) => value.toLocaleLowerCase("en-US").includes(normalizedQuery));
      })
      .slice(0, 80)
      .map((operation) => ({
        name: operation.name,
        title: operation.title,
        description: typeof operation.description === "string" && operation.description.length > 240
          ? `${operation.description.slice(0, 237)}...`
          : operation.description,
        readOnly: operation.readOnly,
        destructive: operation.destructive,
      }));
    return {
      domain: catalog.domain,
      label: catalog.label,
      count: operations.length,
      totalCount: catalog.count ?? operations.length,
      operations,
    };
  };

  registerTextTool(
    "capabilities",
    {
      description:
        "Equinox Local'in agent-facing capability yüzeyini keşfeder. Parametresiz çağrı domain özetlerini; domain çağrısı kompakt operation listesini; query filtreli aramayı; operation ise güncel tam JSON giriş şemasını döndürür. Yeni dinamik operation'lar top-level connector şeması değişmeden görünür.",
      inputSchema: {
        domain: z.enum(CAPABILITY_DOMAIN_NAMES).optional().describe("İsteğe bağlı capability domain"),
        query: z.string().min(1).max(160).optional().describe("Domain kataloğunda ad, başlık veya açıklama araması"),
        operation: z.string().min(1).max(160).optional().describe("Tam descriptor ve JSON şeması istenen operation adı"),
      },
      annotations: {
        title: "Equinox Local capabilities",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ domain, query, operation }) => {
      if ((query || operation) && !domain) {
        throw new Error("capabilities query/operation kullanırken domain zorunludur.");
      }
      if (query && operation) {
        throw new Error("capabilities query ve operation aynı anda kullanılamaz.");
      }
      if (!domain) {
        const staticSummary = registry.summary();
        const externalSummaries = [];
        for (const [externalDomain, definition] of Object.entries(EXTERNAL_CAPABILITY_DOMAINS)) {
          const provider = externalDomains[externalDomain];
          const summary = provider?.summary ? await provider.summary() : { count: 0 };
          externalSummaries.push({
            domain: externalDomain,
            label: definition.label,
            count: summary.count ?? 0,
            callTool: definition.callTool,
            usageHint: definition.usageHint ?? null,
          });
        }
        const domains = [...staticSummary.domains, ...externalSummaries];
        return textResult(JSON.stringify({
          operationCount: domains.reduce((total, item) => total + item.count, 0),
          domains,
        }, null, 2));
      }

      if (Object.hasOwn(EXTERNAL_CAPABILITY_DOMAINS, domain)) {
        const provider = externalDomains[domain];
        if (!provider) throw new Error(`Capability provider unavailable: ${domain}`);
        if (operation) return textResult(JSON.stringify(await provider.describe(operation), null, 2));
        return textResult(JSON.stringify(compactCatalog(await provider.catalog(), query), null, 2));
      }

      if (operation) return textResult(JSON.stringify(registry.describe(domain, operation), null, 2));
      return textResult(JSON.stringify(compactCatalog(registry.catalog(domain), query), null, 2));
    },
    {
      projectAware: false,
      mutationScopes: [],
      mcpExposed: true,
      capability: false,
    },
  );

  for (const [domain, definition] of Object.entries(STABLE_CAPABILITY_DOMAINS)) {
    const callInputSchema = {
      operation: z.string().min(1).max(160).describe("Çağrılacak dinamik Equinox Local operation adı"),
      arguments: z.record(z.string(), z.unknown()).default({}).describe("Seçilen operation'ın güncel JSON giriş şemasına uyan argümanlar"),
    };
    const callMeta = {};
    if (domain === "files") {
      callInputSchema.file = z.object({
        download_url: z.string().url(),
        file_id: z.string().min(1).max(256),
        mime_type: z.string().min(1).max(200).optional(),
        file_name: z.string().min(1).max(255).optional(),
      }).strict().optional().describe("ChatGPT tarafından native attachment bridge üzerinden sağlanan isteğe bağlı tek dosya");
      callMeta["openai/fileParams"] = ["file"];
    }

    registerTextTool(
      definition.callTool,
      {
        description:
          `${definition.label} domain'indeki tek bir operation'ı çağırır. ` +
          `Önce capabilities({domain: "${domain}"}) ile operation'ları, ardından capabilities({domain: "${domain}", operation: "..."}) ile güncel şemayı keşfet. ` +
          "Operation adları serbest string'dir; yeni operation'lar connector refresh gerektirmez." +
          (definition.usageHint ? ` ${definition.usageHint}` : ""),
        inputSchema: callInputSchema,
        annotations: {
          title: `${definition.label} capability çağrısı`,
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: definition.openWorldHint,
        },
        ...(domain === "files" ? { _meta: callMeta } : {}),
      },
      async ({ operation, arguments: operationArguments, file }) => {
        const invocationArguments = domain === "files" && file !== undefined
          ? { ...operationArguments, file }
          : operationArguments;
        const result = await registry.invoke(domain, operation, invocationArguments);
        return normalizeGatewayInvocationResult(result, textResult);
      },
      {
        projectAware: false,
        mutationScopes: [],
        mcpExposed: true,
        capability: false,
        pauseGuard: false,
      },
    );
  }
}
