export const AGENT_PAUSED_ERROR_CODE = "EQUINOX_LOCAL_PAUSED_BY_USER";

function runningCount(manager) {
  return manager.list().filter((item) => item.running).length;
}

function pausedError(operationName) {
  const error = new Error(
    "Equinox Local was paused by the user. No mutating action was performed. " +
      "Read-only status remains available; ask the user to Resume Agent in Control Center before continuing.",
  );
  error.code = AGENT_PAUSED_ERROR_CODE;
  error.operation = operationName;
  return error;
}

export function createAgentControlController({
  terminalManager,
  processManager,
  onEvent = async () => null,
  now = () => Date.now(),
} = {}) {
  if (!terminalManager?.list || !terminalManager?.stop) {
    throw new Error("Agent control requires terminalManager list/stop.");
  }
  if (!processManager?.list || !processManager?.stop) {
    throw new Error("Agent control requires processManager list/stop.");
  }
  if (typeof onEvent !== "function") {
    throw new Error("Agent control onEvent must be a function.");
  }

  let paused = false;
  let pausedAt = null;
  let resumedAt = null;
  let pauseCount = 0;
  let lastStop = null;
  let transition = Promise.resolve();

  const activeWork = () => Object.freeze({
    terminals: runningCount(terminalManager),
    processes: runningCount(processManager),
    total: runningCount(terminalManager) + runningCount(processManager),
  });

  const snapshot = () => Object.freeze({
    state: paused ? "PAUSED" : "ACTIVE",
    paused,
    pausedAt,
    resumedAt,
    pauseCount,
    activeWork: activeWork(),
    lastStop,
  });

  const assertMutationAllowed = (operationName = "mutation") => {
    if (paused) throw pausedError(operationName);
  };

  const pause = async ({ reason = "user_emergency_stop" } = {}) => {
    transition = transition.then(async () => {
      if (paused) return snapshot();

      paused = true;
      pausedAt = new Date(now()).toISOString();
      pauseCount += 1;

      const terminals = terminalManager.list().filter((item) => item.running);
      const processes = processManager.list().filter((item) => item.running);
      const failures = [];

      await onEvent({
        component: "agent-control",
        type: "agent.paused_by_user",
        severity: "warn",
        status: "paused",
        message: "Agent execution was paused by the user.",
        details: {
          reason,
          terminalCount: terminals.length,
          processCount: processes.length,
        },
      });

      const results = await Promise.allSettled([
        ...terminals.map((item) => terminalManager.stop({
          sessionId: item.sessionId,
          force: false,
          timeoutMs: 1_200,
          remove: false,
        })),
        ...processes.map((item) => processManager.stop({
          processId: item.processId,
          force: false,
          timeoutMs: 1_500,
          remove: false,
        })),
      ]);

      for (const result of results) {
        if (result.status === "rejected") {
          failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
        }
      }

      lastStop = Object.freeze({
        at: pausedAt,
        reason,
        requestedTerminals: terminals.length,
        requestedProcesses: processes.length,
        failureCount: failures.length,
      });

      await onEvent({
        component: "agent-control",
        type: "agent.emergency_stop_completed",
        severity: failures.length > 0 ? "warn" : "info",
        status: failures.length > 0 ? "partial" : "completed",
        message: failures.length > 0
          ? "Agent emergency stop completed with cleanup warnings."
          : "Agent emergency stop completed.",
        details: lastStop,
      });

      return snapshot();
    });
    return transition;
  };

  const resume = async () => {
    transition = transition.then(async () => {
      if (!paused) return snapshot();
      paused = false;
      resumedAt = new Date(now()).toISOString();
      await onEvent({
        component: "agent-control",
        type: "agent.resumed_by_user",
        severity: "info",
        status: "active",
        message: "Agent execution was resumed by the user.",
        details: { resumedAt },
      });
      return snapshot();
    });
    return transition;
  };

  return Object.freeze({
    snapshot,
    pause,
    resume,
    assertMutationAllowed,
  });
}
