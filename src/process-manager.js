import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { createConnection } from "node:net";

const DEFAULT_MAX_ACTIVE_PROCESSES = 12;
const DEFAULT_MAX_RETAINED_PROCESSES = 32;
const DEFAULT_MAX_BUFFER_CHARS = 4_000_000;
const DEFAULT_READ_MAX_CHARS = 40_000;
const DEFAULT_GROUP_POLL_MS = 100;

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

function publicProcess(session) {
  return {
    processId: session.id,
    label: session.label,
    projectId: session.projectId,
    projectName: session.projectName,
    cwd: session.cwd,
    command: session.command,
    args: [...session.args],
    purpose: session.purpose,
    pid: session.pid,
    running: session.running,
    expectedPorts: [...session.expectedPorts],
    createdAt: toIso(session.createdAt),
    startedAt: toIso(session.startedAt),
    lastActivityAt: toIso(session.lastActivityAt),
    exitedAt: toIso(session.exitedAt),
    exitCode: session.exitCode,
    signal: session.signal,
    spawnError: session.spawnError,
    baseCursor: session.baseCursor,
    cursor: session.totalCursor,
    bufferedChars: session.buffer.length,
    droppedChars: session.droppedChars,
  };
}

function outputText(chunk) {
  return Buffer.isBuffer(chunk)
    ? chunk.toString("utf8")
    : String(chunk ?? "");
}

function normalizeChunk(stream, chunk) {
  const text = outputText(chunk);

  if (!text) {
    return "";
  }

  const prefix = stream === "stderr"
    ? "[stderr] "
    : "[stdout] ";

  return prefix + text;
}

function appendBoundedTail(state, text, maxChars) {
  if (!text) return;
  const combined = state.value + text;
  if (combined.length <= maxChars) {
    state.value = combined;
    return;
  }
  const overflow = combined.length - maxChars;
  state.value = combined.slice(overflow);
  state.droppedChars += overflow;
}

function boundedSnapshot(value, droppedChars, maxChars, stripAnsiCodes) {
  const overflow = Math.max(0, value.length - maxChars);
  const chunk = overflow > 0 ? value.slice(overflow) : value;
  const totalDropped = droppedChars + overflow;
  return {
    value: stripAnsiCodes ? stripAnsi(chunk) : chunk,
    truncated: totalDropped > 0,
    droppedChars: totalDropped,
  };
}

function normalizeExpectedPorts(ports) {
  const normalized = [];

  for (const port of ports ?? []) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Geçersiz TCP portu: ${port}`);
    }

    if (!normalized.includes(port)) {
      normalized.push(port);
    }
  }

  return normalized;
}

function defaultProcessGroupExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

export function createProcessManager({
  spawnImpl = nodeSpawn,
  killImpl = process.kill.bind(process),
  groupExistsImpl = defaultProcessGroupExists,
  now = () => Date.now(),
  randomId = () => randomUUID().slice(0, 8),
  maxActiveProcesses = DEFAULT_MAX_ACTIVE_PROCESSES,
  maxRetainedProcesses = DEFAULT_MAX_RETAINED_PROCESSES,
  maxBufferChars = DEFAULT_MAX_BUFFER_CHARS,
  groupPollMs = DEFAULT_GROUP_POLL_MS,
  onEvent = null,
} = {}) {
  const sessions = new Map();

  if (!Number.isInteger(groupPollMs) || groupPollMs < 1 || groupPollMs > 5000) {
    throw new Error("Process group poll interval is invalid.");
  }

  const emitEvent = (event) => {
    if (typeof onEvent !== "function") {
      return;
    }
    void Promise.resolve(onEvent(event)).catch(() => {});
  };

  const getSession = (processId) => {
    const session = sessions.get(processId);

    if (!session) {
      throw new Error(`Yönetilen süreç bulunamadı: ${processId}`);
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

  const appendOutput = (session, stream, chunk) => {
    const rawText = outputText(chunk);
    const text = normalizeChunk(stream, rawText);

    if (!text) {
      return;
    }

    appendBoundedTail(
      stream === "stderr" ? session.stderrState : session.stdoutState,
      rawText,
      maxBufferChars,
    );
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
          component: "process",
          type: "process.log_truncated",
          severity: "warn",
          status: "degraded",
          projectId: session.projectId,
          correlationId: session.id,
          message: "Managed process log buffer exceeded its limit; older output is being dropped.",
          details: {
            processId: session.id,
            label: session.label,
            droppedChars: session.droppedChars,
          },
        });
      }
    }

    notifyWaiters(session);
  };

  const processGroupExists = (session) => {
    if (!Number.isInteger(session.pid)) {
      return false;
    }

    try {
      return Boolean(groupExistsImpl(session.pid));
    } catch (error) {
      if (!session.groupProbeErrorNotified) {
        session.groupProbeErrorNotified = true;
        emitEvent({
          component: "process",
          type: "process.group_probe_failed",
          severity: "warn",
          status: "degraded",
          projectId: session.projectId,
          correlationId: session.id,
          message: "Managed process group liveness could not be verified; ownership is being retained fail-closed.",
          details: {
            processId: session.id,
            label: session.label,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return true;
    }
  };

  const finalizeSession = (session, { code = null, signal = null } = {}) => {
    if (!session.running) {
      return;
    }

    if (session.groupMonitorTimer) {
      clearTimeout(session.groupMonitorTimer);
      session.groupMonitorTimer = null;
    }

    session.running = false;
    session.exitCode = Number.isInteger(code) ? code : null;
    session.signal = signal === null || signal === undefined
      ? null
      : String(signal);
    session.exitedAt = now();
    session.lastActivityAt = session.exitedAt;
    notifyWaiters(session);
    session.resolveExit?.();

    const failed = Boolean(
      session.spawnError ||
      (
        session.purpose === "background" &&
        !session.stopRequested &&
        (
          (session.exitCode !== null && session.exitCode !== 0) ||
          session.signal
        )
      ),
    );
    emitEvent({
      component: "process",
      type: failed ? "process.crashed" : "process.exited",
      severity: failed ? "error" : "info",
      status: failed ? "failed" : "completed",
      projectId: session.projectId,
      correlationId: session.id,
      message: failed
        ? "Managed background process ended unexpectedly."
        : "Managed background process ended.",
      details: {
        processId: session.id,
        label: session.label,
        exitCode: session.exitCode,
        signal: session.signal,
        stopRequested: session.stopRequested,
        expectedPorts: session.expectedPorts,
        spawnError: session.spawnError,
      },
    });
  };

  const scheduleGroupMonitor = (session) => {
    if (!session.running || !session.leaderExited || session.groupMonitorTimer) {
      return;
    }

    session.groupMonitorTimer = setTimeout(() => {
      session.groupMonitorTimer = null;
      if (!session.running || !session.leaderExited) return;

      if (processGroupExists(session)) {
        scheduleGroupMonitor(session);
        return;
      }

      if (!session.leaderClosed) return;
      finalizeSession(session, {
        code: session.leaderExitCode,
        signal: session.leaderSignal,
      });
    }, groupPollMs);
    session.groupMonitorTimer.unref?.();
  };

  const pruneRetainedProcesses = () => {
    if (sessions.size < maxRetainedProcesses) {
      return;
    }

    const removable = [...sessions.values()]
      .filter((session) => !session.running)
      .sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0));

    while (
      sessions.size >= maxRetainedProcesses &&
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

  const start = ({
    projectId,
    projectName,
    cwd,
    command,
    args = [],
    purpose = "background",
    env = process.env,
    label,
    expectedPorts = [],
  }) => {
    const activeCount = [...sessions.values()].filter(
      (session) => session.running,
    ).length;

    if (activeCount >= maxActiveProcesses) {
      throw new Error(
        `Aynı anda en fazla ${maxActiveProcesses} yönetilen süreç açık olabilir.`,
      );
    }

    if (typeof command !== "string" || !command.trim()) {
      throw new Error("Başlatılacak komut gerekli.");
    }

    if (
      !Array.isArray(args) ||
      args.some((item) => typeof item !== "string")
    ) {
      throw new Error("Süreç argümanları metin dizisi olmalı.");
    }
    if (!["background", "terminal_exec"].includes(purpose)) {
      throw new Error("Süreç amacı geçersiz.");
    }

    pruneRetainedProcesses();

    const id = `proc-${randomId()}`;
    const createdAt = now();
    const ports = normalizeExpectedPorts(expectedPorts);
    let child;

    try {
      child = spawnImpl(command, args, {
        cwd,
        env: {
          ...env,
          PAGER: "cat",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          NO_COLOR: env.NO_COLOR ?? "1",
        },
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(
        `Süreç başlatılamadı: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const session = {
      id,
      label: label || `${projectId}:${command.split("/").at(-1)}`,
      projectId,
      projectName,
      cwd,
      command,
      args: [...args],
      purpose,
      expectedPorts: ports,
      pid: Number.isInteger(child.pid) ? child.pid : null,
      child,
      running: true,
      createdAt,
      startedAt: createdAt,
      lastActivityAt: createdAt,
      exitedAt: null,
      exitCode: null,
      signal: null,
      spawnError: null,
      buffer: "",
      baseCursor: 0,
      totalCursor: 0,
      droppedChars: 0,
      stdoutState: { value: "", droppedChars: 0 },
      stderrState: { value: "", droppedChars: 0 },
      bufferDropNotified: false,
      stopRequested: false,
      waiters: new Set(),
      exitPromise: null,
      resolveExit: null,
      leaderExited: false,
      leaderClosed: false,
      leaderExitCode: null,
      leaderSignal: null,
      groupMonitorTimer: null,
      groupProbeErrorNotified: false,
    };

    session.exitPromise = new Promise((resolve) => {
      session.resolveExit = resolve;
    });

    sessions.set(id, session);
    emitEvent({
      component: "process",
      type: "process.started",
      severity: "info",
      status: "running",
      projectId: session.projectId,
      correlationId: session.id,
      message: "Managed background process started.",
      details: {
        processId: session.id,
        label: session.label,
        command: session.command,
        purpose: session.purpose,
        argumentCount: session.args.length,
        pid: session.pid,
        expectedPorts: session.expectedPorts,
      },
    });

    child.stdout?.on("data", (chunk) => {
      appendOutput(session, "stdout", chunk);
    });

    child.stderr?.on("data", (chunk) => {
      appendOutput(session, "stderr", chunk);
    });

    child.once("error", (error) => {
      session.spawnError = error instanceof Error
        ? error.message
        : String(error);
      appendOutput(session, "stderr", `Süreç hatası: ${session.spawnError}\n`);

      if (!Number.isInteger(child.pid)) {
        finalizeSession(session, {
          code: null,
          signal: "spawn_error",
        });
      }
    });

    child.once("exit", (code, signal) => {
      session.leaderExited = true;
      session.leaderExitCode = Number.isInteger(code) ? code : null;
      session.leaderSignal = signal === null || signal === undefined
        ? null
        : String(signal);

      if (processGroupExists(session)) {
        session.lastActivityAt = now();
        notifyWaiters(session);
        emitEvent({
          component: "process",
          type: "process.leader_exited",
          severity: "info",
          status: "running",
          projectId: session.projectId,
          correlationId: session.id,
          message: "Managed process leader exited while descendants remain in the owned process group.",
          details: {
            processId: session.id,
            label: session.label,
            exitCode: session.leaderExitCode,
            signal: session.leaderSignal,
            stopRequested: session.stopRequested,
          },
        });
        scheduleGroupMonitor(session);
        return;
      }

      if (session.leaderClosed) {
        finalizeSession(session, { code, signal });
      } else {
        session.lastActivityAt = now();
        notifyWaiters(session);
      }
    });

    child.once("close", (code, signal) => {
      session.leaderClosed = true;
      if (!session.leaderExited) {
        session.leaderExited = true;
        session.leaderExitCode = Number.isInteger(code) ? code : null;
        session.leaderSignal = signal === null || signal === undefined ? null : String(signal);
      }
      if (!session.running) return;
      if (processGroupExists(session)) {
        scheduleGroupMonitor(session);
        return;
      }
      finalizeSession(session, {
        code: session.leaderExitCode,
        signal: session.leaderSignal,
      });
    });

    return publicProcess(session);
  };

  const list = () =>
    [...sessions.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicProcess);

  const readLogs = async ({
    processId,
    cursor,
    maxChars = DEFAULT_READ_MAX_CHARS,
    stripAnsiCodes = true,
    waitMs = 0,
  }) => {
    const session = getSession(processId);
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
      process: publicProcess(session),
      requestedCursor,
      effectiveCursor,
      cursorWasDropped: requestedCursor < session.baseCursor,
      nextCursor,
      hasMore: nextCursor < session.totalCursor,
      output: stripAnsiCodes ? stripAnsi(chunk) : chunk,
    };
  };

  const waitForExit = async ({ processId, waitMs = 0 }) => {
    const session = getSession(processId);
    if (!Number.isInteger(waitMs) || waitMs < 0) {
      throw new Error("Süreç bekleme süresi geçersiz.");
    }
    if (session.running && waitMs > 0) {
      await Promise.race([
        session.exitPromise,
        new Promise((resolve) => setTimeout(resolve, waitMs)),
      ]);
    }
    return publicProcess(session);
  };

  const snapshotOutput = ({
    processId,
    maxChars = DEFAULT_READ_MAX_CHARS,
    stripAnsiCodes = true,
  }) => {
    const session = getSession(processId);
    if (!Number.isInteger(maxChars) || maxChars < 1) {
      throw new Error("Süreç çıktı sınırı geçersiz.");
    }

    const stdout = boundedSnapshot(
      session.stdoutState.value,
      session.stdoutState.droppedChars,
      maxChars,
      stripAnsiCodes,
    );
    const stderr = boundedSnapshot(
      session.stderrState.value,
      session.stderrState.droppedChars,
      maxChars,
      stripAnsiCodes,
    );
    const combined = boundedSnapshot(
      session.buffer,
      session.droppedChars,
      maxChars,
      stripAnsiCodes,
    );

    return {
      process: publicProcess(session),
      nextCursor: session.totalCursor,
      stdout: stdout.value,
      stderr: stderr.value,
      combinedOutput: combined.value,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      combinedOutputTruncated: combined.truncated,
      stdoutDroppedChars: stdout.droppedChars,
      stderrDroppedChars: stderr.droppedChars,
      combinedOutputDroppedChars: combined.droppedChars,
    };
  };

  const sendSignal = (session, signal) => {
    if (!session.running) {
      return;
    }

    let groupError = null;

    if (Number.isInteger(session.pid)) {
      try {
        killImpl(-session.pid, signal);
        return;
      } catch (error) {
        groupError = error;
      }
    }

    if (session.leaderExited) {
      if (!processGroupExists(session)) {
        finalizeSession(session, {
          code: session.leaderExitCode,
          signal: session.leaderSignal,
        });
        return;
      }

      throw new Error(
        `Süreç grubuna sinyal gönderilemedi: ${groupError instanceof Error ? groupError.message : String(groupError ?? "bilinmeyen hata")}`,
      );
    }

    try {
      session.child.kill(signal);
    } catch (error) {
      const first = groupError instanceof Error
        ? groupError.message
        : groupError
          ? String(groupError)
          : "yok";
      throw new Error(
        `Süreç sinyali gönderilemedi. Grup hatası: ${first}. Çocuk hatası: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const stop = async ({
    processId,
    force = false,
    timeoutMs = 2500,
    remove = false,
  }) => {
    const session = getSession(processId);

    if (session.running) {
      session.stopRequested = true;
      emitEvent({
        component: "process",
        type: "process.stop_requested",
        severity: "info",
        status: "stopping",
        projectId: session.projectId,
        correlationId: session.id,
        message: "Stop requested for managed background process.",
        details: {
          processId: session.id,
          label: session.label,
          force,
        },
      });
      sendSignal(session, force ? "SIGKILL" : "SIGTERM");

      await Promise.race([
        session.exitPromise,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);

      if (session.running && !force) {
        sendSignal(session, "SIGKILL");
        await Promise.race([
          session.exitPromise,
          new Promise((resolve) => setTimeout(resolve, 700)),
        ]);
      }
    }

    const result = publicProcess(session);

    if (remove && !session.running) {
      sessions.delete(processId);
    }

    return result;
  };

  const findByPort = (port) =>
    [...sessions.values()]
      .filter((session) => session.expectedPorts.includes(port))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicProcess);

  const shutdown = async () => {
    const running = [...sessions.values()].filter(
      (session) => session.running,
    );

    await Promise.all(
      running.map((session) =>
        stop({
          processId: session.id,
          force: false,
          timeoutMs: 1000,
          remove: false,
        }).catch(() => {}),
      ),
    );
  };

  return Object.freeze({
    start,
    list,
    readLogs,
    waitForExit,
    snapshotOutput,
    stop,
    findByPort,
    shutdown,
  });
}

export async function probeTcpPort({
  host = "127.0.0.1",
  port,
  timeoutMs = 1000,
  createConnectionImpl = createConnection,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Geçersiz TCP portu: ${port}`);
  }

  const startedAt = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const socket = createConnectionImpl({ host, port });

    const finish = (listening, error = null) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timer !== null) {
        clearTimeout(timer);
      }

      socket.destroy?.();
      resolve({
        host,
        port,
        listening,
        latencyMs: Date.now() - startedAt,
        error:
          error === null
            ? null
            : error instanceof Error
              ? error.message
              : String(error),
      });
    };

    timer = setTimeout(() => {
      finish(false, new Error("Bağlantı zaman aşımına uğradı."));
    }, timeoutMs);

    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(false, error));
  });
}

export function parseLsofFieldOutput(output) {
  const records = [];
  let current = null;

  const flush = () => {
    if (current) {
      records.push(current);
      current = null;
    }
  };

  for (const line of String(output ?? "").split("\n")) {
    if (!line) {
      continue;
    }

    const type = line[0];
    const value = line.slice(1);

    if (type === "p") {
      flush();
      current = {
        pid: /^\d+$/u.test(value)
          ? Number.parseInt(value, 10)
          : null,
        command: "",
        endpoint: "",
      };
    } else if (type === "c" && current) {
      current.command = value;
    } else if (type === "n" && current) {
      current.endpoint = value;
    }
  }

  flush();
  return records;
}

export const __test = Object.freeze({
  stripAnsi,
  normalizeChunk,
  normalizeExpectedPorts,
});
