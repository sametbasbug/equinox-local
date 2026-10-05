import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "./equinox-local-platform.js";

const execFile = promisify(execFileCallback);

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
export const EQUINOX_LOCAL_MAIN_NATIVE_MANIFEST_SCHEMA_VERSION = 1;

const DARWIN_TARGETS = Object.freeze(["darwin-arm64", "darwin-x64"]);
const WINDOWS_TARGETS = Object.freeze(["win32-arm64", "win32-x64"]);
const ALL_TARGETS = Object.freeze([...EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS]);

const SHARED_NATIVE_PATHS = Object.freeze([
  ".github/workflows/release-validation.yml",
  "scripts/release/package-managed-release.mjs",
  "src/equinox-local-platform.js",
  "src/equinox-local-release-runtime-contract.js",
  "src/equinox-local-runtime-versions.js",
]);
const SHARED_NATIVE_ADMISSION_PATHS = Object.freeze([
  ".github/workflows/ci.yml",
  "scripts/release/build-main-native-artifact.mjs",
  "scripts/release/materialize-main-native-artifact.mjs",
  "scripts/release/plan-main-native-artifacts.mjs",
  "src/equinox-local-main-native-admission.js",
]);
const DARWIN_NATIVE_PATHS = Object.freeze([
  "app/",
  "src/equinox-local-native-app.js",
  "src/equinox-local-native-app-host.js",
  "scripts/release/prepare-source-app-host.mjs",
]);
const WINDOWS_NATIVE_PATHS = Object.freeze([
  ".github/actions/prepare-arm64-package/",
  "native/windows/",
  "scripts/release/package-managed-release-windows.mjs",
  "scripts/release/windows-managed-zip.ps1",
  "src/equinox-local-windows-stable-shell.js",
  "src/equinox-local-windows-shell-control.js",
]);

function normalizeChangedPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value) || value.startsWith("/") || value.includes("\\")) {
    throw new Error("Main native-impact path is invalid.");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("Main native-impact path is unsafe.");
  return value;
}
function matchesRule(relative, rule) {
  return rule.endsWith("/") ? relative.startsWith(rule) : relative === rule;
}
function addTargets(targets, values) {
  for (const target of values) targets.add(target);
}

function nativeContractRulesForTarget(target) {
  if (!ALL_TARGETS.includes(target)) throw new Error("Main native runtime contract target is unsupported.");
  const platformRules = target.startsWith("darwin-") ? DARWIN_NATIVE_PATHS : WINDOWS_NATIVE_PATHS;
  return Object.freeze([...new Set([...SHARED_NATIVE_PATHS, ...platformRules])]);
}

function parseNativeContractTree(raw, rules) {
  const entries = [];
  const seen = new Set();
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 1) throw new Error("Main native runtime contract Git tree output is malformed.");
    const header = record.slice(0, separator);
    const relative = normalizeChangedPath(record.slice(separator + 1));
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})$/u.exec(header);
    if (!match) throw new Error(`Main native runtime contract input is not a normal Git blob: ${relative}.`);
    if (!rules.some((rule) => matchesRule(relative, rule))) throw new Error(`Unexpected Main native runtime contract input: ${relative}.`);
    if (seen.has(relative)) throw new Error(`Duplicate Main native runtime contract input: ${relative}.`);
    seen.add(relative);
    entries.push(Object.freeze({ mode: match[1], objectId: match[2], path: relative }));
  }
  for (const rule of rules) {
    if (!entries.some((entry) => matchesRule(entry.path, rule))) throw new Error(`Main native runtime contract input is missing: ${rule}.`);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return Object.freeze(entries);
}

export async function computeEquinoxLocalMainNativeRuntimeContract({
  rootDir,
  sourceSha,
  target,
  execFileImpl = execFile,
} = {}) {
  if (typeof rootDir !== "string" || rootDir.length < 1) throw new Error("Main native runtime contract root is required.");
  if (!SHA_PATTERN.test(sourceSha ?? "")) throw new Error("Main native runtime contract source SHA is invalid.");
  const rules = nativeContractRulesForTarget(target);
  const root = path.resolve(rootDir);
  const revision = await execFileImpl("git", ["-C", root, "rev-parse", "--verify", `${sourceSha}^{commit}`], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (String(revision.stdout ?? "").trim() !== sourceSha) throw new Error("Main native runtime contract source SHA is unavailable in the canonical checkout.");
  const pathspecs = rules.map((rule) => rule.endsWith("/") ? rule.slice(0, -1) : rule);
  const tree = await execFileImpl("git", ["-C", root, "ls-tree", "-r", "-z", sourceSha, "--", ...pathspecs], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
  });
  const entries = parseNativeContractTree(String(tree.stdout ?? ""), rules);
  const digest = createHash("sha256");
  digest.update("equinox-local-main-native-runtime-contract-v1\0", "utf8");
  digest.update(`target=${target}\0`, "utf8");
  for (const entry of entries) digest.update(`${entry.mode}\0${entry.path}\0${entry.objectId}\0`, "utf8");
  return Object.freeze({
    schemaVersion: 1,
    target,
    sha256: digest.digest("hex"),
    inputCount: entries.length,
    inputs: entries,
  });
}

export async function planEquinoxLocalMainNativeTransition({
  currentRoot,
  currentSha,
  targetRoot,
  targetSha,
  target,
  computeRuntimeContractImpl = computeEquinoxLocalMainNativeRuntimeContract,
} = {}) {
  if (typeof computeRuntimeContractImpl !== "function") throw new Error("Main native transition contract computer is required.");
  const [currentContract, targetContract] = await Promise.all([
    computeRuntimeContractImpl({ rootDir: currentRoot, sourceSha: currentSha, target }),
    computeRuntimeContractImpl({ rootDir: targetRoot, sourceSha: targetSha, target }),
  ]);
  if (currentContract?.target !== target || targetContract?.target !== target) throw new Error("Main native transition contract target drifted.");
  if (!DIGEST_PATTERN.test(currentContract?.sha256 ?? "") || !DIGEST_PATTERN.test(targetContract?.sha256 ?? "")) {
    throw new Error("Main native transition contract digest is invalid.");
  }
  const mode = currentContract.sha256 === targetContract.sha256 ? "reuse_native" : "artifact_required";
  return Object.freeze({
    mode,
    target,
    currentSha,
    targetSha,
    currentRuntimeContractSha256: currentContract.sha256,
    targetRuntimeContractSha256: targetContract.sha256,
  });
}

const MAX_NATIVE_IMPACT_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_NATIVE_IMPACT_CHANGED_PATHS = 20_000;
const DEFAULT_CANONICAL_MAIN_REF = "refs/remotes/origin/main";

async function runNativeAdmissionGit(root, args, { execFileImpl = execFile, maxBuffer = 1024 * 1024 } = {}) {
  return execFileImpl("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}

async function resolveExactCommit(root, revision, label, { execFileImpl = execFile } = {}) {
  const result = await runNativeAdmissionGit(root, ["rev-parse", "--verify", `${revision}^{commit}`], { execFileImpl });
  const resolved = String(result?.stdout ?? "").trim();
  if (!SHA_PATTERN.test(resolved)) throw new Error(`${label} did not resolve to an exact commit.`);
  return resolved;
}

async function assertGitAncestor(root, ancestor, descendant, message, { execFileImpl = execFile } = {}) {
  try {
    await runNativeAdmissionGit(root, ["merge-base", "--is-ancestor", ancestor, descendant], { execFileImpl });
  } catch {
    throw new Error(message);
  }
}

export async function inspectEquinoxLocalMainNativeImpactRange({
  rootDir,
  currentSha,
  targetSha,
  canonicalMainRef = DEFAULT_CANONICAL_MAIN_REF,
  execFileImpl = execFile,
} = {}) {
  if (typeof rootDir !== "string" || rootDir.length < 1) throw new Error("Main native-impact Git root is required.");
  if (!SHA_PATTERN.test(currentSha ?? "")) throw new Error("Main native-impact current SHA is invalid.");
  if (!SHA_PATTERN.test(targetSha ?? "")) throw new Error("Main native-impact target SHA is invalid.");
  if (typeof canonicalMainRef !== "string" || canonicalMainRef.length < 1 || canonicalMainRef.length > 256 || /[\u0000-\u001f\u007f]/u.test(canonicalMainRef)) {
    throw new Error("Main native-impact canonical ref is invalid.");
  }

  const root = path.resolve(rootDir);
  const [resolvedCurrent, resolvedTarget, canonicalMainSha] = await Promise.all([
    resolveExactCommit(root, currentSha, "Main native-impact current SHA", { execFileImpl }),
    resolveExactCommit(root, targetSha, "Main native-impact target SHA", { execFileImpl }),
    resolveExactCommit(root, canonicalMainRef, "Main native-impact canonical main ref", { execFileImpl }),
  ]);
  if (resolvedCurrent !== currentSha) throw new Error("Main native-impact current SHA does not resolve exactly.");
  if (resolvedTarget !== targetSha) throw new Error("Main native-impact target SHA does not resolve exactly.");

  await assertGitAncestor(root, currentSha, targetSha, "Main native-impact current SHA is not an ancestor of the target SHA.", { execFileImpl });
  await assertGitAncestor(root, currentSha, canonicalMainSha, "Main native-impact current SHA is not on canonical main history.", { execFileImpl });
  await assertGitAncestor(root, targetSha, canonicalMainSha, "Main native-impact target SHA is not on canonical main history.", { execFileImpl });

  if (currentSha === targetSha) {
    return Object.freeze({
      currentSha,
      targetSha,
      canonicalMainSha,
      changedPaths: Object.freeze([]),
      ...classifyEquinoxLocalMainNativeImpact([]),
    });
  }

  const diff = await runNativeAdmissionGit(root, [
    "diff", "--name-only", "-z", "--no-renames", currentSha, targetSha, "--",
  ], { execFileImpl, maxBuffer: MAX_NATIVE_IMPACT_DIFF_BYTES });
  const raw = String(diff?.stdout ?? "");
  if (Buffer.byteLength(raw, "utf8") > MAX_NATIVE_IMPACT_DIFF_BYTES) throw new Error("Main native-impact Git diff exceeds the byte limit.");
  const changedPaths = raw.split("\0").filter(Boolean).map(normalizeChangedPath);
  if (changedPaths.length > MAX_NATIVE_IMPACT_CHANGED_PATHS) throw new Error("Main native-impact Git diff contains too many changed paths.");
  const uniquePaths = Object.freeze([...new Set(changedPaths)]);
  const impact = classifyEquinoxLocalMainNativeImpact(uniquePaths);
  return Object.freeze({
    currentSha,
    targetSha,
    canonicalMainSha,
    changedPaths: uniquePaths,
    ...impact,
  });
}

export function classifyEquinoxLocalMainNativeImpact(changedPaths = []) {
  if (!Array.isArray(changedPaths)) throw new Error("Main native-impact paths must be an array.");
  const targets = new Set();
  const reasons = [];
  const seen = new Set();
  for (const raw of changedPaths) {
    const relative = normalizeChangedPath(raw);
    if (seen.has(relative)) continue;
    seen.add(relative);
    if ([...SHARED_NATIVE_PATHS, ...SHARED_NATIVE_ADMISSION_PATHS].some((rule) => matchesRule(relative, rule))) {
      addTargets(targets, ALL_TARGETS);
      reasons.push(Object.freeze({ path: relative, scope: "all" }));
      continue;
    }
    if (DARWIN_NATIVE_PATHS.some((rule) => matchesRule(relative, rule))) {
      addTargets(targets, DARWIN_TARGETS);
      reasons.push(Object.freeze({ path: relative, scope: "darwin" }));
      continue;
    }
    if (WINDOWS_NATIVE_PATHS.some((rule) => matchesRule(relative, rule))) {
      addTargets(targets, WINDOWS_TARGETS);
      reasons.push(Object.freeze({ path: relative, scope: "windows" }));
    }
  }
  const requiredTargets = ALL_TARGETS.filter((target) => targets.has(target));
  return Object.freeze({ nativeImpact: requiredTargets.length > 0, requiredTargets: Object.freeze(requiredTargets), reasons: Object.freeze(reasons) });
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(`${label} contains missing or unsupported fields.`);
}

export function validateEquinoxLocalMainNativeArtifactManifest(value, {
  expectedSourceSha = null,
  expectedTarget = null,
  expectedRuntimeContractSha256 = null,
} = {}) {
  assertExactKeys(value, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256", "artifact"], "Main native artifact manifest");
  if (value.schemaVersion !== EQUINOX_LOCAL_MAIN_NATIVE_MANIFEST_SCHEMA_VERSION || value.channel !== "main") throw new Error("Main native artifact manifest identity is invalid.");
  if (!SHA_PATTERN.test(value.sourceSha ?? "")) throw new Error("Main native artifact source SHA is invalid.");
  if (expectedSourceSha !== null && value.sourceSha !== expectedSourceSha) throw new Error("Main native artifact source SHA does not match the admitted update target.");
  if (!ALL_TARGETS.includes(value.target)) throw new Error("Main native artifact target is unsupported.");
  if (expectedTarget !== null && value.target !== expectedTarget) throw new Error("Main native artifact target does not match the host target.");
  if (!DIGEST_PATTERN.test(value.runtimeContractSha256 ?? "")) throw new Error("Main native runtime contract digest is invalid.");
  if (expectedRuntimeContractSha256 !== null && value.runtimeContractSha256 !== expectedRuntimeContractSha256) {
    throw new Error("Main native runtime contract digest does not match the exact source contract.");
  }
  assertExactKeys(value.artifact, ["name", "sha256", "bytes"], "Main native artifact");
  if (typeof value.artifact.name !== "string" || !/^equinox-local-main-[a-f0-9]{40}-(?:darwin|win32)-(?:arm64|x64)\.(?:tar\.gz|zip)$/u.test(value.artifact.name)) {
    throw new Error("Main native artifact name is invalid.");
  }
  const expectedExtension = value.target.startsWith("darwin-") ? ".tar.gz" : ".zip";
  const expectedName = `equinox-local-main-${value.sourceSha}-${value.target}${expectedExtension}`;
  if (value.artifact.name !== expectedName) throw new Error("Main native artifact name is not bound to its exact source SHA and target.");
  if (!DIGEST_PATTERN.test(value.artifact.sha256 ?? "")) throw new Error("Main native artifact SHA-256 is invalid.");
  if (!Number.isSafeInteger(value.artifact.bytes) || value.artifact.bytes < 1 || value.artifact.bytes > MAX_ARTIFACT_BYTES) throw new Error("Main native artifact byte size is invalid.");
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    channel: value.channel,
    sourceSha: value.sourceSha,
    target: value.target,
    runtimeContractSha256: value.runtimeContractSha256,
    artifact: Object.freeze({ ...value.artifact }),
  });
}
