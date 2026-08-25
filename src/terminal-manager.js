import { randomUUID } from "node:crypto";

const DEFAULT_MAX_ACTIVE_SESSIONS = 8;
const DEFAULT_MAX_RETAINED_SESSIONS = 24;
const DEFAULT_MAX_BUFFER_CHARS = 2_000_000;
const DEFAULT_READ_MAX_CHARS = 30_000;

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
  };
}

export function createTerminalManager({
  ptyModuleLoader = () => import("node-pty"),
  now = () => Date.now(),
  randomId = () => randomUUID().slice(0, 8),
  maxActiveSessions = DEFAULT_MAX_ACTIVE_SESSIONS,
  maxRetainedSessions = DEFAULT_MAX_RETAINED_SESSIONS,
  maxBufferChars = DEFAULT_MAX_BUFFER_CHARS,
  onEvent = null,
} = {}) {
  const sessions = new Map();
  let ptyModulePromise;

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
          message: "PTY terminal buffer sınırını aştı; eski çıktı düşürülüyor.",
          details: {
            sessionId: session.id,
            label: session.label,
            droppedChars: session.droppedChars,
          },
        });
      }
    }

    notifyWaiters(session);
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

  const start = async ({
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
    const activeCount = [...sessions.values()].filter(
      (session) => session.running,
    ).length;

    if (activeCount >= maxActiveSessions) {
      throw new Error(
        `Aynı anda en fazla ${maxActiveSessions} terminal oturumu açık olabilir.`,
      );
    }

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
      waiters: new Set(),
      exitPromise: null,
      resolveExit: null,
    };

    session.exitPromise = new Promise((resolve) => {
      session.resolveExit = resolve;
    });

    sessions.set(id, session);
    emitEvent({
      component: "terminal",
      type: "terminal.started",
      severity: "info",
      status: "running",
      projectId: session.projectId,
      correlationId: session.id,
      message: "PTY terminal oturumu başlatıldı.",
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
      session.running = false;
      session.exitCode = exitCode ?? null;
      session.signal = signal ?? null;
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
          ? "PTY terminal oturumu beklenmedik biçimde sonlandı."
          : "PTY terminal oturumu sonlandı.",
        details: {
          sessionId: session.id,
          label: session.label,
          exitCode: session.exitCode,
          signal: session.signal,
          stopRequested: session.stopRequested,
        },
      });
    });

    return publicSession(session);
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
        message: "PTY terminal oturumu için durdurma istendi.",
        details: {
          sessionId: session.id,
          label: session.label,
          force,
        },
      });
      session.terminal.kill(force ? "SIGKILL" : "SIGHUP");

      await Promise.race([
        session.exitPromise,
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);

      if (session.running && !force) {
        session.terminal.kill("SIGKILL");
        await Promise.race([
          session.exitPromise,
          new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
      }
    }

    const result = publicSession(session);

    if (remove && !session.running) {
      sessions.delete(sessionId);
    }

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
});
