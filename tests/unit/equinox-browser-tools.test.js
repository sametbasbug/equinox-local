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
  const bridge = {
    snapshot: () => ({ active: true, ready: true }),
    call: async (method, args, options) => {
      calls.push({ method, args, options });
      if (method === "status") return { extensionVersion: "0.1.0" };
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
    "equinox_browser_snapshot",
    "equinox_browser_screenshot",
    "equinox_browser_screenshot_delete",
    "equinox_browser_find",
    "equinox_browser_click",
    "equinox_browser_hover",
    "equinox_browser_scroll",
    "equinox_browser_select",
    "equinox_browser_check",
    "equinox_browser_wait",
    "equinox_browser_fill",
    "equinox_browser_press",
    "equinox_browser_eval",
    "equinox_browser_observe_start",
    "equinox_browser_observe_stop",
    "equinox_browser_console",
    "equinox_browser_network",
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
  harness.deps.isBrowserAccessEnabled = () => false;
  await registerEquinoxBrowserTools(harness.deps);

  const status = await harness.tools.get("equinox_browser_status").handler({});
  assert.deepEqual(parseTextResult(status), {
    accessEnabled: false,
    defaultTarget: "agent",
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

test("snapshot preserves @ref workflow arguments", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);

  await harness.tools.get("equinox_browser_snapshot").handler({
    tab_id: 42,
    include_readable: false,
  });
  assert.deepEqual(harness.calls.at(-1), {
    method: "snapshot",
    args: { tabId: 42, includeReadable: false },
    options: { context: "agent" },
  });

  await harness.tools.get("equinox_browser_click").handler({ ref: "@e3", tab_id: 42 });
  assert.deepEqual(harness.calls.at(-1), {
    method: "click",
    args: { tabId: 42, ref: "@e3" },
    options: { context: "agent" },
  });
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

test("semantic find and observation tools map to first-party bridge methods", async () => {
  const harness = makeHarness();
  await registerEquinoxBrowserTools(harness.deps);

  await harness.tools.get("equinox_browser_find").handler({ query: "Sign in", role: "button", exact: true, tab_id: 9 });
  assert.deepEqual(harness.calls.at(-1), {
    method: "find",
    args: { tabId: 9, query: "Sign in", role: "button", exact: true },
    options: { context: "agent" },
  });

  await harness.tools.get("equinox_browser_observe_start").handler({ tab_id: 9 });
  assert.deepEqual(harness.calls.at(-1).method, "observe.start");
  await harness.tools.get("equinox_browser_console").handler({ tab_id: 9, limit: 20, clear: false });
  assert.deepEqual(harness.calls.at(-1), {
    method: "console.read",
    args: { tabId: 9, limit: 20, clear: false },
    options: { context: "agent" },
  });
  await harness.tools.get("equinox_browser_network").handler({ tab_id: 9, limit: 30, clear: true });
  assert.deepEqual(harness.calls.at(-1).method, "network.read");
  await harness.tools.get("equinox_browser_dialog").handler({ tab_id: 9, action: "accept", prompt_text: "ok" });
  assert.deepEqual(harness.calls.at(-1), {
    method: "dialog",
    args: { tabId: 9, action: "accept", promptText: "ok" },
    options: { context: "agent" },
  });
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
