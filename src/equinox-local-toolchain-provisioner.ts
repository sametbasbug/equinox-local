import { randomBytes } from "node:crypto";
import type {Dirent} from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { downloadVerifiedUpdateArtifact } from "./equinox-local-release-manager.js";
import { equinoxLocalToolchainContract } from "./equinox-local-toolchain-contract.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";

const execFile = promisify(execFileCallback);
const WINDOWS_ZIP_HELPER_PATH = fileURLToPath(new URL("./equinox-local-windows-release-zip.ps1", import.meta.url));
type ProvisionFs = typeof fs;
type ProvisionEnv = NodeJS.ProcessEnv;
type ProvisionContract = ReturnType<typeof equinoxLocalToolchainContract>;
type ProvisionComponent = ProvisionContract["git"] | ProvisionContract["node"];
type PinnedArtifact = ProvisionComponent["distribution"];
type ProvisionExec = (command:string,args:string[],options:{timeout:number;maxBuffer:number;windowsHide?:boolean})=>Promise<{stdout:string|Buffer;stderr?:string|Buffer}>;
type DownloadArtifact = (artifact:PinnedArtifact,destination:string)=>Promise<unknown>;
type ExtractComponent = (args:ExtractOptions)=>Promise<unknown>;
type ExtractOptions = {
  archivePath:string;extractionRoot:string;component:ProvisionComponent;
  contract:ProvisionContract;platform:string;env:ProvisionEnv;
  execFileImpl:ProvisionExec;windowsZipHelperPath:string;
};
type HostOptions = {platform:string;env:ProvisionEnv;execFileImpl:ProvisionExec};
type FsOptions = {fsImpl?:ProvisionFs};
type DirOptions = FsOptions & {create?:boolean;pathApi?:typeof path.posix};
type RootOptions = FsOptions & {platform:string;execFileImpl:ProvisionExec};
type StampOptions = FsOptions & {platform?:string};
type NormalFileOptions = FsOptions & {executable?:boolean;platform?:string};
type InstallOptions = {platform:string;env:ProvisionEnv;fsImpl:ProvisionFs;
  execFileImpl:ProvisionExec;downloadImpl:DownloadArtifact;extractComponentImpl:ExtractComponent;windowsZipHelperPath:string};
type ProvisionOptions = FsOptions & {
  runtimeRoot?:unknown;target?:string;platform?:string;env?:ProvisionEnv;
  execFileImpl?:ProvisionExec;fetchImpl?:typeof fetch;
  downloadImpl?:DownloadArtifact|null;extractComponentImpl?:ExtractComponent;
  windowsZipHelperPath?:string|undefined;
};
type TarEntry = Readonly<{name:string;parts:string[];type:string;size:number;linkTarget:string|null}>;
type ParseTarInput = {namesOutput:unknown;verboseOutput:unknown;expectedRoot:string};
function errorCode(error:unknown,code:string):boolean {return error!==null&&typeof error==="object"&&"code" in error&&error.code===code;}
const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRY_NAME = 1_000;
const COMPONENT_STAMP = ".equinox-toolchain-component.json";

function inside(parent:string, child:string, pathApi:typeof path.posix = path) {
  const relative = pathApi.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !pathApi.isAbsolute(relative);
}

function normalizeTarEntryName(rawName:unknown, expectedRoot:string) {
  if (typeof rawName !== "string" || rawName.length < 1 || rawName.length > MAX_ENTRY_NAME || rawName.includes("\0") || rawName.includes("\\")) {
    throw new Error("Toolchain archive contains an invalid entry name.");
  }
  let name = rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
  if (expectedRoot === ".") {
    while (name.startsWith("./")) name = name.slice(2);
    if (name === "" || name === ".") return Object.freeze({ name: "", parts: [] });
  }
  if (!name || path.posix.isAbsolute(name)) throw new Error("Toolchain archive entries must be relative paths.");
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Toolchain archive contains an unsafe path traversal entry.");
  }
  if (expectedRoot !== "." && parts[0] !== expectedRoot) {
    throw new Error("Toolchain archive escaped its expected root.");
  }
  return Object.freeze({ name, parts });
}

function validateRelativeSymlinkTarget(parts:string[], target:unknown, expectedRoot:string) {
  if (typeof target !== "string" || target.length < 1 || target.length > MAX_ENTRY_NAME || target.includes("\0") || target.includes("\\") || path.posix.isAbsolute(target)) {
    throw new Error("Toolchain archive contains an unsafe symbolic link target.");
  }
  const stack = parts.slice(0, -1);
  const minimumDepth = expectedRoot === "." ? 0 : 1;
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length <= minimumDepth) throw new Error("Toolchain archive symbolic link escapes its expected root.");
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
}

function parseTarVerboseEntry(line:string) {
  const type = line[0] ?? "";
  const match = line.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+/u);
  if (!match) throw new Error("Toolchain archive verbose listing is invalid.");
  const size = Number(match[1]);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Toolchain archive entry size is invalid.");
  const arrow = type === "l" ? line.lastIndexOf(" -> ") : -1;
  const linkTarget = arrow >= 0 ? line.slice(arrow + 4) : null;
  if (type === "l" && !linkTarget) throw new Error("Toolchain archive symbolic link metadata is invalid.");
  return Object.freeze({ type, size, linkTarget });
}

export function validateToolchainTarListing({ namesOutput, verboseOutput, expectedRoot }:ParseTarInput) {
  if (expectedRoot !== "." && (typeof expectedRoot !== "string" || expectedRoot.length < 1 || expectedRoot.includes("/") || expectedRoot.includes("\\"))) {
    throw new Error("Toolchain archive expected root is invalid.");
  }
  const rawNames = String(namesOutput ?? "").split("\n").filter(Boolean);
  const verboseLines = String(verboseOutput ?? "").split("\n").filter(Boolean);
  if (rawNames.length < 1 || rawNames.length > MAX_ARCHIVE_ENTRIES || verboseLines.length !== rawNames.length) {
    throw new Error("Toolchain archive listing is inconsistent.");
  }

  const entries:TarEntry[] = [];
  const seen = new Set<string>();
  let extractedBytes = 0;
  for (let index = 0; index < rawNames.length; index += 1) {
    const normalized = normalizeTarEntryName(rawNames[index], expectedRoot);
    const metadata = parseTarVerboseEntry(verboseLines[index]!);
    if (!["-", "d", "l"].includes(metadata.type)) {
      throw new Error("Toolchain archive may contain only regular files, directories and safe symbolic links.");
    }
    if (normalized.name) {
      if (seen.has(normalized.name)) throw new Error("Toolchain archive contains a duplicate path.");
      seen.add(normalized.name);
    } else if (metadata.type !== "d") {
      throw new Error("Toolchain archive root marker must be a directory.");
    }
    if (metadata.type === "l") validateRelativeSymlinkTarget(normalized.parts, metadata.linkTarget, expectedRoot);
    if (metadata.type === "-") {
      if (metadata.size > MAX_EXTRACTED_BYTES - extractedBytes) throw new Error("Toolchain archive exceeds the extracted size limit.");
      extractedBytes += metadata.size;
    }
    entries.push(Object.freeze({ ...normalized, ...metadata }));
  }

  const symlinks = new Set(entries.filter((entry) => entry.type === "l").map((entry) => entry.name));
  for (const entry of entries) {
    if (!entry.name) continue;
    const parts = entry.name.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (symlinks.has(parts.slice(0, index).join("/"))) {
        throw new Error("Toolchain archive contains an entry beneath a symbolic link.");
      }
    }
  }

  return Object.freeze({ entryCount: entries.length, extractedBytes });
}

export function toolchainFetchForArtifact(artifact:{url:string}, fetchImpl:typeof fetch) {
  if (typeof fetchImpl !== "function") throw new Error("Toolchain network client is unavailable.");
  let expected;
  try { expected = new URL(artifact.url); } catch { throw new Error("Toolchain artifact URL is invalid."); }
  if (expected.protocol !== "https:") throw new Error("Toolchain artifact URL must use HTTPS.");

  return async (url:RequestInfo|URL, options:RequestInit = {}) => {
    const requested = new URL(String(url));
    if (requested.href !== expected.href) throw new Error("Toolchain downloader refused an unexpected artifact URL.");
    let response = await fetchImpl(requested, { ...options, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response?.status)) return response;

    if (expected.hostname !== "github.com") throw new Error("Toolchain artifact returned an unexpected redirect.");
    const location = response.headers?.get?.("location");
    if (!location) throw new Error("Toolchain artifact redirect is missing its Location header.");
    const redirected = new URL(location, expected);
    if (
      redirected.protocol !== "https:" ||
      redirected.hostname !== "release-assets.githubusercontent.com" ||
      !redirected.pathname.startsWith("/github-production-release-asset/")
    ) {
      throw new Error("Toolchain artifact redirect target is not trusted.");
    }
    return fetchImpl(redirected, { ...options, redirect: "error" });
  };
}

function windowsSystemTools(env:ProvisionEnv) {
  const root = env?.SystemRoot ?? env?.WINDIR;
  if (typeof root !== "string" || !path.win32.isAbsolute(root) || root.includes("\0")) {
    throw new Error("Trusted Windows SystemRoot is required for toolchain extraction.");
  }
  return Object.freeze({
    tar: path.win32.join(root, "System32", "tar.exe"),
    powershell: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  });
}

async function inspectTarArchive(archivePath:string, expectedRoot:string, { platform, env, execFileImpl }:HostOptions) {
  const tarPath = platform === "win32" ? windowsSystemTools(env).tar : "/usr/bin/tar";
  const [{ stdout: namesOutput }, { stdout: verboseOutput }] = await Promise.all([
    execFileImpl(tarPath, ["-tzf", archivePath], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }),
    execFileImpl(tarPath, ["-tvzf", archivePath], { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }),
  ]);
  return validateToolchainTarListing({ namesOutput, verboseOutput, expectedRoot });
}

async function extractTarArchive(archivePath:string, destinationPath:string, { platform, env, execFileImpl }:HostOptions) {
  const tarPath = platform === "win32" ? windowsSystemTools(env).tar : "/usr/bin/tar";
  await fs.mkdir(destinationPath, { recursive: false, mode: 0o700 });
  const args = ["-xzf", archivePath, "-C", destinationPath];
  if (platform !== "win32") args.push("--no-same-owner");
  await execFileImpl(tarPath, args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}

async function runWindowsZipHelper(mode:string, archivePath:string, destinationPath:string|null, expectedRoot:string, { env, execFileImpl, helperPath }:Omit<HostOptions,"platform">&{helperPath:string}) {
  const powershell = windowsSystemTools(env).powershell;
  const args = [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", helperPath,
    "-Mode", mode,
    "-ArchivePath", archivePath,
    "-ExpectedRoot", expectedRoot,
  ];
  if (destinationPath) args.push("-DestinationPath", destinationPath);
  await execFileImpl(powershell, args, {
    timeout: mode === "Extract" ? 180_000 : 60_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

const TREE_VALIDATION_CONCURRENCY = 16;

async function mapBounded<T,R>(items:readonly T[], concurrency:number, visit:(item:T,index:number)=>Promise<R>):Promise<R[]> {
  const results:R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await visit(items[index]!, index);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function validateExtractedTree(root:string, { platform, fsImpl = fs }:FsOptions&{platform:string}) {
  let entryCount = 0;
  let totalBytes = 0;
  let frontier:string[] = [root];
  const rootReal = await fsImpl.realpath(root);
  while (frontier.length > 0) {
    const directoryBatches = await mapBounded(frontier, 8, async (directory) => ({
      directory,
      entries: await fsImpl.readdir(directory, { withFileTypes: true }),
    }));
    const pending:{directory:string;entry:Dirent<string>}[] = [];
    for (const { directory, entries } of directoryBatches) {
      entryCount += entries.length;
      if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error("Extracted toolchain contains too many entries.");
      for (const entry of entries) pending.push({ directory, entry });
    }
    const inspected = await mapBounded(pending, TREE_VALIDATION_CONCURRENCY, async ({ directory, entry }) => {
      const absolute = path.join(directory, entry.name);
      const stat = await fsImpl.lstat(absolute);
      if (stat.isSymbolicLink()) {
        if (platform === "win32") throw new Error("Windows toolchain extraction may not contain symbolic links or reparse points.");
        const target = await fsImpl.readlink(absolute);
        if (path.isAbsolute(target)) throw new Error("Extracted toolchain contains an absolute symbolic link.");
        const resolved = await fsImpl.realpath(absolute);
        if (resolved !== rootReal && !inside(rootReal, resolved)) throw new Error("Extracted toolchain symbolic link escaped its root.");
        return Object.freeze({ type: "symlink" });
      }
      if (stat.isDirectory()) return Object.freeze({ type: "directory", absolute });
      if (stat.isFile()) return Object.freeze({ type: "file", size: stat.size });
      throw new Error("Extracted toolchain contains an unsupported filesystem entry.");
    });
    const nextFrontier:string[] = [];
    for (const item of inspected) {
      if (item.type === "directory") {
        nextFrontier.push(item.absolute);
      } else if (item.type === "file") {
        if (item.size > MAX_EXTRACTED_BYTES - totalBytes) throw new Error("Extracted toolchain exceeds the size limit.");
        totalBytes += item.size;
      }
    }
    frontier = nextFrontier;
  }
  return Object.freeze({ entryCount, totalBytes });
}

async function assertNormalFile(filePath:string, label:string, { executable = false, platform = process.platform, fsImpl = fs }:NormalFileOptions = {}) {
  const stat = await fsImpl.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a normal file.`);
  if (stat.size < 1) throw new Error(`${label} must not be empty.`);
  if (executable && platform !== "win32" && (stat.mode & 0o111) === 0) throw new Error(`${label} must be executable.`);
}

function componentStamp(component:ProvisionComponent) {
  return Object.freeze({
    schemaVersion: 1,
    component: component.component,
    version: component.version,
    target: component.target,
    artifact: Object.freeze({
      filename: component.distribution.filename,
      bytes: component.distribution.bytes,
      sha256: component.distribution.sha256,
    }),
  });
}

async function writeComponentStamp(root:string, component:ProvisionComponent, { fsImpl = fs }:FsOptions = {}) {
  const stampPath = path.join(root, COMPONENT_STAMP);
  await fsImpl.writeFile(stampPath, `${JSON.stringify(componentStamp(component))}\n`, { flag: "wx", mode: 0o600 });
}

async function validateComponentStamp(root:string, component:ProvisionComponent, { platform = process.platform, fsImpl = fs }:StampOptions = {}) {
  const stampPath = path.join(root, COMPONENT_STAMP);
  let data;
  try {
    ({ data } = await readBoundedNormalFile(stampPath, {
      fsImpl,
      platform,
      minBytes: 1,
      maxBytes: 4096,
      encoding: "utf8",
      label: "Toolchain component stamp",
    }));
  } catch {
    throw new Error("Toolchain component stamp is unsafe or invalid.");
  }
  let parsed:unknown;
  try { parsed = JSON.parse(data); } catch { throw new Error("Toolchain component stamp is invalid."); }
  if (JSON.stringify(parsed) !== JSON.stringify(componentStamp(component))) throw new Error("Toolchain component stamp does not match the pinned distribution.");
}

async function validateComponentIdentity(root:string, component:ProvisionComponent, contract:ProvisionContract, { platform, fsImpl = fs, execFileImpl = execFile }:RootOptions) {
  await validateExtractedTree(root, { platform, fsImpl });
  if (component.component === "git") {
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const gitPath = pathApi.join(root, platform === "win32" ? "cmd/git.exe" : "bin/git");
    await assertNormalFile(gitPath, "Product-owned Git", { executable: platform !== "win32", platform, fsImpl });
    if (platform === "darwin") {
      // A valid `git --version` cannot prove HTTPS works: pinned macOS Dugite
      // reports //libexec/git-core unless the product selects its helpers.
      // Verify both real helpers and templates on *every* install/reuse before
      // a user reaches Main enrollment or a detached update transaction.
      const helpers = path.join(root, "libexec", "git-core");
      const templates = path.join(root, "share", "git-core", "templates");
      for (const directory of [helpers, templates]) {
        const [info, real] = await Promise.all([fsImpl.lstat(directory), fsImpl.realpath(directory)]);
        if (!info.isDirectory() || info.isSymbolicLink() || real !== directory) {
          throw new Error("Product-owned macOS Git helpers or templates are unsafe.");
        }
      }
      const remoteHttps = path.join(helpers, "git-remote-https");
      const resolved = await fsImpl.realpath(remoteHttps);
      if (!resolved.startsWith(`${helpers}${path.sep}`)) {
        throw new Error("Product-owned macOS Git HTTPS helper escaped its pinned distribution.");
      }
      const helperStat = await fsImpl.stat(remoteHttps);
      if (!helperStat.isFile() || (helperStat.mode & 0o111) === 0) {
        throw new Error("Product-owned macOS Git HTTPS helper is missing or not executable.");
      }
    }
    if (platform === "win32") {
      const shellPath = pathApi.join(root, "usr", "bin", "sh.exe");
      await assertNormalFile(shellPath, "Product-owned POSIX shell", { platform, fsImpl });
    }
    const { stdout } = await execFileImpl(gitPath, ["--version"], { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true });
    const upstreamVersion = component.version.split("-")[0];
    if (!String(stdout ?? "").trim().startsWith(`git version ${upstreamVersion}`)) throw new Error("Product-owned Git version does not match its pinned distribution.");
  } else if (component.component === "node") {
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    const nodePath = pathApi.join(root, platform === "win32" ? "node.exe" : "bin/node");
    const npmPath = pathApi.join(root, ...(platform === "win32"
      ? ["node_modules", "npm", "bin", "npm-cli.js"]
      : ["lib", "node_modules", "npm", "bin", "npm-cli.js"]));
    const npxPath = pathApi.join(root, ...(platform === "win32"
      ? ["node_modules", "npm", "bin", "npx-cli.js"]
      : ["lib", "node_modules", "npm", "bin", "npx-cli.js"]));
    await assertNormalFile(nodePath, "Product-owned Node", { executable: platform !== "win32", platform, fsImpl });
    await assertNormalFile(npmPath, "Product-owned npm CLI", { fsImpl });
    await assertNormalFile(npxPath, "Product-owned npx CLI", { fsImpl });
    const { stdout } = await execFileImpl(nodePath, ["--version"], { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true });
    if (String(stdout ?? "").trim() !== `v${component.version}`) throw new Error("Product-owned Node version does not match its pinned distribution.");
  } else {
    throw new Error("Unsupported Equinox Local toolchain component.");
  }

  if (root === component.root) {
    await validateComponentStamp(root, component, { platform, fsImpl });
  }
}

async function defaultExtractComponent({ archivePath, extractionRoot, component, platform, env, execFileImpl, windowsZipHelperPath }:ExtractOptions) {
  if (component.distribution.filename.endsWith(".zip")) {
    if (platform !== "win32") throw new Error("ZIP toolchain extraction is only supported on Windows.");
    // Extract validates the bounded ZIP central directory before writing and then validates the extracted tree.
    // Avoid a redundant standalone Inspect pass on the same already hash-verified archive.
    await runWindowsZipHelper("Extract", archivePath, extractionRoot, component.archiveRoot, { env, execFileImpl, helperPath: windowsZipHelperPath });
    return;
  }
  if (!component.distribution.filename.endsWith(".tar.gz")) throw new Error("Unsupported toolchain archive type.");
  await inspectTarArchive(archivePath, component.archiveRoot, { platform, env, execFileImpl });
  await extractTarArchive(archivePath, extractionRoot, { platform, env, execFileImpl });
}

async function ensureNormalDirectory(directory:string, { fsImpl = fs, create = false }:DirOptions = {}) {
  if (create) {
    await fsImpl.mkdir(directory, { recursive: false, mode: 0o700 }).catch((error) => {
      if (!errorCode(error,"EEXIST")) throw error;
    });
  }
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Toolchain directory is unsafe: ${directory}`);
  return directory;
}

async function ensureNormalDirectoryChain(base:string, segments:string[], { fsImpl = fs, pathApi = path }:DirOptions = {}) {
  let current = base;
  await ensureNormalDirectory(current, { fsImpl });
  for (const segment of segments) {
    if (typeof segment !== "string" || !segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
      throw new Error("Toolchain directory segment is invalid.");
    }
    current = pathApi.join(current, segment);
    await ensureNormalDirectory(current, { fsImpl, create: true });
  }
  return current;
}

async function installComponent(component:ProvisionComponent, contract:ProvisionContract, {
  platform,
  env,
  fsImpl,
  execFileImpl,
  downloadImpl,
  extractComponentImpl,
  windowsZipHelperPath,
}:InstallOptions) {
  const existing = await fsImpl.lstat(component.root).catch((error) => errorCode(error,"ENOENT") ? null : Promise.reject(error));
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Existing ${component.component} toolchain path is unsafe.`);
    await validateComponentIdentity(component.root, component, contract, { platform, fsImpl, execFileImpl });
    return Object.freeze({ component: component.component, status: "reused", root: component.root });
  }

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const parent = await ensureNormalDirectoryChain(contract.toolchainRoot, [
    component.component,
    component.version,
  ], { fsImpl, pathApi });
  if (pathApi.dirname(component.root) !== parent) throw new Error("Toolchain component root does not match the admitted layout.");
  const transaction = pathApi.join(parent, `.install-${component.component}-${randomBytes(8).toString("hex")}`);
  const archivePath = pathApi.join(transaction, component.distribution.filename);
  const extractionRoot = pathApi.join(transaction, "extracted");
  await fsImpl.mkdir(transaction, { recursive: false, mode: 0o700 });
  try {
    await downloadImpl(component.distribution, archivePath);
    await extractComponentImpl({ archivePath, extractionRoot, component, contract, platform, env, execFileImpl, windowsZipHelperPath });
    const sourceRoot = component.archiveRoot === "." ? extractionRoot : pathApi.join(extractionRoot, component.archiveRoot);
    const sourceStat = await fsImpl.lstat(sourceRoot);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`${component.component} toolchain archive root is unsafe.`);
    await validateComponentIdentity(sourceRoot, component, contract, { platform, fsImpl, execFileImpl });
    await writeComponentStamp(sourceRoot, component, { fsImpl });
    await fsImpl.rename(sourceRoot, component.root);
    await validateComponentIdentity(component.root, component, contract, { platform, fsImpl, execFileImpl });
    return Object.freeze({ component: component.component, status: "installed", root: component.root });
  } finally {
    await fsImpl.rm(transaction, { recursive: true, force: true }).catch(() => {});
  }
}

export async function provisionEquinoxLocalToolchain({
  runtimeRoot,
  target,
  platform = process.platform,
  env = process.env,
  fsImpl = fs,
  execFileImpl = execFile,
  fetchImpl = globalThis.fetch,
  downloadImpl = null,
  extractComponentImpl = defaultExtractComponent,
  windowsZipHelperPath = WINDOWS_ZIP_HELPER_PATH,
}:ProvisionOptions) {
  const contract = equinoxLocalToolchainContract({ runtimeRoot, target: target! });
  if (contract.platform !== platform) throw new Error(`Toolchain target ${target} does not match host platform ${platform}.`);

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    if (typeof windowsZipHelperPath !== "string" || !path.win32.isAbsolute(windowsZipHelperPath) || path.win32.basename(windowsZipHelperPath) !== "equinox-local-windows-release-zip.ps1") {
      throw new Error("Windows toolchain ZIP helper path is invalid.");
    }
    await assertNormalFile(windowsZipHelperPath, "Windows toolchain ZIP helper", { platform, fsImpl });
  }
  const runtimeParent = pathApi.dirname(contract.runtimeRoot);
  await ensureNormalDirectory(runtimeParent, { fsImpl });
  await ensureNormalDirectory(contract.runtimeRoot, { fsImpl, create: true });
  if (pathApi.dirname(contract.toolchainRoot) !== contract.runtimeRoot) throw new Error("Toolchain root does not match the admitted runtime layout.");
  await ensureNormalDirectory(contract.toolchainRoot, { fsImpl, create: true });

  const verifiedDownload = downloadImpl ?? ((artifact, destinationPath) =>
    downloadVerifiedUpdateArtifact(artifact, destinationPath, {
      fetchImpl: toolchainFetchForArtifact(artifact, fetchImpl),
    }));

  const componentResults = await Promise.allSettled([
    installComponent(contract.git, contract, {
      platform, env, fsImpl, execFileImpl, downloadImpl: verifiedDownload, extractComponentImpl, windowsZipHelperPath,
    }),
    installComponent(contract.node, contract, {
      platform, env, fsImpl, execFileImpl, downloadImpl: verifiedDownload, extractComponentImpl, windowsZipHelperPath,
    }),
  ]);
  const failed = componentResults.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  const [git, node] = componentResults.map((result) => {
    if (result.status !== "fulfilled") throw result.reason;
    return result.value;
  });

  return Object.freeze({ contract, components: Object.freeze([git, node]) });
}
