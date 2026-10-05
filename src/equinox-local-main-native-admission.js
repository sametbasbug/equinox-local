import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "./equinox-local-platform.js";

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
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || /[\r\n\0]/u.test(value) || value.startsWith("/") || value.includes("\\")) {
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

export function classifyEquinoxLocalMainNativeImpact(changedPaths = []) {
  if (!Array.isArray(changedPaths)) throw new Error("Main native-impact paths must be an array.");
  const targets = new Set();
  const reasons = [];
  const seen = new Set();
  for (const raw of changedPaths) {
    const relative = normalizeChangedPath(raw);
    if (seen.has(relative)) continue;
    seen.add(relative);
    if (SHARED_NATIVE_PATHS.some((rule) => matchesRule(relative, rule))) {
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

export function validateEquinoxLocalMainNativeArtifactManifest(value, { expectedSourceSha = null, expectedTarget = null } = {}) {
  assertExactKeys(value, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256", "artifact"], "Main native artifact manifest");
  if (value.schemaVersion !== EQUINOX_LOCAL_MAIN_NATIVE_MANIFEST_SCHEMA_VERSION || value.channel !== "main") throw new Error("Main native artifact manifest identity is invalid.");
  if (!SHA_PATTERN.test(value.sourceSha ?? "")) throw new Error("Main native artifact source SHA is invalid.");
  if (expectedSourceSha !== null && value.sourceSha !== expectedSourceSha) throw new Error("Main native artifact source SHA does not match the admitted update target.");
  if (!ALL_TARGETS.includes(value.target)) throw new Error("Main native artifact target is unsupported.");
  if (expectedTarget !== null && value.target !== expectedTarget) throw new Error("Main native artifact target does not match the host target.");
  if (!DIGEST_PATTERN.test(value.runtimeContractSha256 ?? "")) throw new Error("Main native runtime contract digest is invalid.");
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
