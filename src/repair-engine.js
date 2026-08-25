import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const REPAIR_SCHEMA_VERSION = 1;
const DEFAULT_MAX_HISTORY_RECORDS = 500;
const DEFAULT_INCIDENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const OUTCOMES = Object.freeze([
  "RECOVERED",
  "FAILED",
  "NEEDS_INTERVENTION",
]);

const RECIPES = Object.freeze([
  Object.freeze({
    id: "peekaboo_bridge_restart",
    label: "Restart Peekaboo bridge",
    description:
      "Peekaboo MCP child bridge'ini yeniden başlatır; uyumluluk, Screen Recording, Accessibility ve salt-okunur server status doğrulaması yapar.",
    incidentCodes: Object.freeze(["PEEKABOO_TRANSPORT_FAILURE"]),
    scope: "runtime-infrastructure",
    risk: "low",
  }),
  Object.freeze({
    id: "stale_preview_cleanup",
    label: "Clean stale preview",
    description:
      "Release preview portunu tutan süreci yalnız listener PID, Equinox managed-process PID ve workflow preview sahipliği birebir doğrulanırsa kapatır.",
    incidentCodes: Object.freeze(["PREVIEW_PORT_OCCUPIED"]),
    scope: "managed-process",
    risk: "low",
  }),
  Object.freeze({
    id: "orphan_process_cleanup",
    label: "Clean workflow orphan processes",
    description:
      "Terminal durumdaki bir workflow'a ait, Equinox process manager tarafından sahip olunan workflow child süreçlerini kapatır.",
    incidentCodes: Object.freeze([
      "WORKFLOW_FAILURE",
      "WORKFLOW_CHILD_PROCESS_CRASH",
      "WORKFLOW_PAUSED",
    ]),
    scope: "managed-process",
    risk: "low",
  }),
  Object.freeze({
    id: "stale_workflow_recover",
    label: "Resume resumable workflow",
    description:
      "Paused/failed ve resumable workflow'u güncel izinli proje kökü yeniden doğrulandıktan sonra mevcut workflow resume mekanizmasıyla devam ettirir.",
    incidentCodes: Object.freeze([
      "WORKFLOW_FAILURE",
      "WORKFLOW_CHILD_PROCESS_CRASH",
      "WORKFLOW_PAUSED",
    ]),
    scope: "managed-workflow",
    risk: "low",
  }),
]);

const RECIPE_MAP = new Map(RECIPES.map((recipe) => [recipe.id, recipe]));

function iso(value) {
  return new Date(value).toISOString();
}

function clip(value, max = 4_000) {
  const text = String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/(authorization\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]");
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function publicRecipe(recipe) {
  return {
    id: recipe.id,
    label: recipe.label,
    description: recipe.description,
    incidentCodes: [...recipe.incidentCodes],
    scope: recipe.scope,
    risk: recipe.risk,
    arbitraryCommand: false,
    deploymentMutation: false,
    gitMutation: false,
    credentialMutation: false,
    projectFileMutation: false,
  };
}

function safeIncidentSummary(incident) {
  if (!incident) return null;
  return {
    incidentId: incident.incidentId,
    code: incident.code,
    state: incident.state,
    confidence: incident.confidence,
    severity: incident.severity,
    component: incident.component,
    projectId: incident.projectId,
    firstSeen: incident.firstSeen,
    lastSeen: incident.lastSeen,
  };
}

function uniqueListenerPids(listeners) {
  const pids = new Set();
  for (const listener of listeners ?? []) {
    if (Number.isInteger(listener?.pid) && listener.pid > 0) {
      pids.add(listener.pid);
    }
  }
  return [...pids];
}

function workflowIdFromPreviewLabel(label) {
  const match = /^workflow:(wf-[a-z0-9-]{6,80}):preview$/u.exec(String(label ?? ""));
  return match?.[1] ?? null;
}

function workflowChildPrefix(workflowId) {
  return `workflow:${workflowId}:`;
}

function compactProcess(record) {
  if (!record) return null;
  return {
    processId: record.processId,
    label: record.label,
    projectId: record.projectId,
    pid: record.pid,
    running: record.running,
    expectedPorts: Array.isArray(record.expectedPorts) ? [...record.expectedPorts] : [],
    createdAt: record.createdAt,
    exitedAt: record.exitedAt,
    exitCode: record.exitCode,
    signal: record.signal,
  };
}

function compactWorkflow(record) {
  if (!record) return null;
  return {
    workflowId: record.workflowId,
    recipeId: record.recipeId,
    projectId: record.projectId,
    projectRoot: record.projectRoot,
    status: record.status,
    resumable: record.resumable,
    currentStepIndex: record.currentStepIndex,
    updatedAt: record.updatedAt,
    error: record.error ? clip(record.error, 2_000) : null,
  };
}

async function readHistoryFile(historyPath) {
  let text = "";
  try {
    text = await fs.readFile(historyPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.schemaVersion === REPAIR_SCHEMA_VERSION) {
        records.push(parsed);
      }
    } catch {
      // Bounded repair history yalnız geçerli kendi kayıtlarını kullanır.
    }
  }
  return records;
}

export function createRepairEngine({
  rootDir,
  diagnosisEngine,
  observability,
  processManager,
  workflowManager,
  inspectPort,
  restartPeekabooBridge,
  getPeekabooStatus,
  restartChromeBridge,
  getChromeSnapshot,
  resumeWorkflowSafely,
  now = () => Date.now(),
  randomId = () => randomUUID().slice(0, 10),
  maxHistoryRecords = DEFAULT_MAX_HISTORY_RECORDS,
  incidentWindowMs = DEFAULT_INCIDENT_WINDOW_MS,
} = {}) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
    throw new Error("Repair storage kökü mutlak yol olmalı.");
  }
  if (!diagnosisEngine || typeof diagnosisEngine.incidentReport !== "function") {
    throw new Error("Repair engine diagnosis engine gerektirir.");
  }
  if (!observability || typeof observability.record !== "function") {
    throw new Error("Repair engine observability gerektirir.");
  }
  if (!processManager || typeof processManager.list !== "function" || typeof processManager.stop !== "function") {
    throw new Error("Repair engine process manager gerektirir.");
  }
  if (!workflowManager || typeof workflowManager.status !== "function") {
    throw new Error("Repair engine workflow manager gerektirir.");
  }
  if (typeof inspectPort !== "function") {
    throw new Error("Repair engine port inspector gerektirir.");
  }
  if (!Number.isInteger(maxHistoryRecords) || maxHistoryRecords < 10 || maxHistoryRecords > 10_000) {
    throw new Error("Repair history kayıt sınırı geçersiz.");
  }

  const historyPath = path.join(rootDir, "repair-history.jsonl");
  const activeRepairs = new Set();
  let initialized = false;

  const initialize = async () => {
    if (initialized) return;
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(rootDir, 0o700).catch(() => {});
    try {
      await fs.access(historyPath);
    } catch {
      await fs.writeFile(historyPath, "", { mode: 0o600 });
    }
    await fs.chmod(historyPath, 0o600).catch(() => {});
    initialized = true;
  };

  const appendHistory = async (record) => {
    await initialize();
    const existing = await readHistoryFile(historyPath);
    const next = [...existing, record].slice(-maxHistoryRecords);
    const temporary = `${historyPath}.${process.pid}.${randomId()}.tmp`;
    const serialized = next.map((item) => JSON.stringify(item)).join("\n") + (next.length ? "\n" : "");
    await fs.writeFile(temporary, serialized, { mode: 0o600 });
    await fs.rename(temporary, historyPath);
    await fs.chmod(historyPath, 0o600).catch(() => {});
  };

  const listHistory = async ({
    limit = 50,
    recipeId = null,
    outcome = null,
    incidentId = null,
  } = {}) => {
    await initialize();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Repair history limit 1 ile 500 arasında olmalı.");
    }
    if (outcome && !OUTCOMES.includes(outcome)) {
      throw new Error(`Geçersiz repair outcome: ${outcome}`);
    }
    const records = await readHistoryFile(historyPath);
    return records
      .filter((record) => !recipeId || record.recipeId === recipeId)
      .filter((record) => !outcome || record.outcome === outcome)
      .filter((record) => !incidentId || record.incidentId === incidentId)
      .slice(-limit)
      .reverse();
  };

  const emit = async (event) => {
    await observability.record({
      component: "repair",
      ...event,
    }).catch(() => {});
  };

  const finishRecord = async ({
    base,
    outcome,
    actionStatus,
    summary,
    before = null,
    after = null,
    details = {},
  }) => {
    const completedAtMs = now();
    const record = {
      ...base,
      completedAt: iso(completedAtMs),
      durationMs: Math.max(0, completedAtMs - Date.parse(base.startedAt)),
      outcome,
      actionStatus,
      summary: clip(summary, 4_000),
      before,
      after,
      details,
    };
    await appendHistory(record);
    await emit({
      type: outcome === "RECOVERED" ? "repair.recovered" : outcome === "FAILED" ? "repair.failed" : "repair.needs_intervention",
      severity: outcome === "RECOVERED" ? "info" : outcome === "FAILED" ? "error" : "warn",
      status: outcome === "RECOVERED" ? "recovered" : outcome === "FAILED" ? "failed" : "attention_required",
      projectId: base.projectId,
      correlationId: base.repairId,
      message: record.summary,
      details: {
        repairId: base.repairId,
        recipeId: base.recipeId,
        incidentId: base.incidentId,
        incidentCode: base.incidentCode,
        actionStatus,
      },
    });
    return record;
  };

  const alreadyResolved = async ({ base, incident, note }) => finishRecord({
    base,
    outcome: "RECOVERED",
    actionStatus: "SKIPPED_ALREADY_RESOLVED",
    summary: note ?? "Incident repair anında zaten çözülmüş görünüyordu; mutasyon yapılmadı.",
    before: safeIncidentSummary(incident),
    after: safeIncidentSummary(incident),
  });

  const repairPeekaboo = async ({ base, incident, report }) => {
    if (incident.state === "RESOLVED") {
      return alreadyResolved({ base, incident });
    }
    if (typeof restartPeekabooBridge !== "function" || typeof getPeekabooStatus !== "function") {
      return finishRecord({
        base,
        outcome: "FAILED",
        actionStatus: "REPAIR_BACKEND_UNAVAILABLE",
        summary: "Peekaboo restart backend kullanılamıyor.",
        before: safeIncidentSummary(incident),
      });
    }

    const before = {
      incident: safeIncidentSummary(incident),
      bridge: report.currentEvidence?.bridgeSnapshot?.peekaboo ?? null,
    };
    await emit({
      type: "repair.action_started",
      severity: "info",
      status: "recovering",
      correlationId: base.repairId,
      message: "Peekaboo bridge restart başladı.",
      details: { repairId: base.repairId, recipeId: base.recipeId, incidentId: base.incidentId },
    });

    await restartPeekabooBridge();
    const status = await getPeekabooStatus();
    const permissions = status?.permissionState ?? {};
    const compatibilityOk = status?.compatibility?.ok === true;
    const permissionsOk = permissions.screenRecording === true && permissions.accessibility === true;
    const healthy = status?.active === true && compatibilityOk && permissionsOk && !status?.error;

    if (!healthy) {
      return finishRecord({
        base,
        outcome: "NEEDS_INTERVENTION",
        actionStatus: "RESTARTED_BUT_HEALTH_CHECK_FAILED",
        summary: "Peekaboo bridge yeniden başlatıldı ancak compatibility/permission/server health doğrulaması tam geçmedi.",
        before,
        after: {
          active: status?.active ?? false,
          compatibilityOk,
          permissions,
          error: status?.error ?? null,
        },
      });
    }

    return finishRecord({
      base,
      outcome: "RECOVERED",
      actionStatus: "RESTARTED_AND_VERIFIED",
      summary: "Peekaboo bridge yeniden başlatıldı ve compatibility + macOS izinleri + server status doğrulandı.",
      before,
      after: {
        active: true,
        compatibilityOk: true,
        permissions,
        reconnectCount: status.reconnectCount,
      },
    });
  };

  const repairChrome = async ({ base, incident, report }) => {
    const current = typeof getChromeSnapshot === "function"
      ? await Promise.resolve(getChromeSnapshot()).catch(() => null)
      : report.currentEvidence?.bridgeSnapshot?.chrome ?? null;
    if (incident.state === "RESOLVED" && current?.active === true) {
      return alreadyResolved({ base, incident, note: "Chrome incident zaten çözülmüş ve backend readiness aktif; restart yapılmadı." });
    }
    if (typeof restartChromeBridge !== "function" || typeof getChromeSnapshot !== "function") {
      return finishRecord({
        base,
        outcome: "FAILED",
        actionStatus: "REPAIR_BACKEND_UNAVAILABLE",
        summary: "Chrome bridge restart backend kullanılamıyor.",
        before: { incident: safeIncidentSummary(incident), bridge: current },
      });
    }

    const before = { incident: safeIncidentSummary(incident), bridge: current };
    await emit({
      type: "repair.action_started",
      severity: "info",
      status: "recovering",
      correlationId: base.repairId,
      message: "Chrome bridge restart başladı.",
      details: { repairId: base.repairId, recipeId: base.recipeId, incidentId: base.incidentId },
    });

    await restartChromeBridge();
    const after = await Promise.resolve(getChromeSnapshot());
    const healthy = after?.active === true && after?.connection?.status === "ACTIVE";
    if (!healthy) {
      return finishRecord({
        base,
        outcome: "NEEDS_INTERVENTION",
        actionStatus: "RESTARTED_BUT_BACKEND_NOT_READY",
        summary: "Chrome bridge restart tamamlandı ancak gerçek Chrome backend readiness ACTIVE olmadı.",
        before,
        after,
      });
    }

    return finishRecord({
      base,
      outcome: "RECOVERED",
      actionStatus: "RESTARTED_AND_VERIFIED",
      summary: "Chrome DevTools MCP bridge yeniden kuruldu ve gerçek Chrome backend readiness doğrulandı.",
      before,
      after,
    });
  };

  const repairStalePreview = async ({ base, incident }) => {
    const port = Number(incident.details?.requestedPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return finishRecord({
        base,
        outcome: "NEEDS_INTERVENTION",
        actionStatus: "INVALID_INCIDENT_EVIDENCE",
        summary: "Preview incident geçerli port kanıtı taşımıyor; cleanup yapılmadı.",
        before: safeIncidentSummary(incident),
      });
    }

    const live = await inspectPort(port);
    if (!live?.probe?.listening) {
      await emit({
        component: "release-gate",
        type: "release-gate.port_recovered",
        severity: "info",
        status: "recovered",
        projectId: incident.projectId,
        correlationId: incident.correlationId,
        message: `Release preview portu artık boş: ${port}.`,
        details: {
          incidentId: base.incidentId,
          repairId: base.repairId,
          port,
        },
      });
      return alreadyResolved({
        base,
        incident,
        note: `Preview portu ${port} repair anında artık dinlenmiyor; süreç kapatma yapılmadı.`,
      });
    }
    if (live.lsofError) {
      return finishRecord({
        base,
        outcome: "NEEDS_INTERVENTION",
        actionStatus: "OWNERSHIP_UNPROVEN",
        summary: "lsof listener sahipliği doğrulanamadığı için preview sürecine dokunulmadı.",
        before: { port, lsofError: clip(live.lsofError, 2_000) },
      });
    }

    const listenerPids = uniqueListenerPids(live.listeners);
    const managed = (live.managedProcesses ?? []).filter((record) =>
      record.running === true &&
      Number.isInteger(record.pid) &&
      record.expectedPorts?.includes(port) &&
      workflowIdFromPreviewLabel(record.label),
    );

    if (listenerPids.length !== 1 || managed.length !== 1 || listenerPids[0] !== managed[0].pid) {
      return finishRecord({
        base,
        outcome: "NEEDS_INTERVENTION",
        actionStatus: "OWNERSHIP_UNPROVEN",
        summary: "Preview cleanup yalnız tek listener PID ile tek managed workflow preview PID birebir eşleşirse çalışır; koşul sağlanmadı.",
        before: {
          port,
          listenerPids,
          managedProcesses: managed.map(compactProcess),
        },
      });
    }

    const target = managed[0];
    const workflowId = workflowIdFromPreviewLabel(target.label);
    let workflow;
    try {
      workflow = workflowManager.status(workflowId);
    } catch {
      workflow = null;
    }
    if (!workflow || ["queued", "running"].includes(workflow.status)) {
      return finishRecord({
        base,
        outcome: "NEEDS_INTERVENTION",
        actionStatus: "PREVIEW_NOT_PROVEN_STALE",
        summary: workflow
          ? "Preview sürecinin sahibi workflow hâlâ aktif; cleanup güvenlik nedeniyle reddedildi."
          : "Preview etiketi bir workflow ID taşıyor ancak workflow kaydı bulunamadı; stale sahipliği kanıtlanamadı.",
        before: {
          port,
          process: compactProcess(target),
          workflow: compactWorkflow(workflow),
        },
      });
    }

    await emit({
      type: "repair.precondition_verified",
      severity: "info",
      status: "recovering",
      projectId: target.projectId,
      correlationId: base.repairId,
      message: "Stale preview sahipliği listener PID + managed PID + terminal workflow ile doğrulandı.",
      details: { repairId: base.repairId, recipeId: base.recipeId, incidentId: base.incidentId, processId: target.processId, port },
    });

    const stopped = await processManager.stop({
      processId: target.processId,
      force: false,
      timeoutMs: 2_000,
      remove: true,
    });
    const afterPort = await inspectPort(port);
    if (afterPort?.probe?.listening) {
      return finishRecord({
        base,
        outcome: "FAILED",
        actionStatus: "PROCESS_STOPPED_PORT_STILL_LISTENING",
        summary: `Managed preview process durduruldu ancak ${port} portu hâlâ dinleniyor; başka listener olabilir.`,
        before: { port, process: compactProcess(target), workflow: compactWorkflow(workflow) },
        after: { process: compactProcess(stopped), listenerPids: uniqueListenerPids(afterPort.listeners) },
      });
    }

    await emit({
      component: "release-gate",
      type: "release-gate.port_recovered",
      severity: "info",
      status: "recovered",
      projectId: incident.projectId,
      correlationId: incident.correlationId,
      message: `Release preview portu self-healing ile boşaltıldı: ${port}.`,
      details: {
        incidentId: base.incidentId,
        repairId: base.repairId,
        port,
      },
    });

    return finishRecord({
      base,
      outcome: "RECOVERED",
      actionStatus: "STALE_PREVIEW_REMOVED",
      summary: `Stale managed preview process güvenli biçimde kapatıldı ve ${port} portunun boşaldığı doğrulandı.`,
      before: { port, process: compactProcess(target), workflow: compactWorkflow(workflow) },
      after: { process: compactProcess(stopped), portListening: false },
    });
  };

  const resolveWorkflowForIncident = (incident) => {
    const workflowId = incident.details?.workflowId ?? (String(incident.correlationId ?? "").startsWith("wf-") ? incident.correlationId : null);
    if (!workflowId) return { workflowId: null, workflow: null };
    try {
      return { workflowId, workflow: workflowManager.status(workflowId) };
    } catch {
      return { workflowId, workflow: null };
    }
  };

  const repairOrphanProcesses = async ({ base, incident }) => {
    const { workflowId, workflow } = resolveWorkflowForIncident(incident);
    if (!workflowId || !workflow) {
      return finishRecord({
        base,
        outcome: "NEEDS_INTERVENTION",
        actionStatus: "WORKFLOW_NOT_FOUND",
        summary: "Incident için workflow kaydı bulunamadı; child process sahipliği kanıtlanamadı.",
        before: safeIncidentSummary(incident),
      });
    }
    if (["queued", "running"].includes(workflow.status)) {
      return finishRecord({
        base,
        outcome: "NEEDS_INTERVENTION",
        actionStatus: "WORKFLOW_STILL_ACTIVE",
        summary: "Workflow hâlâ aktif; child process cleanup güvenlik nedeniyle reddedildi.",
        before: { incident: safeIncidentSummary(incident), workflow: compactWorkflow(workflow) },
      });
    }

    const prefix = workflowChildPrefix(workflowId);
    const targets = processManager.list().filter((record) =>
      record.running === true &&
      record.projectId === workflow.projectId &&
      typeof record.label === "string" &&
      record.label.startsWith(prefix),
    );
    if (targets.length === 0) {
      return alreadyResolved({
        base,
        incident,
        note: "Terminal workflow'a ait çalışan managed child process kalmamış; cleanup yapılmadı.",
      });
    }

    await emit({
      type: "repair.precondition_verified",
      severity: "info",
      status: "recovering",
      projectId: workflow.projectId,
      correlationId: base.repairId,
      message: "Orphan workflow child süreç sahipliği doğrulandı.",
      details: { repairId: base.repairId, recipeId: base.recipeId, incidentId: base.incidentId, workflowId, processCount: targets.length },
    });

    const stopped = [];
    for (const target of targets) {
      stopped.push(await processManager.stop({
        processId: target.processId,
        force: false,
        timeoutMs: 2_000,
        remove: true,
      }));
    }
    const remaining = processManager.list().filter((record) =>
      record.running === true &&
      record.projectId === workflow.projectId &&
      typeof record.label === "string" &&
      record.label.startsWith(prefix),
    );
    if (remaining.length > 0) {
      return finishRecord({
        base,
        outcome: "FAILED",
        actionStatus: "ORPHAN_PROCESS_REMAINS",
        summary: "Bazı workflow child süreçleri cleanup sonrasında hâlâ çalışıyor.",
        before: { workflow: compactWorkflow(workflow), targets: targets.map(compactProcess) },
        after: { stopped: stopped.map(compactProcess), remaining: remaining.map(compactProcess) },
      });
    }

    return finishRecord({
      base,
      outcome: "RECOVERED",
      actionStatus: "ORPHAN_PROCESSES_REMOVED",
      summary: `${stopped.length} orphan managed workflow child process güvenli biçimde kapatıldı.`,
      before: { workflow: compactWorkflow(workflow), targets: targets.map(compactProcess) },
      after: { stopped: stopped.map(compactProcess), remaining: [] },
    });
  };

  const repairWorkflow = async ({ base, incident }) => {
    const { workflowId, workflow } = resolveWorkflowForIncident(incident);
    if (!workflowId || !workflow) {
      return finishRecord({
        base,
        outcome: "NEEDS_INTERVENTION",
        actionStatus: "WORKFLOW_NOT_FOUND",
        summary: "Resume için workflow kaydı bulunamadı.",
        before: safeIncidentSummary(incident),
      });
    }
    if (["completed", "cancelled"].includes(workflow.status)) {
      return alreadyResolved({
        base,
        incident,
        note: `Workflow ${workflow.status}; resume mutasyonu yapılmadı.`,
      });
    }
    if (!workflow.resumable || !["paused", "failed"].includes(workflow.status)) {
      return finishRecord({
        base,
        outcome: "NEEDS_INTERVENTION",
        actionStatus: "WORKFLOW_NOT_RESUMABLE",
        summary: `Workflow güvenli resume durumunda değil: ${workflow.status}.`,
        before: { incident: safeIncidentSummary(incident), workflow: compactWorkflow(workflow) },
      });
    }

    const prefix = workflowChildPrefix(workflowId);
    const runningChildren = processManager.list().filter((record) =>
      record.running === true &&
      record.projectId === workflow.projectId &&
      typeof record.label === "string" &&
      record.label.startsWith(prefix),
    );
    if (runningChildren.length > 0) {
      return finishRecord({
        base,
        outcome: "NEEDS_INTERVENTION",
        actionStatus: "ORPHAN_PROCESS_PRESENT",
        summary: "Workflow resume öncesinde hâlâ çalışan managed child süreç var; önce orphan_process_cleanup kullanılmalı.",
        before: {
          incident: safeIncidentSummary(incident),
          workflow: compactWorkflow(workflow),
          runningChildren: runningChildren.map(compactProcess),
        },
      });
    }
    if (typeof resumeWorkflowSafely !== "function") {
      return finishRecord({
        base,
        outcome: "FAILED",
        actionStatus: "REPAIR_BACKEND_UNAVAILABLE",
        summary: "Safe workflow resume backend kullanılamıyor.",
        before: { workflow: compactWorkflow(workflow) },
      });
    }

    await emit({
      type: "repair.precondition_verified",
      severity: "info",
      status: "recovering",
      projectId: workflow.projectId,
      correlationId: base.repairId,
      message: "Workflow resumable state ve child-process temizliği doğrulandı; project root guard yeniden çalıştırılacak.",
      details: { repairId: base.repairId, recipeId: base.recipeId, incidentId: base.incidentId, workflowId },
    });

    const resumed = await resumeWorkflowSafely(workflowId);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const after = workflowManager.status(workflowId);
    if (after.status === "failed") {
      return finishRecord({
        base,
        outcome: "FAILED",
        actionStatus: "RESUME_FAILED_IMMEDIATELY",
        summary: "Workflow resume kabul edildi ancak workflow hemen tekrar failed durumuna geçti.",
        before: { workflow: compactWorkflow(workflow) },
        after: { requested: compactWorkflow(resumed), current: compactWorkflow(after) },
      });
    }
    if (!["queued", "running", "completed"].includes(after.status)) {
      return finishRecord({
        base,
        outcome: "NEEDS_INTERVENTION",
        actionStatus: "RESUME_STATE_UNEXPECTED",
        summary: `Workflow resume sonrası beklenmeyen durumda: ${after.status}.`,
        before: { workflow: compactWorkflow(workflow) },
        after: { requested: compactWorkflow(resumed), current: compactWorkflow(after) },
      });
    }

    return finishRecord({
      base,
      outcome: "RECOVERED",
      actionStatus: after.status === "completed" ? "WORKFLOW_COMPLETED" : "WORKFLOW_RESUMED",
      summary: after.status === "completed"
        ? "Workflow güvenli resume sonrası tamamlandı."
        : "Workflow project-root guard doğrulamasıyla güvenli biçimde resume edildi.",
      before: { workflow: compactWorkflow(workflow) },
      after: { requested: compactWorkflow(resumed), current: compactWorkflow(after) },
    });
  };

  const handlers = Object.freeze({
    peekaboo_bridge_restart: repairPeekaboo,
    chrome_bridge_restart: repairChrome,
    stale_preview_cleanup: repairStalePreview,
    orphan_process_cleanup: repairOrphanProcesses,
    stale_workflow_recover: repairWorkflow,
  });

  const repairIssue = async ({ incidentId, recipeId }) => {
    await initialize();
    const recipe = RECIPE_MAP.get(recipeId);
    if (!recipe) {
      throw new Error(`Bilinmeyen repair recipe: ${recipeId}`);
    }
    if (activeRepairs.has(incidentId)) {
      throw new Error(`Bu incident için zaten aktif repair var: ${incidentId}`);
    }
    activeRepairs.add(incidentId);

    const startedAtMs = now();
    const repairId = `repair-${startedAtMs.toString(36)}-${randomId()}`;
    let report = null;
    let incident = null;
    let base = {
      schemaVersion: REPAIR_SCHEMA_VERSION,
      repairId,
      recipeId,
      incidentId,
      incidentCode: null,
      projectId: null,
      startedAt: iso(startedAtMs),
    };

    try {
      report = await diagnosisEngine.incidentReport({
        incidentId,
        windowMs: incidentWindowMs,
      });
      incident = report.incident;
      base = {
        ...base,
        incidentCode: incident.code,
        projectId: incident.projectId ?? null,
      };

      await emit({
        type: "repair.started",
        severity: "info",
        status: "recovering",
        projectId: base.projectId,
        correlationId: repairId,
        message: `Repair başladı: ${recipeId}`,
        details: {
          repairId,
          recipeId,
          incidentId,
          incidentCode: incident.code,
        },
      });

      if (!recipe.incidentCodes.includes(incident.code)) {
        return finishRecord({
          base,
          outcome: "NEEDS_INTERVENTION",
          actionStatus: "RECIPE_INCIDENT_MISMATCH",
          summary: `${recipeId} tarifi ${incident.code} incident koduna uygulanamaz; mutasyon yapılmadı.`,
          before: safeIncidentSummary(incident),
          details: { supportedIncidentCodes: [...recipe.incidentCodes] },
        });
      }

      const handler = handlers[recipeId];
      return await handler({ base, incident, report });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return finishRecord({
        base,
        outcome: "FAILED",
        actionStatus: "REPAIR_EXCEPTION",
        summary: `Repair yürütülemedi: ${message}`,
        before: safeIncidentSummary(incident),
      });
    } finally {
      activeRepairs.delete(incidentId);
    }
  };

  return Object.freeze({
    initialize,
    recipes: () => RECIPES.map(publicRecipe),
    repairIssue,
    history: listHistory,
    get activeRepairCount() {
      return activeRepairs.size;
    },
    get historyPath() {
      return historyPath;
    },
  });
}

export const __test = Object.freeze({
  REPAIR_SCHEMA_VERSION,
  OUTCOMES,
  RECIPES,
  workflowIdFromPreviewLabel,
  uniqueListenerPids,
  compactProcess,
  compactWorkflow,
});
