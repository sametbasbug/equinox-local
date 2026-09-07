import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

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


function normalizeTtyName(value) {
  const tty = String(value ?? "").trim().replace(/^\/dev\//u, "");
  if (!tty || tty === "??" || tty === "?") return null;
  return tty;
}

export function parseDarwinTtyProcessPids(output, ttyName) {
  const wanted = normalizeTtyName(ttyName);
  if (!wanted) return [];
  const pids = [];
  for (const line of String(output ?? "").split(/\r?\n/u)) {
    const match = line.trim().match(/^(\d+)\s+(\S+)$/u);
    if (!match || normalizeTtyName(match[2]) !== wanted) continue;
    const pid = Number.parseInt(match[1], 10);
    if (pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

async function defaultResolveProcessTty(pid) {
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

async function defaultListTtyProcessPids(ttyName) {
  if (process.platform !== "darwin") return null;
  const { stdout = "" } = await execFile(
    "/bin/ps",
    ["-axo", "pid=,tty="],
    { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, encoding: "utf8" },
  );
  return parseDarwinTtyProcessPids(stdout, ttyName);
}

function defaultPidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function stripAnsi(value) {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001bP.*?\u001b\\/gsu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u001b[@-_]/gu, "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n");
}

function toIso(value) {
  return value === null || value === undefined
    ? null
    : new Date(value).toISOString();
}

function publicSession(session) {
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
  onEvent = null,
} = {}) {
  const sessions = new Map();
  let ptyModulePromise;
  let pendingStarts = 0;

  const emitEvent = (event) => {
    if (typeof onEvent !== "function") {
      return;
    }
    void Promise.resolve(onEvent(event)).catch(() => {});
  };

  const loadPtyModule = async () => {
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

  const getSession = (sessionId) => {
    const session = sessions.get(sessionId);

    if (!session) {
      throw new Error(`Terminal oturumu bulunamadı: ${sessionId}`);
    }

    return session;
  };

  const notifyWaiters = (session) => {
    const waiters = [...session.waiters];
    session.waiters.clear();

    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  };

  const setOwnershipError = (session, error) => {
    session.ownershipError = error instanceof Error ? error.message : String(error);
  };

  const refreshOwnedPids = async (session) => {
    try {
      const ttyName = session.ttyName ?? await session.ttyPromise;
      if (!ttyName) return false;
      const pids = await listTtyProcessPidsImpl(ttyName);
      if (pids === null) return false;
      if (!Array.isArray(pids)) {
        throw new Error("PTY TTY process inventory returned an invalid result.");
      }
      const normalized = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
      if (!session.shellExited && !normalized.includes(session.pid)) {
        throw new Error("PTY shell disappeared from its controlling TTY inventory.");
      }
      if (!session.shellExited || normalized.includes(session.pid)) {
        session.ownedPids = new Set(normalized);
        session.ownershipSnapshotAt = Date.now();
      }
      return true;
    } catch (error) {
      setOwnershipError(session, error);
      return false;
    }
  };

  const scheduleOwnershipRefresh = (session) => {
    if (session.shellExited || session.ownershipRefreshTimer) return;
    session.ownershipRefreshTimer = setTimeout(() => {
      session.ownershipRefreshTimer = null;
      void refreshOwnedPids(session);
    }, ownershipRefreshDelayMs);
    session.ownershipRefreshTimer.unref?.();
  };

  const scheduleOwnershipMonitor = (session) => {
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

  const signalPid = (pid, signal) => {
    try {
      killImpl(pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  };

  const finalizeSession = (session) => {
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

  const trackedDescendants = (session) => [...session.ownedPids]
    .filter((pid) => pid !== session.pid && pidExistsImpl(pid));

  const signalTrackedOwnership = (session, signal) => {
    for (const pid of trackedDescendants(session)) {
      signalPid(pid, signal);
    }
    if (!session.shellExited) session.terminal.kill(signal);
  };

  const waitForTrackedOwnershipDrain = async (session, timeoutMs) => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      const liveDescendants = trackedDescendants(session);
      if (session.shellExited && liveDescendants.length === 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const cleanupOwnedSession = (session, {
    force = false,
    timeoutMs = 1500,
    naturalExit = false,
  } = {}) => {
    if (session.cleanupPromise) return session.cleanupPromise;

    session.cleanupPromise = (async () => {
      session.cleanupError = null;
      try {
        let ownershipVerified = false;
        if (!session.shellExited) {
          ownershipVerified = await refreshOwnedPids(session);
        } else {
          ownershipVerified = Boolean(
            session.ttyName &&
            session.ownershipSnapshotAt &&
            Date.now() - session.ownershipSnapshotAt <= naturalExitOwnershipFreshMs,
          );
        }

        if (process.platform === "darwin" && !ownershipVerified) {
          if (naturalExit) {
            session.cleanupVerified = null;
            finalizeSession(session);
            return publicSession(session);
          }
          throw new Error(
            session.ownershipError || "PTY controlling-TTY ownership could not be verified.",
          );
        }

        signalTrackedOwnership(session, force ? "SIGKILL" : "SIGHUP");
        let drained = await waitForTrackedOwnershipDrain(
          session,
          force ? Math.min(timeoutMs, 700) : timeoutMs,
        );
        if (!drained && !force) {
          signalTrackedOwnership(session, "SIGKILL");
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

  const appendOutput = (session, data) => {
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

  const pruneRetainedSessions = () => {
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
      sessions.delete(removable.shift().id);
    }
  };

  const waitForData = async (session, cursor, waitMs) => {
    if (
      waitMs <= 0 ||
      session.totalCursor > cursor ||
      !session.running
    ) {
      return;
    }

    await new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          session.waiters.delete(waiter);
          resolve();
        }, waitMs),
      };

      session.waiters.add(waiter);
    });
  };

  const reserveStart = () => {
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
  }) => {
    pruneRetainedSessions();

    const { spawn } = await loadPtyModule();
    const id = `term-${randomId()}`;
    const createdAt = now();
    const terminal = spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        PAGER: "cat",
        GIT_PAGER: "cat",
      },
      handleFlowControl: true,
    });

    const session = {
      id,
      label: label || `${projectId}:${shell.split("/").at(-1)}`,
      projectId,
      projectName,
      cwd,
      shell,
      pid: terminal.pid ?? null,
      terminal,
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
      ownedPids: new Set(),
      ownershipSnapshotAt: null,
      ownershipError: null,
      ownershipRefreshTimer: null,
      ownershipMonitorTimer: null,
      cleanupVerified: null,
      cleanupError: null,
      cleanupPromise: null,
      waiters: new Set(),
      exitPromise: null,
      resolveExit: null,
    };

    session.exitPromise = new Promise((resolve) => {
      session.resolveExit = resolve;
    });
    session.ttyPromise = session.ttyName
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

    terminal.onData((data) => {
      appendOutput(session, data);
    });

    terminal.onExit(({ exitCode, signal }) => {
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
    if (process.platform === "darwin" && !session.ttyName) {
      session.stopRequested = true;
      session.terminal.kill("SIGKILL");
      sessions.delete(id);
      throw new Error(session.ownershipError || "PTY controlling TTY could not be resolved.");
    }
    await refreshOwnedPids(session);
    scheduleOwnershipMonitor(session);
    return publicSession(session);
  };

  const start = async (options) => {
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
  }) => {
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

  const write = ({ sessionId, data = "", key }) => {
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
      const sequence = KEY_SEQUENCES[key];

      if (!sequence) {
        throw new Error(`Desteklenmeyen terminal tuşu: ${key}`);
      }

      session.terminal.write(sequence);
    }

    session.lastActivityAt = now();
    scheduleOwnershipRefresh(session);
    return publicSession(session);
  };

  const resize = ({ sessionId, cols, rows }) => {
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
  }) => {
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

  const shutdown = async () => {
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
