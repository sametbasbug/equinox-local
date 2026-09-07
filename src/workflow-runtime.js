import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

import { buildSafeWorkflowEnvironment, sanitizeWorkflowOutput } from "./workflow-security.js";
import { createWorkflowManager } from "./workflow-manager.js";
const execFile = promisify(execFileCallback);
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

export async function createWorkflowRuntime({
  rootDir,
  processManager,
  probeTcpPort,
  extraStepExecutor,
  onEvent,
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
  return workflowManager;
}

export const __test = Object.freeze({
  safeWorkflowEnvironment,
  assertGitClean,
  choosePreviewPort,
  buildPreviewNpmArgs,
  createWorkflowStepExecutor,
});
