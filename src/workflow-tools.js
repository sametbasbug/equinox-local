import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

import { buildSafeWorkflowEnvironment, sanitizeWorkflowOutput } from "./workflow-security.js";
import { createWorkflowManager } from "./workflow-manager.js";
import {
  WORKFLOW_RECIPE_IDS,
  buildWorkflowPlan,
  listWorkflowRecipes,
} from "./workflow-recipes.js";

const execFile = promisify(execFileCallback);
const WORKFLOW_STATES = Object.freeze([
  "all",
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

function safeWorkflowEnvironment() {
  return {
    ...buildSafeWorkflowEnvironment(process.env),
    CI: "1",
    NO_COLOR: "1",
    CLICOLOR: "0",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_color: "false",
  };
}

async function resolveNpmBinary() {
  for (const candidate of [
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
    "/usr/bin/npm",
  ]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Sıradaki bilinen npm yolunu dene.
    }
  }

  throw new Error("Workflow için npm binary bulunamadı.");
}

async function assertGitClean(projectRoot) {
  const [rootResult, statusResult] = await Promise.all([
    execFile(
      "/usr/bin/git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd: projectRoot,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        env: safeWorkflowEnvironment(),
      },
    ),
    execFile(
      "/usr/bin/git",
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      {
        cwd: projectRoot,
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        env: safeWorkflowEnvironment(),
      },
    ),
  ]);

  const topLevel = String(rootResult.stdout ?? "").trim();

  if (topLevel !== projectRoot) {
    throw new Error(
      `Workflow proje kökü Git köküyle uyuşmuyor. Beklenen: ${projectRoot}; Git: ${topLevel}`,
    );
  }

  const status = String(statusResult.stdout ?? "").trim();

  if (status) {
    throw new Error(`Workflow temiz Git çalışma ağacı gerektiriyor:\n${status}`);
  }

  return {
    clean: true,
    projectRoot,
  };
}

function delayWithAbort(milliseconds, signal) {
  if (signal.aborted) {
    return Promise.reject(new Error("Workflow durduruldu."));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Workflow durduruldu."));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function drainProcessLogs({
  processManager,
  processId,
  cursor,
  log,
  waitMs,
}) {
  const result = await processManager.readLogs({
    processId,
    cursor,
    maxChars: 120_000,
    stripAnsiCodes: true,
    waitMs,
  });

  if (result.output) {
    await log(sanitizeWorkflowOutput(result.output), "info");
  }

  return result;
}

async function runManagedNpmScript({
  processManager,
  workflow,
  step,
  signal,
  log,
}) {
  const npmBinary = await resolveNpmBinary();
  const startedAt = Date.now();
  const processInfo = processManager.start({
    projectId: workflow.projectId,
    projectName: workflow.projectName,
    cwd: workflow.projectRoot,
    command: npmBinary,
    args: ["run", step.script],
    env: safeWorkflowEnvironment(),
    label: `workflow:${workflow.workflowId}:${step.script}`,
    expectedPorts: [],
  });
  let cursor = 0;

  try {
    while (true) {
      if (signal.aborted) {
        await processManager.stop({
          processId: processInfo.processId,
          force: false,
          timeoutMs: 1500,
          remove: false,
        }).catch(() => {});
        throw new Error("Workflow durduruldu.");
      }

      const logs = await drainProcessLogs({
        processManager,
        processId: processInfo.processId,
        cursor,
        log,
        waitMs: 750,
      });
      cursor = logs.nextCursor;

      if (!logs.process.running && !logs.hasMore) {
        if (logs.process.spawnError) {
          throw new Error(`npm süreci başlatılamadı: ${logs.process.spawnError}`);
        }

        if (logs.process.exitCode !== 0) {
          throw new Error(
            `npm run ${step.script} başarısız oldu; exit code ${logs.process.exitCode ?? "?"}.`,
          );
        }

        return {
          script: step.script,
          exitCode: logs.process.exitCode,
          durationMs: Date.now() - startedAt,
        };
      }

      if (Date.now() - startedAt > step.timeoutSeconds * 1000) {
        await processManager.stop({
          processId: processInfo.processId,
          force: false,
          timeoutMs: 1500,
          remove: false,
        }).catch(() => {});
        throw new Error(
          `npm run ${step.script} ${step.timeoutSeconds} saniyelik workflow zaman aşımını geçti.`,
        );
      }
    }
  } finally {
    const current = processManager.list().find(
      (item) => item.processId === processInfo.processId,
    );

    if (current) {
      await processManager.stop({
        processId: processInfo.processId,
        force: false,
        timeoutMs: 800,
        remove: true,
      }).catch(() => {});
    }
  }
}

async function choosePreviewPort({ requestedPort, probeTcpPort }) {
  if (requestedPort !== null && requestedPort !== undefined) {
    const requested = await probeTcpPort({
      host: "127.0.0.1",
      port: requestedPort,
      timeoutMs: 250,
    });

    if (requested.listening) {
      throw new Error(`İstenen preview portu zaten kullanımda: ${requestedPort}`);
    }

    return requestedPort;
  }

  for (let port = 43100; port <= 43199; port += 1) {
    const probe = await probeTcpPort({
      host: "127.0.0.1",
      port,
      timeoutMs: 100,
    });

    if (!probe.listening) {
      return port;
    }
  }

  throw new Error("43100-43199 aralığında boş preview portu bulunamadı.");
}

function buildPreviewNpmArgs(step, port) {
  if (step.adapter === "next-start") {
    return [
      "run",
      step.script,
      "--",
      "-H",
      "127.0.0.1",
      "-p",
      String(port),
    ];
  }

  if (step.adapter === "host-port") {
    return [
      "run",
      step.script,
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ];
  }

  throw new Error(`Desteklenmeyen preview adapter: ${step.adapter}`);
}

async function runPreviewSmoke({
  processManager,
  probeTcpPort,
  workflow,
  step,
  signal,
  log,
}) {
  const npmBinary = await resolveNpmBinary();
  const port = await choosePreviewPort({
    requestedPort: step.port,
    probeTcpPort,
  });
  const args = buildPreviewNpmArgs(step, port);
  const startedAt = Date.now();
  const processInfo = processManager.start({
    projectId: workflow.projectId,
    projectName: workflow.projectName,
    cwd: workflow.projectRoot,
    command: npmBinary,
    args,
    env: safeWorkflowEnvironment(),
    label: `workflow:${workflow.workflowId}:preview`,
    expectedPorts: [port],
  });
  let cursor = 0;

  try {
    await log(`Preview süreci başlatıldı: 127.0.0.1:${port}`, "info");

    while (true) {
      if (signal.aborted) {
        throw new Error("Workflow durduruldu.");
      }

      const logs = await drainProcessLogs({
        processManager,
        processId: processInfo.processId,
        cursor,
        log,
        waitMs: 500,
      });
      cursor = logs.nextCursor;

      if (!logs.process.running) {
        throw new Error(
          `Preview süreci port açılmadan kapandı; exit code ${logs.process.exitCode ?? "?"}.`,
        );
      }

      const probe = await probeTcpPort({
        host: "127.0.0.1",
        port,
        timeoutMs: 300,
      });

      if (probe.listening) {
        break;
      }

      if (Date.now() - startedAt > Math.min(step.timeoutSeconds, 90) * 1000) {
        throw new Error("Preview sunucusu zamanında loopback portunu açmadı.");
      }

      await delayWithAbort(250, signal);
    }

    const url = `http://127.0.0.1:${port}${step.path}`;
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "user-agent": "Equinox-Local-Workflow/3.7",
      },
    });

    if (response.status < 200 || response.status >= 400) {
      throw new Error(`Preview HTTP smoke testi başarısız: HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const contentLength = response.headers.get("content-length");
    await response.body?.cancel().catch(() => {});
    await log(
      `Preview HTTP smoke başarılı: ${response.status} ${response.url || url}`,
      "info",
    );

    return {
      port,
      url,
      finalUrl: response.url || url,
      status: response.status,
      contentType,
      contentLength: contentLength ?? null,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await processManager.stop({
      processId: processInfo.processId,
      force: false,
      timeoutMs: 1500,
      remove: true,
    }).catch(() => {});
  }
}

export function createWorkflowStepExecutor({
  processManager,
  probeTcpPort,
  extraStepExecutor,
}) {
  return async ({ workflow, step, signal, log }) => {
    if (signal.aborted) {
      throw new Error("Workflow durduruldu.");
    }

    if (step.kind === "git-clean") {
      const result = await assertGitClean(workflow.projectRoot);
      await log("Git çalışma ağacı temiz.", "info");
      return result;
    }

    if (step.kind === "npm-script") {
      return runManagedNpmScript({
        processManager,
        workflow,
        step,
        signal,
        log,
      });
    }

    if (step.kind === "preview-smoke") {
      return runPreviewSmoke({
        processManager,
        probeTcpPort,
        workflow,
        step,
        signal,
        log,
      });
    }

    if (typeof extraStepExecutor === "function") {
      const delegated = await extraStepExecutor({
        workflow,
        step,
        signal,
        log,
      });

      if (delegated?.handled) {
        return delegated.result ?? null;
      }
    }

    throw new Error(`Desteklenmeyen workflow adım türü: ${step.kind}`);
  };
}

export async function registerWorkflowTools({
  rootDir,
  registerTextTool,
  z,
  getActiveProjectId,
  getActiveProjectName,
  getActiveProjectRoot,
  resolveProjectContext,
  readProjectPackageJson,
  processManager,
  probeTcpPort,
  extraStepExecutor,
  onEvent,
  processJsonResult,
  errorResult,
}) {
  const workflowManager = createWorkflowManager({
    rootDir,
    executeStep: createWorkflowStepExecutor({
      processManager,
      probeTcpPort,
      extraStepExecutor,
    }),
    onEvent,
  });
  await workflowManager.initialize();

  registerTextTool(
    "workflow_recipes",
    {
      description:
        "Aktif projede v3.7 kalıcı workflow motorunun sabit tariflerini ve package.json'a göre kullanılabilirliklerini listeler.",
      inputSchema: {},
      annotations: {
        title: "Workflow tariflerini listele",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const { scripts } = await readProjectPackageJson();
        return processJsonResult({
          projectId: getActiveProjectId(),
          projectName: getActiveProjectName(),
          recipes: listWorkflowRecipes(scripts),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTextTool(
    "workflow_start",
    {
      description:
        "Aktif projede sabit bir kalıcı workflow tarifi başlatır. Rastgele komut veya environment kabul etmez; workflow state ve logları Selene Workspace altında kalıcı saklanır.",
      inputSchema: {
        recipe_id: z.enum(WORKFLOW_RECIPE_IDS),
        label: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[^\u0000-\u001f\u007f]+$/u)
          .optional(),
        timeout_seconds: z.number().int().min(30).max(900).default(300),
        preview_port: z.number().int().min(1024).max(65535).optional(),
        preview_path: z.string().min(1).max(200).default("/"),
      },
      annotations: {
        title: "Kalıcı workflow başlat",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      recipe_id,
      label,
      timeout_seconds,
      preview_port,
      preview_path,
    }) => {
      try {
        const { scripts } = await readProjectPackageJson();
        const plan = buildWorkflowPlan({
          recipeId: recipe_id,
          scripts,
          options: {
            timeoutSeconds: timeout_seconds,
            previewPort: preview_port,
            previewPath: preview_path,
          },
        });

        return processJsonResult({
          ok: true,
          workflow: await workflowManager.start({
            recipeId: plan.recipe.id,
            recipeLabel: plan.recipe.label,
            label,
            projectId: getActiveProjectId(),
            projectName: getActiveProjectName(),
            projectRoot: getActiveProjectRoot(),
            options: plan.options,
            steps: plan.steps,
          }),
          next: "workflow_status ve workflow_logs ile ilerlemeyi takip et.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTextTool(
    "workflow_list",
    {
      description:
        "Kalıcı workflow kayıtlarını durumlarına göre listeler; varsayılan olarak aktif proje kayıtlarını gösterir.",
      inputSchema: {
        state: z.enum(WORKFLOW_STATES).default("all"),
        include_all_projects: z.boolean().default(false),
      },
      annotations: {
        title: "Workflow kayıtlarını listele",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ state, include_all_projects }) =>
      processJsonResult({
        state,
        workflows: workflowManager.list({
          state,
          projectId: include_all_projects ? undefined : getActiveProjectId(),
        }),
      }),
  );

  registerTextTool(
    "workflow_status",
    {
      description:
        "Tek bir kalıcı workflow kaydının proje, tarif, adım, deneme, hata ve resume durumunu gösterir.",
      inputSchema: {
        workflow_id: z.string().min(1).max(100),
      },
      annotations: {
        title: "Workflow durumunu göster",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workflow_id }) => {
      try {
        return processJsonResult({
          workflow: workflowManager.status(workflow_id),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "workflow_logs",
    {
      description:
        "Kalıcı workflow loglarını byte cursor üzerinden okur ve çalışan workflow için kısa süre yeni log bekleyebilir.",
      inputSchema: {
        workflow_id: z.string().min(1).max(100),
        cursor: z.number().int().min(0).default(0),
        max_bytes: z.number().int().min(1).max(320_000).default(80_000),
        wait_ms: z.number().int().min(0).max(10_000).default(0),
      },
      annotations: {
        title: "Workflow loglarını oku",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workflow_id, cursor, max_bytes, wait_ms }) => {
      try {
        return processJsonResult(
          await workflowManager.readLogs({
            workflowId: workflow_id,
            cursor,
            maxBytes: max_bytes,
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
    "workflow_cancel",
    {
      description:
        "Çalışan veya bekleyen kalıcı workflow'u iptal eder; o workflow'a ait yönetilen alt süreç önce normal, gerekirse zorla kapatılır.",
      inputSchema: {
        workflow_id: z.string().min(1).max(100),
      },
      annotations: {
        title: "Workflow iptal et",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workflow_id }) => {
      try {
        return processJsonResult({
          workflow: await workflowManager.cancel(workflow_id),
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
    "workflow_resume",
    {
      description:
        "Paused veya failed kalıcı workflow'u tamamlanan adımları tekrar etmeden kaldığı adımdan yeniden çalıştırır; proje slotunun aynı Git köküne işaret ettiğini doğrular.",
      inputSchema: {
        workflow_id: z.string().min(1).max(100),
      },
      annotations: {
        title: "Workflow devam ettir",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workflow_id }) => {
      try {
        const current = workflowManager.status(workflow_id);
        const context = await resolveProjectContext(current.projectId);

        if (context.rootRealPath !== current.projectRoot) {
          throw new Error(
            "Workflow kayıtlı proje kökü güncel izinli proje slotuyla uyuşmuyor; resume engellendi.",
          );
        }

        return processJsonResult({
          workflow: await workflowManager.resume(workflow_id),
          next: "workflow_status ve workflow_logs ile ilerlemeyi takip et.",
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

  return workflowManager;
}

export const __test = Object.freeze({
  WORKFLOW_STATES,
  safeWorkflowEnvironment,
  assertGitClean,
  choosePreviewPort,
  buildPreviewNpmArgs,
  createWorkflowStepExecutor,
});
