import { execFile as execFileCallback, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { protectWindowsPrivateStatePath } from "./equinox-local-private-state.js";
import { repairWindowsPathext } from "./equinox-local-generic-execution.js";
import { managedSupervisorPaths, readSupervisorTransport } from "./equinox-local-supervisor.js";

type ShellEnvironment = NodeJS.ProcessEnv;
type SupervisorPaths = ReturnType<typeof managedSupervisorPaths>;
type ReconnectOptions = {
  delayMs: number;
  preflight: () => Promise<unknown>;
};
type ChildOptions = {
  cwd?: string | undefined;
  env?: ShellEnvironment | undefined;
  stdin?: "pipe" | "ignore" | "inherit" | undefined;
  reconnect?: ReconnectOptions | undefined;
};
type ChildResult = {
  code?: number | null;
  signal?: string | null;
  terminatingSignal?: string | null;
  retryRequested?: boolean;
};
type RunChild = (command: string, args: string[], options: ChildOptions) => Promise<ChildResult>;
type ChildDependencies = {
  spawnImpl?: typeof spawn | undefined;
  processLike?: Pick<EventEmitter, "once" | "off"> | undefined;
  setTimeoutImpl?: typeof setTimeout | undefined;
  clearTimeoutImpl?: typeof clearTimeout | undefined;
};
type RunSupervisorOptions = {
  platform?: string;
  homeDir?: string;
  env?: ShellEnvironment;
  serverPath?: string | undefined;
  readTransportImpl?: (paths: SupervisorPaths, options: {platform: string}) => Promise<{tunnelId: string} | null>;
  protectProfileImpl?: (input: {target: string; type: "directory"}) => Promise<unknown>;
  mkdirImpl?: typeof fs.mkdir;
  execFileImpl?: (command: string, args: string[], options: {cwd: string; env: ShellEnvironment; timeout: number; maxBuffer: number; windowsHide: true}) => Promise<unknown>;
  runChildImpl?: RunChild;
};
type TunnelInitOptions = {paths: SupervisorPaths; nodePath: string; serverPath: string; tunnelId: string};

const execFile = promisify(execFileCallback);
const PROFILE = "equinox-local";
const RECONNECT_BASE_DELAY_MS = 30_000;
const RECONNECT_MAX_DELAY_MS = 10 * 60_000;

export function windowsTunnelReconnectDelay(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Windows tunnel reconnect attempt is invalid.");
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 8));
}

function quoteMcpPath(value: string): string {
  if (typeof value !== "string" || !path.win32.isAbsolute(value) || /["%!\r\n\0]/u.test(value)) {
    throw new Error("Windows MCP command path contains unsupported characters.");
  }
  // tunnel-client's stdio command parser interprets Windows backslashes as
  // escapes (C:\Users -> C:Users). Go/Node on Windows accept forward slashes
  // for absolute paths, so normalize only the --mcp-command executable/argv.
  // Never change the underlying Windows filesystem or the file: key ref.
  return `"${value.replaceAll("\\", "/")}"`;
}

export function windowsTunnelInitArguments({ paths, nodePath, serverPath, tunnelId }: TunnelInitOptions): string[] {
  return [
    "init", "--force", "--sample", "sample_mcp_stdio_local",
    "--profile", PROFILE, "--profile-dir", paths.profileDir,
    "--tunnel-id", tunnelId,
    "--mcp-command", `${quoteMcpPath(nodePath)} ${quoteMcpPath(serverPath)}`,
    "--control-plane-api-key-ref", `file:${paths.runtimeKeyPath}`,
    "--health-listen-addr", "127.0.0.1:0",
  ];
}

function childEnv(parent: ShellEnvironment, mode: "local-only" | "tunnel"): ShellEnvironment {
  const keys = ["SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "PATH", "PATHEXT", "COMSPEC", "USERNAME", "USERDOMAIN", "EQUINOX_LOCAL_RELEASE_DIR", "EQUINOX_LOCAL_INSTALL_ROOT", "EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE"];
  const env = Object.fromEntries(keys.filter((key) => typeof parent[key] === "string" && parent[key]).map((key) => [key, parent[key]]));
  env.PATHEXT = repairWindowsPathext(env.PATHEXT);
  env.EQUINOX_LOCAL_SUPERVISOR_MODE = mode;
  return env;
}

export async function runWindowsSupervisorChild(command: string, args: string[], options: ChildOptions, {
  spawnImpl = spawn,
  processLike = process,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}: ChildDependencies = {}): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve, reject) => {
    // A configured tunnel may recover while the Control Center is running in
    // local-only mode. Keep that local server reachable during bounded tunnel
    // preflight attempts; stop it via its owned stdin only once preflight succeeds.
    const reconnect = options.reconnect ?? null;
    const child = spawnImpl(command, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
      stdio: [reconnect ? "pipe" : options.stdin, "inherit", "inherit"] });
    let terminatingSignal: string | null = null;
    let retryRequested = false;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let failedProbes = 0;
    const scheduleProbe = () => {
      if (!reconnect || closed || terminatingSignal) return;
      reconnectTimer = setTimeoutImpl(async () => {
        reconnectTimer = null;
        try {
          await reconnect.preflight();
          if (closed || terminatingSignal) return;
          retryRequested = true;
          // server.js owns graceful shutdown on an owned stdin EOF; do not
          // force-kill or interrupt unrelated Windows processes/tasks.
          child.stdin!.end();
        } catch {
          failedProbes++;
          if (!closed) scheduleProbe();
        }
      }, Math.min(RECONNECT_MAX_DELAY_MS, reconnect.delayMs * 2 ** Math.min(failedProbes, 8)));
    };
    const onSignal = (signal: NodeJS.Signals) => { terminatingSignal = signal; if (!child.killed) child.kill(signal); };
    const term = () => onSignal("SIGTERM");
    const intr = () => onSignal("SIGINT");
    processLike.once("SIGTERM", term);
    processLike.once("SIGINT", intr);
    const cleanup = () => {
      closed = true;
      if (reconnectTimer) clearTimeoutImpl(reconnectTimer);
      processLike.off("SIGTERM", term);
      processLike.off("SIGINT", intr);
    };
    child.once("spawn", () => {
      if (options.env?.EQUINOX_LOCAL_SUPERVISOR_MODE === "local-only") {
        process.stderr.write("[Equinox Windows supervisor] state=local-only-child-spawned.\n");
      }
      scheduleProbe();
    });
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => {
      if (options.env?.EQUINOX_LOCAL_SUPERVISOR_MODE === "local-only") {
        const phase = code === 0 ? "local-only-child-exit-zero"
          : code === null && signal === "SIGTERM" ? "local-only-child-sigterm"
          : code === null && signal === "SIGINT" ? "local-only-child-sigint"
          : code === null && signal === "SIGBREAK" ? "local-only-child-sigbreak"
          : code === null ? "local-only-child-signal-other"
          : "local-only-child-exit-nonzero";
        process.stderr.write("[Equinox Windows supervisor] state=" + phase + ".\n");
      }
      cleanup();
      resolve({ code, signal, terminatingSignal, retryRequested });
    });
  });
}

export async function runWindowsShellRuntimeSupervisor({
  platform = process.platform,
  homeDir = os.homedir(),
  env = process.env,
  serverPath = process.argv[2],
  readTransportImpl = readSupervisorTransport,
  protectProfileImpl = protectWindowsPrivateStatePath,
  mkdirImpl = fs.mkdir,
  execFileImpl = execFile,
  runChildImpl = runWindowsSupervisorChild,
}: RunSupervisorOptions = {}): Promise<{mode: "local-only" | "tunnel"} & ChildResult> {
  if (platform !== "win32") throw new Error("Windows shell supervisor requires Windows.");
  const paths = managedSupervisorPaths(homeDir, { platform, env }) as SupervisorPaths;
  const releaseDir = env.EQUINOX_LOCAL_RELEASE_DIR;
  if (typeof releaseDir !== "string" || !path.win32.isAbsolute(releaseDir) ||
      typeof serverPath !== "string" || !path.win32.isAbsolute(serverPath) ||
      path.win32.normalize(env.EQUINOX_LOCAL_INSTALL_ROOT || "").toLowerCase() !== paths.installRoot.toLowerCase()) {
    throw new Error("Windows runtime source or release path is invalid.");
  }
  const cwd = path.win32.dirname(serverPath);
  const node = path.win32.join(releaseDir, "runtime", "node", "bin", "node.exe");
  const tunnel = path.win32.join(releaseDir, "runtime", "tunnel", "tunnel-client.exe");
  const localOnly = (reconnect: ReconnectOptions | null = null) => runChildImpl(node, [serverPath], {
    // The gate stdin is an update-handshake pipe and can reach EOF after the
    // gate releases the child. The local-only server treats stdin EOF as a
    // deliberate shutdown. Give it a distinct supervisor-owned pipe that
    // stays open until intentional WPF Job Object shutdown or tunnel handoff.
    cwd, env: childEnv(env, "local-only"), stdin: "pipe", ...(reconnect ? { reconnect } : {}),
  });
  let transport: {tunnelId: string} | null;
  try {
    transport = await readTransportImpl(paths, { platform });
  } catch {
    process.stderr.write("[Equinox Windows supervisor] state=tunnel-config-invalid; starting local-only Control Center.\n");
    return { mode: "local-only", ...(await localOnly()) };
  }
  if (!transport) {
    process.stderr.write("[Equinox Windows supervisor] state=tunnel-not-configured; starting local-only Control Center.\n");
    return { mode: "local-only", ...(await localOnly()) };
  }

  const initializeTunnel = async () => {
    await mkdirImpl(paths.profileDir, { recursive: true, mode: 0o700 });
    await protectProfileImpl({ target: paths.profileDir, type: "directory" });
    await execFileImpl(tunnel, windowsTunnelInitArguments({ paths, nodePath: node, serverPath, tunnelId: transport.tunnelId }), {
      cwd, env: childEnv(env, "tunnel"), timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
  };
  let failedAttempts = 0;
  while (true) {
    try {
      await initializeTunnel();
      process.stderr.write("[Equinox Windows supervisor] state=tunnel-starting.\n");
      const tunnelStart = Date.now();
      const result = await runChildImpl(tunnel, ["run", "--profile", PROFILE, "--profile-dir", paths.profileDir], {
        cwd, env: childEnv(env, "tunnel"), stdin: "ignore",
      });
      if (result.terminatingSignal) return { mode: "tunnel", ...result };
      if (Date.now() - tunnelStart >= 5 * 60_000) failedAttempts = 0;
      process.stderr.write("[Equinox Windows supervisor] state=tunnel-exited; temporarily starting local-only Control Center.\n");
    } catch {
      // The tunnel executable may fail init, profile validation or spawn. Do
      // not leak credential paths, tunnel IDs or child stderr to diagnostics.
      process.stderr.write("[Equinox Windows supervisor] state=tunnel-init-failed; temporarily starting local-only Control Center.\n");
    }
    failedAttempts++;
    const retry = await localOnly({
      delayMs: windowsTunnelReconnectDelay(failedAttempts),
      preflight: initializeTunnel,
    });
    if (retry.terminatingSignal || !retry.retryRequested) return { mode: "local-only", ...retry };
    // The owned local-only server has completed its graceful shutdown after
    // successful tunnel preflight. Only now may the tunnel bind the same port.
    process.stderr.write("[Equinox Windows supervisor] state=tunnel-retry-ready; attempting reconnect.\n");
  }
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runWindowsShellRuntimeSupervisor().then(({ code, signal }) => {
    // The WPF gate must see the actual child failure, not a clean 0 from
    // the supervisor's fulfilled Promise.
    process.exitCode = typeof code === "number" && Number.isInteger(code) ? code : (signal ? 128 : 1);
  }).catch(() => {
    process.stderr.write("[Equinox Windows supervisor] Failed to start runtime; check Control Center.\n");
    process.exitCode = 1;
  });
}
