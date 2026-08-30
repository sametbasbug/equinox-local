import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { readBoundedNormalFile } from "./equinox-local-safe-file.js";

const WORKFLOW_SCHEMA_VERSION = 1;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_MAX_RETAINED = 100;
const DEFAULT_MAX_LOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STATE_BYTES = 1024 * 1024;

const ACTIVE_STATES = new Set(["queued", "running"]);
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const RESUMABLE_STATES = new Set(["paused", "failed"]);
const VALID_STATES = new Set([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);
const VALID_STEP_STATES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

function iso(now) {
  return new Date(now).toISOString();
}

function cleanError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 4000 ? `${message.slice(0, 4000)}…` : message;
}

function cloneStep(step) {
  return {
    id: step.id,
    kind: step.kind,
    label: step.label,
    status: step.status,
    attempts: step.attempts,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    error: step.error,
    result: step.result ?? null,
  };
}

function publicWorkflow(record) {
  return {
    workflowId: record.workflowId,
    schemaVersion: record.schemaVersion,
    recipeId: record.recipeId,
    recipeLabel: record.recipeLabel,
    label: record.label,
    projectId: record.projectId,
    projectName: record.projectName,
    projectRoot: record.projectRoot,
    status: record.status,
    resumable: RESUMABLE_STATES.has(record.status),
    currentStepIndex: record.currentStepIndex,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    interruptionCount: record.interruptionCount,
    error: record.error,
    options: { ...record.options },
    steps: record.steps.map(cloneStep),
  };
}

function validateStoredRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Workflow state bir JSON nesnesi olmalı.");
  }

  if (record.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new Error(`Desteklenmeyen workflow state sürümü: ${record.schemaVersion}`);
  }

  if (
    typeof record.workflowId !== "string" ||
    !/^wf-[a-z0-9-]{6,80}$/u.test(record.workflowId)
  ) {
    throw new Error("Workflow kimliği geçersiz.");
  }

  if (!VALID_STATES.has(record.status)) {
    throw new Error(`Workflow durumu geçersiz: ${record.status}`);
  }

  if (!Array.isArray(record.steps) || record.steps.length < 1 || record.steps.length > 64) {
    throw new Error("Workflow adım listesi geçersiz.");
  }

  for (const step of record.steps) {
    if (
      !step ||
      typeof step !== "object" ||
      typeof step.id !== "string" ||
      typeof step.kind !== "string" ||
      !VALID_STEP_STATES.has(step.status)
    ) {
      throw new Error("Workflow adım state kaydı geçersiz.");
    }
  }

  return record;
}

export function createWorkflowManager({
  rootDir,
  executeStep,
  now = () => Date.now(),
  randomId = () => randomUUID().slice(0, 10),
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  maxRetained = DEFAULT_MAX_RETAINED,
  maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  maxStateBytes = DEFAULT_MAX_STATE_BYTES,
  onEvent = null,
} = {}) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
    throw new Error("Workflow storage kökü mutlak bir yol olmalı.");
  }

  if (typeof executeStep !== "function") {
    throw new Error("Workflow step executor gerekli.");
  }

  const records = new Map();
  const runners = new Map();
  const logWaiters = new Map();
  const loadErrors = [];
  let initialized = false;
  let shuttingDown = false;

  const emitEvent = (event) => {
    if (typeof onEvent !== "function") {
      return;
    }
    void Promise.resolve(onEvent(event)).catch(() => {});
  };

  const statePath = (workflowId) => path.join(rootDir, `${workflowId}.json`);
  const logPath = (workflowId) => path.join(rootDir, `${workflowId}.log`);

  const notifyLogWaiters = (workflowId) => {
    const waiters = logWaiters.get(workflowId);

    if (!waiters) {
      return;
    }

    logWaiters.delete(workflowId);

    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };

  const persist = async (record) => {
    record.updatedAt = iso(now());
    const target = statePath(record.workflowId);
    const temporary = `${target}.${process.pid}.${randomId()}.tmp`;
    const serialized = `${JSON.stringify(record, null, 2)}\n`;

    if (Buffer.byteLength(serialized, "utf8") > maxStateBytes) {
      throw new Error("Workflow state güvenlik boyutu sınırını aştı.");
    }

    await fs.writeFile(temporary, serialized, { mode: 0o600 });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600).catch(() => {});
  };

  const appendLog = async (record, level, message) => {
    const value = String(message ?? "");

    if (!value) {
      return;
    }

    let size = 0;

    try {
      size = (await fs.stat(logPath(record.workflowId))).size;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    if (size >= maxLogBytes) {
      if (!record.logTruncated) {
        record.logTruncated = true;
        await persist(record);
      }
      return;
    }

    const clipped = value.length > 200_000
      ? `${value.slice(0, 200_000)}\n[workflow log parçası kısaltıldı]`
      : value;
    const prefix = `[${iso(now())}] [${String(level).toUpperCase()}] `;
    const line = `${prefix}${clipped.replace(/\n/gu, `\n${prefix}`)}\n`;
    const remaining = maxLogBytes - size;
    const buffer = Buffer.from(line, "utf8");
    const output = buffer.length > remaining
      ? buffer.subarray(0, Math.max(0, remaining))
      : buffer;

    if (output.length > 0) {
      await fs.appendFile(logPath(record.workflowId), output, { mode: 0o600 });
      await fs.chmod(logPath(record.workflowId), 0o600).catch(() => {});
      notifyLogWaiters(record.workflowId);
    }
  };

  const requireRecord = (workflowId) => {
    const record = records.get(workflowId);

    if (!record) {
      throw new Error(`Workflow bulunamadı: ${workflowId}`);
    }

    return record;
  };

  const pruneRetained = async () => {
    if (records.size < maxRetained) {
      return;
    }

    const removable = [...records.values()]
      .filter((record) => TERMINAL_STATES.has(record.status))
      .sort((left, right) =>
        String(left.updatedAt).localeCompare(String(right.updatedAt)),
      );

    while (records.size >= maxRetained && removable.length > 0) {
      const record = removable.shift();
      records.delete(record.workflowId);
      await Promise.all([
        fs.rm(statePath(record.workflowId), { force: true }),
        fs.rm(logPath(record.workflowId), { force: true }),
      ]);
    }
  };

  const finalizeAbort = async (record, runner) => {
    const mode = runner.stopMode === "pause" ? "pause" : "cancel";
    const step = record.steps[record.currentStepIndex];

    if (step?.status === "running") {
      step.status = mode === "pause" ? "pending" : "cancelled";
      step.completedAt = iso(now());
      step.error = mode === "pause"
        ? "Runtime kapanışı nedeniyle adım yeniden çalıştırılmak üzere beklemeye alındı."
        : "Workflow kullanıcı tarafından iptal edildi.";
    }

    record.status = mode === "pause" ? "paused" : "cancelled";
    record.error = mode === "pause"
      ? "Runtime kapanışı nedeniyle workflow duraklatıldı."
      : "Workflow kullanıcı tarafından iptal edildi.";
    record.completedAt = mode === "cancel" ? iso(now()) : null;
    await persist(record);
    await appendLog(
      record,
      mode === "pause" ? "warn" : "info",
      mode === "pause"
        ? "Workflow runtime kapanışı için güvenli biçimde duraklatıldı."
        : "Workflow iptal edildi.",
    );
    emitEvent({
      component: "workflow",
      type: mode === "pause" ? "workflow.paused" : "workflow.cancelled",
      severity: mode === "pause" ? "warn" : "info",
      status: record.status,
      projectId: record.projectId,
      correlationId: record.workflowId,
      message: record.error,
      details: {
        workflowId: record.workflowId,
        recipeId: record.recipeId,
        currentStepIndex: record.currentStepIndex,
      },
    });
  };

  const runRecord = async (record, runner) => {
    record.status = "running";
    record.startedAt ??= iso(now());
    record.error = null;
    record.completedAt = null;
    await persist(record);
    await appendLog(record, "info", `Workflow başladı: ${record.recipeId} / ${record.projectId}`);
    emitEvent({
      component: "workflow",
      type: "workflow.started",
      severity: "info",
      status: "running",
      projectId: record.projectId,
      correlationId: record.workflowId,
      message: `Workflow başladı: ${record.recipeId}`,
      details: {
        workflowId: record.workflowId,
        recipeId: record.recipeId,
        stepCount: record.steps.length,
      },
    });

    try {
      for (let index = 0; index < record.steps.length; index += 1) {
        const step = record.steps[index];

        if (step.status === "completed") {
          continue;
        }

        if (runner.controller.signal.aborted) {
          await finalizeAbort(record, runner);
          return;
        }

        record.currentStepIndex = index;
        step.status = "running";
        step.attempts += 1;
        step.startedAt = iso(now());
        step.completedAt = null;
        step.error = null;
        step.result = null;
        await persist(record);
        await appendLog(record, "info", `Adım başladı: ${step.label}`);

        if (runner.controller.signal.aborted) {
          await finalizeAbort(record, runner);
          return;
        }

        try {
          const result = await executeStep({
            workflow: publicWorkflow(record),
            step: { ...step },
            signal: runner.controller.signal,
            log: async (message, level = "info") =>
              appendLog(record, level, message),
          });

          if (runner.controller.signal.aborted) {
            await finalizeAbort(record, runner);
            return;
          }

          step.status = "completed";
          step.completedAt = iso(now());
          step.result = result ?? null;
          await persist(record);
          await appendLog(record, "info", `Adım tamamlandı: ${step.label}`);
        } catch (error) {
          if (runner.controller.signal.aborted) {
            await finalizeAbort(record, runner);
            return;
          }

          const message = cleanError(error);
          step.status = "failed";
          step.completedAt = iso(now());
          step.error = message;
          record.status = "failed";
          record.error = message;
          record.completedAt = iso(now());
          await persist(record);
          await appendLog(record, "error", `Adım başarısız: ${step.label}\n${message}`);
          emitEvent({
            component: "workflow",
            type: "workflow.failed",
            severity: "error",
            status: "failed",
            projectId: record.projectId,
            correlationId: record.workflowId,
            message,
            details: {
              workflowId: record.workflowId,
              recipeId: record.recipeId,
              stepId: step.id,
              stepLabel: step.label,
              attempts: step.attempts,
            },
          });
          return;
        }
      }

      record.currentStepIndex = record.steps.length;
      await appendLog(record, "info", "Workflow başarıyla tamamlandı.");
      record.status = "completed";
      record.error = null;
      record.completedAt = iso(now());
      await persist(record);
      emitEvent({
        component: "workflow",
        type: "workflow.completed",
        severity: "info",
        status: "completed",
        projectId: record.projectId,
        correlationId: record.workflowId,
        message: "Workflow başarıyla tamamlandı.",
        details: {
          workflowId: record.workflowId,
          recipeId: record.recipeId,
          stepCount: record.steps.length,
        },
      });
    } catch (error) {
      const message = cleanError(error);
      record.status = "failed";
      record.error = message;
      record.completedAt = iso(now());
      await persist(record).catch(() => {});
      await appendLog(record, "error", `Workflow motoru hatası: ${message}`).catch(() => {});
      emitEvent({
        component: "workflow",
        type: "workflow.engine_error",
        severity: "error",
        status: "failed",
        projectId: record.projectId,
        correlationId: record.workflowId,
        message,
        details: {
          workflowId: record.workflowId,
          recipeId: record.recipeId,
        },
      });
    }
  };

  const launch = (record) => {
    if (runners.has(record.workflowId)) {
      throw new Error("Workflow zaten çalışıyor.");
    }

    const activeCount = runners.size;

    if (activeCount >= maxConcurrent) {
      throw new Error(`Aynı anda en fazla ${maxConcurrent} workflow çalışabilir.`);
    }

    const runner = {
      controller: new AbortController(),
      stopMode: null,
      promise: null,
    };

    runners.set(record.workflowId, runner);
    runner.promise = runRecord(record, runner)
      .finally(() => {
        runners.delete(record.workflowId);
      });
  };

  const initialize = async () => {
    if (initialized) {
      return;
    }

    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(rootDir, 0o700).catch(() => {});
    const entries = await fs.readdir(rootDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !/^wf-[a-z0-9-]{6,80}\.json$/u.test(entry.name)) {
        continue;
      }

      const filePath = path.join(rootDir, entry.name);

      try {
        const { data: stateText } = await readBoundedNormalFile(filePath, {
          maxBytes: maxStateBytes,
          encoding: "utf8",
          label: "Workflow state file",
        });

        const parsed = validateStoredRecord(
          JSON.parse(stateText),
        );

        const recoveredFromInterruption = ACTIVE_STATES.has(parsed.status);
        if (recoveredFromInterruption) {
          parsed.status = "paused";
          parsed.interruptionCount = Number(parsed.interruptionCount ?? 0) + 1;
          parsed.error = "Önceki runtime sonlanırken workflow tamamlanmamıştı.";
          parsed.completedAt = null;

          for (const step of parsed.steps) {
            if (step.status === "running") {
              step.status = "pending";
              step.completedAt = null;
              step.error = "Runtime kesintisi sonrasında yeniden çalıştırılacak.";
            }
          }
        }

        records.set(parsed.workflowId, parsed);

        if (parsed.status === "paused") {
          await persist(parsed);
          await appendLog(
            parsed,
            "warn",
            "Workflow state diskten yüklendi; tamamlanmamış çalışma güvenli biçimde paused durumuna alındı.",
          );
          if (recoveredFromInterruption) {
            emitEvent({
              component: "workflow",
              type: "workflow.interrupted",
              severity: "warn",
              status: "paused",
              projectId: parsed.projectId,
              correlationId: parsed.workflowId,
              message: parsed.error,
              details: {
                workflowId: parsed.workflowId,
                recipeId: parsed.recipeId,
                interruptionCount: parsed.interruptionCount,
              },
            });
          }
        }
      } catch (error) {
        loadErrors.push({
          file: entry.name,
          error: cleanError(error),
        });
      }
    }

    initialized = true;
  };

  const start = async ({
    recipeId,
    recipeLabel,
    label,
    projectId,
    projectName,
    projectRoot,
    options = {},
    steps,
  }) => {
    if (!initialized) {
      throw new Error("Workflow manager initialize edilmedi.");
    }

    if (shuttingDown) {
      throw new Error("Runtime kapanırken yeni workflow başlatılamaz.");
    }

    if (!Array.isArray(steps) || steps.length < 1 || steps.length > 64) {
      throw new Error("Workflow 1 ile 64 arasında adım içermeli.");
    }

    const conflicting = [...records.values()].find(
      (record) =>
        record.projectId === projectId &&
        ACTIVE_STATES.has(record.status),
    );

    if (conflicting) {
      throw new Error(
        `Bu projede zaten aktif workflow var: ${conflicting.workflowId}`,
      );
    }

    await pruneRetained();
    const workflowId = `wf-${now().toString(36)}-${randomId()}`.toLowerCase();
    const createdAt = iso(now());
    const record = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      workflowId,
      recipeId,
      recipeLabel,
      label: label || `${projectId}:${recipeId}`,
      projectId,
      projectName,
      projectRoot,
      status: "queued",
      currentStepIndex: 0,
      createdAt,
      startedAt: null,
      updatedAt: createdAt,
      completedAt: null,
      interruptionCount: 0,
      error: null,
      logTruncated: false,
      options: { ...options },
      steps: steps.map((step) => ({
        ...step,
        status: "pending",
        attempts: 0,
        startedAt: null,
        completedAt: null,
        error: null,
        result: null,
      })),
    };

    records.set(workflowId, record);
    await persist(record);
    await appendLog(record, "info", `Workflow kaydı oluşturuldu: ${workflowId}`);
    launch(record);
    return publicWorkflow(record);
  };

  const list = ({ state = "all", projectId } = {}) => {
    const items = [...records.values()]
      .filter((record) => !projectId || record.projectId === projectId)
      .filter((record) => state === "all" || record.status === state)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .map(publicWorkflow);

    return items;
  };

  const status = (workflowId) => publicWorkflow(requireRecord(workflowId));

  const readLogs = async ({
    workflowId,
    cursor = 0,
    maxBytes = 80_000,
    waitMs = 0,
  }) => {
    const record = requireRecord(workflowId);

    if (!Number.isInteger(cursor) || cursor < 0) {
      throw new Error("Workflow log cursor değeri geçersiz.");
    }

    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 320_000) {
      throw new Error("Workflow log okuma boyutu 1 ile 320000 arasında olmalı.");
    }

    const getSize = async () => {
      try {
        return (await fs.stat(logPath(workflowId))).size;
      } catch (error) {
        if (error?.code === "ENOENT") {
          return 0;
        }
        throw error;
      }
    };

    let size = await getSize();

    if (waitMs > 0 && cursor >= size && ACTIVE_STATES.has(record.status)) {
      await new Promise((resolve) => {
        const waiter = {
          resolve,
          timer: setTimeout(() => {
            const set = logWaiters.get(workflowId);
            set?.delete(waiter);
            if (set?.size === 0) {
              logWaiters.delete(workflowId);
            }
            resolve();
          }, waitMs),
        };
        const set = logWaiters.get(workflowId) ?? new Set();
        set.add(waiter);
        logWaiters.set(workflowId, set);
      });
      size = await getSize();
    }

    const effectiveCursor = Math.min(cursor, size);
    const length = Math.min(maxBytes, Math.max(0, size - effectiveCursor));
    let bytesRead = 0;
    let output = "";

    if (length > 0) {
      const handle = await fs.open(logPath(workflowId), "r");
      try {
        const buffer = Buffer.alloc(length);
        const result = await handle.read(buffer, 0, length, effectiveCursor);
        bytesRead = result.bytesRead;
        output = new TextDecoder("utf-8").decode(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    }

    const nextCursor = effectiveCursor + bytesRead;

    return {
      workflow: publicWorkflow(record),
      requestedCursor: cursor,
      effectiveCursor,
      nextCursor,
      hasMore: nextCursor < size,
      output,
    };
  };

  const cancel = async (workflowId) => {
    const record = requireRecord(workflowId);
    const runner = runners.get(workflowId);

    if (TERMINAL_STATES.has(record.status)) {
      return publicWorkflow(record);
    }

    if (runner) {
      runner.stopMode = "cancel";
      runner.controller.abort();
      await appendLog(record, "info", "Workflow iptal isteği alındı.");
      await runner.promise.catch(() => {});
      return publicWorkflow(requireRecord(workflowId));
    }

    record.status = "cancelled";
    record.error = "Workflow kullanıcı tarafından iptal edildi.";
    record.completedAt = iso(now());
    const step = record.steps[record.currentStepIndex];
    if (step && step.status !== "completed") {
      step.status = "cancelled";
      step.completedAt = iso(now());
    }
    await persist(record);
    await appendLog(record, "info", "Workflow iptal edildi.");
    return publicWorkflow(record);
  };

  const resume = async (workflowId) => {
    const record = requireRecord(workflowId);

    if (!RESUMABLE_STATES.has(record.status)) {
      throw new Error(`Bu workflow devam ettirilemez; durum: ${record.status}`);
    }

    if (shuttingDown) {
      throw new Error("Runtime kapanırken workflow devam ettirilemez.");
    }

    const conflicting = [...records.values()].find(
      (candidate) =>
        candidate.workflowId !== workflowId &&
        candidate.projectId === record.projectId &&
        ACTIVE_STATES.has(candidate.status),
    );

    if (conflicting) {
      throw new Error(
        `Bu projede başka bir aktif workflow var: ${conflicting.workflowId}`,
      );
    }

    const current = record.steps[record.currentStepIndex];
    if (current && ["failed", "cancelled", "running"].includes(current.status)) {
      current.status = "pending";
      current.completedAt = null;
      current.error = null;
      current.result = null;
    }

    record.status = "queued";
    record.error = null;
    record.completedAt = null;
    await persist(record);
    await appendLog(record, "info", "Workflow devam ettirme isteği alındı.");
    emitEvent({
      component: "workflow",
      type: "workflow.resumed",
      severity: "info",
      status: "queued",
      projectId: record.projectId,
      correlationId: record.workflowId,
      message: "Workflow devam ettirme isteği alındı.",
      details: {
        workflowId: record.workflowId,
        recipeId: record.recipeId,
        interruptionCount: record.interruptionCount,
      },
    });
    launch(record);
    return publicWorkflow(record);
  };

  const removeTerminalRecord = async (workflowId) => {
    const record = requireRecord(workflowId);

    if (!TERMINAL_STATES.has(record.status)) {
      throw new Error(
        `Yalnız terminal durumdaki workflow kaydı temizlenebilir: ${workflowId} (${record.status})`,
      );
    }

    if (runners.has(workflowId)) {
      throw new Error(
        `Workflow runner hâlâ aktif; kayıt temizlenmedi: ${workflowId}`,
      );
    }

    const snapshot = publicWorkflow(record);
    records.delete(workflowId);
    await Promise.all([
      fs.rm(statePath(workflowId), { force: true }),
      fs.rm(logPath(workflowId), { force: true }),
    ]);
    notifyLogWaiters(workflowId);
    return snapshot;
  };

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    const active = [...runners.entries()];

    for (const [workflowId, runner] of active) {
      const record = records.get(workflowId);
      if (record) {
        runner.stopMode = "pause";
        runner.controller.abort();
      }
    }

    await Promise.all(
      active.map(([, runner]) =>
        Promise.race([
          runner.promise.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]),
      ),
    );
  };

  const summary = () => ({
    rootDir,
    initialized,
    total: records.size,
    active: [...records.values()].filter((record) => ACTIVE_STATES.has(record.status)).length,
    paused: [...records.values()].filter((record) => record.status === "paused").length,
    loadErrors: [...loadErrors],
  });

  return Object.freeze({
    initialize,
    start,
    list,
    status,
    readLogs,
    cancel,
    resume,
    removeTerminalRecord,
    shutdown,
    summary,
  });
}

export const __test = Object.freeze({
  WORKFLOW_SCHEMA_VERSION,
  ACTIVE_STATES,
  TERMINAL_STATES,
  RESUMABLE_STATES,
  validateStoredRecord,
  publicWorkflow,
});
