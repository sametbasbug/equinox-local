const REQUIRED_AUTO_CONTINUE_VERSION = 1;
const DEFAULT_POLL_MS = 600;
const DEFAULT_QUIET_MS = 1_200;
const MAX_CHAIN_HOPS = 3;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function continuationPrompt(taskId, checkpointRevision) {
  return [
    `Continue task ${taskId} from checkpoint ${checkpointRevision}.`,
    "Read the latest Task Capsule from Equinox Local, follow its current objective and next steps, and continue from the safe checkpoint.",
    "Do not repeat completed work.",
  ].join(" ");
}

function extensionAutoContinueVersion(contextSnapshot) {
  return Number(contextSnapshot?.extension?.capabilityVersions?.autoContinue) || 0;
}

export function createAutoContinueController({
  store,
  browserBridge,
  agentControl,
  onEvent = null,
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  pollMs = DEFAULT_POLL_MS,
  quietMs = DEFAULT_QUIET_MS,
} = {}) {
  if (!store || !browserBridge?.call || !browserBridge?.snapshot || !agentControl?.snapshot || !agentControl?.assertMutationAllowed) {
    throw new Error("Auto Continue controller dependencies are missing.");
  }
  const timers = new Map();
  const quietSince = new Map();
  const activeDeliveries = new Set();
  const inFlightTicks = new Set();
  let stopped = false;

  const emit = (event) => {
    if (typeof onEvent === "function") void Promise.resolve(onEvent(event)).catch(() => {});
  };

  const clearMonitor = (continuationId) => {
    const timer = timers.get(continuationId);
    if (timer) clearTimeoutImpl(timer);
    timers.delete(continuationId);
    quietSince.delete(continuationId);
  };

  const schedule = (taskId, continuationId, delayMs = pollMs) => {
    if (stopped || timers.has(continuationId)) return;
    const timer = setTimeoutImpl(() => {
      timers.delete(continuationId);
      const run = Promise.resolve().then(() => tick(taskId, continuationId));
      inFlightTicks.add(run);
      void run.then(
        () => inFlightTicks.delete(run),
        () => inFlightTicks.delete(run),
      );
    }, delayMs);
    timer?.unref?.();
    timers.set(continuationId, timer);
  };

  const callContext = async (context, method, args, timeoutMs = 5_000) => (
    browserBridge.call(method, args, { context, timeoutMs })
  );

  const resolveTarget = async () => {
    const snapshot = browserBridge.snapshot();
    const contexts = [];
    const outdated = [];
    for (const context of ["agent", "user"]) {
      const state = snapshot?.contexts?.[context];
      if (!state?.ready) continue;
      if (extensionAutoContinueVersion(state) < REQUIRED_AUTO_CONTINUE_VERSION) {
        outdated.push(context);
        continue;
      }
      try {
        const result = await callContext(context, "continuation.target.resolve", {});
        contexts.push({ context, instanceId: state.extension?.instanceId || state.host?.instanceId || null, result });
      } catch (error) {
        contexts.push({ context, instanceId: state.extension?.instanceId || null, result: { mode: "task-tab", status: "error", reason: errorMessage(error) } });
      }
    }

    const pinned = contexts.filter((item) => item.result?.mode === "pinned");
    if (pinned.length > 1) throw new Error("Auto Continue is pinned in more than one Chrome profile. Keep only one explicit pin.");
    let selected = null;
    if (pinned.length === 1) {
      if (pinned[0].result?.status !== "ready") {
        throw new Error(`Pinned Auto Continue target is not ready: ${pinned[0].result?.reason || pinned[0].result?.status || "unknown"}.`);
      }
      selected = pinned[0];
    } else {
      const ready = contexts.filter((item) => item.result?.mode === "task-tab" && item.result?.status === "ready");
      if (ready.length !== 1) {
        if (ready.length > 1) throw new Error("More than one Chrome profile has a generating ChatGPT task. Pin the intended conversation in the extension popup.");
        if (outdated.length > 0 && contexts.length === 0) throw new Error("Auto Continue requires the current Equinox Browser extension in the active Chrome profile.");
        throw new Error("Auto Continue could not identify exactly one generating ChatGPT conversation. Keep the task response generating, or pin its tab in the extension popup.");
      }
      selected = ready[0];
    }

    const target = selected.result?.target;
    if (!target || !target.generationActive || !target.userEpoch || !target.assistantTurnKey || !selected.instanceId) {
      throw new Error("Auto Continue target did not provide a complete generation identity.");
    }
    return {
      browserContext: selected.context,
      browserInstanceId: selected.instanceId,
      mode: selected.result.mode,
      tabId: target.tabId,
      conversationId: target.conversationId,
      canonicalUrl: target.canonicalUrl,
      title: target.title,
      userEpoch: target.userEpoch,
      assistantTurnKey: target.assistantTurnKey,
      autoContinueVersion: target.autoContinueVersion,
    };
  };

  const cancelForReason = async (taskId, continuationId, reason) => {
    clearMonitor(continuationId);
    try {
      const current = await store.readInternal(taskId);
      if (current.continuation?.continuationId === continuationId && current.continuation.status === "armed") {
        await store.cancelContinuation(taskId, reason);
      }
    } catch {
      // Task may have been completed or cancelled by the human.
    }
  };

  const tick = async (taskId, continuationId) => {
    if (stopped) return;
    let task;
    try {
      task = await store.readInternal(taskId);
    } catch {
      clearMonitor(continuationId);
      return;
    }
    const continuation = task.continuation;
    if (!continuation || continuation.continuationId !== continuationId || continuation.status !== "armed") {
      clearMonitor(continuationId);
      return;
    }
    if (Date.parse(continuation.expiresAt) <= now()) {
      await store.expireContinuation(taskId, continuationId).catch(() => {});
      clearMonitor(continuationId);
      return;
    }
    if (agentControl.snapshot().paused) {
      await cancelForReason(taskId, continuationId, "agent_paused");
      return;
    }
    const target = continuation.target;
    if (!target) {
      await cancelForReason(taskId, continuationId, "missing_browser_target");
      return;
    }

    let state;
    try {
      state = await callContext(target.browserContext, "continuation.inspect", { tabId: target.tabId });
    } catch {
      await cancelForReason(taskId, continuationId, "browser_target_unavailable");
      return;
    }
    if (state?.conversationId !== target.conversationId) {
      await cancelForReason(taskId, continuationId, "conversation_changed");
      return;
    }
    if (state?.userEpoch !== target.userEpoch) {
      await cancelForReason(taskId, continuationId, "human_interruption");
      return;
    }
    if (state?.assistantTurnKey !== target.assistantTurnKey) {
      await cancelForReason(taskId, continuationId, "assistant_turn_changed");
      return;
    }
    if (state?.generationActive) {
      quietSince.delete(continuationId);
      schedule(taskId, continuationId);
      return;
    }
    if (!state?.composerReady || !state?.composerEmpty) {
      await cancelForReason(taskId, continuationId, "composer_not_empty");
      return;
    }

    const firstQuietAt = quietSince.get(continuationId);
    if (!firstQuietAt) {
      quietSince.set(continuationId, now());
      schedule(taskId, continuationId, quietMs);
      return;
    }
    const remainingQuiet = quietMs - (now() - firstQuietAt);
    if (remainingQuiet > 0) {
      schedule(taskId, continuationId, Math.max(50, remainingQuiet));
      return;
    }
    if (activeDeliveries.has(target.browserInstanceId)) {
      schedule(taskId, continuationId);
      return;
    }

    activeDeliveries.add(target.browserInstanceId);
    clearMonitor(continuationId);
    try {
      agentControl.assertMutationAllowed("continuation_delivery");
      await store.reserveContinuationDelivery(taskId, continuationId);
      emit({ component: "auto-continue", type: "continuation.delivery_started", severity: "info", status: "delivering", message: "Auto Continue began a guarded ChatGPT delivery.", details: { taskId, browserContext: target.browserContext } });
      let result;
      try {
        result = await callContext(target.browserContext, "continuation.deliver", {
          continuationId,
          tabId: target.tabId,
          conversationId: target.conversationId,
          userEpoch: target.userEpoch,
          assistantTurnKey: target.assistantTurnKey,
          prompt: continuationPrompt(taskId, continuation.checkpointRevision),
        }, 10_000);
      } catch (error) {
        await store.settleContinuationDelivery(taskId, continuationId, "failed", "browser_delivery_ambiguous_error");
        emit({ component: "auto-continue", type: "continuation.delivery_failed", severity: "warn", status: "failed", message: "Auto Continue browser delivery failed and will not be retried.", details: { taskId, error: errorMessage(error).slice(0, 300) } });
        return;
      }
      if (result?.confirmed === true) {
        await store.settleContinuationDelivery(taskId, continuationId, "delivered");
      } else {
        await store.settleContinuationDelivery(taskId, continuationId, "failed", result?.duplicatePrevented ? "duplicate_delivery_prevented" : "browser_delivery_unconfirmed");
      }
    } catch (error) {
      const current = await store.readInternal(taskId).catch(() => null);
      if (current?.continuation?.continuationId === continuationId && current.continuation.status === "delivering") {
        await store.settleContinuationDelivery(taskId, continuationId, "failed", "delivery_guard_failed").catch(() => {});
      }
      emit({ component: "auto-continue", type: "continuation.guard_failed", severity: "warn", status: "failed", message: "Auto Continue stopped at a delivery guard.", details: { taskId, error: errorMessage(error).slice(0, 300) } });
    } finally {
      activeDeliveries.delete(target.browserInstanceId);
    }
  };

  const arm = async ({ taskId, ttlMinutes = 15 } = {}) => {
    agentControl.assertMutationAllowed("continuation_arm");
    const task = await store.readInternal(taskId);
    if (task.status !== "active") throw new Error("Only an active Task Capsule can arm Auto Continue.");
    const previous = task.continuation;
    const continuingChain = previous?.status === "delivered" && previous.chainId;
    const hop = continuingChain ? previous.hop + 1 : 1;
    if (hop > MAX_CHAIN_HOPS) throw new Error(`Auto Continue chain reached the ${MAX_CHAIN_HOPS}-turn safety limit. Arm a new task/checkpoint chain explicitly.`);
    const target = await resolveTarget();
    const armed = await store.armContinuation({
      taskId,
      ttlMinutes,
      chainId: continuingChain ? previous.chainId : null,
      hop,
      target,
    });
    schedule(taskId, armed.continuation.continuationId);
    return armed;
  };

  const cancel = async (taskId, reason = "agent_cancelled") => {
    const current = await store.readInternal(taskId);
    if (current.continuation?.continuationId) clearMonitor(current.continuation.continuationId);
    return store.cancelContinuation(taskId, reason);
  };

  const start = async () => {
    stopped = false;
    const reconciled = await store.reconcileContinuationsAfterRestart();
    for (const task of reconciled.resumable) {
      if (task.continuation?.continuationId) schedule(task.taskId, task.continuation.continuationId);
    }
    return { resumed: reconciled.resumable.length, retired: reconciled.retired.length };
  };

  const shutdown = async () => {
    stopped = true;
    for (const continuationId of [...timers.keys()]) clearMonitor(continuationId);
    await Promise.allSettled([...inFlightTicks]);
  };

  return Object.freeze({ arm, cancel, start, shutdown, resolveTarget });
}
