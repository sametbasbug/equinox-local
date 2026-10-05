import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyEquinoxLocalMainNativeImpact,
  validateEquinoxLocalMainNativeArtifactManifest,
} from "../../src/equinox-local-main-native-admission.js";

const SHA = "a".repeat(40);
const manifest = (target = "darwin-arm64") => ({
  schemaVersion: 1,
  channel: "main",
  sourceSha: SHA,
  target,
  runtimeContractSha256: "b".repeat(64),
  artifact: {
    name: `equinox-local-main-${SHA}-${target}${target.startsWith("darwin-") ? ".tar.gz" : ".zip"}`,
    sha256: "c".repeat(64),
    bytes: 12345,
  },
});

test("runtime-only source changes do not require native main artifacts", () => {
  assert.deepEqual(classifyEquinoxLocalMainNativeImpact(["src/server.js", "src/task-capsule-store.js"]), {
    nativeImpact: false,
    requiredTargets: [],
    reasons: [],
  });
});

test("macOS native inputs require both Darwin architectures", () => {
  const result = classifyEquinoxLocalMainNativeImpact(["app/EquinoxLocalApp.swift", "src/equinox-local-native-app.js"]);
  assert.deepEqual(result.requiredTargets, ["darwin-arm64", "darwin-x64"]);
  assert.deepEqual(result.reasons.map((entry) => entry.scope), ["darwin", "darwin"]);
});

test("Windows native inputs require both Windows architectures", () => {
  const result = classifyEquinoxLocalMainNativeImpact([
    "native/windows/EquinoxLocal.WindowsShell/App.xaml.cs",
    "native/windows/equinox-browser-native-host-launcher.cpp",
  ]);
  assert.deepEqual(result.requiredTargets, ["win32-arm64", "win32-x64"]);
});

test("shared native contracts require all four release targets and deduplicate paths", () => {
  const result = classifyEquinoxLocalMainNativeImpact(["src/equinox-local-platform.js", "src/equinox-local-platform.js"]);
  assert.deepEqual(result.requiredTargets, ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]);
  assert.equal(result.reasons.length, 1);
  assert.equal(result.reasons[0].scope, "all");
});

test("native-impact path admission is fail-closed for unsafe path syntax", () => {
  assert.throws(() => classifyEquinoxLocalMainNativeImpact(["../app/EquinoxLocalApp.swift"]), /unsafe/u);
  assert.throws(() => classifyEquinoxLocalMainNativeImpact(["native\\windows\\shell.cs"]), /invalid/u);
  assert.throws(() => classifyEquinoxLocalMainNativeImpact("app/EquinoxLocalApp.swift"), /array/u);
});

test("exact-SHA native manifest binds source target runtime contract and artifact digest", () => {
  const value = manifest("win32-arm64");
  assert.deepEqual(validateEquinoxLocalMainNativeArtifactManifest(value, { expectedSourceSha: SHA, expectedTarget: "win32-arm64" }), value);
});

test("native manifest rejects SHA target name digest size and schema drift", () => {
  assert.throws(() => validateEquinoxLocalMainNativeArtifactManifest({ ...manifest(), sourceSha: "a".repeat(39) }), /source SHA/u);
  assert.throws(() => validateEquinoxLocalMainNativeArtifactManifest(manifest(), { expectedSourceSha: "d".repeat(40) }), /admitted update target/u);
  assert.throws(() => validateEquinoxLocalMainNativeArtifactManifest(manifest(), { expectedTarget: "darwin-x64" }), /host target/u);
  const badName = manifest(); badName.artifact = { ...badName.artifact, name: `equinox-local-main-${SHA}-darwin-x64.tar.gz` };
  assert.throws(() => validateEquinoxLocalMainNativeArtifactManifest(badName), /not bound/u);
  const badContract = manifest(); badContract.runtimeContractSha256 = "b".repeat(63);
  assert.throws(() => validateEquinoxLocalMainNativeArtifactManifest(badContract), /runtime contract digest/u);
  const badSize = manifest(); badSize.artifact = { ...badSize.artifact, bytes: 0 };
  assert.throws(() => validateEquinoxLocalMainNativeArtifactManifest(badSize), /byte size/u);
  const extra = { ...manifest(), unexpected: true };
  assert.throws(() => validateEquinoxLocalMainNativeArtifactManifest(extra), /unsupported fields/u);
});
