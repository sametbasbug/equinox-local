import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSafeWinappEnvironment,
  createWinappBridge,
  WINAPP_ALLOWED_TOOLS,
} from "../../src/winapp-bridge.js";

function createHarness() {
  const calls = [];
  const mkdirs = [];
  const bridge = createWinappBridge({
    platform: "win32",
    baseEnvironment: {
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
      USERPROFILE: "C:\\Users\\Test",
      OPENAI_API_KEY: "must-not-leak",
    },
    fsImpl: { mkdir: async (...args) => mkdirs.push(args) },
    resolveBinaryImpl: async () => "C:\\Equinox\\runtime\\winapp\\winapp.exe",
    execFileImpl: async (binary, args, options) => {
      calls.push({ binary, args, options });
      if (args[0] === "--version") return { stdout: "winapp 0.7.1\n", stderr: "" };
      return { stdout: JSON.stringify({ ok: true, args }), stderr: "" };
    },
  });
  return { bridge, calls, mkdirs };
}

test("winapp bridge exposes a practical Windows UI surface instead of a crippled semantic subset", async () => {
  const { bridge } = createHarness();
  const tools = await bridge.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [...WINAPP_ALLOWED_TOOLS]);
  for (const required of ["screenshot", "drag", "hover", "scroll", "touch", "pen", "send_keys", "yield"]) {
    assert.equal(tools.some((tool) => tool.name === required), true, `missing ${required}`);
  }
  assert.equal(tools.some((tool) => tool.name === "record"), false, "record stays separate until managed artifact lifecycle is implemented");
});

test("winapp bridge delegates system-key opt-in to winapp native safety instead of adding a duplicate ban", async () => {
  const { bridge, calls } = createHarness();
  const result = await bridge.callTool("send_keys", {
    app: "Notepad", keys: "win+r", via: "send-input", allow_system_keys: true, workflow_id: "workflow-1",
  });
  assert.equal(result.content[0].type, "text");
  const invocation = calls.at(-1);
  assert.deepEqual(invocation.args, ["ui", "send-keys", "win+r", "-a", "Notepad", "--via", "send-input", "--allow-system-keys", "--json"]);
  assert.equal(invocation.options.env.WINAPP_UI_WORKFLOW_ID, "workflow-1");
  assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
});

test("winapp bridge maps native inspect/search/input options without a shell", async () => {
  const { bridge, calls } = createHarness();
  await bridge.callTool("inspect_ui", { app: "Notepad", selector: "Editor", ancestors: true, hide_offscreen: true });
  assert.deepEqual(calls.at(-1).args, ["ui", "inspect", "Editor", "-a", "Notepad", "--ancestors", "--hide-offscreen", "--json"]);
  await bridge.callTool("search", { app: "Notepad", query: "Button", max: 10, root: "Main", type: "Button", class_name: "Button" });
  assert.deepEqual(calls.at(-1).args, ["ui", "search", "Button", "-a", "Notepad", "--max", "10", "--root", "Main", "--type", "Button", "--class-name", "Button", "--json"]);
  await bridge.callTool("click", { app: "Notepad", selector: "Save", double: true });
  assert.deepEqual(calls.at(-1).args, ["ui", "click", "Save", "-a", "Notepad", "--double", "--json"]);
  await bridge.callTool("drag", { app: "Notepad", from: "A", to: "200,300", hold_ms: 150, dwell_ms: 250 });
  assert.deepEqual(calls.at(-1).args, ["ui", "drag", "A", "200,300", "-a", "Notepad", "--hold-ms", "150", "--dwell-ms", "250", "--json"]);
  assert.equal(calls.at(-1).options.shell, undefined);
});

test("winapp screenshot defaults to managed temporary output and returns JSON path metadata", async () => {
  const { bridge, calls, mkdirs } = createHarness();
  await bridge.callTool("screenshot", { app: "Notepad", focus: true });
  const invocation = calls.at(-1);
  const outputIndex = invocation.args.indexOf("--output");
  assert.notEqual(outputIndex, -1);
  assert.match(invocation.args[outputIndex + 1], /^C:\\Temp\\Equinox Local\\desktop\\capture-/u);
  assert.equal(invocation.args.includes("--focus"), true);
  assert.equal(mkdirs.length, 1);
});

test("winapp bridge maps scroll, touch and pen while leaving native semantic validation to winapp", async () => {
  const { bridge, calls } = createHarness();
  await bridge.callTool("scroll", { app: "Demo", selector: "Pane", wheel: -3 });
  assert.deepEqual(calls.at(-1).args, ["ui", "scroll", "Pane", "-a", "Demo", "--wheel", "-3", "--json"]);
  await bridge.callTool("touch", { app: "Demo", at: "100,200", gesture: "swipe", to_point: "500,200", duration_ms: 300 });
  assert.deepEqual(calls.at(-1).args, ["ui", "touch", "-a", "Demo", "--at", "100,200", "--gesture", "swipe", "--to-point", "500,200", "--duration-ms", "300", "--json"]);
  await bridge.callTool("pen", { app: "Demo", path: "100,100 200,200", pressure: 0.8, tilt_x: 10 });
  assert.deepEqual(calls.at(-1).args, ["ui", "pen", "-a", "Demo", "--path", "100,100 200,200", "--pressure", "0.8", "--tilt-x", "10", "--json"]);
});

test("winapp bridge targets an exact process id through winapp -a PID semantics", async () => {
  const { bridge, calls } = createHarness();
  await bridge.callTool("inspect_ui", { pid: 4321, depth: 2 });
  assert.deepEqual(calls.at(-1).args, ["ui", "inspect", "-a", "4321", "--depth", "2", "--json"]);
});

test("winapp bridge rejects ambiguous app/window/pid targeting but not native UI behaviors", async () => {
  const { bridge } = createHarness();
  await assert.rejects(bridge.callTool("click", { app: "Notepad", window: "1234", selector: "Save" }), /only one of app, window, or pid/u);
  await assert.rejects(bridge.callTool("send_keys", { app: "Notepad", keys: "hello", imaginary_option: true }), /argument is not supported/u);
});

test("winapp bridge status verifies the pinned binary version", async () => {
  const { bridge } = createHarness();
  const status = await bridge.status();
  assert.equal(status.engine, "winapp");
  assert.equal(status.version, "0.7.1");
  assert.equal(status.active, true);
  assert.equal(status.allowedToolCount, WINAPP_ALLOWED_TOOLS.length);
  assert.match(status.compatibility.warnings[0], /native UI\/input safety semantics/u);
});

test("winapp child environment keeps Windows runtime paths but strips provider secrets", () => {
  const env = buildSafeWinappEnvironment({ SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", USERPROFILE: "C:\\Users\\Test", PATH: "C:\\unsafe", OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "secret2" }, "wf-123");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.TEMP, "C:\\Temp");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH, "C:\\Windows\\System32;C:\\Windows");
  assert.equal(env.WINAPP_UI_WORKFLOW_ID, "wf-123");
});
