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
  assert.match(refreshed.content[0].text, /refreshed: 1 bounded tools/u);
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

test("desktop_call preserves native MCP image content from a desktop provider", async () => {
  const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
  const bridge = {
    label: "Windows desktop",
    async status() { return { engine: "winapp", version: "0.7.1", binary: "winapp.exe", active: true, allowedToolCount: 1, allowedTools: ["screenshot"], compatibility: { warnings: [] } }; },
    async restart() {},
    async listTools() { return [{ name: "screenshot", description: "Capture", inputSchema: { type: "object", properties: {}, additionalProperties: false } }]; },
    async callTool() { return { content: [{ type: "text", text: "captured" }, image] }; },
  };
  const harness = createHarness({ desktopBridge: bridge });
  const result = await harness.rawRegistrations.get("desktop_call").handler({ operation: "screenshot", arguments: {} });
  assert.deepEqual(result.content[1], image);
  assert.equal(result.structuredContent, undefined,
    "MCP clients must see native image parts, not a competing text-only structured output");
  assert.equal(harness.rawRegistrations.get("desktop_call").config.outputSchema, undefined,
    "a text-only output schema must not suppress image content");
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

test("desktop gate denies mutation and private catalog when desktop Agent Access is disabled, while status stays available", async () => {
  const events = [];
  const harness = createHarness({
    agentAccess: {desktop:false},
    peekabooBridge:{
      label:"protected",
      async status(){events.push("status");return {
        version:"4.3.0",binary:"owned-peekaboo",active:false,allowedToolCount:0,allowedTools:[],
        compatibility:null,error:"mock service unavailable",
        reconnectCount:0,lastReconnectAt:null,unexpectedCloseCount:0,lastUnexpectedCloseAt:null,
        lastTransportError:null,permissions:null,serverStatus:null,
      }},
      async listTools(){events.push("list");throw Error("must not list private catalog")},
      async restart(){events.push("restart");throw Error("must not restart")},
      async callTool(){events.push("call");throw Error("must not click")},
    },
  });
  const operations = await harness.discovery.catalog();
  assert.deepEqual(operations.operations.map(item=>item.name),["status","refresh","restart"]);
  assert.equal(operations.label,"protected");
  assert.equal((await harness.discovery.summary()).count,3);
  await assert.rejects(harness.discovery.describe("click"),/Desktop automation access is disabled/u);
  assert.deepEqual(events,[]);
  const registration=harness.rawRegistrations.get("desktop_call");
  assert.deepEqual(registration.options,{mcpExposed:true,capability:false,pauseGuard:false});
  assert.deepEqual(registration.config.annotations,{
    title:"Desktop operation çağır",readOnlyHint:false,destructiveHint:true,
    idempotentHint:false,openWorldHint:false,
  });
  for(const operation of ["refresh","restart","click","screenshot"]) {
    const result=await registration.handler({operation,arguments:{}});
    assert.equal(result.isError,true,operation);
    assert.match(result.content[0].text,/Desktop automation access is disabled/u,operation);
  }
  const status=await registration.handler({operation:"status",arguments:{}});
  assert.equal(status.isError,undefined);
  assert.match(status.content[0].text,/İzin durumu alınamadı: mock service unavailable/u);
  assert.deepEqual(events,["status"]);
  assert.deepEqual(harness.lockCalls,[]);
});

test("desktop built-in status, refresh and restart refuse extra arguments before any bridge mutation", async () => {
  const harness=createHarness();
  const registration=harness.rawRegistrations.get("desktop_call");
  for(const operation of ["status","refresh","restart"]) {
    const response=await registration.handler({
      operation,arguments:{unapproved:"value"},
    });
    assert.equal(response.isError,true,operation);
    assert.match(response.content[0].text,new RegExp(`desktop ${operation} arguments kabul etmez`, "u"),operation);
  }
  assert.equal(harness.restartCount,0);
  assert.deepEqual(harness.lockCalls,[]);
  assert.deepEqual(harness.bridgeCalls,[]);
  assert.deepEqual(harness.listCalls,[]);
});

test("desktop mutations preserve exact pause-check then owned bridge lock order and errors never retry", async () => {
  const events=[];
  const failure=Error("controlled desktop bridge failure");
  const harness=createHarness({
    assertMutationAllowed:operation=>events.push(["pauseCheck",operation]),
    withMutationLocks:async(scopes,callback)=>{
      events.push(["lock",scopes]);
      return callback();
    },
    desktopBridge:{
      label:"Windows desktop",
      status:async()=>({engine:"winapp",version:"test",binary:"owned",active:true,
        allowedToolCount:0,allowedTools:[],compatibility:{warnings:[]}}),
      restart:async()=>events.push(["restart"]),
      listTools:async refresh=>{events.push(["list",refresh]);return [];},
      callTool:async(name,args)=>{
        events.push(["call",name,args]);
        throw failure;
      },
    },
  });
  const handler=harness.rawRegistrations.get("desktop_call").handler;
  const refresh=await handler({operation:"refresh",arguments:{}});
  assert.equal(refresh.isError,undefined);
  const restart=await handler({operation:"restart",arguments:{}});
  assert.equal(restart.isError,undefined);
  const click=await handler({operation:"click",arguments:{target:"fixture"}});
  assert.equal(click.isError,true);
  assert.match(click.content[0].text,/controlled desktop bridge failure/u);
  assert.deepEqual(events,[
    ["pauseCheck","desktop.refresh"],["list",true],
    ["pauseCheck","desktop.restart"],["lock",["desktop"]],["restart"],["list",true],
    ["pauseCheck","desktop.click"],["lock",["desktop"]],["call","click",{target:"fixture"}],
  ]);
});

test("desktop Windows read-only status and native screenshot image blocks retain their provider semantics", async () => {
  const image={type:"image",data:"aW1hZ2U=",mimeType:"image/png"};
  const harness=createHarness({
    desktopBridge:{
      label:"Windows desktop",
      status:async()=>({
        engine:"winapp",version:"0.7.1",binary:"winapp.exe",active:true,
        allowedToolCount:1,allowedTools:["screenshot"],compatibility:{warnings:["fixture-only"]},
      }),
      restart:async()=>{},
      listTools:async()=>[{name:"screenshot",description:"Capture",inputSchema:{type:"object"}}],
      callTool:async()=>({content:[{type:"text",text:"captured"},image]}),
    },
  });
  const handler=harness.rawRegistrations.get("desktop_call").handler;
  const status=await handler({operation:"status",arguments:{}});
  assert.match(status.content[0].text,/Microsoft winapp: 0\.7\.1/u);
  assert.match(status.content[0].text,/Not: fixture-only/u);
  const screenshot=await handler({operation:"screenshot",arguments:{}});
  assert.deepEqual(screenshot.content[1],image);
  assert.equal(screenshot.structuredContent,undefined);
  assert.deepEqual(harness.lockCalls,[["desktop"]]);
  const catalog=await harness.discovery.catalog();
  assert.equal(catalog.operations.find(item=>item.name==="screenshot").inputSchema,undefined,
    "the public discovery listing excludes schemas until a specific operation is described");
  const described=await harness.discovery.describe("screenshot");
  assert.deepEqual(described.inputSchema,{type:"object"});
  assert.equal(harness.rawRegistrations.get("desktop_call").config.outputSchema,undefined);
});
