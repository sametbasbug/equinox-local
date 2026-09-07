import fs from "node:fs/promises";

import { TERMINAL_KEYS } from "./terminal-manager.js";
import { buildGenericExecutionEnvironment } from "./equinox-local-generic-execution.js";

function resolveTerminalShell(shell) {
  if (shell === "zsh") return "/bin/zsh";
  if (shell === "bash") return "/bin/bash";
  throw new Error(`Desteklenmeyen terminal kabuğu: ${shell}`);
}

export function registerTerminalTools({
  registerTextTool,
  z,
  terminalManager,
  processManager,
  agentAccess,
  safeResolve,
  fsImpl = fs,
  getActiveProjectId,
  getActiveProjectName,
  getActiveProjectRoot,
  runtimeEnv = process.env,
  buildGenericExecutionEnvironmentImpl = buildGenericExecutionEnvironment,
  recordEvent = null,
  textResult,
  errorResult,
} = {}) {
  const terminalJsonResult = (value) => textResult(JSON.stringify(value, null, 2));
  const recordTerminalExecEvent = async (projectId, state, snapshot, durationMs) => {
    if (typeof recordEvent !== "function") return;
    await Promise.resolve(recordEvent({
      component: "terminal",
      type: state === "running"
        ? "terminal.exec_promoted"
        : "terminal.exec_completed",
      severity: "info",
      status: state === "running" ? "running" : "completed",
      projectId,
      message: state === "running"
        ? "Terminal command continues as a managed process."
        : "Terminal command completed.",
      details: {
        durationMs,
        exitCode: snapshot.process.exitCode,
        signal: snapshot.process.signal,
        promoted: state === "running",
        stdoutTruncated: snapshot.stdoutTruncated,
        stderrTruncated: snapshot.stderrTruncated,
        combinedOutputTruncated: snapshot.combinedOutputTruncated,
      },
    })).catch(() => {});
  };

  registerTextTool(
    "terminal_exec",
    {
      description:
        "Seçilen proje içinde zsh komut zincirini managed process olarak başlatır. Kısa işler tek çağrıda tamamlanır; wait_ms içinde bitmeyen iş öldürülmeden aynı process_id ile process_logs üzerinden devam eder. Etkileşimli TTY için terminal_start kullanılır.",
      inputSchema: {
        command: z.string().min(1).max(20_000),
        cwd: z.string().default(".").describe("Proje köküne göre göreli başlangıç klasörü"),
        wait_ms: z.number().int().min(0).max(120_000).default(30_000)
          .describe("Bu çağrıda tamamlanma için beklenecek süre. Süre dolarsa komut öldürülmez; managed process olarak devam eder."),
        max_output_chars: z.number().int().min(1_000).max(200_000).default(40_000),
      },
      annotations: {
        title: "Terminal komutu çalıştır",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command, cwd, wait_ms, max_output_chars }) => {
      try {
        if (!agentAccess.terminal) {
          throw new Error("Terminal erişimi Control Center'da kapalı.");
        }

        const resolvedCwd = await safeResolve(cwd);
        const stats = await fsImpl.stat(resolvedCwd);
        if (!stats.isDirectory()) {
          throw new Error("Terminal başlangıç yolu bir klasör değil.");
        }

        const projectId = getActiveProjectId();
        const projectName = getActiveProjectName();
        const executionEnv = {
          ...buildGenericExecutionEnvironmentImpl({
            runtimeEnv,
            projectId,
            projectRoot: getActiveProjectRoot(),
          }),
          PAGER: "cat",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          NO_COLOR: "1",
        };
        const startedAt = Date.now();
        const processInfo = processManager.start({
          projectId,
          projectName,
          cwd: resolvedCwd,
          command: "/bin/zsh",
          args: ["-lc", command],
          purpose: "terminal_exec",
          env: executionEnv,
          label: `${projectId}:terminal-exec`,
          expectedPorts: [],
        });

        await processManager.waitForExit({
          processId: processInfo.processId,
          waitMs: wait_ms,
        });
        const snapshot = processManager.snapshotOutput({
          processId: processInfo.processId,
          maxChars: max_output_chars,
          stripAnsiCodes: true,
        });
        const running = snapshot.process.running;
        const durationMs = Math.max(0, Date.now() - startedAt);
        await recordTerminalExecEvent(
          projectId,
          running ? "running" : "completed",
          snapshot,
          durationMs,
        );

        if (running) {
          return terminalJsonResult({
            ok: true,
            completed: false,
            promoted: true,
            message: "Terminal komutu hâlâ çalışıyor; aynı managed process öldürülmeden devam ediyor.",
            projectId,
            projectName,
            initialCwd: resolvedCwd,
            processId: snapshot.process.processId,
            process: snapshot.process,
            nextCursor: snapshot.nextCursor,
            stdout: snapshot.stdout,
            stderr: snapshot.stderr,
            combinedOutput: snapshot.combinedOutput,
            stdoutTruncated: snapshot.stdoutTruncated,
            stderrTruncated: snapshot.stderrTruncated,
            combinedOutputTruncated: snapshot.combinedOutputTruncated,
            stdoutDroppedChars: snapshot.stdoutDroppedChars,
            stderrDroppedChars: snapshot.stderrDroppedChars,
            combinedOutputDroppedChars: snapshot.combinedOutputDroppedChars,
            next: "Yeni çıktıyı process_logs ile nextCursor değerinden okumaya devam et; gerekirse process_stop ile durdur.",
          });
        }

        await processManager.stop({
          processId: snapshot.process.processId,
          remove: true,
        });
        return terminalJsonResult({
          ok: !snapshot.process.spawnError && snapshot.process.exitCode === 0,
          completed: true,
          promoted: false,
          message: snapshot.process.exitCode === 0
            ? "Terminal komutu tamamlandı."
            : "Terminal komutu " + (snapshot.process.exitCode ?? "bilinmeyen") + " çıkış koduyla tamamlandı.",
          projectId,
          projectName,
          initialCwd: resolvedCwd,
          durationMs,
          exitCode: snapshot.process.exitCode,
          signal: snapshot.process.signal,
          spawnError: snapshot.process.spawnError,
          stdout: snapshot.stdout,
          stderr: snapshot.stderr,
          combinedOutput: snapshot.combinedOutput,
          stdoutTruncated: snapshot.stdoutTruncated,
          stderrTruncated: snapshot.stderrTruncated,
          combinedOutputTruncated: snapshot.combinedOutputTruncated,
          stdoutDroppedChars: snapshot.stdoutDroppedChars,
          stderrDroppedChars: snapshot.stderrDroppedChars,
          combinedOutputDroppedChars: snapshot.combinedOutputDroppedChars,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { mutationScopes: ["global"] },
  );

  registerTextTool(
    "terminal_start",
    {
      description:
        "Seçilen proje içinde kalıcı bir gerçek PTY terminal oturumu başlatır. Etkileşimli/ön-plan TTY işleri içindir; uzun yaşayan arka plan servisleri process_start kullanır. Zsh veya Bash çalışır; sonraki çağrılar terminal_write, terminal_read, terminal_resize ve terminal_stop ile yapılır.",
      inputSchema: {
        cwd: z.string().default(".").describe("Proje köküne göre göreli başlangıç klasörü"),
        shell: z.enum(["zsh", "bash"]).default("zsh"),
        cols: z.number().int().min(20).max(400).default(120),
        rows: z.number().int().min(5).max(200).default(30),
        label: z.string().min(1).max(80).optional(),
      },
      annotations: {
        title: "PTY terminali başlat",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ cwd, shell, cols, rows, label }) => {
      try {
        if (!agentAccess.terminal) {
          throw new Error("Terminal erişimi Control Center'da kapalı.");
        }

        const resolvedCwd = await safeResolve(cwd);
        const stats = await fsImpl.stat(resolvedCwd);
        if (!stats.isDirectory()) {
          throw new Error("Terminal başlangıç yolu bir klasör değil.");
        }

        const projectId = getActiveProjectId();
        const session = await terminalManager.start({
          projectId,
          projectName: getActiveProjectName(),
          cwd: resolvedCwd,
          shell: resolveTerminalShell(shell),
          shellArgs: ["-l"],
          env: buildGenericExecutionEnvironmentImpl({
            runtimeEnv,
            projectId,
            projectRoot: getActiveProjectRoot(),
          }),
          cols,
          rows,
          label,
        });

        return terminalJsonResult({
          ok: true,
          message: "PTY terminal oturumu başlatıldı.",
          session,
          next: "Çıktıyı terminal_read ile oku; komut göndermek için terminal_write kullan.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTextTool(
    "terminal_list",
    {
      description:
        "Equinox Local içindeki çalışan ve yakın zamanda kapanmış PTY terminal oturumlarını listeler.",
      inputSchema: {},
      annotations: {
        title: "PTY terminallerini listele",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => terminalJsonResult({ sessions: terminalManager.list() }),
    { projectAware: false },
  );

  registerTextTool(
    "terminal_read",
    {
      description:
        "Bir PTY terminal oturumunun yeni çıktısını kararlı cursor değeriyle okur. İsteğe bağlı olarak kısa süre yeni çıktı bekler ve ANSI kontrol kodlarını temizler.",
      inputSchema: {
        session_id: z.string().min(1).max(80),
        cursor: z.number().int().min(0).optional(),
        max_chars: z.number().int().min(1).max(120_000).default(30_000),
        strip_ansi: z.boolean().default(true),
        wait_ms: z.number().int().min(0).max(5_000).default(0),
      },
      annotations: {
        title: "PTY terminal çıktısını oku",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, cursor, max_chars, strip_ansi, wait_ms }) => {
      try {
        return terminalJsonResult(
          await terminalManager.read({
            sessionId: session_id,
            cursor,
            maxChars: max_chars,
            stripAnsiCodes: strip_ansi,
            waitMs: wait_ms,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "terminal_write",
    {
      description:
        "Çalışan PTY terminaline metin ve isteğe bağlı özel tuş gönderir. Enter, Ctrl+C, Ctrl+D, Tab, Escape ve ok tuşlarını destekler.",
      inputSchema: {
        session_id: z.string().min(1).max(80),
        data: z.string().max(100_000).default(""),
        key: z.enum(TERMINAL_KEYS).optional(),
      },
      annotations: {
        title: "PTY terminaline yaz",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ session_id, data, key }) => {
      try {
        if (!agentAccess.terminal) {
          throw new Error("Terminal erişimi Control Center'da kapalı.");
        }
        return terminalJsonResult({
          ok: true,
          session: terminalManager.write({ sessionId: session_id, data, key }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false, mutationScopes: ["global"] },
  );

  registerTextTool(
    "terminal_resize",
    {
      description: "Çalışan PTY terminalinin sütun ve satır ölçüsünü değiştirir.",
      inputSchema: {
        session_id: z.string().min(1).max(80),
        cols: z.number().int().min(20).max(400),
        rows: z.number().int().min(5).max(200),
      },
      annotations: {
        title: "PTY terminalini yeniden boyutlandır",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, cols, rows }) => {
      try {
        return terminalJsonResult({
          ok: true,
          session: terminalManager.resize({ sessionId: session_id, cols, rows }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false, mutationScopes: ["global"] },
  );

  registerTextTool(
    "terminal_stop",
    {
      description:
        "Bir PTY terminal oturumunu ve izlenen controlling-TTY joblarını durdurur. Normalde SIGHUP, gerekirse SIGKILL kullanır ve macOS'ta owned-job drain doğrulanır; kapanan kayıt isteğe bağlı silinebilir.",
      inputSchema: {
        session_id: z.string().min(1).max(80),
        force: z.boolean().default(false),
        remove: z.boolean().default(false),
      },
      annotations: {
        title: "PTY terminalini durdur",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ session_id, force, remove }) => {
      try {
        return terminalJsonResult({
          ok: true,
          session: await terminalManager.stop({ sessionId: session_id, force, remove }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false, mutationScopes: ["global"] },
  );
}
