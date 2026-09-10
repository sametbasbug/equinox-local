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
  createProtectedAgentPathChecker,
  isSensitiveAgentName,
} from "./equinox-local-agent-path-policy.js";
import {
  createTerminalManager,
} from "./terminal-manager.js";
import {
  registerTerminalTools,
} from "./equinox-local-terminal-tools.js";
import {
  createProcessManager,
  probeTcpPort,
} from "./process-manager.js";
import {
  createAgentControlController,
} from "./equinox-local-agent-control.js";
import {
  registerProcessTools,
} from "./equinox-local-process-tools.js";
import {
  registerDesktopGatewayTools,
} from "./equinox-local-desktop-tools.js";
import {
  registerProjectDiscoveryTools,
} from "./equinox-local-project-tools.js";
import {
  registerImageViewTools,
} from "./equinox-local-image-tools.js";
import {
  isPathInside as isPathInsideRoot,
  parseGitWorktreePorcelain,
  publicWorktreeRecord,
} from "./worktree-utils.js";
import {
  createWorkflowRuntime,
} from "./workflow-runtime.js";
import {
  createPrivateReleaseGateRuntime,
  privateGitHubStatus,
  privateReleaseGateSnapshot,
  privateWorkflowStepExecutor,
  registerPrivateReleaseGateTools,
  registerPrivateSecureServiceTools,
  registerPrivateVisualTools,
} from "./equinox-local-private-composition.js";
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
  registerTelegramSendTool,
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
  registerRestartRuntimeTool,
  scheduleEquinoxLocalRestart,
} from "./equinox-local-restart.js";
import { launchDetachedHelper } from "./equinox-local-detached-helper.js";
import {
  createMutationPathLockManager,
  resolveGitCommonDirectory,
} from "./equinox-local-mutation-lock.js";
import {
  scheduleEquinoxLocalUninstall,
} from "./equinox-local-uninstall.js";
import {
  getEquinoxLocalDoctorStatus,
  registerSystemDoctorTool,
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
import { startRuntimeLifecycle } from "./equinox-local-runtime-lifecycle.js";

export async function createEquinoxLocalRuntime() {
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

const projectContextStorage =
  new AsyncLocalStorage();

const MAX_FILE_BYTES = 512 * 1024;
const MAX_OUTPUT_CHARS = 120_000;

const IGNORED_DIRECTORIES = new Set([
  ".git",
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
  let gitCommonDirRealPath = null;
  try {
    await validateIndependentGitProjectRoot(rootRealPath);
    kind = "git";
    gitCommonDirRealPath = await resolveGitCommonDirectory(rootRealPath);
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
    gitCommonDirRealPath,
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
  await resolveWorkspaceRuntimePaths();
const runtimeObservability =
  createRuntimeObservability({
    rootDir: initialRuntimePaths.observabilityRoot,
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
const agentControl =
  createAgentControlController({
    terminalManager,
    processManager,
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
const mutationPathLocks = createMutationPathLockManager({
  waitMs: MUTATION_LOCK_WAIT_MS,
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

function getMutationLockPlan(
  scopes,
  context,
) {
  const keys = [];
  let projectRoot = null;

  for (const scope of scopes) {
    if (scope === "project") {
      if (!context?.rootRealPath) {
        throw new Error(
          "Proje yazma kilidi için aktif proje bağlamı gerekli.",
        );
      }
      projectRoot = context.rootRealPath;
      continue;
    }

    if (scope === "git-common") {
      if (context?.kind !== "git" || !context.gitCommonDirRealPath) {
        throw new Error("Git ortak kaynak kilidi için Git proje bağlamı gerekli.");
      }
      keys.push(`git-common:${context.gitCommonDirRealPath}`);
      continue;
    }

    if (scope === "global") {
      keys.push("global");
      continue;
    }

    if (scope === "browser") {
      keys.push("browser");
      continue;
    }

    throw new Error(
      `Bilinmeyen mutasyon kilidi kapsamı: ${scope}`,
    );
  }

  return Object.freeze({
    keys: [...new Set(keys)].sort(),
    projectRoot,
  });
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

function withMutationLockPlan(plan, task) {
  return withMutationLocks(
    plan.keys,
    () => plan.projectRoot
      ? mutationPathLocks.withLock(plan.projectRoot, task)
      : task(),
  );
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
      if (
        options.pauseGuard !== false &&
        registeredConfig.annotations?.readOnlyHint !== true
      ) {
        try {
          agentControl.assertMutationAllowed(name);
        } catch (error) {
          return errorResult(error);
        }
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
          const lockPlan =
            getMutationLockPlan(
              mutationScopes,
              undefined,
            );

          return await withMutationLockPlan(
            lockPlan,
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

        const lockPlan =
          getMutationLockPlan(
            mutationScopes,
            context,
          );

        return projectContextStorage.run(
          context,
          () =>
            withMutationLockPlan(
              lockPlan,
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
    if (
      options.pauseGuard !== false &&
      config.annotations?.readOnlyHint !== true
    ) {
      try {
        agentControl.assertMutationAllowed(name);
      } catch (error) {
        return errorResult(error);
      }
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

registerProjectDiscoveryTools({
  registerTextTool,
  projectIds: PROJECT_IDS,
  projectDefinitions: PROJECT_DEFINITIONS,
  fileRootIds: FILE_ROOT_IDS,
  fileRootDefinitions: FILE_ROOT_DEFINITIONS,
  fullFileAccess: FULL_FILE_ACCESS,
  defaultProject: DEFAULT_PROJECT,
  resolveProjectContext,
  resolveFileRootContext,
  execFileImpl: execFile,
  fsImpl: fs,
  gitEnv: process.env,
  textResult,
});

registerImageViewTools({
  registerRawTool,
  z,
  fullFileAccess: FULL_FILE_ACCESS,
  fileRootIds: FILE_ROOT_IDS,
  resolveFileRootContext,
  homeDir: process.env.HOME,
  fsImpl: fs,
});

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
        "Önce Terminal üzerinden branch'i origin üzerindeki aynı branch'e normal push ile gönder.",
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

function delayMilliseconds(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

registerTerminalTools({
  registerTextTool,
  z,
  terminalManager,
  processManager,
  agentAccess: AGENT_ACCESS,
  safeResolve,
  getActiveProjectId,
  getActiveProjectName,
  getActiveProjectRoot,
  runtimeEnv: process.env,
  recordEvent: recordRuntimeEvent,
  textResult,
  errorResult,
});


registerProcessTools({
  registerTextTool,
  z,
  processManager,
  agentAccess: AGENT_ACCESS,
  safeResolve,
  getActiveProjectId,
  getActiveProjectName,
  getActiveProjectRoot,
  runtimeEnv: process.env,
  execFileImpl: execFile,
  textResult,
  errorResult,
});


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

async function resolveWorkspaceRuntimePaths() {
  const workspace = await resolveProjectContext(WORKSPACE_PROJECT_ID);
  return Object.freeze({
    workspace,
    worktreeRoot: path.join(workspace.rootRealPath, "worktrees"),
    visualRoot: path.join(workspace.rootRealPath, "visual-regression"),
    browserScreenshotRoot: path.join(workspace.rootRealPath, "browser-screenshots"),
    workflowRoot: path.join(workspace.rootRealPath, "workflows"),
    releaseGateRoot: path.join(workspace.rootRealPath, "release-gates"),
    observabilityRoot: path.join(workspace.rootRealPath, "observability"),
    repairRoot: path.join(workspace.rootRealPath, "repairs"),
    recoveryPolicyRoot: path.join(workspace.rootRealPath, "recovery-policies"),
    janitorRoot: path.join(workspace.rootRealPath, "janitor"),
  });
}

async function ensureWorkspaceRuntimeDirectories() {
  const {
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
  } = await resolveWorkspaceRuntimePaths();
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

const processJsonResult = (value) =>
  textResult(JSON.stringify(value, null, 2));

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
equinoxAgentBrowser = createEquinoxAgentBrowser({
  bridge: equinoxBrowserBridge,
  homeDir: process.env.HOME,
  execFileAsync: execFile,
  recordEvent: recordRuntimeEvent,
});

registerPrivateVisualTools({
  registerTextTool,
  processJsonResult,
  errorResult,
  projectIdValueSchema: PROJECT_ID_VALUE_SCHEMA,
  workspaceProjectId: WORKSPACE_PROJECT_ID,
  ensureWorkspaceRuntimeDirectories,
  resolveExplicitProjectPathForRead,
  resolveExplicitProjectPathForWrite,
  equinoxAgentBrowser,
  equinoxBrowserBridge,
  projectRoots: Object.values(PROJECT_DEFINITIONS).map((definition) => definition.root),
});



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


const workflowRuntimePaths =
  await ensureWorkspaceRuntimeDirectories();
const releaseGateRuntime =
  createPrivateReleaseGateRuntime({
    rootDir: workflowRuntimePaths.releaseGateRoot,
    processManager,
    probeTcpPort,
    equinoxAgentBrowser,
    equinoxBrowserBridge,
    projectRoots: Object.values(PROJECT_DEFINITIONS).map((definition) => definition.root),
    extractTextContent,
    resolveNpmBinary,
    onEvent: recordRuntimeEvent,
  });
const workflowManager =
  await createWorkflowRuntime({
    rootDir: workflowRuntimePaths.workflowRoot,
    processManager,
    probeTcpPort,
    extraStepExecutor:
      privateWorkflowStepExecutor(releaseGateRuntime),
    onEvent: recordRuntimeEvent,
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

await registerPrivateReleaseGateTools({
  registerTextTool,
  z,
  workflowManager,
  releaseGateRuntime,
  readProjectPackageJson,
  getActiveProjectId,
  getActiveProjectName,
  getActiveProjectRoot,
  resolveProjectContext,
  processJsonResult,
  errorResult,
});


const secureServiceState = registerPrivateSecureServiceTools({
  registerTextTool,
  z,
  getActiveProjectId,
  getActiveProjectName,
  getActiveProjectRoot,
  resolveProjectContext,
  runGhWithCode,
  assertGhAuthenticated,
  getGitHubRepoSlug,
  runGitWithCode,
  getCurrentGitBranch,
  getExactHeadCommit,
  assertNoGitOperationInProgress,
  assertCleanGitWorktree,
  assertRemoteBranchAtHead,
  readProjectPackageJson,
  resolveNpmBinary,
  processManager,
  parseJsonOutput,
  sanitizeGitNetworkOutput,
  delayMilliseconds,
  readWorkflowRunById,
  onEvent: recordRuntimeEvent,
  processJsonResult,
  errorResult,
});

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
    ...(await privateReleaseGateSnapshot(releaseGateRuntime)),
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
await registerRecoveryPolicyTools({
  registerTextTool,
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
await registerRuntimeJanitorTools({
  registerTextTool,
  z,
  janitor: runtimeJanitor,
  processJsonResult,
  errorResult,
});

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
  shutdownAgentBrowser: () => equinoxAgentBrowser.shutdown(),
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
    const agentBrowserStatus = await equinoxAgentBrowser.status();
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
      agentControl: agentControl.snapshot(),
      capabilities: capabilityRegistry.summary(),
    };
  },
  pauseAgent: async () => withMutationLocks(["agent-control"], async () => (
    agentControl.pause({ reason: "control_center_emergency_stop" })
  )),
  resumeAgent: async () => withMutationLocks(["agent-control"], async () => agentControl.resume()),
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
      const result = await scheduleEquinoxLocalRestart({ installation: equinoxLocalInstallation });
      runtimeRestartPendingUntil = Date.now() + RUNTIME_RESTART_GUARD_MS;
      return { ...result, installationKind: "managed" };
    }

    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const sourceRoot = path.basename(moduleDir) === "src" ? path.dirname(moduleDir) : moduleDir;
    const scriptPath = path.join(sourceRoot, "scripts", "restart-runtime.sh");
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
    await launchDetachedHelper({
      spawnImpl: spawn,
      command: "/bin/bash",
      args: [scriptPath],
      options: {
        detached: true,
        stdio: "ignore",
        env: Object.fromEntries(Object.entries(sourceRestartEnv).filter(([, value]) => typeof value === "string" && value.length > 0)),
      },
      label: "Equinox Local source restart helper",
    });
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
    const restart = await scheduleEquinoxLocalRestart({ installation: equinoxLocalInstallation });
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
    return privateGitHubStatus({
      context,
      projectContextStorage,
      secureServiceState,
      runGhWithCode,
    });
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
  recordInternalError: (error) => recordRuntimeEvent({
    component: "control-center",
    type: "control.error",
    severity: "error",
    status: "failed",
    message: "Control Center request failed internally.",
    details: {
      error: error instanceof Error ? error.message : String(error),
    },
  }),
});
registerDesktopGatewayTools({
  registerTextTool,
  registerRawTool,
  z,
  agentAccess: AGENT_ACCESS,
  peekabooBridge,
  allowedTools: PEEKABOO_ALLOWED_TOOLS,
  withMutationLocks,
  normalizeChromeToolResult,
  extractTextContent,
  textResult,
  errorResult,
  assertMutationAllowed: (operationName) => agentControl.assertMutationAllowed(operationName),
});

registerRestartRuntimeTool({
  registerTextTool,
  installation: equinoxLocalInstallation,
  sourceModuleUrl: import.meta.url,
  fsImpl: fs,
  pathImpl: path,
  processImpl: process,
  markRestartPending: () => {
    runtimeRestartPendingUntil =
      Date.now() + RUNTIME_RESTART_GUARD_MS;
  },
  textResult,
  errorResult,
});

registerTelegramSendTool({
  registerTextTool,
  z,
  textResult,
  errorResult,
});

registerSystemDoctorTool({
  registerTextTool,
  getDoctorStatus: getControlCenterDoctorStatus,
  textResult,
  errorResult,
});

registerStableCapabilityGateways({
  registerTextTool,
  registry: capabilityRegistry,
  textResult,
});

let localShutdownStarted = false;

async function shutdownLocalResources({ reason = "api" } = {}) {
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
      reason,
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

let runtimeStarted = false;

async function start({ transport = new StdioServerTransport() } = {}) {
  if (runtimeStarted) throw new Error("Equinox Local runtime already started.");
  runtimeStarted = true;

  await ensureWorkspaceRuntimeDirectories();
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
  await equinoxBrowserBridge.start();
  await repairEngine.initialize();
  await recoveryPolicyController.initialize();
  await runtimeJanitor.initialize();
  await runtimeJanitor.startMaintenance();
  if (EQUINOX_LOCAL_CONFIG.controlCenter.enabled) {
    await equinoxLocalControlApi.start();
  }

  setTimeout(() => {
    void recoveryPolicyController?.reconcile().catch((error) => {
      console.error(
        `[Equinox Local] Startup automatic recovery reconciliation başarısız: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }, 500).unref?.();

  return startRuntimeLifecycle({
    connect: () => server.connect(transport),
    shutdown: shutdownLocalResources,
  });
}

return Object.freeze({
  server,
  start,
  shutdown: shutdownLocalResources,
  snapshot: () => Object.freeze({
    started: runtimeStarted,
    browser: equinoxBrowserBridge.snapshot(),
    controlCenter: equinoxLocalControlApi?.snapshot?.() ?? null,
  }),
});
}

const isDirectExecution = Boolean(
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href,
);
if (isDirectExecution) {
  const runtime = await createEquinoxLocalRuntime();
  await runtime.start();
}
