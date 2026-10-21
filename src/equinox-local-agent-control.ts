export const AGENT_PAUSED_ERROR_CODE = "EQUINOX_LOCAL_PAUSED_BY_USER";

type TerminalItem = Readonly<{sessionId:string;running:boolean}>;
type ProcessItem = Readonly<{processId:string;running:boolean}>;
type StopRequest = Readonly<{force:false;timeoutMs:number;remove:false}>;
type TerminalManager = {
  list:()=>TerminalItem[];
  stop:(request:StopRequest&{sessionId:string})=>Promise<unknown>;
};
type ProcessManager = {
  list:()=>ProcessItem[];
  stop:(request:StopRequest&{processId:string})=>Promise<unknown>;
};
type AgentEvent = {
  component:"agent-control";
  type:"agent.paused_by_user"|"agent.emergency_stop_completed"|"agent.resumed_by_user";
  severity:"warn"|"info";
  status:"paused"|"partial"|"completed"|"active";
  message:string;
  details:Readonly<Record<string,unknown>>;
};
type LastStop = Readonly<{
  at:string|null;reason:string;
  requestedTerminals:number;requestedProcesses:number;failureCount:number;
}>;
type Snapshot = Readonly<{
  state:"PAUSED"|"ACTIVE";
  paused:boolean;
  pausedAt:string|null;
  resumedAt:string|null;
  pauseCount:number;
  activeWork:Readonly<{terminals:number;processes:number;total:number}>;
  lastStop:LastStop|null;
}>;
type AgentControlOptions = {
  terminalManager?:TerminalManager;
  processManager?:ProcessManager;
  onEvent?:(event:AgentEvent)=>Promise<unknown>;
  now?:()=>number;
};

function runningCount(manager:Pick<TerminalManager,"list">|Pick<ProcessManager,"list">):number {
  return manager.list().filter((item) => item.running).length;
}

function pausedError(operationName:string) {
  const error = new Error(
    "Equinox Local was paused by the user. No mutating action was performed. " +
      "Read-only status remains available; ask the user to Resume Agent in Control Center before continuing.",
  );
  return Object.assign(error, {code:AGENT_PAUSED_ERROR_CODE,operation:operationName});
}

export function createAgentControlController({
  terminalManager,
  processManager,
  onEvent = async () => null,
  now = () => Date.now(),
}: AgentControlOptions = {}) {
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
  let pausedAt:string|null = null;
  let resumedAt:string|null = null;
  let pauseCount = 0;
  let lastStop:LastStop|null = null;
  let transition:Promise<Snapshot|void> = Promise.resolve();

  const activeWork = () => Object.freeze({
    terminals: runningCount(terminalManager),
    processes: runningCount(processManager),
    total: runningCount(terminalManager) + runningCount(processManager),
  });

  const snapshot = ():Snapshot => Object.freeze({
    state: paused ? "PAUSED" : "ACTIVE",
    paused,
    pausedAt,
    resumedAt,
    pauseCount,
    activeWork: activeWork(),
    lastStop,
  });

  const assertMutationAllowed = (operationName = "mutation"):void => {
    if (paused) throw pausedError(operationName);
  };

  const pause = async ({ reason = "user_emergency_stop" }:{reason?:string} = {}) => {
    transition = transition.then(async () => {
      if (paused) return snapshot();

      paused = true;
      pausedAt = new Date(now()).toISOString();
      pauseCount += 1;

      const terminals = terminalManager.list().filter((item) => item.running);
      const processes = processManager.list().filter((item) => item.running);
      const failures:string[] = [];

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
