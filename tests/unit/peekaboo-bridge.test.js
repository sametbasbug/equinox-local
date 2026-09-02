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

test("Peekaboo allowlist excludes AI, browser and clipboard surfaces", () => {
  assert.equal(PEEKABOO_ALLOWED_TOOLS.includes("agent"), false);
  assert.equal(PEEKABOO_ALLOWED_TOOLS.includes("analyze"), false);
  assert.equal(PEEKABOO_ALLOWED_TOOLS.includes("browser"), false);
  assert.equal(PEEKABOO_ALLOWED_TOOLS.includes("clipboard"), false);
  assert.equal(PEEKABOO_ALLOWED_TOOLS.includes("dialog"), false);
  assert.equal(PEEKABOO_ALLOWED_TOOLS.includes("paste"), false);
  assert.equal(PEEKABOO_ALLOWED_TOOLS.includes("permissions"), true);
  assert.equal(PEEKABOO_ALLOWED_TOOLS.includes("see"), true);
  assert.equal(PEEKABOO_ALLOWED_TOOLS.includes("inspect_ui"), true);
  assert.equal(PEEKABOO_ALLOWED_TOOLS.includes("press"), true);
  assert.equal(PEEKABOO_ALLOWED_TOOLS.includes("action"), true);
});

test("safe Peekaboo environment does not inherit provider credentials", () => {
  const env = buildSafePeekabooEnvironment({
    HOME: "/Users/demo",
    USER: "demo",
    OPENAI_API_KEY: "secret-openai",
    ANTHROPIC_API_KEY: "secret-anthropic",
    GH_TOKEN: "secret-github",
    PATH: "/unsafe/path",
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

test("semantic desktop targeting is enforced for click, drag, scroll and move", () => {
  assert.deepEqual(
    normalizePeekabooArguments("click", { on: "B1", snapshot: "snap-1" }),
    { on: "B1", snapshot: "snap-1" },
  );

  assert.throws(
    () => normalizePeekabooArguments("click", { coords: "100,200" }),
    /Koordinat tabanlı click/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("drag", { from_coords: "1,2", to_coords: "3,4" }),
    /Koordinat tabanlı drag/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("scroll", { direction: "down" }),
    /scroll hedef element/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("move", { center: true }),
    /Koordinat\/merkez/u,
  );
});

test("blind typing and global keyboard input are rejected", () => {
  assert.throws(
    () => normalizePeekabooArguments("type", { text: "hello" }),
    /Aktif odağa körlemesine/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("hotkey", { keys: "cmd,c" }),
    /Global hotkey/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("press", { keys: ["cmd+c"] }),
    /fresh exact snapshot/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("press", { keys: ["cmd+c"], snapshot: "latest" }),
    /implicit latest/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("press", { keys: ["cmd+c"], snapshot: "snap-2", app: "TextEdit" }),
    /snapshot-pinned/u,
  );

  assert.deepEqual(
    normalizePeekabooArguments("type", {
      on: "T2",
      snapshot: "snap-2",
      text: "hello",
    }),
    { on: "T2", snapshot: "snap-2", text: "hello" },
  );
  assert.deepEqual(
    normalizePeekabooArguments("type", {
      snapshot: "snap-2",
      text: "hello",
    }),
    { snapshot: "snap-2", text: "hello" },
  );
  assert.deepEqual(
    normalizePeekabooArguments("hotkey", {
      keys: "cmd,c",
      app: "TextEdit",
    }),
    { keys: "cmd,c", app: "TextEdit" },
  );
  assert.deepEqual(
    normalizePeekabooArguments("press", {
      keys: ["cmd+c"],
      snapshot: "snap-2",
    }),
    { keys: ["cmd+c"], snapshot: "snap-2" },
  );
});

test("mass quit, force quit and broad menu or Dock actions are blocked", () => {
  assert.throws(
    () => normalizePeekabooArguments("app", { action: "quit", all: true }),
    /topluca kapatma/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("app", { action: "quit", name: "Finder", force: true }),
    /Force quit/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("menu", { action: "list-all" }),
    /sistem menü-extra/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("dock", { action: "right-click", app: "Finder" }),
    /Dock context-menu/u,
  );
});

test("see cannot write arbitrary paths and traversal bounds are capped", () => {
  assert.throws(
    () => normalizePeekabooArguments("see", { path: "/tmp/capture.png" }),
    /see\.path/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("inspect_ui", { max_elements: 5001 }),
    /max_elements/u,
  );

  assert.deepEqual(
    normalizePeekabooArguments("inspect_ui", {
      app_target: "Finder",
      max_depth: 20,
      max_elements: 2000,
    }),
    { app_target: "Finder", max_depth: 20, max_elements: 2000 },
  );
});

test("v3 perform_action and v4 action accept only AX accessibility actions", () => {
  assert.deepEqual(
    normalizePeekabooArguments("perform_action", {
      on: "B7",
      action: "AXPress",
    }),
    { on: "B7", action: "AXPress" },
  );

  assert.throws(
    () => normalizePeekabooArguments("perform_action", {
      on: "B7",
      action: "press",
    }),
    /yalnız AX/u,
  );

  assert.deepEqual(
    normalizePeekabooArguments("action", {
      on: "B7",
      action: "AXPress",
    }),
    { on: "B7", action: "AXPress" },
  );
  assert.throws(
    () => normalizePeekabooArguments("action", { on: "B7", action: "press" }),
    /yalnız AX/u,
  );
});

test("blocked Peekaboo tool names never reach the downstream server", () => {
  for (const name of ["agent", "analyze", "browser", "clipboard", "dialog", "paste", "image", "capture", "swipe"]) {
    assert.throws(
      () => normalizePeekabooArguments(name, {}),
      /allowlist/u,
    );
  }
});

function makeCompatibleToolCatalog(major = 3) {
  const names = major === 4
    ? __test.PEEKABOO_V4_REQUIRED_TOOLS
    : __test.PEEKABOO_V3_REQUIRED_TOOLS;
  return names.map((name) => {
    const shape = __test.REQUIRED_TOOL_SHAPES[name];
    const properties = Object.fromEntries(
      shape.properties.map((property) => [property, {}]),
    );
    if (shape.actionValues) {
      properties.action = { enum: [...shape.actionValues] };
    }
    return {
      name,
      inputSchema: {
        type: "object",
        properties,
      },
    };
  });
}

test("Peekaboo compatibility gate catches old versions and schema drift", () => {
  const tools = makeCompatibleToolCatalog();
  const current = inspectPeekabooCompatibility(tools, "Peekaboo 3.9.9");
  assert.equal(current.ok, true);
  assert.deepEqual(current.errors, []);

  const v4 = inspectPeekabooCompatibility(makeCompatibleToolCatalog(4), "Peekaboo 4.0.0");
  assert.equal(v4.ok, true);
  assert.equal(v4.contract, "v4");
  assert.deepEqual(v4.errors, []);

  const old = inspectPeekabooCompatibility(tools, "Peekaboo 3.9.8");
  assert.equal(old.ok, false);
  assert.match(old.errors.join("\n"), /3\.9\.9/u);

  const drifted = structuredClone(tools);
  delete drifted.find((tool) => tool.name === "click").inputSchema.properties.on;
  const drift = inspectPeekabooCompatibility(drifted, "Peekaboo 3.9.9");
  assert.equal(drift.ok, false);
  assert.match(drift.errors.join("\n"), /click.*'on'/u);

  const wrongV4Surface = inspectPeekabooCompatibility(tools, "Peekaboo 4.0.0");
  assert.equal(wrongV4Surface.ok, false);
  assert.match(wrongV4Surface.errors.join("\n"), /press/u);
  assert.match(wrongV4Surface.errors.join("\n"), /action/u);

  const future = inspectPeekabooCompatibility(makeCompatibleToolCatalog(4), "Peekaboo 5.0.0");
  assert.equal(future.ok, false);
  assert.match(future.errors.join("\n"), /major version 5/u);
});

test("Peekaboo permission parser and preflight distinguish granted permissions", () => {
  assert.deepEqual(
    parsePeekabooPermissions(
      "Screen Recording: [ok] Granted\nAccessibility: [warn] Not Granted",
    ),
    { screenRecording: true, accessibility: false },
  );
  assert.deepEqual(
    parsePeekabooPermissions(
      "Screen Recording (Required): [ok] Granted\nAccessibility (Required): [ok] Granted\nEvent Synthesizing (Action-specific): [ok] Granted",
    ),
    { screenRecording: true, accessibility: true },
  );

  assert.doesNotThrow(() =>
    __test.assertPermissionState("see", {
      screenRecording: true,
      accessibility: true,
    }),
  );
  assert.throws(
    () =>
      __test.assertPermissionState("click", {
        screenRecording: true,
        accessibility: false,
      }),
    /Accessibility izni gerekli/u,
  );
});

test("Control Center readiness trusts verified compatibility and permissions over optional status noise", () => {
  const readyStatus = {
    active: true,
    compatibility: { ok: true },
    permissionState: { screenRecording: true, accessibility: true },
    error: "server_status",
  };
  assert.equal(isPeekabooStatusReady(readyStatus), true);
  assert.equal(isPeekabooStatusReady({ ...readyStatus, permissionState: { screenRecording: true, accessibility: false } }), false);
  assert.equal(isPeekabooStatusReady({ ...readyStatus, compatibility: { ok: false } }), false);
  assert.equal(isPeekabooStatusReady({ ...readyStatus, active: false }), false);
  assert.equal(isPeekabooStatusReady({
    active: true,
    compatibility: { ok: true },
    permissions: "Screen Recording: [ok] Granted\nAccessibility: [ok] Granted",
  }), true);
});

test("Control Center passive readiness never treats unknown permissions as an attention state", () => {
  const passiveStatus = {
    active: true,
    compatibility: { ok: true },
    permissionState: null,
    permissions: null,
  };
  assert.equal(isPeekabooControlCenterReady(passiveStatus), true);
  assert.equal(isPeekabooControlCenterReady({
    ...passiveStatus,
    permissionState: { screenRecording: true, accessibility: false },
  }), false);
  assert.equal(isPeekabooControlCenterReady({ ...passiveStatus, compatibility: { ok: false } }), false);
  assert.equal(isPeekabooControlCenterReady({ ...passiveStatus, active: false }), false);
});

test("destructive desktop shortcuts and protected system processes are blocked", () => {
  assert.throws(
    () => normalizePeekabooArguments("hotkey", { keys: "cmd,delete", app: "Finder" }),
    /Silme, Force Quit/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("hotkey", { keys: "ctrl,cmd,q", app: "Finder" }),
    /oturum kilitleme/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("press", { keys: ["cmd+delete"], snapshot: "snap-safe" }),
    /press chord/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("press", { key: "q", modifiers: ["ctrl", "cmd"], snapshot: "snap-safe" }),
    /press chord/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("menu", { action: "click", app: "Finder", path: "Finder > Empty Bin" }),
    /Silme, sistem oturumu/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("click", { query: "Shut Down" }),
    /güç yönetimi/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("app", { action: "quit", name: "SystemUIServer" }),
    /Korunan macOS uygulaması/u,
  );
  assert.throws(
    () => normalizePeekabooArguments("window", { action: "close", app: "Dock" }),
    /Korunan macOS uygulaması/u,
  );
});

test("transport errors and oversized downstream results are guarded", () => {
  assert.equal(__test.isPeekabooTransportError(new Error("Connection closed")), true);
  assert.equal(__test.isPeekabooTransportError(new Error("button not found")), false);

  assert.throws(
    () =>
      __test.guardPeekabooResult({
        content: [{ type: "text", text: "x".repeat(__test.MAX_RESULT_BYTES + 1) }],
      }),
    /2 MB/u,
  );
});
