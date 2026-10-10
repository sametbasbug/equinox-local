import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { protectWindowsPrivateStatePath } from "./equinox-local-private-state.js";
import { managedSupervisorPaths, readSupervisorTransport } from "./equinox-local-supervisor.js";

const execFile = promisify(execFileCallback);
const PROFILE = "equinox-local";

function quoteMcpPath(value) {
  if (typeof value !== "string" || !path.win32.isAbsolute(value) || /["%!\r\n\0]/u.test(value)) {
    throw new Error("Windows MCP command path contains unsupported characters.");
  }
  return `"${value}"`;
}

export function windowsTunnelInitArguments({ paths, nodePath, serverPath, tunnelId }) {
  return [
    "init", "--force", "--sample", "sample_mcp_stdio_local",
    "--profile", PROFILE, "--profile-dir", paths.profileDir,
    "--tunnel-id", tunnelId,
    "--mcp-command", `${quoteMcpPath(nodePath)} ${quoteMcpPath(serverPath)}`,
    "--control-plane-api-key-ref", `file:${paths.runtimeKeyPath}`,
    "--health-listen-addr", "127.0.0.1:0",
  ];
}

function childEnv(parent, mode) {
  const keys = ["SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "PATH", "PATHEXT", "COMSPEC", "USERNAME", "USERDOMAIN", "EQUINOX_LOCAL_RELEASE_DIR", "EQUINOX_LOCAL_INSTALL_ROOT", "EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE"];
  const env = Object.fromEntries(keys.filter((key) => typeof parent[key] === "string" && parent[key]).map((key) => [key, parent[key]]));
  env.EQUINOX_LOCAL_SUPERVISOR_MODE = mode;
  return env;
}

async function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: [options.stdin, "inherit", "inherit"] });
    let terminatingSignal = null;
    const onSignal = (signal) => { terminatingSignal = signal; if (!child.killed) child.kill(signal); };
    const term = () => onSignal("SIGTERM");
    const intr = () => onSignal("SIGINT");
    process.once("SIGTERM", term);
    process.once("SIGINT", intr);
    const cleanup = () => { process.off("SIGTERM", term); process.off("SIGINT", intr); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => { cleanup(); resolve({ code, signal, terminatingSignal }); });
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
  runChildImpl = runChild,
} = {}) {
  if (platform !== "win32") throw new Error("Windows shell supervisor requires Windows.");
  const paths = managedSupervisorPaths(homeDir, { platform, env });
  const releaseDir = env.EQUINOX_LOCAL_RELEASE_DIR;
  if (typeof releaseDir !== "string" || !path.win32.isAbsolute(releaseDir) ||
      typeof serverPath !== "string" || !path.win32.isAbsolute(serverPath) ||
      path.win32.normalize(env.EQUINOX_LOCAL_INSTALL_ROOT || "").toLowerCase() !== paths.installRoot.toLowerCase()) {
    throw new Error("Windows runtime source or release path is invalid.");
  }
  const cwd = path.win32.dirname(serverPath);
  const node = path.win32.join(releaseDir, "runtime", "node", "bin", "node.exe");
  const tunnel = path.win32.join(releaseDir, "runtime", "tunnel", "tunnel-client.exe");
  const localOnly = () => runChildImpl(node, [serverPath], { cwd, env: childEnv(env, "local-only"), stdin: "inherit" });
  let transport;
  try {
    transport = await readTransportImpl(paths, { platform });
  } catch {
    process.stderr.write("[Equinox Windows supervisor] Tunnel configuration needs attention; starting local-only Control Center.\n");
    return { mode: "local-only", ...(await localOnly()) };
  }
  if (!transport) return { mode: "local-only", ...(await localOnly()) };
  try {
    await mkdirImpl(paths.profileDir, { recursive: true, mode: 0o700 });
    await protectProfileImpl({ target: paths.profileDir, type: "directory" });
    await execFileImpl(tunnel, windowsTunnelInitArguments({ paths, nodePath: node, serverPath, tunnelId: transport.tunnelId }), {
      cwd, env: childEnv(env, "tunnel"), timeout: 15_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    const result = await runChildImpl(tunnel, ["run", "--profile", PROFILE, "--profile-dir", paths.profileDir], {
      cwd, env: childEnv(env, "tunnel"), stdin: "ignore",
    });
    if (result.terminatingSignal) return { mode: "tunnel", ...result };
    process.stderr.write("[Equinox Windows supervisor] Tunnel transport exited; starting local-only Control Center.\n");
  } catch {
    process.stderr.write("[Equinox Windows supervisor] Tunnel unavailable; starting local-only Control Center.\n");
  }
  return { mode: "local-only", ...(await localOnly()) };
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  runWindowsShellRuntimeSupervisor().catch(() => {
    process.stderr.write("[Equinox Windows supervisor] Failed to start runtime; check Control Center.\n");
    process.exitCode = 1;
  });
}
