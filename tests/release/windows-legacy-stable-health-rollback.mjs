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
const inspectB = async () => {
  const log = await fs.readFile(logFile, "utf8").catch(() => "");
  const candidate = log.slice(candidateLogStart);
  return candidate.split("\n").slice(-85).flatMap((line) => {
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
    if (match[1] === "runtime-gate-exit") return [match[1] + ":" + (/exit=(-?\d+)/u.exec(details)?.[1] ?? "unknown")];
    if (match[1] === "tunnel-transport" && /^[a-z-]+$/u.test(details)) return [match[1] + ":" + details];
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
assert.ok(observations > 0, "New native Stable must reach HEALTHY before forced rollback; " + JSON.stringify({ polls, firstBStatus, lastBStatus, lastStatus, nativeStarts, candidatePidObserved: candidatePid !== null, candidateAlive, candidateIdentity, candidateNativePhases }));
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
