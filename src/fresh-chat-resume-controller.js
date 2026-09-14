const REQUIRED_FRESH_CHAT_RESUME_VERSION = 1;
const DEFAULT_POLL_MS = 600;
const DEFAULT_QUIET_MS = 1_200;
const FRESH_RESUME_BROWSER_TIMEOUT_MS = 40_000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function freshResumePrompt(taskId, checkpointRevision) {
  return [
    `Continue task ${taskId} from checkpoint ${checkpointRevision} in this fresh chat.`,
    "Read the latest Task Capsule from Equinox Local, follow its current objective, completed work, and next steps, and continue from the safe checkpoint.",
    "Do not repeat completed work and do not depend on the previous chat transcript.",
  ].join(" ");
}

function extensionFreshResumeVersion(contextSnapshot) {
  return Number(contextSnapshot?.extension?.capabilityVersions?.freshChatResume) || 0;
}

export function createFreshChatResumeController({
  store,
  browserBridge,
  autoContinueController,
  agentControl,
  onEvent = null,
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  pollMs = DEFAULT_POLL_MS,
  quietMs = DEFAULT_QUIET_MS,
} = {}) {
  if (!store || !browserBridge?.call || !browserBridge?.snapshot || !autoContinueController?.resolveTarget || !agentControl?.snapshot || !agentControl?.assertMutationAllowed) {
    throw new Error("Fresh Chat Resume controller dependencies are missing.");
  }

  const timers = new Map();
  const quietSince = new Map();
  const activeMutations = new Set();
  const inFlightTicks = new Set();
  let stopped = false;

  const emit = (event) => {
    if (typeof onEvent === "function") void Promise.resolve(onEvent(event)).catch(() => {});
  };

  const clearMonitor = (resumeId) => {
    const timer = timers.get(resumeId);
    if (timer) clearTimeoutImpl(timer);
    timers.delete(resumeId);
    quietSince.delete(resumeId);
  };

  const schedule = (taskId, resumeId, delayMs = pollMs) => {
    if (stopped || timers.has(resumeId)) return;
    const timer = setTimeoutImpl(() => {
      timers.delete(resumeId);
      const run = Promise.resolve().then(() => tick(taskId, resumeId));
      inFlightTicks.add(run);
      void run.then(
        () => inFlightTicks.delete(run),
        () => inFlightTicks.delete(run),
      );
    }, delayMs);
    timer?.unref?.();
    timers.set(resumeId, timer);
  };

  const callContext = async (context, method, args, timeoutMs = 5_000) => (
    browserBridge.call(method, args, { context, timeoutMs })
  );

  const resolveSource = async () => {
    const target = await autoContinueController.resolveTarget();
    const contextState = browserBridge.snapshot()?.contexts?.[target.browserContext];
    const freshChatResumeVersion = extensionFreshResumeVersion(contextState);
    if (freshChatResumeVersion < REQUIRED_FRESH_CHAT_RESUME_VERSION) {
      throw new Error("Fresh Chat Resume requires the current Equinox Browser extension in the selected Chrome profile.");
    }
    const instanceId = contextState?.extension?.instanceId || contextState?.host?.instanceId || null;
    if (!instanceId || instanceId !== target.browserInstanceId) {
      throw new Error("Fresh Chat Resume browser instance changed while resolving the source conversation.");
    }
    return {
      browserContext: target.browserContext,
      browserInstanceId: target.browserInstanceId,
      mode: target.mode,
      tabId: target.tabId,
      conversationId: target.conversationId,
      canonicalUrl: target.canonicalUrl,
      title: target.title,
      userEpoch: target.userEpoch,
      assistantTurnKey: target.assistantTurnKey,
      freshChatResumeVersion,
    };
  };

  const cancelForReason = async (taskId, resumeId, reason) => {
    clearMonitor(resumeId);
    try {
      const current = await store.readInternal(taskId);
      if (current.freshResume?.resumeId === resumeId && current.freshResume.status === "prepared") {
        await store.cancelFreshResume(taskId, reason);
      }
    } catch {
      // Task may have changed or been completed by the human.
    }
  };

  const tick = async (taskId, resumeId) => {
    if (stopped) return;
    let task;
    try {
      task = await store.readInternal(taskId);
    } catch {
      clearMonitor(resumeId);
      return;
    }
    const freshResume = task.freshResume;
    if (!freshResume || freshResume.resumeId !== resumeId || freshResume.status !== "prepared") {
      clearMonitor(resumeId);
      return;
    }
    if (freshResume.checkpointRevision !== task.checkpointRevision) {
      await cancelForReason(taskId, resumeId, "checkpoint_changed");
      return;
    }
    if (agentControl.snapshot().paused) {
      await cancelForReason(taskId, resumeId, "agent_paused");
      return;
    }

    const source = freshResume.source;
    let state;
    try {
      state = await callContext(source.browserContext, "continuation.inspect", { tabId: source.tabId });
    } catch {
      await cancelForReason(taskId, resumeId, "browser_source_unavailable");
      return;
    }
    if (state?.conversationId !== source.conversationId) {
      await cancelForReason(taskId, resumeId, "conversation_changed");
      return;
    }
    if (state?.userEpoch !== source.userEpoch) {
      await cancelForReason(taskId, resumeId, "human_interruption");
      return;
    }
    if (state?.assistantTurnKey !== source.assistantTurnKey) {
      await cancelForReason(taskId, resumeId, "assistant_turn_changed");
      return;
    }
    if (state?.generationActive) {
      quietSince.delete(resumeId);
      schedule(taskId, resumeId);
      return;
    }
    if (!state?.composerReady || !state?.composerEmpty) {
      await cancelForReason(taskId, resumeId, "composer_not_empty");
      return;
    }

    const firstQuietAt = quietSince.get(resumeId);
    if (!firstQuietAt) {
      quietSince.set(resumeId, now());
      schedule(taskId, resumeId, quietMs);
      return;
    }
    const remainingQuiet = quietMs - (now() - firstQuietAt);
    if (remainingQuiet > 0) {
      schedule(taskId, resumeId, Math.max(50, remainingQuiet));
      return;
    }
    if (activeMutations.has(source.browserInstanceId)) {
      schedule(taskId, resumeId);
      return;
    }

    activeMutations.add(source.browserInstanceId);
    clearMonitor(resumeId);
    let mutationReserved = false;
    try {
      agentControl.assertMutationAllowed("fresh_chat_resume");
      await store.reserveFreshResumeMutation(taskId, resumeId);
      mutationReserved = true;
      emit({ component: "fresh-chat-resume", type: "fresh_resume.browser_started", severity: "info", status: "creating", message: "Fresh Chat Resume began one guarded browser transition.", details: { taskId, resumeId, browserContext: source.browserContext } });

      let result;
      try {
        result = await callContext(source.browserContext, "resume.create", {
          resumeId,
          sourceTabId: source.tabId,
          sourceConversationId: source.conversationId,
          prompt: freshResumePrompt(taskId, freshResume.checkpointRevision),
        }, FRESH_RESUME_BROWSER_TIMEOUT_MS);
      } catch (error) {
        await store.settleFreshResume(taskId, resumeId, "ambiguous", { reason: "browser_transition_ambiguous_error" }).catch(() => {});
        emit({ component: "fresh-chat-resume", type: "fresh_resume.browser_failed", severity: "warn", status: "ambiguous", message: "Fresh Chat Resume browser transition failed after mutation reservation and will not retry automatically.", details: { taskId, resumeId, error: errorMessage(error).slice(0, 300) } });
        return;
      }

      if (result?.confirmed === true && Number.isInteger(result.destinationTabId) && result.destinationTabId > 0 && typeof result.destinationConversationId === "string" && typeof result.destinationCanonicalUrl === "string") {
        await store.settleFreshResume(taskId, resumeId, "confirmed", {
          destination: {
            browserContext: source.browserContext,
            browserInstanceId: source.browserInstanceId,
            tabId: result.destinationTabId,
            conversationId: result.destinationConversationId,
            canonicalUrl: result.destinationCanonicalUrl,
          },
        });
        emit({ component: "fresh-chat-resume", type: "fresh_resume.browser_confirmed", severity: "info", status: "confirmed", message: "Fresh Chat Resume confirmed the destination conversation and rebound the task.", details: { taskId, resumeId, browserContext: source.browserContext } });
      } else {
        const reason = result?.duplicatePrevented
          ? "duplicate_transition_prevented"
          : (result?.reason ? `browser_${String(result.reason).slice(0, 120)}` : "browser_transition_unconfirmed");
        await store.settleFreshResume(taskId, resumeId, "ambiguous", { reason }).catch(() => {});
      }
    } catch (error) {
      const current = await store.readInternal(taskId).catch(() => null);
      if (mutationReserved && current?.freshResume?.resumeId === resumeId && current.freshResume.status === "creating") {
        await store.settleFreshResume(taskId, resumeId, "ambiguous", { reason: "resume_guard_failed" }).catch(() => {});
      }
      emit({ component: "fresh-chat-resume", type: "fresh_resume.guard_failed", severity: "warn", status: mutationReserved ? "ambiguous" : "cancelled", message: "Fresh Chat Resume stopped at a guarded transition boundary.", details: { taskId, resumeId, error: errorMessage(error).slice(0, 300) } });
    } finally {
      activeMutations.delete(source.browserInstanceId);
    }
  };

  const prepare = async ({ taskId } = {}) => {
    agentControl.assertMutationAllowed("fresh_chat_resume_prepare");
    const task = await store.readInternal(taskId);
    if (task.status !== "active") throw new Error("Only an active Task Capsule can prepare Fresh Chat Resume.");
    const source = await resolveSource();
    const prepared = await store.prepareFreshResume({ taskId, source });
    schedule(taskId, prepared.freshResume.resumeId);
    return prepared;
  };

  const cancel = async (taskId, reason = "agent_cancelled") => {
    const current = await store.readInternal(taskId);
    if (current.freshResume?.resumeId) clearMonitor(current.freshResume.resumeId);
    return store.cancelFreshResume(taskId, reason);
  };

  const abandon = async (taskId, reason = "agent_abandoned") => {
    const current = await store.readInternal(taskId);
    if (current.freshResume?.resumeId) clearMonitor(current.freshResume.resumeId);
    return store.abandonFreshResume(taskId, reason);
  };

  const cancelAll = async (reason = "emergency_stop") => {
    for (const resumeId of [...timers.keys()]) clearMonitor(resumeId);
    return store.cancelAllFreshResumes(reason);
  };

  const start = async () => {
    stopped = false;
    const reconciled = await store.reconcileFreshResumesAfterRestart();
    for (const task of reconciled.resumable) {
      if (task.freshResume?.resumeId) schedule(task.taskId, task.freshResume.resumeId);
    }
    return { resumed: reconciled.resumable.length, retired: reconciled.retired.length };
  };

  const shutdown = async () => {
    stopped = true;
    for (const resumeId of [...timers.keys()]) clearMonitor(resumeId);
    await Promise.allSettled([...inFlightTicks]);
  };

  return Object.freeze({ prepare, cancel, abandon, cancelAll, start, shutdown, resolveSource });
}
