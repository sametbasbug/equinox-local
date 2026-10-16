// Hosted Windows ONLY: observe real healthy new Stable, force failed health,
// and assert that the old Main, native WPF and Native Messaging are restored.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { installManagedEquinoxRelease } from "../../src/equinox-local-first-install.js";
import { activatePreparedEquinoxRelease } from "../../src/equinox-local-update-activation.js";

const [stagedReleaseDir, installedRoot, oldSha, versionB] = process.argv.slice(2);
if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" ||
    process.env.CI !== "true" || process.env.EQUINOX_WINDOWS_LEGACY_REINSTALL_ACCEPTANCE !== "true" ||
    !["x64", "arm64"].includes(process.arch) || !path.win32.isAbsolute(stagedReleaseDir ?? "") ||
    !path.win32.isAbsolute(installedRoot ?? "") ||
    !/^[a-f0-9]{40}$/u.test(oldSha ?? "") || !/^\d+\.\d+\.\d+$/u.test(versionB ?? "")) {
  throw new Error("Refusing historic native rollback outside a disposable exact Windows runner.");
}
const trustedRoot = path.win32.join(process.env.LOCALAPPDATA, "Equinox Local");
assert.equal(path.win32.normalize(installedRoot).toLowerCase(), path.win32.normalize(trustedRoot).toLowerCase());
assert.equal(path.win32.dirname(stagedReleaseDir).toLowerCase(),
  path.win32.join(installedRoot, "staging", "historic-repair-negative").toLowerCase());
const metadata = JSON.parse(await fs.readFile(path.win32.join(stagedReleaseDir, "release.json"), "utf8"));
assert.equal(metadata.target, "win32-" + process.arch);
assert.equal(metadata.version, versionB);
assert.notEqual(metadata.sourceSha, oldSha);
const mainStamp = path.win32.join(installedRoot, "state", "main-update", "install.json");
const originalStamp = await fs.readFile(mainStamp);
const currentPath = path.win32.join(installedRoot, "current-version.json");
const previousCurrent = JSON.parse(await fs.readFile(currentPath, "utf8"));
assert.notEqual(previousCurrent.version, versionB);
const manifestPath = path.win32.join(installedRoot, "browser", "native-messaging", "dev.equinox.browser.json");
const originalManifest = await fs.readFile(manifestPath);
const shellPath = path.win32.join(process.env.LOCALAPPDATA, "Programs", "Equinox Local", "EquinoxLocal.exe");
const shellHash = async () => createHash("sha256").update(await fs.readFile(shellPath)).digest("hex");
const originalShell = await shellHash();
let observations = 0;
let polls = 0;
let nativeStarts = 0;
let firstBStatus = null;
let lastBStatus = "no B status";
let candidateNativePhases = [];
let candidatePid = null;
let candidateAlive = null;
let candidateIdentity = "not-observed";
const execFileAsync = promisify(execFile);
const probeCandidate = async () => {
  if (candidatePid === null) return "pid-not-available";
  // The disposable runner reports only booleans/counts, never executable paths,
  // process command lines, environment, or user-owned credentials.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$p = Get-CimInstance Win32_Process -Filter 'ProcessId = " + candidatePid + "'",
    "if ($null -eq $p) { Write-Output gone; exit 0 }",
    "$a = Get-Process -Id " + candidatePid + " -ErrorAction Stop",
    "$pathMatches = [string]::Equals($p.ExecutablePath, $env:EQUINOX_WPF_EXPECTED_EXE, [StringComparison]::OrdinalIgnoreCase)",
    "$parentMatches = ($p.ParentProcessId -eq " + process.pid + ")",
    "$modulesLoaded = @($a.Modules | Where-Object { $_.ModuleName -eq 'PresentationFramework.dll' }).Count -gt 0",
    "@{exists=$true; pathMatches=$pathMatches; parentMatches=$parentMatches; threads=[Math]::Min($a.Threads.Count,250); mainWindow=($a.MainWindowHandle -ne 0); wpfModule=$modulesLoaded} | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ], {
      env: { ...process.env, EQUINOX_WPF_EXPECTED_EXE: shellPath },
      timeout: 12_000, maxBuffer: 4096, windowsHide: true,
    });
    if (stdout.trim() === "gone") return JSON.stringify({ exists: false });
    const info = JSON.parse(stdout.trim());
    return JSON.stringify({
      exists: info.exists === true,
      pathMatches: info.pathMatches === true,
      parentMatches: info.parentMatches === true,
      threads: Number.isInteger(info.threads) ? info.threads : null,
      mainWindow: info.mainWindow === true,
      wpfModule: info.wpfModule === true,
    });
  } catch (error) {
    return "OS-probe-" + (error?.code === "ETIMEDOUT" ? "timeout" : "unavailable");
  }
};
const logFile = path.win32.join(installedRoot, "logs", "windows-shell-runtime.log");
let candidateLogStart = 0;
let candidateStartMs = 0;
let candidateLogRotated = false;
const inspectB = async () => {
  const log = await fs.readFile(logFile, "utf8").catch(() => "");
  candidateLogRotated = log.length < candidateLogStart;
  // WPF rotates its own bounded log at 64 KiB. Byte offsets become invalid
  // after rotation; timestamp-filter recent fixed-format native events instead.
  return log.split(/\r?\n/u).slice(-110).flatMap((line) => {
    const epochMs = Date.parse(line.slice(0, 23) + "Z");
    if (!Number.isFinite(epochMs) || epochMs < candidateStartMs - 2000) return [];
    const match = /^\S+ (shell-startup|runtime-discovery|runtime-start-phase|runtime-start|runtime-gate-exit|tunnel-transport|windows-shell-registration) ([^\r\n]*)$/u.exec(line);
    if (!match) return [];
    const details = match[2];
    if (match[1] === "shell-startup" && /^(entered|primary-acquired|main-window-created)$/u.test(details)) {
      return [match[1] + ":" + details];
    }
    if (match[1] === "runtime-discovery") {
      return [match[1] + ":" + (details.includes("supervisor=True") ? "supervisor-present" : "supervisor-missing")];
    }
    if (match[1] === "runtime-start-phase" && /^[a-z-]+$/u.test(details)) return [match[1] + ":" + details];
    if (match[1] === "runtime-gate-exit") {
      const classes = [
        ["ERR_MODULE_NOT_FOUND", "module-not-found"],
        ["Cannot find module", "module-not-found"],
        ["ERR_PACKAGE_PATH_NOT_EXPORTED", "package-exports"],
        ["ERR_REQUIRE_ESM", "require-esm"],
        ["ERR_INVALID_ARG_TYPE", "invalid-argument"],
        ["SyntaxError", "syntax"],
        ["ReferenceError", "reference"],
        ["TypeError", "type"],
        ["RangeError", "range"],
        ["SecurityError", "security"],
        ["ENOENT", "missing-path"],
        ["EACCES", "access-denied"],
        ["EPERM", "operation-denied"],
        ["Cannot find package", "package-not-found"],
        ["Error:", "other-error"],
      ];
      const errorClass = classes.find(([pattern]) => details.includes(pattern))?.[1] ??
        (details.includes("stderr=") ? "unrecognized-stderr" : "no-stderr");
      // Emit only vocabulary-fixed diagnostic clues from the generic Error
      // heading, never user paths, arguments, credentials or raw stderr.
      const safeWords = new Set(("equinox local windows main stable native runtime server config configuration " +
        "control center private state source manifest identity current release install installation " +
        "missing invalid unsupported expected failed failure denied permission access path root " +
        "package module node process token bridge key signature version target source sha " +
        "file not found cannot read open create initialize initialized directory owned " +
        "must required absent unavailable already existing verified healthy connection " +
        "transport tunnel name endpoint port listening address duplicate conflict " +
        "unsupported unrecognized error failed to with is no has the a an at from").split(" "));
      const errorText = /\bError:\s*([^|\r\n]{1,180})/u.exec(details)?.[1] ?? "";
      const clue = errorText.split(/[^\p{L}\p{N}]+/u).slice(0, 11)
        .map((word) => safeWords.has(word.toLowerCase()) ? word.toLowerCase() : "x")
        .join("-").slice(0, 90) || "none";
      // The first public source stack frame/line localizes the throw without
      // emitting any user's home path, config contents, or raw stderr.
      const frames = [...details.matchAll(/\b(equinox-[a-z0-9-]+\.js|server\.js):([1-9]\d{0,3}):[1-9]\d{0,3}\b/gu)]
        .filter((frame) => Number(frame[2]) <= 4000)
        .slice(0, 3)
        .map((frame) => frame[1] + ":" + frame[2]);
      const site = ["equinox-local-config.js", "equinox-local-private-state.js",
        "equinox-local-platform.js", "equinox-local-main-install-state.js",
        "equinox-local-windows-runtime-supervisor.js", "equinox-local-control-api.js",
        "equinox-local-release-manager.js", "server.js", "node:internal"]
        .find((file) => details.includes(file)) ?? "unknown";
      return [match[1] + ":" + (/exit=(-?\d+)/u.exec(details)?.[1] ?? "unknown"),
        "runtime-gate-error:" + errorClass, "runtime-gate-hint:" + clue,
        "runtime-gate-site:" + site, "runtime-gate-frames:" + (frames.join(",") || "none")];
    }
    if (match[1] === "tunnel-transport" && /^(?:tunnel-[a-z-]+|local-only-(?:stdin-eof|child-exit-zero|child-spawned|child-sigterm|child-sigint|child-sigbreak|child-signal-other|child-exit-nonzero|control-ready|control-disabled))$/u.test(details)) return [match[1] + ":" + details];
    if (match[1] === "runtime-start" || match[1] === "windows-shell-registration") {
      return [match[1] + ":" + (/^([a-zA-Z]+Exception)/u.exec(details)?.[1] ?? "error")];
    }
    return [];
  }).slice(-45);
};
let lastStatus = "no status";
await assert.rejects(installManagedEquinoxRelease({
  stagedReleaseDir, platform: "win32", arch: process.arch,
  activateImpl: (options) => activatePreparedEquinoxRelease({
    ...options, healthAttempts: 30,
    kickstartImpl: async (...args) => {
      nativeStarts++;
      if (nativeStarts === 1) {
        candidateLogStart = (await fs.readFile(logFile, "utf8").catch(() => "")).length;
        candidateStartMs = Date.now();
      }
      const started = await options.kickstartImpl(...args);
      if (nativeStarts === 1) candidatePid = Number.isInteger(started?.pid) ? started.pid : null;
      return started;
    },
    fetchImpl: async (...args) => {
      polls++;
      let response;
      try { response = await fetch(...args); }
      catch (error) {
        if (nativeStarts === 1) {
          lastBStatus = "fetch-error:" + String(error?.cause?.code ?? error?.name ?? "unknown");
          if (polls >= 25) {
            candidateNativePhases = await inspectB();
            if (candidatePid !== null) {
              try { process.kill(candidatePid, 0); candidateAlive = true; }
              catch (check) { candidateAlive = check?.code === "EPERM"; }
              candidateIdentity = await probeCandidate();
            }
          }
        }
        throw error;
      }
      if (!response.ok) lastStatus = "HTTP " + response.status;
      if (!response.ok) return response;
      const body = await response.clone().json().catch(() => null);
      lastStatus = JSON.stringify({ version: body?.status?.server?.version, kind: body?.status?.installation?.kind, health: body?.status?.health?.state });
      if (nativeStarts === 1) {
        if (firstBStatus === null) firstBStatus = lastStatus;
        lastBStatus = lastStatus;
      }
      if (body?.status?.server?.version !== versionB ||
          body?.status?.installation?.kind !== "managed" ||
          body?.status?.health?.state !== "HEALTHY") return response;
      observations++;
      return new Response(JSON.stringify({ ...body, status: {
        ...body.status, health: { ...body.status.health, state: "UNHEALTHY" },
      } }), { status: response.status, headers: { "content-type": "application/json" } });
    },
  }),
}), /rolled back/u);
assert.ok(observations > 0, "New native Stable must reach HEALTHY before forced rollback; " + JSON.stringify({ polls, firstBStatus, lastBStatus, lastStatus, nativeStarts, candidatePidObserved: candidatePid !== null, candidateAlive, candidateIdentity, candidateLogRotated, candidateNativePhases }));
assert.deepEqual(await fs.readFile(mainStamp), originalStamp);
assert.deepEqual(JSON.parse(await fs.readFile(currentPath, "utf8")), previousCurrent);
assert.deepEqual(await fs.readFile(manifestPath), originalManifest);
assert.equal(await shellHash(), originalShell);
const response = await fetch("http://127.0.0.1:24891/api/v1/status", { signal: AbortSignal.timeout(10000) });
const { status } = await response.json();
assert.equal(status.server.version, previousCurrent.version);
assert.equal(status.installation.kind, "managed-source");
assert.equal(status.installation.sourceSha, oldSha);
assert.equal(status.health.state, "HEALTHY");
console.log("Real Windows win32-" + process.arch + " old Main forced Stable B failure -> healthy original Main native WPF and Native Messaging rollback PASSED.");
