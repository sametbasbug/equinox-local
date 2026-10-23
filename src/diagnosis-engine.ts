type Severity = "info" | "warn" | "error" | "critical";
type IncidentState = "ATTENTION REQUIRED" | "ACTIVE" | "RECOVERING" | "RESOLVED";
type EventDetails = Record<string, unknown> & {
  label?: string; requestedPort?: unknown; recipeId?: string; exitCode?: number | null;
  signal?: string | null; profileId?: string; combinedVerdict?: string;
  childProcessIds?: string[];
};
type DiagnosisEvent = {
  eventId:string;timestamp:string;timestampMs:number;component:string;type:string;
  severity:Severity;status:string | null;projectId:string | null;correlationId:string | null;
  message:string | null;details:EventDetails;
};
type PortListener = {pid?:number | null;command?:string;endpoint?:string};
type ManagedProcess = {
  processId:string;label?:string;projectId?:string | null;running?:boolean;pid?:number;
  expectedPorts?:number[];createdAt?:string;exitedAt?:string | null;exitCode?:number | null;
  signal?:string | null;spawnError?:string | null;droppedChars?:number;
  cursor?:number;args?:string[];
};
type PortEvidence = {
  probe?:{listening?:boolean;[key:string]:unknown} | null;
  listeners?:PortListener[];lsofError?:string | null;managedProcesses?:ManagedProcess[];
  suggestedUrl?:string | null;error?:string | null;
};
type StepRecord = {id?:string;label?:string;status?:string;attempts?:number;error?:string};
type WorkflowRecord = {
  status?:string;steps?:StepRecord[];recipeId?:string;resumable?:boolean;
  [key:string]:unknown;
};
type IncidentDetails = Record<string, unknown>;
type Incident = {
  incidentId:string;code:string;title:string;summary:string;state:IncidentState;
  confidence:string;severity:Severity;component:string;relatedComponents:string[];
  projectId:string | null;correlationId:string | null;firstSeen:string;lastSeen:string;
  occurrences:number;recommendation:string;evidenceEventIds:string[];details:IncidentDetails;
};
type IncidentInput = {
  code:string;title:string;summary:string;state:IncidentState;
  confidence?:string;severity?:Severity;anchorEvent:DiagnosisEvent;
  firstSeenEvent?:DiagnosisEvent | null;evidence?:DiagnosisEvent[];recommendation:string;
  details?:IncidentDetails;
};
type BridgeIncidentInput = {
  events:DiagnosisEvent[];component:string;failureTypes:Set<string>;recoveryTypes:Set<string>;
  code:string;title:string;summary:string;recommendation:string;
};
type DiagnosisOptions = {
  windowMs?:number;projectId?:string | null;component?:string | null;
  includeResolved?:boolean;limit?:number;
};
type ReportOptions = {incidentId?:string;windowMs?:number};
type DiagnosisResult = {
  evaluatedAt:string;window:{start:string;end:string;windowMs:number};
  filters:{projectId:string | null;component:string | null;includeResolved:boolean;limit:number};
  health:unknown;bridgeSnapshot:unknown;eventCount:number;incidentCount:number;
  incidents:Incident[];note:string;
};
type DiagnosisDependencies = {
  observability:{
    query:(args:{sinceMs:number;untilMs:number;limit:number;newestFirst:boolean})=>Promise<DiagnosisEvent[]>;
    scan?:(args:{sinceMs:number;untilMs:number})=>Promise<DiagnosisEvent[]>;
    health?:(args:{windowMs:number})=>Promise<unknown>;
  };
  workflowManager?:{
    status?:(workflowId:string)=>WorkflowRecord;
    readLogs?:(args:{workflowId:string;cursor:number;maxBytes:number})=>Promise<{effectiveCursor:number;output:string}>;
  };
  processManager?:{
    list?:()=>ManagedProcess[];
    readLogs?:(args:{processId:string;cursor:number;maxChars:number;stripAnsiCodes:boolean;waitMs:number})=>Promise<{output:string}>;
  };
  inspectPort?:(port:number)=>Promise<PortEvidence>;
  getBridgeSnapshot?:()=>unknown;
  now?:()=>number;
};
type DiagnosisEngine = {
  diagnose:(options?:DiagnosisOptions)=>Promise<DiagnosisResult>;
  incidentReport:(options?:ReportOptions)=>Promise<unknown>;
};
type CodedError={message?:string};

const MAX_DIAGNOSIS_EVENTS = 10_000;
const COMPONENTS = Object.freeze([
  "runtime",
  "workflow",
  "process",
  "terminal",
  "release-gate",
  "deployment",
  "peekaboo",
  "chrome",
  "agent-browser",
]);

const SEVERITY_RANK = Object.freeze({
  info: 0,
  warn: 1,
  error: 2,
  critical: 3,
});

function cleanText(value:unknown,max=8_000):string {
  const text = String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/(authorization\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]");
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function severityMax(events:DiagnosisEvent[],fallback:Severity="warn"):Severity {
  let selected = fallback;
  for (const event of events) {
    if ((SEVERITY_RANK[event?.severity] ?? 0) > (SEVERITY_RANK[selected] ?? 0)) {
      selected = event.severity;
    }
  }
  return selected;
}

function compactEvent(event:DiagnosisEvent) {
  return {
    eventId: event.eventId,
    timestamp: event.timestamp,
    component: event.component,
    type: event.type,
    severity: event.severity,
    status: event.status,
    projectId: event.projectId,
    correlationId: event.correlationId,
    message: event.message,
    details: event.details ?? {},
  };
}

function incidentId(code:string,anchorEvent:DiagnosisEvent):string {
  const codePart = String(code).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  const eventPart = String(anchorEvent?.eventId ?? "unknown").replace(/^evt-/u, "").replace(/[^a-z0-9-]+/giu, "-");
  return `inc-${codePart}-${eventPart}`.slice(0, 180);
}

function relatedByCorrelation(events:DiagnosisEvent[],correlationId:string | null):DiagnosisEvent[] {
  if (!correlationId) return [];
  return events.filter((event) => event.correlationId === correlationId);
}

function sortIncidents(incidents:Incident[]):Incident[] {
  const stateRank = { "ATTENTION REQUIRED": 0, ACTIVE: 1, RECOVERING: 2, RESOLVED: 3 };
  return [...incidents].sort((left, right) => {
    const byState = (stateRank[left.state] ?? 9) - (stateRank[right.state] ?? 9);
    if (byState !== 0) return byState;
    const bySeverity = (SEVERITY_RANK[right.severity] ?? 0) - (SEVERITY_RANK[left.severity] ?? 0);
    if (bySeverity !== 0) return bySeverity;
    return Date.parse(right.lastSeen) - Date.parse(left.lastSeen);
  });
}

function buildIncident({
  code,
  title,
  summary,
  state,
  confidence = "HIGH",
  severity = "warn",
  anchorEvent,
  firstSeenEvent = null,
  evidence = [],
  recommendation,
  details = {},
}:IncidentInput):Incident {
  const evidenceEvents = evidence.length > 0 ? evidence : [anchorEvent];
  const timestamps = evidenceEvents.map((event) => event.timestampMs).filter(Number.isFinite);
  const firstSeenMs = Number.isFinite(firstSeenEvent?.timestampMs)
    ? firstSeenEvent!.timestampMs
    : Math.min(...timestamps);
  return {
    incidentId: incidentId(code, anchorEvent),
    code,
    title,
    summary: cleanText(summary, 4_000),
    state,
    confidence,
    severity,
    component: anchorEvent.component,
    relatedComponents: [...new Set(evidenceEvents.map((event) => event.component).filter(Boolean))],
    projectId: anchorEvent.projectId ?? null,
    correlationId: anchorEvent.correlationId ?? null,
    firstSeen: new Date(firstSeenMs).toISOString(),
    lastSeen: new Date(Math.max(...timestamps)).toISOString(),
    occurrences: evidenceEvents.filter((event) => event.type === anchorEvent.type).length || 1,
    recommendation: cleanText(recommendation, 2_000),
    evidenceEventIds: evidenceEvents.slice(-50).map((event) => event.eventId),
    details,
  };
}

function bridgeIncident({ events, component, failureTypes, recoveryTypes, code, title, summary, recommendation }:BridgeIncidentInput):Incident | null {
  const relevant = events.filter((event) =>
    event.component === component && (failureTypes.has(event.type) || recoveryTypes.has(event.type)),
  );
  const failures = relevant.filter((event) => failureTypes.has(event.type));
  if (failures.length === 0) return null;

  const anchor = failures.at(-1)!;
  const firstFailureMs = failures[0]!.timestampMs;
  const incidentEvidence = relevant.filter((event) => event.timestampMs >= firstFailureMs);
  const latest = incidentEvidence.at(-1) ?? anchor;
  const active = failureTypes.has(latest.type);
  const state = active && (anchor.severity === "critical" || anchor.status === "attention_required")
    ? "ATTENTION REQUIRED"
    : active
      ? "ACTIVE"
      : "RESOLVED";
  const repeated = failures.length > 1;

  return buildIncident({
    code,
    title,
    summary: repeated ? `${summary} Seçilen pencerede ${failures.length} kez tekrarlandı.` : summary,
    state,
    confidence: "HIGH",
    severity: severityMax(failures),
    anchorEvent: anchor,
    evidence: incidentEvidence,
    recommendation,
    details: {
      failureCount: failures.length,
      latestEventType: latest.type,
      latestEventStatus: latest.status,
    },
  });
}

function findWorkflowChildCrashes(events:DiagnosisEvent[],workflowId:string,failureTimestampMs:number):DiagnosisEvent[] {
  return events.filter((event) =>
    event.component === "process" &&
    event.type === "process.crashed" &&
    typeof event.details?.label === "string" &&
    event.details.label.includes(workflowId) &&
    Math.abs(event.timestampMs - failureTimestampMs) <= 30_000,
  );
}

function publicProcessRecord(record:ManagedProcess | null | undefined) {
  if (!record) return null;
  return {
    processId: record.processId,
    label: record.label,
    projectId: record.projectId,
    running: record.running,
    pid: record.pid,
    expectedPorts: record.expectedPorts,
    createdAt: record.createdAt,
    exitedAt: record.exitedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    spawnError: record.spawnError,
    droppedChars: record.droppedChars,
  };
}

function publicPortEvidence(value:PortEvidence | null | undefined) {
  if (!value || typeof value !== "object") return value ?? null;
  return {
    probe: value.probe ?? null,
    listeners: Array.isArray(value.listeners)
      ? value.listeners.slice(0, 50).map((listener) => ({
        pid: listener?.pid ?? null,
        command: cleanText(listener?.command, 200),
        endpoint: cleanText(listener?.endpoint, 300),
      }))
      : [],
    lsofError: value.lsofError ? cleanText(value.lsofError, 2_000) : null,
    managedProcesses: Array.isArray(value.managedProcesses)
      ? value.managedProcesses.map(publicProcessRecord).filter(Boolean)
      : [],
    suggestedUrl: value.suggestedUrl ? cleanText(value.suggestedUrl, 500) : null,
    error: value.error ? cleanText(value.error, 2_000) : null,
  };
}

export function createDiagnosisEngine({
  observability,
  workflowManager,
  processManager,
  inspectPort,
  getBridgeSnapshot = () => ({}),
  now = () => Date.now(),
}:DiagnosisDependencies = {} as DiagnosisDependencies):DiagnosisEngine {
  if (!observability || typeof observability.query !== "function") {
    throw new Error("Diagnosis engine observability kaynağı gerektirir.");
  }

  const scanEvents = async ({ sinceMs, untilMs }:{sinceMs:number;untilMs:number}):Promise<DiagnosisEvent[]> => {
    if (typeof observability.scan === "function") {
      const events = await observability.scan({ sinceMs, untilMs });
      return events.slice(-MAX_DIAGNOSIS_EVENTS);
    }
    return observability.query({
      sinceMs,
      untilMs,
      limit: 500,
      newestFirst: false,
    });
  };

  const workflowSnapshot = (workflowId:string):WorkflowRecord | null => {
    if (!workflowId || typeof workflowManager?.status !== "function") return null;
    try {
      return workflowManager.status(workflowId);
    } catch {
      return null;
    }
  };

  const diagnose = async ({
    windowMs = 60 * 60 * 1000,
    projectId = null,
    component = null,
    includeResolved = true,
    limit = 20,
  }:DiagnosisOptions = {}):Promise<DiagnosisResult> => {
    const end = now();
    const start = Math.max(0, end - windowMs);
    let events = await scanEvents({ sinceMs: start, untilMs: end });
    events = events
      .filter((event) => !projectId || event.projectId === projectId)
      .sort((left, right) => left.timestampMs - right.timestampMs);

    const incidents:Incident[] = [];
    const consumedEventIds = new Set<string>();

    // Release-preview port collisions get highest diagnostic priority because they often explain a later workflow failure.
    const portGroups = new Map<string,DiagnosisEvent[]>();
    for (const event of events.filter((item) => item.type === "release-gate.port_collision")) {
      const port = Number(event.details?.requestedPort);
      const key = `${event.projectId ?? "global"}:${Number.isInteger(port) ? port : "unknown"}`;
      const list = portGroups.get(key) ?? [];
      list.push(event);
      portGroups.set(key, list);
    }
    for (const group of portGroups.values()) {
      const anchor = group.at(-1)!;
      const port = Number(anchor.details?.requestedPort);
      const correlated = relatedByCorrelation(events, anchor.correlationId);
      correlated.forEach((event) => consumedEventIds.add(event.eventId));
      let livePort:PortEvidence | null = null;
      if (Number.isInteger(port) && port >= 1 && port <= 65535 && typeof inspectPort === "function") {
        livePort = await inspectPort(port).catch((error) => ({ error: cleanText(error?.message ?? error) }));
      }
      const stillListening = Boolean(livePort?.probe?.listening);
      const incident = buildIncident({
        code: "PREVIEW_PORT_OCCUPIED",
        title: `Release preview portu kullanımda${Number.isInteger(port) ? `: ${port}` : ""}`,
        summary: stillListening
          ? "Release preview başlatılamadı ve aynı port şu anda hâlâ dinleniyor."
          : "Release preview port çakışması kaydedildi; port artık dinlenmiyor, dolayısıyla olay geçmişte kalmış görünüyor.",
        state: stillListening ? "ACTIVE" : "RESOLVED",
        confidence: "HIGH",
        severity: severityMax(correlated, "warn"),
        anchorEvent: anchor,
        firstSeenEvent: group[0]!,
        evidence: [...group, ...correlated.filter((event) => event.eventId !== anchor.eventId)],
        recommendation: "Portu kullanan süreci doğrula; yalnızca sahipliği net olan stale preview/orphan süreç temizliği v4.0.2 repair tarifiyle yapılmalı.",
        details: {
          requestedPort: Number.isInteger(port) ? port : null,
          livePort: publicPortEvidence(livePort),
        },
      });
      incidents.push(incident);
    }

    // Workflow failures: correlate the workflow record and a child process crash if present.
    const workflowFailures = events.filter((event) =>
      event.component === "workflow" && ["workflow.failed", "workflow.engine_error"].includes(event.type),
    );
    const workflowIds = [...new Set(workflowFailures.map((event) => event.correlationId).filter(Boolean))] as string[];
    for (const workflowId of workflowIds) {
      const failures = workflowFailures.filter((event) => event.correlationId === workflowId);
      if (failures.some((event) => consumedEventIds.has(event.eventId))) continue;
      const anchor = failures.at(-1)!;
      const workflow = workflowSnapshot(workflowId);
      const childCrashes = findWorkflowChildCrashes(events, workflowId, anchor.timestampMs);
      const correlated = relatedByCorrelation(events, workflowId);
      const latestWorkflowEvent = correlated.at(-1) ?? anchor;
      const state = workflow?.status === "completed" || latestWorkflowEvent.type === "workflow.completed"
        ? "RESOLVED"
        : workflow?.status === "paused" || latestWorkflowEvent.type === "workflow.resumed"
          ? "RECOVERING"
          : "ACTIVE";
      const failedStep = workflow?.steps?.find((step) => step.status === "failed") ?? null;
      const hasChildCrash = childCrashes.length > 0;
      childCrashes.forEach((event) => consumedEventIds.add(event.eventId));
      correlated.forEach((event) => consumedEventIds.add(event.eventId));

      incidents.push(buildIncident({
        code: hasChildCrash ? "WORKFLOW_CHILD_PROCESS_CRASH" : "WORKFLOW_FAILURE",
        title: hasChildCrash ? "Workflow alt süreci çöktü" : "Workflow başarısız oldu",
        summary: hasChildCrash
          ? `Workflow ${workflowId} başarısızlığıyla aynı anda yönetilen bir child process crash olayı bulundu.`
          : `Workflow ${workflowId} başarısız oldu${failedStep?.label ? `; başarısız adım: ${failedStep.label}` : ""}.`,
        state,
        confidence: hasChildCrash ? "HIGH" : "MEDIUM",
        severity: severityMax([...failures, ...childCrashes], "error"),
        anchorEvent: anchor,
        firstSeenEvent: failures[0]!,
        evidence: [...correlated, ...childCrashes],
        recommendation: "Workflow ve ilgili process loglarını incele; sahiplik koşulları doğrulanıyorsa v4.0.2 orphan_process_cleanup veya stale_workflow_recover sabit recipe'leri açıkça çağrılabilir.",
        details: {
          workflowId,
          workflowStatus: workflow?.status ?? null,
          recipeId: workflow?.recipeId ?? anchor.details?.recipeId ?? null,
          failedStep: failedStep ? {
            id: failedStep.id,
            label: failedStep.label,
            attempts: failedStep.attempts,
            error: cleanText(failedStep.error, 2_000),
          } : null,
          childProcessIds: childCrashes.map((event) => event.correlationId),
        },
      }));
    }

    // Runtime restart veya kontrollü shutdown sonrası paused kalan resumable workflow'lar.
    const pausedWorkflowEvents = events.filter((event) =>
      event.type === "workflow.paused" || event.type === "workflow.interrupted",
    );
    const pausedWorkflowIds = [...new Set(pausedWorkflowEvents.map((event) => event.correlationId).filter(Boolean))] as string[];
    for (const workflowId of pausedWorkflowIds) {
      if (workflowIds.includes(workflowId)) continue;
      const pauses = pausedWorkflowEvents.filter((event) => event.correlationId === workflowId);
      const anchor = pauses.at(-1)!;
      const workflow = workflowSnapshot(workflowId);
      const correlated = relatedByCorrelation(events, workflowId);
      const latest = correlated.at(-1) ?? anchor;
      const state = workflow?.status === "paused"
        ? "ACTIVE"
        : ["queued", "running"].includes(workflow?.status as string) || latest.type === "workflow.resumed"
          ? "RECOVERING"
          : workflow?.status === "completed" || latest.type === "workflow.completed"
            ? "RESOLVED"
            : workflow?.status === "failed"
              ? "ACTIVE"
              : "RESOLVED";
      correlated.forEach((event) => consumedEventIds.add(event.eventId));
      incidents.push(buildIncident({
        code: "WORKFLOW_PAUSED",
        title: "Workflow paused durumda kaldı",
        summary: workflow?.status === "paused"
          ? `Workflow ${workflowId} runtime kesintisi/kapanışı sonrasında paused ve güvenli resume bekliyor.`
          : `Workflow ${workflowId} geçmişte paused oldu; güncel durum: ${workflow?.status ?? latest.status ?? "bilinmiyor"}.`,
        state,
        confidence: "HIGH",
        severity: "warn",
        anchorEvent: anchor,
        firstSeenEvent: pauses[0]!,
        evidence: correlated,
        recommendation: "Workflow resumable ve proje kökü değişmemişse v4.0.2 stale_workflow_recover tarifiyle guarded resume uygulanabilir.",
        details: {
          workflowId,
          workflowStatus: workflow?.status ?? null,
          recipeId: workflow?.recipeId ?? anchor.details?.recipeId ?? null,
          resumable: workflow?.resumable ?? false,
        },
      }));
    }

    // Uncorrelated process crashes.
    for (const anchor of events.filter((event) => event.type === "process.crashed")) {
      if (consumedEventIds.has(anchor.eventId)) continue;
      incidents.push(buildIncident({
        code: "MANAGED_PROCESS_CRASH",
        title: "Yönetilen arka plan süreci çöktü",
        summary: `${anchor.details?.label ?? anchor.correlationId ?? "Yönetilen süreç"} beklenmedik biçimde sonlandı.`,
        state: "RESOLVED",
        confidence: "HIGH",
        severity: anchor.severity ?? "error",
        anchorEvent: anchor,
        evidence: relatedByCorrelation(events, anchor.correlationId),
        recommendation: "Process logunu ve exit code/signal bilgisini incele; süreç bir terminal workflow'a ait orphan child ise yalnız v4.0.2 orphan_process_cleanup sahiplik doğrulamasıyla temizlenmeli.",
        details: {
          processId: anchor.correlationId,
          exitCode: anchor.details?.exitCode ?? null,
          signal: anchor.details?.signal ?? null,
          label: anchor.details?.label ?? null,
        },
      }));
    }

    const bridgeDefinitions = [
      {
        component: "agent-browser",
        failureTypes: new Set(["launch_failed"]),
        recoveryTypes: new Set(["launch_requested"]),
        code: "AGENT_BROWSER_LAUNCH_FAILURE",
        title: "Agent Browser başlatılamadı",
        summary: "İzole Agent Browser başlatılırken Chrome keşfi veya profil açılışı başarısız oldu.",
        recommendation: "Agent Browser launch error kaydını incele; Chrome kurulum yolu ve özel profil izinlerini kontrol et. Personal Chrome'a sessiz fallback yapılmaz.",
      },
      {
        component: "peekaboo",
        failureTypes: new Set(["peekaboo.error", "peekaboo.unexpected_close"]),
        recoveryTypes: new Set(["peekaboo.started", "peekaboo.reconnected"]),
        code: "PEEKABOO_TRANSPORT_FAILURE",
        title: "Peekaboo transport arızası",
        summary: "Peekaboo MCP child bridge bağlantısı hata verdi veya beklenmedik biçimde kapandı.",
        recommendation: "Transport arızası güncelse v4.0.2 peekaboo_bridge_restart sabit recipe'si compatibility ve macOS izinlerini yeniden doğrulayarak uygulanabilir.",
      },
      {
        component: "peekaboo",
        failureTypes: new Set(["peekaboo.permission_loss"]),
        recoveryTypes: new Set(["peekaboo.permissions_ok"]),
        code: "PEEKABOO_PERMISSION_LOSS",
        title: "Peekaboo macOS izni kayboldu",
        summary: "Screen Recording veya Accessibility izni kullanılamaz hale geldi.",
        recommendation: "macOS Privacy & Security izinlerini doğrula; izin değişikliği Equinox Local tarafından otomatik yapılmamalı.",
      },
      {
        component: "peekaboo",
        failureTypes: new Set(["peekaboo.compatibility_failure"]),
        recoveryTypes: new Set(["peekaboo.compatibility_ok"]),
        code: "PEEKABOO_COMPATIBILITY_FAILURE",
        title: "Peekaboo uyumluluk kapısı başarısız",
        summary: "Peekaboo sürümü veya MCP araç şeması Equinox Local güvenli yüzeyiyle uyumlu değil.",
        recommendation: "Peekaboo sürüm/şema değişimini incele; uyumluluk doğrulanmadan desktop mutasyonu yapılmamalı.",
      },
    ];
    for (const definition of bridgeDefinitions) {
      const incident = bridgeIncident({ events, ...definition });
      if (incident) incidents.push(incident);
    }

    // Failed deployments, grouped by managed deployment/run correlation id.
    const deploymentFailures = events.filter((event) => event.type === "deployment.failed");
    for (const correlationId of [...new Set(deploymentFailures.map((event) => event.correlationId).filter(Boolean))] as string[]) {
      const failures = deploymentFailures.filter((event) => event.correlationId === correlationId);
      const correlated = relatedByCorrelation(events, correlationId);
      const latest = (correlated.at(-1) ?? failures.at(-1))!;
      const recovered = latest.type === "deployment.completed";
      incidents.push(buildIncident({
        code: "DEPLOYMENT_FAILURE",
        title: "Deployment başarısız oldu",
        summary: failures.at(-1)!.message ?? "Deployment başarısızlık olayı kaydedildi.",
        state: recovered ? "RESOLVED" : "ACTIVE",
        confidence: "HIGH",
        severity: severityMax(failures, "error"),
        anchorEvent: failures.at(-1)!,
        evidence: correlated,
        recommendation: "Deployment loglarını incele. Diagnosis engine hiçbir deployment retry veya mutation başlatmaz.",
        details: {
          deploymentId: correlationId,
          profileId: failures.at(-1)!.details?.profileId ?? null,
          exitCode: failures.at(-1)!.details?.exitCode ?? null,
        },
      }));
    }

    // RED release gates that were not already consumed by a more specific root cause.
    for (const anchor of events.filter((event) =>
      event.type === "release-gate.verdict" && String(event.details?.combinedVerdict ?? event.status).toUpperCase() === "RED",
    )) {
      if (consumedEventIds.has(anchor.eventId)) continue;
      incidents.push(buildIncident({
        code: "RELEASE_GATE_RED",
        title: "Release quality gate RED",
        summary: "Release gate kalite veya readiness kontrollerinden biri hard failure verdi.",
        state: "ACTIVE",
        confidence: "HIGH",
        severity: anchor.severity ?? "error",
        anchorEvent: anchor,
        evidence: relatedByCorrelation(events, anchor.correlationId),
        recommendation: "release_report ve ilgili workflow loglarını incele; diagnosis engine candidate/deploy oluşturmaz.",
        details: anchor.details ?? {},
      }));
    }

    for (const anchor of events.filter((event) => event.type === "terminal.unexpected_exit")) {
      incidents.push(buildIncident({
        code: "PTY_UNEXPECTED_EXIT",
        title: "PTY terminal beklenmedik biçimde kapandı",
        summary: anchor.message ?? "PTY terminal oturumu beklenmedik biçimde sonlandı.",
        state: "RESOLVED",
        confidence: "HIGH",
        severity: anchor.severity ?? "warn",
        anchorEvent: anchor,
        evidence: relatedByCorrelation(events, anchor.correlationId),
        recommendation: "Terminal exit code/signal bilgisini incele; kullanıcı terminali otomatik yeniden açılmaz.",
        details: anchor.details ?? {},
      }));
    }

    const health = typeof observability.health === "function"
      ? await observability.health({ windowMs: Math.min(windowMs, 24 * 60 * 60 * 1000) })
      : null;
    const bridgeSnapshot = await Promise.resolve(getBridgeSnapshot()).catch(() => ({}));
    let filtered = sortIncidents(incidents);
    if (component) {
      filtered = filtered.filter((incident) =>
        incident.component === component || incident.relatedComponents.includes(component),
      );
    }
    if (!includeResolved) {
      filtered = filtered.filter((incident) => incident.state !== "RESOLVED");
    }
    filtered = filtered.slice(0, limit);

    return {
      evaluatedAt: new Date(end).toISOString(),
      window: {
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        windowMs,
      },
      filters: { projectId, component, includeResolved, limit },
      health,
      bridgeSnapshot,
      eventCount: events.length,
      incidentCount: filtered.length,
      incidents: filtered,
      note: "Diagnosis engine salt okunurdur; repair, restart, cleanup, Git veya deployment mutasyonu yapmaz.",
    };
  };

  const incidentReport = async ({ incidentId: requestedIncidentId, windowMs = 24 * 60 * 60 * 1000 }:ReportOptions = {}) => {
    const diagnosis = await diagnose({ windowMs, includeResolved: true, limit: 100 });
    const incident = diagnosis.incidents.find((item) => item.incidentId === requestedIncidentId);
    if (!incident) {
      throw new Error("Incident seçilen retention/zaman penceresinde bulunamadı.");
    }

    const end = now();
    const events = await scanEvents({ sinceMs: Math.max(0, end - windowMs), untilMs: end });
    const evidenceIds = new Set(incident.evidenceEventIds);
    let timeline = events.filter((event) => evidenceIds.has(event.eventId));
    if (incident.correlationId) {
      timeline = events.filter((event) =>
        evidenceIds.has(event.eventId) || event.correlationId === incident.correlationId,
      );
    }
    timeline = timeline.sort((left, right) => left.timestampMs - right.timestampMs).slice(-100);

    let workflow:WorkflowRecord | null = null;
    let workflowLogTail:string | null = null;
    if (incident.correlationId?.startsWith("wf-") && typeof workflowManager?.status === "function") {
      workflow = workflowSnapshot(incident.correlationId);
      if (workflow && typeof workflowManager?.readLogs === "function") {
        try {
          const sizeProbe = await workflowManager.readLogs({
            workflowId: incident.correlationId,
            cursor: Number.MAX_SAFE_INTEGER,
            maxBytes: 1,
          });
          const logs = await workflowManager.readLogs({
            workflowId: incident.correlationId,
            cursor: Math.max(0, sizeProbe.effectiveCursor - 12_000),
            maxBytes: 12_000,
          });
          workflowLogTail = cleanText(logs.output, 12_000);
        } catch {
          workflowLogTail = null;
        }
      }
    }

    const processIds = new Set<string>();
    for (const event of timeline) {
      if (event.component === "process" && event.correlationId) processIds.add(event.correlationId);
      for (const processId of event.details?.childProcessIds ?? []) processIds.add(processId);
    }
    for (const processId of (incident.details?.childProcessIds ?? []) as string[]) processIds.add(processId);

    const allProcesses = typeof processManager?.list === "function" ? processManager.list() : [];
    const processes:unknown[] = [];
    for (const processId of processIds) {
      const record = allProcesses.find((item) => item.processId === processId);
      if (!record) continue;
      let logTail:string | null = null;
      if (typeof processManager?.readLogs === "function") {
        try {
          const logs = await processManager.readLogs({
            processId,
            cursor: Math.max(0, (record.cursor ?? 0) - 8_000),
            maxChars: 8_000,
            stripAnsiCodes: true,
            waitMs: 0,
          });
          logTail = cleanText(logs.output, 8_000);
        } catch {
          logTail = null;
        }
      }
      processes.push({ ...publicProcessRecord(record), logTail });
    }

    let livePort = incident.details?.livePort ?? null;
    if (incident.code === "PREVIEW_PORT_OCCUPIED" && Number.isInteger(incident.details?.requestedPort) && typeof inspectPort === "function") {
      const inspected = await inspectPort(incident.details.requestedPort as number).catch((error) => ({ error: cleanText(error?.message ?? error) }));
      livePort = publicPortEvidence(inspected);
    }

    return {
      generatedAt: new Date(end).toISOString(),
      incident,
      timeline: timeline.map(compactEvent),
      currentEvidence: {
        health: diagnosis.health,
        bridgeSnapshot: await Promise.resolve(getBridgeSnapshot()).catch(() => ({})),
        livePort,
        workflow,
        workflowLogTail,
        processes,
      },
      limitations: [
        "Rapor yalnızca bounded observability retention içindeki olayları kullanır.",
        "Diagnosis engine salt okunurdur; root-cause önerileri repair komutu çalıştırmaz.",
      ],
    };
  };

  return Object.freeze({
    diagnose,
    incidentReport,
  });
}

export const __test = Object.freeze({
  COMPONENTS,
  cleanText,
  incidentId,
  bridgeIncident,
  findWorkflowChildCrashes,
});
