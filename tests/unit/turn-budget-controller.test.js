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

test("turn budget defaults and stages are bounded", () => {
  assert.deepEqual(__test.normalizeSettings(), { enabled: true, cutoffMinutes: 22, fallbackResetMinutes: 5 });
  assert.equal(__test.stageForElapsed(17 * 60_000, 22), "running");
  assert.equal(__test.stageForElapsed(18 * 60_000, 22), "checkpoint");
  assert.equal(__test.stageForElapsed(20 * 60_000, 22), "finalize");
  assert.equal(__test.stageForElapsed(22 * 60_000, 22), "overdue");
  assert.throws(() => __test.normalizeSettings({ cutoffMinutes: 4 }), /between 5 and 120/u);
  assert.throws(() => __test.normalizeSettings({ cutoffMinutes: 22, fallbackResetMinutes: 0 }), /between 1 and cutoffMinutes/u);
  assert.throws(() => __test.normalizeSettings({ cutoffMinutes: 10, fallbackResetMinutes: 11 }), /between 1 and cutoffMinutes/u);
});

test("controller persists immediate runtime settings with private permissions", async () => {
  await withTempDir(async (root) => {
    const settingsPath = path.join(root, "turn-budget.json");
    const controller = createTurnBudgetController({ settingsPath });
    await controller.initialize();
    assert.equal(controller.snapshot().cutoffMinutes, 22);
    assert.equal(controller.snapshot().fallbackResetMinutes, 5);
    await controller.updateSettings({ enabled: true, cutoffMinutes: 19, fallbackResetMinutes: 3 });
    assert.equal(controller.snapshot().cutoffMinutes, 19);
    assert.equal(controller.snapshot().fallbackResetMinutes, 3);
    assert.equal((await fs.stat(settingsPath)).mode & 0o777, 0o600);
    const reloaded = createTurnBudgetController({ settingsPath });
    await reloaded.initialize();
    assert.equal(reloaded.snapshot().cutoffMinutes, 19);
    assert.equal(reloaded.snapshot().fallbackResetMinutes, 3);
  });
});

test("browser assistant turn identity resets the budget and start notice only once per turn", async () => {
  let now = 1_000_000;
  let turn = "turn-a";
  let userEpoch = "user-a";
  const controller = createTurnBudgetController({
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

test("fallback timer becomes idle after configurable inactivity when browser identity is unavailable", async () => {
  let now = 0;
  const controller = createTurnBudgetController({ now: () => now, resolveTurnIdentity: async () => null });
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


test("passive refresh clears a finished browser turn without starting the next turn early", async () => {
  let now = 0;
  let probe = { browserContext: "user", conversationId: "chat-1", userEpoch: "user-a", assistantTurnKey: "turn-a", title: "Task" };
  const controller = createTurnBudgetController({
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
  assert.equal((await controller.refreshSnapshot()).active, null, "passive status polling must not start a new budget before first Local use");
  await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  assert.equal(controller.snapshot().active.elapsedMs, 0);
});

test("passive refresh preserves browser timer when identity probing is temporarily unavailable", async () => {
  let now = 0;
  let probe = { browserContext: "user", conversationId: "chat-1", userEpoch: "user-a", assistantTurnKey: "turn-a" };
  const controller = createTurnBudgetController({ now: () => now, resolveTurnIdentity: async () => probe });
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
  const controller = createTurnBudgetController({ now: () => now, resolveTurnIdentity: async () => probe });
  await controller.initialize();
  await controller.prepareInvocation("runtime_call", { operation: "status", arguments: {} });
  now = 20_000;
  probe = { browserContext: "user", conversationId: "chat-1", userEpoch: "user-b", assistantTurnKey: "turn-b" };
  assert.equal((await controller.refreshSnapshot()).active, null);
});
