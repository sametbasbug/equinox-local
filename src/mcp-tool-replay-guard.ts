import { createHash } from "node:crypto";

type ReplaySignal = Readonly<{aborted?:boolean}>;
type ReplayExtra = Readonly<{
  requestId?:unknown;
  sessionId?:unknown;
  signal?:ReplaySignal|null;
}>;
type ReplayEvent = Readonly<{
  toolName:string;
  mode:"request_id"|"inflight_semantic"|"aborted_semantic";
  ageMs:number;
  settled:boolean;
}>;
type ReplayConfig = Readonly<{
  now?:()=>number;
  settledTtlMs?:number;
  abortReplayWindowMs?:number;
  inFlightReplayWindowMs?:number;
  maxRecords?:number;
  onReplay?:((event:ReplayEvent)=>unknown)|null;
}>;
type ReplayRecord = {
  fingerprint:string;
  requestKeys:Set<string>;
  signal:ReplaySignal|null;
  createdAt:number;
  settledAt:number|null;
  promise:Promise<unknown>|null;
};
type Invocation<T> = Readonly<{
  toolName:string;
  input:unknown;
  extra?:ReplayExtra|null;
  invoke:()=>T|Promise<T>;
}>;

const DEFAULT_SETTLED_TTL_MS = 10 * 60 * 1000;
const DEFAULT_ABORT_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_IN_FLIGHT_REPLAY_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 256;

function canonicalize(value:unknown):unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const output:Record<string,unknown> = {};
  const obj=value as Record<string,unknown>;
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] !== undefined) output[key] = canonicalize(obj[key]);
  }
  return output;
}

function fingerprint(toolName:string,input:unknown):string {
  const canonical = JSON.stringify(canonicalize(input ?? null));
  return createHash("sha256").update(toolName).update("\0").update(canonical).digest("hex");
}

function normalizeRequestId(value:unknown):string|null {
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `n:${value}`;
  return null;
}

function requestKey(toolName:string,extra:ReplayExtra|null|undefined):string|null {
  const requestId = normalizeRequestId(extra?.requestId);
  if (!requestId) return null;
  const sessionId = typeof extra?.sessionId === "string" ? extra.sessionId : "";
  return `${toolName}\0${sessionId}\0${requestId}`;
}

export function createMcpToolReplayGuard({
  now = () => Date.now(),
  settledTtlMs = DEFAULT_SETTLED_TTL_MS,
  abortReplayWindowMs = DEFAULT_ABORT_REPLAY_WINDOW_MS,
  inFlightReplayWindowMs = DEFAULT_IN_FLIGHT_REPLAY_WINDOW_MS,
  maxRecords = DEFAULT_MAX_RECORDS,
  onReplay = null,
}:ReplayConfig = {}) {
  const records = new Set<ReplayRecord>();
  const byRequest = new Map<string,ReplayRecord>();
  const latestByFingerprint = new Map<string,ReplayRecord>();

  const removeRecord = (record:ReplayRecord) => {
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
      .sort((a, b) => a.settledAt! - b.settledAt!);
    while (records.size > maxRecords && settled.length > 0) {
      removeRecord(settled.shift()!);
    }
  };

  const noteReplay = (record:ReplayRecord,toolName:string,mode:ReplayEvent["mode"]) => {
    if (typeof onReplay !== "function") return;
    try {
      void Promise.resolve(onReplay({
        toolName,
        mode,
        ageMs: Math.max(0, now() - record.createdAt),
        settled: record.settledAt !== null,
      })).catch(() => {});
    } catch {
      // Replay telemetry must never break the owned invocation/result boundary.
    }
  };

  const run = <T>({toolName,input,extra,invoke}:Invocation<T>):T|Promise<T> => {
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
      return exact.promise as Promise<T>;
    }

    const previous = latestByFingerprint.get(inputFingerprint);
    const previousAge = previous ? Math.max(0, now() - previous.createdAt) : Infinity;
    const previousStillInFlight = previous?.settledAt === null;
    if (previous && previousStillInFlight && previousAge <= inFlightReplayWindowMs) {
      previous.requestKeys.add(key);
      byRequest.set(key, previous);
      noteReplay(previous, toolName, "inflight_semantic");
      return previous.promise as Promise<T>;
    }

    const previousAborted = previous?.signal?.aborted === true;
    if (previous && previousAborted && previousAge <= abortReplayWindowMs) {
      previous.requestKeys.add(key);
      byRequest.set(key, previous);
      noteReplay(previous, toolName, "aborted_semantic");
      return previous.promise as Promise<T>;
    }

    const record:ReplayRecord = {
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
    return record.promise as Promise<T>;
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
