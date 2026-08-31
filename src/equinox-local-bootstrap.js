import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createEquinoxLocalConfigManager,
  serializeEquinoxLocalConfig,
} from "./equinox-local-config.js";
import {
  equinoxLocalAppExecutablePath,
  equinoxLocalAppRuntimeWrapperPath,
} from "./equinox-local-app-host.js";
import { synchronizeEquinoxLocalNativeAppHost } from "./equinox-local-native-app-host.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import {
  managedSupervisorPaths,
  resolveSupervisorRelease,
} from "./equinox-local-supervisor.js";

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

const WORKSPACE_GIT_HEAD = "ref: refs/heads/main\n";
const WORKSPACE_GIT_CONFIG = `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n`;

async function assertWorkspaceGitDirectory(gitRoot, { fsImpl = fs } = {}) {
  const stat = await fsImpl.lstat(gitRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Existing Equinox Workspace .git entry is unsafe.");
  }
  for (const relative of ["objects", "refs"]) {
    const nested = await fsImpl.lstat(path.join(gitRoot, relative));
    if (!nested.isDirectory() || nested.isSymbolicLink()) {
      throw new Error(`Existing Equinox Workspace Git ${relative} metadata is unsafe.`);
    }
  }
  for (const relative of ["HEAD", "config"]) {
    const nested = await fsImpl.lstat(path.join(gitRoot, relative));
    if (!nested.isFile() || nested.isSymbolicLink() || nested.size < 1 || nested.size > 64 * 1024) {
      throw new Error(`Existing Equinox Workspace Git ${relative} metadata is unsafe.`);
    }
  }
  const { data: headText } = await readBoundedNormalFile(path.join(gitRoot, "HEAD"), {
    fsImpl,
    minBytes: 1,
    maxBytes: 64 * 1024,
    encoding: "utf8",
    label: "Existing Equinox Workspace Git HEAD metadata",
  });
  const head = headText.trim();
  const detached = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head);
  const symbolic = head.startsWith("ref: refs/heads/")
    && head.length > "ref: refs/heads/".length
    && !head.includes("..")
    && !head.includes("@{")
    && !head.includes("\\")
    && !head.endsWith("/");
  if (!detached && !symbolic) {
    throw new Error("Existing Equinox Workspace Git HEAD metadata is invalid.");
  }
  return gitRoot;
}

async function assertNormalGitHead(gitRoot, { fsImpl = fs } = {}) {
  const headPath = path.join(gitRoot, "HEAD");
  const { data: headText } = await readBoundedNormalFile(headPath, {
    fsImpl,
    minBytes: 1,
    maxBytes: 64 * 1024,
    encoding: "utf8",
    label: "Configured Git metadata HEAD",
  });
  const head = headText.trim();
  const detached = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head);
  const symbolic = head.startsWith("ref: refs/heads/")
    && head.length > "ref: refs/heads/".length
    && !head.includes("..")
    && !head.includes("@{")
    && !head.includes("\\")
    && !head.endsWith("/");
  if (!detached && !symbolic) throw new Error("Configured Git metadata HEAD is invalid.");
}

export async function validateIndependentGitProjectRoot(projectRoot, { fsImpl = fs } = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new Error("Configured project root must be an absolute path.");
  }
  const projectReal = await fsImpl.realpath(projectRoot);
  const projectStat = await fsImpl.lstat(projectReal);
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) {
    throw new Error("Configured project root is not a safe directory.");
  }

  const gitEntry = path.join(projectReal, ".git");
  const gitStat = await fsImpl.lstat(gitEntry);
  if (gitStat.isSymbolicLink()) throw new Error("Configured project .git entry may not be a symbolic link.");

  if (gitStat.isDirectory()) {
    await assertNormalGitHead(gitEntry, { fsImpl });
    return projectReal;
  }

  if (!gitStat.isFile()) {
    throw new Error("Configured project .git entry is invalid.");
  }
  const { data: gitFile } = await readBoundedNormalFile(gitEntry, {
    fsImpl,
    minBytes: 1,
    maxBytes: 64 * 1024,
    encoding: "utf8",
    label: "Configured project .git entry",
  });
  if (gitFile.includes("\0") || gitFile.includes("\r") || gitFile.split("\n").filter(Boolean).length !== 1) {
    throw new Error("Configured project Git worktree metadata is invalid.");
  }
  const match = /^gitdir: (.+)\n?$/u.exec(gitFile);
  if (!match?.[1]) throw new Error("Configured project Git worktree metadata is invalid.");
  const configuredGitDir = path.isAbsolute(match[1])
    ? match[1]
    : path.resolve(projectReal, match[1]);
  const gitDirReal = await fsImpl.realpath(configuredGitDir);
  const gitDirStat = await fsImpl.lstat(gitDirReal);
  if (!gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) {
    throw new Error("Configured project Git worktree directory is unsafe.");
  }
  await assertNormalGitHead(gitDirReal, { fsImpl });
  return projectReal;
}

export async function ensureWorkspaceGitRepository(workspaceRoot, { fsImpl = fs } = {}) {
  const expectedRoot = await fsImpl.realpath(workspaceRoot);
  const gitEntry = path.join(expectedRoot, ".git");

  try {
    await assertWorkspaceGitDirectory(gitEntry, { fsImpl });
    return expectedRoot;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporary = path.join(expectedRoot, `.git.equinox-init-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    await fsImpl.mkdir(path.join(temporary, "objects", "info"), { recursive: true, mode: 0o700 });
    await fsImpl.mkdir(path.join(temporary, "objects", "pack"), { recursive: true, mode: 0o700 });
    await fsImpl.mkdir(path.join(temporary, "refs", "heads"), { recursive: true, mode: 0o700 });
    await fsImpl.mkdir(path.join(temporary, "refs", "tags"), { recursive: true, mode: 0o700 });
    await fsImpl.writeFile(path.join(temporary, "HEAD"), WORKSPACE_GIT_HEAD, { flag: "wx", mode: 0o600 });
    await fsImpl.writeFile(path.join(temporary, "config"), WORKSPACE_GIT_CONFIG, { flag: "wx", mode: 0o600 });
    await fsImpl.rename(temporary, gitEntry);
  } catch (error) {
    await fsImpl.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await assertWorkspaceGitDirectory(gitEntry, { fsImpl });
  return expectedRoot;
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

export function appRuntimeWrapper({ installRoot }) {
  const current = path.join(installRoot, "current");
  const nodeBinary = path.join(current, "runtime", "node", "bin", "node");
  const supervisor = path.join(current, "equinox-local-supervisor.js");
  return `#!/bin/bash\nset -euo pipefail\nRUNTIME_HOST_PID=$PPID\nSUPERVISOR_PID=\"\"\nPARENT_WATCHDOG_PID=\"\"\ncleanup() {\n  if [ -n \"$PARENT_WATCHDOG_PID\" ]; then\n    kill \"$PARENT_WATCHDOG_PID\" >/dev/null 2>&1 || true\n    wait \"$PARENT_WATCHDOG_PID\" 2>/dev/null || true\n  fi\n  if [ -n \"$SUPERVISOR_PID\" ]; then\n    kill \"$SUPERVISOR_PID\" >/dev/null 2>&1 || true\n    wait \"$SUPERVISOR_PID\" 2>/dev/null || true\n  fi\n}\nshutdown() {\n  exit 0\n}\ntrap cleanup EXIT\ntrap shutdown INT TERM HUP\nwatch_runtime_host() {\n  while kill -0 \"$RUNTIME_HOST_PID\" >/dev/null 2>&1; do\n    sleep 1\n  done\n  kill -TERM \"$$\" >/dev/null 2>&1 || true\n}\nwatch_runtime_host &\nPARENT_WATCHDOG_PID=$!\n${shellQuote(nodeBinary)} ${shellQuote(supervisor)} &\nSUPERVISOR_PID=$!\nwait \"$SUPERVISOR_PID\"\n`;
}

export function launchAgentPlist({ homeDir, installRoot }) {
  const appExecutable = equinoxLocalAppExecutablePath(homeDir);
  const logsDir = path.join(homeDir, "Library", "Logs");
  const stdoutPath = path.join(logsDir, "Equinox Local.log");
  const stderrPath = path.join(logsDir, "Equinox Local.error.log");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${EQUINOX_LOCAL_LAUNCH_AGENT_LABEL}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xmlEscape(appExecutable)}</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HOME</key>\n    <string>${xmlEscape(homeDir)}</string>\n    <key>EQUINOX_LOCAL_RUNTIME_HOST</key>\n    <string>1</string>\n    <key>EQUINOX_LOCAL_INSTALL_ROOT</key>\n    <string>${xmlEscape(installRoot)}</string>\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n  <key>ProcessType</key>\n  <string>Background</string>\n  <key>ThrottleInterval</key>\n  <integer>10</integer>\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(stdoutPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(stderrPath)}</string>\n</dict>\n</plist>\n`;
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

export async function bootstrapManagedEquinoxUser({
  homeDir = os.homedir(),
  ensureAppHostImpl = null,
} = {}) {
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
  const appHost = ensureAppHostImpl
    ? await ensureAppHostImpl({ homeDir })
    : await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir: release.releaseDir });
  const appRuntimeWrapperPath = equinoxLocalAppRuntimeWrapperPath(homeDir);
  await atomicWrite(appRuntimeWrapperPath, appRuntimeWrapper({ installRoot: paths.installRoot }), 0o700);

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
    appPath: appHost.appPath,
    appExecutablePath: appHost.executablePath,
    appRuntimeWrapperPath,
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
