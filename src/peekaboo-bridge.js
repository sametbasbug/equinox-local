import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const ROOT = path.dirname(fileURLToPath(import.meta.url));

export const PEEKABOO_ALLOWED_TOOLS = Object.freeze([
  "permissions",
  "list",
  "inspect_ui",
  "see",
  "app",
  "window",
  "menu",
  "dock",
  "click",
  "drag",
  "move",
  "hotkey",
  "press",
  "scroll",
  "type",
  "perform_action",
  "action",
  "set_value",
  "space",
  "sleep",
]);

const PEEKABOO_ALLOWED_TOOL_SET = new Set(PEEKABOO_ALLOWED_TOOLS);
const PEEKABOO_READ_ONLY_TOOL_SET = new Set([
  "permissions",
  "list",
  "inspect_ui",
  "see",
]);
const PEEKABOO_TOOL_CACHE_MS = 60_000;
const PEEKABOO_PERMISSION_CACHE_MS = 5_000;
const MAX_ARGUMENT_BYTES = 100_000;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_INPUT = 20_000;
const SAFE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const MIN_PEEKABOO_VERSION = Object.freeze({ major: 3, minor: 9, patch: 9 });
const MAX_SUPPORTED_PEEKABOO_MAJOR = 4;

const PEEKABOO_V3_REQUIRED_TOOLS = Object.freeze([
  "permissions", "list", "inspect_ui", "see", "app", "window", "menu", "dock",
  "click", "drag", "move", "hotkey", "scroll", "type", "perform_action",
  "set_value", "space", "sleep",
]);

const PEEKABOO_V4_REQUIRED_TOOLS = Object.freeze([
  "permissions", "inspect_ui", "see", "app", "window", "menu", "dock",
  "click", "press", "scroll", "type", "action",
  "set_value", "space", "sleep",
]);

const PROTECTED_APPLICATION_NAMES = new Set([
  "loginwindow",
  "systemuiserver",
  "windowmanager",
  "dock",
  "accessibility",
  "control centre",
  "control center",
  "com.apple.loginwindow",
  "com.apple.systemuiserver",
  "com.apple.windowmanager",
  "com.apple.dock",
]);

const DANGEROUS_MENU_PATTERN =
  /(?:empty\s+(?:bin|trash)|move\s+to\s+(?:bin|trash)|delete\s+immediately|force\s+quit|shut\s+down|restart|log\s+out|lock\s+screen|erase|format)/iu;

const REQUIRED_TOOL_SHAPES = Object.freeze({
  permissions: Object.freeze({ properties: [] }),
  list: Object.freeze({ properties: ["item_type"] }),
  inspect_ui: Object.freeze({ properties: ["app_target", "snapshot", "max_elements"] }),
  see: Object.freeze({ properties: ["app_target", "snapshot", "max_elements"] }),
  app: Object.freeze({ properties: ["action", "name"], actionValues: ["launch", "quit", "list"] }),
  window: Object.freeze({ properties: ["action", "window_id"], actionValues: ["close", "list"] }),
  menu: Object.freeze({ properties: ["action", "app", "path"], actionValues: ["list", "click"] }),
  dock: Object.freeze({ properties: ["action"], actionValues: ["list"] }),
  click: Object.freeze({ properties: ["on", "query", "snapshot"] }),
  drag: Object.freeze({ properties: ["from", "to", "snapshot"] }),
  move: Object.freeze({ properties: ["id", "snapshot"] }),
  hotkey: Object.freeze({ properties: ["keys", "app", "window_id"] }),
  press: Object.freeze({ properties: ["keys", "key", "snapshot"] }),
  scroll: Object.freeze({ properties: ["direction", "on", "snapshot"] }),
  type: Object.freeze({ properties: ["text", "on", "snapshot"] }),
  perform_action: Object.freeze({ properties: ["on", "action", "snapshot"] }),
  action: Object.freeze({ properties: ["on", "action", "snapshot"] }),
  set_value: Object.freeze({ properties: ["on", "value", "snapshot"] }),
  space: Object.freeze({ properties: ["action"] }),
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

function compatibilityContract(installedVersion, byName) {
  if (installedVersion?.major === 4) {
    return { name: "v4", requiredTools: PEEKABOO_V4_REQUIRED_TOOLS };
  }
  if (installedVersion?.major === 3) {
    return { name: "v3", requiredTools: PEEKABOO_V3_REQUIRED_TOOLS };
  }
  if (!installedVersion && byName.has("press") && byName.has("action")) {
    return { name: "v4", requiredTools: PEEKABOO_V4_REQUIRED_TOOLS };
  }
  return { name: "v3", requiredTools: PEEKABOO_V3_REQUIRED_TOOLS };
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

  if (
    [
      "inspect_ui",
      "window",
      "menu",
      "dock",
      "click",
      "drag",
      "move",
      "hotkey",
      "press",
      "scroll",
      "type",
      "perform_action",
      "action",
      "set_value",
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

function normalizeApplicationName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isProtectedApplication(value) {
  return PROTECTED_APPLICATION_NAMES.has(normalizeApplicationName(value));
}

function normalizeHotkeyChord(value) {
  return String(value ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePressChord(value) {
  return String(value ?? "")
    .split(/[+,]/u)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function isDangerousKeyboardChord(parts) {
  const chord = new Set(parts);
  return (
    (chord.has("cmd") && chord.has("delete")) ||
    (chord.has("cmd") && chord.has("option") && chord.has("escape")) ||
    (chord.has("cmd") && chord.has("alt") && chord.has("escape")) ||
    (chord.has("ctrl") && chord.has("cmd") && chord.has("q")) ||
    (chord.has("control") && chord.has("cmd") && chord.has("q"))
  );
}

function hasExplicitSnapshot(args) {
  return typeof args.snapshot === "string" && args.snapshot.trim().length > 0 && args.snapshot !== "latest";
}

function hasDesktopTarget(args) {
  return Boolean(
    args.on ||
      args.app ||
      args.pid !== undefined ||
      args.window_id !== undefined ||
      args.window_title ||
      args.window_index !== undefined,
  );
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
    assertStringLimit(args.app_target, "app_target", 300);
    assertStringLimit(args.snapshot, "snapshot", 200);

    if (toolName === "see" && args.path !== undefined) {
      throw new Error(
        "see.path Equinox Local üzerinden kapalıdır; Peekaboo geçici çıktısını kullan.",
      );
    }
  }

  if (toolName === "app") {
    assertStringLimit(args.name, "name", 300);
    assertStringLimit(args.to, "to", 300);
    assertStringLimit(args.bundleId, "bundleId", 300);

    if (args.all === true) {
      throw new Error("Tüm uygulamaları topluca kapatma Equinox Local üzerinden yasak.");
    }

    if (args.force === true) {
      throw new Error("Force quit Equinox Local Peekaboo köprüsünde kapalıdır.");
    }

    if (
      ["quit", "relaunch", "hide", "unhide"].includes(args.action) &&
      isProtectedApplication(args.name)
    ) {
      throw new Error(`Korunan macOS uygulaması üzerinde '${args.action}' eylemi kapalıdır.`);
    }
  }

  if (toolName === "window") {
    assertStringLimit(args.app, "app", 300);
    assertStringLimit(args.title, "title", 500);
    assertOptionalNumber(args.width, "width", { min: 100, max: 16_384 });
    assertOptionalNumber(args.height, "height", { min: 100, max: 16_384 });
    assertOptionalNumber(args.x, "x", { min: -16_384, max: 32_768 });
    assertOptionalNumber(args.y, "y", { min: -16_384, max: 32_768 });

    if (args.action !== "focus" && isProtectedApplication(args.app)) {
      throw new Error(`Korunan macOS uygulaması penceresinde '${args.action}' eylemi kapalıdır.`);
    }
  }

  if (toolName === "menu") {
    assertStringLimit(args.app, "app", 300);
    assertStringLimit(args.item, "item", 500);
    assertStringLimit(args.path, "path", 1_000);

    if (args.action === "list-all" || args.action === "click-extra") {
      throw new Error(
        "Tüm uygulama menülerini tarama ve sistem menü-extra tıklama Equinox Local üzerinden kapalıdır.",
      );
    }

    if (
      args.action === "click" &&
      DANGEROUS_MENU_PATTERN.test(`${args.path ?? ""} ${args.item ?? ""}`)
    ) {
      throw new Error("Silme, sistem oturumu veya güç yönetimi menü eylemleri masaüstü köprüsünde kapalıdır.");
    }
  }

  if (toolName === "dock") {
    assertStringLimit(args.app, "app", 300);
    assertStringLimit(args.select, "select", 500);

    if (args.action === "right-click") {
      throw new Error("Dock context-menu eylemleri ilk v3.9 güvenli yüzeyinde kapalıdır.");
    }
  }

  if (toolName === "click") {
    assertStringLimit(args.on, "on", 500);
    assertStringLimit(args.query, "query", 1_000);
    assertStringLimit(args.snapshot, "snapshot", 200);

    if (args.coords !== undefined) {
      throw new Error(
        "Koordinat tabanlı click kapalıdır; see/inspect_ui element ID veya query kullan.",
      );
    }

    if (args.foreground === true || args.background === false || args.modifiers !== undefined) {
      throw new Error(
        "Foreground/shared-pointer click ve foreground modifier kullanımı Equinox Local üzerinden kapalıdır.",
      );
    }

    if (!args.on && !args.query) {
      throw new Error("click için element ID (on) veya query zorunludur.");
    }

    if (args.query && DANGEROUS_MENU_PATTERN.test(args.query)) {
      throw new Error("Silme, sistem oturumu veya güç yönetimi hedeflerine query ile click kapalıdır.");
    }

    assertOptionalNumber(args.wait_for, "wait_for", {
      min: 0,
      max: 30_000,
      integer: true,
    });
  }

  if (toolName === "drag") {
    assertStringLimit(args.from, "from", 500);
    assertStringLimit(args.to, "to", 500);
    assertStringLimit(args.snapshot, "snapshot", 200);

    if (args.from_coords !== undefined || args.to_coords !== undefined) {
      throw new Error(
        "Koordinat tabanlı drag kapalıdır; see/inspect_ui element ID veya query kullan.",
      );
    }

    if (!args.from || !args.to) {
      throw new Error("drag için from ve to semantik element hedefleri zorunludur.");
    }

    assertOptionalNumber(args.duration, "duration", {
      min: 0,
      max: 10_000,
      integer: true,
    });
  }

  if (toolName === "move") {
    assertStringLimit(args.id, "id", 500);
    assertStringLimit(args.snapshot, "snapshot", 200);

    if (
      args.coordinates !== undefined ||
      args.to !== undefined ||
      args.center === true
    ) {
      throw new Error(
        "Koordinat/merkez tabanlı mouse move kapalıdır; element ID kullan.",
      );
    }

    if (!args.id) {
      throw new Error("move için see/inspect_ui kaynaklı element ID zorunludur.");
    }
  }

  if (toolName === "hotkey") {
    assertStringLimit(args.keys, "keys", 120);
    assertStringLimit(args.app, "app", 300);
    assertStringLimit(args.window_title, "window_title", 500);

    if (!hasDesktopTarget(args)) {
      throw new Error(
        "Global hotkey gönderimi kapalıdır; app/pid/window hedefi belirt.",
      );
    }

    if (isDangerousKeyboardChord(normalizeHotkeyChord(args.keys))) {
      throw new Error("Silme, Force Quit veya oturum kilitleme hotkey'i masaüstü köprüsünde kapalıdır.");
    }

    assertOptionalNumber(args.hold_duration, "hold_duration", {
      min: 0,
      max: 5_000,
      integer: true,
    });
  }

  if (toolName === "press") {
    assertStringLimit(args.key, "key", 120);
    assertStringLimit(args.snapshot, "snapshot", 200);

    if (!hasExplicitSnapshot(args)) {
      throw new Error(
        "Peekaboo 4 press için fresh exact snapshot zorunludur; targetless veya implicit latest keyboard gönderimi kapalıdır.",
      );
    }
    if (
      args.app !== undefined || args.pid !== undefined || args.window_id !== undefined ||
      args.window_title !== undefined || args.window_index !== undefined || args.foreground !== undefined
    ) {
      throw new Error(
        "Peekaboo 4 press yalnız snapshot-pinned background delivery kullanır; app/pid/window/foreground hedefleri kapalıdır.",
      );
    }

    if (args.keys !== undefined) {
      if (!Array.isArray(args.keys) || args.keys.length === 0 || args.keys.length > 100) {
        throw new Error("press.keys 1-100 chord içeren bir dizi olmalı.");
      }
      for (const chord of args.keys) {
        assertStringLimit(chord, "press.keys[]", 120);
        if (isDangerousKeyboardChord(normalizePressChord(chord))) {
          throw new Error("Silme, Force Quit veya oturum kilitleme press chord'u masaüstü köprüsünde kapalıdır.");
        }
      }
    }

    if (args.modifiers !== undefined && !Array.isArray(args.modifiers)) {
      throw new Error("press.modifiers bir dizi olmalı.");
    }
    if (Array.isArray(args.modifiers)) {
      for (const modifier of args.modifiers) {
        assertStringLimit(modifier, "press.modifiers[]", 20);
      }
    }

    if (Boolean(args.key) === Array.isArray(args.keys)) {
      throw new Error("press için keys veya key biçimlerinden tam olarak biri kullanılmalı.");
    }
    if (Array.isArray(args.keys) && args.modifiers !== undefined) {
      throw new Error("press.keys ile modifiers birlikte kullanılamaz.");
    }

    if (
      args.key &&
      isDangerousKeyboardChord([
        ...(Array.isArray(args.modifiers) ? args.modifiers : []),
        args.key,
      ].map((part) => String(part).toLowerCase()))
    ) {
      throw new Error("Silme, Force Quit veya oturum kilitleme press chord'u masaüstü köprüsünde kapalıdır.");
    }

    assertOptionalNumber(args.hold, "hold", { min: 0, max: 10_000, integer: true });
    assertOptionalNumber(args.delay, "delay", { min: 0, max: 10_000, integer: true });
    assertOptionalNumber(args.count, "count", { min: 1, max: 100, integer: true });
  }

  if (toolName === "scroll") {
    assertStringLimit(args.on, "on", 500);
    assertStringLimit(args.snapshot, "snapshot", 200);

    if (!args.on) {
      throw new Error(
        "Mouse konumunda global scroll kapalıdır; scroll hedef element ID'si belirt.",
      );
    }

    if (args.foreground === true || args.smooth === true) {
      throw new Error(
        "Foreground/shared-pointer scroll Equinox Local üzerinden kapalıdır.",
      );
    }

    assertOptionalNumber(args.amount, "amount", {
      min: -100,
      max: 100,
    });
    assertOptionalNumber(args.delay, "delay", {
      min: 0,
      max: 1_000,
    });
  }

  if (toolName === "type") {
    assertStringLimit(args.text, "text", MAX_TEXT_INPUT);
    assertStringLimit(args.on, "on", 500);
    assertStringLimit(args.snapshot, "snapshot", 200);
    assertStringLimit(args.app, "app", 300);
    assertStringLimit(args.window_title, "window_title", 500);

    if (!hasExplicitSnapshot(args) && !hasDesktopTarget(args)) {
      throw new Error(
        "Aktif odağa körlemesine yazma kapalıdır; fresh exact snapshot veya açık element/uygulama/pencere hedefi belirt.",
      );
    }

    assertOptionalNumber(args.delay, "delay", {
      min: 0,
      max: 1_000,
    });
    assertOptionalNumber(args.tab, "tab", {
      min: 0,
      max: 50,
      integer: true,
    });
  }

  if (toolName === "perform_action" || toolName === "action") {
    assertStringLimit(args.on, "on", 500);
    assertStringLimit(args.snapshot, "snapshot", 200);
    assertStringLimit(args.action, "action", 80);

    if (!/^AX[A-Za-z0-9]{1,60}$/u.test(args.action ?? "")) {
      throw new Error(`${toolName} yalnız AX* accessibility eylemlerini kabul eder.`);
    }
  }

  if (toolName === "set_value") {
    assertStringLimit(args.on, "on", 500);
    assertStringLimit(args.snapshot, "snapshot", 200);

    if (typeof args.value === "string" && args.value.length > MAX_TEXT_INPUT) {
      throw new Error(`set_value metni ${MAX_TEXT_INPUT} karakter sınırını aşıyor.`);
    }
  }

  if (toolName === "space") {
    assertStringLimit(args.app, "app", 300);
    assertOptionalNumber(args.to, "to", { min: 1, max: 64, integer: true });
    assertOptionalNumber(args.window_index, "window_index", {
      min: 0,
      max: 1_000,
      integer: true,
    });
  }

  if (toolName === "sleep") {
    assertOptionalNumber(args.duration, "duration", {
      min: 0,
      max: 30_000,
      integer: true,
    });
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
    path.join(ROOT, "runtime", "peekaboo", "peekaboo"),
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
      args: [
        "mcp",
        "--no-remote",
        "--log-level",
        "warning",
        "--input-strategy",
        "actionFirst",
      ],
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
    if (
      !refresh &&
      permissionCache &&
      timestamp - permissionCache.fetchedAt < PEEKABOO_PERMISSION_CACHE_MS
    ) {
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
        const currentPermissions = await readPermissions(false);
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
  PEEKABOO_PERMISSION_CACHE_MS,
  MAX_ARGUMENT_BYTES,
  MAX_RESULT_BYTES,
  MAX_TEXT_INPUT,
  MIN_PEEKABOO_VERSION,
  MAX_SUPPORTED_PEEKABOO_MAJOR,
  PEEKABOO_V3_REQUIRED_TOOLS,
  PEEKABOO_V4_REQUIRED_TOOLS,
  REQUIRED_TOOL_SHAPES,
  hasExplicitSnapshot,
  hasDesktopTarget,
  requiredPermissionsForTool,
  assertPermissionState,
  isPeekabooTransportError,
  guardPeekabooResult,
});
