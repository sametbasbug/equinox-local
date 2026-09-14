import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";

export const TASK_CAPSULE_SCHEMA_VERSION = 1;
export const TASK_CAPSULE_STATUSES = Object.freeze(["active", "completed", "cancelled"]);
export const TASK_CAPSULE_ERROR_CODES = Object.freeze({
  revisionConflict: "TASK_CAPSULE_REVISION_CONFLICT",
  notFound: "TASK_CAPSULE_NOT_FOUND",
  terminalRequired: "TASK_CAPSULE_TERMINAL_REQUIRED",
});
const STATUS_SET = new Set(TASK_CAPSULE_STATUSES);
const CONTINUATION_STATUS_SET = new Set(["armed", "delivering", "delivered", "cancelled", "expired", "failed"]);
const FRESH_RESUME_STATUS_SET = new Set(["prepared", "creating", "confirmed", "cancelled", "ambiguous"]);
const DEFAULT_MAX_RETAINED = 50;
const DEFAULT_MAX_STATE_BYTES = 256 * 1024;
const MAX_TTL_MINUTES = 60;
const REFERENCE_TYPES = new Set(["project", "branch", "commit", "file", "url", "note"]);

function iso(now) { return new Date(now).toISOString(); }
function bytes(value) { return Buffer.byteLength(value, "utf8"); }
function boundedText(value, { label, maxChars = null, maxBytes = null, allowEmpty = false }) {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  if (/\0|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new Error(`${label} contains unsupported control characters.`);
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (!allowEmpty && !normalized) throw new Error(`${label} cannot be empty.`);
  if (maxChars !== null && normalized.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters.`);
  if (maxBytes !== null && bytes(normalized) > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  return normalized;
}
function normalizeItems(value, label) {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${label} must be an array with at most 64 items.`);
  return value.map((item, index) => boundedText(item, { label: `${label}[${index}]`, maxBytes: 1024 }));
}
function normalizeReferences(value = []) {
  if (!Array.isArray(value) || value.length > 32) throw new Error("references must be an array with at most 32 items.");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`references[${index}] must be an object.`);
    if (Object.keys(item).some((key) => !["type", "label", "value"].includes(key))) throw new Error(`references[${index}] contains an unsupported field.`);
    if (!REFERENCE_TYPES.has(item.type)) throw new Error(`references[${index}].type is unsupported.`);
    const label = boundedText(item.label, { label: `references[${index}].label`, maxChars: 120 });
    const valueText = boundedText(item.value, { label: `references[${index}].value`, maxBytes: 2048 });
    if (item.type === "file" && (path.isAbsolute(valueText) || valueText.split(/[\\/]/u).includes(".."))) throw new Error(`references[${index}].value must be a safe relative file reference.`);
    if (item.type === "url") {
      let parsed;
      try { parsed = new URL(valueText); } catch { throw new Error(`references[${index}].value must be a valid HTTPS URL.`); }
      if (parsed.protocol !== "https:") throw new Error(`references[${index}].value must use HTTPS.`);
    }
    return { type: item.type, label, value: valueText };
  });
}
function normalizeSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Task checkpoint input must be an object.");
  return {
    title: boundedText(input.title, { label: "title", maxChars: 160 }),
    objective: boundedText(input.objective, { label: "objective", maxBytes: 12 * 1024 }),
    completed: normalizeItems(input.completed ?? [], "completed"),
    next: normalizeItems(input.next ?? [], "next"),
    references: normalizeReferences(input.references ?? []),
  };
}
function normalizeTaskId(value) {
  if (typeof value !== "string" || !/^task-[a-z0-9-]{6,80}$/u.test(value)) throw new Error("Task id is invalid.");
  return value;
}
function revisionConflict(expectedRevision, currentRevision) {
  const error = new Error(`Task Capsule changed since revision ${expectedRevision}; current revision is ${currentRevision}. Refresh the task before saving.`);
  error.code = TASK_CAPSULE_ERROR_CODES.revisionConflict;
  return error;
}
function normalizeContinuationTarget(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Auto Continue target must be an object.");
  const browserContext = value.browserContext;
  if (!["agent", "user"].includes(browserContext)) throw new Error("Auto Continue browser context is invalid.");
  if (!["task-tab", "pinned"].includes(value.mode)) throw new Error("Auto Continue target mode is invalid.");
  if (!Number.isInteger(value.tabId) || value.tabId < 1) throw new Error("Auto Continue target tab id is invalid.");
  const browserInstanceId = boundedText(value.browserInstanceId, { label: "browserInstanceId", maxChars: 128 });
  const conversationId = boundedText(value.conversationId, { label: "conversationId", maxChars: 160 });
  if (!/^[A-Za-z0-9-]{8,160}$/u.test(conversationId)) throw new Error("Auto Continue conversation id is invalid.");
  const canonicalUrl = boundedText(value.canonicalUrl, { label: "canonicalUrl", maxChars: 500 });
  const parsed = new URL(canonicalUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") throw new Error("Auto Continue canonical URL must be a chatgpt.com HTTPS URL.");
  const title = boundedText(value.title || "ChatGPT", { label: "target title", maxChars: 200 });
  const userEpoch = boundedText(value.userEpoch, { label: "userEpoch", maxChars: 200 });
  const assistantTurnKey = boundedText(value.assistantTurnKey, { label: "assistantTurnKey", maxChars: 200 });
  if (!Number.isInteger(value.autoContinueVersion) || value.autoContinueVersion < 1 || value.autoContinueVersion > 100) throw new Error("Auto Continue capability version is invalid.");
  return { browserContext, browserInstanceId, mode: value.mode, tabId: value.tabId, conversationId, canonicalUrl, title, userEpoch, assistantTurnKey, autoContinueVersion: value.autoContinueVersion };
}
function normalizeFreshResumeSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Fresh Chat Resume source must be an object.");
  const browserContext = value.browserContext;
  if (!["agent", "user"].includes(browserContext)) throw new Error("Fresh Chat Resume browser context is invalid.");
  if (!["task-tab", "pinned"].includes(value.mode)) throw new Error("Fresh Chat Resume source mode is invalid.");
  if (!Number.isInteger(value.tabId) || value.tabId < 1) throw new Error("Fresh Chat Resume source tab id is invalid.");
  const browserInstanceId = boundedText(value.browserInstanceId, { label: "fresh resume browserInstanceId", maxChars: 128 });
  const conversationId = boundedText(value.conversationId, { label: "fresh resume conversationId", maxChars: 160 });
  if (!/^[A-Za-z0-9-]{8,160}$/u.test(conversationId)) throw new Error("Fresh Chat Resume source conversation id is invalid.");
  const canonicalUrl = boundedText(value.canonicalUrl, { label: "fresh resume canonicalUrl", maxChars: 500 });
  const parsed = new URL(canonicalUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") throw new Error("Fresh Chat Resume source URL must be a chatgpt.com HTTPS URL.");
  const title = boundedText(value.title || "ChatGPT", { label: "fresh resume source title", maxChars: 200 });
  const userEpoch = boundedText(value.userEpoch, { label: "fresh resume userEpoch", maxChars: 200 });
  const assistantTurnKey = boundedText(value.assistantTurnKey, { label: "fresh resume assistantTurnKey", maxChars: 200 });
  if (!Number.isInteger(value.freshChatResumeVersion) || value.freshChatResumeVersion < 1 || value.freshChatResumeVersion > 100) throw new Error("Fresh Chat Resume capability version is invalid.");
  return { browserContext, browserInstanceId, mode: value.mode, tabId: value.tabId, conversationId, canonicalUrl, title, userEpoch, assistantTurnKey, freshChatResumeVersion: value.freshChatResumeVersion };
}
function normalizeChatBinding(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Chat binding must be an object.");
  const browserContext = value.browserContext;
  if (!["agent", "user"].includes(browserContext)) throw new Error("Chat binding browser context is invalid.");
  const browserInstanceId = boundedText(value.browserInstanceId, { label: "chat binding browserInstanceId", maxChars: 128 });
  if (!Number.isInteger(value.tabId) || value.tabId < 1) throw new Error("Chat binding tab id is invalid.");
  const conversationId = boundedText(value.conversationId, { label: "chat binding conversationId", maxChars: 160 });
  if (!/^[A-Za-z0-9-]{8,160}$/u.test(conversationId)) throw new Error("Chat binding conversation id is invalid.");
  const canonicalUrl = boundedText(value.canonicalUrl, { label: "chat binding canonicalUrl", maxChars: 500 });
  const parsed = new URL(canonicalUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com") throw new Error("Chat binding URL must be a chatgpt.com HTTPS URL.");
  return { browserContext, browserInstanceId, tabId: value.tabId, conversationId, canonicalUrl };
}
function normalizeFreshResumeDestination(value, source = null) {
  const binding = normalizeChatBinding(value);
  if (!binding) throw new Error("Fresh Chat Resume destination is required.");
  if (source && (binding.browserContext !== source.browserContext || binding.browserInstanceId !== source.browserInstanceId)) {
    throw new Error("Fresh Chat Resume destination must stay in the source browser context and instance.");
  }
  return binding;
}
function cloneFreshResume(value) {
  return value ? { ...value, source: value.source ? { ...value.source } : null, destination: value.destination ? { ...value.destination } : null } : null;
}
function cloneChatBinding(value) { return value ? { ...value } : null; }
function publicFreshResume(value) {
  if (!value) return null;
  return {
    resumeId: value.resumeId,
    status: value.status,
    checkpointRevision: value.checkpointRevision,
    preparedAt: value.preparedAt,
    mutationStartedAt: value.mutationStartedAt ?? null,
    completedAt: value.completedAt ?? null,
    reason: value.reason ?? null,
    source: value.source ? { browserContext: value.source.browserContext, mode: value.source.mode, tabId: value.source.tabId, title: value.source.title } : null,
    destination: value.destination ? { browserContext: value.destination.browserContext, tabId: value.destination.tabId } : null,
  };
}
function publicChatBinding(value) {
  return value ? { browserContext: value.browserContext, tabId: value.tabId } : null;
}
function cloneContinuation(value) { return value ? { ...value, target: value.target ? { ...value.target } : null } : null; }
function cloneContinuationRecord(record) {
  return {
    ...record,
    completed: [...record.completed],
    next: [...record.next],
    references: record.references.map((item) => ({ ...item })),
    continuation: cloneContinuation(record.continuation),
    freshResume: cloneFreshResume(record.freshResume),
    chatBinding: cloneChatBinding(record.chatBinding),
  };
}
function publicContinuation(value) {
  if (!value) return null;
  return {
    continuationId: value.continuationId, status: value.status, checkpointRevision: value.checkpointRevision,
    armedAt: value.armedAt, expiresAt: value.expiresAt, chainId: value.chainId, hop: value.hop, reason: value.reason ?? null,
    target: value.target ? { browserContext: value.target.browserContext, mode: value.target.mode, tabId: value.target.tabId, title: value.target.title } : null,
  };
}
function publicTask(record) {
  return Object.freeze({
    taskId: record.taskId, schemaVersion: record.schemaVersion, title: record.title, objective: record.objective,
    status: record.status, checkpointRevision: record.checkpointRevision, completed: [...record.completed], next: [...record.next],
    references: record.references.map((item) => ({ ...item })), createdAt: record.createdAt, updatedAt: record.updatedAt,
    completedAt: record.completedAt, continuation: publicContinuation(record.continuation),
    freshResume: publicFreshResume(record.freshResume), chatBinding: publicChatBinding(record.chatBinding),
  });
}
function validateStoredRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Stored Task Capsule must be an object.");
  if (record.schemaVersion !== TASK_CAPSULE_SCHEMA_VERSION) throw new Error(`Unsupported Task Capsule schema version: ${record.schemaVersion}`);
  normalizeTaskId(record.taskId);
  if (!STATUS_SET.has(record.status)) throw new Error(`Invalid Task Capsule status: ${record.status}`);
  if (!Number.isInteger(record.checkpointRevision) || record.checkpointRevision < 1) throw new Error("Task Capsule checkpoint revision is invalid.");
  const normalized = normalizeSnapshot(record);
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") throw new Error("Task Capsule timestamps are invalid.");
  if (record.completedAt !== null && typeof record.completedAt !== "string") throw new Error("Task Capsule completedAt is invalid.");
  const continuation = record.continuation ?? null;
  if (continuation !== null) {
    const item = continuation;
    if (!item || typeof item !== "object" || typeof item.continuationId !== "string" || !/^cont-[a-z0-9-]{6,80}$/u.test(item.continuationId)) throw new Error("Task continuation record is invalid.");
    if (!CONTINUATION_STATUS_SET.has(item.status) || !Number.isInteger(item.checkpointRevision)) throw new Error("Task continuation state is invalid.");
    if (item.target !== null) item.target = normalizeContinuationTarget(item.target);
  }
  let freshResume = record.freshResume ?? null;
  if (freshResume !== null) {
    if (!freshResume || typeof freshResume !== "object" || typeof freshResume.resumeId !== "string" || !/^resume-[a-z0-9-]{6,80}$/u.test(freshResume.resumeId)) throw new Error("Fresh Chat Resume record is invalid.");
    if (!FRESH_RESUME_STATUS_SET.has(freshResume.status) || !Number.isInteger(freshResume.checkpointRevision)) throw new Error("Fresh Chat Resume state is invalid.");
    if (typeof freshResume.preparedAt !== "string") throw new Error("Fresh Chat Resume preparedAt is invalid.");
    if (freshResume.mutationStartedAt !== null && freshResume.mutationStartedAt !== undefined && typeof freshResume.mutationStartedAt !== "string") throw new Error("Fresh Chat Resume mutationStartedAt is invalid.");
    if (freshResume.completedAt !== null && freshResume.completedAt !== undefined && typeof freshResume.completedAt !== "string") throw new Error("Fresh Chat Resume completedAt is invalid.");
    const source = normalizeFreshResumeSource(freshResume.source);
    const destination = freshResume.destination == null ? null : normalizeFreshResumeDestination(freshResume.destination, source);
    freshResume = { ...freshResume, source, destination, reason: freshResume.reason ?? null };
  }
  const chatBinding = normalizeChatBinding(record.chatBinding ?? null);
  return { ...record, ...normalized, continuation: cloneContinuation(continuation), freshResume: cloneFreshResume(freshResume), chatBinding: cloneChatBinding(chatBinding) };
}

export function createTaskCapsuleStore({ rootDir, now = () => Date.now(), randomId = () => randomUUID().slice(0, 10), maxRetained = DEFAULT_MAX_RETAINED, maxStateBytes = DEFAULT_MAX_STATE_BYTES, onEvent = null } = {}) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) throw new Error("Task Capsule storage root must be an absolute path.");
  const records = new Map();
  const loadErrors = [];
  let initialized = false;
  let mutation = Promise.resolve();
  const emit = (event) => { if (typeof onEvent === "function") void Promise.resolve(onEvent(event)).catch(() => {}); };
  const statePath = (taskId) => path.join(rootDir, `${normalizeTaskId(taskId)}.json`);
  const withMutation = (fn) => { const run = mutation.then(fn, fn); mutation = run.catch(() => {}); return run; };
  const persist = async (record) => {
    const output = `${JSON.stringify(record, null, 2)}\n`;
    if (bytes(output) > maxStateBytes) throw new Error("Task Capsule exceeds the state size limit.");
    const target = statePath(record.taskId);
    const temporary = `${target}.${process.pid}.${randomId()}.tmp`;
    await fs.writeFile(temporary, output, { mode: 0o600, flag: "wx" });
    try {
      const existing = await fs.lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new Error("Task Capsule target must be a normal file.");
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600).catch(() => {});
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  };
  const requireTask = (taskId) => {
    const record = records.get(normalizeTaskId(taskId));
    if (!record) {
      const error = new Error(`Task Capsule not found: ${taskId}`);
      error.code = TASK_CAPSULE_ERROR_CODES.notFound;
      throw error;
    }
    return record;
  };
  const clearContinuation = (record, reason) => {
    if (!record.continuation || record.continuation.status !== "armed") return false;
    record.continuation = { ...record.continuation, status: "cancelled", reason };
    return true;
  };
  const clearPreparedFreshResume = (record, reason) => {
    if (!record.freshResume || record.freshResume.status !== "prepared") return false;
    const completedAt = iso(now());
    record.freshResume = { ...record.freshResume, status: "cancelled", reason, completedAt };
    return true;
  };
  const assertDeliveryNotCommitted = (record, action) => {
    if (record.continuation?.status === "delivering") {
      throw new Error(`Task Capsule cannot ${action} after Auto Continue delivery has been reserved.`);
    }
  };
  const assertFreshResumeNotUnresolved = (record, action) => {
    if (["creating", "ambiguous"].includes(record.freshResume?.status)) {
      throw new Error(`Task Capsule cannot ${action} while Fresh Chat Resume is ${record.freshResume.status}; resolve or abandon the transition first.`);
    }
  };
  const assertNoLiveFreshResume = (record, action) => {
    if (["prepared", "creating", "ambiguous"].includes(record.freshResume?.status)) {
      throw new Error(`Task Capsule cannot ${action} while Fresh Chat Resume is ${record.freshResume.status}.`);
    }
  };
  const prune = async () => {
    if (records.size < maxRetained) return;
    const removable = [...records.values()].filter((record) => record.status !== "active").sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
    while (records.size >= maxRetained && removable.length) { const record = removable.shift(); records.delete(record.taskId); await fs.rm(statePath(record.taskId), { force: true }); }
    if (records.size >= maxRetained) throw new Error("Task Capsule retention limit is full of active tasks; finish or cancel a task before creating another.");
  };
  const initialize = async () => {
    if (initialized) return { loaded: records.size, errors: [...loadErrors] };
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(rootDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Task Capsule storage root must be a normal directory.");
    await fs.chmod(rootDir, 0o700).catch(() => {});
    for (const entry of await fs.readdir(rootDir, { withFileTypes: true })) {
      if (!/^task-[a-z0-9-]{6,80}\.json$/u.test(entry.name)) continue;
      try {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Task Capsule entry is not a normal file.");
        const loaded = await readBoundedNormalFile(path.join(rootDir, entry.name), { maxBytes: maxStateBytes, encoding: "utf8", label: "Task Capsule state" });
        const record = validateStoredRecord(JSON.parse(loaded.data)); records.set(record.taskId, record);
      } catch (error) { loadErrors.push({ file: entry.name, error: error instanceof Error ? error.message : String(error) }); }
    }
    initialized = true;
    return { loaded: records.size, errors: [...loadErrors] };
  };
  const checkpoint = (input) => withMutation(async () => {
    await initialize();
    const snapshot = normalizeSnapshot(input);
    const requestedId = input.taskId ?? input.task_id ?? null;
    if (requestedId) {
      const record = requireTask(requestedId);
      if (record.status !== "active") throw new Error("Only active Task Capsules can receive a new checkpoint.");
      const expectedRevision = input.expectedRevision ?? input.expected_revision ?? null;
      if (expectedRevision !== null) {
        if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error("expectedRevision must be a positive integer.");
        if (record.checkpointRevision !== expectedRevision) throw revisionConflict(expectedRevision, record.checkpointRevision);
      }
      assertDeliveryNotCommitted(record, "change checkpoint");
      assertFreshResumeNotUnresolved(record, "change checkpoint");
      clearContinuation(record, "checkpoint_changed");
      clearPreparedFreshResume(record, "checkpoint_changed");
      Object.assign(record, snapshot);
      record.checkpointRevision += 1;
      record.updatedAt = iso(now());
      await persist(record);
      emit({ component: "task-capsule", type: "task.checkpointed", severity: "info", status: "updated", message: "Task Capsule checkpoint was updated.", details: { taskId: record.taskId, checkpointRevision: record.checkpointRevision } });
      return publicTask(record);
    }
    await prune();
    const taskId = `task-${randomId()}`;
    const timestamp = iso(now());
    const record = { taskId, schemaVersion: TASK_CAPSULE_SCHEMA_VERSION, ...snapshot, status: "active", checkpointRevision: 1, createdAt: timestamp, updatedAt: timestamp, completedAt: null, continuation: null, freshResume: null, chatBinding: null };
    await persist(record);
    records.set(taskId, record);
    emit({ component: "task-capsule", type: "task.created", severity: "info", status: "active", message: "Task Capsule was created.", details: { taskId, checkpointRevision: 1 } });
    return publicTask(record);
  });
  const read = async (taskId) => { await initialize(); return publicTask(requireTask(taskId)); };
  const list = async ({ status = null, limit = 50 } = {}) => {
    await initialize();
    if (status !== null && !STATUS_SET.has(status)) throw new Error("Task status filter is invalid.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Task list limit must be between 1 and 100.");
    return [...records.values()].filter((record) => status === null || record.status === status).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, limit).map(publicTask);
  };
  const finish = (taskId) => withMutation(async () => {
    await initialize();
    const record = requireTask(taskId);
    if (record.status === "cancelled") throw new Error("A cancelled Task Capsule cannot be marked completed.");
    if (record.status === "completed") return publicTask(record);
    assertDeliveryNotCommitted(record, "finish");
    assertFreshResumeNotUnresolved(record, "finish");
    clearContinuation(record, "task_completed");
    clearPreparedFreshResume(record, "task_completed");
    record.status = "completed"; record.completedAt = iso(now()); record.updatedAt = record.completedAt;
    await persist(record);
    emit({ component: "task-capsule", type: "task.completed", severity: "info", status: "completed", message: "Task Capsule was completed.", details: { taskId: record.taskId } });
    return publicTask(record);
  });
  const cancel = (taskId) => withMutation(async () => {
    await initialize();
    const record = requireTask(taskId);
    if (record.status === "completed") throw new Error("A completed Task Capsule cannot be cancelled.");
    if (record.status === "cancelled") return publicTask(record);
    assertDeliveryNotCommitted(record, "cancel");
    assertFreshResumeNotUnresolved(record, "cancel");
    clearContinuation(record, "task_cancelled");
    clearPreparedFreshResume(record, "task_cancelled");
    record.status = "cancelled"; record.completedAt = iso(now()); record.updatedAt = record.completedAt;
    await persist(record);
    emit({ component: "task-capsule", type: "task.cancelled", severity: "info", status: "cancelled", message: "Task Capsule was cancelled.", details: { taskId: record.taskId } });
    return publicTask(record);
  });
  const remove = (taskId) => withMutation(async () => {
    await initialize();
    const record = requireTask(taskId);
    if (record.status === "active") {
      const error = new Error("Active Task Capsules must be completed or cancelled before deletion.");
      error.code = TASK_CAPSULE_ERROR_CODES.terminalRequired;
      throw error;
    }
    await fs.rm(statePath(record.taskId), { force: true });
    records.delete(record.taskId);
    emit({ component: "task-capsule", type: "task.deleted", severity: "info", status: "deleted", message: "Terminal Task Capsule was deleted.", details: { taskId: record.taskId, previousStatus: record.status } });
    return Object.freeze({ taskId: record.taskId, status: record.status, deleted: true });
  });
  const armContinuation = ({ taskId, ttlMinutes = 15, chainId = null, hop = 1, target = null } = {}) => withMutation(async () => {
    await initialize();
    const record = requireTask(taskId);
    if (record.status !== "active") throw new Error("Only active Task Capsules can arm Auto Continue.");
    assertNoLiveFreshResume(record, "arm Auto Continue");
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > MAX_TTL_MINUTES) throw new Error(`Auto Continue TTL must be between 1 and ${MAX_TTL_MINUTES} minutes.`);
    if (!Number.isInteger(hop) || hop < 1 || hop > 3) throw new Error("Auto Continue hop must be between 1 and 3.");
    const armedAtMs = now();
    record.continuation = { continuationId: `cont-${randomId()}`, status: "armed", checkpointRevision: record.checkpointRevision, armedAt: iso(armedAtMs), expiresAt: iso(armedAtMs + ttlMinutes * 60_000), chainId: chainId || `chain-${randomId()}`, hop, target: normalizeContinuationTarget(target), reason: null };
    record.updatedAt = iso(now());
    await persist(record);
    emit({ component: "task-capsule", type: "continuation.armed", severity: "info", status: "armed", message: "Auto Continue was armed for a Task Capsule.", details: { taskId: record.taskId, checkpointRevision: record.checkpointRevision, hop } });
    return publicTask(record);
  });
  const cancelContinuation = (taskId, reason = "cancelled") => withMutation(async () => {
    await initialize();
    const record = requireTask(taskId);
    const normalizedReason = boundedText(String(reason), { label: "continuation cancellation reason", maxChars: 120 });
    assertDeliveryNotCommitted(record, "cancel Auto Continue");
    if (!clearContinuation(record, normalizedReason)) return publicTask(record);
    record.updatedAt = iso(now());
    await persist(record);
    emit({ component: "task-capsule", type: "continuation.cancelled", severity: "info", status: "cancelled", message: "Auto Continue was cancelled for a Task Capsule.", details: { taskId: record.taskId } });
    return publicTask(record);
  });
  const cancelAllContinuations = (reason = "emergency_stop") => withMutation(async () => {
    await initialize();
    const changed = [];
    for (const record of records.values()) {
      if (!clearContinuation(record, reason)) continue;
      record.updatedAt = iso(now()); await persist(record); changed.push(record.taskId);
    }
    if (changed.length) emit({ component: "task-capsule", type: "continuation.cancelled_all", severity: "warn", status: "cancelled", message: "Pending Auto Continue arms were cancelled.", details: { count: changed.length, reason } });
    return { cancelled: changed.length, taskIds: changed };
  });
  const prepareFreshResume = ({ taskId, source } = {}) => withMutation(async () => {
    await initialize();
    const record = requireTask(taskId);
    if (record.status !== "active") throw new Error("Only active Task Capsules can prepare Fresh Chat Resume.");
    if (["armed", "delivering"].includes(record.continuation?.status)) throw new Error("Fresh Chat Resume cannot start while Auto Continue is pending.");
    if (["prepared", "creating"].includes(record.freshResume?.status)) throw new Error(`Fresh Chat Resume is already ${record.freshResume.status}.`);
    if (record.freshResume?.status === "ambiguous") throw new Error("Fresh Chat Resume is ambiguous; abandon or resolve the previous transition before trying again.");
    if (record.freshResume?.status === "confirmed" && record.freshResume.checkpointRevision === record.checkpointRevision) {
      throw new Error("This Task Capsule checkpoint has already been resumed into a fresh chat.");
    }
    const normalizedSource = normalizeFreshResumeSource(source);
    const preparedAt = iso(now());
    record.freshResume = {
      resumeId: `resume-${randomId()}`,
      status: "prepared",
      checkpointRevision: record.checkpointRevision,
      preparedAt,
      mutationStartedAt: null,
      completedAt: null,
      source: normalizedSource,
      destination: null,
      reason: null,
    };
    record.updatedAt = preparedAt;
    await persist(record);
    emit({ component: "task-capsule", type: "fresh_resume.prepared", severity: "info", status: "prepared", message: "Fresh Chat Resume was prepared for a Task Capsule.", details: { taskId: record.taskId, resumeId: record.freshResume.resumeId, checkpointRevision: record.checkpointRevision } });
    return publicTask(record);
  });
  const reserveFreshResumeMutation = (taskId, resumeId) => withMutation(async () => {
    await initialize();
    const record = requireTask(taskId);
    const freshResume = record.freshResume;
    if (!freshResume || freshResume.resumeId !== resumeId) throw new Error("Fresh Chat Resume reservation no longer matches the current task checkpoint.");
    if (freshResume.status !== "prepared") throw new Error(`Fresh Chat Resume cannot reserve browser mutation from state ${freshResume.status}.`);
    if (freshResume.checkpointRevision !== record.checkpointRevision) throw new Error("Fresh Chat Resume checkpoint changed before browser mutation.");
    freshResume.status = "creating";
    freshResume.mutationStartedAt = iso(now());
    freshResume.reason = null;
    record.updatedAt = freshResume.mutationStartedAt;
    await persist(record);
    emit({ component: "task-capsule", type: "fresh_resume.mutation_reserved", severity: "info", status: "creating", message: "Fresh Chat Resume reserved browser mutation before creating a destination chat.", details: { taskId: record.taskId, resumeId } });
    return publicTask(record);
  });
  const settleFreshResume = (taskId, resumeId, status, { destination = null, reason = null } = {}) => withMutation(async () => {
    await initialize();
    if (!["confirmed", "ambiguous"].includes(status)) throw new Error("Fresh Chat Resume settlement state is invalid.");
    const record = requireTask(taskId);
    const freshResume = record.freshResume;
    if (!freshResume || freshResume.resumeId !== resumeId) throw new Error("Fresh Chat Resume settlement no longer matches the current task checkpoint.");
    if (freshResume.status !== "creating") {
      if (freshResume.status === status) return publicTask(record);
      throw new Error(`Fresh Chat Resume cannot settle from state ${freshResume.status}.`);
    }
    if (status === "confirmed") {
      freshResume.destination = normalizeFreshResumeDestination(destination, freshResume.source);
      record.chatBinding = cloneChatBinding(freshResume.destination);
      freshResume.reason = null;
    } else {
      freshResume.destination = null;
      freshResume.reason = boundedText(String(reason || "browser_transition_ambiguous"), { label: "Fresh Chat Resume ambiguous reason", maxChars: 160 });
    }
    freshResume.status = status;
    freshResume.completedAt = iso(now());
    record.updatedAt = freshResume.completedAt;
    await persist(record);
    emit({ component: "task-capsule", type: status === "confirmed" ? "fresh_resume.confirmed" : "fresh_resume.ambiguous", severity: status === "confirmed" ? "info" : "warn", status, message: status === "confirmed" ? "Fresh Chat Resume destination was confirmed and bound to the task." : "Fresh Chat Resume ended in an ambiguous state and will not retry automatically.", details: { taskId: record.taskId, resumeId, reason: freshResume.reason } });
    return publicTask(record);
  });
  const cancelFreshResume = (taskId, reason = "cancelled") => withMutation(async () => {
    await initialize();
    const record = requireTask(taskId);
    const freshResume = record.freshResume;
    if (!freshResume || ["cancelled", "confirmed"].includes(freshResume.status)) return publicTask(record);
    const normalizedReason = boundedText(String(reason), { label: "Fresh Chat Resume cancellation reason", maxChars: 120 });
    const completedAt = iso(now());
    if (freshResume.status === "creating") {
      freshResume.status = "ambiguous";
      freshResume.reason = `${normalizedReason}_during_creating`.slice(0, 160);
    } else {
      freshResume.status = "cancelled";
      freshResume.reason = normalizedReason;
    }
    freshResume.completedAt = completedAt;
    record.updatedAt = completedAt;
    await persist(record);
    emit({ component: "task-capsule", type: freshResume.status === "ambiguous" ? "fresh_resume.ambiguous" : "fresh_resume.cancelled", severity: freshResume.status === "ambiguous" ? "warn" : "info", status: freshResume.status, message: freshResume.status === "ambiguous" ? "Fresh Chat Resume was interrupted after browser mutation reservation; automatic retry is disabled." : "Fresh Chat Resume was cancelled before browser mutation.", details: { taskId: record.taskId, resumeId: freshResume.resumeId, reason: freshResume.reason } });
    return publicTask(record);
  });
  const abandonFreshResume = (taskId, reason = "abandoned") => withMutation(async () => {
    await initialize();
    const record = requireTask(taskId);
    const freshResume = record.freshResume;
    if (!freshResume || freshResume.status === "cancelled") return publicTask(record);
    if (freshResume.status === "confirmed") throw new Error("A confirmed Fresh Chat Resume cannot be abandoned.");
    if (freshResume.status === "creating") throw new Error("Fresh Chat Resume cannot be abandoned while browser mutation is in progress.");
    const normalizedReason = boundedText(String(reason), { label: "Fresh Chat Resume abandon reason", maxChars: 120 });
    freshResume.status = "cancelled";
    freshResume.reason = normalizedReason;
    freshResume.completedAt = iso(now());
    record.updatedAt = freshResume.completedAt;
    await persist(record);
    emit({ component: "task-capsule", type: "fresh_resume.cancelled", severity: "info", status: "cancelled", message: "Fresh Chat Resume recovery state was explicitly abandoned.", details: { taskId: record.taskId, resumeId: freshResume.resumeId, reason: normalizedReason } });
    return publicTask(record);
  });
  const cancelAllFreshResumes = (reason = "emergency_stop") => withMutation(async () => {
    await initialize();
    const cancelled = [];
    const ambiguous = [];
    const timestamp = iso(now());
    for (const record of records.values()) {
      const freshResume = record.freshResume;
      if (!freshResume || record.status !== "active") continue;
      if (freshResume.status === "prepared") {
        freshResume.status = "cancelled";
        freshResume.reason = reason;
        freshResume.completedAt = timestamp;
        record.updatedAt = timestamp;
        await persist(record);
        cancelled.push(record.taskId);
      } else if (freshResume.status === "creating") {
        freshResume.status = "ambiguous";
        freshResume.reason = `${reason}_during_creating`.slice(0, 160);
        freshResume.completedAt = timestamp;
        record.updatedAt = timestamp;
        await persist(record);
        ambiguous.push(record.taskId);
      }
    }
    if (cancelled.length || ambiguous.length) emit({ component: "task-capsule", type: "fresh_resume.cancelled_all", severity: "warn", status: ambiguous.length ? "ambiguous" : "cancelled", message: "Pending Fresh Chat Resume transitions were stopped.", details: { cancelled: cancelled.length, ambiguous: ambiguous.length, reason } });
    return { cancelled: cancelled.length, ambiguous: ambiguous.length, taskIds: [...cancelled, ...ambiguous] };
  });
  const reconcileFreshResumesAfterRestart = () => withMutation(async () => {
    await initialize();
    const resumable = [];
    const retired = [];
    for (const record of records.values()) {
      const freshResume = record.freshResume;
      if (!freshResume || record.status !== "active") continue;
      if (freshResume.status === "creating") {
        freshResume.status = "ambiguous";
        freshResume.reason = "runtime_restart_ambiguous_resume";
        freshResume.completedAt = iso(now());
        record.updatedAt = freshResume.completedAt;
        await persist(record);
        retired.push(record.taskId);
      } else if (freshResume.status === "prepared") {
        resumable.push(cloneContinuationRecord(record));
      }
    }
    return { resumable, retired };
  });
  const readInternal = async (taskId) => { await initialize(); return cloneContinuationRecord(requireTask(taskId)); };
  const pendingContinuations = async () => {
    await initialize();
    return [...records.values()]
      .filter((record) => record.status === "active" && ["armed", "delivering"].includes(record.continuation?.status))
      .map(cloneContinuationRecord);
  };
  const reserveContinuationDelivery = (taskId, continuationId) => withMutation(async () => {
    await initialize();
    const record = requireTask(taskId);
    const continuation = record.continuation;
    if (!continuation || continuation.continuationId !== continuationId) throw new Error("Auto Continue delivery reservation no longer matches the current task checkpoint.");
    if (continuation.status !== "armed") throw new Error(`Auto Continue cannot reserve delivery from state ${continuation.status}.`);
    if (Date.parse(continuation.expiresAt) <= now()) {
      continuation.status = "expired";
      continuation.reason = "ttl_expired";
      record.updatedAt = iso(now());
      await persist(record);
      throw new Error("Auto Continue expired before delivery reservation.");
    }
    continuation.status = "delivering";
    continuation.reason = null;
    continuation.deliveryStartedAt = iso(now());
    record.updatedAt = continuation.deliveryStartedAt;
    await persist(record);
    emit({ component: "task-capsule", type: "continuation.delivery_reserved", severity: "info", status: "delivering", message: "Auto Continue delivery was reserved before browser mutation.", details: { taskId: record.taskId, continuationId } });
    return publicTask(record);
  });
  const settleContinuationDelivery = (taskId, continuationId, status, reason = null) => withMutation(async () => {
    await initialize();
    if (!["delivered", "failed"].includes(status)) throw new Error("Auto Continue delivery settlement state is invalid.");
    const record = requireTask(taskId);
    const continuation = record.continuation;
    if (!continuation || continuation.continuationId !== continuationId) throw new Error("Auto Continue delivery settlement no longer matches the current task checkpoint.");
    if (continuation.status !== "delivering") {
      if (continuation.status === status) return publicTask(record);
      throw new Error(`Auto Continue cannot settle delivery from state ${continuation.status}.`);
    }
    continuation.status = status;
    continuation.reason = reason === null ? null : boundedText(String(reason), { label: "delivery reason", maxChars: 120 });
    continuation.deliveryCompletedAt = iso(now());
    record.updatedAt = continuation.deliveryCompletedAt;
    await persist(record);
    emit({ component: "task-capsule", type: status === "delivered" ? "continuation.delivered" : "continuation.delivery_failed", severity: status === "delivered" ? "info" : "warn", status, message: status === "delivered" ? "Auto Continue delivery was confirmed." : "Auto Continue delivery failed without retry.", details: { taskId: record.taskId, continuationId, reason: continuation.reason } });
    return publicTask(record);
  });
  const expireContinuation = (taskId, continuationId) => withMutation(async () => {
    await initialize();
    const record = requireTask(taskId);
    const continuation = record.continuation;
    if (!continuation || continuation.continuationId !== continuationId || continuation.status !== "armed") return publicTask(record);
    continuation.status = "expired";
    continuation.reason = "ttl_expired";
    record.updatedAt = iso(now());
    await persist(record);
    return publicTask(record);
  });
  const reconcileContinuationsAfterRestart = () => withMutation(async () => {
    await initialize();
    const resumable = [];
    const retired = [];
    for (const record of records.values()) {
      const continuation = record.continuation;
      if (!continuation || record.status !== "active") continue;
      if (continuation.status === "delivering") {
        continuation.status = "failed";
        continuation.reason = "runtime_restart_ambiguous_delivery";
        continuation.deliveryCompletedAt = iso(now());
        record.updatedAt = continuation.deliveryCompletedAt;
        await persist(record);
        retired.push(record.taskId);
        continue;
      }
      if (continuation.status === "armed" && Date.parse(continuation.expiresAt) <= now()) {
        continuation.status = "expired";
        continuation.reason = "ttl_expired";
        record.updatedAt = iso(now());
        await persist(record);
        retired.push(record.taskId);
        continue;
      }
      if (continuation.status === "armed") resumable.push(cloneContinuationRecord(record));
    }
    return { resumable, retired };
  });
  return Object.freeze({ initialize, checkpoint, read, readInternal, list, finish, cancel, remove, armContinuation, cancelContinuation, cancelAllContinuations, pendingContinuations, reserveContinuationDelivery, settleContinuationDelivery, expireContinuation, reconcileContinuationsAfterRestart, prepareFreshResume, reserveFreshResumeMutation, settleFreshResume, cancelFreshResume, abandonFreshResume, cancelAllFreshResumes, reconcileFreshResumesAfterRestart, snapshot: async () => ({ tasks: await list({ limit: 50 }), loadErrors: [...loadErrors] }) });
}
