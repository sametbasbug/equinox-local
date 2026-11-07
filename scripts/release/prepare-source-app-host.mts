import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { buildSourceMacDesktopPayload } from "./package-macos-desktop.mjs";
import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
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
import { readEquinoxLocalMainNativePointer } from "../../src/equinox-local-main-native-state.js";
import { buildEquinoxLocalNativeAppArtifacts, equinoxLocalNativeAppArtifactPaths, EQUINOX_LOCAL_NATIVE_APP_SHELL_VERSION } from "../../src/equinox-local-native-app.js";
import { readSourceRuntimeConfig } from "../../src/equinox-local-source-runtime.js";
import { readLegacyMacShellPreferences, retainLegacyMacShellPending } from "../../src/equinox-local-macos-installer.js";
import { requestDesktopUpdateShutdown } from "../../src/equinox-local-desktop-control.js";
import { setTimeout as sleep } from "node:timers/promises";

function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function xmlEscape(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function assertPrivateDirectory(directory: string, { fsImpl = fs, uid = typeof process.getuid === "function" ? process.getuid() : null } = {}) {
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Source app-host directory is unsafe.");
  if (Number.isInteger(uid) && stat.uid !== uid) throw new Error("Source app-host directory ownership is invalid.");
  if ((stat.mode & 0o022) !== 0) throw new Error("Source app-host directory must not be group/world writable.");
}

async function atomicWrite(filePath: string, content: string, mode: number, { fsImpl = fs } = {}) {
  const parent = path.dirname(filePath);
  await assertPrivateDirectory(parent, { fsImpl });
  const temporary = path.join(parent, `.equinox-source-app-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await fsImpl.open(temporary, "wx", mode);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
    await fsImpl.rename(temporary, filePath);
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function assertSourceLauncher(sourceLauncher: string, { fsImpl = fs, uid = typeof process.getuid === "function" ? process.getuid() : null } = {}) {
  const stat = await fsImpl.lstat(sourceLauncher);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Developer source launcher is unsafe.");
  if (Number.isInteger(uid) && stat.uid !== uid) throw new Error("Developer source launcher ownership is invalid.");
  if ((stat.mode & 0o022) !== 0) throw new Error("Developer source launcher must not be group/world writable.");
}

type WrapperOptions = {
  nodePath?: string; configPath?: string; tunnelClient?: string; tunnelRuntime?: string;
  privateCompositionModule?: string; privateCompositionRoot?: string;
  sourceLauncherOwnsLifecycle?: boolean;
};

export function sourceAppRuntimeWrapper(sourceLauncher: string, peekabooPath = "", {
  nodePath = process.execPath,
  configPath = "",
  tunnelClient = "",
  tunnelRuntime = "",
  privateCompositionModule = "",
  privateCompositionRoot = "",
  sourceLauncherOwnsLifecycle = false,
}: WrapperOptions = {}): string {
  const watchdogPath = fileURLToPath(new URL("./watch-source-runtime.mjs", import.meta.url));
  const watchdogCommand = `${shellQuote(nodePath)} ${shellQuote(watchdogPath)} ${shellQuote(configPath)}`;
  const sourceLifecycleCommand = sourceLauncherOwnsLifecycle
    ? `/bin/zsh ${shellQuote(sourceLauncher)} &\nRUNTIME_WATCHDOG_PID=$!\nwait \"$RUNTIME_WATCHDOG_PID\"`
    : `/bin/zsh ${shellQuote(sourceLauncher)}\n# Watch the tunnel, not Peekaboo or remote network readiness.\n${watchdogCommand} &\nRUNTIME_WATCHDOG_PID=$!\nwait \"$RUNTIME_WATCHDOG_PID\"`;
  const pinnedPeekaboo = peekabooPath ? shellQuote(peekabooPath) : '""';
  const stopTunnelRuntime = tunnelClient && tunnelRuntime
    ? `${shellQuote(tunnelClient)} runtimes stop ${shellQuote(tunnelRuntime)} >/dev/null 2>&1 || true`
    : ":";
  const privateCompositionEnvironment = privateCompositionModule && privateCompositionRoot
    ? `export EQUINOX_LOCAL_PRIVATE_COMPOSITION_MODULE=${shellQuote(privateCompositionModule)}\nexport EQUINOX_LOCAL_PRIVATE_COMPOSITION_ROOT=${shellQuote(privateCompositionRoot)}\n`
    : "unset EQUINOX_LOCAL_PRIVATE_COMPOSITION_MODULE\nunset EQUINOX_LOCAL_PRIVATE_COMPOSITION_ROOT\n";
  const logMaintenance = launchAgentLogMaintenanceShell({
    stdoutName: "Equinox Local Source.log",
    stderrName: "Equinox Local Source.error.log",
  });
  return `#!/bin/bash\nset -euo pipefail\numask 077\n${logMaintenance}exec >>\"$HOME/Library/Logs/Equinox Local Source.log\" 2>>\"$HOME/Library/Logs/Equinox Local Source.error.log\"\nRUNTIME_HOST_PID=$PPID\nPEEKABOO=${pinnedPeekaboo}\nPEEKABOO_DAEMON_PID=\"\"\nRUNTIME_WATCHDOG_PID=\"\"\nPARENT_WATCHDOG_PID=\"\"\n\ncleanup() {\n  if [ -n \"$RUNTIME_WATCHDOG_PID\" ]; then\n    kill \"$RUNTIME_WATCHDOG_PID\" >/dev/null 2>&1 || true\n    wait \"$RUNTIME_WATCHDOG_PID\" 2>/dev/null || true\n  fi\n  if [ -n \"$PARENT_WATCHDOG_PID\" ]; then\n    kill \"$PARENT_WATCHDOG_PID\" >/dev/null 2>&1 || true\n    wait \"$PARENT_WATCHDOG_PID\" 2>/dev/null || true\n  fi\n  ${stopTunnelRuntime}\n  if [ -n \"$PEEKABOO_DAEMON_PID\" ]; then\n    kill \"$PEEKABOO_DAEMON_PID\" >/dev/null 2>&1 || true\n    wait \"$PEEKABOO_DAEMON_PID\" 2>/dev/null || true\n  fi\n}\nshutdown() {\n  exit 0\n}\ntrap cleanup EXIT\ntrap shutdown INT TERM HUP\n\nwatch_runtime_host() {\n  local log_check_ticks=0\n  while kill -0 \"$RUNTIME_HOST_PID\" >/dev/null 2>&1; do\n    sleep 1\n    log_check_ticks=$((log_check_ticks + 1))\n    if [ \"$log_check_ticks\" -ge \"$LAUNCH_LOG_CHECK_INTERVAL_SECONDS\" ]; then\n      maintain_launch_logs\n      log_check_ticks=0\n    fi\n  done\n  kill -TERM \"$$\" >/dev/null 2>&1 || true\n}\nwatch_runtime_host &\nPARENT_WATCHDOG_PID=$!\n\nif [ -n \"$PEEKABOO\" ] && [ -x \"$PEEKABOO\" ]; then\n  export EQUINOX_PEEKABOO_PATH=\"$PEEKABOO\"\n  \"$PEEKABOO\" daemon run --mode manual --no-remote --log-level warning &\n  PEEKABOO_DAEMON_PID=$!\nfi\n${privateCompositionEnvironment}${sourceLifecycleCommand}\n`;
}

export function sourceLaunchAgentPlist({ homeDir, label }: { homeDir: string; label: string }): string {
  const appExecutable = equinoxLocalAppExecutablePath(homeDir);
  const logsDir = path.join(homeDir, "Library", "Logs");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xmlEscape(label)}</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xmlEscape(appExecutable)}</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>EQUINOX_LOCAL_RUNTIME_HOST</key>\n    <string>1</string>\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>KeepAlive</key>\n  <true/>\n  <key>ThrottleInterval</key>\n  <integer>30</integer>\n  <key>ProcessType</key>\n  <string>Background</string>\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(path.join(logsDir, "Equinox Local Source.log"))}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(path.join(logsDir, "Equinox Local Source.error.log"))}</string>\n</dict>\n</plist>\n`;
}

const execFile = promisify(execFileCallback);

async function assertSourceOwnersStopped(homeDir: string, label: string) {
  const options = { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 };
  const executable = equinoxLocalAppExecutablePath(homeDir);
  const processes = await execFile("/bin/ps", ["-axww", "-o", "comm="], options);
  if (String(processes.stdout).split("\n").some((command) => command.trim() === executable)) throw new Error("Stop the canonical applet owner before source Electron preparation.");
  for (const job of new Set([label, "dev.equinox.local"])) {
    try {
      await execFile("/bin/launchctl", ["print", `gui/${process.getuid!()}/${job}`], options);
    } catch (error) {
      const failure = error as { code?: unknown; stderr?: string };
      if (failure.code === 113 && /Could not find service/u.test(String(failure.stderr))) continue;
      throw error;
    }
    throw new Error("Configured Source or canonical managed job is still loaded; replacement refused.");
  }
  try {
    await execFile("/usr/sbin/lsof", ["-nP", "-iTCP:24891", "-sTCP:LISTEN", "-t"], options);
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    if (failure.code === 1 && !String(failure.stdout || "").trim() && !String(failure.stderr || "").trim()) return;
    throw error;
  }
  throw new Error("Port 24891 still has a listener; source Electron replacement refused.");
}

async function assertNoManagedPlist(homeDir: string, sourceLabel: string, fsImpl: typeof fs) {
  if (sourceLabel === "dev.equinox.local") return; // Its exact Source content is admitted separately.
  try { await fsImpl.lstat(path.join(homeDir, "Library", "LaunchAgents", "dev.equinox.local.plist")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error("Canonical managed LaunchAgent conflicts with Source preparation.");
}

async function admittedExactSourceFile(target: string, contents: readonly string[], fsImpl: typeof fs) {
  const parent = path.dirname(target);
  let directory;
  try { directory = await fsImpl.lstat(parent); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!path.isAbsolute(target) || await fsImpl.realpath(parent) !== parent || !directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid!() || (directory.mode & 0o022) !== 0) throw new Error("Configured Source file directory is unsafe.");
  const expected = contents.map(value => Buffer.from(value, "utf8"));
  const maximum = Math.max(...expected.map(value => value.length));
  let handle;
  try {
    handle = await fsImpl.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    const normal = (value: typeof stat) => value.isFile() && value.nlink === 1 && value.uid === process.getuid!() && (value.mode & 0o077) === 0 && expected.some(expectedValue => expectedValue.length === value.size);
    if (!normal(stat)) throw new Error("Configured Source input is not a private owned normal file.");
    const bytes = Buffer.alloc(maximum + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    const named = await fsImpl.lstat(target);
    if (!normal(after) || !normal(named) || named.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || named.dev !== stat.dev || named.ino !== stat.ino || after.size !== stat.size || named.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || named.mtimeMs !== stat.mtimeMs || named.ctimeMs !== stat.ctimeMs || count !== stat.size || !expected.some(value => bytes.subarray(0, count).equals(value))) throw new Error("Configured Source input is not the exact unchanged owned program file.");
    return { target, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } finally { await handle.close(); }
}

// Electron's Source owner restarts its wrapper without the old LaunchAgent
// preflight. Synchronize pinned helper binaries and rewrite only the exact
// previously generated Source wrapper before asking Electron to restart it.
export async function synchronizeSourceDesktopRuntimes({
  configPath = process.env.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG,
  homeDir = os.homedir(),
  nodePath = process.env.EQUINOX_LOCAL_DEV_NODE || path.join(homeDir, ".local", "share", "equinox-local-developer", "bin", "node"),
  fsImpl = fs,
}: {
  configPath?: string;
  homeDir?: string;
  nodePath?: string;
  fsImpl?: typeof fs;
} = {}) {
  const before = await readSourceRuntimeConfig({ configPath, fsImpl });
  if (!before.configured) throw new Error("Developer runtime config is missing.");
  const render = (config: typeof before.config) => sourceAppRuntimeWrapper(config.sourceLauncher, config.peekabooPath, {
    nodePath, configPath: before.configPath, tunnelClient: config.tunnelClient,
    tunnelRuntime: config.tunnelRuntime, privateCompositionModule: config.privateCompositionModule,
    privateCompositionRoot: config.privateCompositionRoot,
    sourceLauncherOwnsLifecycle: config.sourceLauncherOwnsLifecycle,
  });
  const wrapperPath = equinoxLocalAppRuntimeWrapperPath(homeDir);
  const previousContent = render(before.config);
  const predecessor = await admittedExactSourceFile(wrapperPath, [previousContent], fsImpl);
  if (!predecessor) throw new Error("Existing Source Electron wrapper is missing or differs from the admitted runtime config.");

  const [{ syncSourceTunnelRuntime }, { syncSourcePeekabooRuntime }] = await Promise.all([
    import("./sync-source-tunnel-runtime.mjs"),
    import("./sync-source-peekaboo-runtime.mjs"),
  ]);
  await syncSourceTunnelRuntime({ configPath: before.configPath });
  await syncSourcePeekabooRuntime({ configPath: before.configPath });
  const after = await readSourceRuntimeConfig({ configPath: before.configPath, fsImpl });
  if (!after.configured) throw new Error("Developer runtime config disappeared during synchronization.");
  const current = await admittedExactSourceFile(wrapperPath, [previousContent], fsImpl);
  if (!current || JSON.stringify(current) !== JSON.stringify(predecessor)) {
    throw new Error("Source Electron wrapper changed during runtime synchronization.");
  }
  const nextContent = render(after.config);
  if (nextContent !== previousContent) await atomicWrite(wrapperPath, nextContent, 0o700, { fsImpl });
  return Object.freeze({ synchronized: true });
}

async function admittedRetiredSourcePlist(homeDir: string, label: string, fsImpl: typeof fs) {
  return await admittedExactSourceFile(path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`), [sourceLaunchAgentPlist({ homeDir, label })], fsImpl);
}

type PrepareOptions = {
  electronSource?: boolean;
  homeDir?: string;
  configPath?: string | undefined;
  nodePath?: string;
  fsImpl?: typeof fs;
  ensureAppHostImpl?: ((options: { homeDir: string }) => Promise<unknown>) | null;
  readMainNativePointerImpl?: typeof readEquinoxLocalMainNativePointer;
  synchronizeNativeAppImpl?: typeof synchronizeEquinoxLocalNativeAppHost;
  buildNativeAppImpl?: typeof buildEquinoxLocalNativeAppArtifacts;
  mainTransactionRoot?: string;
};

export async function prepareSourceAppHost({
  electronSource = false,
  homeDir = os.homedir(),
  configPath = process.env.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG,
  nodePath = process.env.EQUINOX_LOCAL_DEV_NODE || process.execPath,
  fsImpl = fs,
  ensureAppHostImpl = null,
  readMainNativePointerImpl = readEquinoxLocalMainNativePointer,
  synchronizeNativeAppImpl = synchronizeEquinoxLocalNativeAppHost,
  buildNativeAppImpl = buildEquinoxLocalNativeAppArtifacts,
  mainTransactionRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local Developer", "main-update"),
}: PrepareOptions = {}) {
  if (process.platform !== "darwin") throw new Error("Source app host is supported only on macOS.");
  const loaded = await readSourceRuntimeConfig({ configPath, fsImpl });
  if (!loaded.configured) throw new Error("Developer runtime config is missing.");
  const {
    launchAgentLabel,
    peekabooPath,
    sourceLauncher,
    sourceLauncherOwnsLifecycle,
    privateCompositionModule,
    privateCompositionRoot,
  } = loaded.config;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(launchAgentLabel)) throw new Error("Developer launch-agent label is invalid.");
  await assertSourceLauncher(sourceLauncher, { fsImpl });
  const runtimeWrapperPath = equinoxLocalAppRuntimeWrapperPath(homeDir);
  const wrapperContent = sourceAppRuntimeWrapper(sourceLauncher, peekabooPath, {
    nodePath, configPath: loaded.configPath, tunnelClient: loaded.config.tunnelClient,
    tunnelRuntime: loaded.config.tunnelRuntime, privateCompositionModule,
    privateCompositionRoot, sourceLauncherOwnsLifecycle,
  });
  // The legacy Source producer predates these two additive hardening headers.
  // Admit that exact generated body too, never a prefix or arbitrary script.
  const legacyWrapperContent = wrapperContent.replace("set -euo pipefail\numask 077\n", "set -euo pipefail\n")
    .replace('exec >>"$HOME/Library/Logs/Equinox Local Source.log" 2>>"$HOME/Library/Logs/Equinox Local Source.error.log"\n', "");
  let predecessorWrapper: Awaited<ReturnType<typeof admittedExactSourceFile>> = null;
  const installedPlist = path.join(path.dirname(path.dirname(equinoxLocalAppExecutablePath(homeDir))), "Info.plist");
  let installedInfo: Record<string, unknown> | null = null;
  let installedIdentity: Stats | null = null;
  try {
    installedIdentity = await fsImpl.lstat(installedPlist);
    const { stdout } = await execFile("/usr/bin/plutil", ["-convert", "json", "-o", "-", installedPlist], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    installedInfo = JSON.parse(String(stdout)) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const installedElectron = installedInfo?.EquinoxLocalRuntimeRole === "source" || !!installedInfo?.ElectronAsarIntegrity || Number(installedInfo?.EquinoxLocalNativeShellVersion) > EQUINOX_LOCAL_NATIVE_APP_SHELL_VERSION;
  if (!electronSource && installedElectron) throw new Error("Installed Electron host must be prepared explicitly with --electron-source; legacy downgrade is forbidden.");
  if (electronSource) {
    if (homeDir !== os.homedir() || await fsImpl.realpath(homeDir) !== homeDir) throw new Error("Source Electron preparation requires the canonical current-user home.");
    if (ensureAppHostImpl) throw new Error("Source Electron preparation requires the sealed native host synchronization path.");
    await assertSourceOwnersStopped(homeDir, launchAgentLabel);
    await assertNoManagedPlist(homeDir, launchAgentLabel, fsImpl);
    const retired = await admittedRetiredSourcePlist(homeDir, launchAgentLabel, fsImpl);
    if (installedInfo && ((installedElectron && installedInfo.EquinoxLocalRuntimeRole !== "source") || (!installedElectron && !retired))) throw new Error("Existing application is not an admitted legacy Source job or Source Electron host; profile conversion refused.");
    predecessorWrapper = await admittedExactSourceFile(runtimeWrapperPath, installedElectron ? [wrapperContent] : [wrapperContent, legacyWrapperContent], fsImpl);
    if (installedInfo && !predecessorWrapper) throw new Error("Existing Source application requires its exact private Source wrapper.");
    if (retired && installedInfo && !installedElectron) await retainLegacyMacShellPending(await readLegacyMacShellPreferences());
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const head = await execFile("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { timeout: 10_000, maxBuffer: 16384 });
    const stage = await fsImpl.mkdtemp(path.join(await fsImpl.realpath(os.tmpdir()), "equinox-source-desktop-"));
    try {
      const releaseDir = path.join(stage, "release");
      await fsImpl.mkdir(path.join(releaseDir, "runtime"), { recursive: true, mode: 0o700 });
      const target = process.arch === "x64" ? "darwin-x64" : "darwin-arm64";
      await buildSourceMacDesktopPayload({ rootDir: repositoryRoot, releaseDir, target, sourceSha: String(head.stdout).trim() });
      await assertSourceOwnersStopped(homeDir, launchAgentLabel);
      await assertNoManagedPlist(homeDir, launchAgentLabel, fsImpl);
      const currentWrapper = await admittedExactSourceFile(runtimeWrapperPath, installedElectron ? [wrapperContent] : [wrapperContent, legacyWrapperContent], fsImpl);
      if (JSON.stringify(currentWrapper) !== JSON.stringify(predecessorWrapper)) throw new Error("Source predecessor wrapper changed during preparation.");
      const current = await admittedRetiredSourcePlist(homeDir, launchAgentLabel, fsImpl);
      if (current?.dev !== retired?.dev || current?.ino !== retired?.ino) throw new Error("Retired source plist changed during preparation.");
      const beforeReplace = await fsImpl.lstat(installedPlist).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      const originalIdentity = installedIdentity;
      const identityFields = ["dev", "ino", "size", "mtimeMs", "ctimeMs", "uid", "mode"] as const;
      if (!!beforeReplace !== !!originalIdentity || (beforeReplace && originalIdentity && identityFields.some(key => beforeReplace[key] !== originalIdentity[key]))) throw new Error("Installed application identity changed during source preparation.");
      await synchronizeNativeAppImpl({ homeDir, releaseDir, fsImpl, requirePayloadIdentity: true });
      if (current) {
        const final = await admittedRetiredSourcePlist(homeDir, launchAgentLabel, fsImpl);
        if (!final || final.dev !== current.dev || final.ino !== current.ino) throw new Error("Retired source plist changed; removal refused.");
        await fsImpl.unlink(final.target);
      }
    } finally { await fsImpl.rm(stage, { recursive: true, force: true }); }
  } else if (ensureAppHostImpl) {
    await ensureAppHostImpl({ homeDir });
  } else {
    const target = process.arch === "x64" ? "darwin-x64" : "darwin-arm64";
    const pointerPath = path.join(mainTransactionRoot, "current-native.json");
    let mainNative = null;
    try {
      mainNative = await readMainNativePointerImpl(pointerPath, { transactionRoot: mainTransactionRoot, fsImpl });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (mainNative && mainNative.target !== target) throw new Error("Main native pointer does not match the source host platform.");
    // A Factory checkout may outlive a historical signed native pointer.
    // New native menu code must not be pinned forever to an older shell binary.
    // The pointer is independently authenticated before inspecting its metadata.
    const pointerMetadata = mainNative
      ? JSON.parse(await fsImpl.readFile(equinoxLocalNativeAppArtifactPaths(mainNative.releaseDir).metadata, "utf8"))
      : null;
    if (mainNative && Number.isSafeInteger(pointerMetadata?.shellVersion)
        && pointerMetadata.shellVersion >= EQUINOX_LOCAL_NATIVE_APP_SHELL_VERSION) {
      await synchronizeNativeAppImpl({ homeDir, releaseDir: mainNative.releaseDir, fsImpl, requirePayloadIdentity: true });
    } else {
      const artifactRoot = await fsImpl.mkdtemp(path.join(os.tmpdir(), "equinox-source-native-app-"));
      try {
        const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
        await buildNativeAppImpl({ rootDir: repositoryRoot, releaseDir: artifactRoot, target });
        await synchronizeNativeAppImpl({ homeDir, releaseDir: artifactRoot, fsImpl });
      } finally {
        await fsImpl.rm(artifactRoot, { recursive: true, force: true });
      }
    }
  }

  if (electronSource) {
    await assertNoManagedPlist(homeDir, launchAgentLabel, fsImpl);
    const currentWrapper = await admittedExactSourceFile(runtimeWrapperPath, installedElectron ? [wrapperContent] : [wrapperContent, legacyWrapperContent], fsImpl);
    if (JSON.stringify(currentWrapper) !== JSON.stringify(predecessorWrapper)) throw new Error("Source predecessor wrapper changed before replacement.");
  }
  await atomicWrite(runtimeWrapperPath, wrapperContent, 0o700, { fsImpl });
  if (!electronSource) {
    const launchAgentsRoot = path.join(homeDir, "Library", "LaunchAgents");
    await fsImpl.mkdir(launchAgentsRoot, { recursive: true, mode: 0o700 });
    const launchAgentPath = path.join(launchAgentsRoot, `${launchAgentLabel}.plist`);
    await atomicWrite(launchAgentPath, sourceLaunchAgentPlist({ homeDir, label: launchAgentLabel }), 0o600, { fsImpl });
  }

  return Object.freeze({ ready: true, appIdentity: "Equinox Local", bundleId: "dev.equinox.local" });
}

// Explicit one-shot Source refresh. The existing native lifecycle socket is
// responsible for quitting the one desktop owner; packaging NEVER runs over
// a live Electron application or mutates the source checkout.
async function refreshInstalledSourceElectron(expectedSha: string, installedSha: string) {
  if (process.platform !== "darwin" || !/^[a-f0-9]{40}$/u.test(expectedSha) || !/^[a-f0-9]{40}$/u.test(installedSha) || process.env.EQUINOX_LOCAL_DESKTOP_OWNER !== "1") {
    throw new Error("Factory refresh requires an authenticated macOS Source desktop owner and exact local SHA.");
  }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const git = async (...args:string[]) => (await execFile("/usr/bin/git", ["-C",repo,...args], {timeout:10_000,maxBuffer:1024*1024})).stdout.trim();
  const appPath = path.join(os.homedir(), "Applications", "Equinox Local.app");
  const plist = async (key:string) => (await execFile("/usr/bin/plutil", ["-extract",key,"raw",path.join(appPath,"Contents","Info.plist")],{timeout:5000,maxBuffer:16384})).stdout.trim();
  const [sha,branch,dirty,root,role] = await Promise.all([
    git("rev-parse","HEAD"),git("branch","--show-current"),git("status","--porcelain=v1","--untracked-files=all"),
    git("rev-parse","--show-toplevel"),plist("EquinoxLocalRuntimeRole"),
  ]);
  if (sha !== expectedSha || branch !== "main" || dirty || root !== repo || role !== "source" || await plist("EquinoxLocalSourceSha") !== installedSha) {
    throw new Error("Factory refresh refused: local main or original installed Source identity changed.");
  }
  // Let /api/v1/update/apply finish its HTTP response before the owner quits.
  await sleep(1200);
  const shutdown = await requestDesktopUpdateShutdown({homeDir:os.homedir()});
  const ownerPid = "ownerPid" in shutdown ? shutdown.ownerPid : undefined;
  if (typeof ownerPid !== "number" || !Number.isSafeInteger(ownerPid) || ownerPid < 1) throw new Error("Source desktop shutdown owner identity is missing.");
  let stopped = false;
  try {
    for (let attempt = 0;attempt < 90;attempt++) {
      const processState = await execFile("/bin/ps",["-p",String(ownerPid),"-o","comm="],{timeout:3000}).then(r=>r.stdout.trim()).catch(()=>"");
      const portBusy = await execFile("/usr/sbin/lsof",["-nP","-iTCP:24891","-sTCP:LISTEN","-t"],{timeout:5000}).then(r=>Boolean(r.stdout.trim())).catch((error:NodeJS.ErrnoException)=>{
        if (Number((error as {code?:unknown}).code) === 1) return false;
        throw error;
      });
      if (!processState && !portBusy) { stopped=true; break; }
      if (processState && processState !== path.join(appPath,"Contents","MacOS","applet")) {
        throw new Error("Source desktop owner PID identity changed during shutdown.");
      }
      await sleep(1000);
    }
    if (!stopped) throw new Error("Source desktop or its original port did not stop safely.");
    if (await plist("EquinoxLocalSourceSha") !== installedSha) throw new Error("Original installed Source SHA changed before replacement.");
    await prepareSourceAppHost({electronSource:true});
    if (await plist("EquinoxLocalSourceSha") !== expectedSha || await plist("EquinoxLocalRuntimeRole") !== "source") {
      throw new Error("New Source desktop did not preserve its exact commit and role.");
    }
    await execFile("/usr/bin/codesign",["--verify","--deep","--strict",appPath],{timeout:60_000});
  } finally {
    // The exact owner acknowledged shutdown. Even on a source build failure,
    // reopen the existing app, without touching private settings or creating
    // a second updater.
    await execFile("/usr/bin/open",["-a",appPath],{timeout:15_000});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const refresh = args.length === 3 && args[0] === "--electron-source-refresh" && /^[a-f0-9]{40}$/u.test(args[1]!) && /^[a-f0-9]{40}$/u.test(args[2]!);
  if (!refresh && (args.length > 1 || (args.length === 1 && args[0] !== "--electron-source"))) {
    throw new Error("Use prepare-source-app-host [--electron-source] or the exact Source refresh handoff.");
  }
  const work = refresh ? refreshInstalledSourceElectron(args[1]!, args[2]!) : prepareSourceAppHost({electronSource: args[0] === "--electron-source" });
  work.then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
