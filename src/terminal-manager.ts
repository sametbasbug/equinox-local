import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { assertProcessOwnershipImplemented, createTerminalProcessOwnershipAdapter } from "./equinox-local-process-ownership.js";

type Pty={pid:number;_pty?:string;write:(data:string)=>unknown;resize:(cols:number,rows:number)=>unknown;kill:(signal?:string)=>unknown;onData:(fn:(data:string)=>void)=>unknown;onExit:(fn:(info:{exitCode?:number;signal?:number})=>void)=>unknown};
type PtySpawn=(shell:string,args:string[],opts:{name:string;cols:number;rows:number;cwd:string;env:NodeJS.ProcessEnv;handleFlowControl:boolean})=>Pty;
type PtyModule={spawn?:PtySpawn;default?:{spawn?:PtySpawn}};
type Lease={assign?:(pid:number)=>Promise<unknown>;status?:()=>Promise<unknown>;terminate?:(code:number)=>Promise<unknown>;close?:()=>Promise<unknown>};
type Owner={kind:string;implemented?:boolean;requiresVerifiedOwnership?:boolean;gracefulSignal:string;forceSignal:string;createOwnedSet?:(()=>Promise<Lease>);spawnSpec?:(shell:string,args:readonly string[],env:NodeJS.ProcessEnv)=>{command:string;args:readonly string[];env:NodeJS.ProcessEnv;readyMarker?:string};attachAndRelease?:(lease:Lease|null,pty:Pty)=>Promise<unknown>;ownedSetExists:(lease:Lease)=>Promise<boolean>|boolean;signalOwnedSet?:(lease:Lease,signal:string)=>Promise<unknown>;closeOwnedSet?:(lease:Lease|null)=>Promise<unknown>};
type TerminalEvent={component:string;type:string;severity:string;status:string;projectId?:string;correlationId?:string;message:string;details:Record<string,unknown>};
type Waiter={resolve:()=>void;timer:ReturnType<typeof setTimeout>};
type Session={
 id:string;label:string;projectId:string;projectName:string;cwd:string;shell:string;pid:number|null;
 terminal:Pty;ownedSet:Lease|null;running:boolean;cols:number;rows:number;createdAt:number;lastActivityAt:number;exitedAt:number|null;exitCode:number|null;signal:number|string|null;
 buffer:string;baseCursor:number;totalCursor:number;droppedChars:number;bufferDropNotified:boolean;stopRequested:boolean;shellExited:boolean;
 ttyName:string|null;ttyPromise:Promise<string|null>|null;posixSessionId:number|null;ownedPids:Set<number>;ownershipSnapshotAt:number|null;ownershipError:string|null;
 ownershipRefreshTimer:ReturnType<typeof setTimeout>|null;ownershipMonitorTimer:ReturnType<typeof setTimeout>|null;
 cleanupVerified:boolean|null;cleanupError:string|null;cleanupPromise:Promise<ReturnType<typeof publicSession>>|null;transportDisposed:boolean;
 startupMarker:string|null;startupBuffer:string;startupReady:boolean;startupFailure:string|null;startupReadyPromise:Promise<void>|null;resolveStartupReady:(()=>void)|null;
 waiters:Set<Waiter>;exitPromise:Promise<void>|null;resolveExit:(()=>void)|null;
};
type ManagerOptions={
 platform?:string;arch?:string;ownershipAdapter?:Owner|null;ptyModuleLoader?:()=>Promise<PtyModule>;
 now?:()=>number;randomId?:()=>string;maxActiveSessions?:number;maxRetainedSessions?:number;maxBufferChars?:number;
 resolveProcessTtyImpl?:(pid:number|null)=>Promise<string|null>;listTtyProcessPidsImpl?:(tty:string)=>Promise<number[]|null>;
 pidExistsImpl?:(pid:number)=>boolean;killImpl?:(pid:number,signal:string|number)=>unknown;
 ownershipRefreshDelayMs?:number;ownershipMonitorMs?:number;naturalExitOwnershipFreshMs?:number;windowsPtyReadyTimeoutMs?:number;
 nativeProcessSessionHelperPath?:string|null;resolveProcessSessionIdImpl?:((pid:number|null)=>Promise<number|null>)|null;
 listProcessSessionPidsImpl?:((sessionId:number)=>Promise<number[]>)|null;
 onEvent?:((event:TerminalEvent)=>unknown)|null;
};
type StartOptions={projectId:string;projectName:string;cwd:string;shell?:string;shellArgs?:string[];env?:NodeJS.ProcessEnv;cols?:number;rows?:number;label?:string};
type ReadOptions={sessionId:string;cursor?:number|null;maxChars?:number;stripAnsiCodes?:boolean;waitMs?:number};
type WriteOptions={sessionId:string;data?:string;key?:string};
type ResizeOptions={sessionId:string;cols:number;rows:number};
type StopOptions={sessionId:string;force?:boolean;timeoutMs?:number;remove?:boolean};
type CodedError={code?:string};

const execFile = promisify(execFileCallback);

const DEFAULT_MAX_ACTIVE_SESSIONS = 8;
const DEFAULT_MAX_RETAINED_SESSIONS = 24;
const DEFAULT_MAX_BUFFER_CHARS = 2_000_000;
const DEFAULT_READ_MAX_CHARS = 30_000;
const DEFAULT_OWNERSHIP_REFRESH_DELAY_MS = 25;
const DEFAULT_OWNERSHIP_MONITOR_MS = 1_000;
const NATURAL_EXIT_OWNERSHIP_FRESH_MS = 2_500;
const PS_TIMEOUT_MS = 2_000;
const PS_MAX_BUFFER = 512 * 1024;
const NATIVE_SESSION_QUERY_TIMEOUT_MS = 2_000;
const NATIVE_SESSION_QUERY_MAX_BUFFER = 512 * 1024;
const DEFAULT_WINDOWS_PTY_READY_TIMEOUT_MS = 10_000;

export const TERMINAL_KEYS = Object.freeze([
  "enter",
  "ctrl_c",
  "ctrl_d",
  "tab",
  "escape",
  "up",
  "down",
  "left",
  "right",
]);

const KEY_SEQUENCES = Object.freeze({
  enter: "\r",
  ctrl_c: "\u0003",
  ctrl_d: "\u0004",
  tab: "\t",
  escape: "\u001b",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
});


function normalizeTtyName(value:unknown):string|null {
  const tty = String(value ?? "").trim().replace(/^\/dev\//u, "");
  if (!tty || tty === "??" || tty === "?") return null;
  return tty;
}

export function parseDarwinTtyProcessPids(output:unknown,ttyName:unknown):number[] {
  const wanted = normalizeTtyName(ttyName);
  if (!wanted) return [];
  const pids:number[] = [];
  for (const line of String(output ?? "").split(/\r?\n/u)) {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/u);
    if (!match || normalizeTtyName(match[2]) !== wanted) continue;
    const pid = Number.parseInt(match[1]!, 10);
    if (pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

async function defaultResolveProcessTty(pid:number|null):Promise<string|null> {
  if (process.platform !== "darwin") return null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const { stdout = "" } = await execFile(
        "/bin/ps",
        ["-o", "tty=", "-p", String(pid)],
        { timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024, encoding: "utf8" },
      );
      const ttyName = normalizeTtyName(stdout);
      if (ttyName) return ttyName;
    } catch (error) {
      if (attempt === 4) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

async function defaultListTtyProcessPids(ttyName:string):Promise<number[]|null> {
  if (process.platform !== "darwin") return null;
  const { stdout = "" } = await execFile(
    "/bin/ps",
    ["-axo", "pid=,tty="],
    { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, encoding: "utf8" },
  );
  return parseDarwinTtyProcessPids(stdout, ttyName);
}

function defaultPidExists(pid:number):boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as CodedError)?.code === "ESRCH") return false;
    if ((error as CodedError)?.code === "EPERM") return true;
    throw error;
  }
}

function stripAnsi(value:string):string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001bP.*?\u001b\\/gsu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-_]/gu, "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n");
}

function toIso(value:number|null|undefined):string|null {
  return value === null || value === undefined
    ? null
    : new Date(value).toISOString();
}

function publicSession(session:Session) {
  return {
    sessionId: session.id,
    label: session.label,
    projectId: session.projectId,
    projectName: session.projectName,
    cwd: session.cwd,
    shell: session.shell,
    pid: session.pid,
    running: session.running,
    cols: session.cols,
    rows: session.rows,
    createdAt: toIso(session.createdAt),
    lastActivityAt: toIso(session.lastActivityAt),
    exitedAt: toIso(session.exitedAt),
    exitCode: session.exitCode,
    signal: session.signal,
    baseCursor: session.baseCursor,
    cursor: session.totalCursor,
    bufferedChars: session.buffer.length,
    droppedChars: session.droppedChars,
    tty: session.ttyName,
    shellExited: session.shellExited,
    cleanupVerified: session.cleanupVerified,
    cleanupError: session.cleanupError,
  };
}

export function createTerminalManager({
  platform = process.platform,
  arch = process.arch,
  ownershipAdapter = null,
  ptyModuleLoader = () => import("node-pty"),
  now = () => Date.now(),
  randomId = () => randomUUID().slice(0, 8),
  maxActiveSessions = DEFAULT_MAX_ACTIVE_SESSIONS,
  maxRetainedSessions = DEFAULT_MAX_RETAINED_SESSIONS,
  maxBufferChars = DEFAULT_MAX_BUFFER_CHARS,
  resolveProcessTtyImpl = defaultResolveProcessTty,
  listTtyProcessPidsImpl = defaultListTtyProcessPids,
  pidExistsImpl = defaultPidExists,
  killImpl = process.kill.bind(process),
  ownershipRefreshDelayMs = DEFAULT_OWNERSHIP_REFRESH_DELAY_MS,
  ownershipMonitorMs = DEFAULT_OWNERSHIP_MONITOR_MS,
  naturalExitOwnershipFreshMs = NATURAL_EXIT_OWNERSHIP_FRESH_MS,
  windowsPtyReadyTimeoutMs = DEFAULT_WINDOWS_PTY_READY_TIMEOUT_MS,
  nativeProcessSessionHelperPath = process.env.EQUINOX_LOCAL_NATIVE_PROCESS_HELPER ?? null,
  resolveProcessSessionIdImpl = null,
  listProcessSessionPidsImpl = null,
  onEvent = null,
}:ManagerOptions={}) {
  const sessions = new Map<string,Session>();
  const terminalOwnership:Owner = (ownershipAdapter ?? createTerminalProcessOwnershipAdapter({platform,arch})) as Owner;
  let ptyModulePromise:Promise<{spawn:PtySpawn}>|undefined;
  let pendingStarts = 0;

  const nativeSessionHelper = terminalOwnership.kind === "posix-session-or-tty" && typeof nativeProcessSessionHelperPath === "string" && nativeProcessSessionHelperPath.length > 0
    ? nativeProcessSessionHelperPath
    : null;
  const resolveProcessSessionId:((pid:number|null)=>Promise<number|null>)|null = resolveProcessSessionIdImpl ?? (nativeSessionHelper
    ? async (pid) => {
      const { stdout = "" } = await execFile(nativeSessionHelper, ["--internal-process-session-id", String(pid)], {
        timeout: NATIVE_SESSION_QUERY_TIMEOUT_MS,
        maxBuffer: NATIVE_SESSION_QUERY_MAX_BUFFER,
        encoding: "utf8",
      });
      const value = Number.parseInt(String(stdout).trim(), 10);
      return Number.isInteger(value) && value > 0 ? value : null;
    }
    : null);
  const listProcessSessionPids:((sessionId:number)=>Promise<number[]>)|null = listProcessSessionPidsImpl ?? (nativeSessionHelper
    ? async (sessionId) => {
      const { stdout = "" } = await execFile(nativeSessionHelper, ["--internal-process-session-pids", String(sessionId)], {
        timeout: NATIVE_SESSION_QUERY_TIMEOUT_MS,
        maxBuffer: NATIVE_SESSION_QUERY_MAX_BUFFER,
        encoding: "utf8",
      });
      return String(stdout)
        .split(/\r?\n/u)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    }
    : null);

  const emitEvent = (event:TerminalEvent):void => {
    if (typeof onEvent !== "function") {
      return;
    }
    void Promise.resolve(onEvent(event)).catch(() => {});
  };

  const loadPtyModule = async ():Promise<{spawn:PtySpawn}> => {
    if (!ptyModulePromise) {
      ptyModulePromise = Promise.resolve()
        .then(() => ptyModuleLoader())
        .then((module) => {
          const spawn = module?.spawn ?? module?.default?.spawn;

          if (typeof spawn !== "function") {
            throw new Error("node-pty modülü spawn işlevi sunmuyor.");
          }

          return { spawn };
        });
    }

    return ptyModulePromise;
  };

  const getSession = (sessionId:string):Session => {
    const session = sessions.get(sessionId);

    if (!session) {
      throw new Error(`Terminal oturumu bulunamadı: ${sessionId}`);
    }

    return session;
  };

  const notifyWaiters = (session:Session):void => {
    const waiters = [...session.waiters];
    session.waiters.clear();

    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };

  const setOwnershipError = (session:Session,error:unknown):void => {
    session.ownershipError = error instanceof Error ? error.message : String(error);
  };

  const refreshOwnedPids = async (session:Session):Promise<boolean> => {
    try {
      if (terminalOwnership.kind === "job-object") {
        if (!session.ownedSet) return false;
        await terminalOwnership.ownedSetExists(session.ownedSet);
        session.ownershipSnapshotAt = Date.now();
        return true;
      }
      if (session.posixSessionId && listProcessSessionPids) {
        const pids = await listProcessSessionPids(session.posixSessionId);
        if (!Array.isArray(pids)) throw new Error("PTY POSIX-session inventory returned an invalid result.");
        const normalized = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
        if (!session.shellExited && !normalized.includes(session.pid!)) {
          throw new Error("PTY shell disappeared from its POSIX session inventory.");
        }
        session.ownedPids = new Set(normalized);
        session.ownershipSnapshotAt = Date.now();
        return true;
      }

      const ttyName = session.ttyName ?? await session.ttyPromise;
      if (!ttyName) return false;
      const pids = await listTtyProcessPidsImpl(ttyName);
      if (pids === null) return false;
      if (!Array.isArray(pids)) {
        throw new Error("PTY TTY process inventory returned an invalid result.");
      }
      const normalized = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
      if (!session.shellExited && !normalized.includes(session.pid!)) {
        throw new Error("PTY shell disappeared from its controlling TTY inventory.");
      }
      if (!session.shellExited || normalized.includes(session.pid!)) {
        session.ownedPids = new Set(normalized);
        session.ownershipSnapshotAt = Date.now();
      }
      return true;
    } catch (error) {
      setOwnershipError(session, error);
      return false;
    }
  };

  const scheduleOwnershipRefresh = (session:Session):void => {
    if (terminalOwnership.kind === "job-object") return;
    if (session.posixSessionId && listProcessSessionPids) return;
    if (session.shellExited || session.ownershipRefreshTimer) return;
    session.ownershipRefreshTimer = setTimeout(() => {
      session.ownershipRefreshTimer = null;
      void refreshOwnedPids(session);
    }, ownershipRefreshDelayMs);
    session.ownershipRefreshTimer.unref?.();
  };

  const scheduleOwnershipMonitor = (session:Session):void => {
    if (terminalOwnership.kind === "job-object") return;
    if (session.posixSessionId && listProcessSessionPids) return;
    if (
      session.shellExited ||
      !session.running ||
      !session.ttyName ||
      session.ownershipMonitorTimer
    ) {
      return;
    }
    session.ownershipMonitorTimer = setTimeout(() => {
      session.ownershipMonitorTimer = null;
      if (session.shellExited || !session.running) return;
      void refreshOwnedPids(session).finally(() => {
        scheduleOwnershipMonitor(session);
      });
    }, ownershipMonitorMs);
    session.ownershipMonitorTimer.unref?.();
  };

  const signalPid = (pid:number,signal:string):boolean => {
    try {
      killImpl(pid, signal);
      return true;
    } catch (error) {
      if ((error as CodedError)?.code === "ESRCH") return false;
      throw error;
    }
  };

  const finalizeSession = (session:Session):void => {
    if (!session.running) return;
    if (session.ownershipRefreshTimer) {
      clearTimeout(session.ownershipRefreshTimer);
      session.ownershipRefreshTimer = null;
    }
    if (session.ownershipMonitorTimer) {
      clearTimeout(session.ownershipMonitorTimer);
      session.ownershipMonitorTimer = null;
    }
    session.running = false;
    session.exitedAt = now();
    session.lastActivityAt = session.exitedAt;
    notifyWaiters(session);
    session.resolveExit?.();
    if (session.ownedSet && typeof terminalOwnership.closeOwnedSet === "function") {
      const ownedSet = session.ownedSet;
      session.ownedSet = null;
      void Promise.resolve(terminalOwnership.closeOwnedSet(ownedSet)).catch(() => {});
    }

    const failed = Boolean(
      !session.stopRequested &&
      ((session.exitCode !== null && session.exitCode !== 0) || session.signal),
    );
    emitEvent({
      component: "terminal",
      type: failed ? "terminal.unexpected_exit" : "terminal.exited",
      severity: failed ? "warn" : "info",
      status: failed ? "degraded" : "completed",
      projectId: session.projectId,
      correlationId: session.id,
      message: failed
        ? "PTY terminal session ended unexpectedly."
        : "PTY terminal session ended.",
      details: {
        sessionId: session.id,
        label: session.label,
        exitCode: session.exitCode,
        signal: session.signal,
        stopRequested: session.stopRequested,
        cleanupVerified: session.cleanupVerified,
      },
    });
  };

  const trackedDescendants = (session:Session):number[] => [...session.ownedPids]
    .filter((pid) => pid !== session.pid && pidExistsImpl(pid));

  const signalTrackedOwnership = (session:Session,signal:string):void => {
    for (const pid of trackedDescendants(session)) {
      signalPid(pid, signal);
    }
    if (!session.shellExited) session.terminal.kill(signal);
  };

  const waitForTrackedOwnershipDrain = async (session:Session,timeoutMs:number):Promise<boolean> => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      if (session.posixSessionId && listProcessSessionPids) {
        const refreshed = await refreshOwnedPids(session);
        if (!refreshed) return false;
      }
      const liveDescendants = trackedDescendants(session);
      if (session.shellExited && liveDescendants.length === 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const waitForJobObjectDrain = async (session:Session,timeoutMs:number):Promise<boolean> => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      if (!session.ownedSet || !await terminalOwnership.ownedSetExists(session.ownedSet)) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const disposeJobObjectTerminalTransport = (session:Session):void => {
    if (terminalOwnership.kind !== "job-object" || session.transportDisposed) return;
    session.transportDisposed = true;
    // Job Object ownership is responsible for process-tree termination. This
    // signal-free node-pty call only releases its ConPTY/socket/worker handles.
    session.terminal.kill();
  };

  const cleanupOwnedSession = (session:Session,{
    force = false,
    timeoutMs = 1500,
    naturalExit = false,
  }:{force?:boolean;timeoutMs?:number;naturalExit?:boolean}={}):Promise<ReturnType<typeof publicSession>> => {
    if (session.cleanupPromise) return session.cleanupPromise;

    session.cleanupPromise = (async () => {
      session.cleanupError = null;
      try {
        if (terminalOwnership.kind === "job-object") {
          if (!session.ownedSet) throw new Error("Windows PTY Job Object ownership handle is missing.");
          await refreshOwnedPids(session);
          if (await terminalOwnership.ownedSetExists(session.ownedSet)) {
            await terminalOwnership.signalOwnedSet!(
              session.ownedSet,
              force ? terminalOwnership.forceSignal : terminalOwnership.gracefulSignal,
            );
          }
          const drained = await waitForJobObjectDrain(session, force ? Math.min(timeoutMs, 700) : timeoutMs);
          session.cleanupVerified = drained;
          if (!drained) throw new Error("Windows PTY Job Object could not be fully drained.");
          disposeJobObjectTerminalTransport(session);
          finalizeSession(session);
          return publicSession(session);
        }

        let ownershipVerified = false;
        if (!session.shellExited || (session.posixSessionId && listProcessSessionPids)) {
          ownershipVerified = await refreshOwnedPids(session);
        } else {
          ownershipVerified = Boolean(
            session.ttyName &&
            session.ownershipSnapshotAt &&
            Date.now() - session.ownershipSnapshotAt <= naturalExitOwnershipFreshMs,
          );
        }

        if (terminalOwnership.requiresVerifiedOwnership && !ownershipVerified) {
          if (naturalExit) {
            session.cleanupVerified = null;
            finalizeSession(session);
            return publicSession(session);
          }
          throw new Error(
            session.ownershipError || "PTY controlling-TTY ownership could not be verified.",
          );
        }

        signalTrackedOwnership(session, force ? terminalOwnership.forceSignal : terminalOwnership.gracefulSignal);
        let drained = await waitForTrackedOwnershipDrain(
          session,
          force ? Math.min(timeoutMs, 700) : timeoutMs,
        );
        if (!drained && !force) {
          signalTrackedOwnership(session, terminalOwnership.forceSignal);
          drained = await waitForTrackedOwnershipDrain(session, 700);
        }

        session.cleanupVerified = ownershipVerified ? drained : null;
        if (!drained) {
          throw new Error("PTY owned process set could not be fully drained.");
        }
        finalizeSession(session);
        return publicSession(session);
      } catch (error) {
        session.cleanupVerified = false;
        session.cleanupError = error instanceof Error ? error.message : String(error);
        if (terminalOwnership.kind === "job-object" && session.shellExited) {
          try { disposeJobObjectTerminalTransport(session); } catch {}
        }
        emitEvent({
          component: "terminal",
          type: "terminal.cleanup_failed",
          severity: "error",
          status: "failed",
          projectId: session.projectId,
          correlationId: session.id,
          message: "PTY terminal owned-process cleanup could not be verified.",
          details: {
            sessionId: session.id,
            label: session.label,
            error: session.cleanupError,
          },
        });
        if (session.shellExited) finalizeSession(session);
        throw error;
      }
    })();

    return session.cleanupPromise;
  };

  const appendOutput = (session:Session,data:unknown):void => {
    const text = String(data ?? "");

    if (!text) {
      return;
    }

    session.buffer += text;
    session.totalCursor += text.length;
    session.lastActivityAt = now();

    if (session.buffer.length > maxBufferChars) {
      const overflow = session.buffer.length - maxBufferChars;
      session.buffer = session.buffer.slice(overflow);
      session.baseCursor += overflow;
      session.droppedChars += overflow;
      if (!session.bufferDropNotified) {
        session.bufferDropNotified = true;
        emitEvent({
          component: "terminal",
          type: "terminal.log_truncated",
          severity: "warn",
          status: "degraded",
          projectId: session.projectId,
          correlationId: session.id,
          message: "PTY terminal output buffer exceeded its limit; older output is being dropped.",
          details: {
            sessionId: session.id,
            label: session.label,
            droppedChars: session.droppedChars,
          },
        });
      }
    }

    notifyWaiters(session);
    scheduleOwnershipRefresh(session);
  };

  const consumeStartupData = (session:Session,data:unknown):void => {
    const text = String(data ?? "");
    if (!text) return;
    if (!session.startupMarker || session.startupReady) {
      appendOutput(session, text);
      return;
    }

    const marker = session.startupMarker;
    const combined = session.startupBuffer + text;
    const markerIndex = combined.indexOf(marker);
    if (markerIndex >= 0) {
      const before = combined.slice(0, markerIndex);
      let after = combined.slice(markerIndex + marker.length);
      if (after.startsWith("\r\n")) after = after.slice(2);
      else if (after.startsWith("\n") || after.startsWith("\r")) after = after.slice(1);
      session.startupBuffer = "";
      session.startupReady = true;
      session.resolveStartupReady?.();
      if (before) appendOutput(session, before);
      if (after) appendOutput(session, after);
      return;
    }

    let keep = 0;
    const maxKeep = Math.min(marker.length - 1, combined.length);
    for (let length = maxKeep; length > 0; length -= 1) {
      if (marker.startsWith(combined.slice(-length))) {
        keep = length;
        break;
      }
    }
    const publish = combined.slice(0, combined.length - keep);
    session.startupBuffer = keep > 0 ? combined.slice(-keep) : "";
    if (publish) appendOutput(session, publish);
  };

  const waitForStartupReady = async (session:Session):Promise<void> => {
    if (!session.startupMarker || session.startupReady) return;
    let timer:ReturnType<typeof setTimeout>|null = null;
    await Promise.race([
      session.startupReadyPromise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, windowsPtyReadyTimeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer !== null) clearTimeout(timer);
    if (session.startupReady) return;
    if (session.startupFailure) throw new Error(session.startupFailure);
    throw new Error("Windows interactive PowerShell did not become ready before timeout.");
  };

  const pruneRetainedSessions = ():void => {
    if (sessions.size < maxRetainedSessions) {
      return;
    }

    const removable = [...sessions.values()]
      .filter((session) => !session.running)
      .sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0));

    while (
      sessions.size >= maxRetainedSessions &&
      removable.length > 0
    ) {
      sessions.delete(removable.shift()!.id);
    }
  };

  const waitForData = async (session:Session,cursor:number,waitMs:number):Promise<void> => {
    if (
      waitMs <= 0 ||
      session.totalCursor > cursor ||
      !session.running
    ) {
      return;
    }

    await new Promise<void>((resolve) => {
      const waiter:Waiter = {
        resolve,
        timer: setTimeout(() => {
          session.waiters.delete(waiter);
          resolve();
        }, waitMs),
      };

      session.waiters.add(waiter);
    });
  };

  const reserveStart = ():()=>void => {
    const activeCount = [...sessions.values()].filter(
      (session) => session.running,
    ).length;

    if (activeCount + pendingStarts >= maxActiveSessions) {
      throw new Error(
        `Aynı anda en fazla ${maxActiveSessions} terminal oturumu açık olabilir.`,
      );
    }

    pendingStarts += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingStarts -= 1;
    };
  };

  const startReserved = async ({
    projectId,
    projectName,
    cwd,
    shell = "/bin/zsh",
    shellArgs = ["-l"],
    env = process.env,
    cols = 120,
    rows = 30,
    label,
  }:StartOptions) => {
    assertProcessOwnershipImplemented(terminalOwnership, "PTY terminal execution");
    pruneRetainedSessions();

    const { spawn } = await loadPtyModule();
    const id = `term-${randomId()}`;
    const createdAt = now();
    const baseEnv = {
      ...env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      PAGER: "cat",
      GIT_PAGER: "cat",
    };
    let ownedSet:Lease|null = null;
    let spawnShell:string = shell;
    let spawnArgs:string[] = shellArgs;
    let spawnEnv:NodeJS.ProcessEnv = baseEnv;
    let startupMarker:string|null = null;
    if (terminalOwnership.kind === "job-object") {
      ownedSet = await terminalOwnership.createOwnedSet!();
      const spec = terminalOwnership.spawnSpec!(shell, shellArgs, baseEnv);
      spawnShell = spec.command;
      spawnArgs = [...spec.args];
      spawnEnv = { ...spec.env };
      startupMarker = typeof spec.readyMarker === "string" && spec.readyMarker ? spec.readyMarker : null;
    }
    let terminal:Pty;
    try {
      terminal = spawn(spawnShell, spawnArgs, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: spawnEnv,
        handleFlowControl: true,
      });
    } catch (error) {
      try { await terminalOwnership.closeOwnedSet?.(ownedSet); } catch {}
      throw error;
    }

    const session:Session = {
      id,
      label: label || `${projectId}:${shell.split("/").at(-1)}`,
      projectId,
      projectName,
      cwd,
      shell,
      pid: terminal.pid ?? null,
      terminal,
      ownedSet,
      running: true,
      cols,
      rows,
      createdAt,
      lastActivityAt: createdAt,
      exitedAt: null,
      exitCode: null,
      signal: null,
      buffer: "",
      baseCursor: 0,
      totalCursor: 0,
      droppedChars: 0,
      bufferDropNotified: false,
      stopRequested: false,
      shellExited: false,
      // Bundled node-pty exposes the allocated slave TTY internally; ps fallback above
      // keeps startup working if that implementation detail changes in a future pin.
      ttyName: normalizeTtyName(terminal?._pty),
      ttyPromise: null,
      posixSessionId: null,
      ownedPids: new Set<number>(),
      ownershipSnapshotAt: null,
      ownershipError: null,
      ownershipRefreshTimer: null,
      ownershipMonitorTimer: null,
      cleanupVerified: null,
      cleanupError: null,
      cleanupPromise: null,
      transportDisposed: false,
      startupMarker,
      startupBuffer: "",
      startupReady: !startupMarker,
      startupFailure: null,
      startupReadyPromise: null,
      resolveStartupReady: null,
      waiters: new Set<Waiter>(),
      exitPromise: null,
      resolveExit: null,
    };

    session.exitPromise = new Promise<void>((resolve) => {
      session.resolveExit = resolve;
    });
    session.startupReadyPromise = new Promise<void>((resolve) => {
      session.resolveStartupReady = resolve;
    });
    session.ttyPromise = terminalOwnership.kind === "job-object"
      ? Promise.resolve(null)
      : session.ttyName
        ? Promise.resolve(session.ttyName)
        : Promise.resolve(resolveProcessTtyImpl(session.pid))
          .then((ttyName) => {
            session.ttyName = normalizeTtyName(ttyName);
            return session.ttyName;
          })
          .catch((error) => {
            setOwnershipError(session, error);
            return null;
          });

    sessions.set(id, session);
    terminal.onData((data) => {
      consumeStartupData(session, data);
    });

    terminal.onExit(({ exitCode, signal }) => {
      if (session.transportDisposed && session.shellExited) return;
      if (!session.startupReady) {
        session.startupFailure = `Windows interactive shell exited before readiness (exit=${exitCode ?? "null"}, signal=${signal ?? "null"}).`;
        session.resolveStartupReady?.();
      }
      session.shellExited = true;
      session.exitCode = exitCode ?? null;
      session.signal = signal ?? null;
      session.lastActivityAt = now();
      notifyWaiters(session);
      if (!session.stopRequested) {
        void cleanupOwnedSession(session, {
          force: false,
          timeoutMs: 800,
          naturalExit: true,
        }).catch(() => {});
      }
    });

    await session.ttyPromise;
    if (terminalOwnership.kind === "job-object") {
      try {
        const ownedPid = await terminalOwnership.attachAndRelease!(session.ownedSet, terminal);
        if (Number.isInteger(ownedPid) && (ownedPid as number) > 0) session.pid = ownedPid as number;
        if (!await refreshOwnedPids(session)) throw new Error("Windows PTY Job Object ownership could not be verified.");
        await waitForStartupReady(session);
      } catch (error) {
        session.stopRequested = true;
        try { terminal.kill(); } catch {}
        try { await terminalOwnership.closeOwnedSet?.(session.ownedSet); } catch {}
        session.ownedSet = null;
        sessions.delete(id);
        throw error;
      }
    }
    if (terminalOwnership.kind === "posix-session-or-tty" && resolveProcessSessionId && listProcessSessionPids) {
      try {
        const sessionId = await resolveProcessSessionId(session.pid);
        if (!Number.isInteger(sessionId) || sessionId! <= 0) throw new Error("PTY POSIX session id could not be resolved.");
        session.posixSessionId = sessionId;
      } catch (error) {
        setOwnershipError(session, error);
        if (nativeSessionHelper || resolveProcessSessionIdImpl || listProcessSessionPidsImpl) {
          session.stopRequested = true;
          session.terminal.kill("SIGKILL");
          sessions.delete(id);
          throw new Error(session.ownershipError || "PTY POSIX session id could not be resolved.");
        }
      }
    }
    if (terminalOwnership.kind !== "job-object" && terminalOwnership.requiresVerifiedOwnership && !session.posixSessionId && !session.ttyName) {
      session.stopRequested = true;
      session.terminal.kill("SIGKILL");
      sessions.delete(id);
      throw new Error(session.ownershipError || "PTY controlling TTY could not be resolved.");
    }
    await refreshOwnedPids(session);
    emitEvent({
      component: "terminal",
      type: "terminal.started",
      severity: "info",
      status: "running",
      projectId: session.projectId,
      correlationId: session.id,
      message: "PTY terminal session started.",
      details: {
        sessionId: session.id,
        label: session.label,
        shell: session.shell,
        pid: session.pid,
        cols: session.cols,
        rows: session.rows,
      },
    });

    scheduleOwnershipMonitor(session);
    return publicSession(session);
  };

  const start = async (options:StartOptions) => {
    const releaseStart = reserveStart();
    try {
      return await startReserved(options);
    } finally {
      releaseStart();
    }
  };

  const list = () =>
    [...sessions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicSession);

  const read = async ({
    sessionId,
    cursor,
    maxChars = DEFAULT_READ_MAX_CHARS,
    stripAnsiCodes = true,
    waitMs = 0,
  }:ReadOptions) => {
    const session = getSession(sessionId);
    const requestedCursor =
      cursor === undefined || cursor === null
        ? session.baseCursor
        : cursor;

    await waitForData(session, requestedCursor, waitMs);

    const effectiveCursor = Math.max(
      requestedCursor,
      session.baseCursor,
    );
    const offset = effectiveCursor - session.baseCursor;
    const available = session.buffer.slice(offset);
    const chunk = available.slice(0, maxChars);
    const nextCursor = effectiveCursor + chunk.length;

    return {
      session: publicSession(session),
      requestedCursor,
      effectiveCursor,
      cursorWasDropped: requestedCursor < session.baseCursor,
      nextCursor,
      hasMore: nextCursor < session.totalCursor,
      output: stripAnsiCodes ? stripAnsi(chunk) : chunk,
    };
  };

  const write = ({sessionId,data="",key}:WriteOptions) => {
    const session = getSession(sessionId);

    if (!session.running) {
      throw new Error(`Terminal oturumu artık çalışmıyor: ${sessionId}`);
    }

    if (!data && !key) {
      throw new Error("Yazılacak metin veya gönderilecek tuş gerekli.");
    }

    if (data) {
      session.terminal.write(data);
    }

    if (key) {
      const sequence = KEY_SEQUENCES[key as keyof typeof KEY_SEQUENCES];

      if (!sequence) {
        throw new Error(`Desteklenmeyen terminal tuşu: ${key}`);
      }

      session.terminal.write(sequence);
    }

    session.lastActivityAt = now();
    scheduleOwnershipRefresh(session);
    return publicSession(session);
  };

  const resize = ({sessionId,cols,rows}:ResizeOptions) => {
    const session = getSession(sessionId);

    if (!session.running) {
      throw new Error(`Terminal oturumu artık çalışmıyor: ${sessionId}`);
    }

    session.terminal.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    session.lastActivityAt = now();
    return publicSession(session);
  };

  const stop = async ({
    sessionId,
    force = false,
    timeoutMs = 1500,
    remove = false,
  }:StopOptions) => {
    const session = getSession(sessionId);

    if (session.running) {
      session.stopRequested = true;
      emitEvent({
        component: "terminal",
        type: "terminal.stop_requested",
        severity: "info",
        status: "stopping",
        projectId: session.projectId,
        correlationId: session.id,
        message: "Stop requested for PTY terminal session.",
        details: {
          sessionId: session.id,
          label: session.label,
          force,
        },
      });
      await cleanupOwnedSession(session, { force, timeoutMs, naturalExit: false });
    }

    const result = publicSession(session);
    if (remove && !session.running) sessions.delete(sessionId);
    return result;
  };

  const shutdown = async ():Promise<void> => {
    const running = [...sessions.values()].filter(
      (session) => session.running,
    );

    await Promise.all(
      running.map((session) =>
        stop({
          sessionId: session.id,
          force: false,
          timeoutMs: 800,
          remove: false,
        }).catch(() => {}),
      ),
    );
  };

  return Object.freeze({
    start,
    list,
    read,
    write,
    resize,
    stop,
    shutdown,
  });
}

export const __test = Object.freeze({
  stripAnsi,
  parseDarwinTtyProcessPids,
});
