import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createEquinoxLocalConfigManager,
  serializeEquinoxLocalConfig,
} from "./equinox-local-config.js";
import {
  managedSupervisorPaths,
  resolveSupervisorRelease,
} from "./equinox-local-supervisor.js";

const execFile = promisify(execFileCallback);

export const EQUINOX_BROWSER_PRODUCTION_EXTENSION_ID = "npdneefcobilfkjlihghjgjnknenhfoj";
export const EQUINOX_BROWSER_NATIVE_HOST_NAME = "dev.equinox.browser";
export const EQUINOX_LOCAL_LAUNCH_AGENT_LABEL = "dev.equinox.local";

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

async function ensureDirectory(directory, mode = 0o700, { enforceMode = true } = {}) {
  await fs.mkdir(directory, { recursive: true, mode });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Managed bootstrap directory is unsafe: ${directory}`);
  if (enforceMode) await fs.chmod(directory, mode).catch(() => {});
}

async function atomicWrite(filePath, content, mode) {
  const parent = path.dirname(filePath);
  await ensureDirectory(parent, 0o700, { enforceMode: false });
  const temporary = path.join(parent, `.equinox-bootstrap-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, mode).catch(() => {});
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function ensureWorkspaceGitRepository(workspaceRoot, { execFileImpl = execFile } = {}) {
  const expectedRoot = await fs.realpath(workspaceRoot);
  const verify = async () => {
    const { stdout } = await execFileImpl(
      "/usr/bin/git",
      ["-C", workspaceRoot, "rev-parse", "--show-toplevel"],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    const reported = stdout.trim();
    if (!reported) throw new Error("Equinox Workspace Git root is empty.");
    const actualRoot = await fs.realpath(reported);
    if (actualRoot !== expectedRoot) {
      throw new Error("Equinox Workspace resolved to an unexpected parent Git repository.");
    }
    return actualRoot;
  };

  try {
    return await verify();
  } catch (error) {
    const gitEntry = path.join(workspaceRoot, ".git");
    try {
      const stat = await fs.lstat(gitEntry);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error("Existing Equinox Workspace .git entry is unsafe.");
      }
      throw new Error(`Existing Equinox Workspace Git metadata is invalid: ${error instanceof Error ? error.message : error}`);
    } catch (gitError) {
      if (gitError?.code !== "ENOENT") throw gitError;
    }
  }

  await execFileImpl(
    "/usr/bin/git",
    ["-C", workspaceRoot, "init", "--quiet"],
    { timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  return await verify();
}

export function seedEquinoxLocalConfig({ homeDir, installRoot }) {
  const workspaceRoot = path.join(installRoot, "workspace");
  const downloadsRoot = path.join(homeDir, "Downloads");
  return Object.freeze({
    version: 1,
    defaultProject: "workspace",
    runtime: Object.freeze({
      workspaceProject: "workspace",
      downloadsRoot: "downloads",
    }),
    projects: Object.freeze({
      workspace: Object.freeze({
        name: "Equinox Workspace",
        root: workspaceRoot,
        worktrees: false,
      }),
    }),
    fileRoots: Object.freeze({
      downloads: Object.freeze({
        name: "Downloads",
        root: downloadsRoot,
        access: "read-only",
      }),
    }),
    controlCenter: Object.freeze({ enabled: true, port: 24891 }),
  });
}

export function launchAgentPlist({ homeDir, installRoot }) {
  const current = path.join(installRoot, "current");
  const nodeBinary = path.join(current, "runtime", "node", "bin", "node");
  const supervisor = path.join(current, "equinox-local-supervisor.js");
  const logsDir = path.join(homeDir, "Library", "Logs");
  const stdoutPath = path.join(logsDir, "Equinox Local.log");
  const stderrPath = path.join(logsDir, "Equinox Local.error.log");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xmlEscape(nodeBinary)}</string>\n    <string>${xmlEscape(supervisor)}</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HOME</key>\n    <string>${xmlEscape(homeDir)}</string>\n    <key>EQUINOX_LOCAL_INSTALL_ROOT</key>\n    <string>${xmlEscape(installRoot)}</string>\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n  <key>ProcessType</key>\n  <string>Background</string>\n  <key>ThrottleInterval</key>\n  <integer>10</integer>\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(stdoutPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(stderrPath)}</string>\n</dict>\n</plist>\n`;
}

export function nativeHostManifest(hostWrapperPath) {
  return `${JSON.stringify({
    name: EQUINOX_BROWSER_NATIVE_HOST_NAME,
    description: "Equinox Browser native messaging bridge",
    path: hostWrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EQUINOX_BROWSER_PRODUCTION_EXTENSION_ID}/`],
  }, null, 2)}\n`;
}

export function nativeHostWrapper({ installRoot }) {
  const current = path.join(installRoot, "current");
  const nodeBinary = path.join(current, "runtime", "node", "bin", "node");
  const hostScript = path.join(current, "equinox-browser-native-host.js");
  return `#!/bin/bash\nset -euo pipefail\nexec ${shellQuote(nodeBinary)} ${shellQuote(hostScript)} "$@"\n`;
}

async function ensureInitialConfig({ homeDir, installRoot, configPath }) {
  try {
    const stat = await fs.lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Existing Equinox Local config is not a safe normal file.");
    const manager = createEquinoxLocalConfigManager({ homeDir, configPath });
    await manager.initialize();
    return Object.freeze({ created: false, revision: manager.revision });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const config = seedEquinoxLocalConfig({ homeDir, installRoot });
  await atomicWrite(configPath, serializeEquinoxLocalConfig(config), 0o600);
  const manager = createEquinoxLocalConfigManager({ homeDir, configPath });
  await manager.initialize();
  return Object.freeze({ created: true, revision: manager.revision });
}

export async function bootstrapManagedEquinoxUser({ homeDir = os.homedir() } = {}) {
  if (process.platform !== "darwin") throw new Error("Equinox Local managed bootstrap is supported only on macOS.");
  const paths = managedSupervisorPaths(homeDir);
  const release = await resolveSupervisorRelease(paths);
  const configPath = path.join(paths.installRoot, "config.json");
  const workspaceRoot = path.join(paths.installRoot, "workspace");
  const downloadsRoot = path.join(homeDir, "Downloads");
  const secretsRoot = path.join(paths.installRoot, "secrets");
  const logsRoot = path.join(homeDir, "Library", "Logs");

  await ensureDirectory(paths.installRoot, 0o700);
  await ensureDirectory(workspaceRoot, 0o700);
  await ensureWorkspaceGitRepository(workspaceRoot);
  await ensureDirectory(downloadsRoot, 0o700, { enforceMode: false });
  await ensureDirectory(secretsRoot, 0o700);
  await ensureDirectory(logsRoot, 0o700, { enforceMode: false });

  const config = await ensureInitialConfig({ homeDir, installRoot: paths.installRoot, configPath });

  const launchAgentsRoot = path.join(homeDir, "Library", "LaunchAgents");
  await ensureDirectory(launchAgentsRoot, 0o700, { enforceMode: false });
  const launchAgentPath = path.join(launchAgentsRoot, `${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}.plist`);
  await atomicWrite(launchAgentPath, launchAgentPlist({ homeDir, installRoot: paths.installRoot }), 0o600);

  const nativeHostRoot = path.join(homeDir, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
  await ensureDirectory(nativeHostRoot, 0o700, { enforceMode: false });
  const hostWrapperPath = path.join(paths.installRoot, "equinox-browser-native-host");
  await atomicWrite(hostWrapperPath, nativeHostWrapper({ installRoot: paths.installRoot }), 0o700);
  const nativeHostManifestPath = path.join(nativeHostRoot, `${EQUINOX_BROWSER_NATIVE_HOST_NAME}.json`);
  await atomicWrite(nativeHostManifestPath, nativeHostManifest(hostWrapperPath), 0o600);

  return Object.freeze({
    version: release.version,
    installRoot: paths.installRoot,
    releaseDir: release.releaseDir,
    configPath,
    configCreated: config.created,
    configRevision: config.revision,
    launchAgentPath,
    hostWrapperPath,
    nativeHostManifestPath,
    controlCenterUrl: "http://127.0.0.1:24891/",
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && path.basename(invokedPath) === path.basename(fileURLToPath(import.meta.url))) {
  bootstrapManagedEquinoxUser().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
