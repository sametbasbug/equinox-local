import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { EQUINOX_LOCAL_WINAPP_VERSION } from "./equinox-local-runtime-versions.js";

const execFile = promisify(execFileCallback);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = path.basename(MODULE_DIR) === "src" ? path.dirname(MODULE_DIR) : MODULE_DIR;
const MAX_ARGUMENT_BYTES = 100 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_WAIT_MS = 60_000;
const MAX_TEXT_INPUT = 20_000;
const MAX_PATH_LENGTH = 4096;

function objectSchema(properties, required = []) {
  return Object.freeze({ type: "object", properties: Object.freeze(properties), required: Object.freeze(required), additionalProperties: false });
}
const string = (description, maxLength = 1000, { minLength = 1 } = {}) => Object.freeze({ type: "string", minLength, maxLength, description });
const integer = (description, minimum, maximum) => Object.freeze({ type: "integer", minimum, maximum, description });
const number = (description, minimum, maximum) => Object.freeze({ type: "number", minimum, maximum, description });
const bool = (description) => Object.freeze({ type: "boolean", description });
const enumeration = (description, values) => Object.freeze({ type: "string", enum: Object.freeze(values), description });

const targetProperties = Object.freeze({
  app: string("Process name or window-title fragment used by winapp -a.", 300),
  window: string("Exact HWND returned by list_windows, encoded as decimal or 0x-prefixed text.", 32),
  pid: integer("Exact process id used by winapp -p.", 1, 0x7fffffff),
  workflow_id: string("Optional winapp UI workflow id used for native desktop-turn continuity/arbitration.", 256),
});
function withTarget(properties = {}, required = []) {
  return objectSchema({ ...targetProperties, ...properties }, required);
}
const selector = string("AutomationId, semantic slug, accessible-text selector, or coordinate accepted by winapp.", 1000);
const coordinate = string("Screen coordinate in x,y form, in the same coordinate space reported by winapp inspect/search.", 64);
const direction = enumeration("Direction.", ["up", "down", "left", "right"]);

export const WINAPP_ALLOWED_TOOLS = Object.freeze([
  "list_windows", "inspect_ui", "search", "get_property", "get_value", "get_focused", "wait_for", "screenshot",
  "set_value", "invoke", "focus", "click", "drag", "hover", "send_keys", "scroll_into_view", "scroll", "touch", "pen", "yield",
]);
const WINAPP_READ_ONLY_TOOLS = new Set([
  "list_windows", "inspect_ui", "search", "get_property", "get_value", "get_focused", "wait_for", "screenshot",
]);

export const WINAPP_TOOL_DEFINITIONS = Object.freeze({
  list_windows: Object.freeze({ name: "list_windows", description: "List Windows app windows and stable HWNDs through Microsoft winapp UI Automation.", readOnly: true, inputSchema: withTarget({ show_hidden: bool("Include invisible zero-size windows.") }) }),
  inspect_ui: Object.freeze({ name: "inspect_ui", description: "Inspect the Windows UI Automation tree, including subtree/ancestor and interactive-only views.", readOnly: true, inputSchema: withTarget({ selector, depth: integer("Maximum UI tree depth.", 1, 50), ancestors: bool("Walk from selector up through its ancestors."), interactive: bool("Return invokable/interactive elements only."), hide_disabled: bool("Hide disabled elements."), hide_offscreen: bool("Hide off-screen elements.") }) }),
  search: Object.freeze({ name: "search", description: "Search Windows UI Automation controls with native winapp scoping/filter semantics.", readOnly: true, inputSchema: withTarget({ query: string("UI search query.", 1000), max: integer("Maximum matches returned by winapp.", 1, 1000), root: selector, type: string("Optional UIA control type, such as Button/Edit/Text.", 80), class_name: string("Optional exact UIA ClassName filter.", 200) }, ["query"]) }),
  get_property: Object.freeze({ name: "get_property", description: "Read all properties or one named UI Automation property from a selected Windows control.", readOnly: true, inputSchema: withTarget({ selector, property: string("Optional case-sensitive UI Automation property name. Omit to list all available properties.", 120), root: selector, type: string("Optional UIA control type filter.", 80), class_name: string("Optional exact UIA ClassName filter.", 200) }, ["selector"]) }),
  get_value: Object.freeze({ name: "get_value", description: "Read the current value/text of a selected Windows control.", readOnly: true, inputSchema: withTarget({ selector, root: selector, type: string("Optional UIA control type filter.", 80), class_name: string("Optional exact UIA ClassName filter.", 200) }, ["selector"]) }),
  get_focused: Object.freeze({ name: "get_focused", description: "Report the focused UI Automation element for the selected Windows app/window.", readOnly: true, inputSchema: withTarget() }),
  wait_for: Object.freeze({ name: "wait_for", description: "Wait boundedly for a Windows UI element to appear/disappear or reach a property/value.", readOnly: true, inputSchema: withTarget({ selector, value: Object.freeze({ type: "string", maxLength: MAX_TEXT_INPUT }), property: string("Optional case-sensitive UI Automation property to compare.", 120), gone: bool("Wait for the selector to disappear."), contains: bool("Use substring matching for value."), timeout_ms: integer("Maximum wait in milliseconds.", 100, MAX_WAIT_MS), root: selector, type: string("Optional UIA control type filter.", 80), class_name: string("Optional exact UIA ClassName filter.", 200) }, ["selector"]) }),
  screenshot: Object.freeze({ name: "screenshot", description: "Capture a Windows app/window/control as PNG through winapp. Default output is a managed temp file and the JSON result returns its path.", readOnly: true, inputSchema: withTarget({ selector, output: string("Optional output PNG path. Omit to use Equinox-managed temporary output.", MAX_PATH_LENGTH), capture_screen: bool("Capture the live foreground screen region so visible overlays/popups are included."), focus: bool("Foreground the target before ordinary capture.") }) }),
  set_value: Object.freeze({ name: "set_value", description: "Set an editable control through UIA patterns without foreground keyboard injection.", readOnly: false, inputSchema: withTarget({ selector, value: Object.freeze({ type: "string", maxLength: MAX_TEXT_INPUT }) }, ["selector", "value"]) }),
  invoke: Object.freeze({ name: "invoke", description: "Invoke a Windows UI Automation element through its supported UIA action pattern.", readOnly: false, inputSchema: withTarget({ selector }, ["selector"]) }),
  focus: Object.freeze({ name: "focus", description: "Bring the selected Windows control/window forward and verify keyboard focus.", readOnly: false, inputSchema: withTarget({ selector }, ["selector"]) }),
  click: Object.freeze({ name: "click", description: "Click a re-resolved Windows UI element with winapp's native foreground and target-moved guards.", readOnly: false, inputSchema: withTarget({ selector, right: bool("Use the right mouse button."), double: bool("Double-click instead of single-click.") }, ["selector"]) }),
  drag: Object.freeze({ name: "drag", description: "Drag between selectors and/or screen coordinates using winapp's native SendInput safety and re-resolution behavior.", readOnly: false, inputSchema: withTarget({ from: selector, to: selector, right: bool("Use the right mouse button."), hold_ms: integer("Hold before moving; from==to can be used as long-press.", 0, 60_000), dwell_ms: integer("Dwell at destination before button-up.", 0, 60_000) }, ["from", "to"]) }),
  hover: Object.freeze({ name: "hover", description: "Move the pointer to an element and dwell so hover/tooltips/flyouts can activate.", readOnly: false, inputSchema: withTarget({ selector, dwell_ms: integer("Hover dwell time in milliseconds.", 0, 10_000) }, ["selector"]) }),
  send_keys: Object.freeze({ name: "send_keys", description: "Send bounded keyboard input using winapp's native transport and safety semantics. allow_system_keys delegates to winapp's own opt-in guard; win+l and ctrl+alt+del remain blocked by winapp itself.", readOnly: false, inputSchema: withTarget({ keys: Object.freeze({ type: "string", minLength: 1, maxLength: MAX_TEXT_INPUT }), target: selector, verbatim: bool("Type the whole keys payload literally."), via: enumeration("Keyboard transport.", ["post-message", "send-input"]), allow_system_keys: bool("Opt in to winapp-supported system/global key combinations when using send-input.") }, ["keys"]) }),
  scroll_into_view: Object.freeze({ name: "scroll_into_view", description: "Scroll a Windows UI Automation element into view through UIA.", readOnly: false, inputSchema: withTarget({ selector }, ["selector"]) }),
  scroll: Object.freeze({ name: "scroll", description: "Scroll through UIA direction/to patterns or native mouse-wheel injection. Winapp validates mutually exclusive mode options.", readOnly: false, inputSchema: withTarget({ selector, direction, to: enumeration("Jump destination.", ["top", "bottom"]), wheel: integer("Mouse wheel notches; positive=up, negative=down.", -1000, 1000) }, ["selector"]) }),
  touch: Object.freeze({ name: "touch", description: "Use winapp's native Windows touch injection for tap, long-press, swipe, pinch or stretch gestures.", readOnly: false, inputSchema: withTarget({ selector, at: coordinate, gesture: enumeration("Touch gesture.", ["tap", "double-tap", "long-press", "swipe", "pinch", "stretch"]), to_point: coordinate, direction, distance: integer("Gesture distance in pixels.", 1, 100_000), hold_ms: integer("Touch hold time in milliseconds.", 0, 60_000), duration_ms: integer("Gesture travel duration in milliseconds.", 0, 60_000), fingers: integer("Touch contact count.", 1, 10) }) }),
  pen: Object.freeze({ name: "pen", description: "Use winapp's native Windows synthetic pen/stylus API for taps, strokes and erasing.", readOnly: false, inputSchema: withTarget({ selector, at: coordinate, path: string("Whitespace-separated x,y pen stroke path.", 20_000), pressure: number("Pen pressure from 0.0 to 1.0.", 0, 1), tilt_x: integer("Pen X tilt in degrees.", -90, 90), tilt_y: integer("Pen Y tilt in degrees.", -90, 90), eraser: bool("Use the eraser end of the pen."), duration_ms: integer("Total stroke travel duration in milliseconds.", 0, 60_000) }) }),
  yield: Object.freeze({ name: "yield", description: "Release a winapp UI workflow desktop turn immediately instead of waiting for its idle grace.", readOnly: false, inputSchema: objectSchema({ workflow_id: targetProperties.workflow_id }, ["workflow_id"]) }),
});

function assertPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("winapp arguments must be a plain object.");
}
function assertExactKeys(args, schema) {
  const allowed = new Set(Object.keys(schema.properties ?? {}));
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`winapp argument is not supported: ${key}`);
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) throw new Error(`winapp argument is required: ${key}`);
}
function validateScalar(key, value, spec) {
  if (spec.type === "string") {
    if (typeof value !== "string" || (spec.minLength !== undefined && value.length < spec.minLength) || (spec.maxLength !== undefined && value.length > spec.maxLength)) throw new Error(`winapp ${key} is invalid.`);
  } else if (spec.type === "integer") {
    if (!Number.isSafeInteger(value) || value < spec.minimum || value > spec.maximum) throw new Error(`winapp ${key} is invalid.`);
  } else if (spec.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < spec.minimum || value > spec.maximum) throw new Error(`winapp ${key} is invalid.`);
  } else if (spec.type === "boolean" && typeof value !== "boolean") throw new Error(`winapp ${key} is invalid.`);
  if (spec.enum && !spec.enum.includes(value)) throw new Error(`winapp ${key} is invalid.`);
}
function validateArguments(definition, input) {
  assertPlainObject(input);
  assertExactKeys(input, definition.inputSchema);
  for (const [key, value] of Object.entries(input)) validateScalar(key, value, definition.inputSchema.properties[key]);
  const targets = ["app", "window", "pid"].filter((key) => Object.hasOwn(input, key));
  if (targets.length > 1) throw new Error("winapp accepts only one of app, window, or pid per operation.");
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_ARGUMENT_BYTES) throw new Error("winapp arguments exceed the bounded input limit.");
  return input;
}
function targetArgs(args) {
  if (args.app !== undefined) return ["-a", args.app];
  if (args.window !== undefined) return ["-w", args.window];
  if (args.pid !== undefined) return ["-p", String(args.pid)];
  return [];
}
function scopedFilterArgs(args) {
  return [
    ...(args.root ? ["--root", args.root] : []),
    ...(args.type ? ["--type", args.type] : []),
    ...(args.class_name ? ["--class-name", args.class_name] : []),
  ];
}
function commandArgs(toolName, args, { screenshotOutput = null } = {}) {
  const target = targetArgs(args);
  switch (toolName) {
    case "list_windows": return ["ui", "list-windows", ...target, ...(args.show_hidden ? ["--show-hidden"] : []), "--json"];
    case "inspect_ui": return ["ui", "inspect", ...(args.selector ? [args.selector] : []), ...target, ...(args.depth ? ["--depth", String(args.depth)] : []), ...(args.ancestors ? ["--ancestors"] : []), ...(args.interactive ? ["--interactive"] : []), ...(args.hide_disabled ? ["--hide-disabled"] : []), ...(args.hide_offscreen ? ["--hide-offscreen"] : []), "--json"];
    case "search": return ["ui", "search", args.query, ...target, ...(args.max ? ["--max", String(args.max)] : []), ...scopedFilterArgs(args), "--json"];
    case "get_property": return ["ui", "get-property", args.selector, ...target, ...(args.property ? ["--property", args.property] : []), ...scopedFilterArgs(args), "--json"];
    case "get_value": return ["ui", "get-value", args.selector, ...target, ...scopedFilterArgs(args), "--json"];
    case "get_focused": return ["ui", "get-focused", ...target, "--json"];
    case "wait_for": return ["ui", "wait-for", args.selector, ...target, ...(args.value !== undefined ? ["--value", args.value] : []), ...(args.property ? ["--property", args.property] : []), ...(args.gone ? ["--gone"] : []), ...(args.contains ? ["--contains"] : []), ...scopedFilterArgs(args), "--timeout", String(args.timeout_ms ?? 10_000), "--json"];
    case "screenshot": return ["ui", "screenshot", ...(args.selector ? [args.selector] : []), ...target, "--output", args.output ?? screenshotOutput, ...(args.capture_screen ? ["--capture-screen"] : []), ...(args.focus ? ["--focus"] : []), "--json"];
    case "set_value": return ["ui", "set-value", args.selector, args.value, ...target, "--json"];
    case "invoke": return ["ui", "invoke", args.selector, ...target, "--json"];
    case "focus": return ["ui", "focus", args.selector, ...target, "--json"];
    case "click": return ["ui", "click", args.selector, ...target, ...(args.double ? ["--double"] : []), ...(args.right ? ["--right"] : []), "--json"];
    case "drag": return ["ui", "drag", args.from, args.to, ...target, ...(args.right ? ["--right"] : []), ...(args.hold_ms !== undefined ? ["--hold-ms", String(args.hold_ms)] : []), ...(args.dwell_ms !== undefined ? ["--dwell-ms", String(args.dwell_ms)] : []), "--json"];
    case "hover": return ["ui", "hover", args.selector, ...target, ...(args.dwell_ms !== undefined ? ["--dwell-time", String(args.dwell_ms)] : []), "--json"];
    case "send_keys": return ["ui", "send-keys", args.keys, ...target, ...(args.target ? ["--target", args.target] : []), ...(args.verbatim ? ["--verbatim"] : []), ...(args.via ? ["--via", args.via] : []), ...(args.allow_system_keys ? ["--allow-system-keys"] : []), "--json"];
    case "scroll_into_view": return ["ui", "scroll-into-view", args.selector, ...target, "--json"];
    case "scroll": return ["ui", "scroll", args.selector, ...target, ...(args.direction ? ["--direction", args.direction] : []), ...(args.to ? ["--to", args.to] : []), ...(args.wheel !== undefined ? ["--wheel", String(args.wheel)] : []), "--json"];
    case "touch": return ["ui", "touch", ...(args.selector ? [args.selector] : []), ...target, ...(args.at ? ["--at", args.at] : []), ...(args.gesture ? ["--gesture", args.gesture] : []), ...(args.to_point ? ["--to-point", args.to_point] : []), ...(args.direction ? ["--direction", args.direction] : []), ...(args.distance !== undefined ? ["--distance", String(args.distance)] : []), ...(args.hold_ms !== undefined ? ["--hold-ms", String(args.hold_ms)] : []), ...(args.duration_ms !== undefined ? ["--duration-ms", String(args.duration_ms)] : []), ...(args.fingers !== undefined ? ["--fingers", String(args.fingers)] : []), "--json"];
    case "pen": return ["ui", "pen", ...(args.selector ? [args.selector] : []), ...target, ...(args.at ? ["--at", args.at] : []), ...(args.path ? ["--path", args.path] : []), ...(args.pressure !== undefined ? ["--pressure", String(args.pressure)] : []), ...(args.tilt_x !== undefined ? ["--tilt-x", String(args.tilt_x)] : []), ...(args.tilt_y !== undefined ? ["--tilt-y", String(args.tilt_y)] : []), ...(args.eraser ? ["--eraser"] : []), ...(args.duration_ms !== undefined ? ["--duration-ms", String(args.duration_ms)] : []), "--json"];
    case "yield": return ["ui", "yield", "--json"];
    default: throw new Error(`winapp tool is not allowed: ${toolName}`);
  }
}

export function buildSafeWinappEnvironment(baseEnvironment = process.env, workflowId = null) {
  const safe = {};
  const allowed = ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "USERNAME", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "PROCESSOR_ARCHITECTURE"];
  for (const key of allowed) {
    const value = baseEnvironment[key];
    if (typeof value === "string" && value.length <= 10_000) safe[key] = value;
  }
  const windowsRoot = safe.SystemRoot || safe.WINDIR || "C:\\Windows";
  return { ...safe, PATH: `${windowsRoot}\\System32;${windowsRoot}`, NO_COLOR: "1", ...(workflowId ? { WINAPP_UI_WORKFLOW_ID: workflowId } : {}) };
}

export async function resolveWinappBinary(baseEnvironment = process.env, { fsImpl = fs } = {}) {
  const configured = typeof baseEnvironment.EQUINOX_WINAPP_PATH === "string" ? baseEnvironment.EQUINOX_WINAPP_PATH : "";
  const candidates = [configured && path.win32.isAbsolute(configured) ? configured : null, path.join(RUNTIME_ROOT, "runtime", "winapp", "winapp.exe")].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const stat = await fsImpl.lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch {}
  }
  throw new Error("Equinox Local pinned Microsoft winapp runtime is unavailable. Repair or reinstall Equinox Local instead of using a system winapp package.");
}

function boundedError(error) {
  const stdout = typeof error?.stdout === "string" ? error.stdout : "";
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  const text = (stderr || stdout || error?.message || String(error)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim();
  return text.slice(0, 4000) || "Microsoft winapp command failed.";
}
function tempRoot(baseEnvironment) {
  const candidate = baseEnvironment.TEMP || baseEnvironment.TMP || os.tmpdir();
  return path.win32.join(candidate, "Equinox Local", "desktop");
}

export function createWinappBridge({ baseEnvironment = process.env, execFileImpl = execFile, resolveBinaryImpl = resolveWinappBinary, fsImpl = fs, platform = process.platform } = {}) {
  let cachedBinary = null;
  async function binary() {
    if (platform !== "win32") throw new Error("Microsoft winapp desktop automation is available only on Windows.");
    cachedBinary ??= await resolveBinaryImpl(baseEnvironment, { fsImpl });
    return cachedBinary;
  }
  async function run(args, { timeoutMs = DEFAULT_TIMEOUT_MS, workflowId = null } = {}) {
    const executable = await binary();
    try {
      const result = await execFileImpl(executable, args, { env: buildSafeWinappEnvironment(baseEnvironment, workflowId), timeout: timeoutMs, maxBuffer: MAX_RESULT_BYTES, windowsHide: true });
      if (Buffer.byteLength(result.stdout ?? "", "utf8") > MAX_RESULT_BYTES || Buffer.byteLength(result.stderr ?? "", "utf8") > MAX_RESULT_BYTES) throw new Error("Microsoft winapp output exceeded the bounded result limit.");
      return result;
    } catch (error) {
      throw new Error(`Microsoft winapp failed: ${boundedError(error)}`);
    }
  }
  return Object.freeze({
    engine: "winapp",
    label: "Windows desktop",
    async status() {
      const executable = await binary();
      const result = await run(["--version"], { timeoutMs: 10_000 });
      const rawVersion = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      if (!rawVersion.includes(EQUINOX_LOCAL_WINAPP_VERSION)) throw new Error(`Pinned winapp version mismatch; expected ${EQUINOX_LOCAL_WINAPP_VERSION}.`);
      return Object.freeze({
        engine: "winapp",
        version: EQUINOX_LOCAL_WINAPP_VERSION,
        binary: executable,
        active: true,
        allowedToolCount: WINAPP_ALLOWED_TOOLS.length,
        allowedTools: [...WINAPP_ALLOWED_TOOLS],
        compatibility: {
          ok: true,
          minimumVersion: EQUINOX_LOCAL_WINAPP_VERSION,
          warnings: ["Microsoft winapp CLI is Public Preview; Equinox pins the runtime but relies on winapp's native UI/input safety semantics rather than duplicating restrictive policy wrappers."],
        },
      });
    },
    async restart() { cachedBinary = null; await binary(); },
    async listTools() { await binary(); return WINAPP_ALLOWED_TOOLS.map((name) => WINAPP_TOOL_DEFINITIONS[name]); },
    async callTool(toolName, input = {}) {
      const definition = WINAPP_TOOL_DEFINITIONS[toolName];
      if (!definition) throw new Error(`winapp tool is not allowed: ${toolName}`);
      const args = validateArguments(definition, input);
      let screenshotOutput = null;
      if (toolName === "screenshot" && !args.output) {
        const directory = tempRoot(baseEnvironment);
        await fsImpl.mkdir(directory, { recursive: true });
        screenshotOutput = path.win32.join(directory, `capture-${Date.now()}-${randomUUID()}.png`);
      }
      const timeoutMs = toolName === "wait_for" ? Math.min(MAX_WAIT_MS + 5_000, (args.timeout_ms ?? 10_000) + 5_000) : DEFAULT_TIMEOUT_MS;
      const result = await run(commandArgs(toolName, args, { screenshotOutput }), { timeoutMs, workflowId: args.workflow_id ?? null });
      const raw = String(result.stdout ?? "").trim();
      let parsed;
      try { parsed = raw ? JSON.parse(raw) : {}; } catch { throw new Error("Microsoft winapp returned invalid JSON."); }
      return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
    },
    get readOnlyTools() { return new Set(WINAPP_READ_ONLY_TOOLS); },
  });
}

export const __test = Object.freeze({ validateArguments, commandArgs, tempRoot, MAX_ARGUMENT_BYTES, MAX_RESULT_BYTES, MAX_WAIT_MS });
