import type * as zod from "zod/v4";

type ToolInput = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  label?: string;
  expected_ports: number[];
  startup_wait_ms: number;
  state: "all" | "running" | "exited";
  process_id: string;
  cursor?: number;
  max_chars: number;
  strip_ansi: boolean;
  wait_ms: number;
  force: boolean;
  remove: boolean;
  port: number;
  host: "127.0.0.1" | "localhost" | "::1";
  timeout_ms: number;
};
type ToolSchema = {
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  description: string;
};
type RegisterTool = (
  name: string,
  config: ToolSchema,
  handler: (input: ToolInput) => Promise<unknown>,
  options?: { projectAware?: boolean; mutationScopes?: string[] },
) => unknown;
type ManagedProcess = { processId: string; running: boolean; [key: string]: unknown };
type ProcessManager = {
  findByPort: (port: number) => unknown[];
  start: (input: Record<string, unknown>) => Promise<{processId: string}>;
  readLogs: (input: {
    processId: string;
    cursor?: number | undefined;
    maxChars: number;
    stripAnsiCodes: boolean;
    waitMs: number;
  }) => Promise<{process: unknown; output: string; nextCursor: number}>;
  list: () => ManagedProcess[];
  waitForExit: (input: {processId: string; waitMs: number}) => Promise<unknown>;
  snapshotOutput: (input: {processId: string; maxChars: number; stripAnsiCodes: boolean}) => {
    process: ManagedProcess;
    nextCursor: number;
    combinedOutput: string;
    combinedOutputTruncated: boolean;
    combinedOutputDroppedChars: number;
  };
  stop: (input: {processId: string; force: boolean; remove: boolean}) => Promise<unknown>;
};
type PortProbe = (input: {host: string; port: number; timeoutMs: number}) => Promise<unknown>;
type LocalPortInspection = {
  probe: unknown;
  listeners: unknown[];
  lsofError: string | null;
  managedProcesses: unknown[];
  suggestedUrl: string;
};
type PortInspectorOptions = {
  processManager: Pick<ProcessManager, "findByPort">;
  platform?: string;
  probeTcpPortImpl?: PortProbe;
  execFileImpl?: (file: string, args: string[], options: {
    timeout: number;
    maxBuffer: number;
    env: Record<string, string>;
  }) => Promise<{stdout?: string}>;
};
type ProcessToolsOptions = {
  registerTextTool: RegisterTool;
  z: typeof zod;
  processManager: ProcessManager;
  inspectLocalPort: (input: {port: number; host: string; timeoutMs: number}) => Promise<LocalPortInspection>;
  agentAccess: {terminal: boolean};
  safeResolve: (cwd: string) => Promise<string>;
  fsImpl?: Pick<typeof fs, "stat">;
  getActiveProjectId: () => string | null;
  getActiveProjectName: () => string;
  getActiveProjectRoot: () => string | null;
  runtimeEnv?: NodeJS.ProcessEnv;
  buildGenericExecutionEnvironmentImpl?: (input: {
    runtimeEnv: NodeJS.ProcessEnv;
    extraEnv: Record<string, string> | undefined;
    projectId: string | null;
    projectRoot: string | null;
  }) => ReturnType<typeof buildGenericExecutionEnvironment>;
  textResult: (text: string) => unknown;
  errorResult: (error: unknown) => unknown;
};

import fs from "node:fs/promises";

import { buildGenericExecutionEnvironment } from "./equinox-local-generic-execution.js";
import { parseLsofFieldOutput, probeTcpPort } from "./process-manager.js";

export function createLocalPortInspector({
  processManager,
  platform = process.platform,
  probeTcpPortImpl = probeTcpPort,
  execFileImpl,
}: PortInspectorOptions = {} as PortInspectorOptions) {
  return async function inspectLocalPort({
    port,
    host = "127.0.0.1",
    timeoutMs = 1000,
  }: {port: number; host?: string; timeoutMs?: number} = {} as {port:number}) : Promise<LocalPortInspection> {
    const probe = await probeTcpPortImpl({ host, port, timeoutMs });
    let listeners: unknown[] = [];
    let lsofError: string | null = null;

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
        if ((error as {code?: string | number})?.code !== 1) {
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
  buildGenericExecutionEnvironmentImpl = buildGenericExecutionEnvironment as NonNullable<ProcessToolsOptions["buildGenericExecutionEnvironmentImpl"]>,
  textResult,
  errorResult,
}: ProcessToolsOptions = {} as ProcessToolsOptions) {
  const processJsonResult = (value: unknown) => textResult(JSON.stringify(value, null, 2));

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
