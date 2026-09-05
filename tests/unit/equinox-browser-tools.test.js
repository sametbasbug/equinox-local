import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as z from "zod/v4";
import { PNG } from "pngjs";

import { inspectBrowserDownloadFile, registerEquinoxBrowserTools } from "../../src/equinox-browser-tools.js";

function makeHarness() {
  const tools = new Map();
  const calls = [];
  const capabilityVersions = {
    snapshot: 3,
    deltaSnapshot: 1,
    screenshot: 3,
    reacquire: 1,
    compoundAction: 2,
    doubleClick: 1,
    pointerDrag: 1,
    html5Drag: 1,
    wait: 2,
    navigation: 1,
    emulation: 1,
    input: 1,
    actionability: 1,
    click: 2,
    observation: 2,
    touchGesture: 1,
    bookmarks: 2,
  };
  const bridge = {
    snapshot: () => ({
      active: true,
      ready: true,
      extension: { extensionVersion: "0.1.0", capabilityVersions },
      contexts: {
        agent: { ready: true, extension: { extensionVersion: "0.1.0", capabilityVersions } },
        user: { ready: true, extension: { extensionVersion: "0.1.0", capabilityVersions } },
      },
    }),
    call: async (method, args, options) => {
      calls.push({ method, args, options });
      if (method === "status") return { extensionVersion: "0.1.0" };
      if (method === "observe.start" || method === "console.read" || method === "network.read") {
        return { observationVersion: 2, method, args };
      }
      if (method.startsWith("bookmarks.")) {
        return { bookmarksVersion: 2, method, args };
      }
      if (method === "wait" && args?.networkResponse) return { waitVersion: 2, observationVersion: 2, matched: "network_response" };
      return { method, args };
    },
  };

  const register = (name, config, handler) => {
    tools.set(name, { config, handler });
  };

  return {
    tools,
    calls,
    bridge,
    deps: {
      registerTextTool: register,
      registerRawTool: register,
      z,
      fileRootSchema: z.enum(["local", "downloads"]),
      resolveUploadFile: async (root, relativePath) => ({
        root,
        relativePath,
        absolutePath: `/allowed/${root}/${relativePath}`,
      }),
      downloadsRoot: path.join(os.tmpdir(), "equinox-browser-tools-tests", "downloads"),
      screenshotRoot: path.join(os.tmpdir(), "equinox-browser-tools-tests", "browser-screenshots"),
      screenshotProjectId: "workspace",
      bridge,
      ensureAgentBrowserReady: async () => ({ ready: true }),
      getAgentBrowserStatus: () => ({ supported: true, pairing: false, lastLaunchError: null }),
      withMutationLocks: async (_scopes, task) => await task(),
      textResult: (text) => ({ content: [{ type: "text", text }] }),
      errorResult: (error) => ({ isError: true, content: [{ type: "text", text: error?.message || String(error) }] }),
    },
  };
}

function parseTextResult(result) {
  return JSON.parse(result.content[0].text);
}

test("registers the first-party Equinox Browser primitive surface", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);

  assert.deepEqual([...harness.tools.keys()], [
    "equinox_browser_status",
    "equinox_browser_reload_extension",
    "equinox_browser_tabs",
    "equinox_browser_activate",
    "equinox_browser_open",
    "equinox_browser_navigate",
    "equinox_browser_reload",
    "equinox_browser_emulate",
    "equinox_browser_clear_emulation",
    "equinox_browser_new_tab",
    "equinox_browser_back",
    "equinox_browser_forward",
    "equinox_browser_snapshot",
    "equinox_browser_screenshot",
    "equinox_browser_screenshot_delete",
    "equinox_browser_find",
    "equinox_browser_reacquire",
    "equinox_browser_click",
    "equinox_browser_tap",
    "equinox_browser_swipe",
    "equinox_browser_double_click",
    "equinox_browser_drag",
    "equinox_browser_hover",
    "equinox_browser_scroll_into_view",
    "equinox_browser_ref_info",
    "equinox_browser_scroll",
    "equinox_browser_select",
    "equinox_browser_check",
    "equinox_browser_wait",
    "equinox_browser_fill",
    "equinox_browser_press",
    "equinox_browser_type_text",
    "equinox_browser_eval",
    "equinox_browser_observe_start",
    "equinox_browser_observe_stop",
    "equinox_browser_console",
    "equinox_browser_network",
    "equinox_browser_bookmarks_list",
    "equinox_browser_bookmarks_search",
    "equinox_browser_bookmark_add",
    "equinox_browser_bookmark_folder_create",
    "equinox_browser_bookmark_update_move",
    "equinox_browser_bookmark_remove",
    "equinox_browser_dialog",
    "equinox_browser_close",
    "equinox_browser_upload_file",
    "equinox_browser_download_wait",
    "equinox_browser_disconnect",
  ]);
});

test("browser status returns the local snapshot without probing a disconnected extension", async () => {
  const harness = makeHarness();
  harness.bridge.snapshot = () => ({ active: true, ready: false });
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_status").handler({});
  assert.deepEqual(parseTextResult(result), {
    accessEnabled: true,
    defaultTarget: "agent",
    agentBrowser: {
      state: "idle",
      ready: false,
      launchable: true,
      autoLaunchOnUse: true,
      supported: true,
      pairing: false,
      lastLaunchError: null,
    },
    local: { active: true, ready: false },
    remote: null,
    contexts: {
      agent: { local: null, remote: null },
      user: { local: null, remote: null },
    },
  });
  assert.deepEqual(harness.calls, []);
});

test("agent browser access can disable automation while keeping status readable", async () => {
  const harness = makeHarness();
  harness.bridge.snapshot = () => ({ active: true, ready: true });
  harness.deps.isBrowserAccessEnabled = () => false;
  await registerEquinoxBrowserTools(harness.deps);

  const status = await harness.tools.get("equinox_browser_status").handler({});
  assert.deepEqual(parseTextResult(status), {
    accessEnabled: false,
    defaultTarget: "agent",
    agentBrowser: {
      state: "idle",
      ready: false,
      launchable: false,
      autoLaunchOnUse: false,
      supported: true,
      pairing: false,
      lastLaunchError: null,
    },
    local: { active: true, ready: true },
    remote: null,
    contexts: {
      agent: { local: null, remote: null },
      user: { local: null, remote: null },
    },
  });
  assert.deepEqual(harness.calls, []);

  const tabs = await harness.tools.get("equinox_browser_tabs").handler({});
  assert.equal(tabs.isError, true);
  assert.match(tabs.content[0].text, /disabled in Control Center/u);
  assert.deepEqual(harness.calls, []);
});

test("extension reload maps to the first-party self.reload command", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);

  await harness.tools.get("equinox_browser_reload_extension").handler({});
  assert.deepEqual(harness.calls.at(-1), {
    method: "self.reload",
    args: {},
    options: { timeoutMs: 5_000, context: "agent" },
  });
});

test("browser operations default to Agent Browser and can explicitly target User Browser", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);

  const openTool = harness.tools.get("equinox_browser_open");
  const defaultTarget = openTool.config.inputSchema.target._def.defaultValue;
  assert.equal(typeof defaultTarget === "function" ? defaultTarget() : defaultTarget, "agent");

  await openTool.handler({ url: "https://example.com/agent" });
  assert.equal(harness.calls.at(-1)?.options?.context, "agent");

  await openTool.handler({ target: "user", url: "https://example.com/user" });
  assert.equal(harness.calls.at(-1)?.options?.context, "user");
});

test("open maps tab_id to first-party bridge tabId without creating a second abstraction", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_open").handler({
    url: "https://example.com/",
    tab_id: 77,
  });

  assert.deepEqual(parseTextResult(result), {
    method: "open",
    args: { tabId: 77, url: "https://example.com/" },
  });
  assert.deepEqual(harness.calls.at(-1), {
    method: "open",
    args: { tabId: 77, url: "https://example.com/" },
    options: { context: "agent" },
  });
});

test("new tab creates a distinct tab and defaults to active Chrome New Tab", async () => {
  const harness = makeHarness();
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "tabs.create") {
      return { id: 91, windowId: 7, url: args.url, active: args.active };
    }
    return { method, args };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_new_tab").handler({});
  assert.deepEqual(parseTextResult(result), {
    tabId: 91,
    windowId: 7,
    url: "chrome://newtab/",
    active: true,
  });
  assert.deepEqual(harness.calls.at(-1), {
    method: "tabs.create",
    args: { url: "chrome://newtab/", active: true },
    options: { context: "agent" },
  });

  await harness.tools.get("equinox_browser_new_tab").handler({
    target: "user",
    url: "https://example.com/",
    active: false,
  });
  assert.deepEqual(harness.calls.at(-1), {
    method: "tabs.create",
    args: { url: "https://example.com/", active: false },
    options: { context: "user" },
  });
});

test("back and forward map to bounded history commands", async () => {
  const harness = makeHarness();
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "history.back") return { id: 77, windowId: 7, direction: "back" };
    if (method === "history.forward") return { id: 88, windowId: 7, direction: "forward" };
    return { method, args };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const back = await harness.tools.get("equinox_browser_back").handler({ tab_id: 77 });
  assert.deepEqual(parseTextResult(back), { tabId: 77, windowId: 7, direction: "back" });
  assert.deepEqual(harness.calls.at(-1), {
    method: "history.back",
    args: { tabId: 77 },
    options: { context: "agent" },
  });

  const forward = await harness.tools.get("equinox_browser_forward").handler({ target: "user", tab_id: 88 });
  assert.deepEqual(parseTextResult(forward), { tabId: 88, windowId: 7, direction: "forward" });
  assert.deepEqual(harness.calls.at(-1), {
    method: "history.forward",
    args: { tabId: 88 },
    options: { context: "user" },
  });
});

test("snapshot preserves @ref workflow arguments", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);

  await harness.tools.get("equinox_browser_snapshot").handler({
    tab_id: 42,
    include_readable: false,
  });
  assert.deepEqual(harness.calls.at(-1), {
    method: "snapshot",
    args: { tabId: 42, includeReadable: false, output: "compact" },
    options: { context: "agent" },
  });

  await harness.tools.get("equinox_browser_click").handler({ ref: "@e3", tab_id: 42 });
  assert.deepEqual(harness.calls.at(-1), {
    method: "click",
    args: { tabId: 42, ref: "@e3" },
    options: { context: "agent" },
  });
});

test("snapshot v2 maps pruning options and rejects silent downgrade on an old extension", async () => {
  const harness = makeHarness();
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "snapshot") {
      return {
        snapshotVersion: 2,
        deltaVersion: 1,
        snapshot: { id: "42:1:1" },
        elements: [{ ref: "@e1", role: "button", name: "Settings" }],
        text: '@e1 button "Settings"',
        refCount: 1,
        elementCount: 1,
      };
    }
    return { method, args };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_snapshot").handler({
    tab_id: 42,
    include_readable: true,
    mode: "interactive",
    scope: "viewport",
    max_nodes: 40,
    root_ref: "@e3",
    roles: ["button", "link"],
    query: "settings",
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "snapshot",
    args: {
      tabId: 42,
      includeReadable: true,
      mode: "interactive",
      scope: "viewport",
      maxNodes: 40,
      rootRef: "@e3",
      roles: ["button", "link"],
      query: "settings",
      output: "compact",
    },
    options: { context: "agent" },
  });
  const compact = parseTextResult(result);
  assert.equal(compact.outputMode, "compact");
  assert.equal(compact.outputProjectedLocally, true);
  assert.equal(compact.text, '@e1 button "Settings"');
  assert.equal(Object.hasOwn(compact, "elements"), false);

  const oldExtension = makeHarness();
  await registerEquinoxBrowserTools(oldExtension.deps);
  const downgraded = await oldExtension.tools.get("equinox_browser_snapshot").handler({ mode: "interactive" });
  assert.equal(downgraded.isError, true);
  assert.match(downgraded.content[0].text, /Snapshot v2/u);
});

test("navigate and reload expose version-gated observation-preserving navigation", async () => {
  const harness = makeHarness();
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "navigate") return { navigationVersion: 1, id: 41, windowId: 7, url: args.url };
    if (method === "reload") return { navigationVersion: 1, id: 41, windowId: 7, reloaded: true, ignoreCache: args.ignoreCache };
    return { method, args };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const navigated = await harness.tools.get("equinox_browser_navigate").handler({
    target: "user",
    tab_id: 41,
    url: "https://example.com/next",
    ignore_cache: true,
  });
  assert.deepEqual(parseTextResult(navigated), {
    navigationVersion: 1,
    tabId: 41,
    windowId: 7,
    url: "https://example.com/next",
  });
  assert.deepEqual(harness.calls.at(-1), {
    method: "navigate",
    args: { tabId: 41, url: "https://example.com/next", ignoreCache: true },
    options: { context: "user" },
  });

  const reloaded = await harness.tools.get("equinox_browser_reload").handler({ tab_id: 41, ignore_cache: true });
  assert.equal(parseTextResult(reloaded).reloaded, true);
  assert.deepEqual(harness.calls.at(-1), {
    method: "reload",
    args: { tabId: 41, ignoreCache: true },
    options: { context: "agent" },
  });

  const oldExtension = makeHarness();
  await registerEquinoxBrowserTools(oldExtension.deps);
  const oldReload = await oldExtension.tools.get("equinox_browser_reload").handler({});
  assert.equal(oldReload.isError, true);
  assert.match(oldReload.content[0].text, /güncel sürümü/u);
});

test("device emulation tools expose bounded version-gated extension capabilities", async () => {
  const harness = makeHarness();
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "emulate") {
      return {
        emulationVersion: 1,
        tabId: args.tabId,
        width: args.width,
        height: args.height,
        deviceScaleFactor: args.deviceScaleFactor,
        mobile: args.mobile,
        touch: args.touch || args.mobile,
      };
    }
    if (method === "emulation.clear") return { emulationVersion: 1, tabId: args.tabId, cleared: true };
    return { method, args };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const emulated = await harness.tools.get("equinox_browser_emulate").handler({
    target: "user",
    tab_id: 41,
    width: 390,
    height: 844,
    device_scale_factor: 3,
    mobile: true,
    touch: false,
  });
  assert.equal(emulated.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "emulate",
    args: {
      tabId: 41,
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      touch: false,
    },
    options: { context: "user" },
  });
  assert.equal(parseTextResult(emulated).touch, true);

  const cleared = await harness.tools.get("equinox_browser_clear_emulation").handler({ tab_id: 41 });
  assert.equal(cleared.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "emulation.clear",
    args: { tabId: 41 },
    options: { context: "agent" },
  });

  const oldExtension = makeHarness();
  oldExtension.bridge.snapshot = () => ({
    active: true,
    ready: true,
    contexts: {
      agent: { ready: true, extension: { extensionVersion: "0.1.0", capabilityVersions: {} } },
      user: { ready: true, extension: { extensionVersion: "0.1.0", capabilityVersions: {} } },
    },
  });
  await registerEquinoxBrowserTools(oldExtension.deps);
  const rejected = await oldExtension.tools.get("equinox_browser_emulate").handler({ width: 390, height: 844 });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Device\/mobile emulation/u);
  assert.equal(oldExtension.calls.length, 0);
});

test("touch gesture tools expose semantic tap and bounded swipe without coordinates", async () => {
  const harness = makeHarness();
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "tap") return { touchGestureVersion: 1, tabId: args.tabId, ref: args.ref, gesture: "tap" };
    if (method === "swipe") {
      return {
        touchGestureVersion: 1,
        tabId: args.tabId,
        gesture: "swipe",
        direction: args.direction,
        requestedDistance: args.distance,
        ref: args.ref || null,
      };
    }
    return { method, args };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const tapped = await harness.tools.get("equinox_browser_tap").handler({ target: "user", tab_id: 41, ref: "@e7" });
  assert.equal(tapped.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "tap",
    args: { tabId: 41, ref: "@e7" },
    options: { context: "user" },
  });

  const swiped = await harness.tools.get("equinox_browser_swipe").handler({
    tab_id: 41,
    direction: "up",
    distance_px: 320,
    ref: "@e9",
  });
  assert.equal(swiped.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "swipe",
    args: { tabId: 41, direction: "up", distance: 320, ref: "@e9" },
    options: { context: "agent" },
  });

  const oldExtension = makeHarness();
  oldExtension.bridge.snapshot = () => ({
    active: true,
    ready: true,
    contexts: {
      agent: { ready: true, extension: { extensionVersion: "0.1.0", capabilityVersions: {} } },
      user: { ready: true, extension: { extensionVersion: "0.1.0", capabilityVersions: {} } },
    },
  });
  await registerEquinoxBrowserTools(oldExtension.deps);
  const rejected = await oldExtension.tools.get("equinox_browser_tap").handler({ ref: "@e1" });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Touch tap/u);
  assert.equal(oldExtension.calls.length, 0);
});

test("safe reacquire maps source metadata and rejects silent downgrade", async () => {
  const harness = makeHarness();
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "reacquire") {
      return {
        reacquireVersion: 1,
        status: "reacquired",
        oldRef: "@e2",
        newRef: "@e7",
        unique: true,
      };
    }
    return { method, args };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_reacquire").handler({
    old_ref: "@e2",
    from_snapshot_id: "42:1:1",
    tab_id: 42,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "reacquire",
    args: { tabId: 42, oldRef: "@e2", fromSnapshotId: "42:1:1" },
    options: { context: "agent" },
  });

  const oldExtension = makeHarness();
  await registerEquinoxBrowserTools(oldExtension.deps);
  const downgraded = await oldExtension.tools.get("equinox_browser_reacquire").handler({ old_ref: "@e2" });
  assert.equal(downgraded.isError, true);
  assert.match(downgraded.content[0].text, /Safe ref reacquire/u);
});

test("screenshot saves a validated PNG without exposing base64 in the tool result", async () => {
  const harness = makeHarness();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-browser-screenshot-"));
  const fixture = new PNG({ width: 1, height: 1 });
  fixture.data.set([255, 255, 255, 255]);
  const pngBase64 = PNG.sync.write(fixture).toString("base64");
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "screenshot") {
      return { tab: { id: 44 }, fullPage: true, width: 1, height: 1, mimeType: "image/png", data: pngBase64 };
    }
    return { method, args };
  };
  harness.deps.screenshotRoot = path.join(root, "browser-screenshots");
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_screenshot").handler({
    name: "smoke",
    collection: "browser",
    full_page: true,
    tab_id: 44,
  });
  assert.equal(result.isError, undefined);
  const parsed = parseTextResult(result);
  assert.match(parsed.path, /^browser-screenshots\/capture-\d{13}-[0-9a-f-]{36}\/browser\/smoke\.png$/u);
  assert.equal(parsed.storage, "ephemeral");
  assert.equal(parsed.retentionMinutes, 60);
  assert.equal(parsed.width, 1);
  assert.equal(parsed.height, 1);
  assert.equal(Object.hasOwn(parsed, "data"), false);
  assert.equal((await fs.readFile(path.join(root, parsed.path))).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  await fs.rm(root, { recursive: true, force: true });
});

test("annotated screenshot maps annotate_refs and rejects silent extension downgrade", async () => {
  const harness = makeHarness();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-browser-annotated-screenshot-"));
  const fixture = new PNG({ width: 1, height: 1 });
  fixture.data.set([255, 255, 255, 255]);
  const pngBase64 = PNG.sync.write(fixture).toString("base64");
  harness.deps.screenshotRoot = path.join(root, "browser-screenshots");
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "screenshot") {
      return {
        screenshotVersion: 3,
        tab: { id: 44 },
        annotations: { requested: true, annotatedRefs: ["@e1"], skippedOopifRefs: [], truncated: false },
        mimeType: "image/png",
        data: pngBase64,
      };
    }
    return { method, args };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_screenshot").handler({
    name: "annotated",
    collection: "browser",
    annotate_refs: true,
    tab_id: 44,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(harness.calls.find((item) => item.method === "screenshot"), {
    method: "screenshot",
    args: { tabId: 44, fullPage: false, annotateRefs: true },
    options: { context: "agent", timeoutMs: 45_000 },
  });
  assert.equal(parseTextResult(result).annotations.requested, true);
  await fs.rm(root, { recursive: true, force: true });

  const oldExtension = makeHarness();
  await registerEquinoxBrowserTools(oldExtension.deps);
  const downgraded = await oldExtension.tools.get("equinox_browser_screenshot").handler({
    name: "annotated-old",
    collection: "browser",
    annotate_refs: true,
  });
  assert.equal(downgraded.isError, true);
  assert.match(downgraded.content[0].text, /annotate_refs screenshot/u);
});

test("dedicated screenshot delete safely removes artifacts larger than the generic 10 MB file limit", async () => {
  const harness = makeHarness();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-browser-screenshot-delete-"));
  harness.deps.screenshotRoot = path.join(root, "browser-screenshots");
  const captureId = `capture-${Date.now()}-11111111-1111-1111-1111-111111111111`;
  const relativePath = path.join("browser-screenshots", captureId, "browser", "large.png");
  const absolutePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  const payload = Buffer.alloc(11 * 1024 * 1024, 7);
  await fs.writeFile(absolutePath, payload);
  const expected = createHash("sha256").update(payload).digest("hex");
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_screenshot_delete").handler({
    path: relativePath,
    expected_sha256: expected,
  });
  assert.equal(result.isError, undefined);
  assert.equal(parseTextResult(result).bytes, payload.length);
  await assert.rejects(fs.access(absolutePath));
  await assert.rejects(fs.access(path.join(harness.deps.screenshotRoot, captureId)));
  await fs.rm(root, { recursive: true, force: true });
});

test("screenshot storage prunes old capture directories and stays bounded by capture count", async () => {
  const harness = makeHarness();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-browser-screenshot-quota-"));
  const screenshotRoot = path.join(root, "browser-screenshots");
  harness.deps.screenshotRoot = screenshotRoot;
  await fs.mkdir(screenshotRoot, { recursive: true });
  const oldMs = Date.now() - 2 * 60 * 60 * 1000;
  for (let index = 0; index < 25; index += 1) {
    const captureId = `capture-${String(Date.now() - (index + 1) * 1000).padStart(13, "0")}-${String(index).padStart(8, "0")}-1111-1111-1111-111111111111`;
    const target = path.join(screenshotRoot, captureId, "browser");
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "tiny.png"), "x", { flag: "wx", mode: 0o600 });
  }
  const oldCapture = `capture-${String(oldMs).padStart(13, "0")}-aaaaaaaa-1111-1111-1111-111111111111`;
  const oldTarget = path.join(screenshotRoot, oldCapture, "browser");
  await fs.mkdir(oldTarget, { recursive: true });
  await fs.writeFile(path.join(oldTarget, "old.png"), "x", { flag: "wx", mode: 0o600 });
  const oldDate = new Date(oldMs);
  await fs.utimes(path.join(oldTarget, "old.png"), oldDate, oldDate);
  await fs.utimes(oldTarget, oldDate, oldDate);
  await fs.utimes(path.join(screenshotRoot, oldCapture), oldDate, oldDate);
  const fixture = new PNG({ width: 1, height: 1 });
  fixture.data.set([0, 0, 0, 255]);
  const pngBase64 = PNG.sync.write(fixture).toString("base64");
  harness.bridge.call = async () => ({ tab: { id: 1 }, fullPage: false, mimeType: "image/png", data: pngBase64 });
  await registerEquinoxBrowserTools(harness.deps);
  const result = await harness.tools.get("equinox_browser_screenshot").handler({ name: "new", collection: "browser", full_page: false });
  assert.equal(result.isError, undefined);
  const captures = (await fs.readdir(screenshotRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.equal(captures.length <= 24, true);
  assert.equal(captures.some((entry) => entry.name === oldCapture), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("advanced interaction primitives map to first-party bridge methods", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);

  await harness.tools.get("equinox_browser_activate").handler({ tab_id: 12 });
  assert.deepEqual(harness.calls.at(-1), { method: "tabs.activate", args: { tabId: 12 }, options: { context: "agent" } });

  await harness.tools.get("equinox_browser_hover").handler({ ref: "@e4", tab_id: 12 });
  assert.deepEqual(harness.calls.at(-1), { method: "hover", args: { tabId: 12, ref: "@e4" }, options: { context: "agent" } });

  await harness.tools.get("equinox_browser_scroll").handler({ direction: "down", pixels: 900, ref: "@e5", tab_id: 12 });
  assert.deepEqual(harness.calls.at(-1), { method: "scroll", args: { tabId: 12, direction: "down", pixels: 900, ref: "@e5" }, options: { context: "agent" } });

  await harness.tools.get("equinox_browser_select").handler({ ref: "@e6", option: "Beta", tab_id: 12 });
  assert.deepEqual(harness.calls.at(-1), { method: "select", args: { tabId: 12, ref: "@e6", option: "Beta" }, options: { context: "agent" } });

  await harness.tools.get("equinox_browser_check").handler({ ref: "@e7", checked: false, tab_id: 12 });
  assert.deepEqual(harness.calls.at(-1), { method: "check", args: { tabId: 12, ref: "@e7", checked: false }, options: { context: "agent" } });

  await harness.tools.get("equinox_browser_wait").handler({ text: "Ready", timeout_ms: 2_000, tab_id: 12 });
  assert.deepEqual(harness.calls.at(-1), {
    method: "wait",
    args: { tabId: 12, milliseconds: undefined, text: "Ready", urlContains: undefined, timeoutMs: 2_000 },
    options: { timeoutMs: 7_000, context: "agent" },
  });
});

test("rich input, actionability and generalized after map to versioned bridge contracts", async () => {
  const harness = makeHarness();
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "click") return { clickVersion: 2, compoundActionVersion: 2 };
    if (method === "hover" || method === "scroll_into_view" || method === "ref_info") {
      return { actionabilityVersion: 1, ref: args.ref };
    }
    if (method === "press" || method === "type_text") {
      return { inputVersion: 1, compoundActionVersion: 2, ref: args.ref || null };
    }
    if (["fill", "select", "check", "drag"].includes(method)) {
      return {
        compoundActionVersion: 2,
        ...(method === "drag" ? { pointerDragVersion: 1 } : {}),
      };
    }
    return { method, args };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const richClick = await harness.tools.get("equinox_browser_click").handler({
    ref: "@e4",
    button: "right",
    modifiers: ["meta", "shift"],
    delay_ms: 40,
  });
  assert.equal(richClick.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "click",
    args: { tabId: undefined, ref: "@e4", button: "right", modifiers: ["meta", "shift"], delayMs: 40 },
    options: { context: "agent" },
  });

  const scrolled = await harness.tools.get("equinox_browser_scroll_into_view").handler({ ref: "@e4", tab_id: 12 });
  assert.equal(scrolled.isError, undefined);
  assert.equal(harness.calls.at(-1).method, "scroll_into_view");

  const info = await harness.tools.get("equinox_browser_ref_info").handler({ ref: "@e4", tab_id: 12 });
  assert.equal(info.isError, undefined);
  assert.equal(harness.calls.at(-1).method, "ref_info");

  const pressed = await harness.tools.get("equinox_browser_press").handler({
    ref: "@e5",
    key: "Enter",
    after: { snapshot: "full" },
  });
  assert.equal(pressed.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "press",
    args: {
      tabId: undefined,
      key: "Enter",
      ref: "@e5",
      after: { snapshot: "full", quietMs: 500, timeoutMs: 10_000 },
    },
    options: { context: "agent" },
  });

  const typed = await harness.tools.get("equinox_browser_type_text").handler({
    target: "user",
    ref: "@e5",
    text: "Hello",
    delay_ms: 25,
  });
  assert.equal(typed.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "type_text",
    args: { tabId: undefined, ref: "@e5", text: "Hello", delayMs: 25 },
    options: { context: "user" },
  });

  const filled = await harness.tools.get("equinox_browser_fill").handler({
    ref: "@e5",
    value: "x",
    after: { wait_for: "dom_stable" },
  });
  assert.equal(filled.isError, undefined);
  assert.equal(harness.calls.at(-1).args.after.waitFor, "dom_stable");

  const dragged = await harness.tools.get("equinox_browser_drag").handler({
    source_ref: "@e1",
    target_ref: "@e2",
    after: { snapshot: "delta" },
  });
  assert.equal(dragged.isError, undefined);
  assert.equal(harness.calls.at(-1).args.after.snapshot, "delta");
});

test("wait rejects ambiguous conditions before reaching the extension", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);
  const result = await harness.tools.get("equinox_browser_wait").handler({
    milliseconds: 100,
    text: "Ready",
    timeout_ms: 1_000,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /tam olarak biri/);
  assert.equal(harness.calls.length, 0);
});

test("controlled click after maps one bounded post-action chain and rejects silent downgrade", async () => {
  const harness = makeHarness();
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "click") {
      return { compoundActionVersion: 1, after: { ok: true } };
    }
    return { method, args };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_click").handler({
    ref: "@e4",
    tab_id: 12,
    after: {
      wait_for: "dom_stable",
      snapshot: "delta",
      quiet_ms: 250,
      timeout_ms: 2_000,
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "click",
    args: {
      tabId: 12,
      ref: "@e4",
      after: {
        waitFor: "dom_stable",
        snapshot: "delta",
        quietMs: 250,
        timeoutMs: 2_000,
      },
    },
    options: { context: "agent" },
  });

  const oldExtension = makeHarness();
  await registerEquinoxBrowserTools(oldExtension.deps);
  const downgraded = await oldExtension.tools.get("equinox_browser_click").handler({
    ref: "@e4",
    after: { snapshot: "full" },
  });
  assert.equal(downgraded.isError, true);
  assert.match(downgraded.content[0].text, /Controlled click after/u);
});

test("double click plus pointer/HTML5 semantic drag map bounded ref actions and reject silent downgrade", async () => {
  const harness = makeHarness();
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "double_click") return { doubleClickVersion: 1, clickCount: 2, after: { ok: true } };
    if (method === "drag") {
      if (args.mode === "html5") return { html5DragVersion: 1, mode: "html5", dropDispatched: true };
      return { pointerDragVersion: 1, mode: "pointer", actionDispatched: true };
    }
    return { method, args };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const doubleClicked = await harness.tools.get("equinox_browser_double_click").handler({
    ref: "@e4",
    tab_id: 12,
    after: { snapshot: "full", quiet_ms: 300, timeout_ms: 2_000 },
  });
  assert.equal(doubleClicked.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "double_click",
    args: {
      tabId: 12,
      ref: "@e4",
      after: { snapshot: "full", quietMs: 300, timeoutMs: 2_000 },
    },
    options: { context: "agent" },
  });

  const dragged = await harness.tools.get("equinox_browser_drag").handler({
    target: "user",
    source_ref: "@e4",
    target_ref: "@e8",
    steps: 6,
    duration_ms: 500,
    tab_id: 12,
  });
  assert.equal(dragged.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "drag",
    args: {
      tabId: 12,
      sourceRef: "@e4",
      targetRef: "@e8",
      mode: "pointer",
      steps: 6,
      durationMs: 500,
    },
    options: { context: "user" },
  });

  const html5Dragged = await harness.tools.get("equinox_browser_drag").handler({
    source_ref: "@e4",
    target_ref: "@e8",
    mode: "html5",
    tab_id: 12,
  });
  assert.equal(html5Dragged.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "drag",
    args: {
      tabId: 12,
      sourceRef: "@e4",
      targetRef: "@e8",
      mode: "html5",
      steps: 8,
      durationMs: 350,
    },
    options: { context: "agent" },
  });

  const oldExtension = makeHarness();
  await registerEquinoxBrowserTools(oldExtension.deps);
  const doubleClickDowngrade = await oldExtension.tools.get("equinox_browser_double_click").handler({ ref: "@e4" });
  assert.equal(doubleClickDowngrade.isError, true);
  assert.match(doubleClickDowngrade.content[0].text, /Double click/u);

  const dragDowngrade = await oldExtension.tools.get("equinox_browser_drag").handler({
    source_ref: "@e4",
    target_ref: "@e8",
  });
  assert.equal(dragDowngrade.isError, true);
  assert.match(dragDowngrade.content[0].text, /Semantic pointer drag/u);

  const html5DragDowngrade = await oldExtension.tools.get("equinox_browser_drag").handler({
    source_ref: "@e4",
    target_ref: "@e8",
    mode: "html5",
  });
  assert.equal(html5DragDowngrade.isError, true);
  assert.match(html5DragDowngrade.content[0].text, /Semantic HTML5 drag\/drop/u);
});

test("smart wait maps bounded conditions and rejects silent downgrade", async () => {
  const harness = makeHarness();
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method === "wait") return { waitVersion: 2, matched: "dom_stable" };
    return { method, args };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_wait").handler({
    dom_stable: true,
    quiet_ms: 350,
    timeout_ms: 2_000,
    tab_id: 12,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "wait",
    args: {
      tabId: 12,
      milliseconds: undefined,
      text: undefined,
      urlContains: undefined,
      timeoutMs: 2_000,
      domStable: true,
      quietMs: 350,
    },
    options: { timeoutMs: 7_000, context: "agent" },
  });

  const oldExtension = makeHarness();
  await registerEquinoxBrowserTools(oldExtension.deps);
  const downgraded = await oldExtension.tools.get("equinox_browser_wait").handler({
    ref_visible: "@e4",
    timeout_ms: 500,
  });
  assert.equal(downgraded.isError, true);
  assert.match(downgraded.content[0].text, /Smart Wait/u);
});

test("semantic find and observation v2 tools map stable cursor and bounded filters", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);

  await harness.tools.get("equinox_browser_find").handler({ query: "Sign in", role: "button", exact: true, tab_id: 9 });
  assert.deepEqual(harness.calls.at(-1), {
    method: "find",
    args: { tabId: 9, query: "Sign in", role: "button", exact: true },
    options: { context: "agent" },
  });

  const started = await harness.tools.get("equinox_browser_observe_start").handler({ tab_id: 9 });
  assert.equal(started.isError, undefined);
  assert.deepEqual(harness.calls.at(-1).method, "observe.start");

  const consoleRead = await harness.tools.get("equinox_browser_console").handler({
    tab_id: 9,
    limit: 20,
    clear: false,
    after_cursor: 12,
    level: "error",
    query: "failure",
  });
  assert.equal(consoleRead.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "console.read",
    args: { tabId: 9, limit: 20, clear: false, afterCursor: 12, level: "error", query: "failure" },
    options: { context: "agent" },
  });

  const networkRead = await harness.tools.get("equinox_browser_network").handler({
    tab_id: 9,
    limit: 30,
    clear: false,
    after_cursor: 4,
    url_contains: "/api/",
    method: "POST",
    status: 201,
    resource_type: "xhr",
  });
  assert.equal(networkRead.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "network.read",
    args: {
      tabId: 9,
      limit: 30,
      clear: false,
      afterCursor: 4,
      urlContains: "/api/",
      method: "POST",
      status: 201,
      resourceType: "xhr",
    },
    options: { context: "agent" },
  });

  const networkWait = await harness.tools.get("equinox_browser_wait").handler({
    tab_id: 9,
    network_response: { url_contains: "/api/save", method: "POST", status: 204, resource_type: "xhr" },
    timeout_ms: 2_000,
  });
  assert.equal(networkWait.isError, undefined);
  assert.deepEqual(harness.calls.at(-1).args.networkResponse, {
    urlContains: "/api/save",
    method: "POST",
    status: 204,
    resourceType: "xhr",
  });

  await harness.tools.get("equinox_browser_dialog").handler({ tab_id: 9, action: "accept", prompt_text: "ok" });
  assert.deepEqual(harness.calls.at(-1), {
    method: "dialog",
    args: { tabId: 9, action: "accept", promptText: "ok" },
    options: { context: "agent" },
  });
});

test("observation v2 rejects cursor clearing conflicts and missing capability before bridge calls", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);
  const conflict = await harness.tools.get("equinox_browser_console").handler({
    after_cursor: 2,
    clear: true,
  });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /clear ile after_cursor/u);
  assert.equal(harness.calls.length, 0);

  const oldExtension = makeHarness();
  oldExtension.bridge.snapshot = () => ({
    active: true,
    ready: true,
    contexts: {
      agent: { ready: true, extension: { extensionVersion: "0.1.0", capabilityVersions: { wait: 2 } } },
      user: { ready: true, extension: { extensionVersion: "0.1.0", capabilityVersions: { wait: 2 } } },
    },
  });
  await registerEquinoxBrowserTools(oldExtension.deps);
  const rejected = await oldExtension.tools.get("equinox_browser_network").handler({ limit: 10, clear: false });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /Network observation v2/u);
  assert.equal(oldExtension.calls.length, 0);
});

test("Agent Browser bookmark tools are bounded, version-gated and reject Your Browser before bridge calls", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);

  const listed = await harness.tools.get("equinox_browser_bookmarks_list").handler({ parent_id: "1", limit: 25 });
  assert.equal(listed.isError, undefined);
  assert.deepEqual(harness.calls.at(-1), {
    method: "bookmarks.list",
    args: { parentId: "1", limit: 25 },
    options: { context: "agent" },
  });

  const searched = await harness.tools.get("equinox_browser_bookmarks_search").handler({ query: "docs", limit: 10 });
  assert.equal(searched.isError, undefined);
  assert.equal(harness.calls.at(-1).method, "bookmarks.search");

  const added = await harness.tools.get("equinox_browser_bookmark_add").handler({
    title: "Docs",
    url: "https://example.test/docs",
    parent_id: "1",
    index: 2,
  });
  assert.equal(added.isError, undefined);
  assert.deepEqual(harness.calls.at(-1).args, {
    title: "Docs",
    url: "https://example.test/docs",
    parentId: "1",
    index: 2,
  });

  const folder = await harness.tools.get("equinox_browser_bookmark_folder_create").handler({ title: "Agent", parent_id: "1" });
  assert.equal(folder.isError, undefined);
  assert.equal(harness.calls.at(-1).method, "bookmarks.folder_create");

  const updated = await harness.tools.get("equinox_browser_bookmark_update_move").handler({
    id: "9",
    title: "Updated",
    parent_id: "2",
  });
  assert.equal(updated.isError, undefined);
  assert.deepEqual(harness.calls.at(-1).args, { id: "9", title: "Updated", parentId: "2" });

  const removed = await harness.tools.get("equinox_browser_bookmark_remove").handler({ id: "9", recursive: false });
  assert.equal(removed.isError, undefined);
  assert.deepEqual(harness.calls.at(-1).args, { id: "9", recursive: false });

  const callsBeforeUserAttempt = harness.calls.length;
  const userRejected = await harness.tools.get("equinox_browser_bookmarks_list").handler({ target: "user", parent_id: "0", limit: 10 });
  assert.equal(userRejected.isError, true);
  assert.match(userRejected.content[0].text, /yalnız Agent Browser/u);
  assert.equal(harness.calls.length, callsBeforeUserAttempt);

  const oldExtension = makeHarness();
  oldExtension.bridge.snapshot = () => ({
    active: true,
    ready: true,
    contexts: {
      agent: { ready: true, extension: { extensionVersion: "0.1.0", capabilityVersions: {} } },
      user: { ready: true, extension: { extensionVersion: "0.1.0", capabilityVersions: {} } },
    },
  });
  await registerEquinoxBrowserTools(oldExtension.deps);
  const missingCapability = await oldExtension.tools.get("equinox_browser_bookmarks_search").handler({ query: "x", limit: 5 });
  assert.equal(missingCapability.isError, true);
  assert.match(missingCapability.content[0].text, /güncel sürümü/u);
  assert.equal(oldExtension.calls.length, 0);
});

test("upload resolves an allowlisted file before passing its absolute path to the extension", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_upload_file").handler({
    source_root: "downloads",
    path: "avatar.png",
    ref: "@e8",
    tab_id: 91,
  });

  assert.deepEqual(parseTextResult(result), {
    method: "upload",
    args: {
      tabId: 91,
      ref: "@e8",
      files: ["/allowed/downloads/avatar.png"],
    },
  });
});

test("upload refuses a request without a ref or selector", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_upload_file").handler({
    source_root: "local",
    path: "file.txt",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /ref veya selector zorunludur/);
});

test("download wait returns bounded safe metadata and never exposes the absolute Chrome filename", async () => {
  const harness = makeHarness();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-browser-download-"));
  const downloadsRoot = path.join(root, "Downloads");
  await fs.mkdir(downloadsRoot);
  const absolutePath = path.join(downloadsRoot, "fixture.txt");
  const payload = Buffer.from("Equinox download fixture\n", "utf8");
  await fs.writeFile(absolutePath, payload);
  harness.deps.downloadsRoot = downloadsRoot;
  harness.bridge.call = async (method, args, options) => {
    harness.calls.push({ method, args, options });
    if (method !== "downloads.wait") return { method, args };
    return {
      download: {
        id: 17,
        filename: absolutePath,
        name: "fixture.txt",
        mimeType: "text/plain",
        state: "complete",
        danger: "safe",
        fileSize: payload.length,
        exists: true,
        startTime: "2026-08-14T18:00:00.000Z",
        endTime: "2026-08-14T18:00:01.000Z",
      },
    };
  };
  await registerEquinoxBrowserTools(harness.deps);

  const result = await harness.tools.get("equinox_browser_download_wait").handler({ download_id: 17, timeout_ms: 2_000 });
  assert.equal(result.isError, undefined);
  const parsed = parseTextResult(result);
  assert.deepEqual(parsed, {
    downloadId: 17,
    name: "fixture.txt",
    mimeType: "text/plain",
    bytes: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
    state: "complete",
    danger: "safe",
    startTime: "2026-08-14T18:00:00.000Z",
    endTime: "2026-08-14T18:00:01.000Z",
    sourceRoot: "downloads",
  });
  assert.equal(JSON.stringify(parsed).includes(absolutePath), false);
  assert.deepEqual(harness.calls.at(-1), {
    method: "downloads.wait",
    args: { downloadId: 17, timeoutMs: 2_000 },
    options: { timeoutMs: 7_000, context: "agent" },
  });
  await fs.rm(root, { recursive: true, force: true });
});

test("download wait rejects interrupted and dangerous Chrome downloads before filesystem resolution", async () => {
  for (const fixture of [
    { state: "interrupted", danger: "safe", error: "NETWORK_FAILED", pattern: /download kesildi/i },
    { state: "complete", danger: "dangerous_file", error: null, pattern: /güvenli kabul edilmedi/i },
  ]) {
    const harness = makeHarness();
    harness.bridge.call = async () => ({
      download: {
        id: 23,
        filename: "/outside/should-never-be-resolved.bin",
        mimeType: "application/octet-stream",
        fileSize: 1,
        exists: true,
        ...fixture,
      },
    });
    await registerEquinoxBrowserTools(harness.deps);
    const result = await harness.tools.get("equinox_browser_download_wait").handler({ download_id: 23, timeout_ms: 1_000 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, fixture.pattern);
    assert.equal(result.content[0].text.includes("/outside/"), false);
  }
});

test("download file inspection rejects root escape, symlink, size overflow and Chrome/disk size mismatch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-browser-download-guard-"));
  const downloadsRoot = path.join(root, "Downloads");
  const outsideRoot = path.join(root, "Outside");
  await fs.mkdir(downloadsRoot);
  await fs.mkdir(outsideRoot);
  const outside = path.join(outsideRoot, "outside.txt");
  await fs.writeFile(outside, "outside");
  await assert.rejects(
    inspectBrowserDownloadFile({ downloadsRoot, absolutePath: outside }),
    /Downloads kökünün dışında/,
  );

  const link = path.join(downloadsRoot, "escape-link.txt");
  await fs.symlink(outside, link);
  await assert.rejects(
    inspectBrowserDownloadFile({ downloadsRoot, absolutePath: link }),
    /symlink olmayan/,
  );

  const bounded = path.join(downloadsRoot, "bounded.txt");
  await fs.writeFile(bounded, "12345");
  await assert.rejects(
    inspectBrowserDownloadFile({ downloadsRoot, absolutePath: bounded, maxBytes: 4 }),
    /güvenlik sınırını aşıyor/,
  );
  await assert.rejects(
    inspectBrowserDownloadFile({ downloadsRoot, absolutePath: bounded, expectedSize: 6 }),
    /boyutu uyuşmuyor/,
  );
  await fs.rm(root, { recursive: true, force: true });
});
