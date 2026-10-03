import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { prepareManagedEquinoxRelease } from "../../src/equinox-local-release-manager.js";
import {
  equinoxLocalReleaseArtifactName,
  EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS,
} from "../../src/equinox-local-platform.js";
import { readBoundedNormalFile } from "../../src/equinox-local-safe-file.js";
import { activatePreparedEquinoxRelease, readManagedCurrentRelease } from "../../src/equinox-local-update-activation.js";
import { EQUINOX_LOCAL_UPDATE_KEYS } from "../../src/equinox-local-update-keys.js";
import {
  compareEquinoxVersions,
  createEquinoxLocalUpdater,
  equinoxLocalUpdateManifestUrl,
  parseEquinoxVersion,
  validateSignedUpdateManifest,
} from "../../src/equinox-local-updater.js";
import { EQUINOX_LOCAL_VERSION } from "../../src/equinox-local-version.js";

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CANONICAL_ORIGIN = "sametbasbug/equinox-local";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_GIT_OUTPUT = 1024 * 1024;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const DARWIN_TARGET_PATTERN = /^darwin-(arm64|x64)$/u;

function canonicalRemote(value) {
  const remote = String(value ?? "").trim().replace(/\.git$/u, "");
  if (remote === `https://github.com/${CANONICAL_ORIGIN}`) return true;
  if (remote === `git@github.com:${CANONICAL_ORIGIN}`) return true;
  if (remote === `ssh://git@github.com/${CANONICAL_ORIGIN}`) return true;
  return false;
}

async function gitText(args, { rootDir = ROOT, execFileImpl = execFile } = {}) {
  const { stdout = "" } = await execFileImpl("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: MAX_GIT_OUTPUT,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
      LC_ALL: "C",
    },
  });
  return String(stdout).trim();
}

export async function assertReleaseBehaviorCheckout({
  expectedSha,
  rootDir = ROOT,
  execFileImpl = execFile,
  fsImpl = fs,
} = {}) {
  if (!SHA_PATTERN.test(expectedSha ?? "")) throw new Error("Expected source SHA must be an exact 40-character Git SHA.");
  const expectedRoot = await fsImpl.realpath(path.resolve(rootDir));
  const topLevel = await gitText(["rev-parse", "--show-toplevel"], { rootDir, execFileImpl });
  const actualRoot = await fsImpl.realpath(topLevel);
  if (actualRoot !== expectedRoot) throw new Error("Release behavior CLI is not running from its canonical Git worktree root.");
  const origin = await gitText(["remote", "get-url", "origin"], { rootDir, execFileImpl });
  if (!canonicalRemote(origin)) throw new Error("Release behavior CLI checkout origin is not canonical Equinox Local.");
  const status = await gitText(["status", "--porcelain=v1", "--untracked-files=all"], { rootDir, execFileImpl });
  if (status) throw new Error("Release behavior CLI checkout must be clean.");
  const sourceSha = await gitText(["rev-parse", "HEAD"], { rootDir, execFileImpl });
  if (sourceSha !== expectedSha) throw new Error(`Release behavior CLI checkout SHA mismatch: ${sourceSha || "unknown"}.`);
  return Object.freeze({ rootDir: expectedRoot, sourceSha, origin: CANONICAL_ORIGIN });
}

function parsePairs(argv) {
  if (argv.length % 2 !== 0) throw new Error("Release behavior CLI expects --flag value pairs.");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value) throw new Error("Release behavior CLI expects non-empty --flag value pairs.");
    const key = flag.slice(2);
    if (Object.hasOwn(values, key)) throw new Error(`Duplicate release behavior argument: --${key}`);
    values[key] = value;
  }
  return values;
}

function exactKeys(values, allowed, required) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(values)) if (!allowedSet.has(key)) throw new Error(`Unsupported release behavior argument: --${key}`);
  for (const key of required) if (!values[key]) throw new Error(`Missing release behavior argument: --${key}`);
}

function normalizeAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return path.resolve(value);
}

function normalizeHttps(value, label) {
  if (typeof value !== "string" || value.length > 2048) throw new Error(`${label} is invalid.`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${label} must be a clean HTTPS URL.`);
  return url.toString();
}

export function parseReleaseBehaviorCli(argv) {
  const [operation, ...rest] = argv;
  const allowedOperations = new Set([
    "describe",
    "managed-upgrade-smoke",
    "validate-signed-release",
    "verify-live-release",
  ]);
  if (!allowedOperations.has(operation)) {
    throw new Error("Unsupported release behavior operation.");
  }
  const values = parsePairs(rest);
  if (operation === "describe") {
    exactKeys(values, ["expected-sha"], ["expected-sha"]);
    if (!SHA_PATTERN.test(values["expected-sha"])) throw new Error("Expected source SHA must be an exact 40-character Git SHA.");
    return Object.freeze({ operation, expectedSha: values["expected-sha"] });
  }
  if (operation === "validate-signed-release") {
    exactKeys(values, ["expected-sha", "version", "signed-dir"], ["expected-sha", "version", "signed-dir"]);
    if (!SHA_PATTERN.test(values["expected-sha"])) throw new Error("Expected source SHA must be an exact 40-character Git SHA.");
    const version = parseEquinoxVersion(values.version).text;
    if (version !== EQUINOX_LOCAL_VERSION) throw new Error(`Release behavior version must match canonical source version ${EQUINOX_LOCAL_VERSION}.`);
    return Object.freeze({
      operation,
      expectedSha: values["expected-sha"],
      version,
      signedDir: normalizeAbsolute(values["signed-dir"], "Signed release directory"),
    });
  }
  if (operation === "verify-live-release") {
    exactKeys(values, ["expected-sha", "version"], ["expected-sha", "version"]);
    if (!SHA_PATTERN.test(values["expected-sha"])) throw new Error("Expected source SHA must be an exact 40-character Git SHA.");
    const version = parseEquinoxVersion(values.version).text;
    if (version !== EQUINOX_LOCAL_VERSION) throw new Error(`Release behavior version must match canonical source version ${EQUINOX_LOCAL_VERSION}.`);
    return Object.freeze({ operation, expectedSha: values["expected-sha"], version });
  }
  exactKeys(values, [
    "expected-sha",
    "previous-version",
    "version",
    "target",
    "previous-url",
    "previous-sha256",
    "previous-bytes",
    "candidate-manifest",
    "candidate-artifact",
  ], [
    "expected-sha",
    "previous-version",
    "version",
    "target",
    "previous-url",
    "previous-sha256",
    "previous-bytes",
    "candidate-manifest",
  ]);
  if (!SHA_PATTERN.test(values["expected-sha"])) throw new Error("Expected source SHA must be an exact 40-character Git SHA.");
  const previousVersion = parseEquinoxVersion(values["previous-version"]).text;
  const version = parseEquinoxVersion(values.version).text;
  if (version !== EQUINOX_LOCAL_VERSION) throw new Error(`Release behavior version must match canonical source version ${EQUINOX_LOCAL_VERSION}.`);
  if (compareEquinoxVersions(previousVersion, version) >= 0) throw new Error("Previous release version must be older than the candidate version.");
  const targetMatch = DARWIN_TARGET_PATTERN.exec(values.target);
  if (!targetMatch) throw new Error("Managed upgrade smoke currently accepts only Darwin release targets.");
  if (!DIGEST_PATTERN.test(values["previous-sha256"])) throw new Error("Previous artifact SHA-256 is invalid.");
  if (!/^[1-9][0-9]*$/u.test(values["previous-bytes"])) throw new Error("Previous artifact byte count is invalid.");
  const previousBytes = Number(values["previous-bytes"]);
  if (!Number.isSafeInteger(previousBytes) || previousBytes > 1024 * 1024 * 1024) throw new Error("Previous artifact byte count is invalid.");
  const previousUrl = normalizeHttps(values["previous-url"], "Previous artifact URL");
  const expectedPreviousUrl = new URL(`./${equinoxLocalReleaseArtifactName(previousVersion, values.target)}`, equinoxLocalUpdateManifestUrl(values.target)).toString();
  if (previousUrl !== expectedPreviousUrl) throw new Error("Previous artifact URL is not the pinned Equinox Local release URL.");
  return Object.freeze({
    operation,
    expectedSha: values["expected-sha"],
    previousVersion,
    version,
    target: values.target,
    arch: targetMatch[1],
    previousArtifact: Object.freeze({
      url: previousUrl,
      sha256: values["previous-sha256"],
      bytes: previousBytes,
    }),
    candidateManifestPath: normalizeAbsolute(values["candidate-manifest"], "Candidate manifest path"),
    candidateArtifactPath: values["candidate-artifact"]
      ? normalizeAbsolute(values["candidate-artifact"], "Candidate artifact path")
      : null,
  });
}

async function readCandidateManifest(input) {
  const { data } = await readBoundedNormalFile(input.candidateManifestPath, {
    maxBytes: MAX_MANIFEST_BYTES,
    encoding: "utf8",
    label: "Candidate update manifest",
  });
  let raw;
  try {
    raw = JSON.parse(data);
  } catch {
    throw new Error("Candidate update manifest is not valid JSON.");
  }
  const manifest = validateSignedUpdateManifest(raw, {
    publicKeys: EQUINOX_LOCAL_UPDATE_KEYS,
    target: input.target,
  });
  if (manifest.version !== input.version) throw new Error("Candidate update manifest version does not match the requested smoke version.");
  const expectedArtifactUrl = new URL(`./${equinoxLocalReleaseArtifactName(input.version, input.target)}`, equinoxLocalUpdateManifestUrl(input.target)).toString();
  if (manifest.artifact.url !== expectedArtifactUrl) throw new Error("Candidate update artifact URL is not the canonical versioned release URL.");
  if (input.candidateArtifactPath) {
    const stat = await fs.lstat(input.candidateArtifactPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.artifact.bytes) {
      throw new Error("Candidate artifact path does not match the signed manifest byte size.");
    }
  }
  return manifest;
}


async function readValidatedManifestFile(manifestPath, { version, target, publicKeys = EQUINOX_LOCAL_UPDATE_KEYS } = {}) {
  const { data } = await readBoundedNormalFile(manifestPath, {
    maxBytes: MAX_MANIFEST_BYTES,
    encoding: "utf8",
    label: `${target} signed update manifest`,
  });
  let raw;
  try {
    raw = JSON.parse(data);
  } catch {
    throw new Error(`${target} signed update manifest is not valid JSON.`);
  }
  const manifest = validateSignedUpdateManifest(raw, { publicKeys, target });
  if (manifest.version !== version) throw new Error(`${target} signed update manifest has the wrong version.`);
  const expectedArtifactUrl = new URL(`./${equinoxLocalReleaseArtifactName(version, target)}`, equinoxLocalUpdateManifestUrl(target)).toString();
  if (manifest.artifact.url !== expectedArtifactUrl) throw new Error(`${target} signed update artifact URL is not canonical.`);
  return manifest;
}

async function hashNormalFile(filePath, { fsImpl = fs, platform = process.platform } = {}) {
  let expectedIdentity = null;
  if (platform === "win32") {
    const before = await fsImpl.lstat(filePath);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error("Release artifact must be a normal, non-symlink file.");
    if (before.dev === undefined || before.ino === undefined || (before.dev === 0 && before.ino === 0)) {
      throw new Error("Release artifact identity could not be verified safely.");
    }
    expectedIdentity = Object.freeze({ dev: before.dev, ino: before.ino });
  } else if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error("Release artifact validation requires O_NOFOLLOW on this platform.");
  }
  const flags = platform === "win32" ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  let handle;
  try {
    handle = await fsImpl.open(filePath, flags);
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error("Release artifact must be a normal, non-symlink file.");
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Release artifact must be a normal file.");
    if (expectedIdentity && (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino)) {
      throw new Error("Release artifact changed while it was being opened.");
    }
    const hash = createHash("sha256");
    let bytes = 0;
    let position = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      bytes += bytesRead;
      position += bytesRead;
    }
    return Object.freeze({ bytes, sha256: hash.digest("hex") });
  } finally {
    await handle.close().catch(() => {});
  }
}

export async function runValidateSignedRelease(input, { publicKeys = EQUINOX_LOCAL_UPDATE_KEYS } = {}) {
  const bundles = {};
  let publishedAt = null;
  for (const target of EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS) {
    const manifestPath = path.join(input.signedDir, `stable-${target}.json`);
    const manifest = await readValidatedManifestFile(manifestPath, { version: input.version, target, publicKeys });
    const artifactPath = path.join(input.signedDir, equinoxLocalReleaseArtifactName(input.version, target));
    const digest = await hashNormalFile(artifactPath);
    if (digest.bytes !== manifest.artifact.bytes || digest.sha256 !== manifest.artifact.sha256) {
      throw new Error(`${target} release artifact does not match its signed manifest.`);
    }
    if (publishedAt === null) publishedAt = manifest.publishedAt;
    else if (manifest.publishedAt !== publishedAt) throw new Error("Signed release manifests do not share one publishedAt value.");
    bundles[target] = Object.freeze({
      target,
      manifestPath,
      artifactPath,
      publishedAt: manifest.publishedAt,
      artifact: manifest.artifact,
    });
  }
  return Object.freeze({
    status: "passed",
    version: input.version,
    publishedAt,
    bundles: Object.freeze(bundles),
  });
}

export async function runVerifyLiveRelease(input, {
  publicKeys = EQUINOX_LOCAL_UPDATE_KEYS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const bundles = {};
  let publishedAt = null;
  for (const target of EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS) {
    const manifestUrl = equinoxLocalUpdateManifestUrl(target);
    const response = await fetchImpl(manifestUrl, {
      headers: { "cache-control": "no-cache" },
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Live manifest ${target} returned HTTP ${response.status}.`);
    let raw;
    try {
      raw = await response.json();
    } catch {
      throw new Error(`Live manifest ${target} returned invalid JSON.`);
    }
    const manifest = validateSignedUpdateManifest(raw, { publicKeys, target, manifestUrl });
    if (manifest.version !== input.version) throw new Error(`Live signed manifest ${target} has the wrong version.`);
    const expectedArtifactUrl = new URL(`./${equinoxLocalReleaseArtifactName(input.version, target)}`, manifestUrl).toString();
    if (manifest.artifact.url !== expectedArtifactUrl) throw new Error(`Live signed artifact URL is not canonical for ${target}.`);
    const range = await fetchImpl(manifest.artifact.url, {
      headers: { range: "bytes=0-0", "cache-control": "no-cache" },
      redirect: "follow",
    });
    if (range.status !== 206 || range.headers.get("content-range") !== `bytes 0-0/${manifest.artifact.bytes}`) {
      throw new Error(`Live Range verification failed for ${target}.`);
    }
    if (publishedAt === null) publishedAt = manifest.publishedAt;
    else if (manifest.publishedAt !== publishedAt) throw new Error("Live release manifests do not share one publishedAt value.");
    bundles[target] = Object.freeze({
      target,
      publishedAt: manifest.publishedAt,
      artifact: manifest.artifact,
    });
  }
  return Object.freeze({ status: "passed", version: input.version, publishedAt, bundles: Object.freeze(bundles) });
}

function candidateFetch(candidateArtifactPath, manifest) {
  if (!candidateArtifactPath) return globalThis.fetch;
  return async (url, options) => {
    if (String(url) !== manifest.artifact.url) return globalThis.fetch(url, options);
    const stream = Readable.toWeb(createReadStream(candidateArtifactPath));
    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-length": String(manifest.artifact.bytes),
      },
    });
  };
}

export async function runManagedUpgradeSmoke(input) {
  const candidateManifest = await readCandidateManifest(input);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-release-behavior-"));
  try {
    const installRoot = path.join(tempRoot, "install");
    const releasesRoot = path.join(installRoot, "releases");
    const stagingRoot = path.join(installRoot, "staging");
    const currentLink = path.join(installRoot, "current");
    await fs.mkdir(installRoot, { recursive: true, mode: 0o700 });
    const installation = Object.freeze({
      kind: "managed",
      managed: true,
      selfUpdateSupported: true,
      installRoot,
      releasesRoot,
      stagingRoot,
      currentLink,
      platform: "darwin",
      arch: input.arch,
      target: input.target,
    });
    const oldManifest = Object.freeze({
      target: input.target,
      version: input.previousVersion,
      artifact: input.previousArtifact,
    });
    await prepareManagedEquinoxRelease({ installation, manifest: oldManifest });
    await fs.symlink(`releases/${input.previousVersion}`, currentLink, "dir");
    const pinnedManifestUrl = equinoxLocalUpdateManifestUrl(input.target);
    const updater = createEquinoxLocalUpdater({
      currentVersion: input.previousVersion,
      installation,
      publicKeys: EQUINOX_LOCAL_UPDATE_KEYS,
      target: input.target,
      fetchImpl: async (url, options) => {
        if (String(url) === pinnedManifestUrl) {
          return new Response(JSON.stringify(candidateManifest), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return globalThis.fetch(url, options);
      },
    });
    const status = await updater.check();
    if (status.latestVersion !== input.version || status.updateAvailable !== true) {
      throw new Error("Candidate updater did not select the requested release.");
    }
    const prepared = await prepareManagedEquinoxRelease({
      installation,
      manifest: updater.candidate(),
      fetchImpl: candidateFetch(input.candidateArtifactPath, candidateManifest),
    });
    if (prepared.version !== input.version) throw new Error("Candidate release preparation returned the wrong version.");
    const activation = await activatePreparedEquinoxRelease({
      installation,
      targetVersion: input.version,
      kickstartImpl: async () => {},
      syncAppHostImpl: async () => {},
      fetchImpl: async () => {
        const current = await readManagedCurrentRelease(installation);
        return new Response(JSON.stringify({
          status: {
            server: { version: current.version },
            health: { state: "HEALTHY" },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      healthAttempts: 1,
    });
    if (activation.status !== "activated" || activation.previousVersion !== input.previousVersion) {
      throw new Error("Managed upgrade smoke did not activate the expected version transition.");
    }
    return Object.freeze({
      status: "passed",
      previousVersion: input.previousVersion,
      version: input.version,
      target: input.target,
      activationStatus: activation.status,
    });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export async function runReleaseBehaviorCli(argv) {
  const input = parseReleaseBehaviorCli(argv);
  const checkout = await assertReleaseBehaviorCheckout({ expectedSha: input.expectedSha });
  if (input.operation === "describe") {
    return Object.freeze({
      schemaVersion: 1,
      sourceSha: checkout.sourceSha,
      sourceVersion: EQUINOX_LOCAL_VERSION,
      operations: Object.freeze([
        "managed-upgrade-smoke",
        "validate-signed-release",
        "verify-live-release",
      ]),
    });
  }
  const result = input.operation === "managed-upgrade-smoke"
    ? await runManagedUpgradeSmoke(input)
    : input.operation === "validate-signed-release"
      ? await runValidateSignedRelease(input)
      : await runVerifyLiveRelease(input);
  return Object.freeze({ schemaVersion: 1, sourceSha: checkout.sourceSha, sourceVersion: EQUINOX_LOCAL_VERSION, result });
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  runReleaseBehaviorCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
