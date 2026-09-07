import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";

import { registerDesktopGatewayTools } from "../../src/equinox-local-desktop-tools.js";

function createHarness(overrides = {}) {
  const textRegistrations = new Map();
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
        compatibility: {
          ok: true,
          minimumVersion: { major: 4, minor: 3, patch: 0 },
          warnings: [],
        },
        reconnectCount: 1,
        lastReconnectAt: "2026-09-06T10:00:00.000Z",
        unexpectedCloseCount: 0,
        lastUnexpectedCloseAt: null,
        lastTransportError: null,
        permissions: "Screen Recording: granted",
        serverStatus: "ready",
      };
    },
    async restart() {
      restartCount += 1;
    },
    async listTools(refresh) {
      listCalls.push(refresh);
      return [
        {
          name: "see",
          description: "Inspect UI",
          inputSchema: { type: "object" },
        },
      ];
    },
    async callTool(name, args) {
      bridgeCalls.push({ name, args });
      return { content: [{ type: "text", text: "clicked" }] };
    },
  };

  registerDesktopGatewayTools({
    registerTextTool(name, config, handler, options = {}) {
      textRegistrations.set(name, { config, handler, options });
    },
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
    textRegistrations,
    rawRegistrations,
    lockCalls,
    bridgeCalls,
    listCalls,
    get restartCount() {
      return restartCount;
    },
  };
}

test("desktop_status preserves bounded Peekaboo status formatting and MCP exposure", async () => {
  const harness = createHarness();
  const registration = harness.textRegistrations.get("desktop_status");
  assert.ok(registration);
  assert.deepEqual(registration.options, {
    projectAware: false,
    mcpExposed: true,
    capability: false,
  });

  const result = await registration.handler({});
  const text = result.content[0].text;
  assert.match(text, /Peekaboo: 4\.3\.0/u);
  assert.match(text, /Peekaboo MCP köprüsü: AKTİF/u);
  assert.match(text, /Uyumluluk: OK \| minimum=4\.3\.0/u);
  assert.match(text, /İzinler:\nScreen Recording: granted/u);
  assert.match(text, /Peekaboo server durumu:\nready/u);
});

test("desktop_tools preserves access gating, restart and single-tool lookup", async () => {
  const harness = createHarness();
  const registration = harness.textRegistrations.get("desktop_tools");
  assert.ok(registration);

  const result = await registration.handler({
    tool_name: "see",
    refresh: false,
    restart: true,
  });
  assert.equal(harness.restartCount, 1);
  assert.deepEqual(harness.listCalls, [true]);
  assert.match(result.content[0].text, /"name": "see"/u);

  const blocked = createHarness({ agentAccess: { desktop: false } });
  const blockedResult = await blocked.textRegistrations
    .get("desktop_tools")
    .handler({ tool_name: undefined, refresh: false, restart: false });
  assert.equal(blockedResult.isError, true);
  assert.match(blockedResult.content[0].text, /Desktop automation access is disabled/u);
});

test("desktop_call preserves the desktop mutation lock and structured text output", async () => {
  const harness = createHarness();
  const registration = harness.rawRegistrations.get("desktop_call");
  assert.ok(registration);
  assert.deepEqual(registration.options, {
    mcpExposed: true,
    capability: false,
  });

  const result = await registration.handler({
    tool_name: "click",
    arguments: { target: "Save" },
  });
  assert.deepEqual(harness.lockCalls, [["desktop"]]);
  assert.deepEqual(harness.bridgeCalls, [
    { name: "click", args: { target: "Save" } },
  ]);
  assert.deepEqual(result.structuredContent, { text: "clicked" });
});
