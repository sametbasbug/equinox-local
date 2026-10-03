import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";

import {
  buildSafeWinappEnvironment,
  createWinappBridge,
  WINAPP_ALLOWED_TOOLS,
  __test,
} from "../../src/winapp-bridge.js";

function tinyPng() {
  const png = new PNG({ width: 2, height: 3 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

function createHarness() {
  const calls = [];
  const mkdirs = [];
  const opened = [];
  const files = new Map();
  let clipboardText = "initial clipboard";
  const png = tinyPng();
  const bridge = createWinappBridge({
    platform: "win32",
    baseEnvironment: {
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
      USERPROFILE: "C:\\Users\\Test",
      OPENAI_API_KEY: "must-not-leak",
    },
    fsImpl: {
      mkdir: async (...args) => mkdirs.push(args),
      lstat: async (filePath) => ({ isFile: () => true, isSymbolicLink: () => false, size: String(filePath).endsWith(".png") ? png.length : 100 }),
      open: async (filePath, flags) => {
        opened.push({ filePath, flags });
        const data = String(filePath).endsWith(".png") ? png : files.get(filePath);
        return {
          stat: async () => ({ isFile: () => true, size: data.length }),
          readFile: async () => data,
          close: async () => {},
        };
      },
      writeFile: async (filePath, data) => { files.set(filePath, Buffer.from(data).toString("utf8")); },
      unlink: async (filePath) => { files.delete(filePath); },
    },
    resolveBinaryImpl: async () => "C:\\Equinox\\runtime\\winapp\\winapp.exe",
    execFileImpl: async (binary, args, options) => {
      calls.push({ binary, args, options });
      if (args[0] === "--version") return { stdout: "winapp 0.7.1\n", stderr: "" };
      if (String(binary).toLowerCase().endsWith("powershell.exe")) {
        const mode = args[args.indexOf("-Mode") + 1];
        if (mode === "Get") return { stdout: clipboardText, stderr: "" };
        if (mode === "Set") { clipboardText = files.get(args[args.indexOf("-InputPath") + 1]) ?? ""; return { stdout: "", stderr: "" }; }
        if (mode === "Clear") { clipboardText = ""; return { stdout: "", stderr: "" }; }
      }
      return { stdout: JSON.stringify({ ok: true, args }), stderr: "" };
    },
  });
  return { bridge, calls, mkdirs, opened, png, files, clipboard: () => clipboardText };
}

test("winapp bridge exposes a practical Windows UI surface instead of a crippled semantic subset", async () => {
  const { bridge } = createHarness();
  const tools = await bridge.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [...WINAPP_ALLOWED_TOOLS]);
  for (const required of ["screenshot", "drag", "hover", "scroll", "send_keys", "app", "window", "yield"]) {
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

test("winapp managed scratch files stay under per-user LocalAppData instead of the shared OS temp directory", () => {
  assert.equal(
    __test.tempRoot({ LOCALAPPDATA: "C:\\Users\\Türk User\\AppData\\Local", TEMP: "C:\\SharedTemp" }),
    "C:\\Users\\Türk User\\AppData\\Local\\Equinox Local\\cache\\desktop",
  );
  assert.equal(
    __test.tempRoot({ USERPROFILE: "C:\\Users\\Fallback", TEMP: "C:\\SharedTemp" }),
    "C:\\Users\\Fallback\\AppData\\Local\\Equinox Local\\cache\\desktop",
  );
  assert.throws(() => __test.tempRoot({ TEMP: "C:\\SharedTemp" }), /scratch root is unavailable/u);
});

test("winapp managed screenshot returns native MCP image content through the shared image validator", async () => {
  const { bridge, calls, mkdirs, opened, png } = createHarness();
  const result = await bridge.callTool("screenshot", { app: "Notepad", focus: true });
  const invocation = calls.at(-1);
  const outputIndex = invocation.args.indexOf("--output");
  assert.notEqual(outputIndex, -1);
  assert.match(invocation.args[outputIndex + 1], /^C:\\Users\\Test\\AppData\\Local\\Equinox Local\\cache\\desktop\\capture-/u);
  assert.equal(invocation.args.includes("--focus"), true);
  assert.equal(mkdirs.length, 1);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].filePath, invocation.args[outputIndex + 1]);
  assert.equal(opened[0].flags, "r");
  assert.equal(result.content[0].type, "text");
  assert.deepEqual(result.content[1], { type: "image", data: png.toString("base64"), mimeType: "image/png" });
});

test("winapp screenshot with explicit output remains file-only instead of becoming an arbitrary-path image reader", async () => {
  const { bridge } = createHarness();
  const result = await bridge.callTool("screenshot", { app: "Notepad", output: "C:\\Users\\Test\\Desktop\\capture.png" });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
});

test("winapp clipboard get/set/clear uses only the fixed Windows helper boundary", async () => {
  const { bridge, calls, clipboard, files } = createHarness();
  const got = await bridge.callTool("clipboard", { action: "get" });
  assert.match(got.content[0].text, /initial clipboard/u);
  await bridge.callTool("clipboard", { action: "set", text: "hello ✓" });
  assert.equal(clipboard(), "hello ✓");
  assert.equal(files.size, 0);
  const helperCall = calls.find((call) => String(call.binary).toLowerCase().endsWith("powershell.exe") && call.args.includes("Set"));
  assert.ok(helperCall);
  assert.deepEqual(helperCall.args.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass"]);
  assert.match(helperCall.args[helperCall.args.indexOf("-File") + 1], /equinox-local-windows-clipboard\.ps1$/u);
  await bridge.callTool("clipboard", { action: "clear" });
  assert.equal(clipboard(), "");
  await assert.rejects(bridge.callTool("clipboard", { action: "set" }), /requires text/u);
  await assert.rejects(bridge.callTool("clipboard", { action: "get", text: "nope" }), /valid only for set/u);
});

test("winapp paste sets clipboard text then delegates Ctrl+V targeting to native winapp", async () => {
  const { bridge, calls, clipboard } = createHarness();
  const result = await bridge.callTool("paste", { text: "paste me", pid: 4321, target: "SmokeText", workflow_id: "wf-paste" });
  assert.equal(clipboard(), "paste me");
  let invocation = calls.at(-1);
  assert.match(String(invocation.binary), /winapp\.exe$/u);
  assert.deepEqual(invocation.args, ["ui", "send-keys", "ctrl+v", "-a", "4321", "--target", "SmokeText", "--via", "send-input", "--json"]);
  assert.equal(invocation.options.env.WINAPP_UI_WORKFLOW_ID, "wf-paste");
  assert.match(result.content[0].text, /ctrl\+v/u);
  await bridge.callTool("paste", { text: "classic fallback", app: "Notepad", via: "post-message" });
  invocation = calls.at(-1);
  assert.deepEqual(invocation.args, ["ui", "send-keys", "ctrl+v", "-a", "Notepad", "--via", "post-message", "--json"]);
});

test("winapp app lifecycle uses only the fixed Equinox Windows helper", async () => {
  const { bridge, calls } = createHarness();
  await bridge.callTool("app", { action: "list" });
  let invocation = calls.at(-1);
  assert.match(String(invocation.binary).toLowerCase(), /powershell\.exe$/u);
  assert.match(invocation.args[invocation.args.indexOf("-File") + 1], /equinox-local-windows-desktop\.ps1$/u);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("-Mode"), invocation.args.indexOf("-Mode") + 2), ["-Mode", "AppList"]);

  await bridge.callTool("app", { action: "launch", name: "notepad.exe" });
  invocation = calls.at(-1);
  assert.equal(invocation.args[invocation.args.indexOf("-Mode") + 1], "AppLaunch");
  assert.equal(invocation.args[invocation.args.indexOf("-Name") + 1], "notepad.exe");

  await bridge.callTool("app", { action: "open", name: "C:\\Users\\Test\\Desktop\\notes.txt" });
  invocation = calls.at(-1);
  assert.equal(invocation.args[invocation.args.indexOf("-Mode") + 1], "AppOpen");
  assert.equal(invocation.args[invocation.args.indexOf("-Name") + 1], "C:\\Users\\Test\\Desktop\\notes.txt");

  await bridge.callTool("app", { action: "quit", pid: 4321, force: true });
  invocation = calls.at(-1);
  assert.equal(invocation.args[invocation.args.indexOf("-Mode") + 1], "AppQuit");
  assert.equal(invocation.args[invocation.args.indexOf("-TargetPid") + 1], "4321");
  assert.equal(invocation.args.includes("-Force"), true);

  await assert.rejects(bridge.callTool("app", { action: "launch", pid: 42 }), /requires name/u);
  await assert.rejects(bridge.callTool("app", { action: "open", pid: 42 }), /requires name/u);
  await assert.rejects(bridge.callTool("app", { action: "open", name: "notes.txt", force: true }), /force is valid only/u);
  await assert.rejects(bridge.callTool("app", { action: "focus" }), /requires exactly one/u);
  await assert.rejects(bridge.callTool("app", { action: "focus", name: "Notepad", force: true }), /force is valid only/u);
});

test("winapp window lifecycle combines native window discovery with exact Win32 mutations", async () => {
  const { bridge, calls } = createHarness();
  await bridge.callTool("window", { action: "list", app: "Notepad", show_hidden: true });
  let invocation = calls.at(-1);
  assert.match(String(invocation.binary), /winapp\.exe$/u);
  assert.deepEqual(invocation.args, ["ui", "list-windows", "-a", "Notepad", "--show-hidden", "--json"]);

  await bridge.callTool("window", { action: "minimize", window: "0x1234" });
  invocation = calls.at(-1);
  assert.match(String(invocation.binary).toLowerCase(), /powershell\.exe$/u);
  assert.equal(invocation.args[invocation.args.indexOf("-Mode") + 1], "WindowMinimize");
  assert.equal(invocation.args[invocation.args.indexOf("-Hwnd") + 1], "0x1234");

  await bridge.callTool("window", { action: "move", app: "Notepad", x: -1200, y: 40 });
  invocation = calls.at(-1);
  assert.equal(invocation.args[invocation.args.indexOf("-Mode") + 1], "WindowMove");
  assert.equal(invocation.args[invocation.args.indexOf("-Name") + 1], "Notepad");
  assert.equal(invocation.args[invocation.args.indexOf("-X") + 1], "-1200");
  assert.equal(invocation.args[invocation.args.indexOf("-Y") + 1], "40");

  await bridge.callTool("window", { action: "set-bounds", pid: 4321, x: 10, y: 20, width: 1280, height: 720 });
  invocation = calls.at(-1);
  assert.equal(invocation.args[invocation.args.indexOf("-Mode") + 1], "WindowSetBounds");
  assert.equal(invocation.args[invocation.args.indexOf("-Width") + 1], "1280");
  assert.equal(invocation.args[invocation.args.indexOf("-Height") + 1], "720");

  await assert.rejects(bridge.callTool("window", { action: "minimize" }), /requires exactly one/u);
  await assert.rejects(bridge.callTool("window", { action: "resize", window: "0x1", width: 900 }), /requires height/u);
  await assert.rejects(bridge.callTool("window", { action: "focus", window: "0x1", x: 0 }), /does not accept x/u);
});

test("winapp bridge maps native wheel scrolling without adding duplicate semantic validation", async () => {
  const { bridge, calls } = createHarness();
  await bridge.callTool("scroll", { app: "Demo", selector: "Pane", wheel: -3 });
  assert.deepEqual(calls.at(-1).args, ["ui", "scroll", "Pane", "-a", "Demo", "--wheel", "-3", "--json"]);
});

test("winapp bridge targets an exact process id through winapp -a PID semantics", async () => {
  const { bridge, calls } = createHarness();
  await bridge.callTool("inspect_ui", { pid: 4321, depth: 2 });
  assert.deepEqual(calls.at(-1).args, ["ui", "inspect", "-a", "4321", "--depth", "2", "--json"]);
});

test("winapp bridge keeps niche touch and pen commands out of the first-release agent surface", async () => {
  const { bridge } = createHarness();
  const tools = await bridge.listTools();
  assert.equal(tools.some((tool) => tool.name === "touch"), false);
  assert.equal(tools.some((tool) => tool.name === "pen"), false);
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
