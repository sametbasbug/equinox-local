import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { equinoxLocalManagedSourcePaths } from "./equinox-local-managed-source-installation.js";
import { readEquinoxLocalMainSourcePointer, writeEquinoxLocalMainSourcePointer } from "./equinox-local-main-source-pointer.js";
import {
  EQUINOX_LOCAL_MAIN_BRANCH,
  EQUINOX_LOCAL_MAIN_REMOTE,
  EQUINOX_LOCAL_MAIN_REPOSITORY,
  EQUINOX_LOCAL_MAIN_UPDATE_CHANNEL,
  EQUINOX_LOCAL_MAIN_UPDATE_SCHEMA_VERSION,
  inspectCanonicalMainCheckout,
  validateManagedSourceInstallStamp,
} from "./equinox-local-main-update.js";
import { equinoxLocalPlatformPaths } from "./equinox-local-platform.js";
import { inspectPrivateStatePath, protectWindowsPrivateStatePath, verifyWindowsPrivateStateAcl } from "./equinox-local-private-state.js";
import { equinoxLocalGitExecutionEnvironment, equinoxLocalToolchainContract } from "./equinox-local-toolchain-contract.js";
import { provisionEquinoxLocalToolchain } from "./equinox-local-toolchain-provisioner.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";

const execFile = promisify(execFileCallback);
type ManagedFs = typeof fs;
type ManagedExec = typeof execFile;
type ManagedEnv = NodeJS.ProcessEnv;
type Contract = ReturnType<typeof equinoxLocalToolchainContract>;
type Checkout = Awaited<ReturnType<typeof inspectCanonicalMainCheckout>>;
type ProtectAcl = typeof protectWindowsPrivateStatePath;
type VerifyAcl = typeof verifyWindowsPrivateStateAcl;
type ReadPointer = typeof readEquinoxLocalMainSourcePointer;
type WritePointer = typeof writeEquinoxLocalMainSourcePointer;
type FsOptions = {fsImpl?:ManagedFs};
type RunOptions = {cwd?:string;execFileImpl?:ManagedExec;env?:ManagedEnv;platform?:string;pathPrefix?:string|null};
type AclOptions = FsOptions & {platform?:string;env?:ManagedEnv;protectWindowsAcl?:ProtectAcl;verifyWindowsAcl?:VerifyAcl};
type DependencyOptions = FsOptions & {execFileImpl?:ManagedExec;env?:ManagedEnv;platform?:string};
type ToolPaths = {nodePath:string;npmPath:string;shellPath?:string|null};
type RollbackOptions = DependencyOptions & {bootstrapSha?:unknown;target?:string;arch?:string;homeDir?:string|undefined;readPointerImpl?:ReadPointer};
type EnrollOptions = DependencyOptions & {
  bootstrapSha?:unknown;target?:string;arch?:string;homeDir?:string|undefined;
  provisionToolchainImpl?:typeof provisionEquinoxLocalToolchain;
  installDependenciesImpl?:(root:string,contract:Contract,opts:DependencyOptions)=>Promise<unknown>;
  validateSourceImpl?:(root:string,contract:Contract,opts:DependencyOptions)=>Promise<unknown>;
  inspectCheckoutImpl?:typeof inspectCanonicalMainCheckout;
  readPointerImpl?:ReadPointer;writePointerImpl?:WritePointer;randomBytesImpl?:typeof randomBytes;
  mainRemote?:string;windowsZipHelperPath?:string|undefined;
  windowsPrivateStateHelperPath?:string|undefined;stableReleaseDir?:string|undefined;
  protectWindowsAcl?:ProtectAcl;verifyWindowsAcl?:VerifyAcl;
};
function hasErrorCode(error:unknown,code:string):boolean {return !!error && typeof error==="object" && "code" in error && error.code===code;}
function executionOutput(error:unknown):{stdout?:unknown;stderr?:unknown}{return !!error && typeof error==="object" ? error as {stdout?:unknown;stderr?:unknown}:{};}

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STAMP_BYTES = 8 * 1024;

export function managedSourceCommandEnvironment(baseEnv:ManagedEnv = process.env, platform:string = process.platform, pathPrefix:string|null = null) {
  const safe:Record<string,string> = {};
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SystemRoot", "SYSTEMROOT", "WINDIR"]) {
    const value = baseEnv?.[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 10_000) safe[key] = value;
  }
  const systemRoot = safe.SystemRoot || safe.SYSTEMROOT || safe.WINDIR || "C:\\Windows";
  const systemPath = platform === "win32"
    ? [path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"), path.win32.join(systemRoot, "System32"), systemRoot].join(";")
    : "/usr/bin:/bin:/usr/sbin:/sbin";
  const delimiter = platform === "win32" ? ";" : ":";
  const managedPrefix = typeof pathPrefix === "string" && pathPrefix.length > 0 ? `${pathPrefix}${delimiter}` : "";
  return Object.freeze({
    ...safe,
    PATH: `${managedPrefix}${systemPath}`,
    CI: "1",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  });
}

function assertSha(value:unknown):string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) throw new Error("Managed-source bootstrap SHA must be an exact lowercase 40-character Git SHA.");
  return value;
}

async function normalDirectory(directory:string, { fsImpl = fs, create = false }:FsOptions & {create?:boolean} = {}) {
  if (create) await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const [stat, real] = await Promise.all([fsImpl.lstat(directory), fsImpl.realpath(directory)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== directory) throw new Error(`Managed-source enrollment directory is unsafe: ${directory}`);
  return directory;
}

function boundedCommandDiagnostic(value:unknown, maximum = 1_200):string {
  return String(value ?? "")
    .replace(/[\r\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-maximum);
}

async function run(command:string,args:string[],{ cwd, execFileImpl = execFile, env = process.env, platform = process.platform, pathPrefix = null }:RunOptions = {}) {
  try {
    return await execFileImpl(command, args, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: equinoxLocalGitExecutionEnvironment(command, managedSourceCommandEnvironment(env, platform, pathPrefix), { platform }) as NodeJS.ProcessEnv,
    });
  } catch (error) {
    const message = boundedCommandDiagnostic(error instanceof Error ? error.message : error, 1_200) || "Managed-source command failed.";
    const stdout = boundedCommandDiagnostic(executionOutput(error).stdout);
    const stderr = boundedCommandDiagnostic(executionOutput(error).stderr);
    const detail = [stdout ? `stdout: ${stdout}` : null, stderr ? `stderr: ${stderr}` : null].filter(Boolean).join(" ");
    throw new Error(detail ? `${message} ${detail}` : message, { cause: error });
  }
}

export async function ensureManagedSourcePrivateDirectory(directory:string, {
  platform = process.platform,
  fsImpl = fs,
  env = process.env,
  protectWindowsAcl = protectWindowsPrivateStatePath,
  verifyWindowsAcl = verifyWindowsPrivateStateAcl,
}:AclOptions = {}) {
  if (platform !== "win32") return normalDirectory(directory, { fsImpl, create: true });
  const before = await inspectPrivateStatePath(directory, { platform, type: "directory", fsImpl, verifyWindowsAcl });
  if (before.exists) {
    if (!before.safe) throw new Error("Managed-source state directory is not private.");
    return directory;
  }
  const created = await fsImpl.mkdir(directory, { recursive: true });
  if (created === undefined) {
    const raced = await inspectPrivateStatePath(directory, { platform, type: "directory", fsImpl, verifyWindowsAcl });
    if (!raced.exists || !raced.safe) throw new Error("Managed-source state directory is not private.");
    return directory;
  }
  await protectWindowsAcl({ target: directory, type: "directory", env });
  const secured = await inspectPrivateStatePath(directory, { platform, type: "directory", fsImpl, verifyWindowsAcl });
  if (!secured.exists || !secured.safe) throw new Error("Managed-source state directory protection did not verify.");
  return directory;
}

export async function writeManagedSourceInstallStamp(filePath:string, bootstrapSha:unknown, {
  fsImpl = fs,
  randomBytesImpl = randomBytes,
  platform = process.platform,
  env = process.env,
  protectWindowsAcl = protectWindowsPrivateStatePath,
  verifyWindowsAcl = verifyWindowsPrivateStateAcl,
}:AclOptions & {randomBytesImpl?:typeof randomBytes} = {}) {
  const stamp = validateManagedSourceInstallStamp({
    schemaVersion: EQUINOX_LOCAL_MAIN_UPDATE_SCHEMA_VERSION,
    channel: EQUINOX_LOCAL_MAIN_UPDATE_CHANNEL,
    repository: EQUINOX_LOCAL_MAIN_REPOSITORY,
    branch: EQUINOX_LOCAL_MAIN_BRANCH,
    bootstrapSha,
  });
  const parent = path.dirname(filePath);
  await normalDirectory(parent, { fsImpl });
  const temporary = path.join(parent, `.install-${randomBytesImpl(8).toString("hex")}.tmp`);
  const handle = await fsImpl.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(stamp, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (platform === "win32") {
      await protectWindowsAcl({ target: temporary, type: "file", env });
      const temporarySecurity = await inspectPrivateStatePath(temporary, { platform, type: "file", fsImpl, verifyWindowsAcl });
      if (!temporarySecurity.exists || !temporarySecurity.safe) throw new Error("Managed-source install stamp protection did not verify.");
    }
    await fsImpl.rename(temporary, filePath);
    if (platform === "win32") {
      const finalSecurity = await inspectPrivateStatePath(filePath, { platform, type: "file", fsImpl, verifyWindowsAcl });
      if (!finalSecurity.exists || !finalSecurity.safe) throw new Error("Managed-source install stamp protection changed during publish.");
    }
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return stamp;
}

async function readExistingStamp(filePath:string, { fsImpl = fs }:FsOptions = {}) {
  try {
    const { data } = await readBoundedNormalFile(filePath, {
      fsImpl,
      minBytes: 2,
      maxBytes: MAX_STAMP_BYTES,
      encoding: "utf8",
      label: "Managed-source install stamp",
    });
    return validateManagedSourceInstallStamp(JSON.parse(data));
  } catch (error) {
    if (hasErrorCode(error,"ENOENT")) return null;
    throw error;
  }
}

export async function seedPrebuiltDependenciesFromStableRelease(sourceRoot:string, releaseDir:string, { fsImpl = fs }:FsOptions = {}) {
  if (typeof releaseDir !== "string" || !path.isAbsolute(releaseDir)) throw new Error("Managed-source Stable seed release path is invalid.");
  const sourcePackage = await fsImpl.readFile(path.join(sourceRoot, "package.json"));
  const sourceLock = await fsImpl.readFile(path.join(sourceRoot, "package-lock.json"));
  const releasePackage = await fsImpl.readFile(path.join(releaseDir, "package.json"));
  const releaseLock = await fsImpl.readFile(path.join(releaseDir, "package-lock.json"));
  if (!sourcePackage.equals(releasePackage) || !sourceLock.equals(releaseLock)) throw new Error("Managed-source Stable dependency seed does not match the exact source package identity.");
  const sourceModules = path.join(releaseDir, "node_modules");
  const destinationModules = path.join(sourceRoot, "node_modules");
  const sourceStat = await fsImpl.lstat(sourceModules);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Managed-source Stable dependency seed is unavailable or unsafe.");
  await fsImpl.mkdir(destinationModules, { recursive: false });
  const stack:[string,string][] = [[sourceModules, destinationModules]];
  while (stack.length > 0) {
    const [from, to] = stack.pop()!;
    const copies:Promise<void>[] = [];
    for (const entry of await fsImpl.readdir(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const destination = path.join(to, entry.name);
      const stat = await fsImpl.lstat(source);
      if (stat.isSymbolicLink()) throw new Error("Managed-source Stable dependency seed contains a symbolic link.");
      if (stat.isDirectory()) {
        await fsImpl.mkdir(destination, { recursive: false });
        stack.push([source, destination]);
      } else if (stat.isFile()) {
        copies.push(fsImpl.copyFile(source, destination));
        if (copies.length >= 16) {
          await Promise.all(copies.splice(0));
        }
      } else {
        throw new Error("Managed-source Stable dependency seed contains an unsupported filesystem entry.");
      }
    }
    await Promise.all(copies);
  }
}

export async function installPrebuiltDependencies(sourceRoot:string, contract:ToolPaths, { execFileImpl = execFile, fsImpl = fs, env = process.env, platform = process.platform }:DependencyOptions = {}) {
  // Main executes verified committed JavaScript; development-only TypeScript
  // compilers/types belong to CI, never the installed runtime. Keep package
  // and lock bytes unchanged for exact-source Stable seed admission.
  await run(contract.nodePath, [contract.npmPath, "ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], { cwd: sourceRoot, execFileImpl, env, platform, pathPrefix: path.dirname(contract.nodePath) });
  const nodePtyRoot = path.join(sourceRoot, "node_modules", "node-pty");
  const prebuildCheck = path.join(nodePtyRoot, "scripts", "prebuild.js");
  const postInstall = path.join(nodePtyRoot, "scripts", "post-install.js");
  for (const script of [prebuildCheck, postInstall]) {
    const stat = await fsImpl.lstat(script);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Managed-source node-pty lifecycle script is missing or unsafe.");
  }
  await run(contract.nodePath, [prebuildCheck], { cwd: nodePtyRoot, execFileImpl, env, platform, pathPrefix: path.dirname(contract.nodePath) });
  await run(contract.nodePath, [postInstall], { cwd: nodePtyRoot, execFileImpl, env, platform, pathPrefix: path.dirname(contract.nodePath) });
}

export async function validateManagedSource(sourceRoot:string, contract:ToolPaths, { execFileImpl = execFile, env = process.env, platform = process.platform }:DependencyOptions = {}) {
  let checkPromise;
  if (platform === "win32") {
    if (typeof contract.shellPath !== "string" || !path.win32.isAbsolute(contract.shellPath)) {
      throw new Error("Managed-source Windows validation requires the product-owned POSIX shell.");
    }
    checkPromise = run(contract.nodePath, [path.join(sourceRoot, "scripts", "check.mjs"), `--shell-command=${contract.shellPath}`], {
      cwd: sourceRoot, execFileImpl, env, platform, pathPrefix: path.dirname(contract.nodePath),
    });
  } else {
    checkPromise = run(contract.nodePath, [contract.npmPath, "run", "check"], { cwd: sourceRoot, execFileImpl, env, platform, pathPrefix: path.dirname(contract.nodePath) });
  }
  const updaterTestPromise = run(contract.nodePath, ["--test", "tests/release/equinox-local-main-update.test.js"], {
    cwd: sourceRoot, execFileImpl, env, platform, pathPrefix: path.dirname(contract.nodePath),
  });
  await Promise.all([checkPromise, updaterTestPromise]);
}


export async function rollbackEquinoxLocalManagedSourceEnrollment({
  bootstrapSha,
  target,
  platform = process.platform,
  arch = process.arch,
  homeDir,
  env = process.env,
  fsImpl = fs,
  execFileImpl = execFile,
  readPointerImpl = readEquinoxLocalMainSourcePointer,
}:RollbackOptions = {}) {
  const sha = assertSha(bootstrapSha);
  const layout = equinoxLocalPlatformPaths({ platform, arch, ...(homeDir === undefined ? {} : {homeDir}), env });
  if (target !== layout.host.target) throw new Error("Managed-source enrollment rollback target does not match the host target.");
  const paths = equinoxLocalManagedSourcePaths({ platform, arch, ...(homeDir === undefined ? {} : {homeDir}), env });
  const stamp = await readExistingStamp(paths.installStampPath, { fsImpl });
  if (stamp && stamp.bootstrapSha !== sha) throw new Error("Managed-source enrollment rollback bootstrap identity mismatch.");
  const pointerStat = await fsImpl.lstat(paths.sourcePointerPath).catch((error) => {
    if (hasErrorCode(error,"ENOENT")) return null;
    throw error;
  });
  if (!pointerStat && !stamp) return Object.freeze({ rolledBack: false, reason: "not-enrolled" });
  if (!pointerStat?.isFile() || pointerStat.isSymbolicLink()) {
    throw new Error("Managed-source enrollment rollback source pointer is missing or unsafe.");
  }
  const contract = equinoxLocalToolchainContract({ runtimeRoot: layout.runtimeRoot, target });
  const pointer = await readPointerImpl(paths.sourcePointerPath, { fsImpl, execFileImpl, gitPath: contract.gitPath });
  const expectedRoot = path.join(paths.mainTransactionRoot, "sources", sha);
  if (pointer.sha !== sha || pointer.sourceRoot !== expectedRoot) throw new Error("Managed-source enrollment rollback source identity mismatch.");
  // Enrollment commits its install.json LAST. If writing that final stamp
  // failed after publishing the trusted source pointer, safely remove ONLY
  // this exact owned pointer. Never remove reusable source files or secrets.
  const candidates = stamp ? [paths.installStampPath, paths.sourcePointerPath] : [paths.sourcePointerPath];
  for (const candidate of candidates) {
    const stat = await fsImpl.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Managed-source enrollment rollback state file is unsafe.");
    await fsImpl.rm(candidate, { force: false });
  }
  return Object.freeze({ rolledBack: true, bootstrapSha: sha, partial: !stamp });
}

export async function enrollEquinoxLocalManagedSource({
  bootstrapSha,
  target,
  platform = process.platform,
  arch = process.arch,
  homeDir,
  env = process.env,
  fsImpl = fs,
  execFileImpl = execFile,
  provisionToolchainImpl = provisionEquinoxLocalToolchain,
  installDependenciesImpl = installPrebuiltDependencies,
  validateSourceImpl = validateManagedSource,
  inspectCheckoutImpl = inspectCanonicalMainCheckout,
  readPointerImpl = readEquinoxLocalMainSourcePointer,
  writePointerImpl = writeEquinoxLocalMainSourcePointer,
  randomBytesImpl = randomBytes,
  mainRemote = EQUINOX_LOCAL_MAIN_REMOTE,
  windowsZipHelperPath = undefined,
  windowsPrivateStateHelperPath = undefined,
  stableReleaseDir = undefined,
  protectWindowsAcl = protectWindowsPrivateStatePath,
  verifyWindowsAcl = verifyWindowsPrivateStateAcl,
}:EnrollOptions = {}) {
  const sha = assertSha(bootstrapSha);
  const layout = equinoxLocalPlatformPaths({ platform, arch, ...(homeDir === undefined ? {} : {homeDir}), env });
  if (target !== layout.host.target) throw new Error("Managed-source enrollment target does not match the host target.");
  const paths = equinoxLocalManagedSourcePaths({ platform, arch, ...(homeDir === undefined ? {} : {homeDir}), env });
  const enrollmentProtectWindowsAcl = platform === "win32" && windowsPrivateStateHelperPath
    ? (input?: Parameters<ProtectAcl>[0]) => protectWindowsAcl({ ...input, env, helperPath: windowsPrivateStateHelperPath })
    : protectWindowsAcl;
  const enrollmentVerifyWindowsAcl = platform === "win32" && windowsPrivateStateHelperPath
    ? (input?: Parameters<VerifyAcl>[0]) => verifyWindowsAcl({ ...input, env, helperPath: windowsPrivateStateHelperPath })
    : verifyWindowsAcl;
  await normalDirectory(layout.appDataRoot, { fsImpl });
  await ensureManagedSourcePrivateDirectory(paths.mainTransactionRoot, {
    platform, fsImpl, env, protectWindowsAcl: enrollmentProtectWindowsAcl, verifyWindowsAcl: enrollmentVerifyWindowsAcl,
  });

  const provisioned = await provisionToolchainImpl({ runtimeRoot: layout.runtimeRoot, target, platform, env, fsImpl, execFileImpl, windowsZipHelperPath });
  const contract = provisioned?.contract;
  if (!contract || contract.target !== target || contract.runtimeRoot !== layout.runtimeRoot || contract.ambientPathDiscovery !== false) {
    throw new Error("Managed-source enrollment toolchain identity is invalid.");
  }

  const existingStamp = await readExistingStamp(paths.installStampPath, { fsImpl });
  if (existingStamp) {
    if (existingStamp.bootstrapSha !== sha) throw new Error("Existing managed-source bootstrap identity does not match this Stable artifact.");
    const existing = await readPointerImpl(paths.sourcePointerPath, { fsImpl, execFileImpl, gitPath: contract.gitPath });
    const expectedRoot = path.join(paths.mainTransactionRoot, "sources", sha);
    if (existing.sha !== sha || existing.sourceRoot !== expectedRoot) throw new Error("Existing managed-source source pointer does not match its bootstrap identity.");
    return Object.freeze({ status: "already-enrolled", bootstrapSha: sha, sourceRoot: existing.sourceRoot, contract });
  }

  const sourcesRoot = path.join(paths.mainTransactionRoot, "sources");
  const enrollmentRoot = path.join(paths.mainTransactionRoot, "enrollment-staging");
  await normalDirectory(sourcesRoot, { fsImpl, create: true });
  await normalDirectory(enrollmentRoot, { fsImpl, create: true });
  const transactionRoot = path.join(enrollmentRoot, `bootstrap-${randomBytesImpl(8).toString("hex")}`);
  const stagedSourceRoot = path.join(transactionRoot, "source");
  const durableSourceRoot = path.join(sourcesRoot, sha);
  await fsImpl.mkdir(transactionRoot, { recursive: false, mode: 0o700 });

  try {
    let durable:Checkout|null = null;
    try {
      durable = await inspectCheckoutImpl(durableSourceRoot, { fsImpl, execFileImpl, gitPath: contract.gitPath });
    } catch (error) {
      if (!hasErrorCode(error,"ENOENT")) throw error;
    }
    if (!durable?.eligible || durable.currentSha !== sha) {
      if (durable) throw new Error("Existing managed-source bootstrap checkout is invalid.");
      if (typeof mainRemote !== "string" || mainRemote.length < 1) throw new Error("Managed-source canonical remote is unavailable.");
      await run(contract.gitPath, ["clone", "--no-checkout", "--filter=blob:none", "--single-branch", "--branch", EQUINOX_LOCAL_MAIN_BRANCH, mainRemote, stagedSourceRoot], { execFileImpl, env, platform });
      await run(contract.gitPath, ["-C", stagedSourceRoot, "checkout", "--force", "-B", EQUINOX_LOCAL_MAIN_BRANCH, sha], { execFileImpl, env, platform });
      await run(contract.gitPath, ["-C", stagedSourceRoot, "remote", "set-url", "origin", EQUINOX_LOCAL_MAIN_REMOTE], { execFileImpl, env, platform });
      const staged = await inspectCheckoutImpl(stagedSourceRoot, { fsImpl, execFileImpl, gitPath: contract.gitPath });
      if (!staged?.eligible || staged.currentSha !== sha) throw new Error("Managed-source bootstrap checkout does not match the Stable source SHA.");
      if (platform === "win32" && stableReleaseDir) {
        await seedPrebuiltDependenciesFromStableRelease(stagedSourceRoot, stableReleaseDir, { fsImpl });
      } else {
        await installDependenciesImpl(stagedSourceRoot, contract, { execFileImpl, fsImpl, env, platform });
      }
      await validateSourceImpl(stagedSourceRoot, contract, { execFileImpl, fsImpl, env, platform });
      const validated = await inspectCheckoutImpl(stagedSourceRoot, { fsImpl, execFileImpl, gitPath: contract.gitPath });
      if (!validated?.eligible || validated.currentSha !== sha) throw new Error("Managed-source bootstrap checkout changed during validation.");
      await fsImpl.rename(stagedSourceRoot, durableSourceRoot);
    }

    const durableFinal = await inspectCheckoutImpl(durableSourceRoot, { fsImpl, execFileImpl, gitPath: contract.gitPath });
    if (!durableFinal?.eligible || durableFinal.currentSha !== sha) throw new Error("Durable managed-source bootstrap checkout identity is invalid.");
    const pointer = await writePointerImpl(paths.sourcePointerPath, { sourceRoot: durableSourceRoot, sha }, {
      fsImpl, execFileImpl, gitPath: contract.gitPath, randomBytesImpl,
      platform, env, protectWindowsAcl: enrollmentProtectWindowsAcl, verifyWindowsAcl: enrollmentVerifyWindowsAcl,
    });
    await writeManagedSourceInstallStamp(paths.installStampPath, sha, {
      fsImpl, randomBytesImpl, platform, env,
      protectWindowsAcl: enrollmentProtectWindowsAcl, verifyWindowsAcl: enrollmentVerifyWindowsAcl,
    });
    return Object.freeze({ status: "enrolled", bootstrapSha: sha, sourceRoot: pointer.sourceRoot, contract });
  } finally {
    await fsImpl.rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
  }
}
