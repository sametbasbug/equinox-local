import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PEEKABOO_ALLOWED_TOOLS,
  __test,
  buildSafePeekabooEnvironment,
  inspectPeekabooCompatibility,
  isPeekabooControlCenterReady,
  isPeekabooStatusReady,
  normalizePeekabooArguments,
  parsePeekabooPermissions,
  resolvePeekabooBinary,
} from "../../src/peekaboo-bridge.js";

test("Peekaboo exposes the foreground-capable native desktop surface without duplicate AI or browser stacks", () => {
  for (const name of ["capture", "dialog", "paste", "drag", "move", "verify_state", "clipboard", "app", "press"]) {
    assert.equal(PEEKABOO_ALLOWED_TOOLS.includes(name), true, name);
  }
  for (const name of ["agent", "analyze", "browser", "image"]) {
    assert.equal(PEEKABOO_ALLOWED_TOOLS.includes(name), false, name);
  }
  assert.equal(PEEKABOO_ALLOWED_TOOLS.length, 22);
  assert.deepEqual(__test.PEEKABOO_MCP_ARGS, [
    "mcp", "--no-remote", "--allow-foreground", "--log-level", "warning", "--input-strategy", "actionFirst",
  ]);
});

test("safe Peekaboo environment does not inherit provider credentials", () => {
  const env = buildSafePeekabooEnvironment({
    HOME: "/Users/demo", USER: "demo", OPENAI_API_KEY: "secret-openai",
    ANTHROPIC_API_KEY: "secret-anthropic", GH_TOKEN: "secret-github", PATH: "/unsafe/path",
  });
  assert.equal(env.HOME, "/Users/demo");
  assert.equal(env.USER, "demo");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  assert.equal(env.PEEKABOO_ALLOW_TOOLS, PEEKABOO_ALLOWED_TOOLS.join(","));
});

test("Peekaboo resolution uses only an explicit or release-bundled runtime", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-pinned-peekaboo-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "peekaboo");
  await fs.writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(await resolvePeekabooBinary({ EQUINOX_PEEKABOO_PATH: binary }), binary);
  await assert.rejects(
    resolvePeekabooBinary({ EQUINOX_PEEKABOO_PATH: path.join(root, "missing") }),
    /pinned Peekaboo runtime is unavailable/u,
  );
});

test("foreground mouse, keyboard and lifecycle arguments pass through unchanged", () => {
  const cases = [
    ["click", { coords: "100,200", foreground: true, double: true }],
    ["drag", { from_coords: "1,2", to_coords: "300,400", foreground: true, profile: "human" }],
    ["move", { center: true, foreground: true, smooth: true }],
    ["scroll", { direction: "down", foreground: true, smooth: true, amount: 12 }],
    ["press", { keys: ["cmd+delete"], app: "Finder", foreground: true }],
    ["type", { text: "hello", app: "TextEdit", foreground: true }],
    ["app", { action: "quit", name: "Finder", force: true }],
    ["app", { action: "quit", all: true, except: "Finder" }],
    ["menu", { action: "click", app: "Finder", path: "Finder > Empty Bin", foreground: true }],
    ["window", { action: "focus", app: "TextEdit" }],
    ["space", { action: "switch", to: 2, foreground: true }],
  ];
  for (const [name, args] of cases) assert.deepEqual(normalizePeekabooArguments(name, args), args);
});

test("foreground utility tools and direct filesystem options are available while local bounds remain", () => {
  for (const [name, args] of [
    ["see", { path: "/tmp/capture.png", app_target: "Finder" }],
    ["capture", { mode: "frontmost", capture_focus: "foreground", output_dir: "/tmp/peekaboo" }],
    ["clipboard", { action: "set", text: "hello" }],
    ["clipboard", { action: "restore", slot: "handoff" }],
    ["paste", { text: "hello", app: "TextEdit" }],
    ["dialog", { action: "file", app: "TextEdit", path: "/tmp", name: "note.txt", foreground: true }],
    ["action", { on: "B7", action: "AXShowMenu" }],
    ["verify_state", { app: "TextEdit", predicates: [{ kind: "window_exists", expected: true }] }],
  ]) assert.deepEqual(normalizePeekabooArguments(name, args), args);

  assert.throws(() => normalizePeekabooArguments("inspect_ui", { max_elements: 5001 }), /max_elements/u);
  assert.throws(() => normalizePeekabooArguments("type", { text: "x".repeat(__test.MAX_TEXT_INPUT + 1) }), /20000/u);
  assert.throws(() => normalizePeekabooArguments("sleep", { duration: 30001 }), /duration/u);
});

test("non-desktop Peekaboo AI/browser surfaces remain outside the gateway", () => {
  for (const name of ["agent", "analyze", "browser", "image", "swipe", "hotkey", "perform_action", "list"]) {
    assert.throws(() => normalizePeekabooArguments(name, {}), /allowlist/u);
  }
});

function makeCompatibleToolCatalog() {
  return __test.PEEKABOO_V4_REQUIRED_TOOLS.map((name) => {
    const shape = __test.REQUIRED_TOOL_SHAPES[name];
    const properties = Object.fromEntries(shape.properties.map((property) => [property, {}]));
    if (shape.actionValues) properties.action = { enum: [...shape.actionValues] };
    return { name, inputSchema: { type: "object", properties } };
  });
}

test("Peekaboo compatibility gate requires the validated 4.5 foreground surface and catches schema drift", () => {
  const tools = makeCompatibleToolCatalog();
  const current = inspectPeekabooCompatibility(tools, "Peekaboo 4.5.0");
  assert.equal(current.ok, true);
  assert.equal(current.contract, "v4.5");
  assert.deepEqual(current.errors, []);
  assert.equal(__test.PEEKABOO_V4_REQUIRED_TOOLS.includes("drag"), true);
  assert.equal(__test.PEEKABOO_V4_REQUIRED_TOOLS.includes("move"), true);
  assert.equal(__test.PEEKABOO_V4_REQUIRED_TOOLS.includes("dialog"), true);
  assert.equal(__test.PEEKABOO_V4_REQUIRED_TOOLS.includes("verify_state"), true);

  const old = inspectPeekabooCompatibility(tools, "Peekaboo 4.4.9");
  assert.equal(old.ok, false);
  assert.match(old.errors.join("\n"), /4\.5\.0/u);

  const drifted = structuredClone(tools);
  delete drifted.find((tool) => tool.name === "click").inputSchema.properties.foreground;
  const drift = inspectPeekabooCompatibility(drifted, "Peekaboo 4.5.0");
  assert.equal(drift.ok, false);
  assert.match(drift.errors.join("\n"), /click.*'foreground'/u);

  const future = inspectPeekabooCompatibility(tools, "Peekaboo 5.0.0");
  assert.equal(future.ok, false);
  assert.match(future.errors.join("\n"), /major version 5/u);
});

test("Peekaboo permission parser and preflight distinguish granted permissions", () => {
  assert.deepEqual(parsePeekabooPermissions(
    "Screen Recording: [ok] Granted\nAccessibility: [warn] Not Granted",
  ), { screenRecording: true, accessibility: false });
  assert.deepEqual(parsePeekabooPermissions(
    "Screen Recording (Required): [ok] Granted\nAccessibility (Required): [ok] Granted\nEvent Synthesizing (Action-specific): [ok] Granted",
  ), { screenRecording: true, accessibility: true });
  assert.doesNotThrow(() => __test.assertPermissionState("capture", { screenRecording: true, accessibility: false }));
  assert.throws(() => __test.assertPermissionState("click", { screenRecording: true, accessibility: false }), /Accessibility izni gerekli/u);
});

test("Control Center readiness trusts verified compatibility and permissions over optional status noise", () => {
  const readyStatus = {
    active: true, compatibility: { ok: true },
    permissionState: { screenRecording: true, accessibility: true }, error: "server_status",
  };
  assert.equal(isPeekabooStatusReady(readyStatus), true);
  assert.equal(isPeekabooStatusReady({ ...readyStatus, permissionState: { screenRecording: true, accessibility: false } }), false);
  assert.equal(isPeekabooStatusReady({ ...readyStatus, compatibility: { ok: false } }), false);
  assert.equal(isPeekabooStatusReady({ ...readyStatus, active: false }), false);
});

test("Control Center passive readiness never treats unknown permissions as an attention state", () => {
  const passiveStatus = { active: true, compatibility: { ok: true }, permissionState: null, permissions: null };
  assert.equal(isPeekabooControlCenterReady(passiveStatus), true);
  assert.equal(isPeekabooControlCenterReady({ ...passiveStatus, permissionState: { screenRecording: true, accessibility: false } }), false);
  assert.equal(isPeekabooControlCenterReady({ ...passiveStatus, compatibility: { ok: false } }), false);
  assert.equal(isPeekabooControlCenterReady({ ...passiveStatus, active: false }), false);
});

test("ambiguous foreground outcomes remain observable instead of becoming hard tool errors", () => {
  const ambiguous = {
    isError: true,
    content: [{ type: "text", text: "Click did not return a confirmed outcome. Follow the canonical escalation metadata before deciding whether to retry." }],
  };
  assert.equal(__test.isPeekabooAmbiguousOutcomeResult(ambiguous), true);
  const normalized = __test.normalizePeekabooAmbiguousOutcomeResult(ambiguous);
  assert.equal(normalized.isError, false);
  assert.match(normalized.content[0].text, /^\[ambiguous\]/u);
  assert.match(normalized.content[0].text, /observe the exact target/u);
  assert.equal(__test.isPeekabooAmbiguousOutcomeResult({
    isError: true,
    content: [{ type: "text", text: "Press sequence stopped after 0 completed press(es)." }],
  }), false);
});

test("transport errors, oversized inputs and oversized downstream results are guarded", () => {
  assert.equal(__test.isPeekabooTransportError(new Error("Connection closed")), true);
  assert.equal(__test.isPeekabooTransportError(new Error("button not found")), false);
  assert.throws(
    () => normalizePeekabooArguments("click", { query: "x".repeat(__test.MAX_ARGUMENT_BYTES + 1) }),
    /100 KB/u,
  );
  assert.throws(
    () => __test.guardPeekabooResult({ content: [{ type: "text", text: "x".repeat(__test.MAX_RESULT_BYTES + 1) }] }),
    /2 MB/u,
  );
});
