import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import {
  readBoundedNormalFile,
  SAFE_FILE_ERROR_CODES,
  writeBoundedUtf8File,
} from "./equinox-local-safe-file.js";
import {
  createProtectedAgentPathChecker,
  isSensitiveAgentName,
} from "./equinox-local-agent-path-policy.js";
import {
  createTerminalManager,
  TERMINAL_KEYS,
} from "./terminal-manager.js";
import {
  createProcessManager,
  parseLsofFieldOutput,
  probeTcpPort,
} from "./process-manager.js";
import {
  copyProjectPath,
} from "./project-transfer.js";
import {
  buildManagedWorktreePath,
  isPathInside as isPathInsideRoot,
  parseGitWorktreePorcelain,
  publicWorktreeRecord,
  validateWorktreeSlug,
} from "./worktree-utils.js";
import {
  registerWorkflowTools,
} from "./workflow-tools.js";
import {
  createPeekabooBridge,
  isPeekabooControlCenterReady,
  PEEKABOO_ALLOWED_TOOLS,
} from "./peekaboo-bridge.js";
import {
  createRuntimeObservability,
} from "./runtime-observability.js";
import {
  registerRuntimeObservabilityTools,
} from "./runtime-observability-tools.js";
import {
  createEquinoxBrowserBridge,
} from "./equinox-browser-bridge.js";
import {
  equinoxBrowserSocketPath,
} from "./equinox-browser-socket.js";
import {
  registerEquinoxBrowserTools,
} from "./equinox-browser-tools.js";
import {
  createEquinoxAgentBrowser,
} from "./equinox-agent-browser.js";
import {
  createDiagnosisEngine,
} from "./diagnosis-engine.js";
import {
  registerDiagnosisTools,
} from "./diagnosis-tools.js";
import {
  createRepairEngine,
} from "./repair-engine.js";
import {
  registerRepairTools,
} from "./repair-tools.js";
import {
  createRecoveryPolicyController,
} from "./recovery-policy.js";
import {
  registerRecoveryPolicyTools,
} from "./recovery-policy-tools.js";
import {
  createRuntimeJanitor,
} from "./runtime-janitor.js";
import {
  registerRuntimeJanitorTools,
} from "./runtime-janitor-tools.js";
import {
  createEquinoxLocalConfigManager,
} from "./equinox-local-config.js";
import {
  createEquinoxLocalControlApi,
} from "./equinox-local-control-api.js";
import {
  configureTelegramIntegration,
  disconnectTelegramIntegration,
  getTelegramIntegrationStatus,
  sendTelegramMessage,
  testTelegramIntegration,
} from "./telegram-integration.js";
import {
  resolveEquinoxLocalInstallation,
} from "./equinox-local-installation.js";
import {
  createEquinoxLocalUpdater,
} from "./equinox-local-updater.js";
import {
  createEquinoxLocalUpdateCoordinator,
} from "./equinox-local-update-coordinator.js";
import {
  configureManagedTunnel,
  getManagedOnboardingStatus,
} from "./equinox-local-onboarding.js";
import {
  scheduleEquinoxLocalRestart,
} from "./equinox-local-restart.js";
import {
  scheduleEquinoxLocalUninstall,
} from "./equinox-local-uninstall.js";
import {
  getEquinoxLocalDoctorStatus,
} from "./equinox-local-doctor.js";
import {
  inspectSourceCheckoutVersion,
  inspectSourcePeekabooRuntime,
  inspectSourceTunnelRuntime,
} from "./equinox-local-source-runtime.js";
import {
  EQUINOX_LOCAL_UPDATE_KEYS,
} from "./equinox-local-update-keys.js";
import {
  EQUINOX_LOCAL_VERSION,
} from "./equinox-local-version.js";
import {
  validateIndependentGitProjectRoot,
} from "./equinox-local-bootstrap.js";
import {
  chooseLocalFolder,
} from "./control-center-platform.js";
import {
  createCapabilityRegistry,
  registerStableCapabilityGateways,
} from "./capability-registry.js";

const execFile = promisify(execFileCallback);

const equinoxLocalConfigManager = createEquinoxLocalConfigManager({
  homeDir: process.env.HOME,
});
const EQUINOX_LOCAL_CONFIG_SNAPSHOT = await equinoxLocalConfigManager.initialize();
const EQUINOX_LOCAL_CONFIG = EQUINOX_LOCAL_CONFIG_SNAPSHOT.config;
const AGENT_ACCESS = EQUINOX_LOCAL_CONFIG.agentAccess;
const FULL_FILE_ACCESS = AGENT_ACCESS.files === "full";

const DEFAULT_PROJECT = EQUINOX_LOCAL_CONFIG.defaultProject;
const WORKSPACE_PROJECT_ID = EQUINOX_LOCAL_CONFIG.runtime.workspaceProject;
const DOWNLOADS_ROOT_ID = EQUINOX_LOCAL_CONFIG.runtime.downloadsRoot;

const PROJECT_DEFINITIONS = EQUINOX_LOCAL_CONFIG.projects;
const PROJECT_IDS = Object.freeze(Object.keys(PROJECT_DEFINITIONS));
const FILE_ROOT_DEFINITIONS = Object.freeze({
  ...PROJECT_DEFINITIONS,
  ...EQUINOX_LOCAL_CONFIG.fileRoots,
});
const FILE_ROOT_IDS = Object.freeze(Object.keys(FILE_ROOT_DEFINITIONS));

const PROJECT_ID_VALUE_SCHEMA = FULL_FILE_ACCESS
  ? z.string().min(1).max(1024)
  : z.enum(PROJECT_IDS);
const FILE_ROOT_ID_VALUE_SCHEMA = FULL_FILE_ACCESS
  ? z.string().min(1).max(1024)
  : z.enum(FILE_ROOT_IDS);

const PROJECT_ID_SCHEMA = PROJECT_ID_VALUE_SCHEMA
  .default(DEFAULT_PROJECT)
  .describe(
    FULL_FILE_ACCESS
      ? `İşlem yapılacak proje kimliği, home veya erişilebilir mutlak klasör yolu; belirtilmezse ${DEFAULT_PROJECT} kullanılır.`
      : `İşlem yapılacak izinli proje kimliği; belirtilmezse ${DEFAULT_PROJECT} kullanılır. Güncel liste için list_projects aracını kullan.`,
  );

const FILE_ROOT_ID_SCHEMA = FILE_ROOT_ID_VALUE_SCHEMA
  .default(DEFAULT_PROJECT)
  .describe(
    FULL_FILE_ACCESS
      ? "Dosya kökü kimliği, home veya erişilebilir mutlak klasör yolu. Hassas dosya korumaları yine uygulanır."
      : "Dosya okunacak izinli kök; ek read-only kökler yalnız dosya erişimi ve transfer kaynağıdır. Güncel liste için list_projects aracını kullan.",
  );

const projectContextStorage =
  new AsyncLocalStorage();

const MAX_FILE_BYTES = 512 * 1024;
const MAX_COMMIT_BINARY_BYTES = 10 * 1024 * 1024;
const ALLOWED_BINARY_COMMIT_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
  ".woff",
  ".woff2",
]);
const MAX_OUTPUT_CHARS = 120_000;

const IGNORED_DIRECTORIES = new Set([
  ".git",
]);

const TRAVERSAL_SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".astro",
  ".next",
  ".cache",
  "coverage",
]);

const isProtectedAgentPath = createProtectedAgentPathChecker(process.env.HOME);

function assertNotProtectedAgentPath(absolutePath) {
  if (isProtectedAgentPath(absolutePath)) {
    throw new Error("Bu yol hassas kimlik bilgisi veya uygulama credential alanı olarak korunuyor.");
  }
}

async function resolveProjectContext(
  projectId = DEFAULT_PROJECT,
) {
  const configuredDefinition =
    PROJECT_DEFINITIONS[projectId];
  const adHocRoot =
    !configuredDefinition && FULL_FILE_ACCESS
      ? projectId === "home"
        ? process.env.HOME
        : path.isAbsolute(projectId)
          ? projectId
          : null
      : null;
  const definition =
    configuredDefinition ??
    (adHocRoot
      ? {
          name:
            projectId === "home"
              ? "Home"
              : path.basename(adHocRoot) || adHocRoot,
          root: adHocRoot,
          worktrees: false,
        }
      : null);

  if (!definition) {
    throw new Error(
      FULL_FILE_ACCESS
        ? `Proje bağlamı bulunamadı. Yapılandırılmış bir proje kimliği, home veya mutlak klasör yolu kullan: ${projectId}`
        : `İzin verilmeyen proje kimliği: ${projectId}`,
    );
  }

  const normalizedRoot = path.normalize(definition.root);
  if (!configuredDefinition && normalizedRoot === path.parse(normalizedRoot).root) {
    throw new Error("Dosya sistemi kökü doğrudan ajan çalışma kökü olarak kullanılamaz.");
  }

  let rootRealPath;

  try {
    rootRealPath =
      await fs.realpath(definition.root);
  } catch (error) {
    throw new Error(
      [
        `Proje klasörüne ulaşılamadı: ${projectId}`,
        `Beklenen yol: ${definition.root}`,
        error instanceof Error
          ? error.message
          : String(error),
      ].join("\n"),
    );
  }

  const stats = await fs.stat(rootRealPath);

  if (!stats.isDirectory()) {
    throw new Error(
      `İzinli proje kökü bir klasör değil: ${projectId}`,
    );
  }

  if (!configuredDefinition) {
    assertNotProtectedAgentPath(rootRealPath);
  }

  let kind = "directory";
  try {
    await validateIndependentGitProjectRoot(rootRealPath);
    kind = "git";
  } catch (error) {
    if (configuredDefinition) {
      throw new Error(
        [
          `İzinli proje bağımsız bir Git reposu değil: ${projectId}`,
          error instanceof Error
            ? error.message
            : String(error),
        ].join("\n"),
      );
    }
  }

  return Object.freeze({
    id: projectId,
    name: definition.name,
    configuredRoot: definition.root,
    rootRealPath,
    kind,
    configured: Boolean(configuredDefinition),
  });
}

async function resolveFileRootContext(
  rootId = DEFAULT_PROJECT,
) {
  const configuredDefinition =
    FILE_ROOT_DEFINITIONS[rootId];
  const adHocRoot =
    !configuredDefinition && FULL_FILE_ACCESS
      ? rootId === "home"
        ? process.env.HOME
        : path.isAbsolute(rootId)
          ? rootId
          : null
      : null;
  const definition =
    configuredDefinition ??
    (adHocRoot
      ? {
          name:
            rootId === "home"
              ? "Home"
              : path.basename(adHocRoot) || adHocRoot,
          root: adHocRoot,
        }
      : null);

  if (!definition) {
    throw new Error(
      FULL_FILE_ACCESS
        ? `Dosya kökü bulunamadı. Yapılandırılmış bir kök, home veya mutlak klasör yolu kullan: ${rootId}`
        : `İzin verilmeyen dosya kökü: ${rootId}`,
    );
  }

  const normalizedRoot = path.normalize(definition.root);
  if (!configuredDefinition && normalizedRoot === path.parse(normalizedRoot).root) {
    throw new Error("Dosya sistemi kökü doğrudan ajan dosya kökü olarak kullanılamaz.");
  }

  let rootRealPath;

  try {
    rootRealPath =
      await fs.realpath(definition.root);
  } catch (error) {
    throw new Error(
      [
        `Dosya köküne ulaşılamadı: ${rootId}`,
        `Beklenen yol: ${definition.root}`,
        error instanceof Error
          ? error.message
          : String(error),
      ].join("\n"),
    );
  }

  const stats = await fs.stat(rootRealPath);
  if (!stats.isDirectory()) {
    throw new Error(
      `İzinli dosya kökü bir klasör değil: ${rootId}`,
    );
  }

  if (!configuredDefinition) {
    assertNotProtectedAgentPath(rootRealPath);
  }

  return Object.freeze({
    id: rootId,
    name: definition.name,
    configuredRoot: definition.root,
    rootRealPath,
    kind: configuredDefinition && PROJECT_DEFINITIONS[rootId]
      ? "git"
      : "files",
    configured: Boolean(configuredDefinition),
  });
}

function getActiveProjectContext() {
  const context =
    projectContextStorage.getStore();

  if (!context) {
    throw new Error(
      "Aktif proje bağlamı bulunamadı.",
    );
  }

  return context;
}

function getActiveProjectRoot() {
  return getActiveProjectContext()
    .rootRealPath;
}

function getActiveProjectId() {
  return getActiveProjectContext().id;
}

function getActiveProjectName() {
  return getActiveProjectContext().name;
}

function textResult(text) {
  const output =
    text.length > MAX_OUTPUT_CHARS
      ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[Çıktı güvenlik sınırı nedeniyle kısaltıldı.]`
      : text;

  return {
    content: [{ type: "text", text: output }],
  };
}

function errorResult(error) {
  const message =
    error instanceof Error ? error.message : String(error);

  return {
    content: [{ type: "text", text: `Hata: ${message}` }],
    isError: true,
  };
}

function isInsideProject(targetPath) {
  const relative = path.relative(getActiveProjectRoot(), targetPath);

  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

const isSensitiveName = isSensitiveAgentName;

function checkRequestedPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.includes("\0")) {
    throw new Error("Geçersiz dosya yolu.");
  }

  if (path.isAbsolute(relativePath)) {
    throw new Error("Yalnızca proje köküne göre göreli yollar kullanılabilir.");
  }

  const parts = path
    .normalize(relativePath)
    .split(path.sep)
    .filter((part) => part && part !== ".");

  for (const part of parts) {
    if (IGNORED_DIRECTORIES.has(part)) {
      throw new Error(`Bu klasöre erişim kapalı: ${part}`);
    }

    if (isSensitiveName(part)) {
      throw new Error(`Bu dosyaya erişim kapalı: ${part}`);
    }
  }
}

async function safeResolve(relativePath = ".") {
  checkRequestedPath(relativePath);

  const candidate = path.resolve(getActiveProjectRoot(), relativePath);

  if (!isInsideProject(candidate)) {
    throw new Error("Proje klasörü dışına çıkma girişimi engellendi.");
  }

  const realCandidate = await fs.realpath(candidate);

  if (!isInsideProject(realCandidate)) {
    throw new Error("Sembolik bağlantı üzerinden proje dışına çıkış engellendi.");
  }
  if (FULL_FILE_ACCESS && !getActiveProjectContext().configured) {
    assertNotProtectedAgentPath(realCandidate);
  }

  return realCandidate;
}

function displayPath(absolutePath) {
  const relative = path.relative(getActiveProjectRoot(), absolutePath);
  return relative || ".";
}

async function collectEntries(directory, depth, entries) {
  if (entries.length >= 250) {
    return;
  }

  const dirEntries = await fs.readdir(directory, {
    withFileTypes: true,
  });

  dirEntries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of dirEntries) {
    if (entries.length >= 250) {
      return;
    }

    const absolutePath = path.join(directory, entry.name);
    if (
      entry.isSymbolicLink() ||
      TRAVERSAL_SKIPPED_DIRECTORIES.has(entry.name) ||
      isSensitiveName(entry.name) ||
      (FULL_FILE_ACCESS &&
        !getActiveProjectContext().configured &&
        isProtectedAgentPath(absolutePath))
    ) {
      continue;
    }

    const relativePath = displayPath(absolutePath);

    if (entry.isDirectory()) {
      entries.push(`${relativePath}/`);

      if (depth > 0) {
        await collectEntries(absolutePath, depth - 1, entries);
      }
    } else if (entry.isFile()) {
      entries.push(relativePath);
    }
  }
}

async function collectSearchFiles(directory, files, limit = 1200) {
  if (files.length >= limit) {
    return;
  }

  const entries = await fs.readdir(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (files.length >= limit) {
      return;
    }

    const absolutePath = path.join(directory, entry.name);
    if (
      entry.isSymbolicLink() ||
      TRAVERSAL_SKIPPED_DIRECTORIES.has(entry.name) ||
      isSensitiveName(entry.name) ||
      (FULL_FILE_ACCESS &&
        !getActiveProjectContext().configured &&
        isProtectedAgentPath(absolutePath))
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      await collectSearchFiles(absolutePath, files, limit);
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
}

async function runGit(args) {
  if (getActiveProjectContext().kind !== "git") {
    throw new Error("Bu işlem bir Git proje kökü gerektiriyor.");
  }

  const { stdout, stderr } = await execFile("git", args, {
    cwd: getActiveProjectRoot(),
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });

  return [stdout, stderr].filter(Boolean).join("\n").trim();
}

const SERVER_NAME =
  "equinox-local-multiproject";
const SERVER_VERSION = EQUINOX_LOCAL_VERSION;
const equinoxLocalInstallation = resolveEquinoxLocalInstallation({
  homeDir: process.env.HOME,
  env: process.env,
});
const equinoxLocalUpdater = createEquinoxLocalUpdater({
  currentVersion: SERVER_VERSION,
  installation: equinoxLocalInstallation,
  publicKeys: EQUINOX_LOCAL_UPDATE_KEYS,
});
const equinoxLocalUpdateCoordinator = createEquinoxLocalUpdateCoordinator({
  installation: equinoxLocalInstallation,
  updater: equinoxLocalUpdater,
});

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

const initialRuntimePaths =
  await ensureWorkspaceRuntimeDirectories();
const runtimeObservability =
  createRuntimeObservability({
    rootDir: initialRuntimePaths.observabilityRoot,
  });
await runtimeObservability.initialize();
await runtimeObservability.record({
  component: "runtime",
  type: "runtime.start",
  severity: "info",
  status: "healthy",
  message: `Equinox Local ${SERVER_VERSION} runtime started.`,
  details: {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    pid: process.pid,
  },
});

let recoveryPolicyController = null;

function recordRuntimeEvent(event) {
  return runtimeObservability
    .record(event)
    .then((recorded) => {
      if (recoveryPolicyController) {
        void recoveryPolicyController.handleEvent(recorded).catch((error) => {
          console.error(
            `[Equinox Local] Automatic recovery event işlenemedi: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return recorded;
    })
    .catch((error) => {
      console.error(
        `[Equinox Local] Observability event yazılamadı: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
}

const terminalManager =
  createTerminalManager({
    onEvent: recordRuntimeEvent,
  });
const processManager =
  createProcessManager({
    onEvent: recordRuntimeEvent,
  });

let registeredToolCount = 0;
const capabilityRegistry = createCapabilityRegistry();

const RUNTIME_RESTART_GUARD_MS = 30_000;
let runtimeRestartPendingUntil = 0;

function runtimeRestartGuardError(toolName) {
  const remainingMs = runtimeRestartPendingUntil - Date.now();
  if (remainingMs <= 0) {
    runtimeRestartPendingUntil = 0;
    return null;
  }

  return new Error(
    `Equinox Local yeniden başlatma beklemede. ${toolName} çağrısı bu process üzerinde çalıştırılmadı; ` +
      `yaklaşık ${Math.ceil(remainingMs / 1000)} saniye sonra yeni runtime üzerinden tekrar deneyin.`,
  );
}


function extractTextContent(result) {
  if (!result || !Array.isArray(result.content)) {
    return "";
  }

  return result.content
    .filter(
      (item) =>
        item &&
        item.type === "text" &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

const MUTATION_LOCK_WAIT_MS =
  30 * 60 * 1000;

const mutationLockTails = new Map();

const TOOL_MUTATION_SCOPE_OVERRIDES =
  Object.freeze({
    delete_inbox_asset: Object.freeze([
      "inbox",
    ]),
    import_asset: Object.freeze([
      "project",
      "inbox",
    ]),
    export_asset: Object.freeze([
      "project",
      "inbox",
    ]),
  });

function getToolMutationScopes(
  name,
  config,
  options,
  projectAware,
) {
  if (
    Array.isArray(
      options.mutationScopes,
    )
  ) {
    return options.mutationScopes;
  }

  const override =
    TOOL_MUTATION_SCOPE_OVERRIDES[
      name
    ];

  if (override) {
    return override;
  }

  if (
    config.annotations
      ?.readOnlyHint !== false
  ) {
    return [];
  }

  return projectAware
    ? ["project"]
    : ["global"];
}

function getMutationLockKeys(
  scopes,
  context,
) {
  return [
    ...new Set(
      scopes.map((scope) => {
        if (scope === "project") {
          if (!context) {
            throw new Error(
              "Proje yazma kilidi için aktif proje bağlamı gerekli.",
            );
          }

          return `project:${context.id}`;
        }

        if (scope === "inbox") {
          return "asset-inbox";
        }

        if (scope === "global") {
          return "global";
        }

        if (scope === "browser") {
          return "browser";
        }

        throw new Error(
          `Bilinmeyen mutasyon kilidi kapsamı: ${scope}`,
        );
      }),
    ),
  ].sort();
}

async function waitForMutationTail(
  key,
  tail,
) {
  let timeoutHandle;

  try {
    await Promise.race([
      tail.catch(() => {}),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new Error(
                `Yazma kilidi bekleme süresi aşıldı: ${key}`,
              ),
            ),
          MUTATION_LOCK_WAIT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function withMutationLocks(
  keys,
  task,
) {
  if (keys.length === 0) {
    return task();
  }

  const acquired = [];

  try {
    for (const key of keys) {
      const previous =
        mutationLockTails.get(key) ??
        Promise.resolve();

      let release;

      const gate = new Promise(
        (resolve) => {
          release = resolve;
        },
      );

      const tail = previous
        .catch(() => {})
        .then(() => gate);

      mutationLockTails.set(
        key,
        tail,
      );

      try {
        await waitForMutationTail(
          key,
          previous,
        );
      } catch (error) {
        release();

        tail.finally(() => {
          if (
            mutationLockTails.get(
              key,
            ) === tail
          ) {
            mutationLockTails.delete(
              key,
            );
          }
        });

        throw error;
      }

      acquired.push({
        key,
        tail,
        release,
      });
    }

    return await task();
  } finally {
    for (
      let index =
        acquired.length - 1;
      index >= 0;
      index -= 1
    ) {
      acquired[index].release();
    }

    for (const record of acquired) {
      record.tail.finally(() => {
        if (
          mutationLockTails.get(
            record.key,
          ) === record.tail
        ) {
          mutationLockTails.delete(
            record.key,
          );
        }
      });
    }
  }
}

function registerTextTool(
  name,
  config,
  handler,
  options = {},
) {
  const projectAware =
    options.projectAware ?? true;
  const registerCapability =
    options.capability ?? true;
  const exposeToMcp =
    options.mcpExposed ?? false;
  const projectSchema =
    options.projectSchema ?? PROJECT_ID_SCHEMA;
  const resolveContext =
    options.resolveContext ?? resolveProjectContext;

  const inputSchema = projectAware
    ? {
        project: projectSchema,
        ...(config.inputSchema ?? {}),
      }
    : (config.inputSchema ?? {});

  const mutationScopes =
    getToolMutationScopes(
      name,
      config,
      options,
      projectAware,
    );

  const registeredConfig = {
    ...config,
    inputSchema,
    outputSchema:
      config.outputSchema ?? {
        text: z.string(),
      },
  };

  const wrappedHandler = async (...args) => {
      const restartGuardError = runtimeRestartGuardError(name);
      if (restartGuardError) {
        return errorResult(restartGuardError);
      }

      const executeHandler = async (
        forwardedArgs,
      ) => {
        const result =
          await handler(...forwardedArgs);

        if (
          !result ||
          result.isError ||
          result.structuredContent
        ) {
          return result;
        }

        return {
          ...result,
          structuredContent: {
            text: extractTextContent(result),
          },
        };
      };

      if (!projectAware) {
        try {
          const lockKeys =
            getMutationLockKeys(
              mutationScopes,
              undefined,
            );

          return await withMutationLocks(
            lockKeys,
            () =>
              executeHandler(args),
          );
        } catch (error) {
          return errorResult(error);
        }
      }

      const [rawInput = {}, ...rest] =
        args;

      const input =
        rawInput &&
        typeof rawInput === "object"
          ? rawInput
          : {};

      const {
        project = DEFAULT_PROJECT,
        ...handlerInput
      } = input;

      try {
        const context =
          await resolveContext(
            project,
          );

        const lockKeys =
          getMutationLockKeys(
            mutationScopes,
            context,
          );

        return projectContextStorage.run(
          context,
          () =>
            withMutationLocks(
              lockKeys,
              () =>
                executeHandler([
                  handlerInput,
                  ...rest,
                ]),
            ),
        );
      } catch (error) {
        return errorResult(error);
      }
    };

  const registration = exposeToMcp
    ? server.registerTool(
        name,
        registeredConfig,
        wrappedHandler,
      )
    : null;

  if (exposeToMcp) {
    registeredToolCount += 1;
  }

  if (registerCapability) {
    capabilityRegistry.register({
      name,
      config: registeredConfig,
      inputSchema,
      domain: options.capabilityDomain,
      invoke: (input) => wrappedHandler(input),
    });
  }

  return registration;
}

function registerRawTool(
  name,
  config,
  handler,
  options = {},
) {
  const registerCapability =
    options.capability ?? true;
  const exposeToMcp =
    options.mcpExposed ?? false;
  const wrappedHandler = async (...args) => {
    const restartGuardError = runtimeRestartGuardError(name);
    if (restartGuardError) {
      return errorResult(restartGuardError);
    }

    try {
      return await handler(...args);
    } catch (error) {
      return errorResult(error);
    }
  };
  const registration = exposeToMcp
    ? server.registerTool(
        name,
        config,
        wrappedHandler,
      )
    : null;

  if (exposeToMcp) {
    registeredToolCount += 1;
  }

  if (registerCapability) {
    capabilityRegistry.register({
      name,
      config,
      inputSchema:
        config.inputSchema ?? {},
      domain: options.capabilityDomain,
      invoke: (input) => wrappedHandler(input),
    });
  }

  return registration;
}

registerTextTool(
  "list_projects",
  {
    description:
      "Equinox Local için yapılandırılmış proje/kök kısayollarını ve etkin Agent Access dosya modunu listeler. Full modda home veya erişilebilir mutlak klasör yolu ayrıca doğrudan kullanılabilir.",
    inputSchema: {},
    annotations: {
      title: "Proje ve erişim köklerini listele",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const sections = [];

    for (const projectId of PROJECT_IDS) {
      const definition =
        PROJECT_DEFINITIONS[projectId];

      try {
        const context =
          await resolveProjectContext(
            projectId,
          );

        const gitResult =
          await execFile(
            "/usr/bin/git",
            [
              "rev-parse",
              "--show-toplevel",
            ],
            {
              cwd: context.rootRealPath,
              timeout: 15_000,
              maxBuffer: 1024 * 1024,
              env: {
                ...process.env,
                GIT_OPTIONAL_LOCKS: "0",
                GIT_TERMINAL_PROMPT: "0",
                LC_ALL: "C",
              },
            },
          );

        const gitRoot =
          await fs.realpath(
            gitResult.stdout.trim(),
          );

        if (gitRoot !== context.rootRealPath) {
          throw new Error(
            "İzinli yol bağımsız Git repo kökü değil.",
          );
        }

        const [branchResult, statusResult, originResult] =
          await Promise.all([
            execFile(
              "/usr/bin/git",
              [
                "symbolic-ref",
                "--quiet",
                "--short",
                "HEAD",
              ],
              {
                cwd: context.rootRealPath,
                timeout: 15_000,
                maxBuffer: 1024 * 1024,
                env: {
                  ...process.env,
                  GIT_OPTIONAL_LOCKS: "0",
                  GIT_TERMINAL_PROMPT: "0",
                  LC_ALL: "C",
                },
              },
            ).catch(() => ({
              stdout: "DETACHED",
            })),
            execFile(
              "/usr/bin/git",
              [
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
              ],
              {
                cwd: context.rootRealPath,
                timeout: 15_000,
                maxBuffer: 2 * 1024 * 1024,
                env: {
                  ...process.env,
                  GIT_OPTIONAL_LOCKS: "0",
                  GIT_TERMINAL_PROMPT: "0",
                  LC_ALL: "C",
                },
              },
            ),
            execFile(
              "/usr/bin/git",
              [
                "remote",
                "get-url",
                "origin",
              ],
              {
                cwd: context.rootRealPath,
                timeout: 15_000,
                maxBuffer: 1024 * 1024,
                env: {
                  ...process.env,
                  GIT_OPTIONAL_LOCKS: "0",
                  GIT_TERMINAL_PROMPT: "0",
                  LC_ALL: "C",
                },
              },
            ).catch(() => ({
              stdout: "",
            })),
          ]);

        const changeCount =
          statusResult.stdout
            .split("\n")
            .filter(Boolean)
            .length;

        const origin =
          String(
            originResult.stdout ?? "",
          )
            .replace(
              /https?:\/\/[^@\s/]+@/gi,
              "https://[REDACTED]@",
            )
            .trim();

        sections.push(
          [
            `${projectId} — ${definition.name}`,
            `Kök: ${context.rootRealPath}`,
            `Branch: ${String(branchResult.stdout ?? "").trim() || "DETACHED"}`,
            `Çalışma ağacı: ${changeCount === 0 ? "Temiz" : `${changeCount} değişiklik`}`,
            `Origin: ${origin || "Yok"}`,
          ].join("\n"),
        );
      } catch (error) {
        sections.push(
          [
            `${projectId} — ${definition.name}`,
            `Kök: ${definition.root}`,
            "Durum: Kullanılamıyor",
            `Neden: ${
              error instanceof Error
                ? error.message
                : String(error)
            }`,
          ].join("\n"),
        );
      }
    }

    for (const rootId of FILE_ROOT_IDS) {
      if (PROJECT_DEFINITIONS[rootId]) {
        continue;
      }

      const definition =
        FILE_ROOT_DEFINITIONS[rootId];

      try {
        const context =
          await resolveFileRootContext(rootId);
        sections.push(
          [
            `${rootId} — ${definition.name}`,
            `Kök: ${context.rootRealPath}`,
            "Tür: Salt-okunur dosya kökü",
            "İzinler: list_files, read_file, search_text, copy_between_projects kaynağı",
            "Git / terminal / process / workflow / deploy: Kapalı",
          ].join("\n"),
        );
      } catch (error) {
        sections.push(
          [
            `${rootId} — ${definition.name}`,
            `Kök: ${definition.root}`,
            "Durum: Kullanılamıyor",
            `Neden: ${
              error instanceof Error
                ? error.message
                : String(error)
            }`,
          ].join("\n"),
        );
      }
    }

    return textResult(
      [
        `Dosya erişim modu: ${FULL_FILE_ACCESS ? "FULL" : "SELECTED"}`,
        `Varsayılan proje: ${DEFAULT_PROJECT}`,
        FULL_FILE_ACCESS
          ? "Yapılandırılmış kimliklerin yanında project alanında home veya erişilebilir mutlak klasör yolu kullanılabilir. Git araçları seçilen kökün Git repo olmasını ayrıca doğrular."
          : "Git araçlarında project; dosya araçlarında project alanı yalnız yapılandırılmış kökü seçer.",
        ...sections,
      ].join("\n\n"),
    );
  },
  {
    projectAware: false,
  },
);

registerTextTool(
  "project_info",
  {
    description:
      "Seçilen izinli yerel projenin kökünü ve temel Git bilgisini gösterir.",
    inputSchema: {},
    annotations: {
      title: "Yerel proje bilgisi",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const branch = await runGit(["branch", "--show-current"]);

      return textResult(
        [
          `Proje: ${getActiveProjectName()} (${getActiveProjectId()})`,
          `Kök: ${getActiveProjectRoot()}`,
          `Git dalı: ${branch || "(detached HEAD)"}`,
          "Erişim modu: Kontrollü yazma",
        ].join("\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "list_files",
  {
    description:
      "Seçilen projedeki dosya ve klasörleri listeler. Gizli ve hassas alanlar gösterilmez.",
    inputSchema: {
      path: z.string().default(".").describe("Proje köküne göre göreli klasör yolu"),
      depth: z
        .number()
        .int()
        .min(0)
        .max(4)
        .default(2)
        .describe("Alt klasör derinliği"),
    },
    annotations: {
      title: "Proje dosyalarını listele",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ path: requestedPath, depth }) => {
    try {
      const directory = await safeResolve(requestedPath);
      const stats = await fs.stat(directory);

      if (!stats.isDirectory()) {
        throw new Error("Belirtilen yol bir klasör değil.");
      }

      const entries = [];
      await collectEntries(directory, depth, entries);

      const suffix =
        entries.length >= 250
          ? "\n\n[Liste 250 öğeyle sınırlandırıldı.]"
          : "";

      return textResult(
        entries.length > 0
          ? `${entries.join("\n")}${suffix}`
          : "Klasör boş.",
      );
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    projectSchema: FILE_ROOT_ID_SCHEMA,
    resolveContext: resolveFileRootContext,
  },
);

registerTextTool(
  "read_file",
  {
    description:
      "Seçilen projedeki bir metin dosyasının belirli satırlarını okur.",
    inputSchema: {
      path: z.string().min(1).describe("Proje köküne göre göreli dosya yolu"),
      start_line: z.number().int().min(1).default(1),
      end_line: z.number().int().min(1).default(250),
    },
    annotations: {
      title: "Proje dosyası oku",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ path: requestedPath, start_line, end_line }) => {
    try {
      if (end_line < start_line) {
        throw new Error("Bitiş satırı başlangıç satırından küçük olamaz.");
      }

      if (end_line - start_line > 500) {
        throw new Error("Tek çağrıda en fazla 500 satır okunabilir.");
      }

      const filePath = await safeResolve(requestedPath);
      const { data: buffer } = await readBoundedNormalFile(filePath, {
        maxBytes: MAX_FILE_BYTES,
        label: "Okunacak dosya",
      });

      if (buffer.includes(0)) {
        throw new Error("İkili dosyalar okunamaz.");
      }

      const lines = buffer.toString("utf8").split(/\r?\n/);
      const first = Math.max(1, start_line);
      const last = Math.min(lines.length, end_line);

      const selected = lines
        .slice(first - 1, last)
        .map((line, index) => `${first + index} | ${line}`)
        .join("\n");

      return textResult(
        `Dosya: ${displayPath(filePath)}\nSatırlar: ${first}-${last}/${lines.length}\n\n${selected}`,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    projectSchema: FILE_ROOT_ID_SCHEMA,
    resolveContext: resolveFileRootContext,
  },
);

registerTextTool(
  "search_text",
  {
    description:
      "Seçilen proje kaynaklarında büyük-küçük harf duyarsız, düz metin araması yapar.",
    inputSchema: {
      query: z.string().min(1).max(200).describe("Aranacak düz metin"),
      path: z.string().default(".").describe("Aramanın başlayacağı göreli klasör"),
      max_results: z.number().int().min(1).max(100).default(30),
    },
    annotations: {
      title: "Proje kodunda ara",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, path: requestedPath, max_results }) => {
    try {
      const directory = await safeResolve(requestedPath);
      const stats = await fs.stat(directory);

      if (!stats.isDirectory()) {
        throw new Error("Arama yolu bir klasör olmalı.");
      }

      const files = [];
      await collectSearchFiles(directory, files);

      const needle = query.toLowerCase();
      const matches = [];

      for (const filePath of files) {
        if (matches.length >= max_results) {
          break;
        }

        let buffer;
        try {
          ({ data: buffer } = await readBoundedNormalFile(filePath, {
            maxBytes: MAX_FILE_BYTES,
            label: "Arama dosyası",
          }));
        } catch (error) {
          if (
            error?.code === "ENOENT" ||
            error?.code === SAFE_FILE_ERROR_CODES.notNormal ||
            error?.code === SAFE_FILE_ERROR_CODES.tooLarge
          ) {
            continue;
          }
          throw error;
        }

        if (buffer.includes(0)) {
          continue;
        }

        const lines = buffer.toString("utf8").split(/\r?\n/);

        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].toLowerCase().includes(needle)) {
            matches.push(
              `${displayPath(filePath)}:${index + 1}: ${lines[index].trim()}`,
            );

            if (matches.length >= max_results) {
              break;
            }
          }
        }
      }

      return textResult(
        matches.length > 0
          ? matches.join("\n")
          : `"${query}" için eşleşme bulunamadı.`,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    projectSchema: FILE_ROOT_ID_SCHEMA,
    resolveContext: resolveFileRootContext,
  },
);

registerTextTool(
  "git_status",
  {
    description:
      "Seçilen projenin Git dalını ve değişiklik durumunu salt okunur biçimde gösterir.",
    inputSchema: {},
    annotations: {
      title: "Proje Git durumu",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const output = await runGit([
        "status",
        "--short",
        "--branch",
        "--untracked-files=normal",
      ]);

      return textResult(output || "Çalışma ağacı temiz.");
    } catch (error) {
      return errorResult(error);
    }
  },
);

async function resolveGitDiffPath(
  requestedPath,
) {
  if (
    requestedPath.trim() !==
    requestedPath
  ) {
    throw new Error(
      "Git diff yolunun başında veya sonunda boşluk olamaz.",
    );
  }

  checkRequestedPath(requestedPath);

  const root =
    getActiveProjectRoot();

  const candidate = path.resolve(
    root,
    requestedPath,
  );

  if (!isInsideProject(candidate)) {
    throw new Error(
      "Git diff yolu proje kökünün dışına çıkıyor.",
    );
  }

  try {
    await fs.lstat(candidate);

    const resolved =
      await safeResolve(
        requestedPath,
      );

    return displayPath(resolved);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  /*
   * Silinmiş dosya veya klasör diskte artık
   * bulunmayabilir. En yakın mevcut üst dizinin
   * gerçek yolunu doğrulayarak symlink kaçışını
   * engelleriz.
   */
  let ancestor =
    path.dirname(candidate);

  while (true) {
    if (!isInsideProject(ancestor)) {
      throw new Error(
        "Git diff yolunun mevcut üst dizini proje dışına çıkıyor.",
      );
    }

    try {
      const realAncestor =
        await fs.realpath(ancestor);

      if (
        !isInsideProject(
          realAncestor,
        )
      ) {
        throw new Error(
          "Git diff yolu sembolik bağlantı üzerinden proje dışına çıkıyor.",
        );
      }

      break;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }

      if (ancestor === root) {
        throw new Error(
          "Proje kökü doğrulanamadı.",
        );
      }

      ancestor =
        path.dirname(ancestor);
    }
  }

  const relativePath =
    path.relative(
      root,
      candidate,
    );

  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(
      `..${path.sep}`,
    )
  ) {
    throw new Error(
      "Geçersiz Git diff yolu.",
    );
  }

  const [indexResult, headResult] =
    await Promise.all([
      runGitWithCode([
        "ls-files",
        "--",
        relativePath,
      ]),
      runGitWithCode([
        "ls-tree",
        "-r",
        "--name-only",
        "HEAD",
        "--",
        relativePath,
      ]),
    ]);

  if (
    indexResult.code !== 0 ||
    headResult.code !== 0
  ) {
    throw new Error(
      "Silinmiş yolun Git geçmişi doğrulanamadı.",
    );
  }

  if (
    !indexResult.stdout.trim() &&
    !headResult.stdout.trim()
  ) {
    throw new Error(
      "Belirtilen yol mevcut değil ve Git tarafından izlenmiyor.",
    );
  }

  return relativePath;
}

registerTextTool(
  "git_diff",
  {
    description:
      "Seçilen projedeki commit edilmemiş Git farklarını gösterir.",
    inputSchema: {
      staged: z.boolean().default(false).describe("Staged farkları göster"),
      path: z
        .string()
        .optional()
        .describe("İsteğe bağlı göreli dosya veya klasör yolu"),
    },
    annotations: {
      title: "Proje Git farkı",
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ staged, path: requestedPath }) => {
    try {
      const args = ["diff", "--no-ext-diff", "--unified=3"];

      if (staged) {
        args.push("--cached");
      }

      if (requestedPath) {
        const relativePath =
          await resolveGitDiffPath(
            requestedPath,
          );

        args.push(
          "--",
          relativePath,
        );
      }

      const output = await runGit(args);

      return textResult(output || "Gösterilecek Git farkı yok.");
    } catch (error) {
      return errorResult(error);
    }
  },
);


registerTextTool(
  "run_build",
  {
    description:
      "Seçilen projede yalnızca npm run build komutunu çalıştırır ve build çıktısını döndürür.",
    inputSchema: {},
    annotations: {
      title: "Proje production build",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const startedAt = Date.now();
    const npmBinary = "/opt/homebrew/bin/npm";

    try {
      const { stdout, stderr } = await execFile(
        npmBinary,
        ["run", "build"],
        {
          cwd: getActiveProjectRoot(),
          timeout: 300_000,
          maxBuffer: 5 * 1024 * 1024,
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`,
            CI: "1",
            NO_COLOR: "1",
          },
        },
      );

      const durationSeconds = (
        (Date.now() - startedAt) /
        1000
      ).toFixed(1);

      const output = [stdout, stderr]
        .filter(Boolean)
        .join("\n")
        .trim();

      return textResult(
        [
          `Build başarılı (${durationSeconds} saniye).`,
          output || "Build herhangi bir çıktı üretmedi.",
        ].join("\n\n"),
      );
    } catch (error) {
      const durationSeconds = (
        (Date.now() - startedAt) /
        1000
      ).toFixed(1);

      const stdout =
        typeof error?.stdout === "string" ? error.stdout : "";
      const stderr =
        typeof error?.stderr === "string" ? error.stderr : "";
      const message =
        error instanceof Error ? error.message : String(error);

      const details = [stdout, stderr, message]
        .filter(Boolean)
        .join("\n")
        .trim();

      return {
        content: [
          {
            type: "text",
            text: [
              `Build başarısız (${durationSeconds} saniye).`,
              details || "Ayrıntılı hata çıktısı alınamadı.",
            ].join("\n\n"),
          },
        ],
        isError: true,
      };
    }
  },
);


registerTextTool(
  "replace_text",
  {
    description:
      "Seçilen projedeki mevcut bir UTF-8 metin dosyasında tam olarak bir kez geçen metni yenisiyle değiştirir. Dosya oluşturamaz veya silemez.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Proje köküne göre göreli dosya yolu"),
      old_text: z
        .string()
        .min(1)
        .max(100_000)
        .describe("Dosyada tam olarak bir kez bulunması gereken mevcut metin"),
      new_text: z
        .string()
        .max(100_000)
        .describe("Eski metnin yerine yazılacak yeni metin"),
    },
    annotations: {
      title: "Proje metnini değiştir",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ path: requestedPath, old_text, new_text }) => {
    let temporaryPath;

    try {
      if (old_text === new_text) {
        throw new Error("Eski ve yeni metin aynı olamaz.");
      }

      const filePath = await safeResolve(requestedPath);
      const { data: buffer, stat: stats } = await readBoundedNormalFile(filePath, {
        maxBytes: MAX_FILE_BYTES,
        label: "Düzenlenecek dosya",
      });

      if (buffer.includes(0)) {
        throw new Error("İkili dosyalarda metin değişikliği yapılamaz.");
      }

      let currentText;

      try {
        currentText = new TextDecoder("utf-8", {
          fatal: true,
        }).decode(buffer);
      } catch {
        throw new Error("Dosya geçerli UTF-8 metni değil.");
      }

      let matchCount = 0;
      let firstMatchIndex = -1;
      let searchIndex = 0;

      while (true) {
        const matchIndex = currentText.indexOf(
          old_text,
          searchIndex,
        );

        if (matchIndex === -1) {
          break;
        }

        if (firstMatchIndex === -1) {
          firstMatchIndex = matchIndex;
        }

        matchCount += 1;
        searchIndex = matchIndex + old_text.length;
      }

      if (matchCount === 0) {
        throw new Error(
          "Değiştirilecek eski metin dosyada bulunamadı. Dosya değişmiş olabilir.",
        );
      }

      if (matchCount > 1) {
        throw new Error(
          `Eski metin dosyada ${matchCount} kez bulundu. Güvenlik nedeniyle değişiklik uygulanmadı.`,
        );
      }

      const updatedText =
        currentText.slice(0, firstMatchIndex) +
        new_text +
        currentText.slice(firstMatchIndex + old_text.length);

      if (
        Buffer.byteLength(updatedText, "utf8") >
        MAX_FILE_BYTES
      ) {
        throw new Error(
          "Değişiklik sonrasında dosya 512 KB sınırını aşıyor.",
        );
      }

      temporaryPath =
        `${filePath}.equinox-${process.pid}-${Date.now()}.tmp`;

      await fs.writeFile(temporaryPath, updatedText, {
        encoding: "utf8",
        mode: stats.mode & 0o777,
      });

      await fs.rename(temporaryPath, filePath);
      temporaryPath = undefined;

      const relativePath = displayPath(filePath);

      const status = await runGit([
        "status",
        "--short",
        "--",
        relativePath,
      ]);

      const diff = await runGit([
        "diff",
        "--no-ext-diff",
        "--unified=3",
        "--",
        relativePath,
      ]);

      return textResult(
        [
          `Metin başarıyla değiştirildi: ${relativePath}`,
          status
            ? `Git durumu:\n${status}`
            : "Git durumu değişiklik göstermiyor.",
          diff
            ? `Git farkı:\n${diff}`
            : "Dosya Git tarafından izlenmiyor veya gösterilecek diff yok.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    } finally {
      if (temporaryPath) {
        await fs.rm(temporaryPath, {
          force: true,
        }).catch(() => {});
      }
    }
  },
);


registerTextTool(
  "apply_patch",
  {
    description:
      "Seçilen projedeki mevcut UTF-8 metin dosyalarına standart unified git diff uygular. Dirty dosyalar, her hedef için file_hash aracından alınmış güncel SHA-256 doğrulanırsa düzenlenebilir. Dosya oluşturma, silme, yeniden adlandırma, binary patch ve dosya modu değişikliği yasaktır.",
    inputSchema: {
      patch: z
        .string()
        .min(1)
        .max(150_000)
        .describe(
          "diff --git satırları içeren standart unified git diff",
        ),
      expected_sha256_by_path: z
        .record(
          z.string().min(1).max(300),
          z.string().regex(/^[a-fA-F0-9]{64}$/),
        )
        .describe(
          "Patch içindeki her hedef yol için file_hash aracından alınmış beklenen SHA-256 özeti",
        ),
    },
    annotations: {
      title: "Projeye patch uygula",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ patch, expected_sha256_by_path }) => {
    try {
      const patchText =
        patch.replace(/\r\n/g, "\n").trimEnd() + "\n";

      if (!patchText.startsWith("diff --git ")) {
        throw new Error(
          "Patch standart unified git diff biçiminde olmalı ve 'diff --git' ile başlamalı.",
        );
      }

      if (patchText.includes("*** Begin Patch")) {
        throw new Error(
          "Özel Apply Patch biçimi desteklenmiyor. Standart 'diff --git' unified diff kullan.",
        );
      }

      const forbiddenPatterns = [
        /^new file mode /m,
        /^deleted file mode /m,
        /^old mode /m,
        /^new mode /m,
        /^rename from /m,
        /^rename to /m,
        /^similarity index /m,
        /^dissimilarity index /m,
        /^copy from /m,
        /^copy to /m,
        /^GIT binary patch$/m,
        /^Binary files /m,
      ];

      for (const pattern of forbiddenPatterns) {
        if (pattern.test(patchText)) {
          throw new Error(
            "Patch dosya oluşturma, silme, yeniden adlandırma, izin değişikliği veya binary işlem içeriyor.",
          );
        }
      }

      if (patchText.includes("/dev/null")) {
        throw new Error(
          "Dosya oluşturma veya silme içeren patch kabul edilmiyor.",
        );
      }

      const lines = patchText.split("\n");
      const targetPaths = [];

      for (const line of lines) {
        if (!line.startsWith("diff --git ")) {
          continue;
        }

        const parts = line.split(" ");

        if (parts.length !== 4) {
          throw new Error(
            "İlk apply_patch sürümü boşluk içeren dosya yollarını desteklemiyor.",
          );
        }

        const left = parts[2];
        const right = parts[3];

        if (
          !left.startsWith("a/") ||
          !right.startsWith("b/")
        ) {
          throw new Error(
            "Patch yolları 'a/' ve 'b/' öneklerini kullanmalı.",
          );
        }

        const oldPath = left.slice(2);
        const newPath = right.slice(2);

        if (oldPath !== newPath) {
          throw new Error(
            "Dosya yeniden adlandırma desteklenmiyor.",
          );
        }

        if (
          !oldPath ||
          oldPath.startsWith("/") ||
          oldPath.includes("\\") ||
          oldPath.split("/").includes("..")
        ) {
          throw new Error(
            `Geçersiz veya güvensiz dosya yolu: ${oldPath}`,
          );
        }

        if (targetPaths.includes(oldPath)) {
          throw new Error(
            `Aynı dosya patch içinde birden fazla bölümde bulunuyor: ${oldPath}`,
          );
        }

        targetPaths.push(oldPath);
      }

      if (targetPaths.length === 0) {
        throw new Error(
          "Patch içinde düzenlenecek dosya bulunamadı.",
        );
      }

      if (targetPaths.length > 10) {
        throw new Error(
          "Tek çağrıda en fazla 10 dosya düzenlenebilir.",
        );
      }

      const expectedPaths =
        Object.keys(expected_sha256_by_path);
      const missingExpectedPaths =
        targetPaths.filter(
          (relativePath) =>
            !Object.hasOwn(
              expected_sha256_by_path,
              relativePath,
            ),
        );
      const extraExpectedPaths =
        expectedPaths.filter(
          (relativePath) =>
            !targetPaths.includes(relativePath),
        );

      if (
        missingExpectedPaths.length > 0 ||
        extraExpectedPaths.length > 0
      ) {
        throw new Error(
          [
            "expected_sha256_by_path anahtarları patch hedefleriyle birebir eşleşmeli.",
            missingExpectedPaths.length > 0
              ? `Eksik: ${missingExpectedPaths.join(", ")}`
              : null,
            extraExpectedPaths.length > 0
              ? `Fazla: ${extraExpectedPaths.join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      const targetSet = new Set(targetPaths);

      for (const line of lines) {
        if (
          !line.startsWith("--- ") &&
          !line.startsWith("+++ ")
        ) {
          continue;
        }

        const rawPath =
          line.slice(4).split("\t", 1)[0];

        if (
          !rawPath.startsWith("a/") &&
          !rawPath.startsWith("b/")
        ) {
          throw new Error(
            `Geçersiz patch dosya başlığı: ${rawPath}`,
          );
        }

        const relativePath = rawPath.slice(2);

        if (!targetSet.has(relativePath)) {
          throw new Error(
            `Patch başlığı beklenmeyen bir dosyaya işaret ediyor: ${relativePath}`,
          );
        }
      }

      const { createHash } =
        await import("node:crypto");

      for (const relativePath of targetPaths) {
        const filePath = await safeResolve(relativePath);
        const { data: buffer } = await readBoundedNormalFile(filePath, {
          maxBytes: MAX_FILE_BYTES,
          label: `Patch hedefi ${relativePath}`,
        });

        if (buffer.includes(0)) {
          throw new Error(
            `İkili dosya düzenlenemez: ${relativePath}`,
          );
        }

        try {
          new TextDecoder("utf-8", {
            fatal: true,
          }).decode(buffer);
        } catch {
          throw new Error(
            `Dosya geçerli UTF-8 metni değil: ${relativePath}`,
          );
        }

        const currentSha256 =
          createHash("sha256")
            .update(buffer)
            .digest("hex");
        const expectedSha256 =
          expected_sha256_by_path[
            relativePath
          ].toLowerCase();

        if (currentSha256 !== expectedSha256) {
          throw new Error(
            [
              `SHA-256 guard eşleşmedi: ${relativePath}`,
              `Beklenen: ${expectedSha256}`,
              `Güncel: ${currentSha256}`,
              "Dosya file_hash çağrısından sonra değişmiş olabilir; yeni hash alıp patch'i yeniden değerlendir.",
            ].join("\n"),
          );
        }
      }

      const { spawn } =
        await import("node:child_process");

      const runGitProcess = (
        args,
        input = "",
        timeoutMs = 30_000,
      ) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            "/usr/bin/git",
            args,
            {
              cwd: getActiveProjectRoot(),
              env: {
                ...process.env,
                PATH:
                  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
              },
              stdio: ["pipe", "pipe", "pipe"],
            },
          );

          let stdout = "";
          let stderr = "";
          let settled = false;
          let outputTooLarge = false;

          const finishReject = (error) => {
            if (settled) {
              return;
            }

            settled = true;
            clearTimeout(timer);
            reject(error);
          };

          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finishReject(
              new Error(
                "Git işlemi zaman aşımına uğradı.",
              ),
            );
          }, timeoutMs);

          const appendOutput = (
            current,
            chunk,
          ) => {
            const updated =
              current + chunk.toString("utf8");

            if (
              Buffer.byteLength(
                stdout + stderr + updated,
                "utf8",
              ) >
              2 * 1024 * 1024
            ) {
              outputTooLarge = true;
              child.kill("SIGKILL");
            }

            return updated;
          };

          child.stdout.on("data", (chunk) => {
            stdout = appendOutput(
              stdout,
              chunk,
            );
          });

          child.stderr.on("data", (chunk) => {
            stderr = appendOutput(
              stderr,
              chunk,
            );
          });

          child.on("error", finishReject);

          child.on("close", (code) => {
            if (settled) {
              return;
            }

            settled = true;
            clearTimeout(timer);

            if (outputTooLarge) {
              reject(
                new Error(
                  "Git çıktısı güvenlik sınırını aştı.",
                ),
              );
              return;
            }

            resolve({
              code: code ?? 1,
              stdout,
              stderr,
            });
          });

          child.stdin.on("error", () => {});
          child.stdin.end(input);
        });

      for (const relativePath of targetPaths) {
        const ignored = await runGitProcess([
          "check-ignore",
          "-q",
          "--",
          relativePath,
        ]);

        if (ignored.code === 0) {
          throw new Error(
            `Git tarafından yok sayılan dosya düzenlenemez: ${relativePath}`,
          );
        }

        if (ignored.code !== 1) {
          throw new Error(
            `Git ignore kontrolü başarısız: ${ignored.stderr.trim()}`,
          );
        }

      }

      const checkResult =
        await runGitProcess(
          [
            "apply",
            "--check",
            "--whitespace=nowarn",
            "--recount",
            "-",
          ],
          patchText,
        );

      if (checkResult.code !== 0) {
        throw new Error(
          [
            "Patch ön kontrolden geçemedi.",
            checkResult.stderr.trim() ||
              checkResult.stdout.trim() ||
              "Git ayrıntılı hata döndürmedi.",
          ].join("\n"),
        );
      }

      for (const relativePath of targetPaths) {
        const filePath =
          await safeResolve(relativePath);
        const currentBuffer =
          await fs.readFile(filePath);
        const currentSha256 =
          createHash("sha256")
            .update(currentBuffer)
            .digest("hex");
        const expectedSha256 =
          expected_sha256_by_path[
            relativePath
          ].toLowerCase();

        if (currentSha256 !== expectedSha256) {
          throw new Error(
            [
              `SHA-256 guard ikinci kontrolde eşleşmedi: ${relativePath}`,
              `Beklenen: ${expectedSha256}`,
              `Güncel: ${currentSha256}`,
              "Patch ön kontrolü sırasında dosya değişti; işlem uygulanmadı.",
            ].join("\n"),
          );
        }
      }

      const applyResult =
        await runGitProcess(
          [
            "apply",
            "--whitespace=nowarn",
            "--recount",
            "-",
          ],
          patchText,
        );

      if (applyResult.code !== 0) {
        throw new Error(
          [
            "Patch uygulanamadı.",
            applyResult.stderr.trim() ||
              applyResult.stdout.trim() ||
              "Git ayrıntılı hata döndürmedi.",
          ].join("\n"),
        );
      }

      const status = await runGit([
        "status",
        "--short",
        "--",
        ...targetPaths,
      ]);

      const diff = await runGit([
        "diff",
        "--no-ext-diff",
        "--unified=3",
        "--",
        ...targetPaths,
      ]);

      return textResult(
        [
          `Patch başarıyla uygulandı (${targetPaths.length} dosya).`,
          `Dosyalar:\n${targetPaths
            .map((path) => `- ${path}`)
            .join("\n")}`,
          status
            ? `Git durumu:\n${status}`
            : "Git durumu değişiklik göstermiyor.",
          diff
            ? `Git farkı:\n${diff}`
            : "Hedef dosya Git tarafından izlenmiyor; unified diff gösterilemiyor.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);


registerTextTool(
  "create_file",
  {
    description:
      "Seçilen çalışma kökü içinde yalnızca yeni bir UTF-8 metin dosyası oluşturur. Mevcut dosyanın üzerine yazamaz; .git ve hassas credential yolları kapalıdır, Git reposunda ignore kuralları da korunur.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .max(300)
        .describe(
          "Proje köküne göre göreli yeni dosya yolu",
        ),
      content: z
        .string()
        .max(500_000)
        .describe(
          "Yeni dosyaya yazılacak UTF-8 metin içeriği",
        ),
    },
    annotations: {
      title: "Proje dosyası oluştur",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ path: requestedPath, content }) => {
    let createdPath;

    try {
      const pathModule =
        await import("node:path");

      if (requestedPath.trim() !== requestedPath) {
        throw new Error(
          "Dosya yolunun başında veya sonunda boşluk olamaz.",
        );
      }

      if (
        pathModule.isAbsolute(requestedPath) ||
        requestedPath.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(requestedPath)
      ) {
        throw new Error(
          "Mutlak, ters eğik çizgili veya kontrol karakteri içeren yollar kabul edilmez.",
        );
      }

      const segments = requestedPath.split("/");

      if (
        segments.length === 0 ||
        segments.some(
          (segment) =>
            !segment ||
            segment === "." ||
            segment === "..",
        )
      ) {
        throw new Error(
          "Dosya yolu boş, yinelenen veya üst dizine çıkan bölümler içeremez.",
        );
      }

      checkRequestedPath(requestedPath);

      if (content.includes("\0")) {
        throw new Error(
          "Dosya içeriği NUL karakteri içeremez.",
        );
      }

      const contentBytes =
        Buffer.byteLength(content, "utf8");

      if (contentBytes > MAX_FILE_BYTES) {
        throw new Error(
          "Yeni dosya 512 KB yazma sınırını aşıyor.",
        );
      }

      const parentRelative =
        pathModule.posix.dirname(requestedPath);

      const parentPath =
        parentRelative === "."
          ? getActiveProjectRoot()
          : await safeResolve(parentRelative);

      const parentStats =
        await fs.stat(parentPath);

      if (!parentStats.isDirectory()) {
        throw new Error(
          "Hedef üst yol mevcut bir klasör değil.",
        );
      }

      const parentRealPath =
        await fs.realpath(parentPath);

      const targetPath =
        pathModule.join(
          parentRealPath,
          pathModule.posix.basename(
            requestedPath,
          ),
        );

      const relativeFromRoot =
        pathModule.relative(
          getActiveProjectRoot(),
          targetPath,
        );

      if (
        !relativeFromRoot ||
        relativeFromRoot === ".." ||
        relativeFromRoot.startsWith(
          `..${pathModule.sep}`,
        ) ||
        pathModule.isAbsolute(relativeFromRoot)
      ) {
        throw new Error(
          "Hedef dosya proje kökünün dışına çıkıyor.",
        );
      }
      if (FULL_FILE_ACCESS && !getActiveProjectContext().configured) {
        assertNotProtectedAgentPath(targetPath);
      }

      let targetExists = false;

      try {
        await fs.lstat(targetPath);
        targetExists = true;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      if (targetExists) {
        throw new Error(
          "Hedef dosya zaten mevcut. create_file mevcut dosyaların üzerine yazamaz.",
        );
      }

      await assertPathNotIgnored(requestedPath);

      /*
       * wx:
       * - Dosya yoksa oluşturur.
       * - Dosya veya symlink mevcutsa EEXIST ile durur.
       * Böylece kontrol ile yazma arasındaki yarışta da
       * mevcut dosyanın üzerine yazılamaz.
       */
      const fileHandle =
        await fs.open(targetPath, "wx", 0o644);

      createdPath = targetPath;

      try {
        await fileHandle.writeFile(content, {
          encoding: "utf8",
        });

        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }

      const relativePath =
        displayPath(targetPath);

      const isGitProject =
        getActiveProjectContext().kind === "git";
      const status = isGitProject
        ? await runGit([
            "status",
            "--short",
            "--",
            relativePath,
          ])
        : "";

      const result = textResult(
        [
          `Yeni dosya oluşturuldu: ${relativePath}`,
          `Boyut: ${contentBytes} bayt`,
          isGitProject
            ? status
              ? `Git durumu:\n${status}`
              : "Git durumu değişiklik göstermiyor."
            : "Git denetimi uygulanmadı; çalışma kökü normal bir klasör.",
          "Mevcut hiçbir dosyanın üzerine yazılmadı.",
        ].join("\n\n"),
      );

      /*
       * Buraya ulaştıysak işlem başarılıdır.
       * catch bloğunun dosyayı geri almasını engelle.
       */
      createdPath = undefined;

      return result;
    } catch (error) {
      /*
       * Dosya yazıldıktan sonra sonraki bir kontrol
       * başarısız olursa yarım işlemi geri al.
       */
      if (createdPath) {
        await fs.rm(createdPath, {
          force: true,
        }).catch(() => {});
      }

      return errorResult(error);
    }
  },
);

registerTextTool(
  "write_file",
  {
    description:
      "Seçilen çalışma kökü içinde UTF-8 metin dosyası oluşturur veya mevcut normal dosyayı SHA-256 önkoşuluyla atomik olarak değiştirir. Git reposu gerektirmez; hassas credential ve .git yolları kapalı kalır.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .max(300)
        .describe("Çalışma köküne göre göreli dosya yolu"),
      content: z
        .string()
        .max(500_000)
        .describe("Yazılacak UTF-8 metin içeriği"),
      expected_sha256: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/u)
        .optional()
        .describe("Mevcut dosya değiştirilecekse zorunlu güncel SHA-256"),
    },
    annotations: {
      title: "Dosya yaz veya güvenli biçimde değiştir",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ path: requestedPath, content, expected_sha256 }) => {
    try {
      checkRequestedPath(requestedPath);
      if (!requestedPath || requestedPath === ".") {
        throw new Error("Hedef bir dosya yolu olmalı.");
      }

      const parentRelative = path.dirname(requestedPath);
      const parentPath = parentRelative === "."
        ? getActiveProjectRoot()
        : await safeResolve(parentRelative);
      const parentRealPath = await fs.realpath(parentPath);
      const targetPath = path.join(parentRealPath, path.basename(requestedPath));
      if (!isInsideProject(targetPath)) {
        throw new Error("Hedef dosya çalışma kökünün dışına çıkıyor.");
      }
      if (FULL_FILE_ACCESS && !getActiveProjectContext().configured) {
        assertNotProtectedAgentPath(targetPath);
      }

      const result = await writeBoundedUtf8File(targetPath, {
        content,
        expectedSha256: expected_sha256,
        maxBytes: MAX_FILE_BYTES,
        maxExistingBytes: MAX_HASHABLE_FILE_BYTES,
        label: "Dosya",
      });
      return terminalJsonResult({
        ok: true,
        path: displayPath(targetPath),
        ...result,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);


const MAX_HASHABLE_FILE_BYTES =
  10 * 1024 * 1024;

async function inspectFileForDeletion(
  requestedPath,
) {
  const pathModule =
    await import("node:path");

  const { createHash } =
    await import("node:crypto");

  if (
    typeof requestedPath !== "string" ||
    requestedPath.trim() !== requestedPath
  ) {
    throw new Error(
      "Dosya yolunun başında veya sonunda boşluk olamaz.",
    );
  }

  if (
    pathModule.isAbsolute(requestedPath) ||
    requestedPath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(
      requestedPath,
    )
  ) {
    throw new Error(
      "Mutlak, ters eğik çizgili veya kontrol karakteri içeren yollar kabul edilmez.",
    );
  }

  const segments =
    requestedPath.split("/");

  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === "..",
    )
  ) {
    throw new Error(
      "Dosya yolu boş, yinelenen veya üst dizine çıkan bölümler içeremez.",
    );
  }

  const candidatePath =
    pathModule.resolve(
      getActiveProjectRoot(),
      requestedPath,
    );

  const relativeFromRoot =
    pathModule.relative(
      getActiveProjectRoot(),
      candidatePath,
    );

  if (
    !relativeFromRoot ||
    relativeFromRoot === ".." ||
    relativeFromRoot.startsWith(
      `..${pathModule.sep}`,
    ) ||
    pathModule.isAbsolute(
      relativeFromRoot,
    )
  ) {
    throw new Error(
      "Hedef dosya proje kökünün dışına çıkıyor.",
    );
  }

  /*
   * safeResolve hassas yolları ve proje
   * sınırını mevcut ortak güvenlik
   * kurallarımızla doğrular.
   */
  const filePath =
    await safeResolve(requestedPath);

  const rawStats =
    await fs.lstat(candidatePath);

  if (rawStats.isSymbolicLink()) {
    throw new Error(
      "Symlink dosyalar silinemez.",
    );
  }

  if (!rawStats.isFile()) {
    throw new Error(
      "Belirtilen yol mevcut bir normal dosya değil.",
    );
  }

  const relativePath =
    displayPath(filePath);

  if (getActiveProjectContext().kind === "git") {
    let ignored = false;

    try {
      await execFile(
        "/usr/bin/git",
        [
          "check-ignore",
          "-q",
          "--no-index",
          "--",
          relativePath,
        ],
        {
          cwd: getActiveProjectRoot(),
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
        },
      );

      ignored = true;
    } catch (error) {
      if (Number(error?.code) !== 1) {
        throw new Error(
          [
            "Git ignore kontrolü başarısız.",
            error instanceof Error
              ? error.message
              : String(error),
          ].join("\n"),
        );
      }
    }

    if (ignored) {
      throw new Error(
        "Git tarafından yok sayılan dosyalar bu araçlarla işlenemez.",
      );
    }
  }

  const { data: buffer, stat: stats } = await readBoundedNormalFile(filePath, {
    maxBytes: MAX_HASHABLE_FILE_BYTES,
    label: "Hashlenecek dosya",
  });

  if (
    rawStats.dev !== stats.dev ||
    rawStats.ino !== stats.ino
  ) {
    throw new Error(
      "Dosya yolu doğrulama sırasında değişti veya beklenmeyen bir yönlendirme içeriyor.",
    );
  }

  const sha256 =
    createHash("sha256")
      .update(buffer)
      .digest("hex");

  return {
    candidatePath,
    filePath,
    relativePath,
    stats,
    buffer,
    sha256,
  };
}

registerTextTool(
  "file_hash",
  {
    description:
      "Seçilen çalışma kökündeki mevcut bir dosyanın SHA-256 özetini ve boyutunu döndürür; Git reposunda ayrıca Git durumunu gösterir. Dosyada değişiklik yapmaz.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .max(300)
        .describe(
          "Proje köküne göre göreli mevcut dosya yolu",
        ),
    },
    annotations: {
      title: "Proje dosya özeti",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ path: requestedPath }) => {
    try {
      const inspected =
        await inspectFileForDeletion(
          requestedPath,
        );

      const isGitProject =
        getActiveProjectContext().kind === "git";
      let status = "";
      let gitState =
        "Uygulanmıyor; çalışma kökü normal bir klasör";

      if (isGitProject) {
        status = await runGit([
          "status",
          "--short",
          "--",
          inspected.relativePath,
        ]);
        gitState = "Git açısından temiz";

        if (
          status
            .split("\n")
            .filter(Boolean)
            .some(
              (line) =>
                line.startsWith("?? "),
            )
        ) {
          gitState =
            "Git tarafından izlenmiyor";
        } else if (status.trim()) {
          gitState =
            "Çalışma ağacında değişiklik var";
        }
      }

      return textResult(
        [
          `Dosya: ${inspected.relativePath}`,
          `SHA-256: ${inspected.sha256}`,
          `Boyut: ${inspected.stats.size} bayt`,
          `Git durumu: ${gitState}`,
          isGitProject
            ? status.trim()
              ? `Git çıktısı:\n${status}`
              : "Git çıktısı boş."
            : "Git denetimi uygulanmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "delete_file",
  {
    description:
      "Seçilen çalışma kökündeki tek bir mevcut dosyayı yalnızca verilen SHA-256 özeti güncel içerikle birebir eşleşirse siler. Klasör ve symlink silemez; Git reposunda ignore edilmiş veya değişiklik taşıyan takipli dosyalar ayrıca korunur.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .max(300)
        .describe(
          "Proje köküne göre göreli mevcut dosya yolu",
        ),
      expected_sha256: z
        .string()
        .regex(
          /^[a-fA-F0-9]{64}$/,
          "SHA-256 tam olarak 64 onaltılık karakter olmalı.",
        )
        .describe(
          "file_hash aracından alınan beklenen SHA-256 özeti",
        ),
    },
    annotations: {
      title: "Proje dosyasını sil",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({
    path: requestedPath,
    expected_sha256,
  }) => {
    let rollbackData;
    let deletionCompleted = false;

    try {
      const normalizedExpectedHash =
        expected_sha256.toLowerCase();
      const isGitProject =
        getActiveProjectContext().kind === "git";

      const initialInspection =
        await inspectFileForDeletion(
          requestedPath,
        );

      if (
        initialInspection.sha256 !==
        normalizedExpectedHash
      ) {
        throw new Error(
          [
            "SHA-256 uyuşmazlığı nedeniyle dosya silinmedi.",
            `Beklenen: ${normalizedExpectedHash}`,
            `Mevcut:  ${initialInspection.sha256}`,
            "Dosya, hash alındıktan sonra değişmiş olabilir.",
          ].join("\n"),
        );
      }

      let isUntracked = false;
      if (isGitProject) {
        const statusBefore = await runGit([
          "status",
          "--porcelain=v1",
          "--",
          initialInspection.relativePath,
        ]);
        const statusLines = statusBefore
          .split("\n")
          .map((line) => line.trimEnd())
          .filter(Boolean);
        isUntracked =
          statusLines.length === 1 &&
          statusLines[0].startsWith("?? ");

        /*
         * Temiz takipli dosya: status boş.
         * Untracked dosya: yalnızca ?? satırı.
         * Modifiye/staged/conflict dosya:
         * güvenlik nedeniyle reddedilir.
         */
        if (
          statusLines.length > 0 &&
          !isUntracked
        ) {
          throw new Error(
            [
              "Dosyada mevcut Git değişikliği bulundu; silme işlemi durduruldu.",
              "Önce değişikliği commit et, geri al veya ayrı değerlendir.",
              statusLines.join("\n"),
            ].join("\n"),
          );
        }
      }

      /*
       * Git kontrolünden sonra dosyayı tekrar
       * oku ve hash'i yeniden doğrula.
       */
      const currentInspection =
        await inspectFileForDeletion(
          requestedPath,
        );

      if (
        currentInspection.sha256 !==
        normalizedExpectedHash
      ) {
        throw new Error(
          [
            "Dosya işlem sırasında değişti; silme uygulanmadı.",
            `Beklenen: ${normalizedExpectedHash}`,
            `Mevcut:  ${currentInspection.sha256}`,
          ].join("\n"),
        );
      }

      const finalStats =
        await fs.lstat(
          currentInspection.candidatePath,
        );

      if (
        finalStats.isSymbolicLink() ||
        !finalStats.isFile() ||
        finalStats.dev !==
          currentInspection.stats.dev ||
        finalStats.ino !==
          currentInspection.stats.ino ||
        finalStats.size !==
          currentInspection.stats.size
      ) {
        throw new Error(
          "Dosya silme öncesinde değişti veya başka bir dosyayla yer değiştirdi.",
        );
      }

      rollbackData = {
        path:
          currentInspection.candidatePath,
        buffer:
          currentInspection.buffer,
        mode:
          currentInspection.stats.mode &
          0o777,
      };

      await fs.unlink(
        currentInspection.candidatePath,
      );

      deletionCompleted = true;

      if (!isGitProject) {
        deletionCompleted = false;
        rollbackData = undefined;
        return textResult(
          [
            `Dosya silindi: ${currentInspection.relativePath}`,
            `Doğrulanan SHA-256: ${normalizedExpectedHash}`,
            "Git denetimi uygulanmadı; çalışma kökü normal bir klasör.",
          ].join("\n\n"),
        );
      }

      const statusAfter =
        await runGit([
          "status",
          "--short",
          "--",
          currentInspection.relativePath,
        ]);

      const diffAfter =
        await runGit([
          "diff",
          "--no-ext-diff",
          "--unified=3",
          "--",
          currentInspection.relativePath,
        ]);

      /*
       * Git kontrolleri de tamamlandı.
       * Artık rollback gerekmiyor.
       */
      deletionCompleted = false;
      rollbackData = undefined;

      return textResult(
        [
          `Dosya silindi: ${currentInspection.relativePath}`,
          `Doğrulanan SHA-256: ${normalizedExpectedHash}`,
          isUntracked
            ? "Dosya Git tarafından izlenmiyordu."
            : "Dosya Git tarafından izleniyordu ve silinmeden önce temizdi.",
          statusAfter
            ? `Git durumu:\n${statusAfter}`
            : "Git durumu değişiklik göstermiyor.",
          diffAfter
            ? `Git farkı:\n${diffAfter}`
            : "Gösterilecek Git farkı yok.",
        ].join("\n\n"),
      );
    } catch (error) {
      /*
       * Silme başarılı olduktan sonra Git durum
       * kontrolü gibi sonraki bir adım hata verirse
       * dosyayı aynı içerik ve izinlerle geri getir.
       */
      if (
        deletionCompleted &&
        rollbackData
      ) {
        let restoreError;

        try {
          const handle =
            await fs.open(
              rollbackData.path,
              "wx",
              rollbackData.mode,
            );

          try {
            await handle.writeFile(
              rollbackData.buffer,
            );

            await handle.sync();
          } finally {
            await handle.close();
          }
        } catch (restoreFailure) {
          restoreError =
            restoreFailure instanceof Error
              ? restoreFailure.message
              : String(restoreFailure);
        }

        if (restoreError) {
          return errorResult(
            new Error(
              [
                error instanceof Error
                  ? error.message
                  : String(error),
                "UYARI: Silinen dosya otomatik olarak geri getirilemedi.",
                restoreError,
              ].join("\n"),
            ),
          );
        }
      }

      return errorResult(error);
    }
  },
);


async function runGitWithCode(
  args,
  timeoutMs = 30_000,
  cwd = getActiveProjectRoot(),
) {
  try {
    const { stdout = "", stderr = "" } =
      await execFile(
        "/usr/bin/git",
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            PATH:
              "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
          },
        },
      );

    return {
      code: 0,
      stdout:
        typeof stdout === "string"
          ? stdout
          : stdout.toString("utf8"),
      stderr:
        typeof stderr === "string"
          ? stderr
          : stderr.toString("utf8"),
    };
  } catch (error) {
    const stdout =
      typeof error?.stdout === "string"
        ? error.stdout
        : error?.stdout
          ? error.stdout.toString("utf8")
          : "";

    const stderr =
      typeof error?.stderr === "string"
        ? error.stderr
        : error?.stderr
          ? error.stderr.toString("utf8")
          : "";

    return {
      code:
        typeof error?.code === "number"
          ? error.code
          : 1,
      stdout,
      stderr:
        stderr ||
        (
          error instanceof Error
            ? error.message
            : String(error)
        ),
    };
  }
}

async function getCurrentGitBranch() {
  const result =
    await runGitWithCode([
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);

  const branch =
    result.stdout.trim();

  if (
    result.code !== 0 ||
    !branch
  ) {
    throw new Error(
      "Git HEAD bir branch'e bağlı değil. Detached HEAD durumunda işlem yapılamaz.",
    );
  }

  return branch;
}

async function assertNoGitOperationInProgress() {
  const pathModule =
    await import("node:path");

  const gitDirResult =
    await runGitWithCode([
      "rev-parse",
      "--git-dir",
    ]);

  if (gitDirResult.code !== 0) {
    throw new Error(
      `Git dizini alınamadı: ${gitDirResult.stderr.trim()}`,
    );
  }

  const gitDir =
    pathModule.resolve(
      getActiveProjectRoot(),
      gitDirResult.stdout.trim(),
    );

  const markers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_LOG",
    "rebase-merge",
    "rebase-apply",
  ];

  for (const markerName of markers) {
    try {
      await fs.lstat(
        pathModule.join(
          gitDir,
          markerName,
        ),
      );

      throw new Error(
        `Devam eden Git işlemi bulundu: ${markerName}. Önce bu işlemi tamamla veya iptal et.`,
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }
}

function parsePorcelainStatus(rawStatus) {
  const fields =
    rawStatus
      .split("\0")
      .filter(
        (entry) => entry.length > 0,
      );

  const changes = [];

  for (const entry of fields) {
    if (
      entry.length < 4 ||
      entry[2] !== " "
    ) {
      throw new Error(
        "Git status çıktısı beklenen porcelain biçiminde değil.",
      );
    }

    const status =
      entry.slice(0, 2);

    const relativePath =
      entry.slice(3);

    if (
      status.includes("R") ||
      status.includes("C")
    ) {
      throw new Error(
        "İlk commit_changes sürümü yeniden adlandırma veya kopyalama durumlarını desteklemiyor.",
      );
    }

    const conflictStates =
      new Set([
        "DD",
        "AU",
        "UD",
        "UA",
        "DU",
        "AA",
        "UU",
      ]);

    if (
      status.includes("U") ||
      conflictStates.has(status)
    ) {
      throw new Error(
        `Çakışmalı Git durumu bulundu: ${status} ${relativePath}`,
      );
    }

    changes.push({
      status,
      path: relativePath,
    });
  }

  return changes;
}

async function assertSafeCommitPath(
  relativePath,
) {
  const pathModule =
    await import("node:path");

  if (
    typeof relativePath !== "string" ||
    !relativePath ||
    relativePath.trim() !==
      relativePath ||
    pathModule.isAbsolute(
      relativePath,
    ) ||
    relativePath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(
      relativePath,
    )
  ) {
    throw new Error(
      `Geçersiz veya güvensiz Git yolu: ${JSON.stringify(relativePath)}`,
    );
  }

  const segments =
    relativePath.split("/");

  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === "..",
    )
  ) {
    throw new Error(
      `Üst dizine çıkan veya boş bölüm içeren yol: ${relativePath}`,
    );
  }

  const blockedDirectories =
    new Set([
      ".git",
      "node_modules",
      "dist",
      "build",
      ".astro",
      ".next",
      ".cache",
      "coverage",
    ]);

  for (const segment of segments) {
    if (
      blockedDirectories.has(
        segment.toLowerCase(),
      )
    ) {
      throw new Error(
        `Yasaklı klasör commit edilemez: ${relativePath}`,
      );
    }
  }

  const fileName =
    segments[
      segments.length - 1
    ].toLowerCase();

  const blockedNames =
    new Set([
      ".env",
      ".npmrc",
      ".netrc",
      "credentials.json",
      "secrets.json",
      "service-account.json",
      "id_rsa",
      "id_ed25519",
    ]);

  const blockedExtensions = [
    ".pem",
    ".key",
    ".p12",
    ".pfx",
  ];

  if (
    blockedNames.has(fileName) ||
    fileName.startsWith(".env.") ||
    blockedExtensions.some(
      (extension) =>
        fileName.endsWith(
          extension,
        ),
    )
  ) {
    throw new Error(
      `Hassas dosya commit edilemez: ${relativePath}`,
    );
  }

  const ignored =
    await runGitWithCode([
      "check-ignore",
      "-q",
      "--no-index",
      "--",
      relativePath,
    ]);

  if (ignored.code === 0) {
    throw new Error(
      `Git tarafından yok sayılan dosya commit edilemez: ${relativePath}`,
    );
  }

  if (ignored.code !== 1) {
    throw new Error(
      [
        `Git ignore kontrolü başarısız: ${relativePath}`,
        ignored.stderr.trim(),
      ].join("\n"),
    );
  }

  const candidatePath =
    pathModule.resolve(
      getActiveProjectRoot(),
      relativePath,
    );

  const relativeFromRoot =
    pathModule.relative(
      getActiveProjectRoot(),
      candidatePath,
    );

  if (
    !relativeFromRoot ||
    relativeFromRoot === ".." ||
    relativeFromRoot.startsWith(
      `..${pathModule.sep}`,
    ) ||
    pathModule.isAbsolute(
      relativeFromRoot,
    )
  ) {
    throw new Error(
      `Dosya proje kökünün dışına çıkıyor: ${relativePath}`,
    );
  }

  let stats;

  try {
    stats =
      await fs.lstat(
        candidatePath,
      );
  } catch (error) {
    /*
     * Dosya Git değişikliğiyle silindiyse
     * diskte bulunmaması normaldir.
     */
    if (error?.code === "ENOENT") {
      const parentRelative =
        pathModule.dirname(
          relativePath,
        );

      if (
        parentRelative !== "."
      ) {
        await safeResolve(
          parentRelative,
        );
      }

      return;
    }

    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(
      `Symlink commit edilemez: ${relativePath}`,
    );
  }

  if (!stats.isFile()) {
    throw new Error(
      `Normal dosya olmayan hedef commit edilemez: ${relativePath}`,
    );
  }

  const resolved =
    await safeResolve(
      relativePath,
    );

  const buffer =
    await fs.readFile(resolved);

  let isUtf8Text =
    !buffer.includes(0);

  if (isUtf8Text) {
    try {
      new TextDecoder(
        "utf-8",
        { fatal: true },
      ).decode(buffer);
    } catch {
      isUtf8Text = false;
    }
  }

  if (isUtf8Text) {
    const maxTextBytes =
      fileName === "package-lock.json" ||
      fileName === "npm-shrinkwrap.json"
        ? MAX_NPM_LOCKFILE_BYTES
        : MAX_FILE_BYTES;

    if (stats.size > maxTextBytes) {
      const limitLabel =
        maxTextBytes === MAX_NPM_LOCKFILE_BYTES
          ? "5 MB"
          : "512 KB";

      throw new Error(
        `Metin dosyası ${limitLabel} sınırını aşıyor: ${relativePath}`,
      );
    }

    return;
  }

  const extension =
    pathModule.extname(
      fileName,
    );

  if (
    !ALLOWED_BINARY_COMMIT_EXTENSIONS.has(
      extension,
    )
  ) {
    throw new Error(
      `Binary dosya türü commit allowlist'inde değil: ${relativePath}`,
    );
  }

  if (
    stats.size >
    MAX_COMMIT_BINARY_BYTES
  ) {
    throw new Error(
      `Binary web varlığı 10 MB sınırını aşıyor: ${relativePath}`,
    );
  }
}

registerTextTool(
  "create_branch",
  {
    description:
      "Seçilen projenin temiz main branch'i üzerinden equinox/ önekli yeni bir yerel çalışma branch'i oluşturur ve bu branch'e geçer. Mevcut branch'i sıfırlamaz ve push yapmaz.",
    inputSchema: {
      slug: z
        .string()
        .regex(
          /^[a-z0-9][a-z0-9._-]{0,59}$/,
          "Branch adı küçük harf, rakam, nokta, tire veya alt çizgi kullanmalı.",
        )
        .describe(
          "equinox/ önekinden sonraki branch adı; örnek: footer-fix",
        ),
    },
    annotations: {
      title: "Proje çalışma branch'i oluştur",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug }) => {
    try {
      await assertNoGitOperationInProgress();

      const currentBranch =
        await getCurrentGitBranch();

      if (currentBranch !== "main") {
        throw new Error(
          [
            "Yeni çalışma branch'i yalnızca main üzerinden oluşturulabilir.",
            `Mevcut branch: ${currentBranch}`,
          ].join("\n"),
        );
      }

      const status =
        await runGitWithCode([
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]);

      if (status.code !== 0) {
        throw new Error(
          `Git durumu alınamadı: ${status.stderr.trim()}`,
        );
      }

      if (status.stdout.trim()) {
        throw new Error(
          [
            "Çalışma ağacı temiz değil; branch oluşturulmadı.",
            status.stdout.trim(),
          ].join("\n"),
        );
      }

      const branchName =
        `equinox/${slug}`;

      const formatCheck =
        await runGitWithCode([
          "check-ref-format",
          "--branch",
          branchName,
        ]);

      if (formatCheck.code !== 0) {
        throw new Error(
          `Geçersiz Git branch adı: ${branchName}`,
        );
      }

      const localExists =
        await runGitWithCode([
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branchName}`,
        ]);

      if (localExists.code === 0) {
        throw new Error(
          `Yerel branch zaten mevcut: ${branchName}`,
        );
      }

      if (localExists.code !== 1) {
        throw new Error(
          "Yerel branch kontrolü başarısız oldu.",
        );
      }

      const remoteExists =
        await runGitWithCode([
          "show-ref",
          "--verify",
          "--quiet",
          `refs/remotes/origin/${branchName}`,
        ]);

      if (remoteExists.code === 0) {
        throw new Error(
          `Origin üzerinde aynı isimli branch zaten biliniyor: ${branchName}`,
        );
      }

      if (remoteExists.code !== 1) {
        throw new Error(
          "Uzak branch kontrolü başarısız oldu.",
        );
      }

      const baseCommit =
        await runGitWithCode([
          "rev-parse",
          "HEAD",
        ]);

      if (baseCommit.code !== 0) {
        throw new Error(
          `Başlangıç commit'i alınamadı: ${baseCommit.stderr.trim()}`,
        );
      }

      const checkout =
        await runGitWithCode([
          "checkout",
          "--no-guess",
          "--no-track",
          "-b",
          branchName,
        ]);

      if (checkout.code !== 0) {
        throw new Error(
          [
            "Branch oluşturulamadı.",
            checkout.stderr.trim() ||
              checkout.stdout.trim(),
          ].join("\n"),
        );
      }

      const activeBranch =
        await getCurrentGitBranch();

      if (
        activeBranch !==
        branchName
      ) {
        throw new Error(
          "Branch oluşturuldu ancak aktif branch doğrulanamadı.",
        );
      }

      return textResult(
        [
          `Yeni çalışma branch'i oluşturuldu: ${branchName}`,
          `Başlangıç branch'i: ${currentBranch}`,
          `Başlangıç commit'i: ${baseCommit.stdout.trim()}`,
          "Branch yalnızca yerelde oluşturuldu; push yapılmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "commit_changes",
  {
    description:
      "Yalnızca equinox/ çalışma branch'inde bulunan güvenli yerel metin ve izinli web varlığı değişikliklerini stage eder ve tek bir Git commit'i oluşturur. Main'e commit veya push yapamaz.",
    inputSchema: {
      title: z
        .string()
        .min(5)
        .max(72)
        .describe(
          "Tek satırlık Git commit başlığı",
        ),
      body: z
        .string()
        .max(2000)
        .optional()
        .describe(
          "İsteğe bağlı commit açıklaması",
        ),
    },
    annotations: {
      title: "Proje değişikliklerini commit et",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ title, body }) => {
    let stagedByTool = false;
    let commitCompleted = false;

    try {
      if (
        title.trim() !== title ||
        title.includes("\n") ||
        title.includes("\r") ||
        title.includes("\0")
      ) {
        throw new Error(
          "Commit başlığı tek satır olmalı ve başında/sonunda boşluk bulunmamalı.",
        );
      }

      if (
        body?.includes("\0")
      ) {
        throw new Error(
          "Commit açıklaması NUL karakteri içeremez.",
        );
      }

      await assertNoGitOperationInProgress();

      const branch =
        await getCurrentGitBranch();

      if (
        !branch.startsWith(
          "equinox/",
        )
      ) {
        throw new Error(
          [
            "Commit yalnızca equinox/ çalışma branch'lerinde oluşturulabilir.",
            `Mevcut branch: ${branch}`,
          ].join("\n"),
        );
      }

      const stagedBefore =
        await runGitWithCode([
          "diff",
          "--cached",
          "--quiet",
          "--exit-code",
        ]);

      if (stagedBefore.code === 1) {
        throw new Error(
          "İşlem öncesinde staged değişiklikler bulundu. Güvenlik nedeniyle commit oluşturulmadı.",
        );
      }

      if (stagedBefore.code !== 0) {
        throw new Error(
          `Staged değişiklik kontrolü başarısız: ${stagedBefore.stderr.trim()}`,
        );
      }

      const statusBefore =
        await runGitWithCode([
          "status",
          "--porcelain=v1",
          "--no-renames",
          "-z",
          "--untracked-files=all",
        ]);

      if (statusBefore.code !== 0) {
        throw new Error(
          `Git durumu alınamadı: ${statusBefore.stderr.trim()}`,
        );
      }

      const changesBefore =
        parsePorcelainStatus(
          statusBefore.stdout,
        );

      if (
        changesBefore.length === 0
      ) {
        throw new Error(
          "Commit edilecek değişiklik bulunamadı.",
        );
      }

      if (
        changesBefore.length > 50
      ) {
        throw new Error(
          "Tek commit çağrısında en fazla 50 değişmiş dosya işlenebilir.",
        );
      }

      const initialPaths =
        [
          ...new Set(
            changesBefore.map(
              (change) =>
                change.path,
            ),
          ),
        ].sort();

      for (
        const relativePath
        of initialPaths
      ) {
        await assertSafeCommitPath(
          relativePath,
        );
      }

      const addResult =
        await runGitWithCode([
          "add",
          "-A",
          "--",
          ".",
        ]);

      if (addResult.code !== 0) {
        throw new Error(
          [
            "Değişiklikler stage edilemedi.",
            addResult.stderr.trim() ||
              addResult.stdout.trim(),
          ].join("\n"),
        );
      }

      stagedByTool = true;

      const statusAfterStage =
        await runGitWithCode([
          "status",
          "--porcelain=v1",
          "--no-renames",
          "-z",
          "--untracked-files=all",
        ]);

      if (
        statusAfterStage.code !== 0
      ) {
        throw new Error(
          `Stage sonrası Git durumu alınamadı: ${statusAfterStage.stderr.trim()}`,
        );
      }

      const changesAfterStage =
        parsePorcelainStatus(
          statusAfterStage.stdout,
        );

      for (
        const change
        of changesAfterStage
      ) {
        if (
          change.status === "??" ||
          change.status[0] === " " ||
          change.status[1] !== " "
        ) {
          throw new Error(
            [
              "Stage sırasında çalışma ağacı değişti veya tam stage edilemeyen dosya bulundu.",
              `${change.status} ${change.path}`,
            ].join("\n"),
          );
        }
      }

      const stagedPaths =
        [
          ...new Set(
            changesAfterStage.map(
              (change) =>
                change.path,
            ),
          ),
        ].sort();

      if (
        JSON.stringify(
          stagedPaths,
        ) !==
        JSON.stringify(
          initialPaths,
        )
      ) {
        throw new Error(
          [
            "Stage edilen dosya listesi başlangıçtaki değişikliklerle eşleşmiyor.",
            `Başlangıç: ${initialPaths.join(", ")}`,
            `Stage: ${stagedPaths.join(", ")}`,
          ].join("\n"),
        );
      }

      for (
        const relativePath
        of stagedPaths
      ) {
        await assertSafeCommitPath(
          relativePath,
        );
      }

      const stagedCheck =
        await runGitWithCode([
          "diff",
          "--cached",
          "--quiet",
          "--exit-code",
        ]);

      if (
        stagedCheck.code !== 1
      ) {
        throw new Error(
          stagedCheck.code === 0
            ? "Stage sonrasında commit edilecek fark bulunamadı."
            : `Staged diff kontrolü başarısız: ${stagedCheck.stderr.trim()}`,
        );
      }

      const nameStatus =
        await runGitWithCode([
          "diff",
          "--cached",
          "--name-status",
          "--no-renames",
        ]);

      if (nameStatus.code !== 0) {
        throw new Error(
          `Commit dosya özeti alınamadı: ${nameStatus.stderr.trim()}`,
        );
      }

      const diffStat =
        await runGitWithCode([
          "diff",
          "--cached",
          "--stat",
          "--no-renames",
        ]);

      if (diffStat.code !== 0) {
        throw new Error(
          `Commit diff özeti alınamadı: ${diffStat.stderr.trim()}`,
        );
      }

      const commitArgs = [
        "commit",
        "-m",
        title,
      ];

      if (
        body &&
        body.trim()
      ) {
        commitArgs.push(
          "-m",
          body.trim(),
        );
      }

      /*
       * --no-verify kullanılmıyor.
       * Varsa pre-commit ve commit-msg
       * hook'ları normal şekilde çalışır.
       */
      const commitResult =
        await runGitWithCode(
          commitArgs,
          120_000,
        );

      if (
        commitResult.code !== 0
      ) {
        throw new Error(
          [
            "Git commit oluşturulamadı.",
            commitResult.stderr.trim() ||
              commitResult.stdout.trim(),
          ].join("\n"),
        );
      }

      commitCompleted = true;
      stagedByTool = false;

      const commitHash =
        await runGitWithCode([
          "rev-parse",
          "HEAD",
        ]);

      if (commitHash.code !== 0) {
        throw new Error(
          `Yeni commit hash'i alınamadı: ${commitHash.stderr.trim()}`,
        );
      }

      const finalStatus =
        await runGitWithCode([
          "status",
          "--short",
          "--branch",
        ]);

      return textResult(
        [
          `Commit oluşturuldu: ${commitHash.stdout.trim()}`,
          `Branch: ${branch}`,
          `Başlık: ${title}`,
          `Dosyalar:\n${nameStatus.stdout.trim()}`,
          `Özet:\n${diffStat.stdout.trim()}`,
          finalStatus.stdout.trim()
            ? `Son Git durumu:\n${finalStatus.stdout.trim()}`
            : "Çalışma ağacı temiz.",
          "Commit yalnızca yerelde oluşturuldu; push yapılmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      /*
       * Araç stage yaptı fakat commit tamamlanmadıysa
       * yalnızca index'i HEAD durumuna döndürür.
       * Çalışma dosyalarındaki değişiklikleri silmez.
       */
      if (
        stagedByTool &&
        !commitCompleted
      ) {
        const resetResult =
          await runGitWithCode([
            "reset",
            "--mixed",
            "HEAD",
          ]);

        if (
          resetResult.code !== 0
        ) {
          return errorResult(
            new Error(
              [
                error instanceof Error
                  ? error.message
                  : String(error),
                "UYARI: Araç tarafından stage edilen değişiklikler otomatik olarak unstage edilemedi.",
                resetResult.stderr.trim(),
              ].join("\n"),
            ),
          );
        }
      }

      return errorResult(error);
    }
  },
);


function sanitizeGitNetworkOutput(value) {
  return String(value ?? "")
    .replace(
      /https?:\/\/[^@\s/]+@/gi,
      "https://[REDACTED]@",
    )
    .replace(
      /\b(?:ghp_|github_pat_|glpat-)[A-Za-z0-9_=-]+\b/g,
      "[REDACTED_TOKEN]",
    )
    .trim();
}

async function getExactHeadCommit() {
  const result =
    await runGitWithCode([
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);

  const commit =
    result.stdout.trim().toLowerCase();

  if (
    result.code !== 0 ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(
      commit,
    )
  ) {
    throw new Error(
      [
        "Geçerli HEAD commit özeti alınamadı.",
        sanitizeGitNetworkOutput(
          result.stderr,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return commit;
}

async function assertCleanGitWorktree() {
  const result =
    await runGitWithCode([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);

  if (result.code !== 0) {
    throw new Error(
      [
        "Git çalışma ağacı durumu alınamadı.",
        sanitizeGitNetworkOutput(
          result.stderr,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (result.stdout.length > 0) {
    throw new Error(
      [
        "Çalışma ağacı temiz değil; push yapılmadı.",
        result.stdout.trim(),
      ].join("\n"),
    );
  }
}

function assertPushableEquinoxBranch(
  branch,
) {
  if (
    !/^equinox\/[a-z0-9][a-z0-9._-]{0,59}$/.test(
      branch,
    )
  ) {
    throw new Error(
      [
        "Yalnızca güvenli equinox/ çalışma branch'leri push edilebilir.",
        `Mevcut branch: ${branch}`,
      ].join("\n"),
    );
  }

  if (
    branch === "equinox/main" ||
    branch === "equinox/master"
  ) {
    throw new Error(
      "Korunan branch adına benzeyen çalışma branch'i push edilemez.",
    );
  }
}

registerTextTool(
  "git_head",
  {
    description:
      "Seçilen depodaki aktif branch'i, tam HEAD commit SHA değerini, çalışma ağacı durumunu ve varsa upstream bilgisini döndürür. Push öncesinde beklenen SHA değerini almak için kullanılır.",
    annotations: {
      title: "Proje Git HEAD bilgisi",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      await assertNoGitOperationInProgress();

      const branch =
        await getCurrentGitBranch();

      const head =
        await getExactHeadCommit();

      const status =
        await runGitWithCode([
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]);

      if (status.code !== 0) {
        throw new Error(
          `Git durumu alınamadı: ${sanitizeGitNetworkOutput(status.stderr)}`,
        );
      }

      const clean =
        status.stdout.length === 0;

      const upstreamResult =
        await runGitWithCode([
          "for-each-ref",
          "--format=%(upstream:short)",
          `refs/heads/${branch}`,
        ]);

      if (upstreamResult.code !== 0) {
        throw new Error(
          `Upstream bilgisi alınamadı: ${sanitizeGitNetworkOutput(upstreamResult.stderr)}`,
        );
      }

      const upstream =
        upstreamResult.stdout.trim();

      let divergence =
        "Upstream bulunmuyor";

      if (upstream) {
        const divergenceResult =
          await runGitWithCode([
            "rev-list",
            "--left-right",
            "--count",
            `${upstream}...HEAD`,
          ]);

        if (divergenceResult.code === 0) {
          const [
            behindRaw = "0",
            aheadRaw = "0",
          ] =
            divergenceResult.stdout
              .trim()
              .split(/\s+/);

          divergence =
            `Ahead: ${aheadRaw}, behind: ${behindRaw}`;
        } else {
          divergence =
            "Upstream var ancak ayrışma hesaplanamadı";
        }
      }

      return textResult(
        [
          `Branch: ${branch}`,
          `HEAD SHA: ${head}`,
          `Kısa SHA: ${head.slice(0, 12)}`,
          `Çalışma ağacı: ${clean ? "Temiz" : "Değişiklik var"}`,
          `Upstream: ${upstream || "Yok"}`,
          `Takip durumu: ${divergence}`,
          clean
            ? "Bu SHA, push_branch için kullanılabilir."
            : `Değişiklikler:\n${status.stdout.trim()}`,
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "push_branch",
  {
    description:
      "Aktif equinox/ çalışma branch'inin yalnızca doğrulanan HEAD commit'ini origin üzerindeki aynı isimli branch'e normal fast-forward kurallarıyla gönderir. Force-push, branch silme, tag push veya main push yapamaz.",
    inputSchema: {
      expected_head_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          "Beklenen HEAD SHA 40 veya 64 onaltılık karakter olmalı.",
        )
        .describe(
          "git_head aracından alınan tam HEAD SHA değeri",
        ),
    },
    annotations: {
      title: "Proje çalışma branch'ini push et",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({
    expected_head_sha,
  }) => {
    let pushCompleted = false;

    try {
      const expectedHead =
        expected_head_sha.toLowerCase();

      await assertNoGitOperationInProgress();
      await assertCleanGitWorktree();

      const branch =
        await getCurrentGitBranch();

      assertPushableEquinoxBranch(
        branch,
      );

      const formatCheck =
        await runGitWithCode([
          "check-ref-format",
          "--branch",
          branch,
        ]);

      if (formatCheck.code !== 0) {
        throw new Error(
          `Geçersiz Git branch adı: ${branch}`,
        );
      }

      const currentHead =
        await getExactHeadCommit();

      if (currentHead !== expectedHead) {
        throw new Error(
          [
            "HEAD SHA uyuşmazlığı nedeniyle push yapılmadı.",
            `Beklenen: ${expectedHead}`,
            `Mevcut:  ${currentHead}`,
            "Branch, git_head çağrısından sonra değişmiş olabilir.",
          ].join("\n"),
        );
      }

      const localRef =
        await runGitWithCode([
          "show-ref",
          "--verify",
          "--hash",
          `refs/heads/${branch}`,
        ]);

      if (
        localRef.code !== 0 ||
        localRef.stdout
          .trim()
          .toLowerCase() !==
          expectedHead
      ) {
        throw new Error(
          "Aktif branch ref'i beklenen HEAD SHA ile uyuşmuyor.",
        );
      }

      const origin =
        await runGitWithCode([
          "remote",
          "get-url",
          "origin",
        ]);

      if (
        origin.code !== 0 ||
        !origin.stdout.trim()
      ) {
        throw new Error(
          "Origin adlı Git remote bulunamadı.",
        );
      }

      const mirrorSetting =
        await runGitWithCode([
          "config",
          "--bool",
          "--get",
          "remote.origin.mirror",
        ]);

      if (
        mirrorSetting.code === 0 &&
        mirrorSetting.stdout
          .trim()
          .toLowerCase() === "true"
      ) {
        throw new Error(
          "Origin mirror olarak yapılandırılmış; güvenli push aracı çalıştırılmadı.",
        );
      }

      if (
        mirrorSetting.code !== 0 &&
        mirrorSetting.code !== 1
      ) {
        throw new Error(
          `Origin mirror ayarı kontrol edilemedi: ${sanitizeGitNetworkOutput(mirrorSetting.stderr)}`,
        );
      }

      const remoteRef =
        `refs/heads/${branch}`;

      const remoteBefore =
        await runGitWithCode(
          [
            "ls-remote",
            "--quiet",
            "--exit-code",
            "--branches",
            "origin",
            remoteRef,
          ],
          60_000,
        );

      let remoteState =
        "Yeni uzak branch oluşturulacak";

      let remoteBeforeSha = "";

      if (remoteBefore.code === 0) {
        const fields =
          remoteBefore.stdout
            .trim()
            .split(/\s+/);

        remoteBeforeSha =
          (fields[0] ?? "")
            .toLowerCase();

        if (
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(
            remoteBeforeSha,
          )
        ) {
          throw new Error(
            "Origin branch SHA değeri beklenen biçimde değil.",
          );
        }

        remoteState =
          `Mevcut uzak branch güncellenecek: ${remoteBeforeSha}`;
      } else if (
        remoteBefore.code !== 2
      ) {
        throw new Error(
          [
            "Origin branch durumu alınamadı.",
            sanitizeGitNetworkOutput(
              remoteBefore.stderr ||
              remoteBefore.stdout,
            ),
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      /*
       * Ağ ön kontrolünden sonra hem çalışma
       * ağacını hem HEAD SHA değerini yeniden
       * doğrula.
       */
      await assertCleanGitWorktree();

      const finalHead =
        await getExactHeadCommit();

      if (finalHead !== expectedHead) {
        throw new Error(
          [
            "HEAD push öncesinde değişti; işlem durduruldu.",
            `Beklenen: ${expectedHead}`,
            `Mevcut:  ${finalHead}`,
          ].join("\n"),
        );
      }

      /*
       * Kaynak olarak branch adı yerine doğrudan
       * doğrulanan commit SHA kullanılır.
       *
       * - Baştaki '+' yok: force refspec değil.
       * - --force / --force-with-lease yok.
       * - Hedef yalnızca aynı isimli refs/heads branch'i.
       * - Boş kaynak yok: remote branch silinemez.
       * - --no-verify yok: pre-push hook çalışır.
       */
      const pushResult =
        await runGitWithCode(
          [
            "push",
            "--porcelain",
            "origin",
            `${expectedHead}:${remoteRef}`,
          ],
          180_000,
        );

      if (pushResult.code !== 0) {
        throw new Error(
          [
            "Branch origin'a gönderilemedi.",
            sanitizeGitNetworkOutput(
              pushResult.stderr ||
              pushResult.stdout,
            ) ||
              "Git ayrıntılı hata döndürmedi.",
          ].join("\n"),
        );
      }

      pushCompleted = true;

      const remoteAfter =
        await runGitWithCode(
          [
            "ls-remote",
            "--quiet",
            "--exit-code",
            "--branches",
            "origin",
            remoteRef,
          ],
          60_000,
        );

      if (remoteAfter.code !== 0) {
        throw new Error(
          "Push tamamlandı ancak uzak branch sonradan doğrulanamadı.",
        );
      }

      const remoteAfterSha =
        (
          remoteAfter.stdout
            .trim()
            .split(/\s+/)[0] ?? ""
        ).toLowerCase();

      if (
        remoteAfterSha !==
        expectedHead
      ) {
        throw new Error(
          [
            "Push tamamlandı ancak uzak branch beklenen SHA değerinde değil.",
            `Beklenen: ${expectedHead}`,
            `Uzak:    ${remoteAfterSha || "alınamadı"}`,
          ].join("\n"),
        );
      }

      /*
       * Remote-tracking ref'i güncellemeyi dene.
       * Bu yalnızca yerel origin/<branch>
       * bilgisini senkronlar.
       */
      const fetchResult =
        await runGitWithCode(
          [
            "fetch",
            "--no-tags",
            "origin",
            `${remoteRef}:refs/remotes/origin/${branch}`,
          ],
          120_000,
        );

      let trackingMessage =
        "Upstream otomatik ayarlanmadı.";

      if (fetchResult.code === 0) {
        const upstreamResult =
          await runGitWithCode([
            "branch",
            "--set-upstream-to",
            `origin/${branch}`,
            branch,
          ]);

        trackingMessage =
          upstreamResult.code === 0
            ? `Upstream ayarlandı: origin/${branch}`
            : "Push başarılı; upstream ayarı ayrıca yapılamadı.";
      } else {
        trackingMessage =
          "Push başarılı; origin remote-tracking ref'i ayrıca yenilenemedi.";
      }

      const finalStatus =
        await runGitWithCode([
          "status",
          "--short",
          "--branch",
        ]);

      return textResult(
        [
          `Branch başarıyla push edildi: ${branch}`,
          `Gönderilen SHA: ${expectedHead}`,
          remoteState,
          `Doğrulanan uzak SHA: ${remoteAfterSha}`,
          trackingMessage,
          finalStatus.stdout.trim()
            ? `Son Git durumu:\n${finalStatus.stdout.trim()}`
            : "Çalışma ağacı temiz.",
          "Force-push, tag push veya main güncellemesi yapılmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      if (pushCompleted) {
        return textResult(
          [
            "Push işlemi uzak depoda tamamlandı.",
            "Ancak son doğrulama veya yerel upstream ayarının bir bölümü tamamlanamadı.",
            sanitizeGitNetworkOutput(
              message,
            ),
            "Uzak branch durumunu GitHub veya git ls-remote ile ayrıca kontrol et.",
          ].join("\n\n"),
        );
      }

      return errorResult(
        new Error(
          sanitizeGitNetworkOutput(
            message,
          ),
        ),
      );
    }
  },
);


async function resolveGhBinary() {
  const candidates = [
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Sıradaki bilinen yolu dene.
    }
  }

  throw new Error(
    "GitHub CLI bulunamadı. Önce Homebrew ile 'brew install gh' çalıştır.",
  );
}

async function runGhWithCode(
  args,
  input = "",
  timeoutMs = 120_000,
) {
  const ghBinary =
    await resolveGhBinary();

  const { spawn } =
    await import("node:child_process");

  return new Promise((resolve, reject) => {
    const child = spawn(
      ghBinary,
      args,
      {
        cwd: getActiveProjectRoot(),
        env: {
          ...process.env,
          PATH:
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          NO_COLOR: "1",
          CLICOLOR: "0",
        },
        stdio: [
          "pipe",
          "pipe",
          "pipe",
        ],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    let outputTooLarge = false;
    let timer;

    const finishWithError = (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const appendOutput = (
      current,
      chunk,
    ) => {
      const updated =
        current +
        chunk.toString("utf8");

      if (
        Buffer.byteLength(
          stdout + stderr + updated,
          "utf8",
        ) >
        2 * 1024 * 1024
      ) {
        outputTooLarge = true;
        child.kill("SIGKILL");
      }

      return updated;
    };

    child.stdout.on(
      "data",
      (chunk) => {
        stdout = appendOutput(
          stdout,
          chunk,
        );
      },
    );

    child.stderr.on(
      "data",
      (chunk) => {
        stderr = appendOutput(
          stderr,
          chunk,
        );
      },
    );

    child.on(
      "error",
      finishWithError,
    );

    timer = setTimeout(() => {
      child.kill("SIGKILL");

      finishWithError(
        new Error(
          "GitHub CLI işlemi zaman aşımına uğradı.",
        ),
      );
    }, timeoutMs);

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);

      if (outputTooLarge) {
        reject(
          new Error(
            "GitHub CLI çıktısı güvenlik sınırını aştı.",
          ),
        );
        return;
      }

      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });

    child.stdin.on(
      "error",
      () => {},
    );

    child.stdin.end(input);
  });
}

function parseJsonOutput(
  rawValue,
  description,
) {
  try {
    return JSON.parse(rawValue);
  } catch {
    throw new Error(
      `${description} geçerli JSON döndürmedi.`,
    );
  }
}

function parseGitHubRepoSlug(
  remoteUrl,
) {
  const value =
    String(remoteUrl ?? "")
      .trim();

  const patterns = [
    /^git@github\.com:([^/\s]+)\/([^/\s]+)$/i,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+)$/i,
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i,
  ];

  let match;

  for (const pattern of patterns) {
    match = value.match(pattern);

    if (match) {
      break;
    }
  }

  if (!match) {
    throw new Error(
      "Origin adresi desteklenen bir GitHub.com SSH veya HTTPS deposu değil.",
    );
  }

  const owner = match[1];
  const repository =
    match[2].replace(
      /\.git$/i,
      "",
    );

  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repository)
  ) {
    throw new Error(
      "GitHub sahibi veya depo adı beklenen güvenli biçimde değil.",
    );
  }

  return `${owner}/${repository}`;
}

async function getGitHubRepoSlug() {
  const origin =
    await runGitWithCode([
      "remote",
      "get-url",
      "origin",
    ]);

  if (
    origin.code !== 0 ||
    !origin.stdout.trim()
  ) {
    throw new Error(
      "Origin adlı Git remote bulunamadı.",
    );
  }

  return parseGitHubRepoSlug(
    origin.stdout,
  );
}

async function assertRemoteBranchAtHead(
  branch,
  expectedHead,
) {
  const remoteRef =
    `refs/heads/${branch}`;

  const result =
    await runGitWithCode(
      [
        "ls-remote",
        "--quiet",
        "--exit-code",
        "--heads",
        "origin",
        remoteRef,
      ],
      60_000,
    );

  if (result.code !== 0) {
    throw new Error(
      [
        "Aktif branch origin üzerinde bulunamadı.",
        "Önce push_branch aracını kullan.",
        sanitizeGitNetworkOutput(
          result.stderr ||
          result.stdout,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const remoteHead =
    (
      result.stdout
        .trim()
        .split(/\s+/)[0] ?? ""
    ).toLowerCase();

  if (remoteHead !== expectedHead) {
    throw new Error(
      [
        "Origin branch SHA değeri yerel HEAD ile uyuşmuyor.",
        `Yerel: ${expectedHead}`,
        `Uzak:  ${remoteHead || "alınamadı"}`,
        "Önce branch'i yeniden push et.",
      ].join("\n"),
    );
  }

  return remoteHead;
}

registerTextTool(
  "create_pull_request",
  {
    description:
      "Aktif ve origin'a push edilmiş equinox/ çalışma branch'inden yalnızca main branch'ine GitHub pull request oluşturur. Merge, close veya branch silme yapamaz.",
    inputSchema: {
      expected_head_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          "Beklenen HEAD SHA 40 veya 64 onaltılık karakter olmalı.",
        )
        .describe(
          "git_head aracından alınan tam HEAD SHA değeri",
        ),
      title: z
        .string()
        .min(5)
        .max(120)
        .describe(
          "Pull request başlığı",
        ),
      body: z
        .string()
        .max(10_000)
        .optional()
        .describe(
          "Pull request açıklaması",
        ),
      draft: z
        .boolean()
        .optional()
        .describe(
          "Belirtilmezse PR draft olarak oluşturulur",
        ),
    },
    annotations: {
      title: "Proje pull request oluştur",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    expected_head_sha,
    title,
    body,
    draft,
  }) => {
    let pullRequestCreated = false;

    try {
      const expectedHead =
        expected_head_sha.toLowerCase();

      if (
        title.trim() !== title ||
        title.includes("\n") ||
        title.includes("\r") ||
        title.includes("\0")
      ) {
        throw new Error(
          "PR başlığı tek satır olmalı ve başında veya sonunda boşluk bulunmamalı.",
        );
      }

      if (body?.includes("\0")) {
        throw new Error(
          "PR açıklaması NUL karakteri içeremez.",
        );
      }

      await assertNoGitOperationInProgress();
      await assertCleanGitWorktree();

      const branch =
        await getCurrentGitBranch();

      assertPushableEquinoxBranch(
        branch,
      );

      const currentHead =
        await getExactHeadCommit();

      if (currentHead !== expectedHead) {
        throw new Error(
          [
            "HEAD SHA uyuşmazlığı nedeniyle PR oluşturulmadı.",
            `Beklenen: ${expectedHead}`,
            `Mevcut:  ${currentHead}`,
            "Branch, git_head çağrısından sonra değişmiş olabilir.",
          ].join("\n"),
        );
      }

      const mainRef =
        await runGitWithCode([
          "rev-parse",
          "--verify",
          "refs/heads/main^{commit}",
        ]);

      if (mainRef.code !== 0) {
        throw new Error(
          "Yerel main branch'i bulunamadı.",
        );
      }

      const ancestorCheck =
        await runGitWithCode([
          "merge-base",
          "--is-ancestor",
          "refs/heads/main",
          "HEAD",
        ]);

      if (ancestorCheck.code === 1) {
        throw new Error(
          "Aktif çalışma branch'i mevcut yerel main branch'inden türemiyor.",
        );
      }

      if (ancestorCheck.code !== 0) {
        throw new Error(
          `Branch kökeni doğrulanamadı: ${ancestorCheck.stderr.trim()}`,
        );
      }

      const aheadCountResult =
        await runGitWithCode([
          "rev-list",
          "--count",
          "refs/heads/main..HEAD",
        ]);

      const aheadCount =
        Number.parseInt(
          aheadCountResult.stdout.trim(),
          10,
        );

      if (
        aheadCountResult.code !== 0 ||
        !Number.isInteger(aheadCount)
      ) {
        throw new Error(
          "Main'e göre commit sayısı hesaplanamadı.",
        );
      }

      if (aheadCount < 1) {
        throw new Error(
          "Aktif branch main'e göre yeni commit içermiyor; PR oluşturulmadı.",
        );
      }

      const remoteHead =
        await assertRemoteBranchAtHead(
          branch,
          expectedHead,
        );

      const repoSlug =
        await getGitHubRepoSlug();

      const authStatus =
        await runGhWithCode([
          "auth",
          "status",
          "--hostname",
          "github.com",
          "--active",
        ]);

      if (authStatus.code !== 0) {
        throw new Error(
          [
            "GitHub CLI oturumu geçerli değil.",
            "Terminalde 'gh auth login --hostname github.com --web' çalıştır.",
            sanitizeGitNetworkOutput(
              authStatus.stderr ||
              authStatus.stdout,
            ),
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      const existingResult =
        await runGhWithCode([
          "pr",
          "list",
          "--repo",
          repoSlug,
          "--state",
          "open",
          "--head",
          branch,
          "--base",
          "main",
          "--limit",
          "10",
          "--json",
          "number,url,title,isDraft,headRefName,baseRefName,state",
        ]);

      if (existingResult.code !== 0) {
        throw new Error(
          [
            "Mevcut PR kontrolü başarısız.",
            sanitizeGitNetworkOutput(
              existingResult.stderr ||
              existingResult.stdout,
            ),
          ].join("\n"),
        );
      }

      const existingPullRequests =
        parseJsonOutput(
          existingResult.stdout,
          "Mevcut PR sorgusu",
        );

      if (
        !Array.isArray(
          existingPullRequests,
        )
      ) {
        throw new Error(
          "Mevcut PR sorgusu beklenen liste biçiminde değil.",
        );
      }

      if (
        existingPullRequests.length > 0
      ) {
        const existing =
          existingPullRequests[0];

        throw new Error(
          [
            "Bu branch için zaten açık bir PR mevcut.",
            `PR #${existing.number}: ${existing.title}`,
            `Adres: ${existing.url}`,
          ].join("\n"),
        );
      }

      /*
       * --head:
       * gh'nin branch push etmesini veya fork
       * oluşturmayı teklif etmesini engeller.
       *
       * --body-file -:
       * PR gövdesini stdin üzerinden güvenli
       * biçimde iletir.
       *
       * --no-maintainer-edit:
       * Diğer yazma yetkisine sahip kullanıcıların
       * head branch'e doğrudan commit eklemesini
       * engeller.
       */
      const createArgs = [
        "pr",
        "create",
        "--repo",
        repoSlug,
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        title,
        "--body-file",
        "-",
        "--no-maintainer-edit",
      ];

      const shouldCreateDraft =
        draft ?? true;

      if (shouldCreateDraft) {
        createArgs.push(
          "--draft",
        );
      }

      const normalizedBody =
        body?.trim() ?? "";

      const createResult =
        await runGhWithCode(
          createArgs,
          normalizedBody,
          120_000,
        );

      if (createResult.code !== 0) {
        throw new Error(
          [
            "Pull request oluşturulamadı.",
            sanitizeGitNetworkOutput(
              createResult.stderr ||
              createResult.stdout,
            ) ||
              "GitHub CLI ayrıntılı hata döndürmedi.",
          ].join("\n"),
        );
      }

      pullRequestCreated = true;

      const viewResult =
        await runGhWithCode([
          "pr",
          "view",
          branch,
          "--repo",
          repoSlug,
          "--json",
          "number,url,title,state,isDraft,headRefName,headRefOid,baseRefName,maintainerCanModify",
        ]);

      if (viewResult.code !== 0) {
        throw new Error(
          "PR oluşturuldu ancak sonradan doğrulanamadı.",
        );
      }

      const pullRequest =
        parseJsonOutput(
          viewResult.stdout,
          "PR doğrulaması",
        );

      if (
        pullRequest.headRefName !== branch ||
        pullRequest.baseRefName !== "main"
      ) {
        throw new Error(
          [
            "PR oluşturuldu ancak branch bilgileri beklenen değerlerle uyuşmuyor.",
            `Head: ${pullRequest.headRefName}`,
            `Base: ${pullRequest.baseRefName}`,
          ].join("\n"),
        );
      }

      if (
        String(
          pullRequest.headRefOid ?? "",
        ).toLowerCase() !==
        expectedHead
      ) {
        throw new Error(
          [
            "PR oluşturuldu ancak GitHub üzerindeki head SHA beklenen commit değil.",
            `Beklenen: ${expectedHead}`,
            `GitHub:   ${pullRequest.headRefOid ?? "alınamadı"}`,
          ].join("\n"),
        );
      }

      return textResult(
        [
          `Pull request oluşturuldu: #${pullRequest.number}`,
          `Başlık: ${pullRequest.title}`,
          `Adres: ${pullRequest.url}`,
          `Depo: ${repoSlug}`,
          `Base: ${pullRequest.baseRefName}`,
          `Head: ${pullRequest.headRefName}`,
          `HEAD SHA: ${expectedHead}`,
          `Uzak SHA: ${remoteHead}`,
          `Durum: ${pullRequest.state}`,
          `Draft: ${pullRequest.isDraft ? "Evet" : "Hayır"}`,
          `Maintainer düzenlemesi: ${pullRequest.maintainerCanModify ? "Açık" : "Kapalı"}`,
          `Main'e göre commit sayısı: ${aheadCount}`,
          "Merge, close veya branch silme işlemi yapılmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      const message =
        sanitizeGitNetworkOutput(
          error instanceof Error
            ? error.message
            : String(error),
        );

      if (pullRequestCreated) {
        return textResult(
          [
            "Pull request GitHub üzerinde oluşturuldu.",
            "Ancak son doğrulama adımlarından biri tamamlanamadı.",
            message,
            "Aynı branch için yeniden create_pull_request çağırma; önce GitHub üzerindeki PR'ı kontrol et.",
          ].join("\n\n"),
        );
      }

      return errorResult(
        new Error(message),
      );
    }
  },
);



const SAFE_PROJECT_SCRIPT_NAMES =
  new Set([
    "build",
    "check",
    "lint",
    "test",
    "typecheck",
    "type-check",
    "validate",
    "verify",
    "format",
    "format:check",
  ]);

const SAFE_PROJECT_SCRIPT_PREFIXES =
  [
    "build:",
    "check:",
    "lint:",
    "test:",
    "typecheck:",
    "type-check:",
    "validate:",
    "verify:",
    "format:",
  ];

function isAllowedProjectScriptName(
  scriptName,
) {
  return (
    SAFE_PROJECT_SCRIPT_NAMES.has(
      scriptName,
    ) ||
    SAFE_PROJECT_SCRIPT_PREFIXES.some(
      (prefix) =>
        scriptName.startsWith(prefix),
    )
  );
}

async function readProjectPackageJson() {
  const packagePath =
    path.join(
      getActiveProjectRoot(),
      "package.json",
    );

  let buffer;

  try {
    buffer = await fs.readFile(
      packagePath,
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "Seçilen projede package.json bulunamadı.",
      );
    }

    throw error;
  }

  if (
    buffer.length >
    MAX_FILE_BYTES
  ) {
    throw new Error(
      "package.json 512 KB güvenlik sınırını aşıyor.",
    );
  }

  if (buffer.includes(0)) {
    throw new Error(
      "package.json ikili veri içeriyor.",
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(
      new TextDecoder(
        "utf-8",
        { fatal: true },
      ).decode(buffer),
    );
  } catch {
    throw new Error(
      "package.json geçerli UTF-8 JSON değil.",
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "package.json beklenen nesne biçiminde değil.",
    );
  }

  const scripts =
    parsed.scripts &&
    typeof parsed.scripts === "object" &&
    !Array.isArray(parsed.scripts)
      ? parsed.scripts
      : {};

  return {
    packagePath,
    packageJson: parsed,
    scripts,
  };
}

function validateWritableDirectoryPath(
  requestedPath,
) {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.trim() !==
      requestedPath ||
    requestedPath.length < 1 ||
    requestedPath.length > 300 ||
    path.isAbsolute(requestedPath) ||
    requestedPath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(
      requestedPath,
    )
  ) {
    throw new Error(
      "Geçersiz veya güvensiz klasör yolu.",
    );
  }

  const segments =
    requestedPath.split("/");

  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === "..",
    )
  ) {
    throw new Error(
      "Klasör yolu boş, yinelenen veya üst dizine çıkan bölümler içeremez.",
    );
  }

  for (const segment of segments) {
    if (
      IGNORED_DIRECTORIES.has(
        segment,
      ) ||
      isSensitiveName(segment)
    ) {
      throw new Error(
        `Bu klasör yolu kapalı: ${segment}`,
      );
    }
  }

  const candidate =
    path.resolve(
      getActiveProjectRoot(),
      requestedPath,
    );

  if (!isInsideProject(candidate)) {
    throw new Error(
      "Klasör proje kökünün dışına çıkıyor.",
    );
  }
  if (FULL_FILE_ACCESS && !getActiveProjectContext().configured) {
    assertNotProtectedAgentPath(candidate);
  }

  return {
    candidate,
    normalized:
      segments.join("/"),
  };
}

async function assertPathNotIgnored(
  relativePath,
) {
  if (getActiveProjectContext().kind !== "git") {
    return;
  }

  const ignored =
    await runGitWithCode([
      "check-ignore",
      "-q",
      "--no-index",
      "--",
      relativePath,
    ]);

  if (ignored.code === 0) {
    throw new Error(
      `Git tarafından yok sayılan yol işlenemez: ${relativePath}`,
    );
  }

  if (ignored.code !== 1) {
    throw new Error(
      [
        `Git ignore kontrolü başarısız: ${relativePath}`,
        ignored.stderr.trim(),
      ].join("\n"),
    );
  }
}

registerTextTool(
  "list_package_scripts",
  {
    description:
      "Seçilen projenin package.json scripts alanını ve Equinox Local tarafından çalıştırılmasına izin verilen script adlarını gösterir.",
    inputSchema: {},
    annotations: {
      title: "Proje npm scriptlerini listele",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const { scripts } =
        await readProjectPackageJson();

      const entries =
        Object.entries(scripts)
          .filter(
            ([name, command]) =>
              typeof name === "string" &&
              typeof command === "string",
          )
          .sort(([a], [b]) =>
            a.localeCompare(b),
          );

      if (entries.length === 0) {
        return textResult(
          "package.json içinde npm scripti bulunmuyor.",
        );
      }

      return textResult(
        entries
          .map(
            ([name, command]) =>
              `${isAllowedProjectScriptName(name) ? "[izinli]" : "[kapalı]"} ${name}: ${command}`,
          )
          .join("\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "run_project_script",
  {
    description:
      "Seçilen projede package.json içinde tanımlı ve güvenli isim allowlist'ine uyan tek bir npm scriptini argümansız çalıştırır. Scriptin kendi davranışı dosya veya ağ değişikliği yapabilir.",
    inputSchema: {
      script: z
        .string()
        .min(1)
        .max(80)
        .regex(
          /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/,
          "Script adı yalnızca harf, rakam, iki nokta, nokta, alt çizgi veya tire içerebilir.",
        )
        .describe(
          "package.json içinde mevcut npm script adı",
        ),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(900)
        .default(300)
        .describe(
          "Script zaman aşımı; en fazla 900 saniye",
        ),
    },
    annotations: {
      title: "Proje npm scriptini çalıştır",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    script,
    timeout_seconds,
  }) => {
    const startedAt = Date.now();

    try {
      if (
        !isAllowedProjectScriptName(
          script,
        )
      ) {
        throw new Error(
          [
            `Bu npm script adı allowlist dışında: ${script}`,
            "İzinli ana adlar: build, check, lint, test, typecheck, type-check, validate, verify ve format.",
          ].join("\n"),
        );
      }

      const { scripts } =
        await readProjectPackageJson();

      if (
        typeof scripts[script] !==
        "string"
      ) {
        throw new Error(
          `package.json içinde bu script bulunamadı: ${script}`,
        );
      }

      const npmBinary =
        "/opt/homebrew/bin/npm";

      const { stdout, stderr } =
        await execFile(
          npmBinary,
          ["run", script],
          {
            cwd: getActiveProjectRoot(),
            timeout:
              timeout_seconds * 1000,
            maxBuffer:
              8 * 1024 * 1024,
            env: {
              ...process.env,
              PATH:
                `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`,
              CI: "1",
              NO_COLOR: "1",
              GIT_TERMINAL_PROMPT: "0",
            },
          },
        );

      const durationSeconds =
        (
          (Date.now() - startedAt) /
          1000
        ).toFixed(1);

      const output =
        [stdout, stderr]
          .filter(Boolean)
          .join("\n")
          .trim();

      const status =
        await runGitWithCode([
          "status",
          "--short",
          "--branch",
          "--untracked-files=normal",
        ]);

      return textResult(
        [
          `npm run ${script} başarılı (${durationSeconds} saniye).`,
          output ||
            "Script herhangi bir çıktı üretmedi.",
          status.code === 0
            ? `Son Git durumu:\n${status.stdout.trim() || "Çalışma ağacı temiz."}`
            : "Script sonrası Git durumu alınamadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      const durationSeconds =
        (
          (Date.now() - startedAt) /
          1000
        ).toFixed(1);

      const stdout =
        typeof error?.stdout === "string"
          ? error.stdout
          : "";
      const stderr =
        typeof error?.stderr === "string"
          ? error.stderr
          : "";
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      return errorResult(
        new Error(
          [
            `npm run ${script} başarısız (${durationSeconds} saniye).`,
            stdout,
            stderr,
            message,
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      );
    }
  },
);

registerTextTool(
  "create_directory",
  {
    description:
      "Seçilen çalışma kökü içinde yeni bir klasör yolu oluşturur. Kök dışına, .git veya hassas credential alanlarına yazamaz; Git reposunda ignore kuralları da korunur.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .max(300)
        .describe(
          "Proje köküne göre göreli yeni klasör yolu",
        ),
    },
    annotations: {
      title: "Proje klasörü oluştur",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ path: requestedPath }) => {
    const createdPaths = [];

    try {
      const validated =
        validateWritableDirectoryPath(
          requestedPath,
        );

      await assertPathNotIgnored(
        `${validated.normalized}/`,
      );

      const segments =
        validated.normalized.split("/");

      let current =
        getActiveProjectRoot();

      for (const segment of segments) {
        current =
          path.join(current, segment);

        try {
          const existing =
            await fs.lstat(current);

          if (existing.isSymbolicLink()) {
            throw new Error(
              `Klasör yolunda symlink bulundu: ${displayPath(current)}`,
            );
          }

          if (!existing.isDirectory()) {
            throw new Error(
              `Klasör yolundaki mevcut öğe klasör değil: ${displayPath(current)}`,
            );
          }
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }

          await fs.mkdir(
            current,
            { mode: 0o755 },
          );
          createdPaths.push(current);
        }
      }

      const finalRealPath =
        await fs.realpath(
          validated.candidate,
        );

      if (!isInsideProject(finalRealPath)) {
        throw new Error(
          "Oluşturulan klasör proje dışına yönleniyor.",
        );
      }

      return textResult(
        [
          createdPaths.length > 0
            ? `Klasör oluşturuldu: ${validated.normalized}`
            : `Klasör zaten mevcut: ${validated.normalized}`,
          createdPaths.length > 0
            ? `Oluşturulan klasör sayısı: ${createdPaths.length}`
            : "Yeni klasör oluşturulmadı.",
          "Not: Git boş klasörleri takip etmez; klasöre dosya eklenene kadar git_status değişmeyebilir.",
        ].join("\n\n"),
      );
    } catch (error) {
      for (
        const createdPath
        of createdPaths.reverse()
      ) {
        await fs.rmdir(
          createdPath,
        ).catch(() => {});
      }

      return errorResult(error);
    }
  },
);

registerTextTool(
  "remove_empty_directory",
  {
    description:
      "Seçilen çalışma kökündeki tek bir boş klasörü siler. Çalışma kökünü, symlink'i, dolu klasörü, .git veya hassas credential yollarını silemez.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .max(300)
        .describe(
          "Proje köküne göre göreli boş klasör yolu",
        ),
    },
    annotations: {
      title: "Boş proje klasörünü sil",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ path: requestedPath }) => {
    try {
      const validated =
        validateWritableDirectoryPath(
          requestedPath,
        );

      const rawStats =
        await fs.lstat(
          validated.candidate,
        );

      if (rawStats.isSymbolicLink()) {
        throw new Error(
          "Symlink klasör silinemez.",
        );
      }

      if (!rawStats.isDirectory()) {
        throw new Error(
          "Belirtilen yol klasör değil.",
        );
      }

      const entries =
        await fs.readdir(
          validated.candidate,
        );

      if (entries.length > 0) {
        throw new Error(
          "Klasör boş değil; hiçbir şey silinmedi.",
        );
      }

      await fs.rmdir(
        validated.candidate,
      );

      return textResult(
        `Boş klasör silindi: ${validated.normalized}`,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "move_file",
  {
    description:
      "Seçilen çalışma kökündeki mevcut normal bir dosyayı aynı kök içinde yeni ve boş bir hedef yola taşır. Üzerine yazmaz veya symlink işlemez; Git reposunda önceden değişiklik taşıyan takipli dosyayı ayrıca korur.",
    inputSchema: {
      source: z
        .string()
        .min(1)
        .max(300)
        .describe(
          "Proje köküne göre göreli mevcut kaynak dosya",
        ),
      destination: z
        .string()
        .min(1)
        .max(300)
        .describe(
          "Proje köküne göre göreli ve mevcut olmayan hedef dosya",
        ),
    },
    annotations: {
      title: "Proje dosyasını taşı",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ source, destination }) => {
    let moved = false;
    let sourcePath;
    let destinationPath;

    try {
      if (source === destination) {
        throw new Error(
          "Kaynak ve hedef yol aynı olamaz.",
        );
      }

      checkRequestedPath(source);

      const sourceCandidate =
        path.resolve(
          getActiveProjectRoot(),
          source,
        );

      if (!isInsideProject(sourceCandidate)) {
        throw new Error(
          "Kaynak dosya proje dışına çıkıyor.",
        );
      }

      const sourceRawStats =
        await fs.lstat(
          sourceCandidate,
        );

      if (
        sourceRawStats.isSymbolicLink() ||
        !sourceRawStats.isFile()
      ) {
        throw new Error(
          "Kaynak normal bir dosya olmalı; symlink veya klasör taşınamaz.",
        );
      }

      sourcePath =
        await safeResolve(source);

      const sourceResolvedStats =
        await fs.stat(sourcePath);

      if (
        sourceRawStats.dev !== sourceResolvedStats.dev ||
        sourceRawStats.ino !== sourceResolvedStats.ino
      ) {
        throw new Error(
          "Kaynak dosya doğrulama sırasında değişti.",
        );
      }

      if (
        sourceRawStats.size >
        MAX_HASHABLE_FILE_BYTES
      ) {
        throw new Error(
          "Kaynak dosya 10 MB taşıma sınırını aşıyor.",
        );
      }

      const sourceRelative =
        displayPath(sourcePath);

      const isGitProject =
        getActiveProjectContext().kind === "git";
      let sourceIsUntracked = false;
      if (isGitProject) {
        await assertPathNotIgnored(
          sourceRelative,
        );

        const sourceStatus =
          await runGitWithCode([
            "status",
            "--porcelain=v1",
            "--no-renames",
            "--",
            sourceRelative,
          ]);

        if (sourceStatus.code !== 0) {
          throw new Error(
            `Kaynak Git durumu alınamadı: ${sourceStatus.stderr.trim()}`,
          );
        }

        const sourceStatusLines =
          sourceStatus.stdout
            .split("\n")
            .map((line) => line.trimEnd())
            .filter(Boolean);

        sourceIsUntracked =
          sourceStatusLines.length === 1 &&
          sourceStatusLines[0].startsWith(
            "?? ",
          );

        if (
          sourceStatusLines.length > 0 &&
          !sourceIsUntracked
        ) {
          throw new Error(
            [
              "Kaynak takipli dosyada önceden Git değişikliği var; taşıma durduruldu.",
              ...sourceStatusLines,
            ].join("\n"),
          );
        }
      }

      checkRequestedPath(destination);

      if (
        destination.trim() !== destination ||
        destination.includes("\\") ||
        /[\u0000-\u001f\u007f]/.test(
          destination,
        )
      ) {
        throw new Error(
          "Hedef dosya yolu geçersiz.",
        );
      }

      const destinationSegments =
        destination.split("/");

      if (
        destinationSegments.some(
          (segment) =>
            !segment ||
            segment === "." ||
            segment === "..",
        )
      ) {
        throw new Error(
          "Hedef yol boş veya üst dizine çıkan bölüm içeremez.",
        );
      }

      const parentRelative =
        path.posix.dirname(destination);

      const parentPath =
        parentRelative === "."
          ? getActiveProjectRoot()
          : await safeResolve(
              parentRelative,
            );

      const parentStats =
        await fs.lstat(parentPath);

      if (
        parentStats.isSymbolicLink() ||
        !parentStats.isDirectory()
      ) {
        throw new Error(
          "Hedef üst yol normal bir klasör değil.",
        );
      }

      destinationPath =
        path.join(
          parentPath,
          path.posix.basename(
            destination,
          ),
        );

      if (!isInsideProject(destinationPath)) {
        throw new Error(
          "Hedef dosya proje dışına çıkıyor.",
        );
      }
      if (FULL_FILE_ACCESS && !getActiveProjectContext().configured) {
        assertNotProtectedAgentPath(destinationPath);
      }

      try {
        await fs.lstat(destinationPath);
        throw new Error(
          "Hedef dosya zaten mevcut; üzerine yazılmadı.",
        );
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      await assertPathNotIgnored(
        destination,
      );

      await fs.rename(
        sourcePath,
        destinationPath,
      );
      moved = true;

      let statusAfter = null;
      if (isGitProject) {
        statusAfter =
          await runGitWithCode([
            "status",
            "--short",
            "--no-renames",
            "--",
            sourceRelative,
            destination,
          ]);

        if (statusAfter.code !== 0) {
          throw new Error(
            `Taşıma sonrası Git durumu alınamadı: ${statusAfter.stderr.trim()}`,
          );
        }
      }

      moved = false;

      return textResult(
        [
          `Dosya taşındı: ${sourceRelative} -> ${destination}`,
          isGitProject
            ? sourceIsUntracked
              ? "Kaynak dosya Git tarafından izlenmiyordu."
              : "Kaynak dosya taşınmadan önce takipli ve temizdi."
            : "Git denetimi uygulanmadı; çalışma kökü normal bir klasör.",
          isGitProject
            ? statusAfter.stdout.trim()
              ? `Git durumu:\n${statusAfter.stdout.trim()}`
              : "Git durumu değişiklik göstermiyor."
            : "Taşıma aynı çalışma kökü içinde tamamlandı.",
          isGitProject
            ? "commit_changes bu taşımayı ekleme + silme olarak güvenli biçimde commit edebilir."
            : "Git commit adımı uygulanmaz.",
        ].join("\n\n"),
      );
    } catch (error) {
      if (
        moved &&
        sourcePath &&
        destinationPath
      ) {
        await fs.rename(
          destinationPath,
          sourcePath,
        ).catch(() => {});
      }

      return errorResult(error);
    }
  },
);

registerTextTool(
  "checkout_main",
  {
    description:
      "Seçilen projede çalışma ağacı temizse ve devam eden Git işlemi yoksa yerel main branch'ine geçer. Fetch, pull, reset veya branch silme yapmaz.",
    inputSchema: {},
    annotations: {
      title: "Projenin main branch'ine geç",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      await assertNoGitOperationInProgress();
      await assertCleanGitWorktree();

      const before =
        await getCurrentGitBranch();

      const mainExists =
        await runGitWithCode([
          "show-ref",
          "--verify",
          "--quiet",
          "refs/heads/main",
        ]);

      if (mainExists.code !== 0) {
        throw new Error(
          mainExists.code === 1
            ? "Yerel main branch'i bulunamadı."
            : "Yerel main branch kontrolü başarısız.",
        );
      }

      if (before !== "main") {
        const checkout =
          await runGitWithCode([
            "checkout",
            "--no-guess",
            "main",
          ]);

        if (checkout.code !== 0) {
          throw new Error(
            [
              "Main branch'ine geçilemedi.",
              checkout.stderr.trim() ||
                checkout.stdout.trim(),
            ].join("\n"),
          );
        }
      }

      const after =
        await getCurrentGitBranch();

      if (after !== "main") {
        throw new Error(
          "Checkout sonrasında aktif branch main değil.",
        );
      }

      return textResult(
        [
          before === "main"
            ? "Zaten main branch'indeydi."
            : `Branch değiştirildi: ${before} -> main`,
          "Fetch, pull, reset veya branch silme yapılmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "sync_main",
  {
    description:
      "Seçilen projede yalnızca temiz yerel main branch'ini origin/main ile fetch + fast-forward olarak eşitler. Rebase, merge commit, reset, force veya push yapmaz.",
    inputSchema: {
      expected_local_head: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          "Beklenen yerel HEAD SHA 40 veya 64 onaltılık karakter olmalı.",
        )
        .describe(
          "git_head aracından alınan tam yerel main HEAD SHA değeri",
        ),
    },
    annotations: {
      title: "Proje main branch'ini fast-forward eşitle",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ expected_local_head }) => {
    try {
      const expectedHead =
        expected_local_head.toLowerCase();

      await assertNoGitOperationInProgress();
      await assertCleanGitWorktree();

      const branch =
        await getCurrentGitBranch();

      if (branch !== "main") {
        throw new Error(
          [
            "sync_main yalnızca aktif main branch'inde çalışır.",
            `Mevcut branch: ${branch}`,
          ].join("\n"),
        );
      }

      const currentHead =
        await getExactHeadCommit();

      if (currentHead !== expectedHead) {
        throw new Error(
          [
            "Yerel HEAD SHA uyuşmazlığı nedeniyle eşitleme yapılmadı.",
            `Beklenen: ${expectedHead}`,
            `Mevcut:  ${currentHead}`,
          ].join("\n"),
        );
      }

      const origin =
        await runGitWithCode([
          "remote",
          "get-url",
          "origin",
        ]);

      if (
        origin.code !== 0 ||
        !origin.stdout.trim()
      ) {
        throw new Error(
          "Origin adlı Git remote bulunamadı.",
        );
      }

      const fetchResult =
        await runGitWithCode(
          [
            "fetch",
            "--no-tags",
            "origin",
            "refs/heads/main:refs/remotes/origin/main",
          ],
          120_000,
        );

      if (fetchResult.code !== 0) {
        throw new Error(
          [
            "origin/main fetch edilemedi.",
            sanitizeGitNetworkOutput(
              fetchResult.stderr ||
              fetchResult.stdout,
            ),
          ].join("\n"),
        );
      }

      await assertCleanGitWorktree();

      const headAfterFetch =
        await getExactHeadCommit();

      if (headAfterFetch !== expectedHead) {
        throw new Error(
          "Fetch sırasında yerel main HEAD beklenmedik şekilde değişti.",
        );
      }

      const remoteHeadResult =
        await runGitWithCode([
          "rev-parse",
          "--verify",
          "refs/remotes/origin/main^{commit}",
        ]);

      if (remoteHeadResult.code !== 0) {
        throw new Error(
          "Fetch sonrası origin/main commit'i doğrulanamadı.",
        );
      }

      const remoteHead =
        remoteHeadResult.stdout
          .trim()
          .toLowerCase();

      const aheadBehind =
        await runGitWithCode([
          "rev-list",
          "--left-right",
          "--count",
          "refs/remotes/origin/main...HEAD",
        ]);

      if (aheadBehind.code !== 0) {
        throw new Error(
          "Main ile origin/main ayrışması hesaplanamadı.",
        );
      }

      const [remoteOnlyRaw = "0", localOnlyRaw = "0"] =
        aheadBehind.stdout
          .trim()
          .split(/\s+/);

      const remoteOnly =
        Number.parseInt(
          remoteOnlyRaw,
          10,
        );
      const localOnly =
        Number.parseInt(
          localOnlyRaw,
          10,
        );

      if (
        !Number.isInteger(remoteOnly) ||
        !Number.isInteger(localOnly)
      ) {
        throw new Error(
          "Main ayrışma sayıları geçersiz.",
        );
      }

      if (localOnly > 0) {
        throw new Error(
          [
            "Yerel main origin/main üzerinde bulunmayan commit içeriyor; otomatik eşitleme yapılmadı.",
            `Yerel-only commit sayısı: ${localOnly}`,
            `Uzak-only commit sayısı: ${remoteOnly}`,
          ].join("\n"),
        );
      }

      if (remoteOnly > 0) {
        const mergeResult =
          await runGitWithCode(
            [
              "merge",
              "--ff-only",
              "refs/remotes/origin/main",
            ],
            120_000,
          );

        if (mergeResult.code !== 0) {
          throw new Error(
            [
              "Main fast-forward güncellenemedi.",
              mergeResult.stderr.trim() ||
                mergeResult.stdout.trim(),
            ].join("\n"),
          );
        }
      }

      const finalHead =
        await getExactHeadCommit();

      if (finalHead !== remoteHead) {
        throw new Error(
          [
            "Eşitleme sonrası yerel main origin/main ile aynı SHA değerinde değil.",
            `Yerel: ${finalHead}`,
            `Uzak:  ${remoteHead}`,
          ].join("\n"),
        );
      }

      await assertCleanGitWorktree();

      return textResult(
        [
          remoteOnly > 0
            ? `Main fast-forward güncellendi (${remoteOnly} commit).`
            : "Main zaten origin/main ile günceldi.",
          `Önceki SHA: ${expectedHead}`,
          `Güncel SHA: ${finalHead}`,
          "Rebase, merge commit, reset, force veya push yapılmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(
        new Error(
          sanitizeGitNetworkOutput(
            error instanceof Error
              ? error.message
              : String(error),
          ),
        ),
      );
    }
  },
);


function validateEquinoxWorkBranch(
  branch,
) {
  if (
    typeof branch !== "string" ||
    !/^equinox\/[a-z0-9][a-z0-9._-]{0,59}$/.test(
      branch,
    )
  ) {
    throw new Error(
      `Geçersiz veya izin verilmeyen çalışma branch'i: ${branch}`,
    );
  }

  if (
    branch === "equinox/main" ||
    branch === "equinox/master"
  ) {
    throw new Error(
      "Korunan branch adına benzeyen çalışma branch'i kullanılamaz.",
    );
  }

  return branch;
}

async function assertGhAuthenticated() {
  const result =
    await runGhWithCode([
      "auth",
      "status",
      "--hostname",
      "github.com",
      "--active",
    ]);

  if (result.code !== 0) {
    throw new Error(
      [
        "GitHub CLI oturumu geçerli değil.",
        "Terminalde 'gh auth login --hostname github.com --web' çalıştır.",
        sanitizeGitNetworkOutput(
          result.stderr ||
          result.stdout,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

async function readPullRequestByNumber(
  repoSlug,
  prNumber,
) {
  const result =
    await runGhWithCode([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repoSlug,
      "--json",
      [
        "number",
        "url",
        "title",
        "body",
        "state",
        "isDraft",
        "baseRefName",
        "baseRefOid",
        "headRefName",
        "headRefOid",
        "mergeable",
        "mergeStateStatus",
        "reviewDecision",
        "changedFiles",
        "additions",
        "deletions",
        "createdAt",
        "updatedAt",
        "mergedAt",
        "closedAt",
        "maintainerCanModify",
        "isCrossRepository",
      ].join(","),
    ]);

  if (result.code !== 0) {
    throw new Error(
      [
        `PR #${prNumber} okunamadı.`,
        sanitizeGitNetworkOutput(
          result.stderr ||
          result.stdout,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const pullRequest =
    parseJsonOutput(
      result.stdout,
      `PR #${prNumber} sorgusu`,
    );

  if (
    !pullRequest ||
    pullRequest.number !== prNumber
  ) {
    throw new Error(
      "GitHub PR sorgusu beklenen PR numarasını döndürmedi.",
    );
  }

  return pullRequest;
}

function assertSafeMutablePullRequest(
  pullRequest,
  expectedHead,
) {
  if (pullRequest.state !== "OPEN") {
    throw new Error(
      `Yalnızca açık PR değiştirilebilir. Mevcut durum: ${pullRequest.state}`,
    );
  }

  if (pullRequest.baseRefName !== "main") {
    throw new Error(
      `PR hedef branch'i main değil: ${pullRequest.baseRefName}`,
    );
  }

  validateEquinoxWorkBranch(
    pullRequest.headRefName,
  );

  if (pullRequest.isCrossRepository) {
    throw new Error(
      "Fork veya çapraz depo PR'ları bu araçla değiştirilemez.",
    );
  }

  const actualHead =
    String(
      pullRequest.headRefOid ?? "",
    ).toLowerCase();

  if (actualHead !== expectedHead) {
    throw new Error(
      [
        "PR HEAD SHA beklenen değerle uyuşmuyor.",
        `Beklenen: ${expectedHead}`,
        `GitHub:   ${actualHead || "alınamadı"}`,
      ].join("\n"),
    );
  }
}

registerTextTool(
  "git_log",
  {
    description:
      "Seçilen projede mevcut branch veya main üzerindeki son Git commit'lerini salt okunur biçimde listeler.",
    inputSchema: {
      ref: z
        .enum(["current", "main"])
        .default("current")
        .describe(
          "Commit geçmişi okunacak ref",
        ),
      max_count: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20),
      path: z
        .string()
        .optional()
        .describe(
          "İsteğe bağlı göreli dosya veya klasör yolu",
        ),
    },
    annotations: {
      title: "Git commit geçmişini göster",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({
    ref,
    max_count,
    path: requestedPath,
  }) => {
    try {
      const revision =
        ref === "main"
          ? "refs/heads/main"
          : "HEAD";

      const verify =
        await runGitWithCode([
          "rev-parse",
          "--verify",
          `${revision}^{commit}`,
        ]);

      if (verify.code !== 0) {
        throw new Error(
          `Git ref doğrulanamadı: ${revision}`,
        );
      }

      const args = [
        "log",
        `--max-count=${max_count}`,
        "--date=iso-strict",
        "--format=%H%x09%h%x09%ad%x09%an%x09%s",
        revision,
      ];

      if (requestedPath) {
        const resolved =
          await safeResolve(
            requestedPath,
          );
        args.push(
          "--",
          displayPath(resolved),
        );
      }

      const result =
        await runGitWithCode(args);

      if (result.code !== 0) {
        throw new Error(
          `Git log alınamadı: ${result.stderr.trim()}`,
        );
      }

      return textResult(
        result.stdout.trim() ||
          "Gösterilecek commit bulunamadı.",
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "git_show",
  {
    description:
      "Seçilen projede doğrulanan bir commit'in metadata, dosya özeti ve isteğe bağlı patch içeriğini gösterir.",
    inputSchema: {
      revision: z
        .string()
        .regex(
          /^(?:HEAD|main|[a-fA-F0-9]{7,64})$/,
          "Revision HEAD, main veya 7-64 karakterlik commit SHA olmalı.",
        )
        .default("HEAD"),
      include_patch: z
        .boolean()
        .default(false),
      path: z
        .string()
        .optional()
        .describe(
          "İsteğe bağlı göreli dosya veya klasör yolu",
        ),
    },
    annotations: {
      title: "Git commit ayrıntısını göster",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({
    revision,
    include_patch,
    path: requestedPath,
  }) => {
    try {
      const verify =
        await runGitWithCode([
          "rev-parse",
          "--verify",
          `${revision}^{commit}`,
        ]);

      if (verify.code !== 0) {
        throw new Error(
          `Commit doğrulanamadı: ${revision}`,
        );
      }

      const commit =
        verify.stdout.trim();

      const args = [
        "show",
        "--no-ext-diff",
        "--no-renames",
        "--format=fuller",
        "--stat",
        "--summary",
      ];

      if (include_patch) {
        args.push("--patch");
      }

      args.push(commit);

      if (requestedPath) {
        const resolved =
          await safeResolve(
            requestedPath,
          );
        args.push(
          "--",
          displayPath(resolved),
        );
      }

      const result =
        await runGitWithCode(
          args,
          60_000,
        );

      if (result.code !== 0) {
        throw new Error(
          `Commit gösterilemedi: ${result.stderr.trim()}`,
        );
      }

      return textResult(
        [
          `Doğrulanan commit: ${commit}`,
          result.stdout.trim(),
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "list_work_branches",
  {
    description:
      "Seçilen projedeki yerel ve origin üzerindeki equinox/ çalışma branch'lerini, commit ve takip bilgileriyle listeler.",
    inputSchema: {},
    annotations: {
      title: "Çalışma branch'lerini listele",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const current =
        await getCurrentGitBranch();

      const local =
        await runGitWithCode([
          "for-each-ref",
          "--sort=-committerdate",
          "--format=%(refname:short)%09%(objectname)%09%(upstream:short)%09%(upstream:track)%09%(committerdate:iso-strict)%09%(subject)",
          "refs/heads/equinox",
        ]);

      const remote =
        await runGitWithCode([
          "for-each-ref",
          "--sort=-committerdate",
          "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(subject)",
          "refs/remotes/origin/equinox",
        ]);

      if (
        local.code !== 0 ||
        remote.code !== 0
      ) {
        throw new Error(
          "Çalışma branch listesi alınamadı.",
        );
      }

      return textResult(
        [
          `Aktif branch: ${current}`,
          `Yerel equinox/ branch'leri:\n${local.stdout.trim() || "Yok"}`,
          `Bilinen origin/equinox branch'leri:\n${remote.stdout.trim() || "Yok"}`,
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "checkout_work_branch",
  {
    description:
      "Temiz çalışma ağacında mevcut yerel equinox/ branch'ine geçer veya bilinen origin/equinox branch'inden takip eden yerel branch oluşturur. Fetch, reset veya merge yapmaz.",
    inputSchema: {
      slug: z
        .string()
        .regex(
          /^[a-z0-9][a-z0-9._-]{0,59}$/,
          "Branch slug'ı küçük harf, rakam, nokta, tire veya alt çizgi kullanmalı.",
        ),
    },
    annotations: {
      title: "Çalışma branch'ine geç",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ slug }) => {
    try {
      await assertNoGitOperationInProgress();
      await assertCleanGitWorktree();

      const branch =
        validateEquinoxWorkBranch(
          `equinox/${slug}`,
        );

      const before =
        await getCurrentGitBranch();

      if (before === branch) {
        return textResult(
          `Zaten ${branch} branch'indeydi.`,
        );
      }

      const local =
        await runGitWithCode([
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]);

      let checkout;
      let mode;

      if (local.code === 0) {
        checkout =
          await runGitWithCode([
            "checkout",
            "--no-guess",
            branch,
          ]);
        mode = "Mevcut yerel branch";
      } else if (local.code === 1) {
        const remote =
          await runGitWithCode([
            "show-ref",
            "--verify",
            "--quiet",
            `refs/remotes/origin/${branch}`,
          ]);

        if (remote.code !== 0) {
          throw new Error(
            remote.code === 1
              ? `Yerel veya bilinen origin branch'i bulunamadı: ${branch}`
              : "Origin branch kontrolü başarısız.",
          );
        }

        checkout =
          await runGitWithCode([
            "checkout",
            "--no-guess",
            "-b",
            branch,
            "--track",
            `origin/${branch}`,
          ]);
        mode = "Origin branch'inden takip eden yerel branch";
      } else {
        throw new Error(
          "Yerel branch kontrolü başarısız.",
        );
      }

      if (checkout.code !== 0) {
        throw new Error(
          [
            "Çalışma branch'ine geçilemedi.",
            checkout.stderr.trim() ||
              checkout.stdout.trim(),
          ].join("\n"),
        );
      }

      const after =
        await getCurrentGitBranch();

      if (after !== branch) {
        throw new Error(
          "Checkout sonrasında aktif branch doğrulanamadı.",
        );
      }

      return textResult(
        [
          `Branch değiştirildi: ${before} -> ${after}`,
          `Yöntem: ${mode}`,
          "Fetch, reset veya merge yapılmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "get_pull_request",
  {
    description:
      "Seçilen GitHub deposundaki bir pull request'in branch, SHA, draft, merge ve değişiklik bilgilerini salt okunur biçimde gösterir.",
    inputSchema: {
      pr_number: z
        .number()
        .int()
        .min(1),
    },
    annotations: {
      title: "Pull request bilgisi",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ pr_number }) => {
    try {
      await assertGhAuthenticated();
      const repoSlug =
        await getGitHubRepoSlug();
      const pr =
        await readPullRequestByNumber(
          repoSlug,
          pr_number,
        );

      return textResult(
        [
          `PR #${pr.number}: ${pr.title}`,
          `Adres: ${pr.url}`,
          `Durum: ${pr.state}`,
          `Draft: ${pr.isDraft ? "Evet" : "Hayır"}`,
          `Base: ${pr.baseRefName} (${pr.baseRefOid})`,
          `Head: ${pr.headRefName} (${pr.headRefOid})`,
          `Mergeable: ${pr.mergeable}`,
          `Merge state: ${pr.mergeStateStatus}`,
          `Review decision: ${pr.reviewDecision || "Yok"}`,
          `Değişiklik: ${pr.changedFiles} dosya, +${pr.additions} / -${pr.deletions}`,
          `Oluşturulma: ${pr.createdAt}`,
          `Güncellenme: ${pr.updatedAt}`,
          pr.mergedAt
            ? `Merge zamanı: ${pr.mergedAt}`
            : "Merge zamanı: Yok",
          pr.closedAt
            ? `Kapanma zamanı: ${pr.closedAt}`
            : "Kapanma zamanı: Yok",
          `Maintainer düzenlemesi: ${pr.maintainerCanModify ? "Açık" : "Kapalı"}`,
          `Açıklama:\n${pr.body || "(boş)"}`,
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(
        new Error(
          sanitizeGitNetworkOutput(
            error instanceof Error
              ? error.message
              : String(error),
          ),
        ),
      );
    }
  },
);

registerTextTool(
  "get_pull_request_checks",
  {
    description:
      "Seçilen GitHub deposundaki bir pull request'in CI ve GitHub Actions kontrol durumlarını salt okunur biçimde gösterir.",
    inputSchema: {
      pr_number: z
        .number()
        .int()
        .min(1),
      required_only: z
        .boolean()
        .default(false),
    },
    annotations: {
      title: "Pull request kontrolleri",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({
    pr_number,
    required_only,
  }) => {
    try {
      await assertGhAuthenticated();
      const repoSlug =
        await getGitHubRepoSlug();

      const args = [
        "pr",
        "checks",
        String(pr_number),
        "--repo",
        repoSlug,
        "--json",
        "bucket,completedAt,description,event,link,name,startedAt,state,workflow",
      ];

      if (required_only) {
        args.push("--required");
      }

      const result =
        await runGhWithCode(args);

      const checks =
        parsePullRequestChecksResult(
          result,
          `PR #${pr_number} kontrol sorgusu`,
        );

      const counts = {
        pass: 0,
        fail: 0,
        pending: 0,
        skipping: 0,
        cancel: 0,
        other: 0,
      };

      for (const check of checks) {
        const bucket =
          String(check.bucket ?? "other");
        if (
          Object.hasOwn(
            counts,
            bucket,
          )
        ) {
          counts[bucket] += 1;
        } else {
          counts.other += 1;
        }
      }

      return textResult(
        [
          `PR #${pr_number} kontrol sayısı: ${checks.length}`,
          `Özet: pass=${counts.pass}, fail=${counts.fail}, pending=${counts.pending}, skipping=${counts.skipping}, cancel=${counts.cancel}, other=${counts.other}`,
          checks.length > 0
            ? checks
                .map(
                  (check) =>
                    [
                      `[${check.bucket}] ${check.name}`,
                      check.workflow
                        ? `workflow=${check.workflow}`
                        : "",
                      `state=${check.state}`,
                      check.description || "",
                      check.link || "",
                    ]
                      .filter(Boolean)
                      .join(" | "),
                )
                .join("\n")
            : "Kontrol bulunamadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(
        new Error(
          sanitizeGitNetworkOutput(
            error instanceof Error
              ? error.message
              : String(error),
          ),
        ),
      );
    }
  },
);

registerTextTool(
  "update_pull_request",
  {
    description:
      "Yalnızca main hedefli açık bir equinox/ pull request'in başlığını ve/veya açıklamasını beklenen HEAD SHA doğrulamasıyla günceller.",
    inputSchema: {
      pr_number: z
        .number()
        .int()
        .min(1),
      expected_head_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
        ),
      title: z
        .string()
        .min(5)
        .max(120)
        .optional(),
      body: z
        .string()
        .max(10_000)
        .optional(),
    },
    annotations: {
      title: "Pull request'i güncelle",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({
    pr_number,
    expected_head_sha,
    title,
    body,
  }) => {
    try {
      if (
        title === undefined &&
        body === undefined
      ) {
        throw new Error(
          "Başlık veya açıklamadan en az biri verilmelidir.",
        );
      }

      if (
        title !== undefined &&
        (
          title.trim() !== title ||
          title.includes("\n") ||
          title.includes("\r") ||
          title.includes("\0")
        )
      ) {
        throw new Error(
          "PR başlığı tek satır olmalı ve başında/sonunda boşluk bulunmamalı.",
        );
      }

      if (body?.includes("\0")) {
        throw new Error(
          "PR açıklaması NUL karakteri içeremez.",
        );
      }

      await assertGhAuthenticated();
      const repoSlug =
        await getGitHubRepoSlug();
      const expectedHead =
        expected_head_sha.toLowerCase();
      const before =
        await readPullRequestByNumber(
          repoSlug,
          pr_number,
        );

      assertSafeMutablePullRequest(
        before,
        expectedHead,
      );

      const args = [
        "pr",
        "edit",
        String(pr_number),
        "--repo",
        repoSlug,
      ];

      if (title !== undefined) {
        args.push(
          "--title",
          title,
        );
      }

      let input = "";

      if (body !== undefined) {
        args.push(
          "--body-file",
          "-",
        );
        input = body;
      }

      const result =
        await runGhWithCode(
          args,
          input,
        );

      if (result.code !== 0) {
        throw new Error(
          [
            "Pull request güncellenemedi.",
            sanitizeGitNetworkOutput(
              result.stderr ||
              result.stdout,
            ),
          ].join("\n"),
        );
      }

      const after =
        await readPullRequestByNumber(
          repoSlug,
          pr_number,
        );

      assertSafeMutablePullRequest(
        after,
        expectedHead,
      );

      if (
        title !== undefined &&
        after.title !== title
      ) {
        throw new Error(
          "PR güncellendi ancak başlık doğrulanamadı.",
        );
      }

      if (
        body !== undefined &&
        after.body !== body
      ) {
        throw new Error(
          "PR güncellendi ancak açıklama doğrulanamadı.",
        );
      }

      return textResult(
        [
          `PR #${after.number} güncellendi.`,
          `Başlık: ${after.title}`,
          `Adres: ${after.url}`,
          `Head: ${after.headRefName}`,
          `HEAD SHA: ${after.headRefOid}`,
          "Base branch değiştirilmedi; merge veya close yapılmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(
        new Error(
          sanitizeGitNetworkOutput(
            error instanceof Error
              ? error.message
              : String(error),
          ),
        ),
      );
    }
  },
);

registerTextTool(
  "set_pull_request_draft",
  {
    description:
      "Beklenen HEAD SHA ile doğrulanan açık equinox/ pull request'i draft veya review'a hazır duruma getirir.",
    inputSchema: {
      pr_number: z
        .number()
        .int()
        .min(1),
      expected_head_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
        ),
      draft: z.boolean(),
    },
    annotations: {
      title: "PR draft durumunu değiştir",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({
    pr_number,
    expected_head_sha,
    draft,
  }) => {
    try {
      await assertGhAuthenticated();
      const repoSlug =
        await getGitHubRepoSlug();
      const expectedHead =
        expected_head_sha.toLowerCase();
      const before =
        await readPullRequestByNumber(
          repoSlug,
          pr_number,
        );

      assertSafeMutablePullRequest(
        before,
        expectedHead,
      );

      if (before.isDraft === draft) {
        return textResult(
          `PR #${pr_number} zaten ${draft ? "draft" : "review'a hazır"} durumda.`,
        );
      }

      const args = [
        "pr",
        "ready",
        String(pr_number),
        "--repo",
        repoSlug,
      ];

      if (draft) {
        args.push("--undo");
      }

      const result =
        await runGhWithCode(args);

      if (result.code !== 0) {
        throw new Error(
          [
            "PR draft durumu değiştirilemedi.",
            sanitizeGitNetworkOutput(
              result.stderr ||
              result.stdout,
            ),
          ].join("\n"),
        );
      }

      const after =
        await readPullRequestByNumber(
          repoSlug,
          pr_number,
        );

      assertSafeMutablePullRequest(
        after,
        expectedHead,
      );

      if (after.isDraft !== draft) {
        throw new Error(
          "PR draft durumu değişti ancak doğrulanamadı.",
        );
      }

      return textResult(
        [
          `PR #${pr_number} durumu güncellendi.`,
          `Draft: ${after.isDraft ? "Evet" : "Hayır"}`,
          `Adres: ${after.url}`,
          `HEAD SHA: ${after.headRefOid}`,
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(
        new Error(
          sanitizeGitNetworkOutput(
            error instanceof Error
              ? error.message
              : String(error),
          ),
        ),
      );
    }
  },
);

registerTextTool(
  "close_pull_request",
  {
    description:
      "Beklenen HEAD SHA ile doğrulanan, main hedefli açık equinox/ pull request'i kapatır. Branch silmez ve merge yapmaz.",
    inputSchema: {
      pr_number: z
        .number()
        .int()
        .min(1),
      expected_head_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
        ),
      comment: z
        .string()
        .max(2000)
        .optional(),
    },
    annotations: {
      title: "Pull request'i kapat",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    pr_number,
    expected_head_sha,
    comment,
  }) => {
    try {
      if (comment?.includes("\0")) {
        throw new Error(
          "Kapanış yorumu NUL karakteri içeremez.",
        );
      }

      await assertGhAuthenticated();
      const repoSlug =
        await getGitHubRepoSlug();
      const expectedHead =
        expected_head_sha.toLowerCase();
      const before =
        await readPullRequestByNumber(
          repoSlug,
          pr_number,
        );

      assertSafeMutablePullRequest(
        before,
        expectedHead,
      );

      const args = [
        "pr",
        "close",
        String(pr_number),
        "--repo",
        repoSlug,
      ];

      if (
        comment &&
        comment.trim()
      ) {
        args.push(
          "--comment",
          comment.trim(),
        );
      }

      const result =
        await runGhWithCode(args);

      if (result.code !== 0) {
        throw new Error(
          [
            "Pull request kapatılamadı.",
            sanitizeGitNetworkOutput(
              result.stderr ||
              result.stdout,
            ),
          ].join("\n"),
        );
      }

      const after =
        await readPullRequestByNumber(
          repoSlug,
          pr_number,
        );

      if (
        after.state !== "CLOSED" ||
        String(after.headRefOid ?? "").toLowerCase() !== expectedHead
      ) {
        throw new Error(
          "PR kapatıldı ancak son durum veya HEAD SHA doğrulanamadı.",
        );
      }

      return textResult(
        [
          `PR #${after.number} kapatıldı.`,
          `Adres: ${after.url}`,
          `Head: ${after.headRefName}`,
          `HEAD SHA: ${after.headRefOid}`,
          "Branch silinmedi ve merge yapılmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(
        new Error(
          sanitizeGitNetworkOutput(
            error instanceof Error
              ? error.message
              : String(error),
          ),
        ),
      );
    }
  },
);

registerTextTool(
  "cleanup_work_branch",
  {
    description:
      "Aktif main ve temiz çalışma ağacında, açık PR'ı bulunmayan doğrulanmış equinox/ branch'ini yerelden ve isteğe bağlı olarak origin'dan siler. SHA uyuşmazlığında işlem yapmaz.",
    inputSchema: {
      slug: z
        .string()
        .regex(
          /^[a-z0-9][a-z0-9._-]{0,59}$/,
        ),
      expected_tip_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
        ),
      delete_remote: z
        .boolean()
        .default(true),
    },
    annotations: {
      title: "Çalışma branch'ini temizle",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    slug,
    expected_tip_sha,
    delete_remote,
  }) => {
    try {
      const expectedTip =
        expected_tip_sha.toLowerCase();
      const branch =
        validateEquinoxWorkBranch(
          `equinox/${slug}`,
        );

      await assertNoGitOperationInProgress();
      await assertCleanGitWorktree();

      const current =
        await getCurrentGitBranch();

      if (current !== "main") {
        throw new Error(
          [
            "Branch temizliği yalnızca aktif main branch'inde yapılabilir.",
            `Mevcut branch: ${current}`,
          ].join("\n"),
        );
      }

      const localTipResult =
        await runGitWithCode([
          "rev-parse",
          "--verify",
          `refs/heads/${branch}^{commit}`,
        ]);

      if (localTipResult.code !== 0) {
        throw new Error(
          `Yerel branch bulunamadı: ${branch}`,
        );
      }

      const localTip =
        localTipResult.stdout
          .trim()
          .toLowerCase();

      if (localTip !== expectedTip) {
        throw new Error(
          [
            "Yerel branch SHA uyuşmazlığı nedeniyle silme yapılmadı.",
            `Beklenen: ${expectedTip}`,
            `Mevcut:  ${localTip}`,
          ].join("\n"),
        );
      }

      await assertGhAuthenticated();
      const repoSlug =
        await getGitHubRepoSlug();

      const prListResult =
        await runGhWithCode([
          "pr",
          "list",
          "--repo",
          repoSlug,
          "--state",
          "all",
          "--head",
          branch,
          "--base",
          "main",
          "--limit",
          "20",
          "--json",
          "number,url,title,state,headRefName,headRefOid,baseRefName,mergedAt,closedAt",
        ]);

      if (prListResult.code !== 0) {
        throw new Error(
          "Branch'e bağlı PR durumu alınamadı.",
        );
      }

      const pullRequests =
        parseJsonOutput(
          prListResult.stdout,
          "Branch PR sorgusu",
        );

      if (!Array.isArray(pullRequests)) {
        throw new Error(
          "Branch PR sorgusu beklenen liste biçiminde değil.",
        );
      }

      const matching =
        pullRequests.filter(
          (pr) =>
            pr.headRefName === branch &&
            pr.baseRefName === "main" &&
            String(pr.headRefOid ?? "").toLowerCase() === expectedTip,
        );

      if (matching.length === 0) {
        throw new Error(
          "Beklenen branch ve SHA ile eşleşen bir PR bulunamadı; branch silinmedi.",
        );
      }

      const open =
        matching.find(
          (pr) => pr.state === "OPEN",
        );

      if (open) {
        throw new Error(
          [
            "Branch'e bağlı PR hâlâ açık; branch silinmedi.",
            `PR #${open.number}: ${open.url}`,
          ].join("\n"),
        );
      }

      const terminalPr =
        matching.find(
          (pr) =>
            pr.state === "MERGED" ||
            pr.state === "CLOSED",
        );

      if (!terminalPr) {
        throw new Error(
          "PR kapalı veya merge edilmiş durumda doğrulanamadı.",
        );
      }

      let remoteMessage =
        "Uzak branch korunarak yalnızca yerel branch silinecek.";

      if (delete_remote) {
        const remoteRef =
          `refs/heads/${branch}`;
        const remoteBefore =
          await runGitWithCode(
            [
              "ls-remote",
              "--quiet",
              "--exit-code",
              "--heads",
              "origin",
              remoteRef,
            ],
            60_000,
          );

        if (remoteBefore.code === 0) {
          const remoteTip =
            (
              remoteBefore.stdout
                .trim()
                .split(/\s+/)[0] ?? ""
            ).toLowerCase();

          if (remoteTip !== expectedTip) {
            throw new Error(
              [
                "Uzak branch SHA uyuşmazlığı nedeniyle silme yapılmadı.",
                `Beklenen: ${expectedTip}`,
                `Uzak:    ${remoteTip || "alınamadı"}`,
              ].join("\n"),
            );
          }

          const deleteResult =
            await runGitWithCode(
              [
                "push",
                "origin",
                "--delete",
                branch,
              ],
              120_000,
            );

          if (deleteResult.code !== 0) {
            throw new Error(
              [
                "Uzak branch silinemedi; yerel branch korunuyor.",
                sanitizeGitNetworkOutput(
                  deleteResult.stderr ||
                  deleteResult.stdout,
                ),
              ].join("\n"),
            );
          }

          remoteMessage =
            `Uzak branch silindi: origin/${branch}`;
        } else if (remoteBefore.code === 2) {
          remoteMessage =
            "Uzak branch zaten mevcut değildi.";
        } else {
          throw new Error(
            "Uzak branch durumu alınamadı; yerel branch korunuyor.",
          );
        }
      }

      const localDelete =
        await runGitWithCode([
          "branch",
          "-D",
          branch,
        ]);

      if (localDelete.code !== 0) {
        throw new Error(
          [
            "Uzak işlem tamamlanmış olabilir ancak yerel branch silinemedi.",
            localDelete.stderr.trim() ||
              localDelete.stdout.trim(),
          ].join("\n"),
        );
      }

      await runGitWithCode(
        [
          "fetch",
          "--prune",
          "--no-tags",
          "origin",
        ],
        120_000,
      );

      return textResult(
        [
          `Yerel branch silindi: ${branch}`,
          `Doğrulanan tip SHA: ${expectedTip}`,
          `İlişkili PR: #${terminalPr.number} (${terminalPr.state})`,
          `PR adresi: ${terminalPr.url}`,
          remoteMessage,
          "Aktif branch main olarak kaldı; main değiştirilmedi.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(
        new Error(
          sanitizeGitNetworkOutput(
            error instanceof Error
              ? error.message
              : String(error),
          ),
        ),
      );
    }
  },
);



const MAX_NPM_LOCKFILE_BYTES =
  5 * 1024 * 1024;

const NPM_PUBLIC_REGISTRY =
  "https://registry.npmjs.org/";

const NPM_MANIFEST_PATHS =
  Object.freeze([
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
  ]);

const NPM_SCRIPT_POLICY_SCHEMA = z
  .enum([
    "ignore",
    "approved",
  ])
  .default("ignore")
  .describe(
    "ignore: tüm kurulum lifecycle scriptlerini kapatır; approved: yalnızca package.json allowScripts politikasınca onaylanan scriptleri strict modda çalıştırır",
  );

function validateRegistryPackageName(
  packageName,
) {
  if (
    typeof packageName !== "string" ||
    packageName.trim() !== packageName ||
    packageName.length < 1 ||
    packageName.length > 214 ||
    /[\u0000-\u0020\u007f]/.test(
      packageName,
    )
  ) {
    throw new Error(
      "Geçersiz npm paket adı.",
    );
  }

  const simpleName =
    /^[a-z0-9][a-z0-9._-]*$/;

  const scopedName =
    /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

  if (
    !simpleName.test(packageName) &&
    !scopedName.test(packageName)
  ) {
    throw new Error(
      [
        `Yalnızca açık npm registry paket adları kabul edilir: ${packageName}`,
        "GitHub kısaltması, URL, dosya yolu, npm alias veya büyük harf kullanılamaz.",
      ].join("\n"),
    );
  }

  return packageName;
}

function validateRegistryVersionSelector(
  rawSelector = "latest",
) {
  if (
    typeof rawSelector !== "string" ||
    rawSelector.trim() !== rawSelector ||
    rawSelector.length < 1 ||
    rawSelector.length > 100 ||
    /[\u0000-\u001f\u007f]/.test(
      rawSelector,
    )
  ) {
    throw new Error(
      "Geçersiz npm sürüm veya dist-tag değeri.",
    );
  }

  if (
    rawSelector.includes("/") ||
    rawSelector.includes("\\") ||
    rawSelector.includes(":") ||
    rawSelector.includes("@") ||
    rawSelector.includes("#") ||
    /(?:^|\s)(?:file|git|git\+ssh|https?|ssh)(?:\s|$)/i.test(
      rawSelector,
    )
  ) {
    throw new Error(
      "Sürüm alanında URL, Git kaynağı, dosya yolu, alias veya özel protokol kullanılamaz.",
    );
  }

  if (
    !/^[A-Za-z0-9.*+^~<>=| _-]+$/.test(
      rawSelector,
    )
  ) {
    throw new Error(
      "Sürüm alanı yalnızca semver aralığı veya güvenli dist-tag içerebilir.",
    );
  }

  return rawSelector;
}

async function resolveNpmBinary() {
  const candidates = [
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
    "/usr/bin/npm",
  ];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Sıradaki bilinen yolu dene.
    }
  }

  throw new Error(
    "npm çalıştırılabilir dosyası bulunamadı.",
  );
}

function buildSafeNpmEnvironment({
  userConfigPath,
  globalConfigPath,
}) {
  const safeEnvironment = {};

  for (
    const [key, value]
    of Object.entries(process.env)
  ) {
    const upperKey =
      key.toUpperCase();

    if (
      upperKey.startsWith("NPM_") ||
      upperKey.startsWith("NPM_CONFIG_") ||
      upperKey.startsWith("GIT_") ||
      upperKey === "NODE_OPTIONS" ||
      upperKey === "NODE_PATH" ||
      upperKey === "NODE_AUTH_TOKEN" ||
      upperKey === "NPM_TOKEN" ||
      upperKey === "NPM_AUTH_TOKEN" ||
      upperKey === "GH_TOKEN" ||
      upperKey === "GITHUB_TOKEN"
    ) {
      continue;
    }

    safeEnvironment[key] = value;
  }

  return {
    ...safeEnvironment,
    PATH:
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    CI: "1",
    NO_COLOR: "1",
    CLICOLOR: "0",
    GIT_TERMINAL_PROMPT: "0",
    NPM_CONFIG_USERCONFIG:
      userConfigPath,
    NPM_CONFIG_GLOBALCONFIG:
      globalConfigPath,
    NPM_CONFIG_REGISTRY:
      NPM_PUBLIC_REGISTRY,
    NPM_CONFIG_UPDATE_NOTIFIER:
      "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_COLOR: "false",
  };
}

let npmVersionInfoPromise;

async function getSupportedNpmVersionInfo() {
  if (!npmVersionInfoPromise) {
    npmVersionInfoPromise =
      (async () => {
        const npmBinary =
          await resolveNpmBinary();

        let result;

        try {
          result = await execFile(
            npmBinary,
            ["--version"],
            {
              timeout: 30_000,
              maxBuffer:
                1024 * 1024,
              env: {
                PATH:
                  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
                NO_COLOR: "1",
              },
            },
          );
        } catch (error) {
          throw new Error(
            `npm sürümü alınamadı: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        const rawVersion =
          result.stdout.trim();

        const match =
          rawVersion.match(
            /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/,
          );

        if (!match) {
          throw new Error(
            `npm sürümü beklenen biçimde değil: ${rawVersion}`,
          );
        }

        const version = {
          raw: rawVersion,
          major:
            Number.parseInt(match[1], 10),
          minor:
            Number.parseInt(match[2], 10),
          patch:
            Number.parseInt(match[3], 10),
        };

        const supported =
          version.major > 11 ||
          (
            version.major === 11 &&
            version.minor >= 17
          );

        if (!supported) {
          throw new Error(
            [
              `Güvenli npm kaynak ve script politikaları için npm 11.17.0 veya üstü gerekli.`,
              `Mevcut sürüm: ${rawVersion}`,
            ].join("\n"),
          );
        }

        return version;
      })();
  }

  return npmVersionInfoPromise;
}

async function runNpmWithCode(
  args,
  timeoutMs = 300_000,
) {
  const npmBinary =
    await resolveNpmBinary();

  const temporaryConfigDirectory =
    await fs.mkdtemp(
      path.join(
        "/tmp",
        "equinox-npm-config-",
      ),
    );

  const userConfigPath =
    path.join(
      temporaryConfigDirectory,
      "user.npmrc",
    );

  const globalConfigPath =
    path.join(
      temporaryConfigDirectory,
      "global.npmrc",
    );

  try {
    await Promise.all([
      fs.writeFile(
        userConfigPath,
        "",
        { mode: 0o600 },
      ),
      fs.writeFile(
        globalConfigPath,
        "",
        { mode: 0o600 },
      ),
    ]);

    try {
      const {
        stdout = "",
        stderr = "",
      } = await execFile(
        npmBinary,
        args,
        {
          cwd: getActiveProjectRoot(),
          timeout: timeoutMs,
          maxBuffer:
            10 * 1024 * 1024,
          env:
            buildSafeNpmEnvironment({
              userConfigPath,
              globalConfigPath,
            }),
        },
      );

      return {
        code: 0,
        stdout:
          typeof stdout === "string"
            ? stdout
            : stdout.toString("utf8"),
        stderr:
          typeof stderr === "string"
            ? stderr
            : stderr.toString("utf8"),
      };
    } catch (error) {
      const stdout =
        typeof error?.stdout === "string"
          ? error.stdout
          : error?.stdout
            ? error.stdout.toString("utf8")
            : "";

      const stderr =
        typeof error?.stderr === "string"
          ? error.stderr
          : error?.stderr
            ? error.stderr.toString("utf8")
            : "";

      return {
        code:
          typeof error?.code === "number"
            ? error.code
            : 1,
        stdout,
        stderr:
          stderr ||
          (
            error instanceof Error
              ? error.message
              : String(error)
          ),
      };
    }
  } finally {
    await fs.rm(
      temporaryConfigDirectory,
      {
        recursive: true,
        force: true,
      },
    ).catch(() => {});
  }
}

function npmBaseNetworkArgs() {
  return [
    `--registry=${NPM_PUBLIC_REGISTRY}`,
    "--fund=false",
    "--color=false",
  ];
}

function npmRegistryOnlyArgs({
  allowRootDirectories = false,
} = {}) {
  return [
    `--allow-directory=${allowRootDirectories ? "root" : "none"}`,
    `--allow-file=${allowRootDirectories ? "root" : "none"}`,
    "--allow-git=none",
    "--allow-remote=none",
  ];
}

function npmInstallScriptArgs(
  scriptPolicy,
) {
  if (scriptPolicy === "ignore") {
    return [
      "--ignore-scripts=true",
    ];
  }

  if (scriptPolicy === "approved") {
    return [
      "--ignore-scripts=false",
      "--strict-allow-scripts=true",
      "--foreground-scripts=true",
    ];
  }

  throw new Error(
    `Bilinmeyen npm script politikası: ${scriptPolicy}`,
  );
}

async function pathExists(
  absolutePath,
) {
  try {
    await fs.lstat(absolutePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function assertNpmProjectCompatibility({
  requireLockfile = false,
} = {}) {
  await getSupportedNpmVersionInfo();

  const {
    packageJson,
  } = await readProjectPackageJson();

  const packageManager =
    typeof packageJson.packageManager ===
      "string"
      ? packageJson.packageManager.trim()
      : "";

  if (
    packageManager &&
    !packageManager.startsWith("npm@")
  ) {
    throw new Error(
      `Bu proje npm yerine başka bir packageManager tanımlıyor: ${packageManager}`,
    );
  }

  const root =
    getActiveProjectRoot();

  const localNpmrc =
    path.join(root, ".npmrc");

  if (await pathExists(localNpmrc)) {
    throw new Error(
      [
        "Proje kökünde .npmrc bulundu.",
        "Registry veya kimlik bilgisi yönlendirmesini körlemesine çalıştırmamak için yapılandırılmış npm araçları bu projede durduruldu.",
      ].join("\n"),
    );
  }

  const incompatibleLocks = [
    "yarn.lock",
    "pnpm-lock.yaml",
    "pnpm-lock.yml",
    "bun.lock",
    "bun.lockb",
  ];

  for (const fileName of incompatibleLocks) {
    if (
      await pathExists(
        path.join(root, fileName),
      )
    ) {
      throw new Error(
        `npm dışı lockfile bulundu: ${fileName}`,
      );
    }
  }

  const lockFiles = [];

  for (
    const fileName
    of [
      "package-lock.json",
      "npm-shrinkwrap.json",
    ]
  ) {
    const absolutePath =
      path.join(root, fileName);

    if (await pathExists(absolutePath)) {
      const stats =
        await fs.lstat(absolutePath);

      if (
        stats.isSymbolicLink() ||
        !stats.isFile()
      ) {
        throw new Error(
          `Lockfile normal dosya değil: ${fileName}`,
        );
      }

      if (
        stats.size >
        MAX_NPM_LOCKFILE_BYTES
      ) {
        throw new Error(
          `Lockfile 5 MB sınırını aşıyor: ${fileName}`,
        );
      }

      lockFiles.push(fileName);
    }
  }

  if (lockFiles.length > 1) {
    throw new Error(
      "Aynı projede hem package-lock.json hem npm-shrinkwrap.json bulundu.",
    );
  }

  if (
    requireLockfile &&
    lockFiles.length === 0
  ) {
    throw new Error(
      "Bu işlem için package-lock.json veya npm-shrinkwrap.json gerekli.",
    );
  }

  return {
    packageJson,
    packageManager:
      packageManager || "Belirtilmemiş",
    lockFile:
      lockFiles[0] ?? "Yok",
  };
}

async function assertNpmMutationState({
  requireWorkBranch = true,
} = {}) {
  await assertNoGitOperationInProgress();
  await assertCleanGitWorktree();

  const branch =
    await getCurrentGitBranch();

  if (
    requireWorkBranch &&
    !branch.startsWith("equinox/")
  ) {
    throw new Error(
      [
        "Paket manifesti yalnızca equinox/ çalışma branch'inde değiştirilebilir.",
        `Mevcut branch: ${branch}`,
      ].join("\n"),
    );
  }

  return branch;
}

async function snapshotNpmManifestFiles() {
  const snapshots =
    new Map();

  for (
    const relativePath
    of NPM_MANIFEST_PATHS
  ) {
    const absolutePath =
      path.join(
        getActiveProjectRoot(),
        relativePath,
      );

    try {
      const maxBytes =
        relativePath === "package.json"
          ? MAX_FILE_BYTES
          : MAX_NPM_LOCKFILE_BYTES;
      const { data: buffer, stat: stats } = await readBoundedNormalFile(absolutePath, {
        maxBytes,
        label: `npm manifest ${relativePath}`,
      });

      snapshots.set(
        relativePath,
        {
          exists: true,
          buffer,
          mode:
            stats.mode & 0o777,
        },
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        snapshots.set(
          relativePath,
          { exists: false },
        );
        continue;
      }

      throw error;
    }
  }

  return snapshots;
}

async function restoreNpmManifestFiles(
  snapshots,
) {
  const failures = [];

  for (
    const [relativePath, snapshot]
    of snapshots.entries()
  ) {
    const absolutePath =
      path.join(
        getActiveProjectRoot(),
        relativePath,
      );

    try {
      if (!snapshot.exists) {
        await fs.rm(
          absolutePath,
          { force: true },
        );
        continue;
      }

      const temporaryPath =
        `${absolutePath}.equinox-npm-restore-${process.pid}-${Date.now()}.tmp`;

      await fs.writeFile(
        temporaryPath,
        snapshot.buffer,
        {
          mode: snapshot.mode,
        },
      );

      await fs.rename(
        temporaryPath,
        absolutePath,
      );
    } catch (error) {
      failures.push(
        `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [
        "npm manifest geri yüklemesi tam tamamlanamadı.",
        ...failures,
      ].join("\n"),
    );
  }
}

async function getNpmManifestGitChanges() {
  const status =
    await runGitWithCode([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);

  if (status.code !== 0) {
    throw new Error(
      `npm sonrası Git durumu alınamadı: ${status.stderr.trim()}`,
    );
  }

  const changes =
    parsePorcelainStatus(
      status.stdout,
    );

  const allowed =
    new Set(
      NPM_MANIFEST_PATHS,
    );

  const unexpected =
    changes.filter(
      (change) =>
        !allowed.has(change.path),
    );

  if (unexpected.length > 0) {
    throw new Error(
      [
        "npm işlemi beklenmeyen proje dosyalarını değiştirdi.",
        ...unexpected.map(
          (change) =>
            `${change.status} ${change.path}`,
        ),
        "Bu dosyalar otomatik olarak silinmedi; git_status ve git_diff ile incele.",
      ].join("\n"),
    );
  }

  return changes;
}

function getDirectDependencyLocation(
  packageJson,
  packageName,
) {
  const sections = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];

  for (const section of sections) {
    if (
      packageJson[section] &&
      typeof packageJson[section] ===
        "object" &&
      !Array.isArray(
        packageJson[section],
      ) &&
      Object.prototype.hasOwnProperty.call(
        packageJson[section],
        packageName,
      )
    ) {
      return {
        section,
        value:
          String(
            packageJson[section][packageName],
          ),
      };
    }
  }

  return null;
}

function npmDependencySaveFlag(
  dependencyType,
) {
  const flags = {
    prod: "--save-prod",
    dev: "--save-dev",
    optional: "--save-optional",
    peer: "--save-peer",
  };

  const flag =
    flags[dependencyType];

  if (!flag) {
    throw new Error(
      `Bilinmeyen bağımlılık türü: ${dependencyType}`,
    );
  }

  return flag;
}

function formatNpmCommandFailure(
  heading,
  result,
) {
  return [
    heading,
    sanitizeGitNetworkOutput(
      result.stderr ||
      result.stdout,
    ) ||
      "npm ayrıntılı hata döndürmedi.",
  ].join("\n");
}

registerTextTool(
  "npm_project_info",
  {
    description:
      "Seçilen npm projesinin package manager, lockfile, bağımlılık, workspace ve kurulum script politikası bilgilerini salt okunur gösterir.",
    inputSchema: {},
    annotations: {
      title: "npm proje bilgisi",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const compatibility =
        await assertNpmProjectCompatibility();

      const npmVersion =
        await getSupportedNpmVersionInfo();

      const packageJson =
        compatibility.packageJson;

      const dependencySections = [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ];

      const counts =
        dependencySections.map(
          (section) => {
            const value =
              packageJson[section];

            const count =
              value &&
              typeof value === "object" &&
              !Array.isArray(value)
                ? Object.keys(value).length
                : 0;

            return `${section}: ${count}`;
          },
        );

      const allowScripts =
        packageJson.allowScripts;

      const allowScriptCount =
        allowScripts &&
        typeof allowScripts === "object" &&
        !Array.isArray(allowScripts)
          ? Object.keys(allowScripts).length
          : 0;

      const workspaces =
        Array.isArray(packageJson.workspaces)
          ? packageJson.workspaces.length
          : packageJson.workspaces &&
              typeof packageJson.workspaces === "object"
            ? Object.keys(packageJson.workspaces).length
            : 0;

      return textResult(
        [
          `Proje: ${getActiveProjectName()} (${getActiveProjectId()})`,
          `Paket: ${packageJson.name ?? "Adsız"}`,
          `Sürüm: ${packageJson.version ?? "Belirtilmemiş"}`,
          `packageManager: ${compatibility.packageManager}`,
          `npm sürümü: ${npmVersion.raw}`,
          `Lockfile: ${compatibility.lockFile}`,
          `Workspace tanımı: ${workspaces}`,
          `allowScripts kaydı: ${allowScriptCount}`,
          ...counts,
          "Yerel .npmrc: Yok",
          `Registry: ${NPM_PUBLIC_REGISTRY}`,
        ].join("\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "npm_view_package",
  {
    description:
      "Açık npm registry üzerindeki güvenli bir paket adı ve sürümünün temel metadatasını indirip gösterir; paket kurmaz.",
    inputSchema: {
      package: z
        .string()
        .min(1)
        .max(214)
        .describe(
          "Registry paket adı; örnek: astro veya @astrojs/sitemap",
        ),
      version: z
        .string()
        .min(1)
        .max(100)
        .default("latest")
        .describe(
          "Sürüm, semver aralığı veya dist-tag",
        ),
    },
    annotations: {
      title: "npm paket bilgisini görüntüle",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({
    package: packageName,
    version,
  }) => {
    try {
      validateRegistryPackageName(
        packageName,
      );

      const selector =
        validateRegistryVersionSelector(
          version,
        );

      const result =
        await runNpmWithCode(
          [
            "view",
            `${packageName}@${selector}`,
            "name",
            "version",
            "description",
            "license",
            "deprecated",
            "engines",
            "dist-tags",
            "--json",
            ...npmBaseNetworkArgs(),
          ],
          60_000,
        );

      if (result.code !== 0) {
        throw new Error(
          formatNpmCommandFailure(
            "npm paket bilgisi alınamadı.",
            result,
          ),
        );
      }

      let parsed;

      try {
        parsed = JSON.parse(
          result.stdout,
        );
      } catch {
        throw new Error(
          "npm view geçerli JSON döndürmedi.",
        );
      }

      return textResult(
        JSON.stringify(
          parsed,
          null,
          2,
        ),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "npm_outdated",
  {
    description:
      "Seçilen projenin doğrudan npm bağımlılıklarını registry ile karşılaştırır; hiçbir dosyayı değiştirmez.",
    inputSchema: {
      package: z
        .string()
        .min(1)
        .max(214)
        .optional()
        .describe(
          "İsteğe bağlı tek registry paket adı",
        ),
      include_transitive: z
        .boolean()
        .default(false)
        .describe(
          "Doğrudan bağımlılıkların yanında transitif bağımlılıkları da göster",
        ),
    },
    annotations: {
      title: "Güncel olmayan npm paketlerini göster",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({
    package: packageName,
    include_transitive,
  }) => {
    try {
      await assertNpmProjectCompatibility();

      const args = [
        "outdated",
      ];

      if (packageName) {
        validateRegistryPackageName(
          packageName,
        );
        args.push(packageName);
      }

      args.push(
        "--json",
        ...(include_transitive
          ? ["--all"]
          : []),
        ...npmBaseNetworkArgs(),
      );

      const result =
        await runNpmWithCode(
          args,
          120_000,
        );

      if (
        result.code !== 0 &&
        result.code !== 1
      ) {
        throw new Error(
          formatNpmCommandFailure(
            "npm outdated sorgusu başarısız.",
            result,
          ),
        );
      }

      let parsed = {};

      if (result.stdout.trim()) {
        try {
          parsed = JSON.parse(
            result.stdout,
          );
        } catch {
          throw new Error(
            "npm outdated geçerli JSON döndürmedi.",
          );
        }
      }

      const entries =
        Object.entries(parsed);

      if (entries.length === 0) {
        return textResult(
          "Güncel olmayan npm paketi bulunmadı.",
        );
      }

      return textResult(
        entries
          .sort(([a], [b]) =>
            a.localeCompare(b),
          )
          .map(
            ([name, info]) =>
              [
                `Paket: ${name}`,
                `Mevcut: ${info.current ?? "Bilinmiyor"}`,
                `İstenen aralıkta: ${info.wanted ?? "Bilinmiyor"}`,
                `Registry latest: ${info.latest ?? "Bilinmiyor"}`,
                `Tür: ${info.type ?? "Bilinmiyor"}`,
              ].join("\n"),
          )
          .join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "npm_audit",
  {
    description:
      "Seçilen projenin lockfile bağımlılıklarını npm audit ile salt okunur tarar. audit fix çalıştırmaz ve hiçbir dosyayı değiştirmez.",
    inputSchema: {
      audit_level: z
        .enum([
          "info",
          "low",
          "moderate",
          "high",
          "critical",
        ])
        .default("low")
        .describe(
          "npm audit çıkış eşiği; raporda tüm bulgular yine özetlenir",
        ),
      production_only: z
        .boolean()
        .default(false)
        .describe(
          "Dev bağımlılıklarını fiziksel audit kapsamından çıkar",
        ),
    },
    annotations: {
      title: "npm güvenlik denetimi",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({
    audit_level,
    production_only,
  }) => {
    try {
      await assertNpmProjectCompatibility({
        requireLockfile: true,
      });

      const args = [
        "audit",
        "--json",
        `--audit-level=${audit_level}`,
        ...(production_only
          ? ["--omit=dev"]
          : []),
        ...npmBaseNetworkArgs(),
      ];

      const result =
        await runNpmWithCode(
          args,
          120_000,
        );

      if (
        result.code !== 0 &&
        result.code !== 1
      ) {
        throw new Error(
          formatNpmCommandFailure(
            "npm audit çalıştırılamadı.",
            result,
          ),
        );
      }

      let report;

      try {
        report = JSON.parse(
          result.stdout,
        );
      } catch {
        throw new Error(
          "npm audit geçerli JSON döndürmedi.",
        );
      }

      const vulnerabilities =
        report?.metadata?.vulnerabilities ??
        {};

      const vulnerabilityEntries =
        report?.vulnerabilities &&
        typeof report.vulnerabilities ===
          "object"
          ? Object.entries(
              report.vulnerabilities,
            )
          : [];

      const details =
        vulnerabilityEntries
          .slice(0, 20)
          .map(
            ([name, info]) => {
              const fix =
                info?.fixAvailable === true
                  ? "Var"
                  : info?.fixAvailable
                    ? JSON.stringify(
                        info.fixAvailable,
                      )
                    : "Yok";

              return `- ${name}: ${info?.severity ?? "bilinmiyor"}; aralık ${info?.range ?? "?"}; düzeltme ${fix}`;
            },
          );

      return textResult(
        [
          `Audit çıkış kodu: ${result.code}`,
          `Eşik: ${audit_level}`,
          `Production only: ${production_only ? "Evet" : "Hayır"}`,
          `Info: ${vulnerabilities.info ?? 0}`,
          `Low: ${vulnerabilities.low ?? 0}`,
          `Moderate: ${vulnerabilities.moderate ?? 0}`,
          `High: ${vulnerabilities.high ?? 0}`,
          `Critical: ${vulnerabilities.critical ?? 0}`,
          `Toplam: ${vulnerabilities.total ?? 0}`,
          details.length > 0
            ? `İlk bulgular:\n${details.join("\n")}`
            : "Ayrıntılı güvenlik bulgusu yok.",
          vulnerabilityEntries.length > 20
            ? `[${vulnerabilityEntries.length - 20} ek bulgu kısaltıldı.]`
            : "",
          "npm audit fix çalıştırılmadı.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "npm_ci",
  {
    description:
      "Seçilen npm projesinde mevcut lockfile'a göre temiz ve dondurulmuş bağımlılık kurulumu yapar. package.json veya lockfile yazamaz; node_modules klasörünü yeniden oluşturabilir.",
    inputSchema: {
      script_policy:
        NPM_SCRIPT_POLICY_SCHEMA,
      timeout_seconds: z
        .number()
        .int()
        .min(30)
        .max(1800)
        .default(600)
        .describe(
          "npm ci zaman aşımı; en fazla 1800 saniye",
        ),
    },
    annotations: {
      title: "npm temiz bağımlılık kurulumu",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({
    script_policy,
    timeout_seconds,
  }) => {
    const startedAt = Date.now();

    try {
      await assertNpmProjectCompatibility({
        requireLockfile: true,
      });

      const branch =
        await assertNpmMutationState({
          requireWorkBranch:
            script_policy === "approved",
        });

      const result =
        await runNpmWithCode(
          [
            "ci",
            "--audit=false",
            ...npmBaseNetworkArgs(),
            ...npmRegistryOnlyArgs({
              allowRootDirectories: true,
            }),
            ...npmInstallScriptArgs(
              script_policy,
            ),
          ],
          timeout_seconds * 1000,
        );

      if (result.code !== 0) {
        throw new Error(
          formatNpmCommandFailure(
            "npm ci başarısız.",
            result,
          ),
        );
      }

      await assertCleanGitWorktree();

      const duration =
        (
          (Date.now() - startedAt) /
          1000
        ).toFixed(1);

      return textResult(
        [
          `npm ci başarılı (${duration} saniye).`,
          `Branch: ${branch}`,
          `Script politikası: ${script_policy}`,
          sanitizeGitNetworkOutput(
            [
              result.stdout,
              result.stderr,
            ]
              .filter(Boolean)
              .join("\n"),
          ) ||
            "npm herhangi bir çıktı üretmedi.",
          "package.json ve lockfile değişmedi; çalışma ağacı temiz.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "npm_install_package",
  {
    description:
      "Açık npm registry üzerindeki tek bir paketi seçilen equinox/ branch'inde ekler veya günceller. URL, Git, dosya, alias, global kurulum, force ve özel registry kabul etmez.",
    inputSchema: {
      package: z
        .string()
        .min(1)
        .max(214)
        .describe(
          "Registry paket adı",
        ),
      version: z
        .string()
        .min(1)
        .max(100)
        .default("latest")
        .describe(
          "Sürüm, semver aralığı veya dist-tag",
        ),
      dependency_type: z
        .enum([
          "prod",
          "dev",
          "optional",
          "peer",
        ])
        .default("prod")
        .describe(
          "package.json bağımlılık bölümü",
        ),
      exact: z
        .boolean()
        .default(true)
        .describe(
          "package.json içine tam çözülmüş sürümü kaydet",
        ),
      install_node_modules: z
        .boolean()
        .default(true)
        .describe(
          "Manifest ve lockfile güncellemesinden sonra npm ci çalıştır",
        ),
      script_policy:
        NPM_SCRIPT_POLICY_SCHEMA,
      timeout_seconds: z
        .number()
        .int()
        .min(30)
        .max(1800)
        .default(600),
    },
    annotations: {
      title: "npm paketi ekle veya güncelle",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    package: packageName,
    version,
    dependency_type,
    exact,
    install_node_modules,
    script_policy,
    timeout_seconds,
  }) => {
    let snapshots;
    let manifestsChanged = false;

    try {
      validateRegistryPackageName(
        packageName,
      );

      const selector =
        validateRegistryVersionSelector(
          version,
        );

      await assertNpmProjectCompatibility();

      const branch =
        await assertNpmMutationState({
          requireWorkBranch: true,
        });

      snapshots =
        await snapshotNpmManifestFiles();

      const manifestResult =
        await runNpmWithCode(
          [
            "install",
            `${packageName}@${selector}`,
            npmDependencySaveFlag(
              dependency_type,
            ),
            `--save-exact=${exact ? "true" : "false"}`,
            "--package-lock=true",
            "--package-lock-only=true",
            "--ignore-scripts=true",
            "--audit=false",
            ...npmBaseNetworkArgs(),
            ...npmRegistryOnlyArgs(),
          ],
          timeout_seconds * 1000,
        );

      if (manifestResult.code !== 0) {
        await restoreNpmManifestFiles(
          snapshots,
        );

        throw new Error(
          formatNpmCommandFailure(
            "npm paket manifesti güncellenemedi; manifest dosyaları geri yüklendi.",
            manifestResult,
          ),
        );
      }

      manifestsChanged = true;

      const changes =
        await getNpmManifestGitChanges();

      const updated =
        await readProjectPackageJson();

      const location =
        getDirectDependencyLocation(
          updated.packageJson,
          packageName,
        );

      const expectedSection = {
        prod: "dependencies",
        dev: "devDependencies",
        optional:
          "optionalDependencies",
        peer: "peerDependencies",
      }[dependency_type];

      if (
        !location ||
        location.section !==
          expectedSection
      ) {
        await restoreNpmManifestFiles(
          snapshots,
        );

        throw new Error(
          "npm paketi beklenen package.json bölümüne yazmadı; manifest dosyaları geri yüklendi.",
        );
      }

      let installOutput =
        "node_modules kurulumu istenmedi.";

      if (install_node_modules) {
        const ciResult =
          await runNpmWithCode(
            [
              "ci",
              "--audit=false",
              ...npmBaseNetworkArgs(),
              ...npmRegistryOnlyArgs({
                allowRootDirectories:
                  true,
              }),
              ...npmInstallScriptArgs(
                script_policy,
              ),
            ],
            timeout_seconds * 1000,
          );

        if (ciResult.code !== 0) {
          throw new Error(
            [
              "Paket manifesti ve lockfile güncellendi ancak npm ci tamamlanamadı.",
              "Değişiklikler geri alınmadı; git_diff ile inceleyebilir veya branch'i silebilirsin.",
              formatNpmCommandFailure(
                "npm ci hatası:",
                ciResult,
              ),
            ].join("\n"),
          );
        }

        installOutput =
          sanitizeGitNetworkOutput(
            [
              ciResult.stdout,
              ciResult.stderr,
            ]
              .filter(Boolean)
              .join("\n"),
          ) ||
          "npm ci çıktı üretmedi.";
      }

      const finalChanges =
        await getNpmManifestGitChanges();

      const diff =
        await runGitWithCode([
          "diff",
          "--no-ext-diff",
          "--stat",
          "--",
          ...NPM_MANIFEST_PATHS,
        ]);

      return textResult(
        [
          `npm paketi eklendi veya güncellendi: ${packageName}`,
          `Kaydedilen değer: ${location.value}`,
          `Bölüm: ${location.section}`,
          `Branch: ${branch}`,
          `Script politikası: ${script_policy}`,
          `Değişen manifest sayısı: ${finalChanges.length || changes.length}`,
          diff.stdout.trim()
            ? `Git özeti:\n${diff.stdout.trim()}`
            : "Git diff özeti boş.",
          installOutput,
          "Build otomatik çalıştırılmadı; run_project_script ile ayrıca doğrula.",
        ].join("\n\n"),
      );
    } catch (error) {
      if (
        snapshots &&
        !manifestsChanged
      ) {
        await restoreNpmManifestFiles(
          snapshots,
        ).catch(() => {});
      }

      return errorResult(error);
    }
  },
);

registerTextTool(
  "npm_remove_package",
  {
    description:
      "Seçilen equinox/ branch'inden tek bir doğrudan npm bağımlılığını kaldırır. npm ci ile node_modules ağacını isteğe bağlı yeniden kurar.",
    inputSchema: {
      package: z
        .string()
        .min(1)
        .max(214)
        .describe(
          "Kaldırılacak doğrudan registry paket adı",
        ),
      install_node_modules: z
        .boolean()
        .default(true),
      script_policy:
        NPM_SCRIPT_POLICY_SCHEMA,
      timeout_seconds: z
        .number()
        .int()
        .min(30)
        .max(1800)
        .default(600),
    },
    annotations: {
      title: "npm paketini kaldır",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    package: packageName,
    install_node_modules,
    script_policy,
    timeout_seconds,
  }) => {
    let snapshots;
    let manifestsChanged = false;

    try {
      validateRegistryPackageName(
        packageName,
      );

      const compatibility =
        await assertNpmProjectCompatibility();

      const existing =
        getDirectDependencyLocation(
          compatibility.packageJson,
          packageName,
        );

      if (!existing) {
        throw new Error(
          `Paket doğrudan bağımlılık olarak bulunamadı: ${packageName}`,
        );
      }

      const branch =
        await assertNpmMutationState({
          requireWorkBranch: true,
        });

      snapshots =
        await snapshotNpmManifestFiles();

      const manifestResult =
        await runNpmWithCode(
          [
            "uninstall",
            packageName,
            "--package-lock=true",
            "--package-lock-only=true",
            "--ignore-scripts=true",
            "--audit=false",
            ...npmBaseNetworkArgs(),
            ...npmRegistryOnlyArgs(),
          ],
          timeout_seconds * 1000,
        );

      if (manifestResult.code !== 0) {
        await restoreNpmManifestFiles(
          snapshots,
        );

        throw new Error(
          formatNpmCommandFailure(
            "npm paketi kaldırılamadı; manifest dosyaları geri yüklendi.",
            manifestResult,
          ),
        );
      }

      manifestsChanged = true;

      await getNpmManifestGitChanges();

      const updated =
        await readProjectPackageJson();

      if (
        getDirectDependencyLocation(
          updated.packageJson,
          packageName,
        )
      ) {
        await restoreNpmManifestFiles(
          snapshots,
        );

        throw new Error(
          "npm paketi package.json içinden kaldıramadı; manifest dosyaları geri yüklendi.",
        );
      }

      let installOutput =
        "node_modules kurulumu istenmedi.";

      if (install_node_modules) {
        const ciResult =
          await runNpmWithCode(
            [
              "ci",
              "--audit=false",
              ...npmBaseNetworkArgs(),
              ...npmRegistryOnlyArgs({
                allowRootDirectories:
                  true,
              }),
              ...npmInstallScriptArgs(
                script_policy,
              ),
            ],
            timeout_seconds * 1000,
          );

        if (ciResult.code !== 0) {
          throw new Error(
            [
              "Paket manifestten kaldırıldı ancak npm ci tamamlanamadı.",
              "Değişiklikler geri alınmadı; git_diff ile inceleyebilir veya branch'i silebilirsin.",
              formatNpmCommandFailure(
                "npm ci hatası:",
                ciResult,
              ),
            ].join("\n"),
          );
        }

        installOutput =
          sanitizeGitNetworkOutput(
            [
              ciResult.stdout,
              ciResult.stderr,
            ]
              .filter(Boolean)
              .join("\n"),
          ) ||
          "npm ci çıktı üretmedi.";
      }

      const finalChanges =
        await getNpmManifestGitChanges();

      const diff =
        await runGitWithCode([
          "diff",
          "--no-ext-diff",
          "--stat",
          "--",
          ...NPM_MANIFEST_PATHS,
        ]);

      return textResult(
        [
          `npm paketi kaldırıldı: ${packageName}`,
          `Önceki bölüm: ${existing.section}`,
          `Önceki değer: ${existing.value}`,
          `Branch: ${branch}`,
          `Script politikası: ${script_policy}`,
          `Değişen manifest sayısı: ${finalChanges.length}`,
          diff.stdout.trim()
            ? `Git özeti:\n${diff.stdout.trim()}`
            : "Git diff özeti boş.",
          installOutput,
          "Build otomatik çalıştırılmadı; run_project_script ile ayrıca doğrula.",
        ].join("\n\n"),
      );
    } catch (error) {
      if (
        snapshots &&
        !manifestsChanged
      ) {
        await restoreNpmManifestFiles(
          snapshots,
        ).catch(() => {});
      }

      return errorResult(error);
    }
  },
);


const ASSET_INBOX_CONFIGURED_ROOT =
  typeof process.env.HOME === "string" &&
  path.isAbsolute(process.env.HOME)
    ? path.join(
        process.env.HOME,
        "Equinox-Local-Inbox",
      )
    : null;

const MAX_INBOX_ASSET_BYTES =
  10 * 1024 * 1024;

const ALLOWED_INBOX_ASSET_EXTENSIONS =
  new Set([
    ".avif",
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".webp",
    ".woff",
    ".woff2",
  ]);

function formatAssetBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(
    bytes /
    (1024 * 1024)
  ).toFixed(2)} MB`;
}

async function sha256Buffer(buffer) {
  const { createHash } =
    await import("node:crypto");

  return createHash("sha256")
    .update(buffer)
    .digest("hex");
}

async function resolveAssetInboxRoot() {
  if (!ASSET_INBOX_CONFIGURED_ROOT) {
    throw new Error("Equinox Local aktarım klasörü için güvenilir mutlak HOME dizini gerekli.");
  }

  let rawStats;

  try {
    rawStats = await fs.lstat(
      ASSET_INBOX_CONFIGURED_ROOT,
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        [
          "Equinox Local aktarım klasörü bulunamadı.",
          `Beklenen yol: ${ASSET_INBOX_CONFIGURED_ROOT}`,
          "Kurulum betiğini yeniden çalıştır veya klasörü 700 izinleriyle oluştur.",
        ].join("\n"),
      );
    }

    throw error;
  }

  if (rawStats.isSymbolicLink()) {
    throw new Error(
      "Aktarım klasörü symlink olamaz.",
    );
  }

  if (!rawStats.isDirectory()) {
    throw new Error(
      "Aktarım yolu bir klasör değil.",
    );
  }

  if (
    typeof process.getuid === "function" &&
    rawStats.uid !== process.getuid()
  ) {
    throw new Error(
      "Aktarım klasörü mevcut kullanıcıya ait değil.",
    );
  }

  if ((rawStats.mode & 0o022) !== 0) {
    throw new Error(
      "Aktarım klasörü grup veya diğer kullanıcılar tarafından yazılabilir. İzinleri chmod 700 ile düzelt.",
    );
  }

  const realRoot = await fs.realpath(
    ASSET_INBOX_CONFIGURED_ROOT,
  );

  const resolvedStats =
    await fs.stat(realRoot);

  if (
    rawStats.dev !== resolvedStats.dev ||
    rawStats.ino !== resolvedStats.ino
  ) {
    throw new Error(
      "Aktarım klasörü doğrulama sırasında değişti.",
    );
  }

  return realRoot;
}

function validateInboxAssetName(
  requestedName,
) {
  if (
    typeof requestedName !== "string" ||
    requestedName.trim() !==
      requestedName ||
    requestedName.length < 1 ||
    requestedName.length > 220 ||
    requestedName.includes("/") ||
    requestedName.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(
      requestedName,
    ) ||
    requestedName === "." ||
    requestedName === ".." ||
    requestedName.startsWith(".")
  ) {
    throw new Error(
      "Aktarım dosyası doğrudan inbox kökünde bulunan güvenli bir dosya adı olmalı.",
    );
  }

  if (isSensitiveName(requestedName)) {
    throw new Error(
      "Hassas dosya adları aktarım inbox'ında işlenemez.",
    );
  }

  const extension =
    path.extname(
      requestedName,
    ).toLowerCase();

  if (
    !ALLOWED_INBOX_ASSET_EXTENSIONS.has(
      extension,
    )
  ) {
    throw new Error(
      [
        `Desteklenmeyen web varlığı türü: ${extension || "uzantısız"}`,
        "İzinli türler: PNG, JPG, JPEG, WebP, AVIF, GIF, ICO, SVG, WOFF ve WOFF2.",
      ].join("\n"),
    );
  }

  return {
    fileName: requestedName,
    extension,
  };
}

function bufferStartsWith(
  buffer,
  bytes,
) {
  if (buffer.length < bytes.length) {
    return false;
  }

  return bytes.every(
    (value, index) =>
      buffer[index] === value,
  );
}

function bufferAscii(
  buffer,
  start,
  end,
) {
  return buffer
    .subarray(start, end)
    .toString("ascii");
}

function validateSvgAsset(buffer) {
  let text;

  try {
    text = new TextDecoder(
      "utf-8",
      { fatal: true },
    ).decode(buffer);
  } catch {
    throw new Error(
      "SVG dosyası geçerli UTF-8 metni değil.",
    );
  }

  const normalized =
    text.replace(/^\uFEFF/, "").trimStart();

  if (
    !/^(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i.test(
      normalized,
    )
  ) {
    throw new Error(
      "Dosya geçerli bir SVG köküyle başlamıyor.",
    );
  }

  const forbidden = [
    /<script\b/i,
    /<foreignObject\b/i,
    /\son[a-z0-9_-]+\s*=/i,
    /javascript\s*:/i,
    /data\s*:\s*text\/html/i,
    /(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/)/i,
    /url\(\s*["']?\s*(?:https?:|\/\/)/i,
  ];

  for (const pattern of forbidden) {
    if (pattern.test(normalized)) {
      throw new Error(
        "SVG aktif kod veya dış ağ kaynağı içeriyor; güvenlik nedeniyle reddedildi.",
      );
    }
  }

  return {
    kind: "SVG",
    mime: "image/svg+xml",
    binary: false,
  };
}

function detectAndValidateAsset(
  buffer,
  extension,
) {
  if (buffer.length === 0) {
    throw new Error(
      "Boş dosya web varlığı olarak aktarılamaz.",
    );
  }

  switch (extension) {
    case ".png":
      if (
        !bufferStartsWith(
          buffer,
          [
            0x89,
            0x50,
            0x4e,
            0x47,
            0x0d,
            0x0a,
            0x1a,
            0x0a,
          ],
        )
      ) {
        break;
      }

      return {
        kind: "PNG",
        mime: "image/png",
        binary: true,
      };

    case ".jpg":
    case ".jpeg":
      if (
        !bufferStartsWith(
          buffer,
          [0xff, 0xd8, 0xff],
        )
      ) {
        break;
      }

      return {
        kind: "JPEG",
        mime: "image/jpeg",
        binary: true,
      };

    case ".gif": {
      const signature =
        bufferAscii(buffer, 0, 6);

      if (
        signature !== "GIF87a" &&
        signature !== "GIF89a"
      ) {
        break;
      }

      return {
        kind: "GIF",
        mime: "image/gif",
        binary: true,
      };
    }

    case ".webp":
      if (
        bufferAscii(buffer, 0, 4) !==
          "RIFF" ||
        bufferAscii(buffer, 8, 12) !==
          "WEBP"
      ) {
        break;
      }

      return {
        kind: "WebP",
        mime: "image/webp",
        binary: true,
      };

    case ".avif": {
      if (
        bufferAscii(buffer, 4, 8) !==
        "ftyp"
      ) {
        break;
      }

      const brands =
        bufferAscii(
          buffer,
          8,
          Math.min(
            buffer.length,
            40,
          ),
        );

      if (
        !brands.includes("avif") &&
        !brands.includes("avis")
      ) {
        break;
      }

      return {
        kind: "AVIF",
        mime: "image/avif",
        binary: true,
      };
    }

    case ".ico":
      if (
        !bufferStartsWith(
          buffer,
          [0x00, 0x00, 0x01, 0x00],
        )
      ) {
        break;
      }

      return {
        kind: "ICO",
        mime: "image/x-icon",
        binary: true,
      };

    case ".woff":
      if (
        bufferAscii(buffer, 0, 4) !==
        "wOFF"
      ) {
        break;
      }

      return {
        kind: "WOFF",
        mime: "font/woff",
        binary: true,
      };

    case ".woff2":
      if (
        bufferAscii(buffer, 0, 4) !==
        "wOF2"
      ) {
        break;
      }

      return {
        kind: "WOFF2",
        mime: "font/woff2",
        binary: true,
      };

    case ".svg":
      return validateSvgAsset(buffer);

    default:
      break;
  }

  throw new Error(
    `Dosya içeriği ${extension} uzantısının beklenen imzasıyla eşleşmiyor.`,
  );
}

async function inspectInboxAsset(
  requestedName,
) {
  const validated =
    validateInboxAssetName(
      requestedName,
    );

  const inboxRoot =
    await resolveAssetInboxRoot();

  const candidate =
    path.join(
      inboxRoot,
      validated.fileName,
    );

  if (
    path.dirname(candidate) !==
    inboxRoot
  ) {
    throw new Error(
      "Aktarım dosyası inbox kökünün dışına çıkıyor.",
    );
  }

  const initialStats =
    await fs.lstat(candidate);

  if (
    initialStats.isSymbolicLink() ||
    !initialStats.isFile()
  ) {
    throw new Error(
      "Aktarım kaynağı normal bir dosya olmalı; symlink veya klasör işlenemez.",
    );
  }

  if (
    initialStats.size >
    MAX_INBOX_ASSET_BYTES
  ) {
    throw new Error(
      "Web varlığı 10 MB aktarım sınırını aşıyor.",
    );
  }

  const realPath =
    await fs.realpath(candidate);

  if (
    path.dirname(realPath) !==
    inboxRoot
  ) {
    throw new Error(
      "Sembolik bağlantı üzerinden inbox dışına çıkış engellendi.",
    );
  }

  const buffer =
    await fs.readFile(realPath);

  const finalStats =
    await fs.lstat(candidate);

  if (
    finalStats.isSymbolicLink() ||
    !finalStats.isFile() ||
    initialStats.dev !==
      finalStats.dev ||
    initialStats.ino !==
      finalStats.ino ||
    initialStats.size !==
      finalStats.size ||
    initialStats.mtimeMs !==
      finalStats.mtimeMs
  ) {
    throw new Error(
      "Aktarım dosyası okunurken değişti; işlem durduruldu.",
    );
  }

  const detected =
    detectAndValidateAsset(
      buffer,
      validated.extension,
    );

  const sha256 =
    await sha256Buffer(buffer);

  return {
    inboxRoot,
    fileName:
      validated.fileName,
    extension:
      validated.extension,
    realPath,
    stats: finalStats,
    buffer,
    sha256,
    ...detected,
  };
}

function validateAssetDestination(
  requestedPath,
) {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.trim() !==
      requestedPath ||
    requestedPath.length < 1 ||
    requestedPath.length > 300 ||
    path.isAbsolute(requestedPath) ||
    requestedPath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(
      requestedPath,
    )
  ) {
    throw new Error(
      "Geçersiz veya güvensiz hedef dosya yolu.",
    );
  }

  const segments =
    requestedPath.split("/");

  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === "..",
    )
  ) {
    throw new Error(
      "Hedef yol boş, yinelenen veya üst dizine çıkan bölüm içeremez.",
    );
  }

  const allowedHiddenSegments =
    new Set([
      ".github",
      ".well-known",
    ]);

  for (const segment of segments) {
    if (
      segment.startsWith(".") &&
      !allowedHiddenSegments.has(
        segment,
      )
    ) {
      throw new Error(
        `Hedefte bu gizli yol kapalı: ${segment}`,
      );
    }

    if (
      IGNORED_DIRECTORIES.has(
        segment,
      ) ||
      isSensitiveName(segment)
    ) {
      throw new Error(
        `Bu hedef yol kapalı: ${segment}`,
      );
    }
  }

  const extension =
    path.extname(
      segments[
        segments.length - 1
      ],
    ).toLowerCase();

  if (
    !ALLOWED_INBOX_ASSET_EXTENSIONS.has(
      extension,
    )
  ) {
    throw new Error(
      "Hedef uzantı izin verilen web varlığı türlerinden biri olmalı.",
    );
  }

  const candidate =
    path.resolve(
      getActiveProjectRoot(),
      requestedPath,
    );

  if (!isInsideProject(candidate)) {
    throw new Error(
      "Hedef dosya proje kökünün dışına çıkıyor.",
    );
  }

  return {
    normalized:
      segments.join("/"),
    extension,
    candidate,
  };
}

function assertAssetExtensionCompatible(
  sourceExtension,
  destinationExtension,
) {
  const normalize = (extension) =>
    extension === ".jpg" ||
    extension === ".jpeg"
      ? "jpeg"
      : extension.slice(1);

  if (
    normalize(sourceExtension) !==
    normalize(destinationExtension)
  ) {
    throw new Error(
      [
        "Kaynak ve hedef uzantıları aynı varlık türünü göstermiyor.",
        `Kaynak: ${sourceExtension}`,
        `Hedef: ${destinationExtension}`,
      ].join("\n"),
    );
  }
}

registerTextTool(
  "list_asset_inbox",
  {
    description:
      "Mac'teki sabit Equinox-Local-Inbox klasöründe bulunan desteklenen web varlıklarını tür, boyut ve SHA-256 özetiyle listeler. Proje dosyalarına dokunmaz.",
    inputSchema: {
      max_results: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(50),
    },
    annotations: {
      title: "Aktarım inbox'ını listele",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ max_results }) => {
    try {
      const inboxRoot =
        await resolveAssetInboxRoot();

      const entries =
        await fs.readdir(
          inboxRoot,
          { withFileTypes: true },
        );

      const candidates =
        entries
          .filter(
            (entry) =>
              entry.isFile() &&
              !entry.isSymbolicLink() &&
              !entry.name.startsWith("."),
          )
          .sort((a, b) =>
            a.name.localeCompare(
              b.name,
            ),
          )
          .slice(0, max_results);

      const rows = [];

      for (const entry of candidates) {
        try {
          const inspected =
            await inspectInboxAsset(
              entry.name,
            );

          rows.push(
            [
              inspected.fileName,
              inspected.kind,
              formatAssetBytes(
                inspected.stats.size,
              ),
              inspected.sha256,
            ].join(" | "),
          );
        } catch (error) {
          rows.push(
            `${entry.name} | REDDEDİLDİ | ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return textResult(
        [
          `Inbox: ${inboxRoot}`,
          `İzinler: yalnızca mevcut kullanıcı yazabilir`,
          rows.length > 0
            ? rows.join("\n")
            : "Desteklenen aktarım dosyası bulunamadı.",
          entries.length >
          candidates.length
            ? "Liste sonuç sınırı veya desteklenmeyen/gizli öğeler nedeniyle tüm girişleri göstermeyebilir."
            : "Kaynak dosyalar listelenirken değiştirilmedi.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
  { projectAware: false },
);

registerTextTool(
  "inspect_inbox_asset",
  {
    description:
      "Equinox-Local-Inbox içindeki tek bir web varlığının dosya imzasını, MIME türünü, boyutunu ve SHA-256 özetini doğrular.",
    inputSchema: {
      file: z
        .string()
        .min(1)
        .max(220)
        .describe(
          "Inbox kökündeki doğrudan dosya adı",
        ),
    },
    annotations: {
      title: "Inbox varlığını doğrula",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ file }) => {
    try {
      const inspected =
        await inspectInboxAsset(file);

      return textResult(
        [
          `Dosya: ${inspected.fileName}`,
          `Tür: ${inspected.kind}`,
          `MIME: ${inspected.mime}`,
          `Boyut: ${formatAssetBytes(inspected.stats.size)} (${inspected.stats.size} bayt)`,
          `SHA-256: ${inspected.sha256}`,
          inspected.extension === ".svg"
            ? "SVG aktif kod ve dış kaynak kontrollerinden geçti."
            : "Dosya uzantısı ile ikili imzası eşleşiyor.",
          "Dosyada değişiklik yapılmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
  { projectAware: false },
);

registerTextTool(
  "delete_inbox_asset",
  {
    description:
      "Equinox-Local-Inbox içindeki tek bir doğrulanmış web varlığını yalnızca beklenen SHA-256 özeti güncel içerikle eşleşirse siler. Proje dosyalarına dokunmaz.",
    inputSchema: {
      file: z
        .string()
        .min(1)
        .max(220)
        .describe(
          "Inbox kökündeki doğrudan dosya adı",
        ),
      expected_sha256: z
        .string()
        .regex(
          /^[a-fA-F0-9]{64}$/,
          "SHA-256 tam olarak 64 onaltılık karakter olmalı.",
        )
        .describe(
          "inspect_inbox_asset veya list_asset_inbox tarafından döndürülen özet",
        ),
    },
    annotations: {
      title: "Inbox varlığını sil",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({
    file,
    expected_sha256,
  }) => {
    try {
      const inspected =
        await inspectInboxAsset(file);

      const expected =
        expected_sha256.toLowerCase();

      if (inspected.sha256 !== expected) {
        throw new Error(
          [
            "Inbox varlığı SHA-256 uyuşmazlığı nedeniyle silinmedi.",
            `Beklenen: ${expected}`,
            `Mevcut:  ${inspected.sha256}`,
          ].join("\n"),
        );
      }

      const finalStats =
        await fs.lstat(
          inspected.realPath,
        );

      if (
        finalStats.isSymbolicLink() ||
        !finalStats.isFile() ||
        finalStats.dev !==
          inspected.stats.dev ||
        finalStats.ino !==
          inspected.stats.ino ||
        finalStats.size !==
          inspected.stats.size ||
        finalStats.mtimeMs !==
          inspected.stats.mtimeMs
      ) {
        throw new Error(
          "Inbox varlığı silme öncesinde değişti; işlem durduruldu.",
        );
      }

      await fs.unlink(
        inspected.realPath,
      );

      return textResult(
        [
          `Inbox varlığı silindi: ${inspected.fileName}`,
          `Tür: ${inspected.kind}`,
          `Boyut: ${formatAssetBytes(inspected.stats.size)}`,
          `Doğrulanan SHA-256: ${inspected.sha256}`,
          "Hiçbir proje dosyası değiştirilmedi.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
  { projectAware: false },
);

registerTextTool(
  "import_asset",
  {
    description:
      "Doğrulanmış bir web varlığını sabit Equinox-Local-Inbox klasöründen seçilen projedeki mevcut bir klasöre atomik olarak kopyalar. Varsayılan olarak üzerine yazmaz; mevcut dosya yalnızca SHA-256 doğrulamasıyla değiştirilebilir.",
    inputSchema: {
      inbox_file: z
        .string()
        .min(1)
        .max(220)
        .describe(
          "Inbox kökündeki doğrudan kaynak dosya adı",
        ),
      expected_sha256: z
        .string()
        .regex(
          /^[a-fA-F0-9]{64}$/,
          "Kaynak SHA-256 tam olarak 64 onaltılık karakter olmalı.",
        )
        .describe(
          "inspect_inbox_asset veya list_asset_inbox tarafından döndürülen kaynak özeti",
        ),
      destination: z
        .string()
        .min(1)
        .max(300)
        .describe(
          "Seçilen proje köküne göre hedef dosya yolu; üst klasör önceden mevcut olmalı",
        ),
      replace_existing: z
        .boolean()
        .default(false)
        .describe(
          "Mevcut temiz ve takipli hedef dosyayı değiştirmeye izin ver",
        ),
      expected_destination_sha256: z
        .string()
        .regex(
          /^[a-fA-F0-9]{64}$/,
          "Hedef SHA-256 tam olarak 64 onaltılık karakter olmalı.",
        )
        .optional()
        .describe(
          "replace_existing kullanılıyorsa file_hash aracından alınan mevcut hedef özeti",
        ),
    },
    annotations: {
      title: "Web varlığını projeye aktar",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({
    inbox_file,
    expected_sha256,
    destination,
    replace_existing,
    expected_destination_sha256,
  }) => {
    let temporaryPath;
    let replacementBackup;
    let writeCompleted = false;

    try {
      const expectedSourceHash =
        expected_sha256.toLowerCase();

      const source =
        await inspectInboxAsset(
          inbox_file,
        );

      if (
        source.sha256 !==
        expectedSourceHash
      ) {
        throw new Error(
          [
            "Kaynak SHA-256 uyuşmuyor; varlık aktarılmadı.",
            `Beklenen: ${expectedSourceHash}`,
            `Mevcut:  ${source.sha256}`,
          ].join("\n"),
        );
      }

      await assertNoGitOperationInProgress();

      const branch =
        await getCurrentGitBranch();

      if (
        !branch.startsWith(
          "equinox/",
        )
      ) {
        throw new Error(
          [
            "Web varlığı yalnızca equinox/ çalışma branch'inde içe aktarılabilir.",
            `Mevcut branch: ${branch}`,
          ].join("\n"),
        );
      }

      const target =
        validateAssetDestination(
          destination,
        );

      assertAssetExtensionCompatible(
        source.extension,
        target.extension,
      );

      const parentRelative =
        path.posix.dirname(
          target.normalized,
        );

      const parentPath =
        parentRelative === "."
          ? getActiveProjectRoot()
          : await safeResolve(
              parentRelative,
            );

      const parentStats =
        await fs.lstat(parentPath);

      if (
        parentStats.isSymbolicLink() ||
        !parentStats.isDirectory()
      ) {
        throw new Error(
          "Hedef üst yol normal bir klasör değil.",
        );
      }

      const destinationPath =
        path.join(
          parentPath,
          path.posix.basename(
            target.normalized,
          ),
        );

      if (!isInsideProject(destinationPath)) {
        throw new Error(
          "Hedef dosya proje dışına çıkıyor.",
        );
      }

      await assertPathNotIgnored(
        target.normalized,
      );

      let destinationExists = false;
      let destinationStats;

      try {
        destinationStats =
          await fs.lstat(
            destinationPath,
          );
        destinationExists = true;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      if (
        destinationExists &&
        !replace_existing
      ) {
        throw new Error(
          "Hedef dosya zaten mevcut; replace_existing verilmediği için üzerine yazılmadı.",
        );
      }

      if (
        !destinationExists &&
        replace_existing
      ) {
        throw new Error(
          "replace_existing istendi ancak hedef dosya mevcut değil.",
        );
      }

      if (
        destinationExists
      ) {
        if (
          destinationStats.isSymbolicLink() ||
          !destinationStats.isFile()
        ) {
          throw new Error(
            "Mevcut hedef normal bir dosya değil; değiştirilemez.",
          );
        }

        if (
          !expected_destination_sha256
        ) {
          throw new Error(
            "Mevcut hedefi değiştirmek için expected_destination_sha256 zorunlu.",
          );
        }

        const targetStatus =
          await runGitWithCode([
            "status",
            "--porcelain=v1",
            "--no-renames",
            "--",
            target.normalized,
          ]);

        if (targetStatus.code !== 0) {
          throw new Error(
            `Hedef Git durumu alınamadı: ${targetStatus.stderr.trim()}`,
          );
        }

        if (targetStatus.stdout.trim()) {
          throw new Error(
            [
              "Hedef dosyada önceden Git değişikliği var; değiştirme durduruldu.",
              targetStatus.stdout.trim(),
            ].join("\n"),
          );
        }

        const tracked =
          await runGitWithCode([
            "ls-files",
            "--error-unmatch",
            "--",
            target.normalized,
          ]);

        if (tracked.code !== 0) {
          throw new Error(
            "Mevcut hedef Git tarafından takip edilmiyor; güvenlik nedeniyle değiştirilemez.",
          );
        }

        if (
          destinationStats.size >
          MAX_INBOX_ASSET_BYTES
        ) {
          throw new Error(
            "Mevcut hedef 10 MB doğrulama sınırını aşıyor.",
          );
        }

        const destinationBuffer =
          await fs.readFile(
            destinationPath,
          );

        const destinationHash =
          await sha256Buffer(
            destinationBuffer,
          );

        if (
          destinationHash !==
          expected_destination_sha256.toLowerCase()
        ) {
          throw new Error(
            [
              "Mevcut hedef SHA-256 uyuşmuyor; dosya değiştirilmedi.",
              `Beklenen: ${expected_destination_sha256.toLowerCase()}`,
              `Mevcut:  ${destinationHash}`,
            ].join("\n"),
          );
        }

        replacementBackup = {
          path: destinationPath,
          buffer: destinationBuffer,
          mode:
            destinationStats.mode &
            0o777,
          dev: destinationStats.dev,
          ino: destinationStats.ino,
          size: destinationStats.size,
          mtimeMs:
            destinationStats.mtimeMs,
        };
      } else if (
        expected_destination_sha256
      ) {
        throw new Error(
          "Hedef mevcut değilken expected_destination_sha256 verilmemeli.",
        );
      }

      temporaryPath =
        path.join(
          parentPath,
          `.equinox-asset-${process.pid}-${Date.now()}.tmp`,
        );

      const temporaryHandle =
        await fs.open(
          temporaryPath,
          "wx",
          0o644,
        );

      try {
        await temporaryHandle.writeFile(
          source.buffer,
        );
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }

      if (destinationExists) {
        const finalDestinationStats =
          await fs.lstat(
            destinationPath,
          );

        if (
          finalDestinationStats.isSymbolicLink() ||
          !finalDestinationStats.isFile() ||
          finalDestinationStats.dev !==
            replacementBackup.dev ||
          finalDestinationStats.ino !==
            replacementBackup.ino ||
          finalDestinationStats.size !==
            replacementBackup.size ||
          finalDestinationStats.mtimeMs !==
            replacementBackup.mtimeMs
        ) {
          throw new Error(
            "Hedef dosya doğrulama sonrasında değişti; üzerine yazılmadı.",
          );
        }

        await fs.rename(
          temporaryPath,
          destinationPath,
        );
        temporaryPath = undefined;
        writeCompleted = true;
      } else {
        await fs.link(
          temporaryPath,
          destinationPath,
        );
        await fs.unlink(
          temporaryPath,
        );
        temporaryPath = undefined;
        writeCompleted = true;
      }

      const importedBuffer =
        await fs.readFile(
          destinationPath,
        );

      const importedHash =
        await sha256Buffer(
          importedBuffer,
        );

      if (
        importedHash !==
        source.sha256
      ) {
        throw new Error(
          "Aktarılan hedefin SHA-256 özeti kaynakla eşleşmiyor.",
        );
      }

      const status =
        await runGitWithCode([
          "status",
          "--short",
          "--",
          target.normalized,
        ]);

      if (status.code !== 0) {
        throw new Error(
          `Aktarım sonrası Git durumu alınamadı: ${status.stderr.trim()}`,
        );
      }

      writeCompleted = false;
      replacementBackup = undefined;

      return textResult(
        [
          `Web varlığı projeye aktarıldı: ${target.normalized}`,
          `Proje: ${getActiveProjectId()} (${getActiveProjectName()})`,
          `Branch: ${branch}`,
          `Kaynak: ${source.fileName}`,
          `Tür: ${source.kind} (${source.mime})`,
          `Boyut: ${formatAssetBytes(source.stats.size)}`,
          `Doğrulanan SHA-256: ${source.sha256}`,
          destinationExists
            ? "Mevcut temiz ve takipli hedef SHA doğrulamasıyla değiştirildi."
            : "Yeni dosya oluşturuldu; mevcut dosyanın üzerine yazılmadı.",
          status.stdout.trim()
            ? `Git durumu:\n${status.stdout.trim()}`
            : "Git durumu değişiklik göstermiyor.",
          `Inbox kaynağı korundu: ${source.inboxRoot}/${source.fileName}`,
          "Build otomatik çalıştırılmadı; run_project_script ile ayrıca doğrula.",
        ].join("\n\n"),
      );
    } catch (error) {
      if (
        writeCompleted &&
        replacementBackup
      ) {
        try {
          const rollbackTemporary =
            `${replacementBackup.path}.equinox-rollback-${process.pid}-${Date.now()}.tmp`;

          await fs.writeFile(
            rollbackTemporary,
            replacementBackup.buffer,
            {
              mode:
                replacementBackup.mode,
            },
          );

          await fs.rename(
            rollbackTemporary,
            replacementBackup.path,
          );
        } catch (rollbackError) {
          return errorResult(
            new Error(
              [
                error instanceof Error
                  ? error.message
                  : String(error),
                "UYARI: Değiştirilen hedef otomatik olarak geri yüklenemedi.",
                rollbackError instanceof Error
                  ? rollbackError.message
                  : String(rollbackError),
              ].join("\n"),
            ),
          );
        }
      } else if (writeCompleted) {
        await fs.rm(
          path.resolve(
            getActiveProjectRoot(),
            destination,
          ),
          { force: true },
        ).catch(() => {});
      }

      return errorResult(error);
    } finally {
      if (temporaryPath) {
        await fs.rm(
          temporaryPath,
          { force: true },
        ).catch(() => {});
      }
    }
  },
);


function parsePullRequestChecksResult(
  result,
  description,
) {
  const stdout = String(
    result?.stdout ?? "",
  ).trim();

  const stderr = String(
    result?.stderr ?? "",
  ).trim();

  const combinedOutput =
    `${stdout}\n${stderr}`
      .trim()
      .toLowerCase();

  /*
   * gh pr checks, PR üzerinde hiçbir kontrol
   * bulunmadığında bazı sürümlerde JSON yerine
   * boş stdout + "no checks reported" mesajı ve
   * sıfır olmayan çıkış kodu döndürüyor. Bu durum
   * bir sorgu hatası değil, geçerli boş listedir.
   *
   * stdout'ta JSON varsa çıkış kodu sıfır olmasa
   * bile önce JSON'u işleriz; başarısız veya bekleyen
   * kontrollerde gh sıfır olmayan kod döndürebilir.
   */
  if (!stdout) {
    if (
      Number(result?.code) === 0 ||
      combinedOutput.includes(
        "no checks reported",
      )
    ) {
      return [];
    }

    throw new Error(
      [
        `${description} okunamadı.`,
        sanitizeGitNetworkOutput(
          stderr ||
          "GitHub CLI boş çıktı döndürdü.",
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  let checks;

  try {
    checks = parseJsonOutput(
      stdout,
      description,
    );
  } catch (error) {
    throw new Error(
      [
        `${description} okunamadı.`,
        sanitizeGitNetworkOutput(
          stderr || stdout,
        ),
        error instanceof Error
          ? error.message
          : String(error),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (!Array.isArray(checks)) {
    throw new Error(
      "PR kontrol sorgusu beklenen liste biçiminde değil.",
    );
  }

  return checks;
}

async function readPullRequestChecksForMerge(
  repoSlug,
  prNumber,
) {
  const result =
    await runGhWithCode([
      "pr",
      "checks",
      String(prNumber),
      "--repo",
      repoSlug,
      "--json",
      "bucket,completedAt,description,event,link,name,startedAt,state,workflow",
    ]);

  return parsePullRequestChecksResult(
    result,
    `PR #${prNumber} merge kontrol sorgusu`,
  );
}

async function readWorkflowRunById(
  repoSlug,
  runId,
) {
  const result =
    await runGhWithCode([
      "run",
      "view",
      String(runId),
      "--repo",
      repoSlug,
      "--json",
      [
        "attempt",
        "conclusion",
        "createdAt",
        "databaseId",
        "displayTitle",
        "event",
        "headBranch",
        "headSha",
        "jobs",
        "name",
        "number",
        "startedAt",
        "status",
        "updatedAt",
        "url",
        "workflowDatabaseId",
        "workflowName",
      ].join(","),
    ]);

  if (result.code !== 0) {
    throw new Error(
      [
        `Workflow run ${runId} okunamadı.`,
        sanitizeGitNetworkOutput(
          result.stderr ||
          result.stdout,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const run = parseJsonOutput(
    result.stdout,
    `Workflow run ${runId} sorgusu`,
  );

  if (
    !run ||
    Number(run.databaseId) !==
      Number(runId)
  ) {
    throw new Error(
      "GitHub workflow sorgusu beklenen run kimliğini döndürmedi.",
    );
  }

  return run;
}

function normalizeWorkflowHeadSha(
  run,
) {
  const headSha = String(
    run?.headSha ?? "",
  ).toLowerCase();

  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(
      headSha,
    )
  ) {
    throw new Error(
      "Workflow run geçerli bir head SHA döndürmedi.",
    );
  }

  return headSha;
}

function formatWorkflowJobs(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return "Job bilgisi yok.";
  }

  return jobs
    .slice(0, 50)
    .map((job) => {
      const steps =
        Array.isArray(job.steps)
          ? job.steps
              .slice(0, 100)
              .map(
                (step) =>
                  `    - ${step.number ?? "?"}. ${step.name ?? "Adsız adım"}: ${step.status ?? "?"}/${step.conclusion ?? "-"}`,
              )
              .join("\n")
          : "";

      return [
        `- ${job.name ?? "Adsız job"} (#${job.databaseId ?? "?"}): ${job.status ?? "?"}/${job.conclusion ?? "-"}`,
        job.startedAt
          ? `  Başlangıç: ${job.startedAt}`
          : "",
        job.completedAt
          ? `  Bitiş: ${job.completedAt}`
          : "",
        job.url
          ? `  Adres: ${job.url}`
          : "",
        steps
          ? `  Adımlar:\n${steps}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

function delayMilliseconds(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

registerTextTool(
  "merge_pull_request",
  {
    description:
      "Seçilen GitHub deposunda yalnızca main hedefli, draft olmayan, SHA doğrulanmış ve kontrolleri başarılı bir equinox/ pull request'ini squash yöntemiyle merge eder. Admin, bypass, auto-merge veya branch silme kullanmaz.",
    inputSchema: {
      pr_number: z
        .number()
        .int()
        .min(1),
      expected_head_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          "Beklenen PR HEAD SHA 40 veya 64 onaltılık karakter olmalı.",
        ),
      expected_main_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          "Beklenen main SHA 40 veya 64 onaltılık karakter olmalı.",
        ),
      allow_no_checks: z
        .boolean()
        .default(false)
        .describe(
          "Repo hiç CI kontrolü raporlamıyorsa bilinçli olarak merge'e izin ver",
        ),
    },
    annotations: {
      title: "Pull request'i squash merge et",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    pr_number,
    expected_head_sha,
    expected_main_sha,
    allow_no_checks,
  }) => {
    let mergeCommandCompleted = false;

    try {
      const expectedHead =
        expected_head_sha.toLowerCase();
      const expectedMain =
        expected_main_sha.toLowerCase();

      await assertNoGitOperationInProgress();
      await assertCleanGitWorktree();

      const branch =
        await getCurrentGitBranch();

      if (branch !== "main") {
        throw new Error(
          [
            "PR merge işlemi yalnızca temiz yerel main branch'inde yapılabilir.",
            `Mevcut branch: ${branch}`,
          ].join("\n"),
        );
      }

      const localMain =
        await getExactHeadCommit();

      if (localMain !== expectedMain) {
        throw new Error(
          [
            "Yerel main SHA beklenen değerle uyuşmuyor.",
            `Beklenen: ${expectedMain}`,
            `Yerel:    ${localMain}`,
          ].join("\n"),
        );
      }

      const fetchMain =
        await runGitWithCode(
          [
            "fetch",
            "--no-tags",
            "origin",
            "refs/heads/main:refs/remotes/origin/main",
          ],
          120_000,
        );

      if (fetchMain.code !== 0) {
        throw new Error(
          [
            "Origin/main merge öncesinde yenilenemedi.",
            sanitizeGitNetworkOutput(
              fetchMain.stderr ||
              fetchMain.stdout,
            ),
          ].join("\n"),
        );
      }

      const remoteMainResult =
        await runGitWithCode([
          "rev-parse",
          "--verify",
          "refs/remotes/origin/main^{commit}",
        ]);

      const remoteMain =
        remoteMainResult.stdout
          .trim()
          .toLowerCase();

      if (
        remoteMainResult.code !== 0 ||
        remoteMain !== expectedMain
      ) {
        throw new Error(
          [
            "Origin/main SHA beklenen değerle uyuşmuyor; önce sync_main çalıştır.",
            `Beklenen: ${expectedMain}`,
            `Origin:   ${remoteMain || "alınamadı"}`,
          ].join("\n"),
        );
      }

      await assertGhAuthenticated();
      const repoSlug =
        await getGitHubRepoSlug();
      const pullRequest =
        await readPullRequestByNumber(
          repoSlug,
          pr_number,
        );

      assertSafeMutablePullRequest(
        pullRequest,
        expectedHead,
      );

      if (pullRequest.isDraft) {
        throw new Error(
          "Draft pull request merge edilemez. Önce set_pull_request_draft ile review'a hazır yap.",
        );
      }

      const baseOid = String(
        pullRequest.baseRefOid ?? "",
      ).toLowerCase();

      if (baseOid !== expectedMain) {
        throw new Error(
          [
            "PR base SHA beklenen main SHA ile uyuşmuyor.",
            `Beklenen: ${expectedMain}`,
            `GitHub:   ${baseOid || "alınamadı"}`,
          ].join("\n"),
        );
      }

      if (
        pullRequest.mergeable !==
        "MERGEABLE"
      ) {
        throw new Error(
          `PR şu anda merge edilebilir değil: ${pullRequest.mergeable}`,
        );
      }

      if (
        pullRequest.mergeStateStatus !==
        "CLEAN"
      ) {
        throw new Error(
          [
            "PR merge durumu CLEAN değil; otomatik merge yapılmadı.",
            `Merge state: ${pullRequest.mergeStateStatus}`,
          ].join("\n"),
        );
      }

      if (
        pullRequest.reviewDecision ===
        "CHANGES_REQUESTED"
      ) {
        throw new Error(
          "PR üzerinde değişiklik talebi var; merge yapılmadı.",
        );
      }

      const checks =
        await readPullRequestChecksForMerge(
          repoSlug,
          pr_number,
        );

      if (
        checks.length === 0 &&
        !allow_no_checks
      ) {
        throw new Error(
          "PR için hiçbir CI kontrolü raporlanmadı. Bilinçli merge için allow_no_checks: true kullan.",
        );
      }

      const blockingChecks =
        checks.filter((check) => {
          const bucket = String(
            check.bucket ?? "other",
          );

          return ![
            "pass",
            "skipping",
          ].includes(bucket);
        });

      if (blockingChecks.length > 0) {
        throw new Error(
          [
            "PR kontrollerinin tamamı başarılı değil; merge yapılmadı.",
            ...blockingChecks.map(
              (check) =>
                `- ${check.workflow ?? "Workflow"} / ${check.name ?? "Kontrol"}: ${check.bucket ?? "?"} (${check.state ?? "?"})`,
            ),
          ].join("\n"),
        );
      }

      /*
       * gh pr merge --match-head-commit seçeneği bazı
       * dağıtılmış gh sürümlerinde bulunmuyor. GitHub'ın
       * resmi REST merge endpoint'i aynı atomik korumayı
       * `sha` alanıyla sağlıyor: PR HEAD değişmişse istek
       * 409 Conflict ile reddediliyor.
       */
      const mergeRequestBody =
        JSON.stringify({
          sha: expectedHead,
          merge_method: "squash",
        });

      const mergeResult =
        await runGhWithCode(
          [
            "api",
            "--method",
            "PUT",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "X-GitHub-Api-Version: 2022-11-28",
            `repos/${repoSlug}/pulls/${pr_number}/merge`,
            "--input",
            "-",
          ],
          mergeRequestBody,
          180_000,
        );

      if (mergeResult.code !== 0) {
        throw new Error(
          [
            "Pull request squash merge edilemedi.",
            sanitizeGitNetworkOutput(
              mergeResult.stderr ||
              mergeResult.stdout,
            ) ||
              "GitHub API ayrıntılı hata döndürmedi.",
          ].join("\n"),
        );
      }

      const mergeResponse =
        parseJsonOutput(
          mergeResult.stdout,
          "GitHub merge yanıtı",
        );

      if (mergeResponse.merged !== true) {
        throw new Error(
          [
            "GitHub API merge işlemini tamamlamadı.",
            `Mesaj: ${mergeResponse.message ?? "Ayrıntı yok"}`,
          ].join("\n"),
        );
      }

      mergeCommandCompleted = true;

      const finalPullRequest =
        await readPullRequestByNumber(
          repoSlug,
          pr_number,
        );

      if (
        finalPullRequest.state !==
        "MERGED"
      ) {
        return textResult(
          [
            "GitHub merge komutunu kabul etti ancak PR henüz MERGED durumuna geçmedi.",
            `PR #${pr_number}: ${finalPullRequest.url}`,
            `Durum: ${finalPullRequest.state}`,
            `Merge state: ${finalPullRequest.mergeStateStatus}`,
            "Repo merge queue kullanıyor olabilir. Admin, bypass veya auto-merge kullanılmadı.",
          ].join("\n\n"),
        );
      }

      const mergeCommitResult =
        await runGhWithCode([
          "api",
          `repos/${repoSlug}/pulls/${pr_number}`,
          "--jq",
          ".merge_commit_sha // \"\"",
        ]);

      const mergeCommit =
        mergeCommitResult.code === 0
          ? mergeCommitResult.stdout.trim()
          : "";

      return textResult(
        [
          `Pull request squash merge edildi: #${pr_number}`,
          `Başlık: ${finalPullRequest.title}`,
          `Adres: ${finalPullRequest.url}`,
          `Base: ${finalPullRequest.baseRefName}`,
          `Head: ${finalPullRequest.headRefName}`,
          `Doğrulanan HEAD SHA: ${expectedHead}`,
          `Doğrulanan main SHA: ${expectedMain}`,
          `CI kontrol sayısı: ${checks.length}`,
          `Merge zamanı: ${finalPullRequest.mergedAt || "GitHub döndürmedi"}`,
          mergeCommit
            ? `Squash merge commit'i: ${mergeCommit}`
            : "Merge commit SHA ayrıca alınamadı.",
          "Admin, bypass, auto-merge, force veya branch silme kullanılmadı.",
          "Yerel main otomatik güncellenmedi; checkout_main ve sync_main ile ayrıca eşitle.",
        ].join("\n\n"),
      );
    } catch (error) {
      const message = sanitizeGitNetworkOutput(
        error instanceof Error
          ? error.message
          : String(error),
      );

      if (mergeCommandCompleted) {
        return textResult(
          [
            "GitHub merge komutu tamamlandı ancak son doğrulama adımlarından biri başarısız oldu.",
            message,
            "PR durumunu get_pull_request ile ayrıca doğrula.",
          ].join("\n\n"),
        );
      }

      return errorResult(
        new Error(message),
      );
    }
  },
);

registerTextTool(
  "list_workflow_runs",
  {
    description:
      "Seçilen GitHub deposundaki son GitHub Actions workflow çalıştırmalarını durum, sonuç, branch ve SHA bilgileriyle listeler.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20),
      branch: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe(
          "İsteğe bağlı main veya equinox/ branch filtresi",
        ),
      status: z
        .enum([
          "queued",
          "completed",
          "in_progress",
          "requested",
          "waiting",
          "pending",
          "action_required",
          "cancelled",
          "failure",
          "neutral",
          "skipped",
          "stale",
          "startup_failure",
          "success",
          "timed_out",
        ])
        .optional(),
      workflow: z
        .string()
        .min(1)
        .max(200)
        .optional(),
      commit_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          "Commit SHA 40 veya 64 onaltılık karakter olmalı.",
        )
        .optional(),
    },
    annotations: {
      title: "GitHub Actions çalıştırmalarını listele",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({
    limit,
    branch,
    status,
    workflow,
    commit_sha,
  }) => {
    try {
      if (branch) {
        if (
          branch !== "main" &&
          !/^equinox\/[a-z0-9][a-z0-9._-]{0,59}$/.test(
            branch,
          )
        ) {
          throw new Error(
            "Branch filtresi yalnızca main veya güvenli equinox/ branch'i olabilir.",
          );
        }
      }

      if (
        workflow &&
        (
          workflow.trim() !== workflow ||
          /[\u0000-\u001f\u007f]/.test(
            workflow,
          )
        )
      ) {
        throw new Error(
          "Workflow filtresi kontrol karakteri içeremez veya boşlukla başlayıp bitemez.",
        );
      }

      await assertGhAuthenticated();
      const repoSlug =
        await getGitHubRepoSlug();

      const args = [
        "run",
        "list",
        "--repo",
        repoSlug,
        "--limit",
        String(limit),
        "--json",
        "attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName",
      ];

      if (branch) {
        args.push(
          "--branch",
          branch,
        );
      }

      if (status) {
        args.push(
          "--status",
          status,
        );
      }

      if (workflow) {
        args.push(
          "--workflow",
          workflow,
        );
      }

      if (commit_sha) {
        args.push(
          "--commit",
          commit_sha.toLowerCase(),
        );
      }

      const result =
        await runGhWithCode(args);

      if (result.code !== 0) {
        throw new Error(
          [
            "Workflow çalıştırmaları listelenemedi.",
            sanitizeGitNetworkOutput(
              result.stderr ||
              result.stdout,
            ),
          ].join("\n"),
        );
      }

      const runs = parseJsonOutput(
        result.stdout,
        "Workflow run listesi",
      );

      if (!Array.isArray(runs)) {
        throw new Error(
          "Workflow run sorgusu beklenen liste biçiminde değil.",
        );
      }

      return textResult(
        [
          `Depo: ${repoSlug}`,
          `Workflow run sayısı: ${runs.length}`,
          runs.length > 0
            ? runs
                .map(
                  (run) =>
                    [
                      `#${run.databaseId} | ${run.workflowName || run.name || "Workflow"}`,
                      `Başlık: ${run.displayTitle || "-"}`,
                      `Durum: ${run.status || "?"}/${run.conclusion || "-"}`,
                      `Branch/SHA: ${run.headBranch || "-"} / ${run.headSha || "-"}`,
                      `Event: ${run.event || "-"}; attempt: ${run.attempt ?? "?"}`,
                      `Başlangıç: ${run.startedAt || run.createdAt || "-"}`,
                      `Adres: ${run.url || "-"}`,
                    ].join("\n"),
                )
                .join("\n\n")
            : "Eşleşen workflow run bulunamadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(
        new Error(
          sanitizeGitNetworkOutput(
            error instanceof Error
              ? error.message
              : String(error),
          ),
        ),
      );
    }
  },
);

registerTextTool(
  "get_workflow_run",
  {
    description:
      "Seçilen GitHub Actions workflow çalıştırmasının job ve adım durumlarını gösterir; istenirse yalnızca başarısız adımların loglarını getirir.",
    inputSchema: {
      run_id: z
        .number()
        .int()
        .min(1),
      include_failed_logs: z
        .boolean()
        .default(false),
    },
    annotations: {
      title: "GitHub Actions çalıştırmasını göster",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({
    run_id,
    include_failed_logs,
  }) => {
    try {
      await assertGhAuthenticated();
      const repoSlug =
        await getGitHubRepoSlug();
      const run =
        await readWorkflowRunById(
          repoSlug,
          run_id,
        );

      let failedLogs = "";

      if (include_failed_logs) {
        const logs =
          await runGhWithCode(
            [
              "run",
              "view",
              String(run_id),
              "--repo",
              repoSlug,
              "--log-failed",
            ],
            "",
            180_000,
          );

        failedLogs = sanitizeGitNetworkOutput(
          logs.stdout ||
          logs.stderr,
        );
      }

      return textResult(
        [
          `Workflow run: #${run.databaseId}`,
          `Workflow: ${run.workflowName || run.name || "-"}`,
          `Başlık: ${run.displayTitle || "-"}`,
          `Durum: ${run.status || "?"}/${run.conclusion || "-"}`,
          `Event: ${run.event || "-"}`,
          `Branch: ${run.headBranch || "-"}`,
          `HEAD SHA: ${run.headSha || "-"}`,
          `Attempt: ${run.attempt ?? "?"}`,
          `Başlangıç: ${run.startedAt || run.createdAt || "-"}`,
          `Güncellenme: ${run.updatedAt || "-"}`,
          `Adres: ${run.url || "-"}`,
          `Job'lar:\n${formatWorkflowJobs(run.jobs)}`,
          include_failed_logs
            ? `Başarısız adım logları:\n${failedLogs || "Başarısız adım logu bulunamadı."}`
            : "Başarısız loglar istenmedi.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(
        new Error(
          sanitizeGitNetworkOutput(
            error instanceof Error
              ? error.message
              : String(error),
          ),
        ),
      );
    }
  },
);

registerTextTool(
  "rerun_failed_workflow",
  {
    description:
      "SHA ve attempt değeri doğrulanan, tamamlanmış ve başarısız bir GitHub Actions run'ındaki yalnızca başarısız job'ları bağımlılıklarıyla yeniden çalıştırır. Debug modu kullanmaz.",
    inputSchema: {
      run_id: z
        .number()
        .int()
        .min(1),
      expected_head_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
        ),
      expected_attempt: z
        .number()
        .int()
        .min(1),
    },
    annotations: {
      title: "Başarısız workflow job'larını yeniden çalıştır",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    run_id,
    expected_head_sha,
    expected_attempt,
  }) => {
    try {
      await assertGhAuthenticated();
      const repoSlug =
        await getGitHubRepoSlug();
      const run =
        await readWorkflowRunById(
          repoSlug,
          run_id,
        );
      const headSha =
        normalizeWorkflowHeadSha(run);

      if (
        headSha !==
        expected_head_sha.toLowerCase()
      ) {
        throw new Error(
          [
            "Workflow HEAD SHA beklenen değerle uyuşmuyor.",
            `Beklenen: ${expected_head_sha.toLowerCase()}`,
            `GitHub:   ${headSha}`,
          ].join("\n"),
        );
      }

      if (
        Number(run.attempt) !==
        expected_attempt
      ) {
        throw new Error(
          [
            "Workflow attempt değeri değişmiş; yeniden çalıştırma yapılmadı.",
            `Beklenen: ${expected_attempt}`,
            `GitHub:   ${run.attempt}`,
          ].join("\n"),
        );
      }

      if (run.status !== "completed") {
        throw new Error(
          `Yalnızca tamamlanmış workflow yeniden çalıştırılabilir. Durum: ${run.status}`,
        );
      }

      if (
        ![
          "failure",
          "timed_out",
          "startup_failure",
        ].includes(run.conclusion)
      ) {
        throw new Error(
          `Yalnızca başarısız workflow run yeniden çalıştırılabilir. Sonuç: ${run.conclusion}`,
        );
      }

      const rerunResult =
        await runGhWithCode([
          "run",
          "rerun",
          String(run_id),
          "--repo",
          repoSlug,
          "--failed",
        ]);

      if (rerunResult.code !== 0) {
        throw new Error(
          [
            "Başarısız workflow job'ları yeniden başlatılamadı.",
            sanitizeGitNetworkOutput(
              rerunResult.stderr ||
              rerunResult.stdout,
            ),
          ].join("\n"),
        );
      }

      await delayMilliseconds(2000);

      let updatedRun;

      try {
        updatedRun =
          await readWorkflowRunById(
            repoSlug,
            run_id,
          );
      } catch {
        updatedRun = undefined;
      }

      return textResult(
        [
          `Workflow yeniden çalıştırma isteği gönderildi: #${run_id}`,
          `Workflow: ${run.workflowName || run.name || "-"}`,
          `Doğrulanan HEAD SHA: ${headSha}`,
          `Önceki attempt: ${expected_attempt}`,
          updatedRun
            ? `Güncel durum: ${updatedRun.status}/${updatedRun.conclusion || "-"}; attempt ${updatedRun.attempt}`
            : "Güncel run durumu henüz yeniden okunamadı.",
          "Yalnızca başarısız job'lar ve bağımlılıkları yeniden çalıştırıldı; debug modu kullanılmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(
        new Error(
          sanitizeGitNetworkOutput(
            error instanceof Error
              ? error.message
              : String(error),
          ),
        ),
      );
    }
  },
);

registerTextTool(
  "cancel_workflow_run",
  {
    description:
      "SHA ve attempt değeri doğrulanan aktif bir GitHub Actions workflow çalıştırmasına normal iptal isteği gönderir. Force cancel kullanmaz.",
    inputSchema: {
      run_id: z
        .number()
        .int()
        .min(1),
      expected_head_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
        ),
      expected_attempt: z
        .number()
        .int()
        .min(1),
    },
    annotations: {
      title: "Workflow çalıştırmasını iptal et",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    run_id,
    expected_head_sha,
    expected_attempt,
  }) => {
    try {
      await assertGhAuthenticated();
      const repoSlug =
        await getGitHubRepoSlug();
      const run =
        await readWorkflowRunById(
          repoSlug,
          run_id,
        );
      const headSha =
        normalizeWorkflowHeadSha(run);

      if (
        headSha !==
        expected_head_sha.toLowerCase()
      ) {
        throw new Error(
          "Workflow HEAD SHA beklenen değerle uyuşmuyor; iptal edilmedi.",
        );
      }

      if (
        Number(run.attempt) !==
        expected_attempt
      ) {
        throw new Error(
          "Workflow attempt değeri değişmiş; iptal edilmedi.",
        );
      }

      const cancellableStates =
        new Set([
          "queued",
          "in_progress",
          "requested",
          "waiting",
          "pending",
        ]);

      if (
        !cancellableStates.has(
          run.status,
        )
      ) {
        throw new Error(
          `Workflow aktif ve iptal edilebilir durumda değil: ${run.status}/${run.conclusion || "-"}`,
        );
      }

      const cancelResult =
        await runGhWithCode([
          "run",
          "cancel",
          String(run_id),
          "--repo",
          repoSlug,
        ]);

      if (cancelResult.code !== 0) {
        throw new Error(
          [
            "Workflow iptal isteği gönderilemedi.",
            sanitizeGitNetworkOutput(
              cancelResult.stderr ||
              cancelResult.stdout,
            ),
          ].join("\n"),
        );
      }

      let finalRun = run;

      for (
        let attempt = 0;
        attempt < 5;
        attempt += 1
      ) {
        await delayMilliseconds(2000);
        finalRun =
          await readWorkflowRunById(
            repoSlug,
            run_id,
          );

        if (
          !cancellableStates.has(
            finalRun.status,
          )
        ) {
          break;
        }
      }

      return textResult(
        [
          `Workflow iptal isteği gönderildi: #${run_id}`,
          `Workflow: ${run.workflowName || run.name || "-"}`,
          `Doğrulanan HEAD SHA: ${headSha}`,
          `Attempt: ${expected_attempt}`,
          `Önceki durum: ${run.status}/${run.conclusion || "-"}`,
          `Güncel durum: ${finalRun.status}/${finalRun.conclusion || "-"}`,
          "Force cancel kullanılmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(
        new Error(
          sanitizeGitNetworkOutput(
            error instanceof Error
              ? error.message
              : String(error),
          ),
        ),
      );
    }
  },
);

registerTextTool(
  "revert_commit",
  {
    description:
      "Temiz ve origin/main ile aynı yerel main üzerinden yeni bir equinox/ branch'i oluşturur; doğrulanan tek bir normal commit'in ters değişikliğini güvenli bir revert commit'i olarak kaydeder. Main'e doğrudan yazmaz, push veya PR oluşturmaz.",
    inputSchema: {
      commit_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          "Revert edilecek tam commit SHA gerekli.",
        ),
      expected_main_sha: z
        .string()
        .regex(
          /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          "Beklenen main SHA gerekli.",
        ),
      slug: z
        .string()
        .regex(
          /^[a-z0-9][a-z0-9._-]{0,59}$/,
          "Branch slug'ı küçük harf, rakam, nokta, tire veya alt çizgi kullanmalı.",
        ),
      title: z
        .string()
        .min(5)
        .max(72)
        .optional()
        .describe(
          "İsteğe bağlı tek satırlık revert commit başlığı",
        ),
    },
    annotations: {
      title: "Commit'i güvenli revert branch'inde geri al",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    commit_sha,
    expected_main_sha,
    slug,
    title,
  }) => {
    let branchCreated = false;
    let commitCompleted = false;
    const branchName =
      `equinox/${slug}`;

    const cleanupFailedRevert = async () => {
      const messages = [];

      const abort =
        await runGitWithCode([
          "revert",
          "--abort",
        ]);

      if (
        abort.code !== 0 &&
        !/no revert or cherry-pick in progress/i.test(
          `${abort.stderr}\n${abort.stdout}`,
        )
      ) {
        messages.push(
          `revert --abort: ${abort.stderr.trim() || abort.stdout.trim()}`,
        );
      }

      const cleanupStatus =
        await runGitWithCode([
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]);

      if (cleanupStatus.code !== 0) {
        messages.push(
          `cleanup status: ${cleanupStatus.stderr.trim() || cleanupStatus.stdout.trim()}`,
        );
        return messages;
      }

      if (cleanupStatus.stdout.trim()) {
        messages.push(
          [
            "Başarısız revert sonrasında çalışma ağacı temiz değil; eşzamanlı değişiklikleri silmemek için branch otomatik kaldırılmadı.",
            cleanupStatus.stdout.trim(),
          ].join("\n"),
        );
        return messages;
      }

      const checkout =
        await runGitWithCode([
          "checkout",
          "--no-guess",
          "main",
        ]);

      if (checkout.code !== 0) {
        messages.push(
          `checkout main: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
        );
        return messages;
      }

      const remove =
        await runGitWithCode([
          "branch",
          "-D",
          branchName,
        ]);

      if (remove.code !== 0) {
        messages.push(
          `branch cleanup: ${remove.stderr.trim() || remove.stdout.trim()}`,
        );
      }

      return messages;
    };

    try {
      if (title) {
        if (
          title.trim() !== title ||
          title.includes("\n") ||
          title.includes("\r") ||
          title.includes("\0")
        ) {
          throw new Error(
            "Revert commit başlığı tek satır olmalı ve başında/sonunda boşluk bulunmamalı.",
          );
        }
      }

      const expectedMain =
        expected_main_sha.toLowerCase();

      await assertNoGitOperationInProgress();
      await assertCleanGitWorktree();

      const currentBranch =
        await getCurrentGitBranch();

      if (currentBranch !== "main") {
        throw new Error(
          `Revert branch'i yalnızca main üzerinden oluşturulabilir. Mevcut branch: ${currentBranch}`,
        );
      }

      const localMain =
        await getExactHeadCommit();

      if (localMain !== expectedMain) {
        throw new Error(
          "Yerel main SHA beklenen değerle uyuşmuyor.",
        );
      }

      const fetchMain =
        await runGitWithCode(
          [
            "fetch",
            "--no-tags",
            "origin",
            "refs/heads/main:refs/remotes/origin/main",
          ],
          120_000,
        );

      if (fetchMain.code !== 0) {
        throw new Error(
          `Origin/main yenilenemedi: ${sanitizeGitNetworkOutput(fetchMain.stderr || fetchMain.stdout)}`,
        );
      }

      const remoteMainResult =
        await runGitWithCode([
          "rev-parse",
          "--verify",
          "refs/remotes/origin/main^{commit}",
        ]);

      if (
        remoteMainResult.code !== 0 ||
        remoteMainResult.stdout
          .trim()
          .toLowerCase() !==
          expectedMain
      ) {
        throw new Error(
          "Yerel main origin/main ile aynı değil; önce sync_main çalıştır.",
        );
      }

      const targetResult =
        await runGitWithCode([
          "rev-parse",
          "--verify",
          `${commit_sha}^{commit}`,
        ]);

      if (targetResult.code !== 0) {
        throw new Error(
          "Revert edilecek commit doğrulanamadı.",
        );
      }

      const targetCommit =
        targetResult.stdout
          .trim()
          .toLowerCase();

      if (
        targetCommit !==
        commit_sha.toLowerCase()
      ) {
        throw new Error(
          "Revert commit SHA çözümlemesi beklenen tam SHA ile uyuşmuyor.",
        );
      }

      const ancestor =
        await runGitWithCode([
          "merge-base",
          "--is-ancestor",
          targetCommit,
          "refs/heads/main",
        ]);

      if (ancestor.code !== 0) {
        throw new Error(
          "Revert edilecek commit mevcut main geçmişinin bir parçası değil.",
        );
      }

      const parentInfo =
        await runGitWithCode([
          "rev-list",
          "--parents",
          "-n",
          "1",
          targetCommit,
        ]);

      if (parentInfo.code !== 0) {
        throw new Error(
          "Commit parent bilgisi alınamadı.",
        );
      }

      const parentFields =
        parentInfo.stdout
          .trim()
          .split(/\s+/)
          .filter(Boolean);

      if (parentFields.length > 2) {
        throw new Error(
          "Merge commit'leri ilk revert_commit sürümünde desteklenmiyor.",
        );
      }

      const localExists =
        await runGitWithCode([
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branchName}`,
        ]);

      if (localExists.code === 0) {
        throw new Error(
          `Yerel branch zaten mevcut: ${branchName}`,
        );
      }

      if (localExists.code !== 1) {
        throw new Error(
          "Yerel revert branch kontrolü başarısız.",
        );
      }

      const remoteExists =
        await runGitWithCode(
          [
            "ls-remote",
            "--quiet",
            "--exit-code",
            "--heads",
            "origin",
            `refs/heads/${branchName}`,
          ],
          60_000,
        );

      if (remoteExists.code === 0) {
        throw new Error(
          `Origin üzerinde aynı isimli branch zaten mevcut: ${branchName}`,
        );
      }

      if (remoteExists.code !== 2) {
        throw new Error(
          `Uzak revert branch kontrolü başarısız: ${sanitizeGitNetworkOutput(remoteExists.stderr || remoteExists.stdout)}`,
        );
      }

      const checkout =
        await runGitWithCode([
          "checkout",
          "--no-guess",
          "--no-track",
          "-b",
          branchName,
        ]);

      if (checkout.code !== 0) {
        throw new Error(
          `Revert branch'i oluşturulamadı: ${checkout.stderr.trim() || checkout.stdout.trim()}`,
        );
      }

      branchCreated = true;

      const revertResult =
        await runGitWithCode(
          [
            "revert",
            "--no-commit",
            targetCommit,
          ],
          120_000,
        );

      if (revertResult.code !== 0) {
        throw new Error(
          [
            "Commit otomatik olarak revert edilemedi; çakışma oluşmuş olabilir.",
            revertResult.stderr.trim() ||
              revertResult.stdout.trim(),
          ].join("\n"),
        );
      }

      const status =
        await runGitWithCode([
          "status",
          "--porcelain=v1",
          "--no-renames",
          "-z",
          "--untracked-files=all",
        ]);

      if (status.code !== 0) {
        throw new Error(
          "Revert sonrası Git durumu alınamadı.",
        );
      }

      const changes =
        parsePorcelainStatus(
          status.stdout,
        );

      if (changes.length === 0) {
        throw new Error(
          "Revert işlemi değişiklik üretmedi.",
        );
      }

      if (changes.length > 100) {
        throw new Error(
          "Revert 100'den fazla dosyayı etkiliyor; güvenlik nedeniyle durduruldu.",
        );
      }

      const changedPaths = [
        ...new Set(
          changes.map(
            (change) =>
              change.path,
          ),
        ),
      ].sort();

      for (const change of changes) {
        if (
          change.status === "??" ||
          change.status[0] === " " ||
          change.status[1] !== " "
        ) {
          throw new Error(
            `Revert sonrasında beklenmeyen Git durumu: ${change.status} ${change.path}`,
          );
        }
      }

      for (const changedPath of changedPaths) {
        await assertSafeCommitPath(
          changedPath,
        );
      }

      const subjectResult =
        await runGitWithCode([
          "show",
          "-s",
          "--format=%s",
          targetCommit,
        ]);

      const originalSubject =
        subjectResult.code === 0
          ? subjectResult.stdout
              .replace(/\s+/g, " ")
              .trim()
          : targetCommit.slice(0, 12);

      const generatedTitle =
        `revert: ${originalSubject}`
          .slice(0, 72)
          .trimEnd();

      const commitTitle =
        title || generatedTitle;

      const commitResult =
        await runGitWithCode(
          [
            "commit",
            "-m",
            commitTitle,
            "-m",
            `Reverts commit ${targetCommit}.`,
          ],
          120_000,
        );

      if (commitResult.code !== 0) {
        throw new Error(
          [
            "Revert commit oluşturulamadı.",
            commitResult.stderr.trim() ||
              commitResult.stdout.trim(),
          ].join("\n"),
        );
      }

      commitCompleted = true;

      const revertCommit =
        await getExactHeadCommit();

      await assertCleanGitWorktree();

      return textResult(
        [
          `Revert branch'i oluşturuldu: ${branchName}`,
          `Geri alınan commit: ${targetCommit}`,
          `Revert commit'i: ${revertCommit}`,
          `Başlık: ${commitTitle}`,
          `Etkilenen dosya sayısı: ${changedPaths.length}`,
          `Dosyalar:\n${changedPaths.map((item) => `- ${item}`).join("\n")}`,
          "Main doğrudan değiştirilmedi; push veya PR oluşturulmadı.",
        ].join("\n\n"),
      );
    } catch (error) {
      const originalMessage =
        error instanceof Error
          ? error.message
          : String(error);

      if (
        branchCreated &&
        !commitCompleted
      ) {
        const cleanupMessages =
          await cleanupFailedRevert();

        if (cleanupMessages.length > 0) {
          return errorResult(
            new Error(
              [
                originalMessage,
                "UYARI: Başarısız revert branch'i tam temizlenemedi.",
                ...cleanupMessages,
              ].join("\n"),
            ),
          );
        }
      }

      if (commitCompleted) {
        return textResult(
          [
            "Revert commit oluşturuldu ancak son doğrulama adımlarından biri başarısız oldu.",
            `Branch: ${branchName}`,
            originalMessage,
            "Branch otomatik silinmedi; git_status ve git_head ile incele.",
          ].join("\n\n"),
        );
      }

      return errorResult(
        new Error(originalMessage),
      );
    }
  },
);

registerTextTool(
  "export_asset",
  {
    description:
      "Seçilen projedeki doğrulanmış bir PNG, JPG, WebP, AVIF, GIF, ICO, SVG, WOFF veya WOFF2 dosyasını SHA doğrulamasıyla Equinox-Local-Inbox köküne atomik biçimde kopyalar. Proje dosyasını değiştirmez.",
    inputSchema: {
      source_path: z
        .string()
        .min(1)
        .max(300),
      expected_sha256: z
        .string()
        .regex(
          /^[a-fA-F0-9]{64}$/,
          "Kaynak SHA-256 tam olarak 64 onaltılık karakter olmalı.",
        ),
      inbox_name: z
        .string()
        .min(1)
        .max(220)
        .optional(),
      replace_existing: z
        .boolean()
        .default(false),
      expected_inbox_sha256: z
        .string()
        .regex(
          /^[a-fA-F0-9]{64}$/,
        )
        .optional(),
    },
    annotations: {
      title: "Proje varlığını aktarım inbox'ına çıkar",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({
    source_path,
    expected_sha256,
    inbox_name,
    replace_existing,
    expected_inbox_sha256,
  }) => {
    let temporaryPath;
    let writeCompleted = false;
    let replacementBackup;
    let targetPath;

    try {
      const sourcePath =
        await safeResolve(
          source_path,
        );
      const rawSource =
        path.resolve(
          getActiveProjectRoot(),
          source_path,
        );
      const initialStats =
        await fs.lstat(rawSource);

      if (
        initialStats.isSymbolicLink() ||
        !initialStats.isFile()
      ) {
        throw new Error(
          "Dışa aktarılacak kaynak normal bir dosya olmalı.",
        );
      }

      const { data: sourceBuffer, stat: resolvedStats } = await readBoundedNormalFile(sourcePath, {
        maxBytes: MAX_INBOX_ASSET_BYTES,
        label: "Dışa aktarılacak web varlığı",
      });

      if (
        initialStats.dev !==
          resolvedStats.dev ||
        initialStats.ino !==
          resolvedStats.ino
      ) {
        throw new Error(
          "Kaynak dosya doğrulama sırasında değişti.",
        );
      }

      const sourceExtension =
        path.extname(
          source_path,
        ).toLowerCase();

      if (
        !ALLOWED_INBOX_ASSET_EXTENSIONS.has(
          sourceExtension,
        )
      ) {
        throw new Error(
          "Kaynak dosya desteklenen web varlığı türlerinden biri değil.",
        );
      }

      const detected =
        detectAndValidateAsset(
          sourceBuffer,
          sourceExtension,
        );
      const sourceHash =
        await sha256Buffer(
          sourceBuffer,
        );

      if (
        sourceHash !==
        expected_sha256.toLowerCase()
      ) {
        throw new Error(
          [
            "Kaynak SHA-256 uyuşmuyor; dışa aktarılmadı.",
            `Beklenen: ${expected_sha256.toLowerCase()}`,
            `Mevcut:  ${sourceHash}`,
          ].join("\n"),
        );
      }

      const finalStats =
        await fs.lstat(rawSource);

      if (
        finalStats.isSymbolicLink() ||
        !finalStats.isFile() ||
        finalStats.dev !==
          initialStats.dev ||
        finalStats.ino !==
          initialStats.ino ||
        finalStats.size !==
          initialStats.size ||
        finalStats.mtimeMs !==
          initialStats.mtimeMs
      ) {
        throw new Error(
          "Kaynak dosya okunurken değişti; dışa aktarım durduruldu.",
        );
      }

      const desiredName =
        inbox_name ||
        path.basename(
          source_path,
        );
      const validatedTarget =
        validateInboxAssetName(
          desiredName,
        );

      assertAssetExtensionCompatible(
        sourceExtension,
        validatedTarget.extension,
      );

      const inboxRoot =
        await resolveAssetInboxRoot();
      targetPath = path.join(
        inboxRoot,
        validatedTarget.fileName,
      );

      if (
        path.dirname(targetPath) !==
        inboxRoot
      ) {
        throw new Error(
          "Inbox hedefi aktarım klasörünün dışına çıkıyor.",
        );
      }

      let targetExists = false;

      try {
        await fs.lstat(targetPath);
        targetExists = true;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      if (
        targetExists &&
        !replace_existing
      ) {
        throw new Error(
          "Inbox hedefi zaten mevcut; replace_existing verilmediği için üzerine yazılmadı.",
        );
      }

      if (
        !targetExists &&
        replace_existing
      ) {
        throw new Error(
          "replace_existing istendi ancak inbox hedefi mevcut değil.",
        );
      }

      if (targetExists) {
        if (!expected_inbox_sha256) {
          throw new Error(
            "Mevcut inbox hedefini değiştirmek için expected_inbox_sha256 zorunlu.",
          );
        }

        const existing =
          await inspectInboxAsset(
            validatedTarget.fileName,
          );

        if (
          existing.sha256 !==
          expected_inbox_sha256.toLowerCase()
        ) {
          throw new Error(
            "Mevcut inbox hedefinin SHA-256 özeti beklenen değerle uyuşmuyor.",
          );
        }

        replacementBackup = {
          buffer: existing.buffer,
          mode:
            existing.stats.mode &
            0o777,
        };
      } else if (
        expected_inbox_sha256
      ) {
        throw new Error(
          "Inbox hedefi mevcut değilken expected_inbox_sha256 verilmemeli.",
        );
      }

      temporaryPath = path.join(
        inboxRoot,
        `.equinox-export-${process.pid}-${Date.now()}.tmp`,
      );

      const temporaryHandle =
        await fs.open(
          temporaryPath,
          "wx",
          0o644,
        );

      try {
        await temporaryHandle.writeFile(
          sourceBuffer,
        );
        await temporaryHandle.sync();
      } finally {
        await temporaryHandle.close();
      }

      if (targetExists) {
        await fs.rename(
          temporaryPath,
          targetPath,
        );
        temporaryPath = undefined;
        writeCompleted = true;
      } else {
        await fs.link(
          temporaryPath,
          targetPath,
        );
        await fs.unlink(
          temporaryPath,
        );
        temporaryPath = undefined;
        writeCompleted = true;
      }

      const exported =
        await inspectInboxAsset(
          validatedTarget.fileName,
        );

      if (
        exported.sha256 !==
        sourceHash
      ) {
        throw new Error(
          "Inbox'a aktarılan dosyanın SHA-256 özeti kaynakla eşleşmiyor.",
        );
      }

      writeCompleted = false;
      replacementBackup = undefined;

      return textResult(
        [
          `Web varlığı inbox'a aktarıldı: ${validatedTarget.fileName}`,
          `Proje: ${getActiveProjectId()} (${getActiveProjectName()})`,
          `Kaynak: ${displayPath(sourcePath)}`,
          `Tür: ${detected.kind} (${detected.mime})`,
          `Boyut: ${formatAssetBytes(resolvedStats.size)}`,
          `Doğrulanan SHA-256: ${sourceHash}`,
          targetExists
            ? "Mevcut inbox hedefi SHA doğrulamasıyla değiştirildi."
            : "Yeni inbox dosyası oluşturuldu.",
          "Proje dosyası değiştirilmedi veya silinmedi.",
        ].join("\n\n"),
      );
    } catch (error) {
      if (
        writeCompleted &&
        targetPath
      ) {
        if (replacementBackup) {
          try {
            const rollbackPath =
              `${targetPath}.equinox-rollback-${process.pid}-${Date.now()}.tmp`;

            await fs.writeFile(
              rollbackPath,
              replacementBackup.buffer,
              {
                mode:
                  replacementBackup.mode,
              },
            );
            await fs.rename(
              rollbackPath,
              targetPath,
            );
          } catch (rollbackError) {
            return errorResult(
              new Error(
                [
                  error instanceof Error
                    ? error.message
                    : String(error),
                  "UYARI: Değiştirilen inbox hedefi otomatik geri yüklenemedi.",
                  rollbackError instanceof Error
                    ? rollbackError.message
                    : String(rollbackError),
                ].join("\n"),
              ),
            );
          }
        } else {
          await fs.rm(
            targetPath,
            { force: true },
          ).catch(() => {});
        }
      }

      return errorResult(error);
    } finally {
      if (temporaryPath) {
        await fs.rm(
          temporaryPath,
          { force: true },
        ).catch(() => {});
      }
    }
  },
);


registerTextTool(
  "terminal_start",
  {
    description:
      "Seçilen proje içinde kalıcı bir gerçek PTY terminal oturumu başlatır. Zsh veya Bash etkileşimli çalışır; sonraki çağrılar terminal_write, terminal_read, terminal_resize ve terminal_stop ile yapılır.",
    inputSchema: {
      cwd: z
        .string()
        .default(".")
        .describe(
          "Proje köküne göre göreli başlangıç klasörü",
        ),
      shell: z
        .enum(["zsh", "bash"])
        .default("zsh"),
      cols: z
        .number()
        .int()
        .min(20)
        .max(400)
        .default(120),
      rows: z
        .number()
        .int()
        .min(5)
        .max(200)
        .default(30),
      label: z
        .string()
        .min(1)
        .max(80)
        .optional(),
    },
    annotations: {
      title: "PTY terminali başlat",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    cwd,
    shell,
    cols,
    rows,
    label,
  }) => {
    try {
      if (!AGENT_ACCESS.terminal) {
        throw new Error("Terminal erişimi Control Center'da kapalı.");
      }

      const resolvedCwd =
        await safeResolve(cwd);
      const stats =
        await fs.stat(resolvedCwd);

      if (!stats.isDirectory()) {
        throw new Error(
          "Terminal başlangıç yolu bir klasör değil.",
        );
      }

      const session =
        await terminalManager.start({
          projectId:
            getActiveProjectId(),
          projectName:
            getActiveProjectName(),
          cwd: resolvedCwd,
          shell:
            resolveTerminalShell(shell),
          shellArgs: ["-l"],
          env: {
            ...process.env,
            PATH:
              `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`,
            EQUINOX_PROJECT_ID:
              getActiveProjectId(),
            EQUINOX_PROJECT_ROOT:
              getActiveProjectRoot(),
          },
          cols,
          rows,
          label,
        });

      return terminalJsonResult({
        ok: true,
        message:
          "PTY terminal oturumu başlatıldı.",
        session,
        next:
          "Çıktıyı terminal_read ile oku; komut göndermek için terminal_write kullan.",
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "terminal_list",
  {
    description:
      "Equinox Local içindeki çalışan ve yakın zamanda kapanmış PTY terminal oturumlarını listeler.",
    inputSchema: {},
    annotations: {
      title: "PTY terminallerini listele",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () =>
    terminalJsonResult({
      sessions: terminalManager.list(),
    }),
  { projectAware: false },
);

registerTextTool(
  "terminal_read",
  {
    description:
      "Bir PTY terminal oturumunun yeni çıktısını kararlı cursor değeriyle okur. İsteğe bağlı olarak kısa süre yeni çıktı bekler ve ANSI kontrol kodlarını temizler.",
    inputSchema: {
      session_id: z
        .string()
        .min(1)
        .max(80),
      cursor: z
        .number()
        .int()
        .min(0)
        .optional(),
      max_chars: z
        .number()
        .int()
        .min(1)
        .max(120_000)
        .default(30_000),
      strip_ansi: z
        .boolean()
        .default(true),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(5_000)
        .default(0),
    },
    annotations: {
      title: "PTY terminal çıktısını oku",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({
    session_id,
    cursor,
    max_chars,
    strip_ansi,
    wait_ms,
  }) => {
    try {
      return terminalJsonResult(
        await terminalManager.read({
          sessionId: session_id,
          cursor,
          maxChars: max_chars,
          stripAnsiCodes: strip_ansi,
          waitMs: wait_ms,
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
  { projectAware: false },
);

registerTextTool(
  "terminal_write",
  {
    description:
      "Çalışan PTY terminaline metin ve isteğe bağlı özel tuş gönderir. Enter, Ctrl+C, Ctrl+D, Tab, Escape ve ok tuşlarını destekler.",
    inputSchema: {
      session_id: z
        .string()
        .min(1)
        .max(80),
      data: z
        .string()
        .max(100_000)
        .default(""),
      key: z
        .enum(TERMINAL_KEYS)
        .optional(),
    },
    annotations: {
      title: "PTY terminaline yaz",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ session_id, data, key }) => {
    try {
      if (!AGENT_ACCESS.terminal) {
        throw new Error("Terminal erişimi Control Center'da kapalı.");
      }

      return terminalJsonResult({
        ok: true,
        session: terminalManager.write({
          sessionId: session_id,
          data,
          key,
        }),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    projectAware: false,
    mutationScopes: ["global"],
  },
);

registerTextTool(
  "terminal_resize",
  {
    description:
      "Çalışan PTY terminalinin sütun ve satır ölçüsünü değiştirir.",
    inputSchema: {
      session_id: z
        .string()
        .min(1)
        .max(80),
      cols: z
        .number()
        .int()
        .min(20)
        .max(400),
      rows: z
        .number()
        .int()
        .min(5)
        .max(200),
    },
    annotations: {
      title: "PTY terminalini yeniden boyutlandır",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ session_id, cols, rows }) => {
    try {
      return terminalJsonResult({
        ok: true,
        session: terminalManager.resize({
          sessionId: session_id,
          cols,
          rows,
        }),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    projectAware: false,
    mutationScopes: ["global"],
  },
);

registerTextTool(
  "terminal_stop",
  {
    description:
      "Bir PTY terminal oturumunu ve ön plandaki sürecini durdurur. Normalde SIGHUP, gerekirse SIGKILL kullanır; kapanan kayıt isteğe bağlı silinebilir.",
    inputSchema: {
      session_id: z
        .string()
        .min(1)
        .max(80),
      force: z
        .boolean()
        .default(false),
      remove: z
        .boolean()
        .default(false),
    },
    annotations: {
      title: "PTY terminalini durdur",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ session_id, force, remove }) => {
    try {
      return terminalJsonResult({
        ok: true,
        session: await terminalManager.stop({
          sessionId: session_id,
          force,
          remove,
        }),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    projectAware: false,
    mutationScopes: ["global"],
  },
);


function processJsonResult(value) {
  return textResult(
    JSON.stringify(value, null, 2),
  );
}

registerTextTool(
  "process_start",
  {
    description:
      "Seçilen proje içinde PTY gerektirmeyen uzun süreli bir arka plan süreci başlatır. npm run dev, preview sunucuları, watcher'lar ve yerel servisler için kullanılır; stdout ve stderr process_logs ile cursor üzerinden okunur.",
    inputSchema: {
      command: z
        .string()
        .min(1)
        .max(500),
      args: z
        .array(
          z.string().max(2000),
        )
        .max(100)
        .default([]),
      cwd: z
        .string()
        .default(".")
        .describe(
          "Proje köküne göre göreli başlangıç klasörü",
        ),
      env: z
        .record(
          z.string().regex(
            /^[A-Za-z_][A-Za-z0-9_]*$/u,
          ),
          z.string().max(10_000),
        )
        .optional(),
      label: z
        .string()
        .min(1)
        .max(100)
        .optional(),
      expected_ports: z
        .array(
          z.number().int().min(1).max(65535),
        )
        .max(16)
        .default([]),
      startup_wait_ms: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .default(500),
    },
    annotations: {
      title: "Arka plan süreci başlat",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({
    command,
    args,
    cwd,
    env,
    label,
    expected_ports,
    startup_wait_ms,
  }) => {
    try {
      if (!AGENT_ACCESS.terminal) {
        throw new Error("Terminal ve süreç erişimi Control Center'da kapalı.");
      }

      const resolvedCwd =
        await safeResolve(cwd);
      const stats =
        await fs.stat(resolvedCwd);

      if (!stats.isDirectory()) {
        throw new Error(
          "Süreç başlangıç yolu bir klasör değil.",
        );
      }

      const processInfo =
        processManager.start({
          projectId:
            getActiveProjectId(),
          projectName:
            getActiveProjectName(),
          cwd: resolvedCwd,
          command,
          args,
          env: {
            ...process.env,
            PATH:
              `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`,
            EQUINOX_PROJECT_ID:
              getActiveProjectId(),
            EQUINOX_PROJECT_ROOT:
              getActiveProjectRoot(),
            ...(env ?? {}),
          },
          label,
          expectedPorts:
            expected_ports,
        });

      const initialLogs =
        await processManager.readLogs({
          processId:
            processInfo.processId,
          cursor: 0,
          maxChars: 20_000,
          stripAnsiCodes: true,
          waitMs: startup_wait_ms,
        });

      return processJsonResult({
        ok: true,
        message:
          "Arka plan süreci başlatıldı.",
        process: initialLogs.process,
        initialOutput:
          initialLogs.output,
        nextCursor:
          initialLogs.nextCursor,
        next:
          "Yeni çıktıyı process_logs ile nextCursor değerinden okumaya devam et.",
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "process_list",
  {
    description:
      "Equinox Local tarafından başlatılmış çalışan ve yakın zamanda kapanmış arka plan süreçlerini listeler.",
    inputSchema: {
      state: z
        .enum([
          "all",
          "running",
          "exited",
        ])
        .default("all"),
    },
    annotations: {
      title: "Arka plan süreçlerini listele",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ state }) => {
    const processes =
      processManager.list().filter(
        (item) =>
          state === "all" ||
          (state === "running"
            ? item.running
            : !item.running),
      );

    return processJsonResult({
      state,
      count: processes.length,
      processes,
    });
  },
  { projectAware: false },
);

registerTextTool(
  "process_logs",
  {
    description:
      "Yönetilen arka plan sürecinin birleştirilmiş stdout ve stderr çıktısını kararlı cursor değeriyle okur; isteğe bağlı olarak kısa süre yeni log bekler.",
    inputSchema: {
      process_id: z
        .string()
        .min(1)
        .max(80),
      cursor: z
        .number()
        .int()
        .min(0)
        .optional(),
      max_chars: z
        .number()
        .int()
        .min(1)
        .max(160_000)
        .default(40_000),
      strip_ansi: z
        .boolean()
        .default(true),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .default(0),
    },
    annotations: {
      title: "Arka plan süreci loglarını oku",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({
    process_id,
    cursor,
    max_chars,
    strip_ansi,
    wait_ms,
  }) => {
    try {
      return processJsonResult(
        await processManager.readLogs({
          processId: process_id,
          cursor,
          maxChars: max_chars,
          stripAnsiCodes: strip_ansi,
          waitMs: wait_ms,
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
  { projectAware: false },
);

registerTextTool(
  "process_stop",
  {
    description:
      "Equinox Local tarafından başlatılmış arka plan sürecini ve onun süreç grubunu durdurur. Önce SIGTERM, gerekirse SIGKILL kullanır; kapanan kayıt isteğe bağlı silinebilir.",
    inputSchema: {
      process_id: z
        .string()
        .min(1)
        .max(80),
      force: z
        .boolean()
        .default(false),
      remove: z
        .boolean()
        .default(false),
    },
    annotations: {
      title: "Arka plan sürecini durdur",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ process_id, force, remove }) => {
    try {
      return processJsonResult({
        ok: true,
        process: await processManager.stop({
          processId: process_id,
          force,
          remove,
        }),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    projectAware: false,
    mutationScopes: ["global"],
  },
);

async function inspectLocalPort({
  port,
  host = "127.0.0.1",
  timeoutMs = 1000,
} = {}) {
  const probe = await probeTcpPort({
    host,
    port,
    timeoutMs,
  });
  let listeners = [];
  let lsofError = null;

  try {
    const { stdout = "" } = await execFile(
      "/usr/sbin/lsof",
      [
        "-nP",
        `-iTCP:${port}`,
        "-sTCP:LISTEN",
        "-Fpcn",
      ],
      {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: "/usr/sbin:/usr/bin:/bin",
          LC_ALL: "C",
        },
      },
    );
    listeners = parseLsofFieldOutput(stdout);
  } catch (error) {
    if (error?.code !== 1) {
      lsofError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    probe,
    listeners,
    lsofError,
    managedProcesses: processManager.findByPort(port),
    suggestedUrl: `http://${host === "::1" ? "[::1]" : host}:${port}/`,
  };
}

registerTextTool(
  "port_status",
  {
    description:
      "Yerel loopback üzerindeki tek bir TCP portunun dinlenip dinlenmediğini ölçer; lsof ile dinleyen süreçleri ve Equinox Local tarafından o porta bağlanmış yönetilen süreçleri gösterir.",
    inputSchema: {
      port: z
        .number()
        .int()
        .min(1)
        .max(65535),
      host: z
        .enum([
          "127.0.0.1",
          "localhost",
          "::1",
        ])
        .default("127.0.0.1"),
      timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(5000)
        .default(1000),
    },
    annotations: {
      title: "Yerel TCP portunu denetle",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ port, host, timeout_ms }) => {
    try {
      return processJsonResult({
        ok: true,
        ...(await inspectLocalPort({
          port,
          host,
          timeoutMs: timeout_ms,
        })),
      });
    } catch (error) {
      return errorResult(error);
    }
  },
  { projectAware: false },
);


const VISUAL_NAME_PATTERN =
  /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const WORKTREE_BRANCH_PREFIX = "equinox/";

async function resolveExplicitProjectPathForRead(
  projectId,
  relativePath,
  {
    resolveContext = resolveProjectContext,
  } = {},
) {
  checkRequestedPath(relativePath);

  const context =
    await resolveContext(projectId);
  const candidate = path.resolve(
    context.rootRealPath,
    relativePath,
  );

  if (
    !isPathInsideRoot(
      context.rootRealPath,
      candidate,
    )
  ) {
    throw new Error(
      "İzinli proje kökü dışına çıkma girişimi engellendi.",
    );
  }

  const realCandidate =
    await fs.realpath(candidate);

  if (
    !isPathInsideRoot(
      context.rootRealPath,
      realCandidate,
    )
  ) {
    throw new Error(
      "Sembolik bağlantı üzerinden proje dışına çıkış engellendi.",
    );
  }

  return {
    context,
    absolutePath: realCandidate,
    relativePath:
      path.relative(
        context.rootRealPath,
        realCandidate,
      ) || ".",
  };
}

async function resolveBrowserUploadFile(
  rootId,
  relativePath,
) {
  checkRequestedPath(relativePath);

  if (
    relativePath === "." ||
    relativePath === ""
  ) {
    throw new Error(
      "Browser upload için normal bir dosya yolu gerekli.",
    );
  }

  const context =
    await resolveFileRootContext(rootId);
  const candidate = path.resolve(
    context.rootRealPath,
    relativePath,
  );

  if (
    !isPathInsideRoot(
      context.rootRealPath,
      candidate,
    )
  ) {
    throw new Error(
      "Browser upload dosyası izinli kökün dışına çıkıyor.",
    );
  }

  const candidateStats = await fs.lstat(candidate);
  if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) {
    throw new Error("Browser upload için normal ve symlink olmayan bir dosya gerekli.");
  }

  const realCandidate = await fs.realpath(candidate);
  if (
    !isPathInsideRoot(
      context.rootRealPath,
      realCandidate,
    )
  ) {
    throw new Error(
      "Browser upload dosyası sembolik bağlantı üzerinden izinli kökün dışına çıkıyor.",
    );
  }

  return Object.freeze({
    rootId,
    absolutePath: realCandidate,
    relativePath:
      path.relative(context.rootRealPath, realCandidate) || ".",
  });
}

async function resolveExplicitProjectPathForWrite(
  projectId,
  relativePath,
  {
    requirePng = false,
  } = {},
) {
  checkRequestedPath(relativePath);

  if (
    relativePath === "." ||
    relativePath === ""
  ) {
    throw new Error(
      "Proje kökü doğrudan hedef olarak kullanılamaz.",
    );
  }

  if (
    requirePng &&
    path.extname(relativePath).toLowerCase() !==
      ".png"
  ) {
    throw new Error(
      "Görsel regresyon çıktısı .png uzantılı olmalı.",
    );
  }

  const context =
    await resolveProjectContext(projectId);
  const candidate = path.resolve(
    context.rootRealPath,
    relativePath,
  );

  if (
    !isPathInsideRoot(
      context.rootRealPath,
      candidate,
    )
  ) {
    throw new Error(
      "İzinli proje kökü dışına yazma girişimi engellendi.",
    );
  }

  let ancestor = path.dirname(candidate);

  while (true) {
    try {
      const stats = await fs.lstat(ancestor);

      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory()
      ) {
        throw new Error(
          `Hedef üst yolu normal bir klasör değil: ${ancestor}`,
        );
      }

      const realAncestor =
        await fs.realpath(ancestor);

      if (
        !isPathInsideRoot(
          context.rootRealPath,
          realAncestor,
        )
      ) {
        throw new Error(
          "Hedef üst yolu sembolik bağlantıyla proje dışına çıkıyor.",
        );
      }

      break;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }

      const parent = path.dirname(ancestor);

      if (parent === ancestor) {
        throw new Error(
          "Hedef için mevcut güvenli üst klasör bulunamadı.",
        );
      }

      ancestor = parent;
    }
  }

  try {
    const existing = await fs.lstat(candidate);

    if (existing.isSymbolicLink()) {
      throw new Error(
        "Hedef sembolik bağlantı olamaz.",
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return {
    context,
    absolutePath: candidate,
    relativePath:
      path.relative(
        context.rootRealPath,
        candidate,
      ),
  };
}

async function ensureWorkspaceRuntimeDirectories() {
  const workspace =
    await resolveProjectContext(WORKSPACE_PROJECT_ID);
  const gitExcludePath = path.join(
    workspace.rootRealPath,
    ".git",
    "info",
    "exclude",
  );
  const ignoredEntries = [
    "/worktrees/",
    "/visual-regression/",
    "/workflows/",
    "/release-gates/",
    "/observability/",
    "/repairs/",
    "/recovery-policies/",
    "/janitor/",
    "/V4.0_OBSERVABILITY_SELF_HEALING_PLAN.md",
  ];

  let existing = "";

  try {
    existing = await fs.readFile(
      gitExcludePath,
      "utf8",
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const existingLines = new Set(
    existing
      .split(/\r?\n/u)
      .map((line) => line.trim()),
  );
  const missing = ignoredEntries.filter(
    (entry) => !existingLines.has(entry),
  );

  if (missing.length > 0) {
    await fs.mkdir(
      path.dirname(gitExcludePath),
      {
        recursive: true,
        mode: 0o755,
      },
    );

    const prefix =
      existing && !existing.endsWith("\n")
        ? "\n"
        : "";

    await fs.appendFile(
      gitExcludePath,
      `${prefix}${missing.join("\n")}\n`,
      { mode: 0o644 },
    );
  }

  const worktreeRoot = path.join(
    workspace.rootRealPath,
    "worktrees",
  );
  const visualRoot = path.join(
    workspace.rootRealPath,
    "visual-regression",
  );
  const browserScreenshotRoot = path.join(
    workspace.rootRealPath,
    "browser-screenshots",
  );
  const workflowRoot = path.join(
    workspace.rootRealPath,
    "workflows",
  );
  const releaseGateRoot = path.join(
    workspace.rootRealPath,
    "release-gates",
  );
  const observabilityRoot = path.join(
    workspace.rootRealPath,
    "observability",
  );
  const repairRoot = path.join(
    workspace.rootRealPath,
    "repairs",
  );
  const recoveryPolicyRoot = path.join(
    workspace.rootRealPath,
    "recovery-policies",
  );
  const janitorRoot = path.join(
    workspace.rootRealPath,
    "janitor",
  );

  await Promise.all([
    fs.mkdir(worktreeRoot, {
      recursive: true,
      mode: 0o755,
    }),
    fs.mkdir(visualRoot, {
      recursive: true,
      mode: 0o755,
    }),
    fs.mkdir(browserScreenshotRoot, {
      recursive: true,
      mode: 0o700,
    }),
    fs.mkdir(workflowRoot, {
      recursive: true,
      mode: 0o700,
    }),
    fs.mkdir(releaseGateRoot, {
      recursive: true,
      mode: 0o700,
    }),
    fs.mkdir(observabilityRoot, {
      recursive: true,
      mode: 0o700,
    }),
    fs.mkdir(repairRoot, {
      recursive: true,
      mode: 0o700,
    }),
    fs.mkdir(recoveryPolicyRoot, {
      recursive: true,
      mode: 0o700,
    }),
    fs.mkdir(janitorRoot, {
      recursive: true,
      mode: 0o700,
    }),
  ]);
  await fs.chmod(browserScreenshotRoot, 0o700).catch(() => {});
  await fs.chmod(workflowRoot, 0o700).catch(() => {});
  await fs.chmod(releaseGateRoot, 0o700).catch(() => {});
  await fs.chmod(observabilityRoot, 0o700).catch(() => {});
  await fs.chmod(repairRoot, 0o700).catch(() => {});
  await fs.chmod(recoveryPolicyRoot, 0o700).catch(() => {});
  await fs.chmod(janitorRoot, 0o700).catch(() => {});

  return {
    workspace,
    worktreeRoot,
    visualRoot,
    browserScreenshotRoot,
    workflowRoot,
    releaseGateRoot,
    observabilityRoot,
    repairRoot,
    recoveryPolicyRoot,
    janitorRoot,
  };
}

registerTextTool(
  "copy_between_projects",
  {
    description:
      "İzinli bir dosya kökünden Git projesine normal dosya veya klasör ağacını sembolik bağlantı ve hassas yol kontrolleriyle atomik olarak kopyalar; downloads yalnız kaynak olabilir.",
    inputSchema: {
      source_project:
        FILE_ROOT_ID_VALUE_SCHEMA,
      source_path: z
        .string()
        .min(1)
        .max(300),
      destination_project:
        PROJECT_ID_VALUE_SCHEMA,
      destination_path: z
        .string()
        .min(1)
        .max(300),
      replace_existing: z
        .boolean()
        .default(false),
      expected_destination_sha256: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/u)
        .optional(),
      max_files: z
        .number()
        .int()
        .min(1)
        .max(5000)
        .default(2000),
      max_megabytes: z
        .number()
        .int()
        .min(1)
        .max(512)
        .default(128),
    },
    annotations: {
      title: "Projeler arasında dosya kopyala",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({
    source_project,
    source_path,
    destination_project,
    destination_path,
    replace_existing,
    expected_destination_sha256,
    max_files,
    max_megabytes,
  }) => {
    try {
      if (
        source_project ===
        destination_project
      ) {
        throw new Error(
          "Bu araç farklı iki proje arasında aktarım içindir; aynı proje için move_file veya normal dosya araçlarını kullan.",
        );
      }

      const source =
        await resolveExplicitProjectPathForRead(
          source_project,
          source_path,
          {
            resolveContext: resolveFileRootContext,
          },
        );
      const destination =
        await resolveExplicitProjectPathForWrite(
          destination_project,
          destination_path,
        );

      const result = await copyProjectPath({
        sourcePath: source.absolutePath,
        destinationPath:
          destination.absolutePath,
        replaceExisting:
          replace_existing,
        expectedDestinationSha256:
          expected_destination_sha256,
        maxFiles: max_files,
        maxBytes:
          max_megabytes * 1024 * 1024,
        shouldRejectEntry: (name) =>
          IGNORED_DIRECTORIES.has(name) ||
          isSensitiveName(name),
      });

      return processJsonResult({
        ok: true,
        source: {
          project: source_project,
          path: source.relativePath,
        },
        destination: {
          project: destination_project,
          path: destination.relativePath,
        },
        result,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    projectAware: false,
    mutationScopes: ["global"],
  },
);

async function listProjectWorktrees(projectId) {
  const project = await resolveProjectContext(projectId);
  const result = await runGitWithCode(
    [
      "worktree",
      "list",
      "--porcelain",
    ],
    30_000,
    project.rootRealPath,
  );

  if (result.code !== 0) {
    throw new Error(
      result.stderr ||
      `Git worktree listesi alınamadı: ${projectId}`,
    );
  }

  const workspace = await resolveProjectContext(WORKSPACE_PROJECT_ID);
  return parseGitWorktreePorcelain(result.stdout).map((record) =>
    publicWorktreeRecord({
      record,
      workspaceRoot: workspace.rootRealPath,
    }),
  );
}

async function listActiveProjectWorktrees() {
  return listProjectWorktrees(getActiveProjectId());
}

async function listJanitorWorktrees() {
  const records = [];
  const projectIds = PROJECT_IDS.filter(
    (projectId) => PROJECT_DEFINITIONS[projectId]?.worktrees !== false,
  );

  for (const projectId of projectIds) {
    const projectRecords = await listProjectWorktrees(projectId);
    for (const record of projectRecords) {
      if (!record.managed && !record.prunable) {
        continue;
      }

      let pathExists = false;
      try {
        await fs.lstat(record.path);
        pathExists = true;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      const activeTerminal = terminalManager.list().some(
        (item) =>
          item.running &&
          pathExists &&
          isPathInsideRoot(record.path, item.cwd),
      );
      const activeProcess = processManager.list().some(
        (item) =>
          item.running &&
          pathExists &&
          isPathInsideRoot(record.path, item.cwd),
      );

      records.push({
        ...record,
        projectId,
        pathExists,
        activeTerminal,
        activeProcess,
      });
    }
  }

  return records;
}

async function pruneJanitorWorktrees(expectedCandidates) {
  const grouped = new Map();
  for (const candidate of expectedCandidates) {
    const items = grouped.get(candidate.projectId) ?? [];
    items.push(candidate);
    grouped.set(candidate.projectId, items);
  }

  const pruned = [];
  for (const [projectId, candidates] of grouped.entries()) {
    const project = await resolveProjectContext(projectId);
    const current = await listProjectWorktrees(projectId);
    const prunable = [];

    for (const record of current) {
      if (!record.prunable) {
        continue;
      }
      let pathExists = false;
      try {
        await fs.lstat(record.path);
        pathExists = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const activeTerminal = terminalManager.list().some(
        (item) => item.running && pathExists && isPathInsideRoot(record.path, item.cwd),
      );
      const activeProcess = processManager.list().some(
        (item) => item.running && pathExists && isPathInsideRoot(record.path, item.cwd),
      );
      prunable.push({ ...record, pathExists, activeTerminal, activeProcess });
    }

    if (prunable.some((item) => !item.managed)) {
      throw new Error(
        `Janitor ${projectId} reposunda unmanaged prunable worktree gördü; git worktree prune fail-closed reddedildi.`,
      );
    }
    if (prunable.some((item) => item.locked || item.pathExists || item.activeTerminal || item.activeProcess)) {
      throw new Error(
        `Janitor ${projectId} reposunda artık güvenli olmayan prunable worktree gördü; prune reddedildi.`,
      );
    }

    const expectedPaths = new Set(candidates.map((item) => item.workspaceRelativePath));
    const actualPaths = new Set(prunable.map((item) => item.workspaceRelativePath));
    if (
      expectedPaths.size !== actualPaths.size ||
      [...expectedPaths].some((item) => !actualPaths.has(item))
    ) {
      throw new Error(
        `Janitor ${projectId} worktree preview ile canlı prunable set uyuşmuyor; prune reddedildi.`,
      );
    }

    const result = await runGitWithCode(
      ["worktree", "prune", "--expire", "now"],
      30_000,
      project.rootRealPath,
    );
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `Git worktree prune başarısız: ${projectId}`);
    }

    const remaining = await listProjectWorktrees(projectId);
    for (const candidate of candidates) {
      const stillPresent = remaining.some(
        (item) => item.workspaceRelativePath === candidate.workspaceRelativePath,
      );
      if (stillPresent) {
        throw new Error(`Prunable worktree metadata temizlenemedi: ${candidate.workspaceRelativePath}`);
      }
      pruned.push(candidate.id);
    }
  }

  return { pruned };
}

registerTextTool(
  "worktree_list",
  {
    description:
      "Seçilen Git projesinin ana çalışma ağacını ve Equinox Local tarafından workspace altında yönetilen worktree kayıtlarını listeler.",
    inputSchema: {},
    annotations: {
      title: "Git worktree'lerini listele",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const worktrees =
        await listActiveProjectWorktrees();

      return processJsonResult({
        project: getActiveProjectId(),
        count: worktrees.length,
        managedCount:
          worktrees.filter(
            (item) => item.managed,
          ).length,
        worktrees,
        accessProject: WORKSPACE_PROJECT_ID,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
);

registerTextTool(
  "worktree_create",
  {
    description:
      "Seçilen temiz Git projesinde equinox/ branch'i oluşturarak Selene Workspace altında yönetilen ayrı bir worktree hazırlar. Ana çalışma ağacının aktif branch'ini değiştirmez.",
    inputSchema: {
      slug: z
        .string()
        .min(1)
        .max(60),
      base_ref: z
        .enum(["main", "current"])
        .default("main"),
    },
    annotations: {
      title: "Yönetilen Git worktree oluştur",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ slug, base_ref }) => {
    try {
      validateWorktreeSlug(slug);

      if (PROJECT_DEFINITIONS[getActiveProjectId()]?.worktrees === false) {
        throw new Error(
          `Bu proje için managed worktree kapalı: ${getActiveProjectId()}`,
        );
      }

      await assertNoGitOperationInProgress();
      await assertCleanGitWorktree();

      const {
        workspace,
      } = await ensureWorkspaceRuntimeDirectories();
      const targetPath =
        buildManagedWorktreePath({
          workspaceRoot:
            workspace.rootRealPath,
          projectId:
            getActiveProjectId(),
          slug,
        });
      const branch =
        `${WORKTREE_BRANCH_PREFIX}${slug}`;

      try {
        await fs.lstat(targetPath);
        throw new Error(
          `Worktree hedefi zaten mevcut: ${targetPath}`,
        );
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      const branchState =
        await runGitWithCode([
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]);

      if (branchState.code === 0) {
        throw new Error(
          `Yerel branch zaten mevcut: ${branch}`,
        );
      }

      if (branchState.code !== 1) {
        throw new Error(
          branchState.stderr ||
          "Branch durumu doğrulanamadı.",
        );
      }

      const base = base_ref === "main"
        ? "main"
        : "HEAD";
      const baseResult =
        await runGitWithCode([
          "rev-parse",
          "--verify",
          `${base}^{commit}`,
        ]);

      if (baseResult.code !== 0) {
        throw new Error(
          `Worktree başlangıç ref'i bulunamadı: ${base}`,
        );
      }

      await fs.mkdir(
        path.dirname(targetPath),
        {
          recursive: true,
          mode: 0o755,
        },
      );

      const addResult =
        await runGitWithCode(
          [
            "worktree",
            "add",
            "-b",
            branch,
            targetPath,
            baseResult.stdout.trim(),
          ],
          120_000,
        );

      if (addResult.code !== 0) {
        throw new Error(
          addResult.stderr ||
          addResult.stdout ||
          "Worktree oluşturulamadı.",
        );
      }

      await runGitWithCode([
        "worktree",
        "lock",
        "--reason",
        "Managed by Equinox Local",
        targetPath,
      ]);

      const headResult = await execFile(
        "/usr/bin/git",
        ["rev-parse", "HEAD"],
        {
          cwd: targetPath,
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            LC_ALL: "C",
          },
        },
      );

      return processJsonResult({
        ok: true,
        project: getActiveProjectId(),
        branch,
        head:
          headResult.stdout.trim(),
        baseRef: base_ref,
        workspaceProject: WORKSPACE_PROJECT_ID,
        workspacePath:
          path.relative(
            workspace.rootRealPath,
            targetPath,
          ),
        absolutePath: targetPath,
        next:
          `Dosya ve terminal işlemlerinde project=${WORKSPACE_PROJECT_ID} ve cwd=workspacePath kullan.`,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    mutationScopes: ["global"],
  },
);

registerTextTool(
  "worktree_remove",
  {
    description:
      "Workspace altında Equinox Local tarafından yönetilen temiz bir worktree'yi beklenen HEAD SHA doğrulamasıyla kaldırır; isteğe bağlı olarak merge edilmiş branch'i güvenli -d ile siler.",
    inputSchema: {
      slug: z
        .string()
        .min(1)
        .max(60),
      expected_head_sha: z
        .string()
        .regex(/^[a-fA-F0-9]{40}$/u),
      delete_branch: z
        .boolean()
        .default(false),
    },
    annotations: {
      title: "Yönetilen Git worktree'yi kaldır",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({
    slug,
    expected_head_sha,
    delete_branch,
  }) => {
    try {
      validateWorktreeSlug(slug);

      const {
        workspace,
      } = await ensureWorkspaceRuntimeDirectories();
      const targetPath =
        buildManagedWorktreePath({
          workspaceRoot:
            workspace.rootRealPath,
          projectId:
            getActiveProjectId(),
          slug,
        });
      const records =
        await listActiveProjectWorktrees();
      const record = records.find(
        (item) =>
          path.resolve(item.path) ===
          path.resolve(targetPath),
      );

      if (!record || !record.managed) {
        throw new Error(
          "Equinox Local tarafından yönetilen worktree kaydı bulunamadı.",
        );
      }

      const activeTerminal =
        terminalManager.list().find(
          (item) =>
            item.running &&
            isPathInsideRoot(
              targetPath,
              item.cwd,
            ),
        );
      const activeProcess =
        processManager.list().find(
          (item) =>
            item.running &&
            isPathInsideRoot(
              targetPath,
              item.cwd,
            ),
        );

      if (activeTerminal || activeProcess) {
        throw new Error(
          "Worktree içinde çalışan terminal veya arka plan süreci var; önce onu durdur.",
        );
      }

      const [statusResult, headResult, branchResult] =
        await Promise.all([
          execFile(
            "/usr/bin/git",
            [
              "status",
              "--porcelain=v1",
              "--untracked-files=all",
            ],
            {
              cwd: targetPath,
              timeout: 15_000,
              maxBuffer: 4 * 1024 * 1024,
              env: {
                ...process.env,
                GIT_OPTIONAL_LOCKS: "0",
                LC_ALL: "C",
              },
            },
          ),
          execFile(
            "/usr/bin/git",
            ["rev-parse", "HEAD"],
            {
              cwd: targetPath,
              timeout: 15_000,
              maxBuffer: 1024 * 1024,
              env: {
                ...process.env,
                LC_ALL: "C",
              },
            },
          ),
          execFile(
            "/usr/bin/git",
            [
              "symbolic-ref",
              "--quiet",
              "--short",
              "HEAD",
            ],
            {
              cwd: targetPath,
              timeout: 15_000,
              maxBuffer: 1024 * 1024,
              env: {
                ...process.env,
                LC_ALL: "C",
              },
            },
          ),
        ]);

      if (statusResult.stdout.trim()) {
        throw new Error(
          "Worktree çalışma ağacı temiz değil; kaldırılmadı.",
        );
      }

      const actualHead =
        headResult.stdout.trim().toLowerCase();

      if (
        actualHead !==
        expected_head_sha.toLowerCase()
      ) {
        throw new Error(
          [
            "Worktree HEAD SHA uyuşmuyor; kaldırılmadı.",
            `Beklenen: ${expected_head_sha}`,
            `Mevcut:   ${actualHead}`,
          ].join("\n"),
        );
      }

      const branch =
        branchResult.stdout.trim();

      await runGitWithCode([
        "worktree",
        "unlock",
        targetPath,
      ]);

      const removeResult =
        await runGitWithCode(
          [
            "worktree",
            "remove",
            targetPath,
          ],
          120_000,
        );

      if (removeResult.code !== 0) {
        throw new Error(
          removeResult.stderr ||
          removeResult.stdout ||
          "Worktree kaldırılamadı.",
        );
      }

      let branchDeleted = false;

      if (delete_branch && branch) {
        const deleteResult =
          await runGitWithCode([
            "branch",
            "-d",
            branch,
          ]);

        if (deleteResult.code !== 0) {
          throw new Error(
            [
              "Worktree kaldırıldı ancak branch güvenli biçimde silinemedi.",
              deleteResult.stderr ||
                deleteResult.stdout,
            ].join("\n"),
          );
        }

        branchDeleted = true;
      }

      await runGitWithCode([
        "worktree",
        "prune",
        "--expire",
        "now",
      ]);

      return processJsonResult({
        ok: true,
        project: getActiveProjectId(),
        removedPath: targetPath,
        branch,
        head: actualHead,
        branchDeleted,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    mutationScopes: ["global"],
  },
);


const workflowRuntimePaths =
  await ensureWorkspaceRuntimeDirectories();
const workflowManager =
  await registerWorkflowTools({
    rootDir: workflowRuntimePaths.workflowRoot,
    registerTextTool,
    z,
    getActiveProjectId,
    getActiveProjectName,
    getActiveProjectRoot,
    resolveProjectContext,
    readProjectPackageJson,
    processManager,
    probeTcpPort,
    extraStepExecutor: null,
    onEvent: recordRuntimeEvent,
    processJsonResult,
    errorResult,
  });

async function resumeWorkflowSafelyForRepair(workflowId) {
  const current = workflowManager.status(workflowId);
  const context = await resolveProjectContext(current.projectId);

  if (context.rootRealPath !== current.projectRoot) {
    throw new Error(
      "Workflow kayıtlı proje kökü güncel izinli proje slotuyla uyuşmuyor; repair resume engellendi.",
    );
  }

  return workflowManager.resume(workflowId);
}

async function listProjectClientRoots() {
  const roots = [];

  for (const projectId of PROJECT_IDS) {
    const definition =
      PROJECT_DEFINITIONS[
        projectId
      ];

    try {
      const realPath =
        await fs.realpath(
          definition.root,
        );
      const stats =
        await fs.stat(realPath);

      if (!stats.isDirectory()) {
        continue;
      }

      roots.push({
        uri: pathToFileURL(
          realPath,
        ).href,
        name:
          `${projectId} — ${definition.name}`,
      });
    } catch {
      // Kullanılamayan veya henüz hedefe bağlanmamış kökleri atla.
    }
  }

  return roots;
}

function normalizeChromeToolResult(
  result,
) {
  if (
    result &&
    Array.isArray(result.content)
  ) {
    return result;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          result ?? null,
          null,
          2,
        ),
      },
    ],
  };
}

const peekabooBridge = createPeekabooBridge({
  serverVersion: SERVER_VERSION,
  listRoots: listProjectClientRoots,
  onEvent: recordRuntimeEvent,
});

let equinoxAgentBrowser = null;
const equinoxBrowserBridge = createEquinoxBrowserBridge({
  socketPath: equinoxBrowserSocketPath({
    namespace: process.env.EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE || null,
  }),
  recordEvent: recordRuntimeEvent,
  handleExtensionRequest: async ({ context, method, args }) => {
    if (method !== "agent_browser.open") {
      throw new Error(`Unsupported extension-initiated Local action: ${method}`);
    }
    if (args && Object.keys(args).length > 0) {
      throw new Error("agent_browser.open does not accept arguments.");
    }
    if (!equinoxAgentBrowser) {
      throw new Error("Agent Browser manager is not ready yet.");
    }
    if (context === "agent") {
      return {
        opened: false,
        alreadyOpen: true,
        agentBrowser: equinoxAgentBrowser.snapshot(),
      };
    }
    const alreadyOpen = equinoxBrowserBridge.readyFor("agent");
    return {
      opened: true,
      alreadyOpen,
      agentBrowser: await equinoxAgentBrowser.launch({ setup: false }),
    };
  },
});
await equinoxBrowserBridge.start();
equinoxAgentBrowser = createEquinoxAgentBrowser({
  bridge: equinoxBrowserBridge,
  homeDir: process.env.HOME,
  execFileAsync: execFile,
  recordEvent: recordRuntimeEvent,
});
let equinoxLocalControlApi = null;

await registerRuntimeObservabilityTools({
  registerTextTool,
  z,
  observability: runtimeObservability,
  getRuntimeSnapshot: async () => ({
    server: {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      mutationQueueKeys: mutationLockTails.size,
    },
    terminal: {
      active: terminalManager.list().filter((item) => item.running).length,
      total: terminalManager.list().length,
    },
    process: {
      active: processManager.list().filter((item) => item.running).length,
      total: processManager.list().length,
    },
    workflow: workflowManager.summary(),
    peekaboo: {
      active: peekabooBridge.active,
      reconnectCount: peekabooBridge.reconnectCount,
      allowedToolCount: PEEKABOO_ALLOWED_TOOLS.length,
    },
    equinoxBrowser: equinoxBrowserBridge.snapshot(),
    config: {
      version: EQUINOX_LOCAL_CONFIG.version,
      revision: EQUINOX_LOCAL_CONFIG_SNAPSHOT.revision,
      defaultProject: DEFAULT_PROJECT,
      projectCount: PROJECT_IDS.length,
      fileRootCount: FILE_ROOT_IDS.length,
    },
    controlCenter: equinoxLocalControlApi?.snapshot() ?? { active: false },
  }),
  processJsonResult,
  errorResult,
});

const diagnosisEngine = createDiagnosisEngine({
  observability: runtimeObservability,
  workflowManager,
  processManager,
  inspectPort: (port) => inspectLocalPort({
    port,
    host: "127.0.0.1",
    timeoutMs: 1000,
  }),
  getBridgeSnapshot: () => ({
    peekaboo: {
      active: peekabooBridge.active,
      reconnectCount: peekabooBridge.reconnectCount,
      unexpectedCloseCount: peekabooBridge.unexpectedCloseCount,
      allowedToolCount: PEEKABOO_ALLOWED_TOOLS.length,
    },
  }),
});

await registerDiagnosisTools({
  registerTextTool,
  z,
  diagnosisEngine,
  projectIdSchema: PROJECT_ID_VALUE_SCHEMA,
  processJsonResult,
  errorResult,
});

const repairEngine = createRepairEngine({
  rootDir: workflowRuntimePaths.repairRoot,
  diagnosisEngine,
  observability: runtimeObservability,
  processManager,
  workflowManager,
  inspectPort: (port) => inspectLocalPort({
    port,
    host: "127.0.0.1",
    timeoutMs: 1000,
  }),
  restartPeekabooBridge: () => peekabooBridge.restart(),
  getPeekabooStatus: () => peekabooBridge.status(),
  resumeWorkflowSafely: resumeWorkflowSafelyForRepair,
});
await repairEngine.initialize();
await registerRepairTools({
  registerTextTool,
  z,
  repairEngine,
  processJsonResult,
  errorResult,
});

recoveryPolicyController = createRecoveryPolicyController({
  rootDir: workflowRuntimePaths.recoveryPolicyRoot,
  diagnosisEngine,
  repairEngine,
  observability: runtimeObservability,
});
await recoveryPolicyController.initialize();
await registerRecoveryPolicyTools({
  registerTextTool,
  z,
  recoveryPolicyController,
  processJsonResult,
  errorResult,
});

const runtimeJanitor = createRuntimeJanitor({
  rootDir: workflowRuntimePaths.janitorRoot,
  workspaceRoot: workflowRuntimePaths.workspace.rootRealPath,
  workflowRoot: workflowRuntimePaths.workflowRoot,
  visualRoot: workflowRuntimePaths.visualRoot,
  browserScreenshotRoot: workflowRuntimePaths.browserScreenshotRoot,
  releaseGateRoot: workflowRuntimePaths.releaseGateRoot,
  observabilityRoot: workflowRuntimePaths.observabilityRoot,
  terminalManager,
  processManager,
  workflowManager,
  observability: runtimeObservability,
  listManagedWorktrees: listJanitorWorktrees,
  pruneManagedWorktrees: pruneJanitorWorktrees,
  runExclusive: (task) => withMutationLocks(["global"], task),
});
await runtimeJanitor.initialize();
await runtimeJanitor.startMaintenance();
await registerRuntimeJanitorTools({
  registerTextTool,
  z,
  janitor: runtimeJanitor,
  processJsonResult,
  errorResult,
});

setTimeout(() => {
  void recoveryPolicyController?.reconcile().catch((error) => {
    console.error(
      `[Equinox Local] Startup automatic recovery reconciliation başarısız: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}, 500).unref?.();

await registerEquinoxBrowserTools({
  registerTextTool,
  registerRawTool,
  z,
  fileRootSchema: FILE_ROOT_ID_VALUE_SCHEMA,
  resolveUploadFile: resolveBrowserUploadFile,
  downloadsRoot: FILE_ROOT_DEFINITIONS[DOWNLOADS_ROOT_ID].root,
  screenshotRoot: workflowRuntimePaths.browserScreenshotRoot,
  screenshotProjectId: WORKSPACE_PROJECT_ID,
  bridge: equinoxBrowserBridge,
  isBrowserAccessEnabled: () => AGENT_ACCESS.browser,
  ensureAgentBrowserReady: () => equinoxAgentBrowser.ensureReady(),
  getAgentBrowserStatus: () => equinoxAgentBrowser.snapshot(),
  withMutationLocks,
  textResult,
  errorResult,
});

const CONTROL_CENTER_REDACTED_PATHS = Object.freeze(
  [...new Set([
    ...Object.values(EQUINOX_LOCAL_CONFIG.projects).map((definition) => definition.root),
    ...Object.values(EQUINOX_LOCAL_CONFIG.fileRoots).map((definition) => definition.root),
    process.env.HOME,
  ].filter((value) => typeof value === "string" && value.length > 1))]
    .sort((left, right) => right.length - left.length),
);

function sanitizeControlCenterEventText(value) {
  let text = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/gu, " ");
  for (const privatePath of CONTROL_CENTER_REDACTED_PATHS) {
    text = text.replaceAll(privatePath, "[local path]");
  }
  return text.replace(/\s+/gu, " ").trim().slice(0, 300);
}

async function getControlCenterActivity() {
  const events = await runtimeObservability.query({
    sinceMs: Date.now() - (6 * 60 * 60 * 1000),
    limit: 30,
    newestFirst: true,
  });
  return events.map((event) => ({
    timestamp: event.timestamp,
    component: sanitizeControlCenterEventText(event.component).slice(0, 80),
    type: sanitizeControlCenterEventText(event.type).slice(0, 120),
    severity: event.severity,
    status: event.status ?? null,
    message: sanitizeControlCenterEventText(event.message),
  }));
}

function publicPeekabooVersion(value) {
  const match = String(value ?? "").match(/(?:Peekaboo\s+)?(\d+\.\d+\.\d+)/u);
  return match ? match[1] : null;
}

async function getControlCenterPeekabooStatus() {
  try {
    const status = await peekabooBridge.status({ probePermissions: false });
    const ready = isPeekabooControlCenterReady(status);
    return Object.freeze({
      available: true,
      active: Boolean(status.active),
      ready,
      needsAttention: !ready,
      version: publicPeekabooVersion(status.version),
      reconnectCount: Number.isInteger(status.reconnectCount) ? status.reconnectCount : 0,
    });
  } catch {
    return Object.freeze({
      available: false,
      active: false,
      ready: false,
      needsAttention: false,
      version: null,
      reconnectCount: 0,
    });
  }
}

async function getControlCenterDoctorStatus() {
  const browser = equinoxBrowserBridge.snapshot();
  let browserSettings = null;
  if (browser.ready) {
    try {
      browserSettings = await equinoxBrowserBridge.call("settings.status", {}, { timeoutMs: 2_500 });
    } catch {
      // Browser settings are optional doctor context; bridge readiness remains useful on its own.
    }
  }
  const observabilityHealth = await runtimeObservability.health({
    windowMs: 15 * 60 * 1000,
  });
  const onboarding = await getManagedOnboardingStatus({
    installation: equinoxLocalInstallation,
    homeDir: process.env.HOME,
    supervisorMode: process.env.EQUINOX_LOCAL_SUPERVISOR_MODE || null,
  });
  const [developmentTunnel, developmentPeekaboo, sourceCheckout, peekabooStatus] = await Promise.all([
    equinoxLocalInstallation.kind === "source" ? inspectSourceTunnelRuntime() : Promise.resolve(null),
    equinoxLocalInstallation.kind === "source" ? inspectSourcePeekabooRuntime() : Promise.resolve(null),
    equinoxLocalInstallation.kind === "source" ? inspectSourceCheckoutVersion() : Promise.resolve(null),
    getControlCenterPeekabooStatus(),
  ]);
  return getEquinoxLocalDoctorStatus({
    installation: equinoxLocalInstallation,
    config: EQUINOX_LOCAL_CONFIG,
    runtimeHealthState: observabilityHealth.state,
    runtimeVersion: SERVER_VERSION,
    sourceCheckoutVersion: sourceCheckout?.version ?? null,
    browser: {
      ready: Boolean(browser.ready),
      consentAccepted: typeof browserSettings?.consentAccepted === "boolean" ? browserSettings.consentAccepted : null,
    },
    peekaboo: peekabooStatus,
    update: equinoxLocalUpdateCoordinator.snapshot(),
    onboarding,
    developmentTunnel,
    developmentPeekaboo,
    homeDir: process.env.HOME,
  });
}

equinoxLocalControlApi = createEquinoxLocalControlApi({
  configManager: equinoxLocalConfigManager,
  port: EQUINOX_LOCAL_CONFIG.controlCenter.port,
  getStatus: async () => {
    const browser = equinoxBrowserBridge.snapshot();
    const browserSettingsByContext = { agent: null, user: null };
    for (const context of ["agent", "user"]) {
      if (!browser.contexts?.[context]?.ready) continue;
      try {
        browserSettingsByContext[context] = await equinoxBrowserBridge.call("settings.status", {}, {
          timeoutMs: 2_500,
          context,
        });
      } catch {
        // Older extension builds may not expose the settings control plane yet.
      }
    }
    const browserSettings = browserSettingsByContext.user;
    const agentBrowserStatus = equinoxAgentBrowser.snapshot();
    const observabilityHealth = await runtimeObservability.health({
      windowMs: 15 * 60 * 1000,
    });
    return {
      server: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
      },
      health: {
        state: observabilityHealth.state,
        evaluatedAt: observabilityHealth.evaluatedAt,
        recentEventCount: observabilityHealth.recentEventCount,
        reasonCount: observabilityHealth.reasons.length,
      },
      config: {
        version: EQUINOX_LOCAL_CONFIG.version,
        revision: EQUINOX_LOCAL_CONFIG_SNAPSHOT.revision,
        defaultProject: DEFAULT_PROJECT,
        workspaceProject: WORKSPACE_PROJECT_ID,
        projectCount: PROJECT_IDS.length,
        fileRootCount: FILE_ROOT_IDS.length,
      },
      browser: {
        active: Boolean(browser.active),
        ready: Boolean(browser.ready),
        connectedAt: browser.connectedAt ?? null,
        extensionVersion:
          browser.extension?.extensionVersion ?? null,
        consentAccepted: typeof browserSettings?.consentAccepted === "boolean" ? browserSettings.consentAccepted : null,
        consentVersion: Number.isInteger(browserSettings?.consentVersion) ? browserSettings.consentVersion : null,
        requiredConsentVersion: Number.isInteger(browserSettings?.requiredConsentVersion) ? browserSettings.requiredConsentVersion : null,
        controlEnabled: typeof browserSettings?.enabled === "boolean" ? browserSettings.enabled : null,
        agentCursorEnabled: typeof browserSettings?.agentCursorEnabled === "boolean" ? browserSettings.agentCursorEnabled : null,
        agentCursorName: typeof browserSettings?.agentCursorName === "string" ? browserSettings.agentCursorName : null,
        nativeHostConnected: Boolean(browserSettings?.nativeHostConnected ?? browser.ready),
        localConnected: Boolean(browserSettings?.localConnected ?? browser.ready),
        defaultTarget: "agent",
        agentBrowser: agentBrowserStatus,
        contexts: {
          agent: {
            ready: Boolean(browser.contexts?.agent?.ready),
            connectedAt: browser.contexts?.agent?.connectedAt ?? null,
            extensionVersion: browser.contexts?.agent?.extension?.extensionVersion ?? null,
            consentAccepted: typeof browserSettingsByContext.agent?.consentAccepted === "boolean" ? browserSettingsByContext.agent.consentAccepted : null,
            controlEnabled: typeof browserSettingsByContext.agent?.enabled === "boolean" ? browserSettingsByContext.agent.enabled : null,
            agentCursorEnabled: typeof browserSettingsByContext.agent?.agentCursorEnabled === "boolean" ? browserSettingsByContext.agent.agentCursorEnabled : null,
            agentCursorName: typeof browserSettingsByContext.agent?.agentCursorName === "string" ? browserSettingsByContext.agent.agentCursorName : null,
          },
          user: {
            ready: Boolean(browser.contexts?.user?.ready),
            connectedAt: browser.contexts?.user?.connectedAt ?? null,
            extensionVersion: browser.contexts?.user?.extension?.extensionVersion ?? null,
            consentAccepted: typeof browserSettingsByContext.user?.consentAccepted === "boolean" ? browserSettingsByContext.user.consentAccepted : null,
            controlEnabled: typeof browserSettingsByContext.user?.enabled === "boolean" ? browserSettingsByContext.user.enabled : null,
            agentCursorEnabled: typeof browserSettingsByContext.user?.agentCursorEnabled === "boolean" ? browserSettingsByContext.user.agentCursorEnabled : null,
            agentCursorName: typeof browserSettingsByContext.user?.agentCursorName === "string" ? browserSettingsByContext.user.agentCursorName : null,
          },
        },
      },
      peekaboo: {
        active: peekabooBridge.active,
        reconnectCount: peekabooBridge.reconnectCount,
      },
      capabilities: capabilityRegistry.summary(),
    };
  },
  getDoctorStatus: getControlCenterDoctorStatus,
  getActivity: getControlCenterActivity,
  getUpdateStatus: async () => equinoxLocalUpdateCoordinator.snapshot(),
  getOnboardingStatus: async () => getManagedOnboardingStatus({
    installation: equinoxLocalInstallation,
    homeDir: process.env.HOME,
    supervisorMode: process.env.EQUINOX_LOCAL_SUPERVISOR_MODE || null,
  }),
  restartRuntime: async () => withMutationLocks(["local-restart"], async () => {
    if (equinoxLocalInstallation.managed && equinoxLocalInstallation.selfUpdateSupported) {
      const result = scheduleEquinoxLocalRestart({ installation: equinoxLocalInstallation });
      runtimeRestartPendingUntil = Date.now() + RUNTIME_RESTART_GUARD_MS;
      return { ...result, installationKind: "managed" };
    }

    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "restart-runtime.sh");
    const scriptStats = await fs.lstat(scriptPath);
    if (scriptStats.isSymbolicLink() || !scriptStats.isFile()) {
      throw new Error("Source runtime restart script is not a normal file.");
    }
    const sourceRestartEnv = {
      HOME: process.env.HOME,
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      TMPDIR: process.env.TMPDIR,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      EQUINOX_LOCAL_DEV_NODE: process.execPath,
      EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: process.env.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG,
    };
    const child = spawn("/bin/bash", [scriptPath], {
      detached: true,
      stdio: "ignore",
      env: Object.fromEntries(Object.entries(sourceRestartEnv).filter(([, value]) => typeof value === "string" && value.length > 0)),
    });
    child.unref();
    runtimeRestartPendingUntil = Date.now() + RUNTIME_RESTART_GUARD_MS;
    return { scheduled: true, installationKind: "source" };
  }),
  configureTunnel: async (body) => withMutationLocks(["local-onboarding"], async () => {
    const configured = await configureManagedTunnel({
      installation: equinoxLocalInstallation,
      homeDir: process.env.HOME,
      tunnelId: body?.tunnelId,
      runtimeKey: body?.runtimeKey,
    });
    const restart = scheduleEquinoxLocalRestart({ installation: equinoxLocalInstallation });
    return {
      configured: configured.configured,
      tunnelId: configured.tunnelId,
      restartRequired: configured.restartRequired,
      restartScheduled: restart.scheduled,
    };
  }),
  scheduleUninstall: async ({ removeUserData }) => withMutationLocks(["local-uninstall"], async () => (
    scheduleEquinoxLocalUninstall({
      installation: equinoxLocalInstallation,
      removeUserData,
    })
  )),
  checkForUpdates: async () => {
    await equinoxLocalUpdater.check();
    return equinoxLocalUpdateCoordinator.snapshot();
  },
  applyUpdate: async () => withMutationLocks(["local-update"], async () => equinoxLocalUpdateCoordinator.apply()),
  chooseFolder: chooseLocalFolder,
  openAgentBrowser: async () => withMutationLocks(["browser:agent"], async () => (
    equinoxAgentBrowser.launch({ setup: false })
  )),
  updateBrowserSettings: async (settings) => {
    const context = settings?.context === "agent" ? "agent" : "user";
    const { context: _context, ...extensionSettings } = settings ?? {};
    return await withMutationLocks([`browser:${context}`], async () => {
      if (!equinoxBrowserBridge.readyFor(context)) {
        const error = new Error(
          context === "agent"
            ? "Agent Browser is not connected to Equinox Local. Open Agent Browser and install/enable Equinox Browser in that isolated profile."
            : "Equinox Browser is not connected to the user's Chrome profile.",
        );
        error.statusCode = 503;
        throw error;
      }
      return await equinoxBrowserBridge.call("settings.update", extensionSettings, {
        timeoutMs: 5_000,
        context,
      });
    });
  },
  getPeekabooStatus: getControlCenterPeekabooStatus,
  checkGitHub: async () => {
    const context = await resolveProjectContext(EQUINOX_LOCAL_CONFIG.defaultProject);
    const result = await projectContextStorage.run(
      context,
      () => runGhWithCode(["api", "user", "--jq", ".login"], "", 15_000),
    ).catch(() => null);
    const rawAccount = result?.code === 0 ? String(result.stdout ?? "").trim() : "";
    const account = /^[A-Za-z0-9-]{1,39}$/u.test(rawAccount) ? rawAccount : null;
    return { ready: Boolean(account), account };
  },
  getTelegramStatus: async () => getTelegramIntegrationStatus(),
  configureTelegram: async (body) => withMutationLocks(["telegram"], async () => (
    configureTelegramIntegration({
      botToken: body?.botToken,
      telegramUserId: body?.telegramUserId,
    })
  )),
  testTelegram: async () => withMutationLocks(["telegram"], async () => testTelegramIntegration()),
  disconnectTelegram: async () => withMutationLocks(["telegram"], async () => (
    disconnectTelegramIntegration()
  )),
});
if (EQUINOX_LOCAL_CONFIG.controlCenter.enabled) {
  await equinoxLocalControlApi.start();
}

registerTextTool(
  "desktop_status",
  {
    description:
      "Peekaboo tabanlı macOS masaüstü köprüsünün sürümünü, izin durumunu ve Equinox Local güvenli araç yüzeyini gösterir. UI eylemi gerçekleştirmez.",
    inputSchema: {},
    annotations: {
      title: "macOS masaüstü köprüsü durumu",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const status = await peekabooBridge.status();

      return textResult(
        [
          `Peekaboo: ${status.version}`,
          `Binary: ${status.binary}`,
          `Peekaboo MCP köprüsü: ${status.active ? "AKTİF" : "pasif"}`,
          `Equinox Local allowlist: ${status.allowedToolCount} araç`,
          `Araçlar: ${status.allowedTools.join(", ")}`,
          status.compatibility
            ? `Uyumluluk: ${status.compatibility.ok ? "OK" : "HATA"} | minimum=${status.compatibility.minimumVersion.major}.${status.compatibility.minimumVersion.minor}.${status.compatibility.minimumVersion.patch}${status.compatibility.warnings.length > 0 ? ` | uyarı=${status.compatibility.warnings.join(" | ")}` : ""}`
            : `Uyumluluk: doğrulanamadı${status.error ? ` | ${status.error}` : ""}`,
          `MCP yeniden bağlantı: ${status.reconnectCount} | son=${status.lastReconnectAt ? new Date(status.lastReconnectAt).toISOString() : "yok"} | beklenmeyen kapanma=${status.unexpectedCloseCount} | son kapanma=${status.lastUnexpectedCloseAt ? new Date(status.lastUnexpectedCloseAt).toISOString() : "yok"}${status.lastTransportError ? ` | son transport hatası=${status.lastTransportError}` : ""}`,
          status.permissions
            ? `İzinler:\n${status.permissions}`
            : `İzin durumu alınamadı: ${status.error ?? "bilinmeyen hata"}`,
          status.serverStatus
            ? `Peekaboo server durumu:\n${status.serverStatus}`
            : null,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    projectAware: false,
    mcpExposed: true,
    capability: false,
  },
);

registerTextTool(
  "desktop_tools",
  {
    description:
      "Equinox Local tarafından izin verilen Peekaboo macOS araçlarını ve JSON giriş şemalarını listeler. AI agent/analyze, ikinci browser yüzeyi, clipboard, dialog, paste ve ham dosya yakalama araçları bilinçli olarak dışarıda bırakılır.",
    inputSchema: {
      tool_name: z
        .string()
        .min(1)
        .max(160)
        .optional()
        .describe("İsteğe bağlı güvenli Peekaboo araç adı"),
      refresh: z
        .boolean()
        .default(false)
        .describe("Peekaboo MCP araç kataloğunu yeniden yükle"),
      restart: z
        .boolean()
        .default(false)
        .describe("Peekaboo MCP alt sürecini kapatıp yeniden başlat"),
    },
    annotations: {
      title: "macOS masaüstü araç kataloğu",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ tool_name, refresh, restart }) => {
    try {
      if (!AGENT_ACCESS.desktop) {
        throw new Error("Desktop automation access is disabled in Control Center.");
      }

      if (restart) {
        await peekabooBridge.restart();
      }

      const tools = await peekabooBridge.listTools(refresh || restart);

      if (tool_name) {
        const tool = tools.find((candidate) => candidate.name === tool_name);

        if (!tool) {
          throw new Error(
            `Peekaboo aracı güvenli masaüstü kataloğunda bulunamadı: ${tool_name}`,
          );
        }

        return textResult(JSON.stringify(tool, null, 2));
      }

      return textResult(
        [
          `Equinox Local Peekaboo araç sayısı: ${tools.length}`,
          `Alt sunucu allowlist'i: ${PEEKABOO_ALLOWED_TOOLS.join(", ")}`,
          ...tools.map((tool) =>
            [
              tool.name,
              tool.description ?? "",
              JSON.stringify(tool.inputSchema ?? {}),
            ].join("\n"),
          ),
        ].join("\n\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    projectAware: false,
    mcpExposed: true,
    capability: false,
  },
);

registerRawTool(
  "desktop_call",
  {
    description:
      "Peekaboo'nun Equinox Local allowlist'indeki tek bir macOS aracını çağırır. Önce desktop_tools ile şemayı incele. Koordinat tıklama/drag, körlemesine typing, global hotkey, force quit, AI araçları, clipboard/dialog/paste ve sistem menu-extra eylemleri güvenlik katmanında engellenir.",
    inputSchema: {
      tool_name: z
        .string()
        .min(1)
        .max(160)
        .describe("Çağrılacak güvenli Peekaboo araç adı"),
      arguments: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("Peekaboo alt aracının JSON giriş şemasına uyan argümanlar"),
    },
    outputSchema: {
      text: z.string(),
    },
    annotations: {
      title: "macOS masaüstü aracını çağır",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ tool_name, arguments: toolArguments }) => {
    try {
      if (!AGENT_ACCESS.desktop) {
        throw new Error("Desktop automation access is disabled in Control Center.");
      }

      return await withMutationLocks(["desktop"], async () => {
        const result = await peekabooBridge.callTool(tool_name, toolArguments);
        const normalized = normalizeChromeToolResult(result);
        return {
          ...normalized,
          structuredContent: {
            text: extractTextContent(normalized),
          },
        };
      });
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    mcpExposed: true,
    capability: false,
  },
);

registerTextTool(
  "restart_runtime",
  {
    description:
      "Equinox Local runtime'ını kurulum türüne uygun güvenli restart yoluyla yeniden başlatmayı zamanlar. " +
      "Managed kurulumlar bundled LaunchAgent helper'ını, source checkout geliştirme ortamları ise private developer runtime config'ini kullanır. " +
      "Bu araç başarılı döndükten sonra AYNI ASİSTAN TURUNDA başka Equinox Local aracı çağırma; kullanıcıya hemen final durum yanıtı ver.",
    inputSchema: {},
    annotations: {
      title:
        "Equinox Local runtime'ını yeniden başlat",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      if (
        equinoxLocalInstallation.managed &&
        equinoxLocalInstallation.selfUpdateSupported
      ) {
        scheduleEquinoxLocalRestart({
          installation: equinoxLocalInstallation,
        });
        runtimeRestartPendingUntil =
          Date.now() + RUNTIME_RESTART_GUARD_MS;

        return textResult(
          [
            "Equinox Local managed yeniden başlatması zamanlandı.",
            "Bundled LaunchAgent helper kısa bir gecikmeden sonra aktif sürümü yeniden başlatacak.",
            "Bu çağrıdan sonra aynı asistan turunda başka Equinox Local aracı çağrılmamalı.",
            "MCP bağlantısı kısa süreliğine kesilip yeniden kurulabilir.",
          ].join("\n"),
        );
      }

      const { spawn } =
        await import(
          "node:child_process"
        );
      const { fileURLToPath } =
        await import(
          "node:url"
        );

      const serverPath =
        fileURLToPath(
          import.meta.url,
        );
      const scriptPath = path.join(
        path.dirname(serverPath),
        "restart-runtime.sh",
      );
      const scriptStats =
        await fs.lstat(scriptPath);

      if (
        scriptStats.isSymbolicLink() ||
        !scriptStats.isFile()
      ) {
        throw new Error(
          "Source runtime yeniden başlatma scripti normal bir dosya değil.",
        );
      }

      const sourceRestartEnv = {
        HOME: process.env.HOME,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME,
        TMPDIR: process.env.TMPDIR,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        EQUINOX_LOCAL_DEV_NODE: process.execPath,
        EQUINOX_LOCAL_DEV_RUNTIME_CONFIG:
          process.env.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG,
      };
      const child = spawn(
        "/bin/bash",
        [scriptPath],
        {
          detached: true,
          stdio: "ignore",
          env: Object.fromEntries(
            Object.entries(sourceRestartEnv).filter(
              ([, value]) =>
                typeof value === "string" &&
                value.length > 0,
            ),
          ),
        },
      );

      child.unref();
      runtimeRestartPendingUntil =
        Date.now() + RUNTIME_RESTART_GUARD_MS;

      return textResult(
        [
          "Equinox Local source-checkout yeniden başlatması zamanlandı.",
          "Private developer runtime config üzerinden yaklaşık 8 saniye içinde başlayacak.",
          "Bu çağrıdan sonra aynı asistan turunda başka Equinox Local aracı çağrılmamalı.",
          "MCP bağlantısı kısa süreliğine kesilip yeniden kurulabilir.",
          `Kayıt: ${path.join(process.env.TMPDIR ?? "/tmp", "equinox-local-restart.log")}`,
        ].join("\n"),
      );
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    projectAware: false,
    mutationScopes: ["global"],
  },
);

registerTextTool(
  "telegram_send_message",
  {
    description:
      "Control Center'da bağlanmış Telegram botu üzerinden yalnız yapılandırılmış insana düz metin mesaj gönderir. Ajan hedef Telegram ID'sini seçemez veya değiştiremez; bot tokenı ve hedef kimliği MCP sonucuna ya da loglara döndürülmez. Uzun mesajlar Telegram sınırına uygun parçalara otomatik bölünür.",
    inputSchema: {
      message: z
        .string()
        .min(1)
        .max(12_000)
        .describe("İnsanına Telegram üzerinden gönderilecek düz metin mesaj"),
    },
    annotations: {
      title: "Telegram mesajı gönder",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ message }) => {
    try {
      const result = await sendTelegramMessage({ message });
      return textResult(
        result.messageCount === 1
          ? "Telegram mesajı gönderildi."
          : `Telegram mesajı ${result.messageCount} parça halinde gönderildi.`,
      );
    } catch (error) {
      return errorResult(error);
    }
  },
  {
    projectAware: false,
    mutationScopes: ["global"],
  },
);

registerTextTool(
  "system_doctor",
  {
    description:
      "Equinox Local kurulumunu, runtime sağlığını, yapılandırmayı, güvenli güncelleme hazırlığını, ChatGPT bağlantısını ve isteğe bağlı Browser/Desktop köprülerini ürün-dostu ve salt okunur biçimde denetler.",
    inputSchema: {},
    annotations: {
      title:
        "Equinox Local sağlık kontrolü",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const doctor = await getControlCenterDoctorStatus();
      return textResult([
        `Equinox Local system doctor: ${doctor.state}`,
        `Checks: ${doctor.summary.pass} passed, ${doctor.summary.attention} need attention, ${doctor.summary.optional} optional.`,
        ...doctor.checks.map((item) => `${item.status === "pass" ? "OK" : item.status === "attention" ? "ATTENTION" : "OPTIONAL"} | ${item.label} | ${item.detail}`),
      ].join("\n"));
    } catch (error) {
      return errorResult(error);
    }
  },
  { projectAware: false },
);

registerStableCapabilityGateways({
  registerTextTool,
  registry: capabilityRegistry,
  textResult,
});

let localShutdownStarted = false;

async function shutdownLocalResources() {
  if (localShutdownStarted) {
    return;
  }

  localShutdownStarted = true;

  await recordRuntimeEvent({
    component: "runtime",
    type: "runtime.shutdown_requested",
    severity: "info",
    status: "stopping",
    message: "Equinox Local runtime shutdown started.",
    details: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
    },
  });

  runtimeJanitor?.stopMaintenance();
  await recoveryPolicyController?.shutdown();
  await workflowManager.shutdown();

  await Promise.all([
    equinoxLocalControlApi?.close() ?? Promise.resolve(),
    equinoxBrowserBridge.close(),
    peekabooBridge.close(),
    terminalManager.shutdown(),
    processManager.shutdown(),
  ]);

  await recordRuntimeEvent({
    component: "runtime",
    type: "runtime.stopped",
    severity: "info",
    status: "completed",
    message: "Equinox Local runtime resources shut down cleanly.",
    details: {
      pid: process.pid,
    },
  });
  await runtimeObservability.flush();
}

process.stdin.once(
  "end",
  () => {
    void shutdownLocalResources();
  },
);

for (const signal of [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
]) {
  process.once(
    signal,
    () => {
      void shutdownLocalResources()
        .finally(() => {
          process.exit(0);
        });
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
