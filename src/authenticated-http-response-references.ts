type ReferenceEntry = {
  profileId: string;
  trustIdentity: string;
  body: unknown;
  bytes: number;
  expiresAt: number;
};
type CaptureInput = {
  profileId?: unknown;
  trustIdentity?: unknown;
  body?: unknown;
};
type ResolveInput = {
  responseId?: unknown;
  profileId?: unknown;
  trustIdentity?: unknown;
  jsonPointer?: unknown;
};
type StoreOptions = {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  now?: () => number;
  randomBytesImpl?: (size: number) => Buffer;
};
type ResponseStore = {
  resolve: (input: ResolveInput) => unknown;
};
type ResponseContext = {
  profileId?: unknown;
  trustIdentity?: unknown;
  responseStore?: ResponseStore | null;
};
type Binding = {
  target_json_pointer: unknown;
  response_id: unknown;
  source_json_pointer: unknown;
};
type ValidatedBinding = {
  responseId: unknown;
  sourceJsonPointer: unknown;
  targetJsonPointer: unknown;
  targetSegments: string[];
};
type ResolvedBinding = ValidatedBinding & {value: unknown};

import { randomBytes } from "node:crypto";

export const AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS = Object.freeze({
  ttlMs: 10 * 60 * 1000,
  maxEntries: 64,
  maxBytes: 16 * 1024 * 1024,
  maxPointerChars: 2 * 1024,
  maxPointerSegments: 64,
  maxTraversalDepth: 32,
  maxTraversalNodes: 10_000,
  maxRefsPerRequest: 64,
});

const RESPONSE_ID_PATTERN = /^http_resp_[a-f0-9]{32}$/u;
const SENTINEL = "$equinox_response_ref";

function referenceError(message: string): Error & {code: string} {
  const error = new Error(message) as Error & {code: string};
  error.code = "EQUINOX_AUTHENTICATED_HTTP_RESPONSE_REFERENCE";
  return error;
}

function jsonBytes(value: unknown): number {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw referenceError("Authenticated HTTP response reference body is not JSON-compatible.");
  }
  if (serialized === undefined) throw referenceError("Authenticated HTTP response reference body is not JSON-compatible.");
  return Buffer.byteLength(serialized, "utf8");
}

function decodePointerToken(token: string): string {
  if (/~(?![01])/u.test(token)) throw referenceError("Authenticated HTTP response reference JSON Pointer contains invalid escaping.");
  return token.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

function parseJsonPointer(pointer: unknown): string[] {
  if (typeof pointer !== "string" || pointer.length > AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS.maxPointerChars) {
    throw referenceError("Authenticated HTTP response reference JSON Pointer is invalid or too large.");
  }
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw referenceError("Authenticated HTTP response reference JSON Pointer must be empty or start with /.");
  const segments = pointer.slice(1).split("/");
  if (segments.length > AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS.maxPointerSegments) {
    throw referenceError("Authenticated HTTP response reference JSON Pointer has too many segments.");
  }
  return segments.map(decodePointerToken);
}

function resolveJsonPointer(document: unknown, pointer: unknown): unknown {
  const segments = parseJsonPointer(pointer);
  let current: unknown = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) throw referenceError("Authenticated HTTP response reference JSON Pointer array index is invalid.");
      const index = Number.parseInt(segment, 10);
      if (!Number.isSafeInteger(index) || index >= current.length) throw referenceError("Authenticated HTTP response reference JSON Pointer does not exist.");
      current = current[index];
      continue;
    }
    if (current && typeof current === "object") {
      if (!Object.hasOwn(current, segment)) throw referenceError("Authenticated HTTP response reference JSON Pointer does not exist.");
      current = (current as Record<string, unknown>)[segment];
      continue;
    }
    throw referenceError("Authenticated HTTP response reference JSON Pointer does not exist.");
  }
  return current;
}

export function createAuthenticatedHttpResponseReferenceStore({
  ttlMs = AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS.ttlMs,
  maxEntries = AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS.maxEntries,
  maxBytes = AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS.maxBytes,
  now = () => Date.now(),
  randomBytesImpl = randomBytes,
}: StoreOptions = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("HTTP response reference TTL must be a positive integer.");
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("HTTP response reference entry limit must be a positive integer.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("HTTP response reference byte limit must be a positive integer.");
  const entries = new Map<string, ReferenceEntry>();
  let totalBytes = 0;

  function remove(responseId: string): boolean {
    const entry = entries.get(responseId);
    if (!entry) return false;
    entries.delete(responseId);
    totalBytes -= entry.bytes;
    return true;
  }
  function pruneExpired() {
    const current = now();
    for (const [responseId, entry] of entries) if (entry.expiresAt <= current) remove(responseId);
  }
  function evictToBounds() {
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      const oldest = entries.keys().next().value;
      if (!oldest) break;
      remove(oldest);
    }
  }
  function nextResponseId() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const responseId = `http_resp_${randomBytesImpl(16).toString("hex")}`;
      if (RESPONSE_ID_PATTERN.test(responseId) && !entries.has(responseId)) return responseId;
    }
    throw referenceError("Authenticated HTTP response reference id generation failed.");
  }

  return Object.freeze({
    capture({ profileId, trustIdentity, body }: CaptureInput = {}) {
      if (typeof profileId !== "string" || !profileId) throw referenceError("Authenticated HTTP response reference profile is invalid.");
      if (typeof trustIdentity !== "string" || !trustIdentity) throw referenceError("Authenticated HTTP response reference trust identity is invalid.");
      pruneExpired();
      const bytes = jsonBytes(body);
      if (bytes > maxBytes) throw referenceError("Authenticated HTTP response is too large for the response reference cache.");
      const responseId = nextResponseId();
      entries.set(responseId, { profileId, trustIdentity, body, bytes, expiresAt: now() + ttlMs });
      totalBytes += bytes;
      evictToBounds();
      return responseId;
    },
    resolve({ responseId, profileId, trustIdentity, jsonPointer }: ResolveInput = {}) {
      if (typeof responseId !== "string" || !RESPONSE_ID_PATTERN.test(responseId)) throw referenceError("Authenticated HTTP response reference id is invalid.");
      const entry = entries.get(responseId as string);
      if (!entry) {
        pruneExpired();
        throw referenceError("Authenticated HTTP response reference is unknown or expired.");
      }
      if (entry.expiresAt <= now()) {
        remove(responseId as string);
        throw referenceError("Authenticated HTTP response reference is expired.");
      }
      if (entry.profileId !== profileId || entry.trustIdentity !== trustIdentity) {
        throw referenceError("Authenticated HTTP response reference does not belong to this profile trust identity.");
      }
      const value = resolveJsonPointer(entry.body, jsonPointer);
      if (typeof value !== "string") throw referenceError("Authenticated HTTP response references may resolve only to string values.");
      entries.delete(responseId as string);
      entries.set(responseId as string, entry);
      return value;
    },
    purgeProfile(profileId: unknown) {
      let removed = 0;
      for (const [responseId, entry] of entries) {
        if (entry.profileId === profileId) {
          remove(responseId as string);
          removed += 1;
        }
      }
      return removed;
    },
    snapshot() {
      pruneExpired();
      return Object.freeze({ entries: entries.size, totalBytes, maxEntries, maxBytes, ttlMs });
    },
  });
}

export function resolveAuthenticatedHttpResponseReferences(value: unknown, { profileId, trustIdentity, responseStore }: ResponseContext = {}) {
  if (!responseStore || typeof responseStore.resolve !== "function") throw new Error("Authenticated HTTP response reference store is unavailable.");
  const state = { nodes: 0, refs: 0, redactions: new Set<unknown>() };

  function visit(current: unknown, depth: number): unknown {
    state.nodes += 1;
    if (state.nodes > AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS.maxTraversalNodes) throw referenceError("Authenticated HTTP request body is too complex for response reference resolution.");
    if (depth > AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS.maxTraversalDepth) throw referenceError("Authenticated HTTP request body is too deeply nested for response reference resolution.");
    if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));
    if (current && typeof current === "object") {
      if (Object.hasOwn(current, SENTINEL)) {
        if (Object.keys(current).length !== 1) throw referenceError("Authenticated HTTP response reference object must not contain extra fields.");
        const descriptor = (current as Record<string, unknown>)[SENTINEL];
        if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw referenceError("Authenticated HTTP response reference descriptor must be an object.");
        const descriptorKeys = Object.keys(descriptor).sort();
        if (descriptorKeys.length !== 2 || descriptorKeys[0] !== "json_pointer" || descriptorKeys[1] !== "response_id") {
          throw referenceError("Authenticated HTTP response reference descriptor must contain exactly response_id and json_pointer.");
        }
        state.refs += 1;
        if (state.refs > AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS.maxRefsPerRequest) throw referenceError("Authenticated HTTP request contains too many response references.");
        const resolved = responseStore!.resolve({
          responseId: (descriptor as Record<string, unknown>).response_id,
          profileId,
          trustIdentity,
          jsonPointer: (descriptor as Record<string, unknown>).json_pointer,
        });
        state.redactions.add(resolved);
        return resolved;
      }
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(current)) output[key] = visit(item, depth + 1);
      return output;
    }
    return current;
  }

  return Object.freeze({
    value: visit(value, 0),
    redactions: Object.freeze([...state.redactions]),
    refsResolved: state.refs,
  });
}


const UNSAFE_TARGET_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function parseBindingTargetPointer(pointer: unknown): string[] {
  const segments = parseJsonPointer(pointer);
  if (segments.length === 0) {
    throw referenceError("Authenticated HTTP response binding target JSON Pointer cannot replace the body root.");
  }
  for (const segment of segments) {
    if (UNSAFE_TARGET_SEGMENTS.has(segment)) {
      throw referenceError("Authenticated HTTP response binding target JSON Pointer contains a forbidden segment.");
    }
  }
  return segments;
}

function assertJsonObjectBody(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw referenceError("Authenticated HTTP response bindings require a JSON object request body.");
  }
}

export function applyAuthenticatedHttpResponseBindings(value: unknown, bindings: unknown, {
  profileId,
  trustIdentity,
  responseStore,
}: ResponseContext = {}) {
  if (bindings === undefined || bindings === null || (bindings as {length?: unknown}).length === 0) {
    return Object.freeze({
      value,
      redactions: Object.freeze([]),
      bindingsResolved: 0,
    });
  }
  if (!Array.isArray(bindings)) {
    throw referenceError("Authenticated HTTP response bindings must be an array.");
  }
  if (bindings.length > AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS.maxRefsPerRequest) {
    throw referenceError("Authenticated HTTP request contains too many response bindings.");
  }
  if (!responseStore || typeof responseStore.resolve !== "function") {
    throw new Error("Authenticated HTTP response reference store is unavailable.");
  }

  assertJsonObjectBody(value);
  const parsedBindings: ValidatedBinding[] = [];
  const targetPointers = new Set<unknown>();

  for (const binding of bindings) {
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      throw referenceError("Authenticated HTTP response binding must be an object.");
    }
    const keys = Object.keys(binding).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== "response_id" ||
      keys[1] !== "source_json_pointer" ||
      keys[2] !== "target_json_pointer"
    ) {
      throw referenceError("Authenticated HTTP response binding must contain exactly target_json_pointer, response_id and source_json_pointer.");
    }
    const typedBinding = binding as Binding;
    const targetSegments = parseBindingTargetPointer(typedBinding.target_json_pointer);
    parseJsonPointer(typedBinding.source_json_pointer);
    if (targetPointers.has(typedBinding.target_json_pointer)) {
      throw referenceError("Authenticated HTTP response bindings cannot target the same JSON Pointer twice.");
    }
    targetPointers.add(typedBinding.target_json_pointer);
    parsedBindings.push({
      responseId: typedBinding.response_id,
      sourceJsonPointer: typedBinding.source_json_pointer,
      targetJsonPointer: typedBinding.target_json_pointer,
      targetSegments,
    });
  }

  const resolved = parsedBindings.map((binding) => ({
    ...binding,
    value: responseStore.resolve({
      responseId: binding.responseId,
      profileId,
      trustIdentity,
      jsonPointer: binding.sourceJsonPointer,
    }),
  }));

  const output = structuredClone(value) as Record<string, unknown>;
  const redactions = new Set<unknown>();

  for (const binding of resolved) {
    let parent: unknown = output;
    const parentSegments = binding.targetSegments.slice(0, -1);
    const targetSegment = binding.targetSegments.at(-1);

    for (const segment of parentSegments) {
      if (Array.isArray(parent)) {
        throw referenceError("Authenticated HTTP response binding target arrays are not supported in V1.");
      }
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, segment)) {
        throw referenceError("Authenticated HTTP response binding target parent does not exist.");
      }
      parent = (parent as Record<string, unknown>)[segment];
    }

    if (Array.isArray(parent)) {
      throw referenceError("Authenticated HTTP response binding target arrays are not supported in V1.");
    }
    if (!parent || typeof parent !== "object") {
      throw referenceError("Authenticated HTTP response binding target parent is not an object.");
    }
    if (Object.hasOwn(parent, targetSegment as string)) {
      throw referenceError("Authenticated HTTP response binding target already exists and cannot be overwritten.");
    }

    (parent as Record<string, unknown>)[targetSegment as string] = binding.value;
    redactions.add(binding.value);
  }

  return Object.freeze({
    value: output,
    redactions: Object.freeze([...redactions]),
    bindingsResolved: resolved.length,
  });
}
