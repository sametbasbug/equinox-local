import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.basename(MODULE_DIR) === "src" ? path.dirname(MODULE_DIR) : MODULE_DIR;

export const PEEKABOO_ALLOWED_TOOLS = Object.freeze([
  "permissions",
  "inspect_ui",
  "see",
  "capture",
  "clipboard",
  "app",
  "window",
  "menu",
  "dock",
  "click",
  "drag",
  "move",
  "press",
  "scroll",
  "type",
  "paste",
  "dialog",
  "action",
  "set_value",
  "verify_state",
  "space",
  "sleep",
]);

const PEEKABOO_ALLOWED_TOOL_SET = new Set(PEEKABOO_ALLOWED_TOOLS);
const PEEKABOO_READ_ONLY_TOOL_SET = new Set([
  "permissions",
  "inspect_ui",
  "see",
  "verify_state",
]);
const PEEKABOO_TOOL_CACHE_MS = 60_000;
const MAX_ARGUMENT_BYTES = 100_000;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_INPUT = 20_000;
const SAFE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const PEEKABOO_MCP_ARGS = Object.freeze([
  "mcp",
  "--no-remote",
  "--allow-foreground",
  "--log-level",
  "warning",
  "--input-strategy",
  "actionFirst",
]);
const MIN_PEEKABOO_VERSION = Object.freeze({ major: 4, minor: 5, patch: 0 });
const MAX_SUPPORTED_PEEKABOO_MAJOR = 4;

const PEEKABOO_V4_REQUIRED_TOOLS = Object.freeze([...PEEKABOO_ALLOWED_TOOLS]);

const REQUIRED_TOOL_SHAPES = Object.freeze({
  permissions: Object.freeze({ properties: [] }),
  inspect_ui: Object.freeze({ properties: ["app_target", "snapshot", "max_elements"] }),
  see: Object.freeze({ properties: ["app_target", "snapshot", "max_elements", "path"] }),
  capture: Object.freeze({ properties: ["mode", "source", "capture_focus"] }),
  clipboard: Object.freeze({ properties: ["action", "text", "file_path"], actionValues: ["get", "set", "clear", "save", "restore"] }),
  app: Object.freeze({ properties: ["action", "name", "foreground"], actionValues: ["launch", "open", "quit", "relaunch", "focus", "hide", "unhide", "switch", "list"] }),
  window: Object.freeze({ properties: ["action", "window_id", "foreground"], actionValues: ["list", "close", "minimize", "restore", "maximize", "move", "resize", "set-bounds", "focus"] }),
  menu: Object.freeze({ properties: ["action", "app", "path", "foreground"], actionValues: ["list", "click"] }),
  dock: Object.freeze({ properties: ["action"] }),
  click: Object.freeze({ properties: ["on", "query", "coords", "foreground", "snapshot"] }),
  drag: Object.freeze({ properties: ["from", "to", "from_coords", "to_coords", "foreground"] }),
  move: Object.freeze({ properties: ["id", "to", "coordinates", "foreground"] }),
  press: Object.freeze({ properties: ["keys", "key", "snapshot", "foreground", "app", "window_id"] }),
  scroll: Object.freeze({ properties: ["direction", "on", "snapshot", "foreground"] }),
  type: Object.freeze({ properties: ["text", "on", "snapshot", "foreground", "app", "window_id"] }),
  paste: Object.freeze({ properties: ["text", "app", "pid"] }),
  dialog: Object.freeze({ properties: ["action", "app", "foreground"], actionValues: ["list", "click", "input", "file", "dismiss"] }),
  action: Object.freeze({ properties: ["on", "action", "snapshot"] }),
  set_value: Object.freeze({ properties: ["on", "value", "snapshot"] }),
  verify_state: Object.freeze({ properties: ["predicates", "app", "pid", "window_id"] }),
  space: Object.freeze({ properties: ["action", "foreground"], actionValues: ["list", "switch", "move-window"] }),
  sleep: Object.freeze({ properties: ["duration"] }),
});

function assertPlainObject(value, label = "Peekaboo arguments") {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} bir JSON nesnesi olmalı.`);
  }
}

function assertStringLimit(value, name, max = 500) {
  if (value === undefined || value === null) {
    return;
  }

  if (typeof value !== "string" || value.length > max) {
    throw new Error(`${name} en fazla ${max} karakterlik metin olmalı.`);
  }

  if (/\u0000/u.test(value)) {
    throw new Error(`${name} NUL karakteri içeremez.`);
  }
}

function assertOptionalNumber(value, name, { min, max, integer = false }) {
  if (value === undefined || value === null) {
    return;
  }

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    value < min ||
    value > max
  ) {
    const kind = integer ? "tam sayı" : "sayı";
    throw new Error(`${name} ${min}-${max} arasında bir ${kind} olmalı.`);
  }
}

function parsePeekabooVersion(value) {
  const match = /(?:Peekaboo\s+)?(\d+)\.(\d+)\.(\d+)/u.exec(String(value ?? ""));
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersion(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] < right[key] ? -1 : 1;
    }
  }
  return 0;
}

function compatibilityContract() {
  return { name: "v4.5", requiredTools: PEEKABOO_V4_REQUIRED_TOOLS };
}

export function inspectPeekabooCompatibility(tools, versionText = "") {
  const errors = [];
  const warnings = [];
  const installedVersion = parsePeekabooVersion(versionText);
  const byName = new Map((tools ?? []).map((tool) => [tool?.name, tool]));
  const contract = compatibilityContract(installedVersion, byName);

  if (!installedVersion) {
    warnings.push("Peekaboo version could not be parsed; tool-schema validation will be used.");
  } else {
    if (compareVersion(installedVersion, MIN_PEEKABOO_VERSION) < 0) {
      errors.push(
        `Peekaboo ${MIN_PEEKABOO_VERSION.major}.${MIN_PEEKABOO_VERSION.minor}.${MIN_PEEKABOO_VERSION.patch} or newer is required.`,
      );
    }
    if (installedVersion.major > MAX_SUPPORTED_PEEKABOO_MAJOR) {
      errors.push(
        `Peekaboo major version ${installedVersion.major} is not supported yet; the newest validated major is ${MAX_SUPPORTED_PEEKABOO_MAJOR}.`,
      );
    }
  }

  const missingTools = contract.requiredTools.filter((name) => !byName.has(name));
  if (missingTools.length > 0) {
    errors.push(`Missing safe Peekaboo ${contract.name} tools: ${missingTools.join(", ")}`);
  }

  for (const toolName of contract.requiredTools) {
    const shape = REQUIRED_TOOL_SHAPES[toolName];
    const tool = byName.get(toolName);
    if (!tool) {
      continue;
    }

    const properties = tool.inputSchema?.properties ?? {};
    for (const property of shape.properties) {
      if (!(property in properties)) {
        errors.push(`${toolName} schema is missing the expected '${property}' field.`);
      }
    }

    if (shape.actionValues) {
      const actionValues = new Set(properties.action?.enum ?? []);
      for (const action of shape.actionValues) {
        if (!actionValues.has(action)) {
          errors.push(`${toolName}.action schema is missing the expected '${action}' action.`);
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    version: installedVersion,
    minimumVersion: { ...MIN_PEEKABOO_VERSION },
    contract: contract.name,
    missingTools,
    errors,
    warnings,
  };
}

export function parsePeekabooPermissions(text) {
  const value = String(text ?? "");
  const readPermission = (label) => {
    const match = new RegExp(`${label}(?:\\s*\\([^\\r\\n)]*\\))?:\\s*\\[(?:ok|warn|err)\\]\\s*(Granted|Not Granted)`, "iu").exec(value);
    if (!match) {
      return null;
    }
    return match[1].toLowerCase() === "granted";
  };

  return {
    screenRecording: readPermission("Screen Recording"),
    accessibility: readPermission("Accessibility"),
  };
}

export function isPeekabooStatusReady(status) {
  const permissionState = status?.permissionState ?? parsePeekabooPermissions(status?.permissions);
  return Boolean(
    status?.active
      && status?.compatibility?.ok === true
      && permissionState?.screenRecording === true
      && permissionState?.accessibility === true,
  );
}

export function isPeekabooControlCenterReady(status) {
  const permissionState = status?.permissionState ?? parsePeekabooPermissions(status?.permissions);
  const permissionsKnown = permissionState?.screenRecording != null
    && permissionState?.accessibility != null;
  return Boolean(
    status?.active
      && status?.compatibility?.ok === true
      && (!permissionsKnown || isPeekabooStatusReady(status)),
  );
}

function requiredPermissionsForTool(toolName) {
  if (toolName === "see") {
    return ["screenRecording", "accessibility"];
  }
  if (toolName === "capture") {
    return ["screenRecording"];
  }

  if (
    [
      "inspect_ui",
      "window",
      "menu",
      "dock",
      "click",
      "drag",
      "move",
      "press",
      "scroll",
      "type",
      "paste",
      "dialog",
      "action",
      "set_value",
      "verify_state",
      "space",
    ].includes(toolName)
  ) {
    return ["accessibility"];
  }

  return [];
}

function assertPermissionState(toolName, permissions) {
  for (const permission of requiredPermissionsForTool(toolName)) {
    if (permissions?.[permission] === false) {
      const label = permission === "screenRecording" ? "Screen Recording" : "Accessibility";
      throw new Error(
        `Equinox Local ${toolName} için ${label} izni gerekli. System Settings > Privacy & Security bölümünde Equinox Local için izni etkinleştir.`,
      );
    }
  }
}

function isPeekabooTransportError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /(?:connection\s+closed|transport|not\s+connected|broken\s+pipe|\bEPIPE\b|\bECONNRESET\b|\bEOF\b|MCP\s+error\s+-32000)/iu.test(message);
}

function isPeekabooAmbiguousOutcomeResult(result) {
  if (!result?.isError) return false;
  const text = extractTextContent(result);
  return /did not return (?:an? )?(?:confirmed|accepted) outcome[\s\S]*canonical escalation metadata/iu.test(text);
}

function normalizePeekabooAmbiguousOutcomeResult(result) {
  const text = extractTextContent(result);
  return {
    ...result,
    isError: false,
    content: [{
      type: "text",
      text: `[ambiguous] ${text}\nDo not retry blindly; observe the exact target before deciding whether another mutation is needed.`,
    }],
  };
}

function guardPeekabooResult(result) {
  let encoded;
  try {
    encoded = JSON.stringify(result ?? null);
  } catch {
    throw new Error("Peekaboo sonucu güvenli biçimde serileştirilemedi.");
  }

  if (Buffer.byteLength(encoded, "utf8") > MAX_RESULT_BYTES) {
    throw new Error("Peekaboo sonucu 2 MB güvenli çıktı sınırını aşıyor; daha dar bir UI hedefi kullan.");
  }

  return result;
}

function validateTraversalLimits(args) {
  assertOptionalNumber(args.max_depth, "max_depth", {
    min: 1,
    max: 50,
    integer: true,
  });
  assertOptionalNumber(args.max_elements, "max_elements", {
    min: 1,
    max: 5_000,
    integer: true,
  });
  assertOptionalNumber(args.max_children, "max_children", {
    min: 1,
    max: 2_000,
    integer: true,
  });
}

export function normalizePeekabooArguments(toolName, rawArguments = {}) {
  if (!PEEKABOO_ALLOWED_TOOL_SET.has(toolName)) {
    throw new Error(`Peekaboo aracı Equinox Local allowlist'inde değil: ${toolName}`);
  }

  assertPlainObject(rawArguments);
  const encoded = JSON.stringify(rawArguments);
  if (Buffer.byteLength(encoded, "utf8") > MAX_ARGUMENT_BYTES) {
    throw new Error("Peekaboo araç girdisi 100 KB sınırını aşıyor.");
  }

  const args = { ...rawArguments };
  if (toolName === "see" || toolName === "inspect_ui") {
    validateTraversalLimits(args);
  }
  if (toolName === "type" || toolName === "paste" || toolName === "dialog") {
    assertStringLimit(args.text, "text", MAX_TEXT_INPUT);
  }
  if (toolName === "set_value" && typeof args.value === "string" && args.value.length > MAX_TEXT_INPUT) {
    throw new Error(`set_value metni ${MAX_TEXT_INPUT} karakter sınırını aşıyor.`);
  }
  if (toolName === "sleep") {
    assertOptionalNumber(args.duration, "duration", { min: 0, max: 30_000, integer: true });
  }
  return args;
}

export function buildSafePeekabooEnvironment(baseEnvironment = process.env) {
  const safe = {};
  const allowedKeys = [
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "SHELL",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
  ];

  for (const key of allowedKeys) {
    const value = baseEnvironment[key];
    if (typeof value === "string" && value.length <= 10_000) {
      safe[key] = value;
    }
  }

  return {
    ...safe,
    PATH: SAFE_PATH,
    NO_COLOR: "1",
    CLICOLOR: "0",
    PEEKABOO_ALLOW_TOOLS: PEEKABOO_ALLOWED_TOOLS.join(","),
  };
}

export async function resolvePeekabooBinary(baseEnvironment = process.env) {
  const configured = typeof baseEnvironment.EQUINOX_PEEKABOO_PATH === "string"
    ? baseEnvironment.EQUINOX_PEEKABOO_PATH
    : "";
  const candidates = [
    configured && path.isAbsolute(configured) ? configured : null,
    path.join(RUNTIME_ROOT, "runtime", "peekaboo", "peekaboo"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // Pinned desktop runtime is optional; core Equinox Local remains available.
    }
  }

  throw new Error(
    "Equinox Local pinned Peekaboo runtime is unavailable. Repair or reinstall Equinox Local instead of installing a system Peekaboo package.",
  );
}

function extractTextContent(result) {
  if (!result || !Array.isArray(result.content)) {
    return "";
  }

  return result.content
    .filter(
      (item) =>
        item &&
        item.type === "text" &&
        typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

export function createPeekabooBridge({
  serverVersion,
  listRoots,
  baseEnvironment = process.env,
  now = () => Date.now(),
  onEvent = null,
}) {
  let state = null;
  let starting = null;
  let toolCache = null;
  let permissionCache = null;
  let reconnectCount = 0;
  let lastReconnectAt = null;
  let unexpectedCloseCount = 0;
  let lastUnexpectedCloseAt = null;
  let lastTransportError = null;
  let lastTransportErrorAt = null;
  let lastPermissionState = null;
  let lastCompatibilityEventFingerprint = null;

  const emitEvent = (event) => {
    if (typeof onEvent !== "function") {
      return;
    }
    void Promise.resolve(onEvent(event)).catch(() => {});
  };

  const clearCaches = () => {
    toolCache = null;
    permissionCache = null;
  };

  const close = async () => {
    const active = state;
    const pending = starting;

    state = null;
    starting = null;
    clearCaches();

    if (active) {
      active.intentionalClose = true;
      await active.client.close().catch(() => {});
      return;
    }

    if (pending) {
      const started = await pending.catch(() => null);
      if (started) {
        if (state === started) {
          state = null;
        }
        started.intentionalClose = true;
        await started.client.close().catch(() => {});
      }
    }
  };

  const start = async () => {
    const binary = await resolvePeekabooBinary(baseEnvironment);
    const client = new Client(
      {
        name: "equinox-local-peekaboo-bridge",
        version: serverVersion,
      },
      {
        capabilities:
          typeof listRoots === "function"
            ? { roots: { listChanged: false } }
            : {},
      },
    );

    if (typeof listRoots === "function") {
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: await listRoots(),
      }));
    }

    const transport = new StdioClientTransport({
      command: binary,
      args: [...PEEKABOO_MCP_ARGS],
      env: buildSafePeekabooEnvironment(baseEnvironment),
      stderr: "inherit",
    });

    const nextState = {
      client,
      transport,
      binary,
      startedAt: now(),
      intentionalClose: false,
    };

    client.onerror = (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (isPeekabooTransportError(error)) {
        lastTransportError = message;
        lastTransportErrorAt = now();
      }
      emitEvent({
        component: "peekaboo",
        type: "peekaboo.error",
        severity: isPeekabooTransportError(error) ? "warn" : "error",
        status: "degraded",
        message,
        details: {
          transportError: isPeekabooTransportError(error),
        },
      });
      console.error(`[Equinox Local] Peekaboo MCP: ${message}`);
    };

    client.onclose = () => {
      if (!nextState.intentionalClose) {
        unexpectedCloseCount += 1;
        lastUnexpectedCloseAt = now();
        emitEvent({
          component: "peekaboo",
          type: "peekaboo.unexpected_close",
          severity: "warn",
          status: "degraded",
          message: "Peekaboo MCP child process closed unexpectedly.",
          details: {
            unexpectedCloseCount,
          },
        });
      }
      if (state === nextState) {
        state = null;
        clearCaches();
      }
    };

    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }

    state = nextState;
    emitEvent({
      component: "peekaboo",
      type: "peekaboo.started",
      severity: "info",
      status: "healthy",
      message: "Peekaboo MCP bridge connected.",
      details: {
        binary,
        startedAt: nextState.startedAt,
      },
    });
    return nextState;
  };

  const getBridge = async () => {
    if (state) {
      return state;
    }

    if (!starting) {
      starting = start().finally(() => {
        starting = null;
      });
    }

    return starting;
  };

  const readVersion = async (binary) => {
    const versionResult = await execFile(binary, ["--version"], {
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      env: buildSafePeekabooEnvironment(baseEnvironment),
    });
    return String(versionResult.stdout || versionResult.stderr).trim();
  };

  const recoverBridge = async (error) => {
    lastTransportError = error instanceof Error ? error.message : String(error);
    lastTransportErrorAt = now();
    await close();
    await getBridge();
    reconnectCount += 1;
    lastReconnectAt = now();
    emitEvent({
      component: "peekaboo",
      type: "peekaboo.reconnected",
      severity: "info",
      status: "recovered",
      message: "Peekaboo MCP transport connection recovered.",
      details: {
        reconnectCount,
        previousError: lastTransportError,
      },
    });
  };

  const collectTools = async () => {
    const { client } = await getBridge();
    const tools = [];
    let cursor;

    do {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);

    return tools;
  };

  const listTools = async (refresh = false) => {
    const timestamp = now();

    if (
      !refresh &&
      toolCache &&
      timestamp - toolCache.fetchedAt < PEEKABOO_TOOL_CACHE_MS
    ) {
      return toolCache.tools;
    }

    let tools;
    try {
      tools = await collectTools();
    } catch (error) {
      if (!isPeekabooTransportError(error)) {
        throw error;
      }
      await recoverBridge(error);
      tools = await collectTools();
    }

    const filtered = tools.filter((tool) => PEEKABOO_ALLOWED_TOOL_SET.has(tool.name));
    const bridge = await getBridge();
    const versionText = await readVersion(bridge.binary);
    const compatibility = inspectPeekabooCompatibility(filtered, versionText);

    if (!compatibility.ok) {
      lastCompatibilityEventFingerprint = null;
      emitEvent({
        component: "peekaboo",
        type: "peekaboo.compatibility_failure",
        severity: "critical",
        status: "attention_required",
        message: `Peekaboo compatibility check failed: ${compatibility.errors.join(" | ")}`,
        details: {
          errors: compatibility.errors,
          warnings: compatibility.warnings,
          version: versionText,
        },
      });
      throw new Error(
        `Peekaboo compatibility check failed: ${compatibility.errors.join(" | ")}`,
      );
    }

    const compatibilityEventFingerprint = JSON.stringify({
      version: versionText,
      tools: filtered.map((tool) => tool.name).sort(),
      warnings: compatibility.warnings,
    });
    if (compatibilityEventFingerprint !== lastCompatibilityEventFingerprint) {
      lastCompatibilityEventFingerprint = compatibilityEventFingerprint;
      emitEvent({
        component: "peekaboo",
        type: "peekaboo.compatibility_ok",
        severity: "info",
        status: "healthy",
        message: "Peekaboo safe tool-surface compatibility check passed.",
        details: {
          version: versionText,
          toolCount: filtered.length,
          warnings: compatibility.warnings,
        },
      });
    }

    toolCache = {
      fetchedAt: timestamp,
      tools: filtered,
      compatibility,
      versionText,
    };

    return filtered;
  };

  const rawCallTool = async (toolName, args) => {
    const { client } = await getBridge();
    return guardPeekabooResult(
      await client.callTool({
        name: toolName,
        arguments: args,
      }),
    );
  };

  const readPermissions = async (refresh = false) => {
    const timestamp = now();
    if (!refresh && permissionCache) {
      return permissionCache;
    }

    await listTools();
    let result;
    try {
      result = await rawCallTool("permissions", {});
    } catch (error) {
      if (!isPeekabooTransportError(error)) {
        throw error;
      }
      await recoverBridge(error);
      await listTools(true);
      result = await rawCallTool("permissions", {});
    }

    const text = extractTextContent(result);
    const parsed = parsePeekabooPermissions(text);
    if (result?.isError && parsed.screenRecording === null && parsed.accessibility === null) {
      throw new Error(text || "Peekaboo izin durumu okunamadı.");
    }

    const permissionSignature = `${parsed.screenRecording}:${parsed.accessibility}`;
    if (permissionSignature !== lastPermissionState) {
      const lost = parsed.screenRecording === false || parsed.accessibility === false;
      const fullyGranted = parsed.screenRecording === true && parsed.accessibility === true;
      if (lost || fullyGranted) {
        emitEvent({
          component: "peekaboo",
          type: lost ? "peekaboo.permission_loss" : "peekaboo.permissions_ok",
          severity: lost ? "warn" : "info",
          status: lost ? "degraded" : "recovered",
          message: lost
            ? "At least one required Equinox Local macOS permission is unavailable."
            : "Equinox Local Screen Recording and Accessibility permissions are ready.",
          details: {
            screenRecording: parsed.screenRecording,
            accessibility: parsed.accessibility,
          },
        });
      }
      lastPermissionState = permissionSignature;
    }

    permissionCache = {
      fetchedAt: timestamp,
      text,
      ...parsed,
    };
    return permissionCache;
  };

  const ensurePermissions = async (toolName) => {
    const required = requiredPermissionsForTool(toolName);
    if (required.length === 0) {
      return;
    }
    const permissions = await readPermissions();
    assertPermissionState(toolName, permissions);
  };

  const executeToolOnce = async (toolName, args) => {
    const result = await rawCallTool(toolName, args);
    if (result?.isError) {
      if (isPeekabooAmbiguousOutcomeResult(result)) {
        return normalizePeekabooAmbiguousOutcomeResult(result);
      }
      throw new Error(
        extractTextContent(result) || `${toolName} çağrısı başarısız oldu.`,
      );
    }
    return result;
  };

  const callTool = async (toolName, rawArguments = {}) => {
    const args = normalizePeekabooArguments(toolName, rawArguments);
    const tools = await listTools();
    const tool = tools.find((candidate) => candidate.name === toolName);

    if (!tool) {
      throw new Error(`Peekaboo MCP aracı bulunamadı: ${toolName}`);
    }

    if (toolName !== "permissions") {
      await ensurePermissions(toolName);
    }

    try {
      return await executeToolOnce(toolName, args);
    } catch (error) {
      if (!isPeekabooTransportError(error)) {
        throw error;
      }

      await recoverBridge(error);
      await listTools(true);

      if (!PEEKABOO_READ_ONLY_TOOL_SET.has(toolName)) {
        throw new Error(
          `Peekaboo MCP bağlantısı ${toolName} sırasında koptu. Köprü yeniden bağlandı ancak eylemin sonucu belirsiz olabileceği için otomatik tekrar yapılmadı.`,
        );
      }

      if (toolName !== "permissions") {
        await ensurePermissions(toolName);
      }
      return executeToolOnce(toolName, args);
    }
  };

  const status = async ({ probePermissions = true } = {}) => {
    const binary = await resolvePeekabooBinary(baseEnvironment);
    const versionText = await readVersion(binary);
    const statusErrors = [];
    let compatibility = null;
    let permissions = null;
    let permissionState = null;
    let serverStatus = null;
    let availableTools = [];

    try {
      availableTools = await listTools(true);
      compatibility = toolCache?.compatibility ?? null;
    } catch (statusError) {
      statusErrors.push(
        `compatibility:${statusError instanceof Error ? statusError.message : String(statusError)}`,
      );
    }

    if (probePermissions) {
      try {
        const currentPermissions = await readPermissions(true);
        permissions = currentPermissions.text;
        permissionState = {
          screenRecording: currentPermissions.screenRecording,
          accessibility: currentPermissions.accessibility,
        };
      } catch (statusError) {
        permissions = statusError instanceof Error ? statusError.message : String(statusError);
        statusErrors.push("permissions");
      }
    } else if (permissionCache) {
      permissions = permissionCache.text;
      permissionState = {
        screenRecording: permissionCache.screenRecording,
        accessibility: permissionCache.accessibility,
      };
    }

    if (availableTools.some((tool) => tool.name === "list")) {
      try {
        serverStatus = extractTextContent(
          await callTool("list", { item_type: "server_status" }),
        );
      } catch (statusError) {
        serverStatus = statusError instanceof Error ? statusError.message : String(statusError);
        statusErrors.push("server_status");
      }
    } else if (compatibility?.ok) {
      serverStatus = "Peekaboo 4 MCP: legacy list/server_status kaldırıldı; araç kataloğu ve izin preflight'ı sağlıklı.";
    }

    const activeToolNames = availableTools.map((tool) => tool.name);

    return {
      binary,
      version: versionText,
      active: Boolean(state),
      startedAt: state?.startedAt ?? null,
      allowedToolCount: activeToolNames.length,
      allowedTools: activeToolNames,
      compatibility,
      permissions,
      permissionState,
      serverStatus,
      reconnectCount,
      lastReconnectAt,
      unexpectedCloseCount,
      lastUnexpectedCloseAt,
      lastTransportError,
      lastTransportErrorAt,
      error: statusErrors.length > 0 ? statusErrors.join(",") : null,
    };
  };

  return Object.freeze({
    get active() {
      return Boolean(state);
    },
    get startedAt() {
      return state?.startedAt ?? null;
    },
    get reconnectCount() {
      return reconnectCount;
    },
    listTools,
    callTool,
    status,
    close,
    restart: async () => {
      await close();
      await getBridge();
      await listTools(true);
      return state;
    },
  });
}

export const __test = Object.freeze({
  PEEKABOO_TOOL_CACHE_MS,
  PEEKABOO_MCP_ARGS,
  MAX_ARGUMENT_BYTES,
  MAX_RESULT_BYTES,
  MAX_TEXT_INPUT,
  MIN_PEEKABOO_VERSION,
  MAX_SUPPORTED_PEEKABOO_MAJOR,
  PEEKABOO_V4_REQUIRED_TOOLS,
  REQUIRED_TOOL_SHAPES,
  requiredPermissionsForTool,
  assertPermissionState,
  isPeekabooTransportError,
  guardPeekabooResult,
  isPeekabooAmbiguousOutcomeResult,
  normalizePeekabooAmbiguousOutcomeResult,
});
