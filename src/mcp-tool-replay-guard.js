import { createHash } from "node:crypto";

const DEFAULT_SETTLED_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ABORT_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 256;

function canonicalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) output[key] = canonicalize(value[key]);
  }
  return output;
}

function fingerprint(toolName, input) {
  const canonical = JSON.stringify(canonicalize(input ?? null));
  return createHash("sha256").update(toolName).update("\0").update(canonical).digest("hex");
}

function normalizeRequestId(value) {
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `n:${value}`;
  return null;
}

function requestKey(toolName, extra) {
  const requestId = normalizeRequestId(extra?.requestId);
  if (!requestId) return null;
  const sessionId = typeof extra?.sessionId === "string" ? extra.sessionId : "";
  return `${toolName}\0${sessionId}\0${requestId}`;
}

export function createMcpToolReplayGuard({
  now = () => Date.now(),
  settledTtlMs = DEFAULT_SETTLED_TTL_MS,
  abortReplayWindowMs = DEFAULT_ABORT_REPLAY_WINDOW_MS,
  maxRecords = DEFAULT_MAX_RECORDS,
  onReplay = null,
} = {}) {
  const records = new Set();
  const byRequest = new Map();
  const latestByFingerprint = new Map();

  const removeRecord = (record) => {
    records.delete(record);
    if (latestByFingerprint.get(record.fingerprint) === record) {
      latestByFingerprint.delete(record.fingerprint);
    }
    for (const key of record.requestKeys) {
      if (byRequest.get(key) === record) byRequest.delete(key);
    }
  };

  const cleanup = () => {
    const timestamp = now();
    for (const record of [...records]) {
      if (record.settledAt !== null && timestamp - record.settledAt > settledTtlMs) {
        removeRecord(record);
      }
    }

    if (records.size <= maxRecords) return;
    const settled = [...records]
      .filter((record) => record.settledAt !== null)
      .sort((a, b) => a.settledAt - b.settledAt);
    while (records.size > maxRecords && settled.length > 0) {
      removeRecord(settled.shift());
    }
  };

  const noteReplay = (record, toolName, mode) => {
    if (typeof onReplay !== "function") return;
    void Promise.resolve(onReplay({
      toolName,
      mode,
      ageMs: Math.max(0, now() - record.createdAt),
      settled: record.settledAt !== null,
    })).catch(() => {});
  };

  const run = ({ toolName, input, extra, invoke }) => {
    if (typeof invoke !== "function") throw new Error("MCP replay guard invoke callback is required.");
    const key = requestKey(toolName, extra);
    if (!key) return invoke();

    cleanup();
    const inputFingerprint = fingerprint(toolName, input);
    const exact = byRequest.get(key);
    const sameFingerprint = exact?.fingerprint === inputFingerprint;
    const sameSignal = Boolean(
      exact &&
      exact.signal &&
      extra?.signal &&
      exact.signal === extra.signal
    );
    const exactStillInFlight = exact?.settledAt === null;
    if (sameFingerprint && (sameSignal || exactStillInFlight)) {
      noteReplay(exact, toolName, "request_id");
      return exact.promise;
    }

    const previous = latestByFingerprint.get(inputFingerprint);
    const previousAborted = previous?.signal?.aborted === true;
    const previousAge = previous ? Math.max(0, now() - previous.createdAt) : Infinity;
    if (previous && previousAborted && previousAge <= abortReplayWindowMs) {
      previous.requestKeys.add(key);
      byRequest.set(key, previous);
      noteReplay(previous, toolName, "aborted_semantic");
      return previous.promise;
    }

    const record = {
      fingerprint: inputFingerprint,
      requestKeys: new Set([key]),
      signal: extra?.signal ?? null,
      createdAt: now(),
      settledAt: null,
      promise: null,
    };
    records.add(record);
    byRequest.set(key, record);
    latestByFingerprint.set(inputFingerprint, record);

    record.promise = Promise.resolve().then(invoke);
    record.promise.then(
      () => { record.settledAt = now(); cleanup(); },
      () => { record.settledAt = now(); cleanup(); },
    );
    return record.promise;
  };

  return Object.freeze({
    run,
    snapshot: () => ({
      records: records.size,
      requestKeys: byRequest.size,
      fingerprints: latestByFingerprint.size,
    }),
  });
}
