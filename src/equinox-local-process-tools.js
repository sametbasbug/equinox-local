import fs from "node:fs/promises";

import { buildGenericExecutionEnvironment } from "./equinox-local-generic-execution.js";
import { parseLsofFieldOutput, probeTcpPort } from "./process-manager.js";

export function createLocalPortInspector({
  processManager,
  platform = process.platform,
  probeTcpPortImpl = probeTcpPort,
  execFileImpl,
} = {}) {
  return async function inspectLocalPort({
    port,
    host = "127.0.0.1",
    timeoutMs = 1000,
  } = {}) {
    const probe = await probeTcpPortImpl({ host, port, timeoutMs });
    let listeners = [];
    let lsofError = null;

    if (platform !== "win32") {
      try {
        if (typeof execFileImpl !== "function") {
          throw new Error("Local port listener inspection requires execFileImpl on this platform.");
        }
        const { stdout = "" } = await execFileImpl(
          "/usr/sbin/lsof",
          ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcn"],
          {
            timeout: 5000,
            maxBuffer: 1024 * 1024,
            env: { PATH: "/usr/sbin:/usr/bin:/bin", LC_ALL: "C" },
          },
        );
        listeners = parseLsofFieldOutput(stdout);
      } catch (error) {
        if (error?.code !== 1) {
          lsofError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    return {
      probe,
      listeners,
      lsofError,
      managedProcesses: processManager.findByPort(port),
      suggestedUrl: `http://${host === "::1" ? "[::1]" : host}:${port}/`,
    };
  };
}

export function registerProcessTools({
  registerTextTool,
  z,
  processManager,
  inspectLocalPort,
  agentAccess,
  safeResolve,
  fsImpl = fs,
  getActiveProjectId,
  getActiveProjectName,
  getActiveProjectRoot,
  runtimeEnv = process.env,
  buildGenericExecutionEnvironmentImpl = buildGenericExecutionEnvironment,
  textResult,
  errorResult,
} = {}) {
  const processJsonResult = (value) => textResult(JSON.stringify(value, null, 2));

  registerTextTool(
    "process_start",
    {
      description:
        "Seçilen proje içinde PTY gerektirmeyen uzun süreli bir arka plan süreci başlatır. npm run dev, preview sunucuları, watcher'lar ve yerel servisler için kullanılır; stdout ve stderr process_logs ile cursor üzerinden okunur.",
      inputSchema: {
        command: z.string().min(1).max(500),
        args: z.array(z.string().max(2000)).max(100).default([]),
        cwd: z.string().default(".").describe("Proje köküne göre göreli başlangıç klasörü"),
        env: z.record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
          z.string().max(10_000),
        ).optional(),
        label: z.string().min(1).max(100).optional(),
        expected_ports: z.array(z.number().int().min(1).max(65535)).max(16).default([]),
        startup_wait_ms: z.number().int().min(0).max(5000).default(500),
      },
      annotations: {
        title: "Arka plan süreci başlat",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command, args, cwd, env, label, expected_ports, startup_wait_ms }) => {
      try {
        if (!agentAccess.terminal) {
          throw new Error("Terminal ve süreç erişimi Control Center'da kapalı.");
        }

        const resolvedCwd = await safeResolve(cwd);
        const stats = await fsImpl.stat(resolvedCwd);
        if (!stats.isDirectory()) {
          throw new Error("Süreç başlangıç yolu bir klasör değil.");
        }

        const projectId = getActiveProjectId();
        const processInfo = await processManager.start({
          projectId,
          projectName: getActiveProjectName(),
          cwd: resolvedCwd,
          command,
          args,
          env: buildGenericExecutionEnvironmentImpl({
            runtimeEnv,
            extraEnv: env,
            projectId,
            projectRoot: getActiveProjectRoot(),
          }),
          label,
          expectedPorts: expected_ports,
        });

        const initialLogs = await processManager.readLogs({
          processId: processInfo.processId,
          cursor: 0,
          maxChars: 20_000,
          stripAnsiCodes: true,
          waitMs: startup_wait_ms,
        });

        return processJsonResult({
          ok: true,
          message: "Arka plan süreci başlatıldı.",
          process: initialLogs.process,
          initialOutput: initialLogs.output,
          nextCursor: initialLogs.nextCursor,
          next: "Yeni çıktıyı process_logs ile nextCursor değerinden okumaya devam et.",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTextTool(
    "process_list",
    {
      description:
        "Equinox Local tarafından başlatılmış çalışan ve yakın zamanda kapanmış arka plan süreçlerini listeler.",
      inputSchema: {
        state: z.enum(["all", "running", "exited"]).default("all"),
      },
      annotations: {
        title: "Arka plan süreçlerini listele",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ state }) => {
      const processes = processManager.list().filter(
        (item) => state === "all" || (state === "running" ? item.running : !item.running),
      );
      return processJsonResult({ state, count: processes.length, processes });
    },
    { projectAware: false },
  );

  registerTextTool(
    "process_logs",
    {
      description:
        "Yönetilen arka plan sürecinin birleştirilmiş stdout ve stderr çıktısını kararlı cursor değeriyle okur; isteğe bağlı olarak kısa süre yeni log bekler.",
      inputSchema: {
        process_id: z.string().min(1).max(80),
        cursor: z.number().int().min(0).optional(),
        max_chars: z.number().int().min(1).max(160_000).default(40_000),
        strip_ansi: z.boolean().default(true),
        wait_ms: z.number().int().min(0).max(10_000).default(0),
      },
      annotations: {
        title: "Arka plan süreci loglarını oku",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ process_id, cursor, max_chars, strip_ansi, wait_ms }) => {
      try {
        return processJsonResult(
          await processManager.readLogs({
            processId: process_id,
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
    "process_wait",
    {
      description:
        "Yönetilen sonlu bir sürecin tamamlanmasını bounded süre bekler. Bekleme süresi dolarsa süreci öldürmez veya yeniden başlatmaz; aynı process kimliğiyle çalışan durumu ve bounded çıktı snapshot'ını döndürür.",
      inputSchema: {
        process_id: z.string().min(1).max(80),
        wait_ms: z.number().int().min(0).max(120_000).default(30_000),
        max_chars: z.number().int().min(1).max(160_000).default(40_000),
        strip_ansi: z.boolean().default(true),
      },
      annotations: {
        title: "Yönetilen sürecin tamamlanmasını bekle",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ process_id, wait_ms, max_chars, strip_ansi }) => {
      try {
        await processManager.waitForExit({
          processId: process_id,
          waitMs: wait_ms,
        });
        const snapshot = processManager.snapshotOutput({
          processId: process_id,
          maxChars: max_chars,
          stripAnsiCodes: strip_ansi,
        });
        const completed = snapshot.process.running === false;
        return processJsonResult({
          ok: true,
          completed,
          waitExpired: !completed && wait_ms > 0,
          process: snapshot.process,
          nextCursor: snapshot.nextCursor,
          combinedOutput: snapshot.combinedOutput,
          combinedOutputTruncated: snapshot.combinedOutputTruncated,
          combinedOutputDroppedChars: snapshot.combinedOutputDroppedChars,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "process_stop",
    {
      description:
        "Equinox Local tarafından başlatılmış arka plan sürecini ve onun süreç grubunu durdurur. Önce SIGTERM, gerekirse SIGKILL kullanır; kapanan kayıt isteğe bağlı silinebilir.",
      inputSchema: {
        process_id: z.string().min(1).max(80),
        force: z.boolean().default(false),
        remove: z.boolean().default(false),
      },
      annotations: {
        title: "Arka plan sürecini durdur",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ process_id, force, remove }) => {
      try {
        return processJsonResult({
          ok: true,
          process: await processManager.stop({
            processId: process_id,
            force,
            remove,
          }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false, mutationScopes: ["global"] },
  );

  registerTextTool(
    "port_status",
    {
      description:
        "Yerel loopback üzerindeki tek bir TCP portunun dinlenip dinlenmediğini ölçer; işletim sistemi dinleyici kanıtını ve Equinox Local tarafından o porta bağlanmış yönetilen süreçleri gösterir.",
      inputSchema: {
        port: z.number().int().min(1).max(65535),
        host: z.enum(["127.0.0.1", "localhost", "::1"]).default("127.0.0.1"),
        timeout_ms: z.number().int().min(100).max(5000).default(1000),
      },
      annotations: {
        title: "Yerel TCP portunu denetle",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ port, host, timeout_ms }) => {
      try {
        return processJsonResult({
          ok: true,
          ...(await inspectLocalPort({ port, host, timeoutMs: timeout_ms })),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );


}
