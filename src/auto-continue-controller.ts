type BrowserContext = "agent" | "user";
type BrowserInstance = {
  ready?: boolean;
  extension?: { instanceId?: string; capabilityVersions?: { autoContinue?: number } };
  host?: { instanceId?: string };
};
type BrowserTarget = {
  browserContext: BrowserContext;
  browserInstanceId: string;
  mode: string;
  tabId: number;
  conversationId: string;
  canonicalUrl: string;
  title?: string | undefined;
  userEpoch: string;
  assistantTurnKey: string;
  autoContinueVersion?: number | undefined;
};
type BoundChat = Pick<BrowserTarget, "browserContext" | "browserInstanceId" | "tabId" | "conversationId" | "canonicalUrl">;
type Continuation = {
  continuationId: string;
  status: string;
  expiresAt: string;
  checkpointRevision: number;
  target: BrowserTarget | null;
  chainId: string | null;
  hop: number;
};
type Task = {
  taskId: string;
  status: string;
  title: string;
  chatBinding: BoundChat | null;
  continuation: Continuation | null;
};
type TargetResponse = {
  mode?: string;
  status?: string;
  reason?: string;
  target?: Partial<BrowserTarget> & {generationActive?: boolean};
};
type BrowserTab = {id?: unknown; tabId?: unknown; url?: string};
type InspectedTurn = {
  conversationId?: string;
  userEpoch?: string;
  assistantTurnKey?: string;
  generationActive?: boolean;
  composerReady?: boolean;
  composerEmpty?: boolean;
  title?: string;
};
type CapsuleStore = {
  readInternal: (taskId: string) => Promise<Task>;
  read: (taskId: string) => Promise<unknown>;
  bindChat: (args: {taskId: string; binding: BoundChat}) => Promise<unknown>;
  armContinuation: (args: {taskId: string; ttlMinutes: number; chainId: string | null; hop: number; target: BrowserTarget}) => Promise<Task>;
  cancelContinuation: (taskId: string, reason: string) => Promise<unknown>;
  expireContinuation: (taskId: string, continuationId: string) => Promise<unknown>;
  reserveContinuationDelivery: (taskId: string, continuationId: string) => Promise<unknown>;
  settleContinuationDelivery: (taskId: string, continuationId: string, status: string, reason?: string) => Promise<unknown>;
  reconcileContinuationsAfterRestart: () => Promise<{resumable: Task[]; retired: unknown[]}>;
};
type BrowserBridge = {
  snapshot: () => {contexts?: Record<string, BrowserInstance>};
  call: (method: string, args: object, opts: {context: string; timeoutMs: number}) => Promise<unknown>;
};
type AgentControl = {
  snapshot: () => {paused: boolean};
  assertMutationAllowed: (reason: string) => void;
};
type AutoContinueEvent = {
  component: string; type: string; severity: string; status: string; message: string;
  details: Record<string, unknown>;
};
type ControllerOptions = {
  store: CapsuleStore;
  browserBridge: BrowserBridge;
  agentControl: AgentControl;
  onEvent?: ((event: AutoContinueEvent) => unknown) | null;
  now?: () => number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  pollMs?: number;
  quietMs?: number;
  getMaxChainHops?: () => number;
};
type AutoContinueController = {
  arm: (args: {taskId: string; ttlMinutes?: number}) => Promise<Task>;
  armBound: (args: {taskId: string; ttlMinutes?: number}) => Promise<Task>;
  cancel: (taskId: string, reason?: string) => Promise<unknown>;
  start: () => Promise<{resumed: number; retired: number}>;
  shutdown: () => Promise<void>;
  resolveTarget: () => Promise<BrowserTarget>;
  resolveBoundTarget: (taskId: string) => Promise<BrowserTarget>;
  captureBinding: (taskId: string) => Promise<unknown>;
};

const REQUIRED_AUTO_CONTINUE_VERSION = 1;
const DEFAULT_POLL_MS = 600;
const DEFAULT_QUIET_MS = 1_200;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function continuationPrompt(taskId: string, checkpointRevision: number): string {
  return [
    `Continue task ${taskId} from checkpoint ${checkpointRevision}.`,
    "Read the latest Task Capsule from Equinox Local, follow its current objective and next steps, and continue from the safe checkpoint.",
    "Do not repeat completed work.",
  ].join(" ");
}

function extensionAutoContinueVersion(contextSnapshot: BrowserInstance | undefined): number {
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
  getMaxChainHops = () => 10,
}: ControllerOptions = {} as ControllerOptions): AutoContinueController {
  if (!store || !browserBridge?.call || !browserBridge?.snapshot || !agentControl?.snapshot || !agentControl?.assertMutationAllowed) {
    throw new Error("Auto Continue controller dependencies are missing.");
  }
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const quietSince = new Map<string, number>();
  const activeDeliveries = new Set<string>();
  const inFlightTicks = new Set<Promise<void>>();
  let stopped = false;

  const emit = (event: AutoContinueEvent): void => {
    if (typeof onEvent === "function") void Promise.resolve(onEvent(event)).catch(() => {});
  };

  const clearMonitor = (continuationId: string): void => {
    const timer = timers.get(continuationId);
    if (timer) clearTimeoutImpl(timer);
    timers.delete(continuationId);
    quietSince.delete(continuationId);
  };

  const schedule = (taskId: string, continuationId: string, delayMs = pollMs): void => {
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

  const callContext = async (context: string, method: string, args: object, timeoutMs = 5_000): Promise<unknown> => (
    browserBridge.call(method, args, { context, timeoutMs })
  );

  const resolveTarget = async (): Promise<BrowserTarget> => {
    const snapshot = browserBridge.snapshot();
    const contexts: {context: BrowserContext; instanceId: string | null; result: TargetResponse}[] = [];
    const outdated: BrowserContext[] = [];
    for (const context of ["agent", "user"] as const) {
      const state = snapshot?.contexts?.[context];
      if (!state?.ready) continue;
      if (extensionAutoContinueVersion(state) < REQUIRED_AUTO_CONTINUE_VERSION) {
        outdated.push(context);
        continue;
      }
      try {
        const result = await callContext(context, "continuation.target.resolve", {}) as TargetResponse;
        contexts.push({ context, instanceId: state.extension?.instanceId || state.host?.instanceId || null, result });
      } catch (error) {
        contexts.push({ context, instanceId: state.extension?.instanceId || null, result: { mode: "task-tab", status: "error", reason: errorMessage(error) } });
      }
    }

    const pinned = contexts.filter((item) => item.result?.mode === "pinned");
    if (pinned.length > 1) throw new Error("Auto Continue is pinned in more than one Chrome profile. Keep only one explicit pin.");
    let selected: (typeof contexts)[number] | null = null;
    if (pinned.length === 1) {
      if (pinned[0]!.result?.status !== "ready") {
        throw new Error(`Pinned Auto Continue target is not ready: ${pinned[0]!.result?.reason || pinned[0]!.result?.status || "unknown"}.`);
      }
      selected = pinned[0]!;
    } else {
      const ready = contexts.filter((item) => item.result?.mode === "task-tab" && item.result?.status === "ready");
      if (ready.length !== 1) {
        if (ready.length > 1) throw new Error("More than one Chrome profile has a generating ChatGPT task. Pin the intended conversation in the extension popup.");
        if (outdated.length > 0 && contexts.length === 0) throw new Error("Auto Continue requires the current Equinox Browser extension in the active Chrome profile.");
        throw new Error("Auto Continue could not identify exactly one generating ChatGPT conversation. Keep the task response generating, or pin its tab in the extension popup.");
      }
      selected = ready[0]!;
    }

    const target = selected!.result?.target;
    if (!target || !target.generationActive || !target.userEpoch || !target.assistantTurnKey || !selected.instanceId) {
      throw new Error("Auto Continue target did not provide a complete generation identity.");
    }
    return {
      browserContext: selected!.context,
      browserInstanceId: selected!.instanceId!,
      mode: selected!.result.mode!,
      tabId: target.tabId!,
      conversationId: target.conversationId!,
      canonicalUrl: target.canonicalUrl!,
      title: target.title,
      userEpoch: target.userEpoch!,
      assistantTurnKey: target.assistantTurnKey!,
      autoContinueVersion: target.autoContinueVersion,
    };
  };

  const reacquireBoundTab = async ({ context, conversationId }: {context: BrowserContext; conversationId: string}): Promise<{tabId: number; canonicalUrl: string}> => {
    const tabs = await callContext(context, "tabs.list", {}, 5_000) as BrowserTab[];
    const matches = (Array.isArray(tabs) ? tabs : []).filter((tab) => {
      try {
        const url = new URL(String(tab?.url || ""));
        const match = url.pathname.match(/\/c\/([^/]+)\/?$/u);
        return match?.[1] === conversationId;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) {
      if (matches.length > 1) throw new Error("More than one ChatGPT tab matches the task's exact conversation; Auto Continue will not guess.");
      throw new Error("The task's bound ChatGPT conversation is not open in the expected Browser context.");
    }
    const tabId = Number(matches[0]?.id ?? matches[0]?.tabId);
    if (!Number.isInteger(tabId) || tabId < 1) throw new Error("The reacquired ChatGPT tab id is invalid.");
    return { tabId, canonicalUrl: String(matches[0]?.url || "") };
  };

  const resolveBoundTarget = async (taskId: string): Promise<BrowserTarget> => {
    const task = await store.readInternal(taskId);
    const binding = task.chatBinding || task.continuation?.target || null;
    if (!binding) return resolveTarget();
    const snapshot = browserBridge.snapshot();
    const contextState = snapshot?.contexts?.[binding.browserContext];
    if (!contextState?.ready) throw new Error("The task's bound ChatGPT browser context is not connected.");
    const instanceId = contextState.extension?.instanceId || contextState.host?.instanceId || null;
    if (!instanceId || instanceId !== binding.browserInstanceId) throw new Error("The task's bound ChatGPT browser instance changed. Open the task conversation and checkpoint it again.");
    const autoContinueVersion = extensionAutoContinueVersion(contextState);
    if (autoContinueVersion < REQUIRED_AUTO_CONTINUE_VERSION) throw new Error("The task's bound browser needs the current Equinox Browser Auto Continue capability.");
    let tabId = binding.tabId;
    let canonicalUrl = binding.canonicalUrl;
    let inspected: InspectedTurn | null = null;
    try {
      inspected = await callContext(binding.browserContext, "continuation.inspect", { tabId }) as InspectedTurn;
    } catch {
      inspected = null;
    }
    if (inspected?.conversationId !== binding.conversationId) {
      const reacquired = await reacquireBoundTab({ context: binding.browserContext, conversationId: binding.conversationId });
      tabId = reacquired.tabId;
      canonicalUrl = reacquired.canonicalUrl || canonicalUrl;
      inspected = await callContext(binding.browserContext, "continuation.inspect", { tabId }) as InspectedTurn;
      if (inspected?.conversationId !== binding.conversationId) throw new Error("The reacquired ChatGPT tab no longer contains the expected conversation.");
      await store.bindChat({ taskId, binding: {
        browserContext: binding.browserContext,
        browserInstanceId: instanceId,
        tabId,
        conversationId: binding.conversationId,
        canonicalUrl,
      } });
    }
    if (!inspected?.userEpoch || !inspected?.assistantTurnKey) throw new Error("The task's bound ChatGPT conversation does not expose a complete turn identity yet.");
    return {
      browserContext: binding.browserContext,
      browserInstanceId: instanceId,
      mode: "task-tab",
      tabId,
      conversationId: binding.conversationId,
      canonicalUrl,
      title: inspected.title || task.title || "ChatGPT",
      userEpoch: inspected.userEpoch,
      assistantTurnKey: inspected.assistantTurnKey,
      autoContinueVersion,
    };
  };

  const captureBinding = async (taskId: string): Promise<unknown> => {
    try {
      const target = await resolveTarget();
      return await store.bindChat({ taskId, binding: { browserContext: target.browserContext, browserInstanceId: target.browserInstanceId, tabId: target.tabId, conversationId: target.conversationId, canonicalUrl: target.canonicalUrl } });
    } catch {
      return store.read(taskId);
    }
  };

  const cancelForReason = async (taskId: string, continuationId: string, reason: string): Promise<void> => {
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

  const tick = async (taskId: string, continuationId: string): Promise<void> => {
    if (stopped) return;
    let task: Task;
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

    let state: InspectedTurn | null;
    try {
      state = await callContext(target.browserContext, "continuation.inspect", { tabId: target.tabId }) as InspectedTurn;
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
      let result: {confirmed?: boolean; duplicatePrevented?: boolean};
      try {
        result = await callContext(target.browserContext, "continuation.deliver", {
          continuationId,
          tabId: target.tabId!,
          conversationId: target.conversationId!,
          userEpoch: target.userEpoch!,
          assistantTurnKey: target.assistantTurnKey!,
          prompt: continuationPrompt(taskId, continuation.checkpointRevision),
        }, 10_000) as {confirmed?: boolean; duplicatePrevented?: boolean};
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

  const armWithResolver = async ({ taskId, ttlMinutes = 15, resolver }: {taskId: string; ttlMinutes?: number; resolver: (taskId: string) => Promise<BrowserTarget>}): Promise<Task> => {
    agentControl.assertMutationAllowed("continuation_arm");
    const task = await store.readInternal(taskId);
    if (task.status !== "active") throw new Error("Only an active Task Capsule can arm Auto Continue.");
    const previous = task.continuation;
    const continuingChain = previous?.status === "delivered" && previous.chainId;
    const hop = continuingChain ? previous.hop + 1 : 1;
    const maxChainHops = getMaxChainHops();
    if (!Number.isInteger(maxChainHops) || maxChainHops < 1 || maxChainHops > 20) throw new Error("Auto Continue max-hop setting is invalid.");
    if (hop > maxChainHops) throw new Error(`Auto Continue chain reached the ${maxChainHops}-turn safety limit. Arm a new task/checkpoint chain explicitly.`);
    const target = await resolver(taskId);
    const armed = await store.armContinuation({ taskId, ttlMinutes, chainId: continuingChain ? previous.chainId : null, hop, target });
    schedule(taskId, armed.continuation!.continuationId);
    return armed;
  };
  const arm = async ({ taskId, ttlMinutes = 15 }: {taskId: string; ttlMinutes?: number} = {} as {taskId:string}) => armWithResolver({ taskId, ttlMinutes, resolver: async () => resolveTarget() });
  const armBound = async ({ taskId, ttlMinutes = 15 }: {taskId: string; ttlMinutes?: number} = {} as {taskId:string}) => armWithResolver({ taskId, ttlMinutes, resolver: resolveBoundTarget });

  const cancel = async (taskId: string, reason = "agent_cancelled"): Promise<unknown> => {
    const current = await store.readInternal(taskId);
    if (current.continuation?.continuationId) clearMonitor(current.continuation.continuationId);
    return store.cancelContinuation(taskId, reason);
  };

  const start = async (): Promise<{resumed: number; retired: number}> => {
    stopped = false;
    const reconciled = await store.reconcileContinuationsAfterRestart();
    for (const task of reconciled.resumable) {
      if (task.continuation?.continuationId) schedule(task.taskId, task.continuation.continuationId);
    }
    return { resumed: reconciled.resumable.length, retired: reconciled.retired.length };
  };

  const shutdown = async (): Promise<void> => {
    stopped = true;
    for (const continuationId of [...timers.keys()]) clearMonitor(continuationId);
    await Promise.allSettled([...inFlightTicks]);
  };

  return Object.freeze({ arm, armBound, cancel, start, shutdown, resolveTarget, resolveBoundTarget, captureBinding });
}
