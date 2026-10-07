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
import { equinoxLocalToolchainContract } from "./equinox-local-toolchain-contract.js";
import { provisionEquinoxLocalToolchain } from "./equinox-local-toolchain-provisioner.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";

const execFile = promisify(execFileCallback);
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STAMP_BYTES = 8 * 1024;

export function managedSourceCommandEnvironment(baseEnv = process.env, platform = process.platform) {
  const safe = {};
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "SystemRoot", "SYSTEMROOT", "WINDIR"]) {
    const value = baseEnv?.[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 10_000) safe[key] = value;
  }
  const systemRoot = safe.SystemRoot || safe.SYSTEMROOT || safe.WINDIR || "C:\\Windows";
  return Object.freeze({
    ...safe,
    PATH: platform === "win32"
      ? [path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"), path.win32.join(systemRoot, "System32"), systemRoot].join(";")
      : "/usr/bin:/bin:/usr/sbin:/sbin",
    CI: "1",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_build_from_source: "false",
  });
}

function assertSha(value) {
  if (!SHA_PATTERN.test(value ?? "")) throw new Error("Managed-source bootstrap SHA must be an exact lowercase 40-character Git SHA.");
  return value;
}

async function normalDirectory(directory, { fsImpl = fs, create = false } = {}) {
  if (create) await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const [stat, real] = await Promise.all([fsImpl.lstat(directory), fsImpl.realpath(directory)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== directory) throw new Error(`Managed-source enrollment directory is unsafe: ${directory}`);
  return directory;
}

async function run(command, args, { cwd, execFileImpl = execFile, env = process.env, platform = process.platform } = {}) {
  return await execFileImpl(command, args, {
    cwd,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    env: managedSourceCommandEnvironment(env, platform),
  });
}

async function atomicInstallStamp(filePath, bootstrapSha, { fsImpl = fs, randomBytesImpl = randomBytes } = {}) {
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
    await fsImpl.rename(temporary, filePath);
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return stamp;
}

async function readExistingStamp(filePath, { fsImpl = fs } = {}) {
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
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function installPrebuiltDependencies(sourceRoot, contract, { execFileImpl = execFile, fsImpl = fs, env = process.env, platform = process.platform } = {}) {
  await run(contract.nodePath, [contract.npmPath, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: sourceRoot, execFileImpl, env, platform });
  const nodePtyRoot = path.join(sourceRoot, "node_modules", "node-pty");
  const prebuildCheck = path.join(nodePtyRoot, "scripts", "prebuild.js");
  const postInstall = path.join(nodePtyRoot, "scripts", "post-install.js");
  for (const script of [prebuildCheck, postInstall]) {
    const stat = await fsImpl.lstat(script);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Managed-source node-pty lifecycle script is missing or unsafe.");
  }
  await run(contract.nodePath, [prebuildCheck], { cwd: nodePtyRoot, execFileImpl, env, platform });
  await run(contract.nodePath, [postInstall], { cwd: nodePtyRoot, execFileImpl, env, platform });
}

export async function validateManagedSource(sourceRoot, contract, { execFileImpl = execFile, env = process.env, platform = process.platform } = {}) {
  await run(contract.nodePath, [contract.npmPath, "run", "check"], { cwd: sourceRoot, execFileImpl, env, platform });
  await run(contract.nodePath, ["--test", "tests/release/equinox-local-main-update.test.js"], { cwd: sourceRoot, execFileImpl, env, platform });
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
} = {}) {
  const sha = assertSha(bootstrapSha);
  const layout = equinoxLocalPlatformPaths({ platform, arch, homeDir, env });
  if (target !== layout.host.target) throw new Error("Managed-source enrollment rollback target does not match the host target.");
  const paths = equinoxLocalManagedSourcePaths({ platform, arch, homeDir, env });
  const stamp = await readExistingStamp(paths.installStampPath, { fsImpl });
  if (!stamp) return Object.freeze({ rolledBack: false, reason: "not-enrolled" });
  if (stamp.bootstrapSha !== sha) throw new Error("Managed-source enrollment rollback bootstrap identity mismatch.");
  const contract = equinoxLocalToolchainContract({ runtimeRoot: layout.runtimeRoot, target });
  const pointer = await readPointerImpl(paths.sourcePointerPath, { fsImpl, execFileImpl, gitPath: contract.gitPath });
  const expectedRoot = path.join(paths.mainTransactionRoot, "sources", sha);
  if (pointer.sha !== sha || pointer.sourceRoot !== expectedRoot) throw new Error("Managed-source enrollment rollback source identity mismatch.");
  for (const candidate of [paths.installStampPath, paths.sourcePointerPath]) {
    const stat = await fsImpl.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Managed-source enrollment rollback state file is unsafe.");
    await fsImpl.rm(candidate, { force: false });
  }
  return Object.freeze({ rolledBack: true, bootstrapSha: sha });
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
} = {}) {
  const sha = assertSha(bootstrapSha);
  const layout = equinoxLocalPlatformPaths({ platform, arch, homeDir, env });
  if (target !== layout.host.target) throw new Error("Managed-source enrollment target does not match the host target.");
  const paths = equinoxLocalManagedSourcePaths({ platform, arch, homeDir, env });
  await normalDirectory(layout.appDataRoot, { fsImpl });
  await normalDirectory(paths.mainTransactionRoot, { fsImpl, create: true });

  const provisioned = await provisionToolchainImpl({ runtimeRoot: layout.runtimeRoot, target, platform, env, fsImpl, execFileImpl });
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
    let durable = null;
    try {
      durable = await inspectCheckoutImpl(durableSourceRoot, { fsImpl, execFileImpl, gitPath: contract.gitPath });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!durable?.eligible || durable.currentSha !== sha) {
      if (durable) throw new Error("Existing managed-source bootstrap checkout is invalid.");
      await run(contract.gitPath, ["clone", "--no-checkout", "--filter=blob:none", "--single-branch", "--branch", EQUINOX_LOCAL_MAIN_BRANCH, EQUINOX_LOCAL_MAIN_REMOTE, stagedSourceRoot], { execFileImpl, env, platform });
      await run(contract.gitPath, ["-C", stagedSourceRoot, "checkout", "--force", "-B", EQUINOX_LOCAL_MAIN_BRANCH, sha], { execFileImpl, env, platform });
      const staged = await inspectCheckoutImpl(stagedSourceRoot, { fsImpl, execFileImpl, gitPath: contract.gitPath });
      if (!staged?.eligible || staged.currentSha !== sha) throw new Error("Managed-source bootstrap checkout does not match the Stable source SHA.");
      await installDependenciesImpl(stagedSourceRoot, contract, { execFileImpl, fsImpl, env, platform });
      await validateSourceImpl(stagedSourceRoot, contract, { execFileImpl, fsImpl, env, platform });
      const validated = await inspectCheckoutImpl(stagedSourceRoot, { fsImpl, execFileImpl, gitPath: contract.gitPath });
      if (!validated?.eligible || validated.currentSha !== sha) throw new Error("Managed-source bootstrap checkout changed during validation.");
      await fsImpl.rename(stagedSourceRoot, durableSourceRoot);
    }

    const durableFinal = await inspectCheckoutImpl(durableSourceRoot, { fsImpl, execFileImpl, gitPath: contract.gitPath });
    if (!durableFinal?.eligible || durableFinal.currentSha !== sha) throw new Error("Durable managed-source bootstrap checkout identity is invalid.");
    const pointer = await writePointerImpl(paths.sourcePointerPath, { sourceRoot: durableSourceRoot, sha }, {
      fsImpl, execFileImpl, gitPath: contract.gitPath, randomBytesImpl,
    });
    await atomicInstallStamp(paths.installStampPath, sha, { fsImpl, randomBytesImpl });
    return Object.freeze({ status: "enrolled", bootstrapSha: sha, sourceRoot: pointer.sourceRoot, contract });
  } finally {
    await fsImpl.rm(transactionRoot, { recursive: true, force: true }).catch(() => {});
  }
}
