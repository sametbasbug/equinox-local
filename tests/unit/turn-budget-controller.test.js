import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TURN_BUDGET_DEFAULTS,
  __test,
  createTurnBudgetController,
} from "../../src/turn-budget-controller.js";

async function withTempDir(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-turn-budget-"));
  try { return await fn(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function textResult(text = "ok") {
  return { content: [{ type: "text", text }] };
}

const TEST_SETTINGS_PATH = path.join(os.tmpdir(), `equinox-turn-budget-defaults-${process.pid}.json`);

test("turn budget defaults and stages are bounded", () => {
  assert.deepEqual(__test.normalizeSettings(), { enabled: true, cutoffMinutes: 22, fallbackResetMinutes: 2, autoContinueMaxHops: 10 });
  assert.equal(__test.stageForElapsed(17 * 60_000, 22), "running");
  assert.equal(__test.stageForElapsed(18 * 60_000, 22), "checkpoint");
  assert.equal(__test.stageForElapsed(20 * 60_000, 22), "finalize");
  assert.equal(__test.stageForElapsed(22 * 60_000, 22), "overdue");
  assert.throws(() => __test.normalizeSettings({ cutoffMinutes: 4 }), /between 5 and 120/u);
  assert.throws(() => __test.normalizeSettings({ cutoffMinutes: 22, fallbackResetMinutes: 0 }), /between 1 and cutoffMinutes/u);
  assert.throws(() => __test.normalizeSettings({ cutoffMinutes: 10, fallbackResetMinutes: 11 }), /between 1 and cutoffMinutes/u);
  assert.throws(() => __test.normalizeSettings({ autoContinueMaxHops: 21 }), /between 1 and 20/u);
});

test("controller persists immediate runtime settings with private permissions", async () => {
  await withTempDir(async (root) => {
    const settingsPath = path.join(root, "turn-budget.json");
    const controller = createTurnBudgetController({ settingsPath });
    await controller.initialize();
    assert.equal(controller.snapshot().cutoffMinutes, 22);
    assert.equal(controller.snapshot().fallbackResetMinutes, 2);
    assert.equal(controller.snapshot().autoContinueMaxHops, 10);
    await controller.updateSettings({ enabled: true, cutoffMinutes: 19, fallbackResetMinutes: 3, autoContinueMaxHops: 14 });
    assert.equal(controller.snapshot().cutoffMinutes, 19);
    assert.equal(controller.snapshot().fallbackResetMinutes, 3);
    assert.equal(controller.snapshot().autoContinueMaxHops, 14);
    if (process.platform !== "win32") assert.equal((await fs.stat(settingsPath)).mode & 0o777, 0o600);
    const reloaded = createTurnBudgetController({ settingsPath });
    await reloaded.initialize();
    assert.equal(reloaded.snapshot().cutoffMinutes, 19);
    assert.equal(reloaded.snapshot().fallbackResetMinutes, 3);
    assert.equal(reloaded.snapshot().autoContinueMaxHops, 14);
  });
});

test("browser assistant turn identity resets the budget and start notice only once per turn", async () => {
  let now = 1_000_000;
  let turn = "turn-a";
  let userEpoch = "user-a";
  const controller = createTurnBudgetController({
    settingsPath: TEST_SETTINGS_PATH,
    now: () => now,
    resolveTurnIdentity: async () => ({ browserContext: "user", conversationId: "chat-1", userEpoch, assistantTurnKey: turn, title: "Task" }),
  });
  await controller.initialize();

  let prepared = await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  let result = controller.decorateResult(textResult(), prepared);
  assert.match(result.content[0].text, /Turn Budget/u);
  assert.equal(controller.snapshot().active.source, "browser");

  now += 60_000;
  prepared = await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  result = controller.decorateResult(textResult(), prepared);
  assert.doesNotMatch(result.content[0].text, /This assistant turn has/u);
  assert.equal(controller.snapshot().active.elapsedMs, 60_000);

  userEpoch = "user-b";
  now += 1_000;
  prepared = await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  result = controller.decorateResult(textResult(), prepared);
  assert.match(result.content[0].text, /This assistant turn has/u);
  assert.equal(controller.snapshot().active.elapsedMs, 0, "new user epoch resets even if assistant key briefly remains stale");

  turn = "turn-b";
  now += 1_000;
  prepared = await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  result = controller.decorateResult(textResult(), prepared);
  assert.doesNotMatch(result.content[0].text, /This assistant turn has/u, "assistant DOM key settling must not reset the same user turn again");
  assert.equal(controller.snapshot().active.elapsedMs, 1_000);

  userEpoch = "user-c";
  now += 1_000;
  prepared = await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  result = controller.decorateResult(textResult(), prepared);
  assert.match(result.content[0].text, /This assistant turn has/u);
  assert.equal(controller.snapshot().active.elapsedMs, 0);
});

test("controller emits checkpoint, finalize and overdue notices once", async () => {
  let now = 0;
  const controller = createTurnBudgetController({
    settingsPath: TEST_SETTINGS_PATH,
    now: () => now,
    resolveTurnIdentity: async () => ({ browserContext: "user", conversationId: "chat-1", assistantTurnKey: "turn-a" }),
  });
  await controller.initialize();
  let prepared = await controller.prepareInvocation("browser_call", { operation: "status", arguments: {} });
  controller.decorateResult(textResult(), prepared);

  now = 18 * 60_000;
  prepared = await controller.prepareInvocation("browser_call", { operation: "status", arguments: {} });
  let result = controller.decorateResult(textResult(), prepared);
  assert.match(result.content[0].text, /Do not start a new major subtask/u);
  result = controller.decorateResult(textResult(), prepared);
  assert.doesNotMatch(result.content[0].text, /Do not start a new major subtask/u);

  now = 20 * 60_000;
  prepared = await controller.prepareInvocation("browser_call", { operation: "status", arguments: {} });
  result = controller.decorateResult(textResult(), prepared);
  assert.match(result.content[0].text, /FINALIZATION WINDOW/u);

  now = 22 * 60_000;
  prepared = await controller.prepareInvocation("browser_call", { operation: "status", arguments: {} });
  result = controller.decorateResult(textResult(), prepared);
  assert.match(result.content[0].text, /SAFETY CUTOFF REACHED/u);
});

test("runtime blocking waits are clamped only inside finalization window", async () => {
  let now = 0;
  const controller = createTurnBudgetController({
    settingsPath: TEST_SETTINGS_PATH,
    now: () => now,
    resolveTurnIdentity: async () => ({ browserContext: "user", conversationId: "chat-1", assistantTurnKey: "turn-a" }),
  });
  await controller.initialize();
  await controller.prepareInvocation("runtime_call", { operation: "process_wait", arguments: { wait_ms: 120_000 } });

  now = 19 * 60_000;
  let prepared = await controller.prepareInvocation("runtime_call", { operation: "process_wait", arguments: { wait_ms: 120_000 } });
  assert.equal(prepared.input.arguments.wait_ms, 120_000);
  assert.equal(prepared.waitClamped, false);

  now = 21.5 * 60_000;
  prepared = await controller.prepareInvocation("runtime_call", { operation: "process_wait", arguments: { wait_ms: 120_000 } });
  assert.equal(prepared.input.arguments.wait_ms, 5_000);
  assert.equal(prepared.waitClamped, true);
  const result = controller.decorateResult(textResult(), prepared);
  assert.match(result.content[0].text, /blocking wait was shortened/u);
});

test("browser turn identity can use userEpoch before assistantTurnKey exists", async () => {
  let now = 0;
  const controller = createTurnBudgetController({
    settingsPath: TEST_SETTINGS_PATH,
    now: () => now,
    resolveTurnIdentity: async () => ({
      browserContext: "user",
      conversationId: "conv-live",
      userEpoch: "user-live",
      assistantTurnKey: null,
      title: "ChatGPT",
    }),
  });
  await controller.initialize();
  await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  assert.equal(controller.snapshot().active.source, "browser");
  assert.equal(controller.snapshot().active.browserContext, "user");
});

test("fallback timer becomes idle after configurable inactivity when browser identity is unavailable", async () => {
  await withTempDir(async (root) => {
    let now = 0;
    const controller = createTurnBudgetController({
      settingsPath: path.join(root, "turn-budget.json"),
      now: () => now,
      resolveTurnIdentity: async () => null,
    });
    await controller.initialize();
    await controller.updateSettings({ enabled: true, cutoffMinutes: 22, fallbackResetMinutes: 2 });
    await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
    now = 2 * 60_000 - 1;
    assert.notEqual((await controller.refreshSnapshot()).active, null);
    now = 2 * 60_000;
    assert.equal((await controller.refreshSnapshot()).active, null, "passive refresh must retire stale fallback work without a new tool call");
    now += 10 * 60_000;
    assert.equal(controller.snapshot().active, null, "plain snapshots must not resurrect or keep counting a stale fallback");
    const prepared = await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
    assert.equal(prepared.firstNotice, true);
    assert.equal(controller.snapshot().active.elapsedMs, 0, "next Local use starts a fresh fallback burst");
  });
});


test("passive refresh clears a finished browser turn without starting the next turn early", async () => {
  let now = 0;
  let probe = { browserContext: "user", conversationId: "chat-1", userEpoch: "user-a", assistantTurnKey: "turn-a", title: "Task" };
  const controller = createTurnBudgetController({
    settingsPath: TEST_SETTINGS_PATH,
    now: () => now,
    resolveTurnIdentity: async () => probe,
  });
  await controller.initialize();
  await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  now = 30_000;
  assert.equal((await controller.refreshSnapshot()).active.elapsedMs, 30_000);

  probe = { status: "idle", idleContexts: ["user"] };
  assert.equal((await controller.refreshSnapshot()).active, null, "finished assistant turn becomes idle instead of counting forever");

  probe = { browserContext: "user", conversationId: "chat-1", userEpoch: "user-b", assistantTurnKey: "turn-b", title: "Task" };
  assert.equal((await controller.refreshSnapshot()).active.source, "browser",
    "a new Browser generation must start the timer before any Local call");
  now += 11_000;
  await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  assert.equal(controller.snapshot().active.elapsedMs, 11_000,
    "first Local call must NOT restart an already observed Browser turn");
});

test("passive refresh preserves browser timer when identity probing is temporarily unavailable", async () => {
  let now = 0;
  let probe = { browserContext: "user", conversationId: "chat-1", userEpoch: "user-a", assistantTurnKey: "turn-a" };
  const controller = createTurnBudgetController({ settingsPath: TEST_SETTINGS_PATH, now: () => now, resolveTurnIdentity: async () => probe });
  await controller.initialize();
  await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  now = 45_000;
  probe = null;
  const snapshot = await controller.refreshSnapshot();
  assert.equal(snapshot.active.elapsedMs, 45_000);
  assert.equal(snapshot.active.source, "browser");
});

test("passive refresh retires an old turn when a different browser turn is already generating", async () => {
  let now = 0;
  let probe = { browserContext: "user", conversationId: "chat-1", userEpoch: "user-a", assistantTurnKey: "turn-a" };
  const controller = createTurnBudgetController({ settingsPath: TEST_SETTINGS_PATH, now: () => now, resolveTurnIdentity: async () => probe });
  await controller.initialize();
  await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  now = 20_000;
  probe = { browserContext: "user", conversationId: "chat-1", userEpoch: "user-b", assistantTurnKey: "turn-b" };
  assert.equal((await controller.refreshSnapshot()).active.startedAt, new Date(now).toISOString());
  assert.equal(controller.snapshot().active.source, "browser");
  assert.equal(controller.snapshot().active.elapsedMs, 0);
});

test("Turn Budget guidance distinguishes passive Browser start from tool-driven fallback", async () => {
  let now = 1_000;
  let resolved = { browserContext: "user", conversationId: "conversation-1", userEpoch: "user-1" };
  const controller = createTurnBudgetController({
    settingsPath: TEST_SETTINGS_PATH, now: () => now, resolveTurnIdentity: async () => resolved,
  });
  await controller.initialize();
  await controller.refreshSnapshot();
  now += 7_000;
  const invocation = await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  assert.match(JSON.stringify(controller.decorateResult(textResult(), invocation)), /independent of the first Local tool call/u);
  resolved = { status: "idle", idleContexts: ["user"] };
  await controller.refreshSnapshot();
  const fallback = await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  assert.match(JSON.stringify(controller.decorateResult(textResult(), fallback)), /fallback mode/u);
});

test("Browser timer starts from passive generation observation; fallback starts only from first Local use", async () => {
  let now = 0;
  let probe = null;
  const controller = createTurnBudgetController({
    settingsPath: TEST_SETTINGS_PATH, now: () => now,
    resolveTurnIdentity: async () => probe,
  });
  await controller.initialize();
  assert.equal((await controller.refreshSnapshot()).active, null);
  now = 8_000;
  probe = { browserContext: "user", conversationId: "chat-1", userEpoch: "epoch-one", title: "Active" };
  assert.equal((await controller.refreshSnapshot()).active.startedAt, new Date(8_000).toISOString());
  now += 52_000;
  assert.equal(controller.snapshot().active.elapsedMs, 52_000);
  const firstTool = await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  assert.equal(firstTool.firstNotice, true);
  assert.equal(controller.snapshot().active.elapsedMs, 52_000);
  controller.decorateResult(textResult(), firstTool);
  probe = { status: "idle", idleContexts: ["user"] };
  assert.equal((await controller.refreshSnapshot()).active, null);
  now += 6_000;
  const fallback = await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  assert.equal(fallback.firstNotice, true);
  assert.equal(controller.snapshot().active.source, "fallback");
  assert.equal(controller.snapshot().active.elapsedMs, 0);
});

test("Browser generation timestamp predates first Local tool even when the first identity query is late", async () => {
  let now = 1_800_000_030_000;
  const generationStart = now - 21_000;
  const controller = createTurnBudgetController({
    settingsPath: TEST_SETTINGS_PATH, now: () => now,
    resolveTurnIdentity: async () => ({
      browserContext: "user", conversationId: "chat-1", userEpoch: "epoch-1",
      generationStartedAtMs: generationStart,
    }),
  });
  await controller.initialize();
  const firstTool = await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  assert.equal(firstTool.firstNotice, true);
  assert.equal(controller.snapshot().active.source, "browser");
  assert.equal(controller.snapshot().active.elapsedMs, 21_000);
  now += 4_000;
  assert.equal((await controller.refreshSnapshot()).active.elapsedMs, 25_000);
});

test("invalid future or stale Browser timestamps cannot skip or reset the safety clock", async () => {
  let now = 1_800_000_030_000;
  let generationStartedAtMs = now + 60_000;
  const controller = createTurnBudgetController({
    settingsPath: TEST_SETTINGS_PATH, now: () => now,
    resolveTurnIdentity: async () => ({
      browserContext: "user", conversationId: "chat-2", userEpoch: "epoch-2",
      generationStartedAtMs,
    }),
  });
  await controller.initialize();
  await controller.refreshSnapshot();
  assert.equal(controller.snapshot().active.elapsedMs, 0);
  now += 6_000;
  generationStartedAtMs = now - 3 * 60 * 60_000;
  assert.equal((await controller.refreshSnapshot()).active.elapsedMs, 6_000);
});

test("turn budget rejects malformed settings and prevents disk mutation for invalid updates", async () => {
  const invalid = [
    null, [], "string", 13, {enabled:1}, {cutoffMinutes:4},
    {cutoffMinutes:121}, {cutoffMinutes:5.5}, {cutoffMinutes:"22"},
    {fallbackResetMinutes:0}, {fallbackResetMinutes:121},
    {cutoffMinutes:10,fallbackResetMinutes:11},
    {autoContinueMaxHops:0}, {autoContinueMaxHops:21},
    {autoContinueMaxHops:1.5}, {autoContinueMaxHops:"10"},
  ];
  const writes=[];
  const disk={
    readFile:async()=>{throw Object.assign(Error("missing settings"),{code:"ENOENT"})},
    mkdir:async(...args)=>{writes.push(["mkdir",...args])},
    chmod:async(...args)=>{writes.push(["chmod",...args])},
    writeFile:async(...args)=>{writes.push(["writeFile",...args])},
  };
  const controller=createTurnBudgetController({
    settingsPath:"/fixture/private/turn-budget.json",
    fsImpl:disk,
    now:()=>10_000,
  });
  await controller.initialize();
  assert.deepEqual(controller.snapshot().active,null);
  for(const settings of invalid){
    assert.throws(()=>__test.normalizeSettings(settings),Error,JSON.stringify(settings));
    await assert.rejects(()=>controller.updateSettings(settings),Error,JSON.stringify(settings));
  }
  assert.deepEqual(writes,[],"invalid settings must never attempt mkdir/chmod/write");
  assert.equal(controller.snapshot().autoContinueMaxHops,10);
  assert.deepEqual(__test.normalizeSettings({cutoffMinutes:5,fallbackResetMinutes:5,autoContinueMaxHops:20}),{
    enabled:true,cutoffMinutes:5,fallbackResetMinutes:5,autoContinueMaxHops:20,
  });
});

test("turn budget rejects corrupt stored settings except for missing-file ENOENT and preserves private writes", async () => {
  const refusals=[
    {data:"{",error:/Unexpected end|Expected/u},
    {data:JSON.stringify({autoContinueMaxHops:22}),error:/between 1 and 20/u},
    {data:null,error:/file access unavailable/u},
  ];
  for(const example of refusals){
    const controller=createTurnBudgetController({
      settingsPath:"/fixture/turn-budget.json",
      fsImpl:{
        readFile:async()=>{
          if(example.data===null)throw Object.assign(Error("file access unavailable"),{code:"EACCES"});
          return example.data;
        },
        mkdir:async()=>{throw Error("must not write during initialization");},
        chmod:async()=>{throw Error("must not chmod during initialization");},
        writeFile:async()=>{throw Error("must not write during initialization");},
      },
    });
    await assert.rejects(()=>controller.initialize(),example.error);
  }

  const trace=[];
  const controller=createTurnBudgetController({
    settingsPath:"/fixture/turn-budget.json",
    fsImpl:{
      readFile:async()=>{throw Object.assign(Error("missing"),{code:"ENOENT"})},
      mkdir:async(path,options)=>{trace.push(["mkdir",path,options])},
      chmod:async(path,mode)=>{trace.push(["chmod",path,mode]);throw Object.assign(Error("OS refused chmod"),{code:"EPERM"})},
      writeFile:async(path,data,options)=>{trace.push(["write",path,data,options])},
    },
  });
  await controller.initialize();
  await controller.updateSettings({enabled:false,cutoffMinutes:22,fallbackResetMinutes:2,autoContinueMaxHops:20});
  assert.deepEqual(trace,[
    ["mkdir","/fixture",{recursive:true,mode:0o700}],
    ["chmod","/fixture",0o700],
    ["write","/fixture/turn-budget.json",
      JSON.stringify({enabled:false,cutoffMinutes:22,fallbackResetMinutes:2,autoContinueMaxHops:20},null,2)+"\n",
      {mode:0o600}],
    ["chmod","/fixture/turn-budget.json",0o600],
  ]);
  assert.equal(controller.snapshot().enabled,false);
  assert.equal(controller.snapshot().autoContinueMaxHops,20);
});

test("turn budget clamps only integer bounded runtime blocking waits and preserves originals", async () => {
  let now=100_000;
  const controller=createTurnBudgetController({
    settingsPath:TEST_SETTINGS_PATH,now:()=>now,
    resolveTurnIdentity:async()=>({browserContext:"user",conversationId:"fixture",userEpoch:"one"}),
  });
  await controller.initialize();
  const first={operation:"process_wait",arguments:{wait_ms:120_000,marker:"fixture"}};
  await controller.prepareInvocation("runtime_call",first);
  now+=21*60_000;
  const invalid=[-1,"120000",1.5,null,undefined,{}];
  for(const value of invalid){
    const input={operation:"process_wait",arguments:{wait_ms:value,marker:"fixture"}};
    const prepared=await controller.prepareInvocation("runtime_call",input);
    assert.equal(prepared.input,input);
    assert.equal(prepared.waitClamped,false);
  }
  const allowed=await controller.prepareInvocation("runtime_call",first);
  assert.equal(allowed.waitClamped,true);
  assert.equal(allowed.input.arguments.wait_ms,5_000);
  assert.equal(first.arguments.wait_ms,120_000,"never mutate caller input");
  const notRuntime=await controller.prepareInvocation("desktop_call",first);
  assert.equal(notRuntime.input,first);
  assert.equal(notRuntime.waitClamped,false);
  const short=await controller.prepareInvocation("runtime_call",{
    operation:"process_wait",arguments:{wait_ms:1000},
  });
  assert.equal(short.waitClamped,false);
});

test("turn budget falls back on a broken browser probe while preserving image content and at-most-once notices", async () => {
  let now=1_000;
  let attempts=0;
  const controller=createTurnBudgetController({
    settingsPath:TEST_SETTINGS_PATH,now:()=>now,
    resolveTurnIdentity:async()=>{attempts++;throw Error("browser probe unavailable");},
  });
  await controller.initialize();
  const prepared=await controller.prepareInvocation("runtime_call",{operation:"status",arguments:{}});
  assert.equal(controller.snapshot().active.source,"fallback");
  const image={type:"image",mimeType:"image/png",data:"fixture-only"};
  const result={content:[image,{type:"text",text:"original"}],structuredContent:{text:"original"},metadata:{tag:"keep"}};
  const decorated=controller.decorateResult(result,prepared);
  assert.deepEqual(result.content,[image,{type:"text",text:"original"}],"must not modify original payload");
  assert.equal(result.structuredContent.text,"original");
  assert.deepEqual(decorated.content[0],image,"image should never be dropped");
  assert.match(decorated.content[1].text,/This assistant turn has/u);
  assert.match(decorated.structuredContent.text,/This assistant turn has/u);
  assert.deepEqual(decorated.metadata,{tag:"keep"});
  const twice=controller.decorateResult(result,prepared);
  assert.doesNotMatch(twice.content[1].text,/This assistant turn has/u);
  assert.equal(attempts,1);
  now=3*60_000;
  assert.equal((await controller.refreshSnapshot()).active,null);
});

test("a draft in the ChatGPT composer never resets an already running Turn Budget", async () => {
  let timestamp = 100_000;
  let probe = { browserContext: "user", conversationId: "conversation-1", userEpoch: "turn-1", assistantTurnKey: "assistant-1", generationStartedAtMs: timestamp };
  const controller = createTurnBudgetController({ settingsPath: TEST_SETTINGS_PATH, now: () => timestamp, resolveTurnIdentity: async () => probe });
  await controller.initialize();
  assert.equal((await controller.refreshSnapshot()).active.elapsedMs, 0);
  timestamp += 75_000;
  // The Browser reports composing, not idle, if a draft has temporarily
  // removed ChatGPT's generation-button indicator.
  probe = { status: "composing", reason: "draft_not_turn_completion" };
  assert.equal((await controller.refreshSnapshot()).active.elapsedMs, 75_000);
  timestamp += 30_000;
  assert.equal(controller.snapshot().active.elapsedMs, 105_000);
  probe = { status: "idle", idleContexts: ["user"] };
  assert.equal((await controller.refreshSnapshot()).active, null, "confirmed idle clears budget only after the draft is gone");
});
