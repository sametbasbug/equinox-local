import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readBoundedNormalFile,
  SAFE_FILE_ERROR_CODES,
} from "./equinox-local-safe-file.js";
import { sanitizeWorkflowOutput } from "./workflow-security.js";
import {
  applyAuthenticatedHttpResponseBindings,
  createAuthenticatedHttpResponseReferenceStore,
  resolveAuthenticatedHttpResponseReferences,
} from "./authenticated-http-response-references.js";

export const AUTHENTICATED_HTTP_LIMITS = Object.freeze({
  maxProfiles: 32,
  maxStoreBytes: 256 * 1024,
  maxPathChars: 2 * 1024,
  maxQueryEntries: 64,
  maxAgentHeaders: 16,
  maxHeaderValueBytes: 8 * 1024,
  maxRequestBodyBytes: 1024 * 1024,
  maxResponseBodyBytes: 2 * 1024 * 1024,
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 30_000,
  maxCredentialBytes: 8 * 1024,
});

const STORE_VERSION = 1;
const PROFILE_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const SUPPORTED_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const SUPPORTED_METHOD_SET = new Set(SUPPORTED_METHODS);
const RESERVED_AGENT_HEADERS = new Set([
  "authorization", "proxy-authorization", "proxy-authenticate", "cookie", "set-cookie",
  "host", "connection", "keep-alive", "transfer-encoding", "content-length", "content-type",
  "upgrade", "te", "trailer", "forwarded", "origin",
]);
const SAFE_RESPONSE_HEADERS = new Set([
  "content-type", "etag", "last-modified", "retry-after", "ratelimit-limit",
  "ratelimit-remaining", "ratelimit-reset", "x-ratelimit-limit", "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
const ENCODED_SEPARATOR_PATTERN = /%(?:2f|5c|25)/iu;

const DEFAULT_RESPONSE_REFERENCE_STORE = createAuthenticatedHttpResponseReferenceStore();

function profileError(message = "Authenticated HTTP profiles need attention.") {
  const error = new Error(message);
  error.code = "EQUINOX_AUTHENTICATED_HTTP_PROFILES";
  return error;
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function validateExactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  }
}

function normalizeProfileId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  if (!PROFILE_ID_PATTERN.test(id)) {
    throw new Error("HTTP profile id must start with a lowercase letter and contain only lowercase letters, numbers, dot, underscore or dash (max 64 characters).");
  }
  return id;
}

function normalizeLabel(value) {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label || label.length > 100 || CONTROL_PATTERN.test(label)) {
    throw new Error("HTTP profile label must contain 1-100 normal text characters.");
  }
  return label;
}

export function normalizeAuthenticatedHttpOrigin(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    throw new Error("HTTP profile origin must be a bounded HTTPS origin.");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("HTTP profile origin is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("HTTP profiles require HTTPS origins.");
  if (url.username || url.password) throw new Error("HTTP profile origin cannot contain user credentials.");
  if (url.search || url.hash) throw new Error("HTTP profile origin cannot contain query or fragment data.");
  if (url.pathname !== "/") throw new Error("HTTP profile origin must not contain an API path; use basePath instead.");
  return url.origin;
}

function decodedPathSegments(candidate, label) {
  const segments = candidate === "/" ? [] : candidate.slice(1).split("/");
  return segments.map((segment) => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`${label} contains invalid percent encoding.`);
    }
    if (decoded === "." || decoded === "..") throw new Error(`${label} cannot contain dot traversal segments.`);
    if (decoded.includes("/") || decoded.includes("\\")) throw new Error(`${label} cannot hide path separators in encoding.`);
    if (CONTROL_PATTERN.test(decoded)) throw new Error(`${label} contains control characters.`);
    return decoded;
  });
}

export function normalizeAuthenticatedHttpPath(value, label = "HTTP path") {
  if (typeof value !== "string" || !value || value.length > AUTHENTICATED_HTTP_LIMITS.maxPathChars) {
    throw new Error(`${label} must contain 1-${AUTHENTICATED_HTTP_LIMITS.maxPathChars} characters.`);
  }
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error(`${label} must begin with exactly one slash.`);
  }
  if (value.includes("\\") || value.includes("?") || value.includes("#") || CONTROL_PATTERN.test(value)) {
    throw new Error(`${label} contains unsupported path characters.`);
  }
  if (ENCODED_SEPARATOR_PATTERN.test(value)) throw new Error(`${label} cannot contain encoded separators or nested percent encoding.`);
  const normalized = value.length > 1 && value.endsWith("/") ? value.replace(/\/+$/u, "") : value;
  decodedPathSegments(normalized, label);
  return normalized || "/";
}

function pathAllowed(requestPath, prefix) {
  if (prefix === "/") return true;
  const requestSegments = decodedPathSegments(requestPath, "HTTP request path");
  const prefixSegments = decodedPathSegments(prefix, "HTTP allowed path prefix");
  if (prefixSegments.length > requestSegments.length) return false;
  return prefixSegments.every((segment, index) => segment === requestSegments[index]);
}

function normalizeMethodList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > SUPPORTED_METHODS.length) {
    throw new Error("HTTP profile must allow between 1 and 5 supported methods.");
  }
  const methods = [];
  for (const raw of value) {
    const method = typeof raw === "string" ? raw.toUpperCase() : "";
    if (!SUPPORTED_METHOD_SET.has(method)) throw new Error(`Unsupported HTTP profile method: ${raw}`);
    if (!methods.includes(method)) methods.push(method);
  }
  return methods.sort((left, right) => SUPPORTED_METHODS.indexOf(left) - SUPPORTED_METHODS.indexOf(right));
}

function normalizePathPrefixes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new Error("HTTP profile must define 1-32 allowed path prefixes.");
  }
  return [...new Set(value.map((item) => normalizeAuthenticatedHttpPath(item, "HTTP allowed path prefix")))];
}

function normalizeHeaderName(value, label = "HTTP header") {
  const name = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!name || name.length > 128 || !HEADER_NAME_PATTERN.test(name)) throw new Error(`${label} name is invalid.`);
  return name;
}

function assertHeaderIsAgentSafe(name, label = "HTTP agent header") {
  if (RESERVED_AGENT_HEADERS.has(name) || name.startsWith("proxy-") || name.startsWith("x-forwarded-") || name.startsWith("sec-")) {
    throw new Error(`${label} is reserved and cannot be agent-controlled: ${name}`);
  }
}

function normalizeAgentHeaderAllowlist(value = []) {
  if (!Array.isArray(value) || value.length > AUTHENTICATED_HTTP_LIMITS.maxAgentHeaders) {
    throw new Error(`HTTP profile may allow at most ${AUTHENTICATED_HTTP_LIMITS.maxAgentHeaders} agent headers.`);
  }
  const headers = [];
  for (const raw of value) {
    const name = normalizeHeaderName(raw, "HTTP allowed agent header");
    assertHeaderIsAgentSafe(name, "HTTP allowed agent header");
    if (!headers.includes(name)) headers.push(name);
  }
  return headers.sort();
}

function normalizeAuth(value) {
  const raw = assertPlainObject(value, "HTTP profile auth");
  validateExactKeys(raw, new Set(["type", "headerName", "header_name"]), "HTTP profile auth");
  if (raw.type === "bearer") return Object.freeze({ type: "bearer" });
  if (raw.type !== "secret_header") throw new Error("HTTP profile auth type must be bearer or secret_header.");
  const headerName = normalizeHeaderName(raw.headerName ?? raw.header_name, "HTTP secret header");
  assertHeaderIsAgentSafe(headerName, "HTTP secret header");
  return Object.freeze({ type: "secret_header", headerName });
}

function normalizeTimeoutMs(value) {
  if (value === undefined || value === null) return AUTHENTICATED_HTTP_LIMITS.defaultTimeoutMs;
  if (!Number.isInteger(value) || value < 1000 || value > AUTHENTICATED_HTTP_LIMITS.maxTimeoutMs) {
    throw new Error(`HTTP profile timeout must be 1000-${AUTHENTICATED_HTTP_LIMITS.maxTimeoutMs} ms.`);
  }
  return value;
}

export function validateAuthenticatedHttpProfileInput(value) {
  const raw = assertPlainObject(value, "HTTP profile");
  validateExactKeys(raw, new Set([
    "id", "label", "origin", "basePath", "base_path", "auth",
    "allowedMethods", "allowed_methods", "allowedPathPrefixes", "allowed_path_prefixes",
    "allowedAgentHeaders", "allowed_agent_headers", "timeoutMs", "timeout_ms",
  ]), "HTTP profile");
  return Object.freeze({
    id: normalizeProfileId(raw.id),
    label: normalizeLabel(raw.label),
    origin: normalizeAuthenticatedHttpOrigin(raw.origin),
    basePath: normalizeAuthenticatedHttpPath(raw.basePath ?? raw.base_path ?? "/", "HTTP profile basePath"),
    auth: normalizeAuth(raw.auth),
    allowedMethods: Object.freeze(normalizeMethodList(raw.allowedMethods ?? raw.allowed_methods)),
    allowedPathPrefixes: Object.freeze(normalizePathPrefixes(raw.allowedPathPrefixes ?? raw.allowed_path_prefixes ?? ["/"])),
    allowedAgentHeaders: Object.freeze(normalizeAgentHeaderAllowlist(raw.allowedAgentHeaders ?? raw.allowed_agent_headers ?? [])),
    timeoutMs: normalizeTimeoutMs(raw.timeoutMs ?? raw.timeout_ms),
  });
}

function validateCredential(value) {
  if (typeof value !== "string" || !value || CONTROL_PATTERN.test(value)) {
    throw new Error("HTTP profile credential must be non-empty text without control characters.");
  }
  if (Buffer.byteLength(value, "utf8") > AUTHENTICATED_HTTP_LIMITS.maxCredentialBytes) {
    throw new Error(`HTTP profile credential exceeds ${AUTHENTICATED_HTTP_LIMITS.maxCredentialBytes} bytes.`);
  }
  return value;
}

function trustIdentity(profile) {
  return `${profile.origin}\n${profile.auth.type}\n${profile.auth.type === "secret_header" ? profile.auth.headerName : "authorization"}`;
}

function publicProfile(record) {
  const ready = typeof record.credential === "string" && record.credential.length > 0;
  return Object.freeze({
    id: record.id, label: record.label, origin: record.origin, basePath: record.basePath,
    authType: record.auth.type,
    authHeader: record.auth.type === "secret_header" ? record.auth.headerName : "authorization",
    allowedMethods: [...record.allowedMethods], allowedPathPrefixes: [...record.allowedPathPrefixes],
    allowedAgentHeaders: [...record.allowedAgentHeaders], timeoutMs: record.timeoutMs,
    ready, needsCredential: !ready,
  });
}

export function defaultAuthenticatedHttpStorePath(homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "Application Support", "Equinox Local", "secrets", "authenticated-http.json");
}

async function ensurePrivateDirectory(directory, { fsImpl = fs } = {}) {
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw profileError("Authenticated HTTP credential directory is unsafe.");
  await fsImpl.chmod(directory, 0o700);
}

function emptyStore() {
  return { version: STORE_VERSION, agentProfileManagementEnabled: true, profiles: [] };
}

function validateStoredProfile(rawValue) {
  const raw = assertPlainObject(rawValue, "Stored HTTP profile");
  const { credential, ...structure } = raw;
  const profile = validateAuthenticatedHttpProfileInput(structure);
  const secret = credential === undefined ? undefined : validateCredential(credential);
  return { ...profile, ...(secret === undefined ? {} : { credential: secret }) };
}

function validateStore(raw) {
  const object = assertPlainObject(raw, "Authenticated HTTP profile store");
  validateExactKeys(object, new Set(["version", "agentProfileManagementEnabled", "profiles"]), "Authenticated HTTP profile store");
  if (object.version !== STORE_VERSION) throw profileError();
  if (typeof object.agentProfileManagementEnabled !== "boolean") throw profileError();
  if (!Array.isArray(object.profiles) || object.profiles.length > AUTHENTICATED_HTTP_LIMITS.maxProfiles) throw profileError();
  const profiles = object.profiles.map(validateStoredProfile);
  const ids = new Set();
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw profileError();
    ids.add(profile.id);
  }
  return { version: STORE_VERSION, agentProfileManagementEnabled: object.agentProfileManagementEnabled, profiles };
}

async function readStore({ storePath = defaultAuthenticatedHttpStorePath(), fsImpl = fs } = {}) {
  let text;
  let stat;
  try {
    ({ data: text, stat } = await readBoundedNormalFile(storePath, {
      fsImpl,
      minBytes: 1,
      maxBytes: AUTHENTICATED_HTTP_LIMITS.maxStoreBytes,
      encoding: "utf8",
      label: "Authenticated HTTP profile store",
    }));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyStore();
    if ([SAFE_FILE_ERROR_CODES.notNormal, SAFE_FILE_ERROR_CODES.tooSmall, SAFE_FILE_ERROR_CODES.tooLarge].includes(error?.code)) {
      throw profileError();
    }
    throw error;
  }
  if ((stat.mode & 0o777) !== 0o600) throw profileError();
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (Number.isInteger(uid) && Number.isInteger(stat.uid) && stat.uid !== uid) throw profileError();
  try {
    return validateStore(JSON.parse(text));
  } catch (error) {
    if (error?.code === "EQUINOX_AUTHENTICATED_HTTP_PROFILES") throw error;
    throw profileError();
  }
}

async function writeStore(store, { storePath = defaultAuthenticatedHttpStorePath(), fsImpl = fs } = {}) {
  const normalized = validateStore(store);
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > AUTHENTICATED_HTTP_LIMITS.maxStoreBytes) {
    throw profileError("Authenticated HTTP profile store is too large.");
  }
  const parent = path.dirname(storePath);
  await ensurePrivateDirectory(parent, { fsImpl });
  const temp = path.join(parent, `.equinox-auth-http-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await fsImpl.writeFile(temp, payload, { flag: "wx", mode: 0o600 });
    await fsImpl.rename(temp, storePath);
    await fsImpl.chmod(storePath, 0o600);
  } catch (error) {
    await fsImpl.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return normalized;
}

export async function getAuthenticatedHttpProfiles(options = {}) {
  const store = await readStore(options);
  return Object.freeze({
    agentProfileManagementEnabled: store.agentProfileManagementEnabled,
    profiles: Object.freeze(store.profiles.map(publicProfile)),
  });
}

export async function setAuthenticatedHttpAgentManagement({ enabled, ...options } = {}) {
  if (typeof enabled !== "boolean") throw new Error("HTTP profile agent-management setting must be boolean.");
  const store = await readStore(options);
  const next = await writeStore({ ...store, agentProfileManagementEnabled: enabled }, options);
  return Object.freeze({ agentProfileManagementEnabled: next.agentProfileManagementEnabled });
}

function replaceOrAppendProfile(store, record) {
  const index = store.profiles.findIndex((item) => item.id === record.id);
  if (index < 0) {
    if (store.profiles.length >= AUTHENTICATED_HTTP_LIMITS.maxProfiles) {
      throw new Error(`At most ${AUTHENTICATED_HTTP_LIMITS.maxProfiles} authenticated HTTP profiles may be configured.`);
    }
    return [...store.profiles, record].sort((left, right) => left.id.localeCompare(right.id));
  }
  return store.profiles.map((item, itemIndex) => itemIndex === index ? record : item);
}

export async function upsertAuthenticatedHttpProfileFromAgent({ profile, responseStore = DEFAULT_RESPONSE_REFERENCE_STORE, ...options } = {}) {
  const normalized = validateAuthenticatedHttpProfileInput(profile);
  const store = await readStore(options);
  if (!store.agentProfileManagementEnabled) {
    throw new Error("Agent HTTP profile management is disabled in Equinox Local Control Center.");
  }
  const existing = store.profiles.find((item) => item.id === normalized.id);
  const preserveCredential = existing && trustIdentity(existing) === trustIdentity(normalized);
  const record = {
    ...normalized,
    ...(preserveCredential && existing.credential ? { credential: existing.credential } : {}),
  };
  const next = await writeStore({ ...store, profiles: replaceOrAppendProfile(store, record) }, options);
  if (existing && !preserveCredential) responseStore?.purgeProfile?.(normalized.id);
  return publicProfile(next.profiles.find((item) => item.id === normalized.id));
}

export async function upsertAuthenticatedHttpProfileFromControlCenter({ profile, credential, responseStore = DEFAULT_RESPONSE_REFERENCE_STORE, ...options } = {}) {
  const normalized = validateAuthenticatedHttpProfileInput(profile);
  const store = await readStore(options);
  const existing = store.profiles.find((item) => item.id === normalized.id);
  const sameTrust = existing && trustIdentity(existing) === trustIdentity(normalized);
  let nextCredential;
  if (credential !== undefined && credential !== null && credential !== "") nextCredential = validateCredential(credential);
  else if (sameTrust && existing?.credential) nextCredential = existing.credential;
  const record = { ...normalized, ...(nextCredential ? { credential: nextCredential } : {}) };
  const next = await writeStore({ ...store, profiles: replaceOrAppendProfile(store, record) }, options);
  if (existing && !sameTrust) responseStore?.purgeProfile?.(normalized.id);
  return publicProfile(next.profiles.find((item) => item.id === normalized.id));
}

export async function setAuthenticatedHttpProfileCredential({ profileId, credential, ...options } = {}) {
  const id = normalizeProfileId(profileId);
  const secret = validateCredential(credential);
  const store = await readStore(options);
  const existing = store.profiles.find((item) => item.id === id);
  if (!existing) throw new Error(`Unknown authenticated HTTP profile: ${id}`);
  const record = { ...existing, credential: secret };
  const next = await writeStore({ ...store, profiles: replaceOrAppendProfile(store, record) }, options);
  return publicProfile(next.profiles.find((item) => item.id === id));
}

export async function deleteAuthenticatedHttpProfile({ profileId, requireAgentManagement = false, responseStore = DEFAULT_RESPONSE_REFERENCE_STORE, ...options } = {}) {
  const id = normalizeProfileId(profileId);
  const store = await readStore(options);
  if (requireAgentManagement && !store.agentProfileManagementEnabled) {
    throw new Error("Agent HTTP profile management is disabled in Equinox Local Control Center.");
  }
  const profiles = store.profiles.filter((item) => item.id !== id);
  if (profiles.length === store.profiles.length) return Object.freeze({ deleted: false, profileId: id });
  await writeStore({ ...store, profiles }, options);
  responseStore?.purgeProfile?.(id);
  return Object.freeze({ deleted: true, profileId: id });
}

function normalizeQuery(value = {}) {
  const raw = assertPlainObject(value, "HTTP request query");
  const entries = Object.entries(raw);
  if (entries.length > AUTHENTICATED_HTTP_LIMITS.maxQueryEntries) {
    throw new Error(`HTTP request query may contain at most ${AUTHENTICATED_HTTP_LIMITS.maxQueryEntries} entries.`);
  }
  return entries.map(([key, rawValue]) => {
    if (!key || key.length > 128 || CONTROL_PATTERN.test(key)) throw new Error("HTTP request query key is invalid.");
    if (!["string", "number", "boolean"].includes(typeof rawValue) || (typeof rawValue === "number" && !Number.isFinite(rawValue))) {
      throw new Error(`HTTP request query value must be string, number or boolean: ${key}`);
    }
    const text = String(rawValue);
    if (text.length > 4096 || CONTROL_PATTERN.test(text)) throw new Error(`HTTP request query value is invalid or too long: ${key}`);
    return [key, text];
  });
}

function normalizeRequestHeaders(value = {}, profile) {
  const raw = assertPlainObject(value, "HTTP request headers");
  const entries = Object.entries(raw);
  if (entries.length > AUTHENTICATED_HTTP_LIMITS.maxAgentHeaders) {
    throw new Error(`HTTP request may contain at most ${AUTHENTICATED_HTTP_LIMITS.maxAgentHeaders} agent headers.`);
  }
  const allowed = new Set(profile.allowedAgentHeaders);
  const headers = {};
  for (const [rawName, rawValue] of entries) {
    const name = normalizeHeaderName(rawName, "HTTP request header");
    assertHeaderIsAgentSafe(name, "HTTP request header");
    if (!allowed.has(name)) throw new Error(`HTTP request header is not allowed by this profile: ${name}`);
    if (typeof rawValue !== "string" || CONTROL_PATTERN.test(rawValue) || Buffer.byteLength(rawValue, "utf8") > AUTHENTICATED_HTTP_LIMITS.maxHeaderValueBytes) {
      throw new Error(`HTTP request header value is invalid or too large: ${name}`);
    }
    headers[name] = rawValue;
  }
  return headers;
}

function serializeRequestBody(value) {
  if (value === undefined) return { body: undefined, contentType: null };
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > AUTHENTICATED_HTTP_LIMITS.maxRequestBodyBytes) throw new Error("HTTP request body is too large.");
    return { body: value, contentType: "text/plain; charset=utf-8" };
  }
  let body;
  try {
    body = JSON.stringify(value);
  } catch {
    throw new Error("HTTP request body must be JSON-compatible or text.");
  }
  if (body === undefined) throw new Error("HTTP request body must be JSON-compatible or text.");
  if (Buffer.byteLength(body, "utf8") > AUTHENTICATED_HTTP_LIMITS.maxRequestBodyBytes) throw new Error("HTTP request body is too large.");
  return { body, contentType: "application/json; charset=utf-8" };
}

function exactOnlyRedact(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret) text = text.split(secret).join("[REDACTED]");
  }
  return text;
}

function publicRedact(value, secrets = []) {
  return exactOnlyRedact(sanitizeWorkflowOutput(String(value ?? "")), secrets);
}

function redactJsonValueExact(value, secrets, depth = 0) {
  if (depth > 32) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return exactOnlyRedact(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 10_000).map((item) => redactJsonValueExact(item, secrets, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 10_000)) {
      output[exactOnlyRedact(key, secrets)] = redactJsonValueExact(item, secrets, depth + 1);
    }
    return output;
  }
  return value;
}

function redactJsonValuePublic(value, secrets, depth = 0) {
  if (depth > 32) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") return publicRedact(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 10_000).map((item) => redactJsonValuePublic(item, secrets, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 10_000)) {
      output[publicRedact(key, secrets)] = redactJsonValuePublic(item, secrets, depth + 1);
    }
    return output;
  }
  return value;
}

async function readResponseBody(response, { credential, transientRedactions = [] } = {}) {
  const publicSecrets = [credential, ...transientRedactions].filter((value) => typeof value === "string" && value);
  const credentialSecrets = typeof credential === "string" && credential ? [credential] : [];
  if (!response?.body || typeof response.body.getReader !== "function") {
    return Object.freeze({ body: null, referenceBody: null, referenceable: false, truncated: false });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      const remaining = AUTHENTICATED_HTTP_LIMITS.maxResponseBodyBytes - total;
      if (remaining <= 0) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        total += remaining;
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    reader.releaseLock?.();
  }
  if (total === 0) {
    return Object.freeze({ body: null, referenceBody: null, referenceable: false, truncated });
  }
  const text = Buffer.concat(chunks, total).toString("utf8");
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!truncated && /(?:^|\b|\+)json(?:\b|;|$)/iu.test(contentType)) {
    try {
      const parsed = JSON.parse(text);
      return Object.freeze({
        body: redactJsonValuePublic(parsed, publicSecrets),
        referenceBody: redactJsonValueExact(parsed, credentialSecrets),
        referenceable: true,
        truncated: false,
      });
    } catch {
      // Invalid JSON falls through to bounded text and is not referenceable.
    }
  }
  return Object.freeze({
    body: publicRedact(text, publicSecrets),
    referenceBody: null,
    referenceable: false,
    truncated,
  });
}

function safeResponseHeaders(response, secrets = []) {
  const output = {};
  if (!response?.headers || typeof response.headers.entries !== "function") return output;
  for (const [rawName, rawValue] of response.headers.entries()) {
    const name = rawName.toLowerCase();
    if (!SAFE_RESPONSE_HEADERS.has(name)) continue;
    output[name] = publicRedact(rawValue, secrets).slice(0, AUTHENTICATED_HTTP_LIMITS.maxHeaderValueBytes);
  }
  return output;
}

function requestTimeout(inputTimeout, profileTimeout) {
  if (inputTimeout === undefined || inputTimeout === null) return profileTimeout;
  if (!Number.isInteger(inputTimeout) || inputTimeout < 1000 || inputTimeout > profileTimeout) {
    throw new Error(`HTTP request timeout must be 1000-${profileTimeout} ms for this profile.`);
  }
  return inputTimeout;
}

export async function authenticatedHttpRequest({
  profileId,
  method,
  requestPath,
  path: requestPathAlias,
  query = {},
  headers = {},
  body,
  responseBindings,
  response_bindings: responseBindingsAlias,
  timeoutMs,
  timeout_ms: timeoutMsAlias,
  storePath = defaultAuthenticatedHttpStorePath(),
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
  responseStore = DEFAULT_RESPONSE_REFERENCE_STORE,
  captureResponseReference = true,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Authenticated HTTP client is unavailable.");
  const id = normalizeProfileId(profileId);
  const store = await readStore({ storePath, fsImpl });
  const profile = store.profiles.find((item) => item.id === id);
  if (!profile) throw new Error(`Unknown authenticated HTTP profile: ${id}`);
  if (!profile.credential) throw new Error(`Authenticated HTTP profile needs a credential: ${id}`);

  const normalizedMethod = typeof method === "string" ? method.toUpperCase() : "";
  if (!profile.allowedMethods.includes(normalizedMethod)) throw new Error(`HTTP method is not allowed by this profile: ${normalizedMethod || method}`);
  const normalizedPath = normalizeAuthenticatedHttpPath(requestPath ?? requestPathAlias, "HTTP request path");
  if (!profile.allowedPathPrefixes.some((prefix) => pathAllowed(normalizedPath, prefix))) {
    throw new Error(`HTTP request path is not allowed by this profile: ${normalizedPath}`);
  }

  const fullPath = profile.basePath === "/"
    ? normalizedPath
    : normalizedPath === "/" ? profile.basePath : `${profile.basePath}${normalizedPath}`;
  const url = new URL(`${profile.origin}${fullPath}`);
  if (url.origin !== profile.origin) throw new Error("Authenticated HTTP request escaped the configured origin.");
  for (const [key, value] of normalizeQuery(query)) url.searchParams.append(key, value);

  const requestHeaders = normalizeRequestHeaders(headers, profile);
  if (normalizedMethod === "GET" && body !== undefined) throw new Error("GET authenticated HTTP requests cannot include a body.");
  const profileTrustIdentity = trustIdentity(profile);
  const resolvedBody = body === undefined
    ? Object.freeze({ value: undefined, redactions: Object.freeze([]), refsResolved: 0 })
    : resolveAuthenticatedHttpResponseReferences(body, {
      profileId: id,
      trustIdentity: profileTrustIdentity,
      responseStore,
    });
  const boundBody = applyAuthenticatedHttpResponseBindings(
    resolvedBody.value,
    responseBindings ?? responseBindingsAlias ?? [],
    {
      profileId: id,
      trustIdentity: profileTrustIdentity,
      responseStore,
    },
  );
  const requestRedactions = Object.freeze([
    ...new Set([...resolvedBody.redactions, ...boundBody.redactions]),
  ]);
  const serialized = serializeRequestBody(boundBody.value);
  if (serialized.contentType) requestHeaders["content-type"] = serialized.contentType;
  if (profile.auth.type === "bearer") requestHeaders.authorization = `Bearer ${profile.credential}`;
  else requestHeaders[profile.auth.headerName] = profile.credential;

  const effectiveTimeout = requestTimeout(timeoutMs ?? timeoutMsAlias, profile.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);
  timer.unref?.();
  const startedAt = Date.now();
  let response;
  try {
    response = await fetchImpl(url, {
      method: normalizedMethod,
      headers: requestHeaders,
      body: serialized.body,
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Authenticated HTTP request timed out after ${effectiveTimeout} ms.`);
    throw new Error("Authenticated HTTP request failed before a response was received.");
  } finally {
    clearTimeout(timer);
  }

  const responsePayload = await readResponseBody(response, {
    credential: profile.credential,
    transientRedactions: requestRedactions,
  });
  let responseId;
  if (captureResponseReference && responsePayload.referenceable) {
    responseId = responseStore.capture({
      profileId: id,
      trustIdentity: profileTrustIdentity,
      body: responsePayload.referenceBody,
    });
  }
  const responseSecrets = [profile.credential, ...requestRedactions];
  return Object.freeze({
    ok: Boolean(response.ok),
    status: Number.isInteger(response.status) ? response.status : 0,
    headers: Object.freeze(safeResponseHeaders(response, responseSecrets)),
    body: responsePayload.body,
    truncated: responsePayload.truncated,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(responseId ? { responseId } : {}),
  });
}
