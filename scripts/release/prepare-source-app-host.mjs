import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  equinoxLocalAppExecutablePath,
  equinoxLocalAppRuntimeWrapperPath,
  launchAgentLogMaintenanceShell,
} from "../../src/equinox-local-app-host.js";
import { synchronizeEquinoxLocalNativeAppHost } from "../../src/equinox-local-native-app-host.js";
import { buildEquinoxLocalNativeAppArtifacts } from "../../src/equinox-local-native-app.js";
import { readSourceRuntimeConfig } from "../../src/equinox-local-source-runtime.js";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function assertPrivateDirectory(directory, { fsImpl = fs, uid = typeof process.getuid === "function" ? process.getuid() : null } = {}) {
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Source app-host directory is unsafe.");
  if (Number.isInteger(uid) && stat.uid !== uid) throw new Error("Source app-host directory ownership is invalid.");
  if ((stat.mode & 0o022) !== 0) throw new Error("Source app-host directory must not be group/world writable.");
}

async function atomicWrite(filePath, content, mode, { fsImpl = fs } = {}) {
  const parent = path.dirname(filePath);
  await assertPrivateDirectory(parent, { fsImpl });
  const temporary = path.join(parent, `.equinox-source-app-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await fsImpl.open(temporary, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
  try {
    await fsImpl.rename(temporary, filePath);
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function assertSourceLauncher(sourceLauncher, { fsImpl = fs, uid = typeof process.getuid === "function" ? process.getuid() : null } = {}) {
  const stat = await fsImpl.lstat(sourceLauncher);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Developer source launcher is unsafe.");
  if (Number.isInteger(uid) && stat.uid !== uid) throw new Error("Developer source launcher ownership is invalid.");
  if ((stat.mode & 0o022) !== 0) throw new Error("Developer source launcher must not be group/world writable.");
}

export function sourceAppRuntimeWrapper(sourceLauncher, peekabooPath = "") {
  const pinnedPeekaboo = peekabooPath ? shellQuote(peekabooPath) : '""';
  const logMaintenance = launchAgentLogMaintenanceShell({
    stdoutName: "Equinox Local Source.log",
    stderrName: "Equinox Local Source.error.log",
  });
  return `#!/bin/bash\nset -euo pipefail\n${logMaintenance}RUNTIME_HOST_PID=$PPID\nPEEKABOO=${pinnedPeekaboo}\nPEEKABOO_DAEMON_PID=\"\"\nPARENT_WATCHDOG_PID=\"\"\nif [ -z \"$PEEKABOO\" ] || [ ! -x \"$PEEKABOO\" ]; then\n  exec /bin/zsh ${shellQuote(sourceLauncher)}\nfi\nexport EQUINOX_PEEKABOO_PATH=\"$PEEKABOO\"\n\ncleanup() {\n  if [ -n \"$PARENT_WATCHDOG_PID\" ]; then\n    kill \"$PARENT_WATCHDOG_PID\" >/dev/null 2>&1 || true\n    wait \"$PARENT_WATCHDOG_PID\" 2>/dev/null || true\n  fi\n  if [ -n \"$PEEKABOO_DAEMON_PID\" ]; then\n    kill \"$PEEKABOO_DAEMON_PID\" >/dev/null 2>&1 || true\n    wait \"$PEEKABOO_DAEMON_PID\" 2>/dev/null || true\n  fi\n}\nshutdown() {\n  exit 0\n}\ntrap cleanup EXIT\ntrap shutdown INT TERM HUP\n\nwatch_runtime_host() {\n  local log_check_ticks=0\n  while kill -0 \"$RUNTIME_HOST_PID\" >/dev/null 2>&1; do\n    sleep 1\n    log_check_ticks=$((log_check_ticks + 1))\n    if [ \"$log_check_ticks\" -ge \"$LAUNCH_LOG_CHECK_INTERVAL_SECONDS\" ]; then\n      maintain_launch_logs\n      log_check_ticks=0\n    fi\n  done\n  kill -TERM \"$$\" >/dev/null 2>&1 || true\n}\nwatch_runtime_host &\nPARENT_WATCHDOG_PID=$!\n\n\"$PEEKABOO\" daemon run --mode manual --no-remote --log-level warning &\nPEEKABOO_DAEMON_PID=$!\n/bin/zsh ${shellQuote(sourceLauncher)}\n# Peekaboo is optional. Keep the stable app host alive even if its daemon exits;\n# Local/Desktop can reconnect independently without triggering a LaunchAgent loop.\nwait \"$PARENT_WATCHDOG_PID\"\n`;
}

export function sourceLaunchAgentPlist({ homeDir, label }) {
  const appExecutable = equinoxLocalAppExecutablePath(homeDir);
  const logsDir = path.join(homeDir, "Library", "Logs");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xmlEscape(label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xmlEscape(appExecutable)}</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>EQUINOX_LOCAL_RUNTIME_HOST</key>\n    <string>1</string>\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n  <key>ProcessType</key>\n  <string>Background</string>\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(path.join(logsDir, "Equinox Local Source.log"))}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(path.join(logsDir, "Equinox Local Source.error.log"))}</string>\n</dict>\n</plist>\n`;
}

export async function prepareSourceAppHost({
  homeDir = os.homedir(),
  configPath = process.env.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG,
  fsImpl = fs,
  ensureAppHostImpl = null,
} = {}) {
  if (process.platform !== "darwin") throw new Error("Source app host is supported only on macOS.");
  const loaded = await readSourceRuntimeConfig({ configPath, fsImpl });
  if (!loaded.configured) throw new Error("Developer runtime config is missing.");
  const { launchAgentLabel, peekabooPath, sourceLauncher } = loaded.config;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(launchAgentLabel)) throw new Error("Developer launch-agent label is invalid.");
  await assertSourceLauncher(sourceLauncher, { fsImpl });
  if (ensureAppHostImpl) {
    await ensureAppHostImpl({ homeDir });
  } else {
    const target = process.arch === "x64" ? "darwin-x64" : "darwin-arm64";
    const artifactRoot = await fsImpl.mkdtemp(path.join(os.tmpdir(), "equinox-source-native-app-"));
    try {
      const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
      await buildEquinoxLocalNativeAppArtifacts({ rootDir: repositoryRoot, releaseDir: artifactRoot, target });
      await synchronizeEquinoxLocalNativeAppHost({ homeDir, releaseDir: artifactRoot });
    } finally {
      await fsImpl.rm(artifactRoot, { recursive: true, force: true });
    }
  }

  const runtimeWrapperPath = equinoxLocalAppRuntimeWrapperPath(homeDir);
  await atomicWrite(runtimeWrapperPath, sourceAppRuntimeWrapper(sourceLauncher, peekabooPath), 0o700, { fsImpl });
  const launchAgentsRoot = path.join(homeDir, "Library", "LaunchAgents");
  await fsImpl.mkdir(launchAgentsRoot, { recursive: true, mode: 0o700 });
  const launchAgentPath = path.join(launchAgentsRoot, `${launchAgentLabel}.plist`);
  await atomicWrite(launchAgentPath, sourceLaunchAgentPlist({ homeDir, label: launchAgentLabel }), 0o600, { fsImpl });

  return Object.freeze({ ready: true, appIdentity: "Equinox Local", bundleId: "dev.equinox.local" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  prepareSourceAppHost().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
