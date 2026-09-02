import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const JANITOR_SCHEMA_VERSION = 1;
const HISTORY_LIMIT = 500;
const MAX_TREE_ENTRIES = 20_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 6 * HOUR;
const DEFAULT_STARTUP_DELAY_MS = 10_000;

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const WORKFLOW_ID_PATTERN = /^wf-[a-z0-9-]{6,80}$/u;
const ROTATED_EVENT_PATTERN = /^events-\d{13}-[a-z0-9-]+\.jsonl$/u;
const SHA40_PATTERN = /^[a-f0-9]{40}$/u;

export const JANITOR_CATEGORIES = Object.freeze([
  Object.freeze({
    id: "terminal_records",
    label: "Old terminal bookkeeping records",
    description: "Çalışmayan PTY kayıtlarını yalnız 1 saatlik retention sonrasında bellekten kaldırır.",
    retentionMs: HOUR,
    keepNewest: 0,
    storage: "memory",
  }),
  Object.freeze({
    id: "process_records",
    label: "Old process bookkeeping records",
    description: "Çalışmayan managed-process kayıtlarını yalnız 1 saatlik retention sonrasında bellekten kaldırır.",
    retentionMs: HOUR,
    keepNewest: 0,
    storage: "memory",
  }),
  Object.freeze({
    id: "workflow_records",
    label: "Old workflow records",
    description: "Terminal durumdaki workflow state+log çiftlerini 14 gün sonra temizler; en yeni 20 terminal workflow ve release provenance kayıtları korunur.",
    retentionMs: 14 * DAY,
    keepNewest: 20,
    storage: "disk",
  }),
  Object.freeze({
    id: "visual_regression",
    label: "Old visual regression artifacts",
    description: "Visual-regression altındaki runtime-owned artifact dizinlerini son değişiklikten 14 gün sonra temizler.",
    retentionMs: 14 * DAY,
    keepNewest: 0,
    storage: "disk",
  }),
  Object.freeze({
    id: "browser_screenshots",
    label: "Ephemeral browser screenshots",
    description: "Equinox Browser runtime-owned screenshot capture dizinlerini son değişiklikten 1 saat sonra temizler.",
    retentionMs: HOUR,
    keepNewest: 0,
    storage: "disk",
  }),
  Object.freeze({
    id: "release_runs",
    label: "Old release run artifacts",
    description: "Release run screenshot/diff dizinlerini 14 gün sonra temizler; aktif veya current baseline/latest candidate provenance workflow'ları korunur.",
    retentionMs: 14 * DAY,
    keepNewest: 0,
    storage: "disk",
  }),
  Object.freeze({
    id: "release_baseline_sets",
    label: "Old release baseline sets",
    description: "Current baseline set dışındaki immutable baseline setlerini 30 gün sonra temizler.",
    retentionMs: 30 * DAY,
    keepNewest: 0,
    storage: "disk",
  }),
  Object.freeze({
    id: "release_candidates",
    label: "Old release candidates",
    description: "Her projenin en yeni release candidate manifestini korur; daha eski candidate manifestlerini 30 gün sonra temizler.",
    retentionMs: 30 * DAY,
    keepNewest: 1,
    storage: "disk",
  }),
  Object.freeze({
    id: "rollback_bundles",
    label: "Old rollback bundles",
    description: "Current baseline/latest candidate HEAD ve her projenin en yeni rollback snapshot'ını korur; diğer bundle+manifest çiftlerini 30 gün sonra temizler.",
    retentionMs: 30 * DAY,
    keepNewest: 1,
    storage: "disk",
  }),
  Object.freeze({
    id: "stale_worktrees",
    label: "Prunable managed worktree metadata",
    description: "Yalnız Equinox-managed, Git tarafından prunable işaretli, diskte yolu kalmamış ve aktif terminal/process referansı olmayan worktree metadata kayıtlarını prune eder. Branch silmez.",
    retentionMs: 0,
    keepNewest: 0,
    storage: "git-metadata",
  }),
  Object.freeze({
    id: "observability_segments",
    label: "Old observability segments",
    description: "Aktif events-current.jsonl dosyasına dokunmadan yalnız rotate edilmiş event segmentlerini 7 gün sonra temizler.",
    retentionMs: 7 * DAY,
    keepNewest: 0,
    storage: "disk",
  }),
]);

const CATEGORY_MAP = new Map(JANITOR_CATEGORIES.map((item) => [item.id, item]));
const HISTORY_OUTCOMES = new Set([
  "CLEANED",
  "SKIPPED_ALREADY_CLEAN",
  "REFUSED_STALE_PREVIEW",
  "PARTIAL",
  "FAILED",
]);

function iso(value) {
  return new Date(value).toISOString();
}

function parseTime(value) {
  const parsed = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function safeRelative(workspaceRoot, target) {
  if (!isInside(workspaceRoot, target)) {
    throw new Error("Janitor runtime yolu workspace dışına çıkıyor.");
  }
  return path.relative(workspaceRoot, target) || ".";
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonSafe(target) {
  const stat = await lstatOrNull(target);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) {
    return null;
  }
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch {
    return null;
  }
}

async function measureTree({ root, target }) {
  if (!isInside(root, target)) {
    throw new Error("Janitor ölçüm yolu izinli root dışına çıkıyor.");
  }

  const top = await lstatOrNull(target);
  if (!top) {
    return {
      exists: false,
      bytes: 0,
      fileCount: 0,
      directoryCount: 0,
      mtimeMs: 0,
      fingerprint: sha256("missing"),
      unsafeReason: null,
    };
  }
  if (top.isSymbolicLink()) {
    return {
      exists: true,
      bytes: 0,
      fileCount: 0,
      directoryCount: 0,
      mtimeMs: top.mtimeMs,
      fingerprint: sha256("symlink"),
      unsafeReason: "SYMLINK",
    };
  }

  const entries = [];
  let bytes = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let mtimeMs = top.mtimeMs;
  let seen = 0;
  let unsafeReason = null;

  const walk = async (current) => {
    if (unsafeReason) return;
    seen += 1;
    if (seen > MAX_TREE_ENTRIES) {
      unsafeReason = "TREE_ENTRY_LIMIT";
      return;
    }

    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      unsafeReason = "SYMLINK";
      return;
    }
    const relative = path.relative(target, current) || ".";
    mtimeMs = Math.max(mtimeMs, stat.mtimeMs);

    if (stat.isDirectory()) {
      directoryCount += 1;
      entries.push([relative, "d", 0, Math.floor(stat.mtimeMs)]);
      const children = await fs.readdir(current, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        await walk(path.join(current, child.name));
        if (unsafeReason) return;
      }
      return;
    }

    if (!stat.isFile()) {
      unsafeReason = "NON_REGULAR_ENTRY";
      return;
    }
    fileCount += 1;
    bytes += stat.size;
    entries.push([relative, "f", stat.size, Math.floor(stat.mtimeMs)]);
  };

  await walk(target);
  return {
    exists: true,
    bytes,
    fileCount,
    directoryCount,
    mtimeMs,
    fingerprint: sha256(canonical(entries)),
    unsafeReason,
  };
}

async function measureTargets({ workspaceRoot, targets }) {
  const measured = [];
  let bytes = 0;
  let fileCount = 0;
  let mtimeMs = 0;
  let unsafeReason = null;

  for (const item of targets) {
    const result = await measureTree({ root: item.root, target: item.target });
    measured.push({
      relativePath: safeRelative(workspaceRoot, item.target),
      ...result,
    });
    bytes += result.bytes;
    fileCount += result.fileCount;
    mtimeMs = Math.max(mtimeMs, result.mtimeMs);
    unsafeReason ||= result.unsafeReason;
  }

  return {
    bytes,
    fileCount,
    mtimeMs,
    unsafeReason,
    fingerprint: sha256(canonical(measured.map((item) => ({
      relativePath: item.relativePath,
      exists: item.exists,
      bytes: item.bytes,
      fileCount: item.fileCount,
      mtimeMs: Math.floor(item.mtimeMs),
      fingerprint: item.fingerprint,
      unsafeReason: item.unsafeReason,
    })))),
    measured,
  };
}

function ageEligible(timestampMs, retentionMs, nowMs) {
  return Number.isFinite(timestampMs) && timestampMs > 0 && nowMs - timestampMs >= retentionMs;
}

function makeCandidate({
  category,
  id,
  projectId = null,
  bytes = 0,
  fileCount = 0,
  lastModifiedMs = 0,
  workspaceRelativePath = null,
  fingerprint,
  measuredFingerprint = null,
  estimatedBytes = false,
  metadata = {},
  targets = [],
}) {
  return {
    category,
    id,
    projectId,
    bytes,
    fileCount,
    lastModifiedMs,
    workspaceRelativePath,
    fingerprint,
    estimatedBytes,
    metadata,
    _targets: targets,
    _measuredFingerprint:
      measuredFingerprint ??
      (targets.length > 0 ? fingerprint : null),
  };
}

function publicCandidate(item) {
  return {
    id: item.id,
    projectId: item.projectId,
    bytes: item.bytes,
    fileCount: item.fileCount,
    lastModifiedAt: item.lastModifiedMs > 0 ? iso(item.lastModifiedMs) : null,
    workspaceRelativePath: item.workspaceRelativePath,
    estimatedBytes: item.estimatedBytes,
    metadata: item.metadata,
  };
}

function publicProtected(item) {
  return {
    id: item.id,
    projectId: item.projectId ?? null,
    reason: item.reason,
    workspaceRelativePath: item.workspaceRelativePath ?? null,
    metadata: item.metadata ?? {},
  };
}

function cleanupToken(categoryId, candidates) {
  const descriptor = candidates
    .map((item) => ({
      id: item.id,
      projectId: item.projectId,
      bytes: item.bytes,
      fileCount: item.fileCount,
      lastModifiedMs: Math.floor(item.lastModifiedMs || 0),
      workspaceRelativePath: item.workspaceRelativePath,
      fingerprint: item.fingerprint,
      metadata: item.metadata,
    }))
    .sort((a, b) => `${a.projectId ?? ""}:${a.id}`.localeCompare(`${b.projectId ?? ""}:${b.id}`));
  return `jt-${sha256(canonical({ schemaVersion: JANITOR_SCHEMA_VERSION, categoryId, descriptor }))}`;
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
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.schemaVersion === JANITOR_SCHEMA_VERSION) records.push(parsed);
    } catch {
      // Bounded janitor history yalnız geçerli kendi kayıtlarını kullanır.
    }
  }
  return records;
}

export function createRuntimeJanitor({
  rootDir,
  workspaceRoot,
  workflowRoot,
  visualRoot,
  browserScreenshotRoot,
  releaseGateRoot,
  observabilityRoot,
  terminalManager,
  processManager,
  workflowManager,
  observability,
  listManagedWorktrees = async () => [],
  pruneManagedWorktrees = async () => ({ pruned: [] }),
  runExclusive = async (task) => task(),
  now = () => Date.now(),
  randomId = () => randomUUID().slice(0, 10),
  maxHistoryRecords = HISTORY_LIMIT,
  maintenanceIntervalMs = DEFAULT_MAINTENANCE_INTERVAL_MS,
  startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const roots = [rootDir, workspaceRoot, workflowRoot, visualRoot, browserScreenshotRoot, releaseGateRoot, observabilityRoot];
  if (roots.some((item) => typeof item !== "string" || !path.isAbsolute(item))) {
    throw new Error("Runtime janitor bütün storage köklerini mutlak yol olarak gerektirir.");
  }
  for (const runtimeRoot of [workflowRoot, visualRoot, browserScreenshotRoot, releaseGateRoot, observabilityRoot, rootDir]) {
    if (!isInside(workspaceRoot, runtimeRoot)) {
      throw new Error("Runtime janitor storage kökü workspace dışında olamaz.");
    }
  }
  if (!terminalManager?.list || !terminalManager?.stop) throw new Error("Runtime janitor terminal manager gerektirir.");
  if (!processManager?.list || !processManager?.stop) throw new Error("Runtime janitor process manager gerektirir.");
  if (!workflowManager?.list || !workflowManager?.removeTerminalRecord) throw new Error("Runtime janitor workflow manager cleanup API gerektirir.");
  if (!observability?.record) throw new Error("Runtime janitor observability gerektirir.");
  if (typeof runExclusive !== "function") throw new Error("Runtime janitor exclusive mutation wrapper gerektirir.");
  if (!Number.isInteger(maintenanceIntervalMs) || maintenanceIntervalMs < 60_000) {
    throw new Error("Runtime janitor maintenance interval en az 60000 ms olmalı.");
  }
  if (!Number.isInteger(startupDelayMs) || startupDelayMs < 0 || startupDelayMs > maintenanceIntervalMs) {
    throw new Error("Runtime janitor startup delay geçersiz.");
  }

  const historyPath = path.join(rootDir, "janitor-history.jsonl");
  const activeCategories = new Set();
  let initialized = false;
  let maintenanceEnabled = false;
  let maintenanceActive = false;
  let maintenanceTimer = null;
  let nextMaintenanceAtMs = null;
  let lastMaintenance = null;

  const schedulerStatus = () => ({
    enabled: maintenanceEnabled,
    active: maintenanceActive,
    intervalMs: maintenanceIntervalMs,
    startupDelayMs,
    nextRunAt: nextMaintenanceAtMs === null ? null : iso(nextMaintenanceAtMs),
    lastRun: lastMaintenance ? { ...lastMaintenance } : null,
  });

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

  const emit = async (event) => {
    await observability.record({ component: "janitor", ...event }).catch(() => {});
  };

  const appendHistory = async (record) => {
    await initialize();
    const records = await readHistoryFile(historyPath);
    const next = [...records, record].slice(-maxHistoryRecords);
    const temp = `${historyPath}.${process.pid}.${randomId()}.tmp`;
    await fs.writeFile(temp, next.map((item) => JSON.stringify(item)).join("\n") + (next.length ? "\n" : ""), { mode: 0o600 });
    await fs.rename(temp, historyPath);
    await fs.chmod(historyPath, 0o600).catch(() => {});
  };

  const history = async ({ limit = 50, category = null, outcome = null } = {}) => {
    await initialize();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Janitor history limit 1-500 arasında olmalı.");
    if (category && !CATEGORY_MAP.has(category)) throw new Error(`Bilinmeyen janitor kategorisi: ${category}`);
    if (outcome && !HISTORY_OUTCOMES.has(outcome)) throw new Error(`Bilinmeyen janitor outcome: ${outcome}`);
    const records = await readHistoryFile(historyPath);
    return records
      .filter((item) => !category || item.category === category)
      .filter((item) => !outcome || item.outcome === outcome)
      .slice(-limit)
      .reverse();
  };

  const releaseContext = async () => {
    const currentBaselineByProject = new Map();
    const latestCandidateByProject = new Map();
    const latestSnapshotByProject = new Map();
    const projects = new Set();

    for (const child of ["baselines", "candidates", "snapshots"]) {
      const directory = path.join(releaseGateRoot, child);
      let entries = [];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && /^[a-z0-9_]+$/u.test(entry.name)) projects.add(entry.name);
      }
    }

    for (const projectId of projects) {
      const currentPath = path.join(releaseGateRoot, "baselines", projectId, "current.json");
      const current = await readJsonSafe(currentPath);
      if (current?.projectId === projectId && typeof current?.setId === "string") {
        currentBaselineByProject.set(projectId, current);
      }

      const candidateDir = path.join(releaseGateRoot, "candidates", projectId);
      let candidateEntries = [];
      try {
        candidateEntries = await fs.readdir(candidateDir, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const candidates = [];
      for (const entry of candidateEntries) {
        if (!entry.isFile() || entry.isSymbolicLink?.() || !entry.name.endsWith(".json")) continue;
        const candidate = await readJsonSafe(path.join(candidateDir, entry.name));
        if (candidate?.projectId === projectId && typeof candidate?.candidateId === "string" && parseTime(candidate.createdAt)) {
          candidates.push({ candidate, path: path.join(candidateDir, entry.name) });
        }
      }
      candidates.sort((a, b) => parseTime(b.candidate.createdAt) - parseTime(a.candidate.createdAt));
      if (candidates[0]) latestCandidateByProject.set(projectId, candidates[0]);

      const snapshotDir = path.join(releaseGateRoot, "snapshots", projectId);
      let snapshotEntries = [];
      try {
        snapshotEntries = await fs.readdir(snapshotDir, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const snapshots = [];
      for (const entry of snapshotEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const manifest = await readJsonSafe(path.join(snapshotDir, entry.name));
        if (manifest?.projectId === projectId && SHA40_PATTERN.test(String(manifest?.headSha ?? "").toLowerCase()) && parseTime(manifest.createdAt)) {
          snapshots.push({ manifest, path: path.join(snapshotDir, entry.name) });
        }
      }
      snapshots.sort((a, b) => parseTime(b.manifest.createdAt) - parseTime(a.manifest.createdAt));
      if (snapshots[0]) latestSnapshotByProject.set(projectId, snapshots[0]);
    }

    const protectedWorkflowIds = new Set();
    const protectedHeads = new Map();
    for (const [projectId, baseline] of currentBaselineByProject.entries()) {
      if (WORKFLOW_ID_PATTERN.test(String(baseline.sourceWorkflowId ?? ""))) protectedWorkflowIds.add(baseline.sourceWorkflowId);
      const set = protectedHeads.get(projectId) ?? new Set();
      if (SHA40_PATTERN.test(String(baseline.headSha ?? "").toLowerCase())) set.add(String(baseline.headSha).toLowerCase());
      protectedHeads.set(projectId, set);
    }
    for (const [projectId, wrapped] of latestCandidateByProject.entries()) {
      const candidate = wrapped.candidate;
      if (WORKFLOW_ID_PATTERN.test(String(candidate.workflowId ?? ""))) protectedWorkflowIds.add(candidate.workflowId);
      const set = protectedHeads.get(projectId) ?? new Set();
      if (SHA40_PATTERN.test(String(candidate.headSha ?? "").toLowerCase())) set.add(String(candidate.headSha).toLowerCase());
      protectedHeads.set(projectId, set);
    }

    return {
      projects,
      currentBaselineByProject,
      latestCandidateByProject,
      latestSnapshotByProject,
      protectedWorkflowIds,
      protectedHeads,
    };
  };

  const baseContext = async () => {
    const workflows = workflowManager.list({ state: "all" });
    const activeWorkflowIds = new Set(
      workflows.filter((item) => ["queued", "running", "paused"].includes(item.status)).map((item) => item.workflowId),
    );
    return {
      workflows,
      activeWorkflowIds,
      release: await releaseContext(),
      terminals: terminalManager.list(),
      processes: processManager.list(),
    };
  };

  const scanTerminalRecords = async (context, policy, nowMs) => {
    const candidates = [];
    const protectedItems = [];
    for (const item of context.terminals) {
      const exitedMs = parseTime(item.exitedAt);
      if (item.running) {
        protectedItems.push({ id: item.sessionId, reason: "ACTIVE_TERMINAL", metadata: { label: item.label } });
      } else if (!ageEligible(exitedMs, policy.retentionMs, nowMs)) {
        protectedItems.push({ id: item.sessionId, reason: "RETENTION_WINDOW", metadata: { label: item.label, exitedAt: item.exitedAt } });
      } else {
        const fingerprint = sha256(canonical({
          sessionId: item.sessionId,
          cwd: item.cwd,
          exitedAt: item.exitedAt,
          cursor: item.cursor,
          bufferedChars: item.bufferedChars,
          droppedChars: item.droppedChars,
        }));
        candidates.push(makeCandidate({
          category: policy.id,
          id: item.sessionId,
          projectId: item.projectId,
          bytes: Number(item.bufferedChars ?? 0),
          lastModifiedMs: exitedMs,
          fingerprint,
          estimatedBytes: true,
          metadata: { label: item.label, exitedAt: item.exitedAt },
        }));
      }
    }
    return { candidates, protectedItems };
  };

  const scanProcessRecords = async (context, policy, nowMs) => {
    const candidates = [];
    const protectedItems = [];
    for (const item of context.processes) {
      const exitedMs = parseTime(item.exitedAt);
      if (item.running) {
        protectedItems.push({ id: item.processId, reason: "ACTIVE_PROCESS", metadata: { label: item.label } });
      } else if (!ageEligible(exitedMs, policy.retentionMs, nowMs)) {
        protectedItems.push({ id: item.processId, reason: "RETENTION_WINDOW", metadata: { label: item.label, exitedAt: item.exitedAt } });
      } else {
        const fingerprint = sha256(canonical({
          processId: item.processId,
          pid: item.pid,
          cwd: item.cwd,
          exitedAt: item.exitedAt,
          cursor: item.cursor,
          bufferedChars: item.bufferedChars,
          droppedChars: item.droppedChars,
        }));
        candidates.push(makeCandidate({
          category: policy.id,
          id: item.processId,
          projectId: item.projectId,
          bytes: Number(item.bufferedChars ?? 0),
          lastModifiedMs: exitedMs,
          fingerprint,
          estimatedBytes: true,
          metadata: { label: item.label, exitedAt: item.exitedAt },
        }));
      }
    }
    return { candidates, protectedItems };
  };

  const scanWorkflowRecords = async (context, policy, nowMs) => {
    const candidates = [];
    const protectedItems = [];
    const terminal = context.workflows
      .filter((item) => TERMINAL_STATES.has(item.status))
      .sort((a, b) => (parseTime(b.updatedAt) ?? 0) - (parseTime(a.updatedAt) ?? 0));
    const newestFloor = new Set(terminal.slice(0, policy.keepNewest).map((item) => item.workflowId));

    for (const item of context.workflows) {
      const targetState = path.join(workflowRoot, `${item.workflowId}.json`);
      const targetLog = path.join(workflowRoot, `${item.workflowId}.log`);
      const relative = safeRelative(workspaceRoot, targetState);
      const updatedMs = parseTime(item.completedAt ?? item.updatedAt ?? item.createdAt);
      let reason = null;
      if (!TERMINAL_STATES.has(item.status)) reason = "ACTIVE_OR_RESUMABLE_WORKFLOW";
      else if (context.release.protectedWorkflowIds.has(item.workflowId)) reason = "RELEASE_PROVENANCE";
      else if (newestFloor.has(item.workflowId)) reason = "NEWEST_RETENTION_FLOOR";
      else if (!ageEligible(updatedMs, policy.retentionMs, nowMs)) reason = "RETENTION_WINDOW";

      if (reason) {
        protectedItems.push({ id: item.workflowId, projectId: item.projectId, reason, workspaceRelativePath: relative, metadata: { status: item.status, updatedAt: item.updatedAt } });
        continue;
      }

      const targets = [
        { root: workflowRoot, target: targetState },
        { root: workflowRoot, target: targetLog },
      ];
      const measured = await measureTargets({ workspaceRoot, targets });
      if (measured.unsafeReason) {
        protectedItems.push({ id: item.workflowId, projectId: item.projectId, reason: `UNSAFE_TREE_${measured.unsafeReason}`, workspaceRelativePath: relative });
        continue;
      }
      candidates.push(makeCandidate({
        category: policy.id,
        id: item.workflowId,
        projectId: item.projectId,
        bytes: measured.bytes,
        fileCount: measured.fileCount,
        lastModifiedMs: updatedMs,
        workspaceRelativePath: relative,
        fingerprint: sha256(canonical({ measured: measured.fingerprint, status: item.status, updatedAt: item.updatedAt })),
        measuredFingerprint: measured.fingerprint,
        metadata: { status: item.status, updatedAt: item.updatedAt },
        targets,
      }));
    }
    return { candidates, protectedItems };
  };

  const scanImmediateDirectories = async ({ root, category, policy, nowMs }) => {
    const candidates = [];
    const protectedItems = [];
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      const target = path.join(root, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) {
        protectedItems.push({ id: entry.name, reason: "UNRECOGNIZED_OR_NON_DIRECTORY", workspaceRelativePath: safeRelative(workspaceRoot, target) });
        continue;
      }
      const measured = await measureTargets({ workspaceRoot, targets: [{ root, target }] });
      const relative = safeRelative(workspaceRoot, target);
      if (measured.unsafeReason) {
        protectedItems.push({ id: entry.name, reason: `UNSAFE_TREE_${measured.unsafeReason}`, workspaceRelativePath: relative });
      } else if (!ageEligible(measured.mtimeMs, policy.retentionMs, nowMs)) {
        protectedItems.push({ id: entry.name, reason: "RETENTION_WINDOW", workspaceRelativePath: relative, metadata: { lastModifiedAt: measured.mtimeMs ? iso(measured.mtimeMs) : null } });
      } else {
        candidates.push(makeCandidate({
          category,
          id: entry.name,
          bytes: measured.bytes,
          fileCount: measured.fileCount,
          lastModifiedMs: measured.mtimeMs,
          workspaceRelativePath: relative,
          fingerprint: measured.fingerprint,
          targets: [{ root, target }],
        }));
      }
    }
    return { candidates, protectedItems };
  };

  const scanReleaseRuns = async (context, policy, nowMs) => {
    const root = path.join(releaseGateRoot, "runs");
    const candidates = [];
    const protectedItems = [];
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      const target = path.join(root, entry.name);
      const relative = safeRelative(workspaceRoot, target);
      if (!entry.isDirectory() || !WORKFLOW_ID_PATTERN.test(entry.name)) {
        protectedItems.push({ id: entry.name, reason: "UNRECOGNIZED_RELEASE_RUN", workspaceRelativePath: relative });
        continue;
      }
      const measured = await measureTargets({ workspaceRoot, targets: [{ root, target }] });
      let reason = null;
      if (context.activeWorkflowIds.has(entry.name)) reason = "ACTIVE_WORKFLOW";
      else if (context.release.protectedWorkflowIds.has(entry.name)) reason = "CURRENT_RELEASE_PROVENANCE";
      else if (measured.unsafeReason) reason = `UNSAFE_TREE_${measured.unsafeReason}`;
      else if (!ageEligible(measured.mtimeMs, policy.retentionMs, nowMs)) reason = "RETENTION_WINDOW";
      if (reason) {
        protectedItems.push({ id: entry.name, reason, workspaceRelativePath: relative });
      } else {
        candidates.push(makeCandidate({
          category: policy.id,
          id: entry.name,
          bytes: measured.bytes,
          fileCount: measured.fileCount,
          lastModifiedMs: measured.mtimeMs,
          workspaceRelativePath: relative,
          fingerprint: measured.fingerprint,
          targets: [{ root, target }],
        }));
      }
    }
    return { candidates, protectedItems };
  };

  const scanBaselineSets = async (context, policy, nowMs) => {
    const candidates = [];
    const protectedItems = [];
    const baselinesRoot = path.join(releaseGateRoot, "baselines");
    for (const projectId of context.release.projects) {
      const setsRoot = path.join(baselinesRoot, projectId, "sets");
      let entries = [];
      try {
        entries = await fs.readdir(setsRoot, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const current = context.release.currentBaselineByProject.get(projectId) ?? null;
      for (const entry of entries) {
        const target = path.join(setsRoot, entry.name);
        const relative = safeRelative(workspaceRoot, target);
        if (!entry.isDirectory()) {
          protectedItems.push({ id: entry.name, projectId, reason: "UNRECOGNIZED_BASELINE_ENTRY", workspaceRelativePath: relative });
          continue;
        }
        const measured = await measureTargets({ workspaceRoot, targets: [{ root: setsRoot, target }] });
        let reason = null;
        if (!current) reason = "CURRENT_POINTER_UNAVAILABLE_FAIL_CLOSED";
        else if (current.setId === entry.name) reason = "CURRENT_BASELINE_SET";
        else if (measured.unsafeReason) reason = `UNSAFE_TREE_${measured.unsafeReason}`;
        else if (!ageEligible(measured.mtimeMs, policy.retentionMs, nowMs)) reason = "RETENTION_WINDOW";
        if (reason) {
          protectedItems.push({ id: entry.name, projectId, reason, workspaceRelativePath: relative });
        } else {
          candidates.push(makeCandidate({
            category: policy.id,
            id: entry.name,
            projectId,
            bytes: measured.bytes,
            fileCount: measured.fileCount,
            lastModifiedMs: measured.mtimeMs,
            workspaceRelativePath: relative,
            fingerprint: measured.fingerprint,
            targets: [{ root: setsRoot, target }],
          }));
        }
      }
    }
    return { candidates, protectedItems };
  };

  const scanCandidates = async (context, policy, nowMs) => {
    const candidates = [];
    const protectedItems = [];
    const root = path.join(releaseGateRoot, "candidates");
    for (const projectId of context.release.projects) {
      const projectRoot = path.join(root, projectId);
      let entries = [];
      try {
        entries = await fs.readdir(projectRoot, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const latest = context.release.latestCandidateByProject.get(projectId)?.candidate ?? null;
      for (const entry of entries) {
        const target = path.join(projectRoot, entry.name);
        const relative = safeRelative(workspaceRoot, target);
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          protectedItems.push({ id: entry.name, projectId, reason: "UNRECOGNIZED_CANDIDATE_ENTRY", workspaceRelativePath: relative });
          continue;
        }
        const candidate = await readJsonSafe(target);
        if (!candidate || candidate.projectId !== projectId || typeof candidate.candidateId !== "string") {
          protectedItems.push({ id: entry.name, projectId, reason: "INVALID_CANDIDATE_MANIFEST", workspaceRelativePath: relative });
          continue;
        }
        const measured = await measureTargets({ workspaceRoot, targets: [{ root: projectRoot, target }] });
        const createdMs = parseTime(candidate.createdAt) ?? measured.mtimeMs;
        let reason = null;
        if (!latest) reason = "LATEST_CANDIDATE_UNAVAILABLE_FAIL_CLOSED";
        else if (latest.candidateId === candidate.candidateId) reason = "LATEST_CANDIDATE";
        else if (measured.unsafeReason) reason = `UNSAFE_TREE_${measured.unsafeReason}`;
        else if (!ageEligible(createdMs, policy.retentionMs, nowMs)) reason = "RETENTION_WINDOW";
        if (reason) {
          protectedItems.push({ id: candidate.candidateId, projectId, reason, workspaceRelativePath: relative, metadata: { createdAt: candidate.createdAt } });
        } else {
          candidates.push(makeCandidate({
            category: policy.id,
            id: candidate.candidateId,
            projectId,
            bytes: measured.bytes,
            fileCount: measured.fileCount,
            lastModifiedMs: createdMs,
            workspaceRelativePath: relative,
            fingerprint: sha256(canonical({ measured: measured.fingerprint, candidateId: candidate.candidateId, createdAt: candidate.createdAt })),
            measuredFingerprint: measured.fingerprint,
            metadata: { createdAt: candidate.createdAt, workflowId: candidate.workflowId ?? null, headSha: candidate.headSha ?? null },
            targets: [{ root: projectRoot, target }],
          }));
        }
      }
    }
    return { candidates, protectedItems };
  };

  const scanRollbackBundles = async (context, policy, nowMs) => {
    const candidates = [];
    const protectedItems = [];
    const root = path.join(releaseGateRoot, "snapshots");
    for (const projectId of context.release.projects) {
      const projectRoot = path.join(root, projectId);
      let entries = [];
      try {
        entries = await fs.readdir(projectRoot, { withFileTypes: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      const manifests = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
      const latest = context.release.latestSnapshotByProject.get(projectId)?.manifest ?? null;
      for (const entry of manifests) {
        const manifestPath = path.join(projectRoot, entry.name);
        const manifest = await readJsonSafe(manifestPath);
        const headSha = String(manifest?.headSha ?? "").toLowerCase();
        const id = headSha || entry.name;
        if (!manifest || manifest.projectId !== projectId || !SHA40_PATTERN.test(headSha)) {
          protectedItems.push({ id, projectId, reason: "INVALID_SNAPSHOT_MANIFEST", workspaceRelativePath: safeRelative(workspaceRoot, manifestPath) });
          continue;
        }
        const bundlePath = path.join(projectRoot, `${headSha}.bundle`);
        const targets = [
          { root: projectRoot, target: manifestPath },
          { root: projectRoot, target: bundlePath },
        ];
        const measured = await measureTargets({ workspaceRoot, targets });
        const createdMs = parseTime(manifest.createdAt) ?? measured.mtimeMs;
        const protectedHeads = context.release.protectedHeads.get(projectId) ?? new Set();
        let reason = null;
        if (!measured.measured.every((item) => item.exists)) reason = "SNAPSHOT_PAIR_INCOMPLETE";
        else if (protectedHeads.has(headSha)) reason = "CURRENT_RELEASE_HEAD";
        else if (latest?.headSha?.toLowerCase() === headSha) reason = "LATEST_ROLLBACK_SNAPSHOT";
        else if (measured.unsafeReason) reason = `UNSAFE_TREE_${measured.unsafeReason}`;
        else if (!ageEligible(createdMs, policy.retentionMs, nowMs)) reason = "RETENTION_WINDOW";
        if (reason) {
          protectedItems.push({ id: headSha, projectId, reason, workspaceRelativePath: safeRelative(workspaceRoot, manifestPath), metadata: { createdAt: manifest.createdAt } });
        } else {
          candidates.push(makeCandidate({
            category: policy.id,
            id: headSha,
            projectId,
            bytes: measured.bytes,
            fileCount: measured.fileCount,
            lastModifiedMs: createdMs,
            workspaceRelativePath: safeRelative(workspaceRoot, manifestPath),
            fingerprint: sha256(canonical({ measured: measured.fingerprint, headSha, createdAt: manifest.createdAt })),
            measuredFingerprint: measured.fingerprint,
            metadata: { createdAt: manifest.createdAt },
            targets,
          }));
        }
      }
    }
    return { candidates, protectedItems };
  };

  const scanObservability = async (policy, nowMs) => {
    const candidates = [];
    const protectedItems = [];
    let entries = [];
    try {
      entries = await fs.readdir(observabilityRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      const target = path.join(observabilityRoot, entry.name);
      const relative = safeRelative(workspaceRoot, target);
      if (entry.name === "events-current.jsonl") {
        protectedItems.push({ id: entry.name, reason: "ACTIVE_EVENT_SEGMENT", workspaceRelativePath: relative });
        continue;
      }
      if (!entry.isFile() || !ROTATED_EVENT_PATTERN.test(entry.name)) {
        protectedItems.push({ id: entry.name, reason: "UNRECOGNIZED_OBSERVABILITY_ENTRY", workspaceRelativePath: relative });
        continue;
      }
      const measured = await measureTargets({ workspaceRoot, targets: [{ root: observabilityRoot, target }] });
      let reason = null;
      if (measured.unsafeReason) reason = `UNSAFE_TREE_${measured.unsafeReason}`;
      else if (!ageEligible(measured.mtimeMs, policy.retentionMs, nowMs)) reason = "RETENTION_WINDOW";
      if (reason) {
        protectedItems.push({ id: entry.name, reason, workspaceRelativePath: relative });
      } else {
        candidates.push(makeCandidate({
          category: policy.id,
          id: entry.name,
          bytes: measured.bytes,
          fileCount: measured.fileCount,
          lastModifiedMs: measured.mtimeMs,
          workspaceRelativePath: relative,
          fingerprint: measured.fingerprint,
          targets: [{ root: observabilityRoot, target }],
        }));
      }
    }
    return { candidates, protectedItems };
  };

  const scanWorktrees = async (policy) => {
    const candidates = [];
    const protectedItems = [];
    const records = await listManagedWorktrees();
    for (const item of records) {
      const id = `${item.projectId}:${item.workspaceRelativePath ?? item.path ?? "unknown"}`;
      let reason = null;
      if (!item.managed) reason = "UNMANAGED_WORKTREE";
      else if (!item.prunable) reason = "NOT_GIT_PRUNABLE";
      else if (item.locked) reason = "LOCKED_WORKTREE";
      else if (item.activeTerminal || item.activeProcess) reason = "ACTIVE_REFERENCE";
      else if (item.pathExists) reason = "PATH_STILL_EXISTS_FAIL_CLOSED";
      if (reason) {
        protectedItems.push({ id, projectId: item.projectId, reason, workspaceRelativePath: item.workspaceRelativePath ?? null, metadata: { branch: item.branch ?? null, prunable: Boolean(item.prunable) } });
        continue;
      }
      candidates.push(makeCandidate({
        category: policy.id,
        id,
        projectId: item.projectId,
        bytes: 0,
        fileCount: 0,
        lastModifiedMs: 0,
        workspaceRelativePath: item.workspaceRelativePath ?? null,
        fingerprint: sha256(canonical({
          projectId: item.projectId,
          path: item.workspaceRelativePath,
          head: item.head,
          branch: item.branch,
          pruneReason: item.pruneReason,
        })),
        metadata: { head: item.head ?? null, branch: item.branch ?? null, pruneReason: item.pruneReason ?? null },
      }));
    }
    return { candidates, protectedItems };
  };

  const scanCategory = async (categoryId, context = null) => {
    const policy = CATEGORY_MAP.get(categoryId);
    if (!policy) throw new Error(`Bilinmeyen janitor kategorisi: ${categoryId}`);
    const nowMs = now();
    const ctx = context ?? await baseContext();
    let result;
    switch (categoryId) {
      case "terminal_records":
        result = await scanTerminalRecords(ctx, policy, nowMs);
        break;
      case "process_records":
        result = await scanProcessRecords(ctx, policy, nowMs);
        break;
      case "workflow_records":
        result = await scanWorkflowRecords(ctx, policy, nowMs);
        break;
      case "visual_regression":
        result = await scanImmediateDirectories({ root: visualRoot, category: categoryId, policy, nowMs });
        break;
      case "browser_screenshots":
        result = await scanImmediateDirectories({ root: browserScreenshotRoot, category: categoryId, policy, nowMs });
        break;
      case "release_runs":
        result = await scanReleaseRuns(ctx, policy, nowMs);
        break;
      case "release_baseline_sets":
        result = await scanBaselineSets(ctx, policy, nowMs);
        break;
      case "release_candidates":
        result = await scanCandidates(ctx, policy, nowMs);
        break;
      case "rollback_bundles":
        result = await scanRollbackBundles(ctx, policy, nowMs);
        break;
      case "stale_worktrees":
        result = await scanWorktrees(policy);
        break;
      case "observability_segments":
        result = await scanObservability(policy, nowMs);
        break;
      default:
        throw new Error(`Desteklenmeyen janitor kategorisi: ${categoryId}`);
    }
    result.candidates.sort((a, b) => (a.lastModifiedMs - b.lastModifiedMs) || a.id.localeCompare(b.id));
    return { policy, ...result };
  };

  const report = async ({ category = null, includeProtected = false, limit = 100 } = {}) => {
    await initialize();
    if (category && !CATEGORY_MAP.has(category)) throw new Error(`Bilinmeyen janitor kategorisi: ${category}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Janitor report limit 1-500 arasında olmalı.");
    const context = await baseContext();
    const selected = category ? [category] : JANITOR_CATEGORIES.map((item) => item.id);
    const categories = [];
    let reclaimableBytes = 0;
    let reclaimableItems = 0;
    let protectedItems = 0;

    for (const categoryId of selected) {
      const scanned = await scanCategory(categoryId, context);
      const bytes = scanned.candidates.reduce((sum, item) => sum + item.bytes, 0);
      const token = cleanupToken(categoryId, scanned.candidates);
      reclaimableBytes += bytes;
      reclaimableItems += scanned.candidates.length;
      protectedItems += scanned.protectedItems.length;
      categories.push({
        id: scanned.policy.id,
        label: scanned.policy.label,
        description: scanned.policy.description,
        storage: scanned.policy.storage,
        retentionMs: scanned.policy.retentionMs,
        retentionDays: scanned.policy.retentionMs ? scanned.policy.retentionMs / DAY : 0,
        keepNewest: scanned.policy.keepNewest,
        reclaimableCount: scanned.candidates.length,
        reclaimableBytes: bytes,
        protectedCount: scanned.protectedItems.length,
        cleanupToken: token,
        cleanupAllowed: true,
        items: scanned.candidates.slice(0, limit).map(publicCandidate),
        itemsTruncated: scanned.candidates.length > limit,
        protected: includeProtected ? scanned.protectedItems.slice(0, limit).map(publicProtected) : undefined,
        protectedTruncated: includeProtected ? scanned.protectedItems.length > limit : undefined,
      });
    }

    return {
      schemaVersion: JANITOR_SCHEMA_VERSION,
      mode: "DRY_RUN",
      generatedAt: iso(now()),
      reclaimableItems,
      reclaimableBytes,
      protectedItems,
      categories,
      safety: {
        autonomousMaintenance: true,
        internalPlanFingerprint: true,
        maintenanceIntervalMs,
        activeTerminalProtected: true,
        activeProcessProtected: true,
        activeOrPausedWorkflowProtected: true,
        currentBaselineProtected: true,
        latestCandidateProtected: true,
        currentReleaseHeadsProtected: true,
        gitBranchDeletion: false,
        arbitraryPathDeletion: false,
      },
    };
  };

  const verifyFilesystemCandidate = async (candidate) => {
    if (!candidate._targets?.length) return;
    const measured = await measureTargets({ workspaceRoot, targets: candidate._targets });
    if (measured.unsafeReason) throw new Error(`Cleanup hedefi artık güvenli değil: ${candidate.id} (${measured.unsafeReason})`);
    if (!candidate._measuredFingerprint || measured.fingerprint !== candidate._measuredFingerprint) {
      throw new Error(`Cleanup hedefi preview sonrasında değişti: ${candidate.id}`);
    }
  };

  const removeTargets = async (candidate) => {
    await verifyFilesystemCandidate(candidate);
    for (const target of candidate._targets ?? []) {
      if (!isInside(target.root, target.target) || !isInside(workspaceRoot, target.target)) {
        throw new Error("Cleanup hedefi izinli runtime root dışına çıkıyor.");
      }
      const stat = await lstatOrNull(target.target);
      if (!stat) continue;
      if (stat.isSymbolicLink()) throw new Error("Cleanup symlink hedefini reddetti.");
      await fs.rm(target.target, { recursive: stat.isDirectory(), force: true });
    }
  };

  const cleanupOne = async (candidate) => {
    switch (candidate.category) {
      case "terminal_records":
        return terminalManager.stop({ sessionId: candidate.id, force: false, remove: true });
      case "process_records":
        return processManager.stop({ processId: candidate.id, force: false, remove: true });
      case "workflow_records":
        return workflowManager.removeTerminalRecord(candidate.id);
      case "visual_regression":
      case "browser_screenshots":
      case "release_runs":
      case "release_baseline_sets":
      case "release_candidates":
      case "rollback_bundles":
      case "observability_segments":
        await removeTargets(candidate);
        return { removed: candidate.workspaceRelativePath };
      default:
        throw new Error(`Tekil cleanup desteklenmiyor: ${candidate.category}`);
    }
  };

  const cleanup = async ({ category, cleanupToken: suppliedToken }) => {
    await initialize();
    if (!CATEGORY_MAP.has(category)) throw new Error(`Bilinmeyen janitor kategorisi: ${category}`);
    if (typeof suppliedToken !== "string" || !/^jt-[a-f0-9]{64}$/u.test(suppliedToken)) {
      throw new Error("Janitor cleanup için geçerli dry-run cleanup token zorunlu.");
    }
    if (activeCategories.has(category)) throw new Error(`Bu janitor kategorisi için cleanup zaten çalışıyor: ${category}`);
    activeCategories.add(category);
    const startedAtMs = now();
    const cleanupId = `janitor-${startedAtMs.toString(36)}-${randomId()}`;

    try {
      const context = await baseContext();
      const scanned = await scanCategory(category, context);
      const currentToken = cleanupToken(category, scanned.candidates);
      if (currentToken !== suppliedToken) {
        const record = {
          schemaVersion: JANITOR_SCHEMA_VERSION,
          cleanupId,
          category,
          outcome: "REFUSED_STALE_PREVIEW",
          startedAt: iso(startedAtMs),
          completedAt: iso(now()),
          requestedToken: suppliedToken,
          currentToken,
          cleanedCount: 0,
          cleanedBytes: 0,
          itemIds: [],
          error: null,
        };
        await appendHistory(record);
        await emit({
          type: "janitor.cleanup_refused",
          severity: "warn",
          status: "healthy",
          correlationId: cleanupId,
          message: `Janitor preview changed; cleanup was refused for ${category}.`,
          details: { cleanupId, category, reason: "STALE_PREVIEW" },
        });
        return record;
      }

      if (scanned.candidates.length === 0) {
        const record = {
          schemaVersion: JANITOR_SCHEMA_VERSION,
          cleanupId,
          category,
          outcome: "SKIPPED_ALREADY_CLEAN",
          startedAt: iso(startedAtMs),
          completedAt: iso(now()),
          requestedToken: suppliedToken,
          currentToken,
          cleanedCount: 0,
          cleanedBytes: 0,
          itemIds: [],
          error: null,
        };
        await appendHistory(record);
        return record;
      }

      await emit({
        type: "janitor.cleanup_started",
        severity: "info",
        status: "recovering",
        correlationId: cleanupId,
        message: `Janitor cleanup started: ${category}`,
        details: { cleanupId, category, itemCount: scanned.candidates.length, reclaimableBytes: scanned.candidates.reduce((sum, item) => sum + item.bytes, 0) },
      });

      const cleaned = [];
      let failure = null;
      if (category === "stale_worktrees") {
        try {
          const result = await pruneManagedWorktrees(scanned.candidates.map((item) => ({
            projectId: item.projectId,
            id: item.id,
            workspaceRelativePath: item.workspaceRelativePath,
            fingerprint: item.fingerprint,
            metadata: item.metadata,
          })));
          cleaned.push(...scanned.candidates.map((item) => item.id));
          if (result?.pruned && result.pruned.length < cleaned.length) {
            failure = `Expected ${cleaned.length} worktree metadata records, but only ${result.pruned.length} were pruned.`;
          }
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      } else {
        for (const candidate of scanned.candidates) {
          try {
            await cleanupOne(candidate);
            cleaned.push(candidate.id);
          } catch (error) {
            failure = error instanceof Error ? error.message : String(error);
            break;
          }
        }
      }

      const cleanedSet = new Set(cleaned);
      const cleanedBytes = scanned.candidates.filter((item) => cleanedSet.has(item.id)).reduce((sum, item) => sum + item.bytes, 0);
      const outcome = failure
        ? (cleaned.length > 0 ? "PARTIAL" : "FAILED")
        : "CLEANED";
      const record = {
        schemaVersion: JANITOR_SCHEMA_VERSION,
        cleanupId,
        category,
        outcome,
        startedAt: iso(startedAtMs),
        completedAt: iso(now()),
        requestedToken: suppliedToken,
        currentToken,
        cleanedCount: cleaned.length,
        cleanedBytes,
        itemIds: cleaned,
        error: failure,
      };
      await appendHistory(record);
      await emit({
        type: outcome === "CLEANED" ? "janitor.cleaned" : "janitor.cleanup_failed",
        severity: outcome === "CLEANED" ? "info" : "error",
        status: outcome === "CLEANED" ? "recovered" : "failed",
        correlationId: cleanupId,
        message: outcome === "CLEANED"
          ? `Janitor cleanup completed: ${category} (${cleaned.length} items).`
          : `Janitor cleanup did not complete: ${category}${failure ? ` — ${failure}` : ""}`,
        details: { cleanupId, category, outcome, cleanedCount: cleaned.length, cleanedBytes },
      });
      return record;
    } finally {
      activeCategories.delete(category);
    }
  };

  const runMaintenanceCycle = async ({ trigger = "scheduled" } = {}) => {
    await initialize();
    if (maintenanceActive) {
      return {
        outcome: "SKIPPED_ALREADY_RUNNING",
        trigger,
        startedAt: null,
        completedAt: iso(now()),
        categories: [],
      };
    }

    maintenanceActive = true;
    const startedAtMs = now();
    const cycleId = `janitor-cycle-${startedAtMs.toString(36)}-${randomId()}`;
    const results = [];
    await emit({
      type: "janitor.maintenance_started",
      severity: "info",
      status: "healthy",
      correlationId: cycleId,
      message: `Runtime janitor maintenance cycle started: ${trigger}`,
      details: { cycleId, trigger, categoryCount: JANITOR_CATEGORIES.length },
    });

    try {
      for (const policy of JANITOR_CATEGORIES) {
        try {
          const categoryResult = await runExclusive(async () => {
            const context = await baseContext();
            const scanned = await scanCategory(policy.id, context);
            if (scanned.candidates.length === 0) {
              return {
                category: policy.id,
                outcome: "SKIPPED_ALREADY_CLEAN",
                cleanedCount: 0,
                cleanedBytes: 0,
              };
            }

            const token = cleanupToken(policy.id, scanned.candidates);
            const cleaned = await cleanup({
              category: policy.id,
              cleanupToken: token,
            });
            return {
              category: policy.id,
              outcome: cleaned.outcome,
              cleanedCount: cleaned.cleanedCount,
              cleanedBytes: cleaned.cleanedBytes,
              cleanupId: cleaned.cleanupId,
              error: cleaned.error,
            };
          });
          results.push(categoryResult);
        } catch (error) {
          results.push({
            category: policy.id,
            outcome: "FAILED",
            cleanedCount: 0,
            cleanedBytes: 0,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const failed = results.filter((item) => ["FAILED", "PARTIAL"].includes(item.outcome));
      const cleanedCount = results.reduce((sum, item) => sum + (item.cleanedCount ?? 0), 0);
      const cleanedBytes = results.reduce((sum, item) => sum + (item.cleanedBytes ?? 0), 0);
      const completedAtMs = now();
      lastMaintenance = {
        cycleId,
        trigger,
        outcome: failed.length > 0 ? "PARTIAL" : "COMPLETED",
        startedAt: iso(startedAtMs),
        completedAt: iso(completedAtMs),
        cleanedCount,
        cleanedBytes,
        failedCategories: failed.map((item) => item.category),
      };
      await emit({
        type: failed.length > 0 ? "janitor.maintenance_partial" : "janitor.maintenance_completed",
        severity: failed.length > 0 ? "warn" : "info",
        status: failed.length > 0 ? "degraded" : "healthy",
        correlationId: cycleId,
        message: failed.length > 0
          ? `Runtime janitor maintenance cycle completed partially; ${failed.length} categories failed.`
          : `Runtime janitor maintenance cycle completed; ${cleanedCount} items cleaned.`,
        details: {
          cycleId,
          trigger,
          cleanedCount,
          cleanedBytes,
          failedCategories: failed.map((item) => item.category),
        },
      });
      return { ...lastMaintenance, categories: results };
    } finally {
      maintenanceActive = false;
    }
  };

  const scheduleNextMaintenance = (delayMs) => {
    if (!maintenanceEnabled) return;
    if (maintenanceTimer !== null) clearTimeoutImpl(maintenanceTimer);
    nextMaintenanceAtMs = now() + delayMs;
    maintenanceTimer = setTimeoutImpl(() => {
      maintenanceTimer = null;
      nextMaintenanceAtMs = null;
      void runMaintenanceCycle({ trigger: "scheduled" })
        .catch(() => {})
        .finally(() => scheduleNextMaintenance(maintenanceIntervalMs));
    }, delayMs);
    maintenanceTimer?.unref?.();
  };

  const startMaintenance = async () => {
    await initialize();
    if (!maintenanceEnabled) {
      maintenanceEnabled = true;
      scheduleNextMaintenance(startupDelayMs);
    }
    return schedulerStatus();
  };

  const stopMaintenance = () => {
    maintenanceEnabled = false;
    nextMaintenanceAtMs = null;
    if (maintenanceTimer !== null) {
      clearTimeoutImpl(maintenanceTimer);
      maintenanceTimer = null;
    }
  };

  return Object.freeze({
    initialize,
    report,
    cleanup,
    runMaintenanceCycle,
    startMaintenance,
    stopMaintenance,
    status: schedulerStatus,
    history,
    categories: () => JANITOR_CATEGORIES.map((item) => ({ ...item })),
    get activeCleanupCount() {
      return activeCategories.size;
    },
    get historyPath() {
      return historyPath;
    },
  });
}

export const __test = Object.freeze({
  JANITOR_SCHEMA_VERSION,
  CATEGORY_MAP,
  cleanupToken,
  measureTree,
  measureTargets,
  ageEligible,
  canonical,
  DEFAULT_MAINTENANCE_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
});
