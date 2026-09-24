import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";

import { registerDesktopGatewayTools } from "../../src/equinox-local-desktop-tools.js";

function createHarness(overrides = {}) {
  const rawRegistrations = new Map();
  const lockCalls = [];
  const bridgeCalls = [];
  const listCalls = [];
  let restartCount = 0;

  const textResult = (text) => ({ content: [{ type: "text", text }] });
  const errorResult = (error) => ({
    content: [{ type: "text", text: `Hata: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  });

  const peekabooBridge = {
    async status() {
      return {
        version: "4.3.0",
        binary: "peekaboo",
        active: true,
        allowedToolCount: 2,
        allowedTools: ["see", "click"],
        compatibility: { ok: true, minimumVersion: { major: 4, minor: 3, patch: 0 }, warnings: [] },
        reconnectCount: 1,
        lastReconnectAt: "2026-09-06T10:00:00.000Z",
        unexpectedCloseCount: 0,
        lastUnexpectedCloseAt: null,
        lastTransportError: null,
        permissions: "Screen Recording: granted",
        serverStatus: "ready",
      };
    },
    async restart() { restartCount += 1; },
    async listTools(refresh) {
      listCalls.push(refresh);
      return [{ name: "see", description: "Inspect UI", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];
    },
    async callTool(name, args) {
      bridgeCalls.push({ name, args });
      return { content: [{ type: "text", text: "clicked" }] };
    },
  };

  const discovery = registerDesktopGatewayTools({
    registerRawTool(name, config, handler, options = {}) {
      rawRegistrations.set(name, { config, handler, options });
    },
    z,
    agentAccess: { desktop: true },
    peekabooBridge,
    allowedTools: ["see", "click"],
    withMutationLocks: async (scopes, fn) => {
      lockCalls.push(scopes);
      return fn();
    },
    normalizeChromeToolResult: (result) => result,
    extractTextContent: (result) => result.content?.map((item) => item.text ?? "").join("\n") ?? "",
    textResult,
    errorResult,
    ...overrides,
  });

  return {
    discovery,
    rawRegistrations,
    lockCalls,
    bridgeCalls,
    listCalls,
    get restartCount() { return restartCount; },
  };
}

test("desktop exposes one top-level call and unified discovery provider", async () => {
  const harness = createHarness();
  assert.deepEqual([...harness.rawRegistrations.keys()], ["desktop_call"]);
  const registration = harness.rawRegistrations.get("desktop_call");
  assert.ok(registration);
  assert.equal(registration.options.pauseGuard, false);
  assert.equal(registration.config.inputSchema.operation.safeParse("see").success, true);
  assert.equal(registration.config.inputSchema.tool_name, undefined);

  const catalog = await harness.discovery.catalog();
  assert.deepEqual(catalog.operations.map((item) => item.name), ["status", "refresh", "restart", "see"]);
  assert.equal((await harness.discovery.summary()).count, 4);
  const descriptor = await harness.discovery.describe("see");
  assert.equal(descriptor.domain, "desktop");
  assert.equal(descriptor.inputSchema.type, "object");
});

test("desktop status is available through desktop_call without UI access", async () => {
  const harness = createHarness({ agentAccess: { desktop: false } });
  const registration = harness.rawRegistrations.get("desktop_call");
  const result = await registration.handler({ operation: "status", arguments: {} });
  const text = result.content[0].text;
  assert.match(text, /Peekaboo: 4\.3\.0/u);
  assert.match(text, /Peekaboo MCP köprüsü: AKTİF/u);
  assert.match(text, /İzinler:\nScreen Recording: granted/u);
  assert.deepEqual(result.structuredContent, { text });
  const catalog = await harness.discovery.catalog();
  assert.deepEqual(catalog.operations.map((item) => item.name), ["status", "refresh", "restart"]);
});

test("desktop refresh and restart are explicit operations; mutations respect pause guard", async () => {
  const harness = createHarness();
  const registration = harness.rawRegistrations.get("desktop_call");
  const refreshed = await registration.handler({ operation: "refresh", arguments: {} });
  assert.match(refreshed.content[0].text, /refreshed: 1 safe tools/u);
  assert.deepEqual(refreshed.structuredContent, { text: refreshed.content[0].text });
  assert.deepEqual(harness.listCalls, [true]);
  assert.equal(harness.restartCount, 0);

  const guarded = createHarness({
    assertMutationAllowed(operationName) {
      const error = new Error(`paused:${operationName}`);
      error.code = "EQUINOX_LOCAL_PAUSED_BY_USER";
      throw error;
    },
  });
  const guardedCall = guarded.rawRegistrations.get("desktop_call");
  assert.equal(guardedCall.options.pauseGuard, false);

  const statusWhilePaused = await guardedCall.handler({ operation: "status", arguments: {} });
  assert.equal(statusWhilePaused.isError, undefined);
  assert.match(statusWhilePaused.content[0].text, /Peekaboo: 4\.3\.0/u);

  const blockedRefresh = await guardedCall.handler({ operation: "refresh", arguments: {} });
  assert.equal(blockedRefresh.isError, true);
  assert.match(blockedRefresh.content[0].text, /paused:desktop\.refresh/u);

  const blockedRestart = await guardedCall.handler({ operation: "restart", arguments: {} });
  assert.equal(blockedRestart.isError, true);
  assert.match(blockedRestart.content[0].text, /paused:desktop\.restart/u);

  const blockedClick = await guardedCall.handler({ operation: "click", arguments: { target: "Save" } });
  assert.equal(blockedClick.isError, true);
  assert.match(blockedClick.content[0].text, /paused:desktop\.click/u);

  assert.equal(guarded.restartCount, 0);
  assert.deepEqual(guarded.listCalls, []);
  assert.deepEqual(guarded.bridgeCalls, []);
});

test("desktop_call preserves the desktop mutation lock and structured text output", async () => {
  const harness = createHarness();
  const registration = harness.rawRegistrations.get("desktop_call");
  const result = await registration.handler({ operation: "click", arguments: { target: "Save" } });
  assert.deepEqual(harness.lockCalls, [["desktop"]]);
  assert.deepEqual(harness.bridgeCalls, [{ name: "click", args: { target: "Save" } }]);
  assert.deepEqual(result.structuredContent, { text: "clicked" });
});

test("desktop_call routes results through Turn Budget without changing the desktop capability catalog", async () => {
  const events = [];
  const harness = createHarness({
    turnBudgetController: {
      async prepareInvocation(toolName, input) {
        events.push(["prepare", toolName]);
        return { input, firstNotice: true, waitClamped: false };
      },
      decorateResult(result) {
        events.push(["decorate"]);
        return {
          ...result,
          content: result.content.map((item) => item.type === "text"
            ? { ...item, text: `${item.text}\nTURN-BUDGET` }
            : item),
        };
      },
    },
  });
  const registration = harness.rawRegistrations.get("desktop_call");
  const result = await registration.handler({ operation: "status", arguments: {} });
  assert.match(result.content[0].text, /TURN-BUDGET/u);
  assert.deepEqual(events, [["prepare", "desktop_call"], ["decorate"]]);
  assert.equal((await harness.discovery.summary()).count, 4);
});
