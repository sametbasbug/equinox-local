import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const RECOVERY_POLICY_SCHEMA_VERSION = 1;
const DEFAULT_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_CIRCUIT_OPEN_MS = 30 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_DIAGNOSIS_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HISTORY_LIMIT = 100;

const POLICIES = Object.freeze([
  Object.freeze({
    id: "peekaboo_transport_recover",
    label: "Recover Peekaboo transport",
    description: "Beklenmedik Peekaboo MCP child kapanmasında sabit bridge restart recipe'sini çalıştırır.",
    triggerTypes: Object.freeze(["peekaboo.unexpected_close"]),
    incidentCodes: Object.freeze(["PEEKABOO_TRANSPORT_FAILURE"]),
    recipeIds: Object.freeze(["peekaboo_bridge_restart"]),
    scope: "runtime-infrastructure",
    risk: "low",
    eventDelayMs: 100,
    startupReconcile: false,
    requireCorrelation: false,
  }),
  Object.freeze({
    id: "stale_preview_recover",
    label: "Recover stale release preview",
    description: "Release preview port collision sonrasında yalnız v4.0.2 ownership guard'ları geçerse stale managed preview sürecini temizler.",
    triggerTypes: Object.freeze(["release-gate.port_collision"]),
    incidentCodes: Object.freeze(["PREVIEW_PORT_OCCUPIED"]),
    recipeIds: Object.freeze(["stale_preview_cleanup"]),
    scope: "managed-process",
    risk: "low",
    eventDelayMs: 750,
    startupReconcile: false,
    requireCorrelation: true,
  }),
  Object.freeze({
    id: "workflow_failure_orphan_cleanup",
    label: "Clean failed-workflow orphan children",
    description: "Workflow failed olduğunda yalnız Equinox process manager tarafından workflow'a ait olduğu kanıtlanan orphan child süreçleri temizler; failed workflow'u otomatik resume etmez.",
    triggerTypes: Object.freeze(["workflow.failed"]),
    incidentCodes: Object.freeze(["WORKFLOW_FAILURE", "WORKFLOW_CHILD_PROCESS_CRASH"]),
    recipeIds: Object.freeze(["orphan_process_cleanup"]),
    scope: "managed-process",
    risk: "low",
    eventDelayMs: 250,
    startupReconcile: false,
    requireCorrelation: true,
  }),
  Object.freeze({
    id: "paused_workflow_recover",
    label: "Recover interrupted workflow",
    description: "Runtime kesintisi nedeniyle paused/interrupted kalan workflow'da önce orphan child cleanup, sonra project-root guard'lı safe resume çalıştırır.",
    triggerTypes: Object.freeze(["workflow.paused", "workflow.interrupted"]),
    incidentCodes: Object.freeze(["WORKFLOW_PAUSED"]),
    recipeIds: Object.freeze(["orphan_process_cleanup", "stale_workflow_recover"]),
    scope: "managed-workflow",
    risk: "low",
    eventDelayMs: 250,
    startupReconcile: true,
    requireCorrelation: true,
  }),
]);

const POLICY_MAP = new Map(POLICIES.map((policy) => [policy.id, policy]));

function iso(value) {
  return new Date(value).toISOString();
}

function publicPolicy(policy) {
  return {
    id: policy.id,
    label: policy.label,
    description: policy.description,
    triggerTypes: [...policy.triggerTypes],
    incidentCodes: [...policy.incidentCodes],
    recipeIds: [...policy.recipeIds],
    scope: policy.scope,
    risk: policy.risk,
    automatic: true,
    startupReconcile: policy.startupReconcile,
    arbitraryCommand: false,
    deploymentMutation: false,
    gitMutation: false,
    credentialMutation: false,
    projectFileMutation: false,
  };
}

function compactRepair(record) {
  if (!record) return null;
  return {
    repairId: record.repairId,
    recipeId: record.recipeId,
    incidentId: record.incidentId,
    incidentCode: record.incidentCode,
    outcome: record.outcome,
    actionStatus: record.actionStatus,
    summary: record.summary,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    durationMs: record.durationMs,
  };
}

function normalizeState(raw) {
  const output = {
    schemaVersion: RECOVERY_POLICY_SCHEMA_VERSION,
    updatedAt: null,
    circuits: {},
  };
  if (!raw || raw.schemaVersion !== RECOVERY_POLICY_SCHEMA_VERSION || typeof raw.circuits !== "object") {
    return output;
  }

  for (const [key, value] of Object.entries(raw.circuits).slice(0, 500)) {
    if (!value || typeof value !== "object") continue;
    if (!POLICY_MAP.has(value.policyId)) continue;
    if (typeof value.subjectKey !== "string" || value.subjectKey.length < 1 || value.subjectKey.length > 220) continue;
    output.circuits[key] = {
      policyId: value.policyId,
      subjectKey: value.subjectKey,
      failureTimestamps: Array.isArray(value.failureTimestamps)
        ? value.failureTimestamps.filter((item) => Number.isFinite(item)).slice(-20)
        : [],
      openUntilMs: Number.isFinite(value.openUntilMs) ? value.openUntilMs : null,
      lastAttemptAtMs: Number.isFinite(value.lastAttemptAtMs) ? value.lastAttemptAtMs : null,
      lastOutcome: typeof value.lastOutcome === "string" ? value.lastOutcome : null,
      lastIncidentId: typeof value.lastIncidentId === "string" ? value.lastIncidentId : null,
    };
  }
  return output;
}

function eventSubjectKey(policy, event) {
  if (policy.id === "peekaboo_transport_recover") return "peekaboo";
  const projectId = event?.projectId ?? "global";
  const correlation = event?.correlationId ?? null;
  if (correlation) return `${projectId}:${correlation}`;
  const port = Number(event?.details?.requestedPort);
  if (Number.isInteger(port)) return `${projectId}:port:${port}`;
  return `${projectId}:${policy.id}`;
}

function incidentSubjectKey(policy, incident) {
  if (policy.id === "peekaboo_transport_recover") return "peekaboo";
  const projectId = incident?.projectId ?? "global";
  const correlation = incident?.correlationId ?? incident?.details?.workflowId ?? null;
  if (correlation) return `${projectId}:${correlation}`;
  const port = Number(incident?.details?.requestedPort);
  if (Number.isInteger(port)) return `${projectId}:port:${port}`;
  return `${projectId}:${incident?.incidentId ?? policy.id}`;
}

function eventMatchesIncident(policy, event, incident) {
  if (!policy.incidentCodes.includes(incident?.code)) return false;
  if (event?.projectId && incident?.projectId && event.projectId !== incident.projectId) return false;
  if (policy.requireCorrelation && event?.correlationId) {
    return incident?.correlationId === event.correlationId || incident?.details?.workflowId === event.correlationId;
  }
  return true;
}

export function createRecoveryPolicyController({
  rootDir,
  diagnosisEngine,
  repairEngine,
  observability,
  now = () => Date.now(),
  randomId = () => randomUUID().slice(0, 10),
  failureWindowMs = DEFAULT_FAILURE_WINDOW_MS,
  circuitOpenMs = DEFAULT_CIRCUIT_OPEN_MS,
  maxFailures = DEFAULT_MAX_FAILURES,
  diagnosisWindowMs = DEFAULT_DIAGNOSIS_WINDOW_MS,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
    throw new Error("Recovery policy storage kökü mutlak yol olmalı.");
  }
  if (!diagnosisEngine || typeof diagnosisEngine.diagnose !== "function") {
    throw new Error("Recovery policy controller diagnosis engine gerektirir.");
  }
  if (!repairEngine || typeof repairEngine.repairIssue !== "function") {
    throw new Error("Recovery policy controller repair engine gerektirir.");
  }
  if (!observability || typeof observability.record !== "function" || typeof observability.query !== "function") {
    throw new Error("Recovery policy controller observability gerektirir.");
  }
  if (!Number.isInteger(maxFailures) || maxFailures < 2 || maxFailures > 10) {
    throw new Error("Recovery circuit failure sınırı geçersiz.");
  }
  if (!Number.isFinite(failureWindowMs) || failureWindowMs < 1_000) {
    throw new Error("Recovery circuit failure window geçersiz.");
  }
  if (!Number.isFinite(circuitOpenMs) || circuitOpenMs < 1_000) {
    throw new Error("Recovery circuit open süresi geçersiz.");
  }

  const statePath = path.join(rootDir, "recovery-policy-state.json");
  const activeJobs = new Map();
  let state = normalizeState(null);
  let initialized = false;
  let stopping = false;
  let writeTail = Promise.resolve();

  const emit = async (event) => observability.record({
    component: "recovery-policy",
    ...event,
  }).catch(() => null);

  const persistState = async () => {
    const snapshot = JSON.stringify({
      ...state,
      updatedAt: iso(now()),
    }, null, 2) + "\n";
    const operation = async () => {
      const temporary = `${statePath}.${process.pid}.${randomId()}.tmp`;
      await fs.writeFile(temporary, snapshot, { mode: 0o600 });
      await fs.rename(temporary, statePath);
      await fs.chmod(statePath, 0o600).catch(() => {});
    };
    const pending = writeTail.then(operation, operation);
    writeTail = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const initialize = async () => {
    if (initialized) return;
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(rootDir, 0o700).catch(() => {});
    try {
      state = normalizeState(JSON.parse(await fs.readFile(statePath, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      state = normalizeState(null);
      await persistState();
    }
    await fs.chmod(statePath, 0o600).catch(() => {});
    initialized = true;
  };

  const circuitKeyFor = (policy, subjectKey) => `${policy.id}|${subjectKey}`;

  const getCircuitRecord = (policy, subjectKey) => {
    const key = circuitKeyFor(policy, subjectKey);
    const current = state.circuits[key] ?? {
      policyId: policy.id,
      subjectKey,
      failureTimestamps: [],
      openUntilMs: null,
      lastAttemptAtMs: null,
      lastOutcome: null,
      lastIncidentId: null,
    };
    const cutoff = now() - failureWindowMs;
    current.failureTimestamps = current.failureTimestamps.filter((timestamp) => timestamp >= cutoff);
    state.circuits[key] = current;
    return { key, record: current };
  };

  const checkCircuit = async (policy, subjectKey, incidentId) => {
    const { key, record } = getCircuitRecord(policy, subjectKey);
    const timestamp = now();
    if (record.openUntilMs && record.openUntilMs > timestamp) {
      await emit({
        type: "recovery-policy.circuit_blocked",
        severity: "critical",
        status: "attention_required",
        projectId: null,
        correlationId: incidentId,
        message: `Automatic recovery circuit is open: ${policy.id} / ${subjectKey}`,
        details: {
          policyId: policy.id,
          subjectKey,
          circuitKey: key,
          incidentId,
          openUntil: iso(record.openUntilMs),
          failureCount: record.failureTimestamps.length,
        },
      });
      return { blocked: true, key, record };
    }
    if (record.openUntilMs && record.openUntilMs <= timestamp) {
      record.openUntilMs = null;
      record.failureTimestamps = record.failureTimestamps.filter((item) => item >= timestamp - failureWindowMs);
      await persistState();
      await emit({
        type: "recovery-policy.circuit_half_open",
        severity: "info",
        status: "recovering",
        correlationId: incidentId,
        message: `Automatic recovery circuit reopened for a single trial: ${policy.id} / ${subjectKey}`,
        details: {
          policyId: policy.id,
          subjectKey,
          circuitKey: key,
          incidentId,
        },
      });
    }
    return { blocked: false, key, record };
  };

  const noteFailure = async ({ policy, subjectKey, incidentId, outcome }) => {
    const { key, record } = getCircuitRecord(policy, subjectKey);
    const timestamp = now();
    record.failureTimestamps.push(timestamp);
    record.failureTimestamps = record.failureTimestamps.filter((item) => item >= timestamp - failureWindowMs).slice(-20);
    record.lastAttemptAtMs = timestamp;
    record.lastOutcome = outcome;
    record.lastIncidentId = incidentId;
    let opened = false;
    if (record.failureTimestamps.length >= maxFailures) {
      record.openUntilMs = timestamp + circuitOpenMs;
      opened = true;
    }
    await persistState();
    if (opened) {
      await emit({
        type: "recovery-policy.circuit_open",
        severity: "critical",
        status: "attention_required",
        correlationId: incidentId,
        message: `Automatic recovery was suspended: ${policy.id} / ${subjectKey}`,
        details: {
          policyId: policy.id,
          subjectKey,
          circuitKey: key,
          incidentId,
          failureCount: record.failureTimestamps.length,
          failureWindowMs,
          openUntil: iso(record.openUntilMs),
        },
      });
    }
    return { key, record, opened };
  };

  const noteSuccess = async ({ policy, subjectKey, incidentId }) => {
    const { key, record } = getCircuitRecord(policy, subjectKey);
    record.failureTimestamps = [];
    record.openUntilMs = null;
    record.lastAttemptAtMs = now();
    record.lastOutcome = "RECOVERED";
    record.lastIncidentId = incidentId;
    await persistState();
    return { key, record };
  };

  const runPolicyForIncident = async (policy, incident, { source = "event", sourceEvent = null } = {}) => {
    await initialize();
    if (stopping) return { status: "STOPPING", policyId: policy.id };
    const subjectKey = incidentSubjectKey(policy, incident);
    const circuitKey = circuitKeyFor(policy, subjectKey);
    if (activeJobs.has(circuitKey)) {
      await emit({
        type: "recovery-policy.coalesced",
        severity: "info",
        status: "recovering",
        projectId: incident.projectId ?? null,
        correlationId: incident.incidentId,
        message: `The same automatic recovery job is already active: ${policy.id} / ${subjectKey}`,
        details: { policyId: policy.id, subjectKey, circuitKey, incidentId: incident.incidentId },
      });
      return activeJobs.get(circuitKey).promise;
    }

    const metadata = {
      policyId: policy.id,
      subjectKey,
      circuitKey,
      incidentId: incident.incidentId,
      projectId: incident.projectId ?? null,
      startedAt: iso(now()),
      source,
    };

    const promise = (async () => {
      const gate = await checkCircuit(policy, subjectKey, incident.incidentId);
      if (gate.blocked || stopping) {
        return { status: gate.blocked ? "CIRCUIT_OPEN" : "STOPPING", policyId: policy.id, subjectKey };
      }

      await emit({
        type: "recovery-policy.attempt_started",
        severity: "info",
        status: "recovering",
        projectId: incident.projectId ?? null,
        correlationId: incident.incidentId,
        message: `Automatic recovery started: ${policy.id}`,
        details: {
          policyId: policy.id,
          subjectKey,
          circuitKey,
          incidentId: incident.incidentId,
          incidentCode: incident.code,
          source,
          sourceEventId: sourceEvent?.eventId ?? null,
        },
      });

      const repairs = [];
      for (const recipeId of policy.recipeIds) {
        if (stopping) {
          return { status: "STOPPING", policyId: policy.id, subjectKey, repairs };
        }
        const repair = await repairEngine.repairIssue({
          incidentId: incident.incidentId,
          recipeId,
        });
        repairs.push(compactRepair(repair));
        await emit({
          type: "recovery-policy.recipe_result",
          severity: repair.outcome === "RECOVERED" ? "info" : repair.outcome === "FAILED" ? "error" : "warn",
          status: repair.outcome === "RECOVERED" ? "recovering" : "degraded",
          projectId: incident.projectId ?? null,
          correlationId: incident.incidentId,
          message: `${policy.id}: ${recipeId} → ${repair.outcome}`,
          details: {
            policyId: policy.id,
            subjectKey,
            circuitKey,
            incidentId: incident.incidentId,
            recipeId,
            repairId: repair.repairId,
            outcome: repair.outcome,
            actionStatus: repair.actionStatus,
          },
        });
        if (repair.outcome !== "RECOVERED") {
          const failure = await noteFailure({
            policy,
            subjectKey,
            incidentId: incident.incidentId,
            outcome: repair.outcome,
          });
          await emit({
            type: "recovery-policy.failed",
            severity: repair.outcome === "FAILED" ? "error" : "warn",
            status: failure.opened ? "attention_required" : "degraded",
            projectId: incident.projectId ?? null,
            correlationId: incident.incidentId,
            message: `Automatic recovery did not complete: ${policy.id}`,
            details: {
              policyId: policy.id,
              subjectKey,
              circuitKey,
              incidentId: incident.incidentId,
              repairId: repair.repairId,
              outcome: repair.outcome,
              circuitOpened: failure.opened,
            },
          });
          return { status: failure.opened ? "CIRCUIT_OPEN" : "FAILED", policyId: policy.id, subjectKey, repairs };
        }
      }

      await noteSuccess({ policy, subjectKey, incidentId: incident.incidentId });
      await emit({
        type: "recovery-policy.recovered",
        severity: "info",
        status: "recovered",
        projectId: incident.projectId ?? null,
        correlationId: incident.incidentId,
        message: `Automatic recovery completed successfully: ${policy.id}`,
        details: {
          policyId: policy.id,
          subjectKey,
          circuitKey,
          incidentId: incident.incidentId,
          repairIds: repairs.map((repair) => repair?.repairId).filter(Boolean),
          recipeIds: [...policy.recipeIds],
        },
      });
      return { status: "RECOVERED", policyId: policy.id, subjectKey, repairs };
    })().finally(() => {
      activeJobs.delete(circuitKey);
    });

    activeJobs.set(circuitKey, { ...metadata, promise });
    return promise;
  };

  const findIncidentForEvent = async (policy, event) => {
    const diagnosis = await diagnosisEngine.diagnose({
      windowMs: diagnosisWindowMs,
      projectId: event?.projectId ?? null,
      includeResolved: false,
      limit: 50,
    });
    return diagnosis.incidents
      .filter((incident) => eventMatchesIncident(policy, event, incident))
      .sort((a, b) => Date.parse(b.lastSeen ?? b.firstSeen) - Date.parse(a.lastSeen ?? a.firstSeen))[0] ?? null;
  };

  const runPolicyForEvent = async (policy, event) => {
    if (stopping) return { status: "STOPPING", policyId: policy.id };
    if (policy.eventDelayMs > 0) await delay(policy.eventDelayMs);
    if (stopping) return { status: "STOPPING", policyId: policy.id };
    const incident = await findIncidentForEvent(policy, event);
    if (!incident) {
      const subjectKey = eventSubjectKey(policy, event);
      await emit({
        type: "recovery-policy.no_active_incident",
        severity: "info",
        status: "healthy",
        projectId: event?.projectId ?? null,
        correlationId: event?.correlationId ?? null,
        message: `No active incident remained after the automatic recovery trigger: ${policy.id}`,
        details: {
          policyId: policy.id,
          subjectKey,
          circuitKey: circuitKeyFor(policy, subjectKey),
          sourceEventId: event?.eventId ?? null,
          sourceEventType: event?.type ?? null,
        },
      });
      return { status: "NO_ACTIVE_INCIDENT", policyId: policy.id };
    }
    return runPolicyForIncident(policy, incident, { source: "event", sourceEvent: event });
  };

  const handleEvent = async (event) => {
    await initialize();
    if (stopping || !event || typeof event.type !== "string") return [];
    const policies = POLICIES.filter((policy) => policy.triggerTypes.includes(event.type));
    const results = [];
    for (const policy of policies) {
      results.push(await runPolicyForEvent(policy, event));
    }
    return results;
  };

  const reconcile = async () => {
    await initialize();
    if (stopping) return { status: "STOPPING", attempted: 0, results: [] };
    const policies = POLICIES.filter((policy) => policy.startupReconcile);
    const diagnosis = await diagnosisEngine.diagnose({
      windowMs: diagnosisWindowMs,
      includeResolved: false,
      limit: 50,
    });
    const results = [];
    const seen = new Set();
    for (const policy of policies) {
      for (const incident of diagnosis.incidents) {
        if (!policy.incidentCodes.includes(incident.code)) continue;
        const key = `${policy.id}:${incident.incidentId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(await runPolicyForIncident(policy, incident, { source: "startup-reconcile" }));
      }
    }
    await emit({
      type: "recovery-policy.reconcile_completed",
      severity: "info",
      status: "healthy",
      message: `Startup automatic recovery reconciliation completed: ${results.length} incidents processed.`,
      details: {
        attempted: results.length,
        recovered: results.filter((item) => item?.status === "RECOVERED").length,
      },
    });
    return { status: "COMPLETED", attempted: results.length, results };
  };

  const status = async () => {
    await initialize();
    const timestamp = now();
    const circuits = Object.entries(state.circuits).map(([key, record]) => {
      const failures = record.failureTimestamps.filter((item) => item >= timestamp - failureWindowMs);
      const open = Boolean(record.openUntilMs && record.openUntilMs > timestamp);
      return {
        circuitKey: key,
        policyId: record.policyId,
        subjectKey: record.subjectKey,
        state: open ? "OPEN" : "CLOSED",
        failureCount: failures.length,
        maxFailures,
        failureWindowMs,
        openUntil: open ? iso(record.openUntilMs) : null,
        lastAttemptAt: record.lastAttemptAtMs ? iso(record.lastAttemptAtMs) : null,
        lastOutcome: record.lastOutcome,
        lastIncidentId: record.lastIncidentId,
      };
    }).sort((a, b) => Number(b.state === "OPEN") - Number(a.state === "OPEN") || a.circuitKey.localeCompare(b.circuitKey));
    return {
      enabled: !stopping,
      policyCount: POLICIES.length,
      activeJobCount: activeJobs.size,
      activeJobs: [...activeJobs.values()].map(({ promise: _promise, ...metadata }) => metadata),
      openCircuitCount: circuits.filter((item) => item.state === "OPEN").length,
      circuits,
      circuitBreaker: {
        maxFailures,
        failureWindowMs,
        circuitOpenMs,
      },
      statePath,
    };
  };

  const history = async ({ limit = DEFAULT_HISTORY_LIMIT, policyId = null, type = null } = {}) => {
    await initialize();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Recovery history limit 1-500 arasında olmalı.");
    }
    if (policyId && !POLICY_MAP.has(policyId)) {
      throw new Error(`Bilinmeyen recovery policy: ${policyId}`);
    }
    const fetchLimit = Math.min(500, Math.max(limit * 5, 50));
    const events = await observability.query({
      component: "recovery-policy",
      limit: fetchLimit,
      newestFirst: true,
    });
    return events
      .filter((event) => !policyId || event.details?.policyId === policyId)
      .filter((event) => !type || event.type === type)
      .slice(0, limit);
  };

  const shutdown = async ({ timeoutMs = 5_000 } = {}) => {
    stopping = true;
    const jobs = [...activeJobs.values()].map((entry) => entry.promise);
    if (jobs.length === 0) return;
    await Promise.race([
      Promise.allSettled(jobs),
      delay(timeoutMs),
    ]).catch(() => {});
  };

  return Object.freeze({
    initialize,
    handleEvent,
    reconcile,
    status,
    history,
    shutdown,
    policies: () => POLICIES.map(publicPolicy),
    get activeJobCount() {
      return activeJobs.size;
    },
    get statePath() {
      return statePath;
    },
  });
}

export const __test = Object.freeze({
  RECOVERY_POLICY_SCHEMA_VERSION,
  DEFAULT_FAILURE_WINDOW_MS,
  DEFAULT_CIRCUIT_OPEN_MS,
  DEFAULT_MAX_FAILURES,
  POLICIES,
  eventSubjectKey,
  incidentSubjectKey,
  eventMatchesIncident,
  normalizeState,
});
