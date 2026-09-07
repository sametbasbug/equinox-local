import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_SEGMENT_BYTES = 512 * 1024;
const DEFAULT_MAX_SEGMENTS = 12;
const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;
const DEFAULT_MAX_QUERY_LIMIT = 500;
const CURRENT_FILE = "events-current.jsonl";
const SEGMENT_PATTERN = /^events-\d{13}-[a-z0-9-]{4,40}\.jsonl$/u;
const VALID_SEVERITIES = new Set(["info", "warn", "error", "critical"]);
const SECRET_KEY_PATTERN = /(?:authorization|cookie|token|secret|password|credential|api[_-]?key|private[_-]?key|session[_-]?key)/iu;

function toIso(value) {
  return new Date(value).toISOString();
}

function cleanString(value, max = 4_000) {
  const text = String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/giu, "Bearer [REDACTED]")
    .replace(/(authorization\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, "$1=[REDACTED]");
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function sanitizeValue(value, depth = 0) {
  if (depth > 6) {
    return "[DEPTH_LIMIT]";
  }
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return value ?? null;
  }
  if (typeof value === "string") {
    return cleanString(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, nested] of Object.entries(value).slice(0, 100)) {
      output[key] = SECRET_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : sanitizeValue(nested, depth + 1);
    }
    return output;
  }
  return cleanString(value);
}

function normalizeEventInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Observability event girdisi nesne olmalı.");
  }

  const component = cleanString(input.component ?? "runtime", 80).trim();
  const type = cleanString(input.type ?? "runtime.event", 120).trim();
  const severity = String(input.severity ?? "info").toLowerCase();

  if (!component || !/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(component)) {
    throw new Error("Observability component adı geçersiz.");
  }
  if (!type || !/^[a-z0-9][a-z0-9._-]{0,119}$/u.test(type)) {
    throw new Error("Observability event type geçersiz.");
  }
  if (!VALID_SEVERITIES.has(severity)) {
    throw new Error(`Geçersiz observability severity: ${severity}`);
  }

  const normalized = {
    component,
    type,
    severity,
    status: input.status === undefined || input.status === null
      ? null
      : cleanString(input.status, 80),
    projectId: input.projectId === undefined || input.projectId === null
      ? null
      : cleanString(input.projectId, 80),
    correlationId: input.correlationId === undefined || input.correlationId === null
      ? null
      : cleanString(input.correlationId, 160),
    message: input.message === undefined || input.message === null
      ? null
      : cleanString(input.message, 4_000),
    details: sanitizeValue(input.details ?? {}),
  };

  return normalized;
}

function healthKeyForEvent(event) {
  const type = String(event?.type ?? "");
  const correlation = event?.correlationId ? String(event.correlationId) : null;

  if (type.startsWith("peekaboo.permission")) {
    return "peekaboo:permissions";
  }
  if (type.startsWith("peekaboo.compatibility")) {
    return "peekaboo:compatibility";
  }
  if (["peekaboo.error", "peekaboo.unexpected_close", "peekaboo.started", "peekaboo.reconnected"].includes(type)) {
    return "peekaboo:transport";
  }
  if (type.startsWith("chrome.")) {
    return "chrome:transport";
  }
  if (event?.component === "repair" && event?.details?.incidentId) {
    return `repair:${String(event.details.incidentId)}`;
  }
  if (event?.component === "recovery-policy" && event?.details?.circuitKey) {
    return `recovery-policy:${String(event.details.circuitKey)}`;
  }
  if (correlation && ["workflow", "process", "terminal", "deployment", "release-gate"].includes(event?.component)) {
    return `${event.component}:${correlation}`;
  }
  return String(event?.component ?? "runtime");
}

async function safeStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function createRuntimeObservability({
  rootDir,
  now = () => Date.now(),
  randomId = () => randomUUID().slice(0, 10),
  maxSegmentBytes = DEFAULT_MAX_SEGMENT_BYTES,
  maxSegments = DEFAULT_MAX_SEGMENTS,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
} = {}) {
  if (typeof rootDir !== "string" || !path.isAbsolute(rootDir)) {
    throw new Error("Observability storage kökü mutlak bir yol olmalı.");
  }
  if (!Number.isInteger(maxSegmentBytes) || maxSegmentBytes < 16 * 1024) {
    throw new Error("Observability segment sınırı en az 16 KB olmalı.");
  }
  if (!Number.isInteger(maxSegments) || maxSegments < 1 || maxSegments > 100) {
    throw new Error("Observability segment sayısı 1-100 arasında olmalı.");
  }

  const currentPath = path.join(rootDir, CURRENT_FILE);
  let initialized = false;
  let appendTail = Promise.resolve();
  const segmentCache = new Map();
  const knownMalformedCounts = new Map();
  let malformedLines = 0;

  const listSegments = async () => {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const segments = [];
    for (const entry of entries) {
      if (!entry.isFile() || !SEGMENT_PATTERN.test(entry.name)) {
        continue;
      }
      const filePath = path.join(rootDir, entry.name);
      const stats = await fs.stat(filePath);
      segments.push({ filePath, name: entry.name, mtimeMs: stats.mtimeMs, size: stats.size });
    }
    return segments.sort((a, b) => a.mtimeMs - b.mtimeMs);
  };

  const pruneSegments = async () => {
    const segments = await listSegments();
    const present = new Set(segments.map((segment) => segment.filePath));
    for (const cachedPath of segmentCache.keys()) {
      if (!present.has(cachedPath)) segmentCache.delete(cachedPath);
    }
    const excess = Math.max(0, segments.length - maxSegments);
    for (const segment of segments.slice(0, excess)) {
      await fs.rm(segment.filePath, { force: true });
      segmentCache.delete(segment.filePath);
    }
  };

  const initialize = async () => {
    if (initialized) {
      return;
    }
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(rootDir, 0o700).catch(() => {});
    await fs.appendFile(currentPath, "", { mode: 0o600 });
    await fs.chmod(currentPath, 0o600).catch(() => {});
    await pruneSegments();
    initialized = true;
  };

  const rotateIfNeeded = async (incomingBytes) => {
    const stats = await safeStat(currentPath);
    const size = stats?.size ?? 0;
    if (size === 0 || size + incomingBytes <= maxSegmentBytes) {
      return;
    }
    const rotated = path.join(rootDir, `events-${String(now()).padStart(13, "0")}-${randomId()}.jsonl`);
    await fs.rename(currentPath, rotated);
    await fs.chmod(rotated, 0o600).catch(() => {});
    await fs.writeFile(currentPath, "", { mode: 0o600 });
    await fs.chmod(currentPath, 0o600).catch(() => {});
    await pruneSegments();
  };

  const runSerializedStorageOperation = (operation) => {
    const pending = appendTail.then(operation, operation);
    appendTail = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const record = async (input) => {
    await initialize();
    const normalized = normalizeEventInput(input);
    const timestamp = now();
    const event = {
      schemaVersion: 1,
      eventId: `evt-${timestamp.toString(36)}-${randomId()}`.toLowerCase(),
      timestamp: toIso(timestamp),
      timestampMs: timestamp,
      ...normalized,
    };
    const line = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > maxEventBytes) {
      throw new Error("Observability event 64 KB güvenlik sınırını aşıyor.");
    }

    const operation = async () => {
      await rotateIfNeeded(bytes);
      await fs.appendFile(currentPath, line, { mode: 0o600 });
      await fs.chmod(currentPath, 0o600).catch(() => {});
      return event;
    };
    return runSerializedStorageOperation(operation);
  };

  const readFileEvents = async (filePath) => {
    const text = await fs.readFile(filePath, "utf8");
    const events = [];
    let malformedCount = 0;
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed && Number.isFinite(parsed.timestampMs) && typeof parsed.type === "string") {
          events.push(parsed);
        } else {
          malformedCount += 1;
        }
      } catch {
        malformedCount += 1;
      }
    }
    knownMalformedCounts.set(filePath, malformedCount);
    malformedLines = [...knownMalformedCounts.values()].reduce((sum, count) => sum + count, 0);
    return { events, malformedCount };
  };

  const readSegmentEvents = async (segment) => {
    const cached = segmentCache.get(segment.filePath);
    if (
      cached &&
      cached.size === segment.size &&
      cached.mtimeMs === segment.mtimeMs
    ) {
      return cached.parsed;
    }
    const parsed = await readFileEvents(segment.filePath);
    segmentCache.set(segment.filePath, {
      size: segment.size,
      mtimeMs: segment.mtimeMs,
      parsed,
    });
    return parsed;
  };

  const allEvents = async () => {
    await initialize();
    return runSerializedStorageOperation(async () => {
      const segments = await listSegments();
      const parsedSegments = await Promise.all(segments.map(readSegmentEvents));
      const current = await readFileEvents(currentPath);
      const parsed = [...parsedSegments, current];
      malformedLines = parsed.reduce((sum, item) => sum + item.malformedCount, 0);
      return parsed
        .flatMap((item) => item.events)
        .sort((a, b) => a.timestampMs - b.timestampMs);
    });
  };

  const filterEvents = async ({
    sinceMs = null,
    untilMs = null,
    component = null,
    severity = null,
    type = null,
  } = {}) => {
    const events = await allEvents();
    return events.filter((event) =>
      (sinceMs === null || event.timestampMs >= sinceMs) &&
      (untilMs === null || event.timestampMs <= untilMs) &&
      (!component || event.component === component) &&
      (!severity || event.severity === severity) &&
      (!type || event.type === type),
    );
  };

  const query = async ({
    sinceMs = null,
    untilMs = null,
    limit = 100,
    component = null,
    severity = null,
    type = null,
    newestFirst = true,
  } = {}) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > DEFAULT_MAX_QUERY_LIMIT) {
      throw new Error(`Observability event limit 1-${DEFAULT_MAX_QUERY_LIMIT} arasında olmalı.`);
    }
    if (severity && !VALID_SEVERITIES.has(severity)) {
      throw new Error("Observability severity filtresi geçersiz.");
    }

    await initialize();
    return runSerializedStorageOperation(async () => {
      const matches = (event) =>
        (sinceMs === null || event.timestampMs >= sinceMs) &&
        (untilMs === null || event.timestampMs <= untilMs) &&
        (!component || event.component === component) &&
        (!severity || event.severity === severity) &&
        (!type || event.type === type);

      const segments = await listSegments();
      const sources = newestFirst
        ? [{ current: true }, ...segments.toReversed()]
        : [...segments, { current: true }];
      const result = [];

      for (const source of sources) {
        const parsed = source.current
          ? await readFileEvents(currentPath)
          : await readSegmentEvents(source);
        const events = newestFirst ? parsed.events.toReversed() : parsed.events;
        for (const event of events) {
          if (!matches(event)) continue;
          result.push(event);
          if (result.length >= limit) return result;
        }
      }
      return result;
    });
  };

  const storageStats = async () => {
    await initialize();
    return runSerializedStorageOperation(async () => {
      const segments = await listSegments();
      const current = await safeStat(currentPath);
      return {
        rootDir,
        currentBytes: current?.size ?? 0,
        segmentCount: segments.length,
        segmentBytes: segments.reduce((sum, item) => sum + item.size, 0),
        totalBytes: (current?.size ?? 0) + segments.reduce((sum, item) => sum + item.size, 0),
        maxSegmentBytes,
        maxSegments,
        malformedLines,
      };
    });
  };

  const metrics = async ({ windowMs = 24 * 60 * 60 * 1000 } = {}) => {
    const end = now();
    const start = Math.max(0, end - windowMs);
    const events = await filterEvents({ sinceMs: start, untilMs: end });
    const bySeverity = {};
    const byComponent = {};
    const byType = {};
    const byStatus = {};
    for (const event of events) {
      bySeverity[event.severity] = (bySeverity[event.severity] ?? 0) + 1;
      byComponent[event.component] = (byComponent[event.component] ?? 0) + 1;
      byType[event.type] = (byType[event.type] ?? 0) + 1;
      if (event.status) {
        byStatus[event.status] = (byStatus[event.status] ?? 0) + 1;
      }
    }
    return {
      window: { start: toIso(start), end: toIso(end), windowMs },
      totalEvents: events.length,
      bySeverity,
      byComponent,
      byType,
      byStatus,
      storage: await storageStats(),
    };
  };

  const health = async ({ windowMs = 15 * 60 * 1000 } = {}) => {
    const end = now();
    const events = await filterEvents({
      sinceMs: Math.max(0, end - windowMs),
      untilMs: end,
    });
    const latestByHealthKey = new Map();
    for (const event of events) {
      latestByHealthKey.set(healthKeyForEvent(event), event);
    }

    const attention = [...latestByHealthKey.values()].filter((event) =>
      event.status === "attention_required" || event.severity === "critical",
    );
    const recovering = [...latestByHealthKey.values()].filter((event) =>
      event.status === "recovering",
    );
    const degraded = [...latestByHealthKey.values()].filter((event) =>
      ["warn", "error"].includes(event.severity) &&
      !["recovered", "healthy", "completed"].includes(event.status),
    );

    let state = "HEALTHY";
    let reasons = [];
    if (attention.length > 0) {
      state = "ATTENTION REQUIRED";
      reasons = attention;
    } else if (recovering.length > 0) {
      state = "RECOVERING";
      reasons = recovering;
    } else if (degraded.length > 0) {
      state = "DEGRADED";
      reasons = degraded;
    }

    return {
      state,
      windowMs,
      evaluatedAt: toIso(end),
      reasons: reasons.slice(-10).map((event) => ({
        component: event.component,
        type: event.type,
        severity: event.severity,
        status: event.status,
        message: event.message,
        timestamp: event.timestamp,
      })),
      recentEventCount: events.length,
      storage: await storageStats(),
    };
  };

  const flush = async () => {
    await appendTail;
  };

  return Object.freeze({
    initialize,
    record,
    query,
    scan: filterEvents,
    metrics,
    health,
    storageStats,
    flush,
  });
}

export const __test = Object.freeze({
  DEFAULT_MAX_SEGMENT_BYTES,
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_MAX_EVENT_BYTES,
  CURRENT_FILE,
  SEGMENT_PATTERN,
  sanitizeValue,
  normalizeEventInput,
});
