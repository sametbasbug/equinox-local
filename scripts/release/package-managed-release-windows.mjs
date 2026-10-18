import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { hashFile } from "../lib/package-io.mjs";
import { collectManagedReleaseSourceFiles, resolveManagedReleaseSourceSha } from "./package-managed-release.mjs";
import {
  EQUINOX_LOCAL_NODE_VERSION,
  EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION,
  EQUINOX_LOCAL_WINAPP_VERSION,
  NODE_DISTRIBUTIONS,
  TUNNEL_CLIENT_DISTRIBUTIONS,
  WINAPP_DISTRIBUTIONS,
} from "../../src/equinox-local-runtime-versions.js";
import { EQUINOX_LOCAL_VERSION } from "../../src/equinox-local-version.js";
import { validateFirstInstallRelease } from "../../src/equinox-local-first-install.js";

const execFile = promisify(execFileCallback);
const WINDOWS_TARGETS = Object.freeze({
  "win32-x64": Object.freeze({
    arch: "x64",
    shellRid: "win-x64",
    shellPlatform: "x64",
    visualStudioComponent: "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    vcvars: "vcvars64.bat",
    peMachine: 0x8664,
  }),
  "win32-arm64": Object.freeze({
    arch: "arm64",
    shellRid: "win-arm64",
    shellPlatform: "ARM64",
    visualStudioComponent: "Microsoft.VisualStudio.Component.VC.Tools.ARM64",
    vcvars: "vcvarsarm64.bat",
    crossVcvars: "vcvarsamd64_arm64.bat",
    peMachine: 0xaa64,
  }),
});
const MAX_DEPENDENCY_ARCHIVE_BYTES = 128 * 1024 * 1024;
const DEPENDENCY_DOWNLOAD_TIMEOUT_MS = 180_000;
const RETRYABLE_DEPENDENCY_HTTP = new Set([500, 502, 503, 504]);
const DEPENDENCY_RETRY_DELAYS_MS = Object.freeze([300, 900]);
const WINDOWS_ZIP_TIMEOUT_MS = 180_000;
const WINDOWS_EXTRA_RELEASE_FILES = Object.freeze([
  "src/equinox-local-windows-clipboard.ps1",
  "src/equinox-local-windows-desktop.ps1",
  "src/equinox-local-windows-private-state.ps1",
  "src/equinox-local-windows-process-gate.ps1",
  "src/equinox-local-windows-runtime-gate.mjs",
  "src/equinox-local-windows-runtime-supervisor.js",
  "src/equinox-local-windows-release-zip.ps1",
]);
const REQUIRED_SHELL_FILES = Object.freeze([
  "EquinoxLocal.exe",
  "coreclr.dll",
  "hostfxr.dll",
  "Microsoft.Web.WebView2.Core.dll",
]);

export function windowsManagedReleaseDestinationRelative(relative) {
  if (typeof relative !== "string" || relative.length === 0) throw new Error("Windows managed release source path is invalid.");
  const normalized = relative.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`Windows managed release source path is unsafe: ${relative}`);
  }
  return normalized.startsWith("src/") ? normalized.slice(4) : normalized;
}

export function windowsManagedPackageContract({ target = "win32-x64" } = {}) {
  const targetConfig = WINDOWS_TARGETS[target];
  if (!targetConfig) throw new Error(`Unsupported Windows managed release target: ${target}.`);
  return Object.freeze({
    target,
    ...targetConfig,
    artifactSuffix: `${target}.zip`,
    extraReleaseFiles: WINDOWS_EXTRA_RELEASE_FILES,
    requiredShellFiles: REQUIRED_SHELL_FILES,
  });
}

async function sha256File(filePath) {
  const result = await hashFile(filePath, { suppressCloseErrors: true });
  return Object.freeze({ sha256: result.sha256, bytes: result.bytes });
}

export async function downloadVerifiedPinnedWindowsDependency(url, destination, expectedSha256, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEPENDENCY_DOWNLOAD_TIMEOUT_MS,
  retryDelayImpl = (ms, signal) => sleep(ms, undefined, { signal }),
} = {}) {
  if (typeof url !== "string" || !url.startsWith("https://") ||
      typeof destination !== "string" || !path.isAbsolute(destination) ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256 ?? "") ||
      typeof fetchImpl !== "function" || typeof retryDelayImpl !== "function" ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 180_000) {
    throw new Error("Pinned Windows dependency download contract is invalid.");
  }
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  for (let attempt = 0; attempt <= DEPENDENCY_RETRY_DELAYS_MS.length; attempt += 1) {
    if (signal.aborted) throw new Error("Pinned dependency download deadline expired.");
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      credentials: "omit",
      signal,
    });
    if (response?.ok) break;
    const retryable = RETRYABLE_DEPENDENCY_HTTP.has(response?.status)
      && attempt < DEPENDENCY_RETRY_DELAYS_MS.length;
    try { await response?.body?.cancel?.(); } catch { /* Failed error body cleanup is not an authorization. */ }
    if (!retryable) throw new Error(`Pinned dependency server returned HTTP ${response?.status ?? "unknown"}.`);
    // Retry ONLY transient pre-transfer server errors; never replay a partial
    // archive, foreign redirect policy failure, or hash/size validation error.
    await retryDelayImpl(DEPENDENCY_RETRY_DELAYS_MS[attempt], signal);
  }
  if (!response?.body) throw new Error(`Pinned dependency server returned HTTP ${response?.status ?? "unknown"}.`);
  const temporary = `${destination}.part-${randomBytes(8).toString("hex")}`;
  const handle = await fs.open(temporary, "wx");
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const value of response.body) {
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > MAX_DEPENDENCY_ARCHIVE_BYTES) throw new Error("Pinned dependency archive exceeded the size limit.");
      digest.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  const actual = digest.digest("hex");
  if (actual !== expectedSha256) {
    await fs.rm(temporary, { force: true });
    throw new Error("Pinned dependency SHA-256 verification failed.");
  }
  await fs.rename(temporary, destination);
  return Object.freeze({ bytes, sha256: actual });
}

async function expandTrustedPinnedZip(archive, destination) {
  await fs.mkdir(destination, { recursive: true });
  await execFile("tar.exe", ["-xf", archive, "-C", destination], {
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

async function assertNormalTree(root) {
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Managed Windows package contains a reparse/symbolic link: ${absolute}`);
      if (stat.isDirectory()) stack.push(absolute);
      else if (!stat.isFile()) throw new Error(`Managed Windows package contains an unsupported filesystem entry: ${absolute}`);
    }
  }
}

async function hardlinkNormalTree(sourceRoot, destinationRoot) {
  const sourceStat = await fs.lstat(sourceRoot);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Hardlink source tree is unavailable or unsafe.");
  await fs.mkdir(destinationRoot, { recursive: true });
  const stack = [[sourceRoot, destinationRoot]];
  while (stack.length > 0) {
    const [sourceDir, destinationDir] = stack.pop();
    for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
      if (entry.name === ".bin" && sourceDir === sourceRoot) continue;
      const source = path.join(sourceDir, entry.name);
      const destination = path.join(destinationDir, entry.name);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) throw new Error(`Hardlink source tree contains a symbolic link: ${source}`);
      if (stat.isDirectory()) {
        await fs.mkdir(destination, { recursive: false });
        stack.push([source, destination]);
      } else if (stat.isFile()) {
        try {
          await fs.link(source, destination);
        } catch (error) {
          if (!["EXDEV", "EPERM"].includes(error?.code)) throw error;
          await fs.copyFile(source, destination);
        }
      } else {
        throw new Error(`Hardlink source tree contains an unsupported filesystem entry: ${source}`);
      }
    }
  }
}

async function copyReleaseSources(rootDir, releaseDir) {
  const files = await collectManagedReleaseSourceFiles(rootDir);
  for (const relative of [...files, ...WINDOWS_EXTRA_RELEASE_FILES]) {
    const source = path.join(rootDir, relative);
    const destinationRelative = windowsManagedReleaseDestinationRelative(relative);
    const destination = path.join(releaseDir, destinationRelative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
  const modulesSource = path.join(rootDir, "node_modules");
  await hardlinkNormalTree(modulesSource, path.join(releaseDir, "node_modules"));
  return files.length;
}

async function installPinnedWindowsNode(transaction, releaseDir, fetchImpl, target, { canExecuteTarget = true } = {}) {
  const distribution = NODE_DISTRIBUTIONS[target];
  const archive = path.join(transaction, distribution.filename);
  const extracted = path.join(transaction, "node-extracted");
  await downloadVerifiedPinnedWindowsDependency(`https://nodejs.org/dist/v${EQUINOX_LOCAL_NODE_VERSION}/${distribution.filename}`, archive, distribution.sha256, { fetchImpl });
  await expandTrustedPinnedZip(archive, extracted);
  await assertNormalTree(extracted);
  const sourceRoot = path.join(extracted, distribution.filename.replace(/\.zip$/u, ""));
  const destination = path.join(releaseDir, "runtime", "node");
  await fs.mkdir(path.join(destination, "bin"), { recursive: true });
  const nodePath = path.join(destination, "bin", "node.exe");
  await fs.copyFile(path.join(sourceRoot, "node.exe"), nodePath);
  await fs.copyFile(path.join(sourceRoot, "LICENSE"), path.join(destination, "LICENSE"));
  const nodeMachine = await portableExecutableMachine(nodePath);
  if (nodeMachine !== WINDOWS_TARGETS[target].peMachine) throw new Error(`Pinned Windows Node architecture mismatch for ${target}: 0x${nodeMachine.toString(16)}.`);
  if (canExecuteTarget) {
    const version = await execFile(nodePath, ["--version"], { timeout: 10_000, windowsHide: true });
    if (version.stdout.trim() !== `v${EQUINOX_LOCAL_NODE_VERSION}`) throw new Error("Pinned Windows Node version mismatch.");
  }
}

async function installPinnedWindowsTunnel(transaction, releaseDir, fetchImpl, target, { canExecuteTarget = true } = {}) {
  const distribution = TUNNEL_CLIENT_DISTRIBUTIONS[target];
  const archive = path.join(transaction, distribution.filename);
  const extracted = path.join(transaction, "tunnel-extracted");
  await downloadVerifiedPinnedWindowsDependency(`https://github.com/openai/tunnel-client/releases/download/v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}/${distribution.filename}`, archive, distribution.sha256, { fetchImpl });
  await expandTrustedPinnedZip(archive, extracted);
  await assertNormalTree(extracted);
  const expected = [
    "LICENSE", "NOTICE", "cloudflared-manifest.json", "cloudflared.exe", "tunnel-client.exe",
    `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-${distribution.assetTag}-licenses.txt`,
    `tunnel-client-v${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}-${distribution.assetTag}.spdx.json`,
  ].sort();
  const actual = (await fs.readdir(extracted)).sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) throw new Error("Pinned Windows tunnel archive contents drifted.");
  const destination = path.join(releaseDir, "runtime", "tunnel");
  await fs.mkdir(destination, { recursive: true });
  for (const name of expected) await fs.copyFile(path.join(extracted, name), path.join(destination, name));
  for (const name of ["tunnel-client.exe", "cloudflared.exe"]) {
    const machine = await portableExecutableMachine(path.join(destination, name));
    if (machine !== WINDOWS_TARGETS[target].peMachine) throw new Error(`Pinned Windows ${name} architecture mismatch for ${target}: 0x${machine.toString(16)}.`);
  }
  if (canExecuteTarget) {
    const version = await execFile(path.join(destination, "tunnel-client.exe"), ["--version"], { timeout: 10_000, windowsHide: true });
    if (!version.stdout.trim().startsWith(`${EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION}+`)) throw new Error("Pinned Windows tunnel-client version mismatch.");
  }
}

async function installPinnedWindowsWinapp(transaction, rootDir, releaseDir, fetchImpl, target, { canExecuteTarget = true } = {}) {
  const distribution = WINAPP_DISTRIBUTIONS[target];
  if (!distribution) throw new Error(`Pinned Microsoft winapp distribution is unavailable for ${target}.`);
  const archive = path.join(transaction, distribution.filename);
  const extracted = path.join(transaction, "winapp-extracted");
  await downloadVerifiedPinnedWindowsDependency(`https://github.com/microsoft/winappCli/releases/download/v${EQUINOX_LOCAL_WINAPP_VERSION}/${distribution.filename}`, archive, distribution.sha256, { fetchImpl });
  await expandTrustedPinnedZip(archive, extracted);
  await assertNormalTree(extracted);
  const expected = ["libHarfBuzzSharp.dll", "libHarfBuzzSharp.pdb", "libSkiaSharp.dll", "libSkiaSharp.pdb", "winapp.exe", "winapp.pdb"].sort();
  const actual = (await fs.readdir(extracted)).sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error("Pinned Microsoft winapp archive contents drifted.");
  }
  const destination = path.join(releaseDir, "runtime", "winapp");
  await fs.mkdir(destination, { recursive: true });
  for (const name of ["winapp.exe", "libHarfBuzzSharp.dll", "libSkiaSharp.dll"]) {
    await fs.copyFile(path.join(extracted, name), path.join(destination, name));
  }
  await fs.copyFile(path.join(rootDir, "licenses", "microsoft-winapp-cli.txt"), path.join(destination, "LICENSE"));
  const machine = await portableExecutableMachine(path.join(destination, "winapp.exe"));
  const expectedMachine = WINDOWS_TARGETS[target].peMachine;
  if (machine !== expectedMachine) throw new Error(`Microsoft winapp architecture mismatch for ${target}: 0x${machine.toString(16)}.`);
  if (canExecuteTarget) {
    const version = await execFile(path.join(destination, "winapp.exe"), ["--version"], { timeout: 10_000, windowsHide: true });
    if (!`${version.stdout ?? ""}${version.stderr ?? ""}`.includes(EQUINOX_LOCAL_WINAPP_VERSION)) {
      throw new Error("Pinned Microsoft winapp version mismatch.");
    }
  }
}

async function copyPublishedShell(rootDir, releaseDir, shellPublishDir) {
  const source = path.resolve(rootDir, shellPublishDir);
  for (const required of REQUIRED_SHELL_FILES) {
    const stat = await fs.lstat(path.join(source, required));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Published Windows shell is missing ${required}.`);
  }
  let loaderFound = false;
  async function scan(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(absolute);
      else if (entry.isFile() && entry.name === "WebView2Loader.dll") loaderFound = true;
    }
  }
  await scan(source);
  if (!loaderFound) throw new Error("Published Windows shell is missing WebView2Loader.dll.");
  await assertNormalTree(source);
  await fs.cp(source, path.join(releaseDir, "runtime", "shell"), { recursive: true, dereference: false });
}

async function portableExecutableMachine(filePath) {
  const bytes = await fs.readFile(filePath);
  if (bytes.length < 64) throw new Error(`Portable executable is unexpectedly small: ${filePath}`);
  const peOffset = bytes.readInt32LE(0x3c);
  if (peOffset < 0 || peOffset + 6 > bytes.length || bytes.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    throw new Error(`Portable executable has an invalid PE header: ${filePath}`);
  }
  return bytes.readUInt16LE(peOffset + 4);
}

// These arguments are embedded into a .cmd file, not passed directly to an
// executable. Reject CMD metacharacters rather than trusting runner environment
// or checkout paths just because a corresponding filesystem entry exists.
export function assertWindowsBatchQuotedPath(value) {
  if (typeof value !== "string" || !/^[A-Za-z]:\\[\p{L}\p{M}\p{N} _().\\-]+$/u.test(value)) {
    throw new Error("Windows native compile path contains unsafe CMD characters.");
  }
  return value;
}

async function resolveVisualStudioVcvars(contract) {
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (!programFilesX86) throw new Error("ProgramFiles(x86) is unavailable.");
  const vswhere = path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const discoveryOptions = { timeout: 10_000, windowsHide: true };
  let installation = "";
  try {
    const found = await execFile(vswhere, ["-latest", "-products", "*", "-requires", contract.visualStudioComponent, "-property", "installationPath"], discoveryOptions);
    installation = found.stdout.trim();
  } catch {
    // Hosted runner component registration can drift even when target vcvars is present.
  }
  if (!installation) {
    const found = await execFile(vswhere, ["-latest", "-products", "*", "-property", "installationPath"], discoveryOptions);
    installation = found.stdout.trim();
  }
  if (!installation) throw new Error(`Visual Studio C++ toolchain is unavailable for ${contract.target}.`);
  const vcvarsName = process.arch === "x64" && contract.target === "win32-arm64" ? contract.crossVcvars : contract.vcvars;
  const vcvars = path.join(installation, "VC", "Auxiliary", "Build", vcvarsName);
  const stat = await fs.lstat(vcvars).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Visual Studio target environment is unavailable for ${contract.target}.`);
  return assertWindowsBatchQuotedPath(vcvars);
}

export async function compileWindowsJobObjectHelper({
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  outputDir,
  target = `${process.platform}-${process.arch}`,
} = {}) {
  if (!outputDir) throw new Error("Windows Job Object helper output directory is required.");
  const contract = windowsManagedPackageContract({ target });
  const vcvars = await resolveVisualStudioVcvars(contract);
  const destination = path.resolve(outputDir);
  await fs.mkdir(destination, { recursive: true });
  const source = assertWindowsBatchQuotedPath(path.join(rootDir, "native", "windows", "equinox-local-job-object-helper.cpp"));
  const compileScript = path.join(destination, ".compile-job-object-helper.cmd");
  const script = [
    "@echo off",
    `call "${vcvars}" >nul`,
    "if errorlevel 1 exit /b %errorlevel%",
    // Helper uses redirected pipes and must not allocate a desktop console.
    // GUI subsystem keeps Windows Terminal out; mainCRTStartup initializes C++ stdio.
    `cl.exe /nologo /std:c++17 /O2 /EHsc /MT /DUNICODE /D_UNICODE "${source}" /Fe:equinox-local-job-object-helper.exe /link /SUBSYSTEM:WINDOWS /ENTRY:wmainCRTStartup`,
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
  await fs.writeFile(compileScript, script, { encoding: "utf8", flag: "wx" });
  try {
    await execFile("cmd.exe", ["/d", "/c", ".\\.compile-job-object-helper.cmd"], { cwd: destination, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  } finally {
    await fs.rm(compileScript, { force: true });
    await fs.rm(path.join(destination, "equinox-local-job-object-helper.obj"), { force: true });
  }
  const helperPath = path.join(destination, "equinox-local-job-object-helper.exe");
  const machine = await portableExecutableMachine(helperPath);
  if (machine !== contract.peMachine) throw new Error(`Windows Job Object helper architecture mismatch for ${target}: 0x${machine.toString(16)}.`);
  // Marker signals that this compiled native payload supports owned-process
  // gating. Older authenticated Main native releases lack this exact marker.
  await fs.writeFile(path.join(destination, "owned-process-gate-v1.marker"), "equinox-owned-process-gate-v1\n", { flag: "wx" });
  return helperPath;
}

async function compileBrowserLauncher(rootDir, releaseDir, contract) {
  const browserDir = path.join(releaseDir, "runtime", "browser");
  await fs.mkdir(browserDir, { recursive: true });
  const vcvars = await resolveVisualStudioVcvars(contract);
  const source = assertWindowsBatchQuotedPath(path.join(rootDir, "native", "windows", "equinox-browser-native-host-launcher.cpp"));
  const compileScript = path.join(browserDir, ".compile-browser-launcher.cmd");
  const script = [
    "@echo off",
    `call "${vcvars}" >nul`,
    "if errorlevel 1 exit /b %errorlevel%",
    `cl.exe /nologo /std:c++17 /O2 /EHsc /DUNICODE /D_UNICODE "${source}" /Fe:equinox-browser-native-host.exe`,
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
  await fs.writeFile(compileScript, script, { encoding: "utf8", flag: "wx" });
  try {
    await execFile("cmd.exe", ["/d", "/c", ".\\.compile-browser-launcher.cmd"], {
      cwd: browserDir,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
  } finally {
    await fs.rm(compileScript, { force: true });
  }
  const launcherPath = path.join(browserDir, "equinox-browser-native-host.exe");
  const machine = await portableExecutableMachine(launcherPath);
  if (machine !== contract.peMachine) {
    throw new Error(`Windows Native Messaging launcher architecture mismatch for ${contract.target}: 0x${machine.toString(16)}.`);
  }
}

async function copyPrecompiledBrowserLauncher(browserLauncherPath, releaseDir, contract) {
  const source = path.resolve(browserLauncherPath);
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Precompiled Windows Native Messaging launcher is unavailable or unsafe.");
  const machine = await portableExecutableMachine(source);
  if (machine !== contract.peMachine) {
    throw new Error(`Precompiled Windows Native Messaging launcher architecture mismatch for ${contract.target}: 0x${machine.toString(16)}.`);
  }
  const browserDir = path.join(releaseDir, "runtime", "browser");
  await fs.mkdir(browserDir, { recursive: true });
  await fs.copyFile(source, path.join(browserDir, "equinox-browser-native-host.exe"));
}

async function compileWindowsGuardian(rootDir, releaseDir, transaction, contract) {
  // Independent native launcher lives outside the replaceable WPF directory
  // after installation. Packaging on a Windows CI/build host is allowed to use
  // dotnet; the installed runtime never compiles any of its own components.
  const guardianDir = path.join(releaseDir, "runtime", "guardian");
  const project = path.join(rootDir, "native", "windows", "EquinoxLocal.Guardian", "EquinoxLocal.Guardian.csproj");
  const bin = path.join(transaction, "guardian-bin", contract.shellRid);
  const obj = path.join(transaction, "guardian-obj", contract.shellRid);
  await fs.mkdir(guardianDir, { recursive: true });
  try {
    await execFile("dotnet", ["publish", project, "--configuration", "Release", "--runtime", contract.shellRid,
      "--self-contained", "true", `-p:Platform=${contract.shellPlatform}`, `-p:BaseOutputPath=${bin}${path.sep}`,
      `-p:BaseIntermediateOutputPath=${obj}${path.sep}`, "--output", guardianDir], {
      cwd: rootDir, windowsHide: true, timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    // execFile rejects with stdout/stderr but its message alone only prints
    // the command. Surface bounded compiler diagnostics so native x64/ARM64
    // package failures are actionable without re-running the entire CI gate.
    const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    const diagnostics = output.split(/\r?\n/u)
      .filter((line) => /\berror (?:CS[0-9]+|MSB[0-9]+|NETSDK[0-9]+)\b|\bBuild FAILED\b/u.test(line))
      .slice(0, 8).map((line) => line.slice(0, 450));
    throw new Error(`Windows Guardian native publish failed (${contract.target}): ${diagnostics.join(" | ") || "no compiler diagnostics returned"}`);
  }
  const executable = path.join(guardianDir, "EquinoxLocalGuardian.exe");
  const info = await fs.lstat(executable);
  if (!info.isFile() || info.isSymbolicLink() || (await portableExecutableMachine(executable)) !== contract.peMachine) {
    throw new Error("Built Windows Guardian is not an exact architecture-matched normal executable.");
  }
}

async function createManagedZip(rootDir, releaseDir, artifactPath) {
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "windows-managed-zip.ps1");
  await fs.rm(artifactPath, { force: true });
  try {
    const result = await execFile("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
      "-SourceDirectory", releaseDir, "-DestinationZip", artifactPath,
    ], { timeout: WINDOWS_ZIP_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (process.env.GITHUB_ACTIONS === "true") {
      for (const line of String(result?.stdout ?? "").split(/\r?\n/u)) {
        const match = /^Hosted Windows ZIP writer phase: (assembly-load|compile|write); durationSeconds=(\d{1,3}\.\d)$/u.exec(line);
        if (match && Number(match[2]) <= 600) {
          process.stdout.write("Hosted Windows ZIP writer phase: " + match[1] + "; durationSeconds=" + match[2] + "\n");
        }
      }
    }
  } catch (error) {
    if (error && typeof error === "object" && (error.killed === true || error.signal)) {
      throw new Error(`Windows managed ZIP creation exceeded ${WINDOWS_ZIP_TIMEOUT_MS} ms.`);
    }
    const stderr = error && typeof error === "object" && typeof error.stderr === "string" ? error.stderr.trim() : "";
    if (stderr) throw new Error(`Windows managed ZIP creation failed: ${stderr.slice(0, 2000)}`);
    throw error;
  }
}

export async function packageManagedEquinoxWindowsRelease({
  rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  outputDir = path.join(rootDir, "backups", "local-packages"),
  target = process.env.EQUINOX_WINDOWS_PACKAGE_TARGET || `${process.platform}-${process.arch}`,
  shellPublishDir = process.env.EQUINOX_WINDOWS_SHELL_PUBLISH_DIR || null,
  browserLauncherPath = process.env.EQUINOX_WINDOWS_BROWSER_LAUNCHER_PATH || null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const hostTarget = `${process.platform}-${process.arch}`;
  const contract = windowsManagedPackageContract({ target });
  const supportedHost = process.platform === "win32" && ["x64", "arm64"].includes(process.arch);
  const supportedPair = supportedHost && (target === hostTarget || (process.arch === "x64" && target === "win32-arm64"));
  if (!supportedPair) {
    throw new Error(`Windows managed release packaging requires a supported native or x64-to-ARM64 Windows host/target pair; got host=${hostTarget} target=${target}.`);
  }
  const sourceSha = await resolveManagedReleaseSourceSha(rootDir);
  const resolvedShellPublishDir = shellPublishDir || path.join("artifacts", "windows-shell", contract.shellRid);
  await fs.mkdir(outputDir, { recursive: true });
  const transaction = await fs.mkdtemp(path.join(outputDir, `.build-${EQUINOX_LOCAL_VERSION}-${target}-`));
  const releaseDir = path.join(transaction, "release");
  const artifactPath = path.join(outputDir, `equinox-local-${EQUINOX_LOCAL_VERSION}-${target}.zip`);
  await fs.mkdir(releaseDir, { recursive: true });
  try {
    const hostedTiming = process.env.GITHUB_ACTIONS === "true";
    const timed = (phase, started) => {
      if (!hostedTiming) return;
      process.stdout.write("Hosted Windows package phase: " + phase + "; durationSeconds=" +
        Math.min(600, Math.max(0, (Date.now() - started) / 1000)).toFixed(1) + "\n");
    };
    const canExecuteTarget = target === hostTarget;
    const component = async (label, invoke) => {
      const started = Date.now();
      try { return await invoke(); }
      finally { timed("component-" + label, started); }
    };
    const preparationStarted = Date.now();
    const preparationResults = await Promise.allSettled([
      component("sources", () => copyReleaseSources(rootDir, releaseDir)),
      component("node", () => installPinnedWindowsNode(transaction, releaseDir, fetchImpl, target, { canExecuteTarget })),
      component("tunnel", () => installPinnedWindowsTunnel(transaction, releaseDir, fetchImpl, target, { canExecuteTarget })),
      component("winapp", () => installPinnedWindowsWinapp(transaction, rootDir, releaseDir, fetchImpl, target, { canExecuteTarget })),
      component("shell", () => copyPublishedShell(rootDir, releaseDir, resolvedShellPublishDir)),
      component("guardian", () => compileWindowsGuardian(rootDir, releaseDir, transaction, contract)),
      component("job", () => compileWindowsJobObjectHelper({ rootDir, outputDir: path.join(releaseDir, "runtime", "job"), target })),
      component("browser-launcher", () => browserLauncherPath
        ? copyPrecompiledBrowserLauncher(browserLauncherPath, releaseDir, contract)
        : compileBrowserLauncher(rootDir, releaseDir, contract)),
    ]);
    const preparationFailure = preparationResults.find((result) => result.status === "rejected");
    if (preparationFailure) throw preparationFailure.reason;
    timed("prepare-components", preparationStarted);
    const sourceFileCount = preparationResults[0].value;
    await fs.writeFile(path.join(releaseDir, "release.json"), `${JSON.stringify({
      schemaVersion: 1,
      version: EQUINOX_LOCAL_VERSION,
      target,
      sourceSha,
      nodeVersion: EQUINOX_LOCAL_NODE_VERSION,
      tunnelClientVersion: EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION,
      serverEntry: "server.js",
    }, null, 2)}\n`);
    const validationStarted = Date.now();
    await assertNormalTree(releaseDir);
    await validateFirstInstallRelease(releaseDir, { target });
    timed("validate-inputs", validationStarted);
    const zipStarted = Date.now();
    await createManagedZip(rootDir, releaseDir, artifactPath);
    timed("write-zip", zipStarted);
    const hashStarted = Date.now();
    const digest = await sha256File(artifactPath);
    timed("hash-zip", hashStarted);
    return Object.freeze({ version: EQUINOX_LOCAL_VERSION, target, sourceSha, artifactPath, ...digest, sourceFileCount });
  } finally {
    await fs.rm(transaction, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  packageManagedEquinoxWindowsRelease()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
