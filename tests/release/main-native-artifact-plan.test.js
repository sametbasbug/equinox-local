import assert from "node:assert/strict";
import test from "node:test";
import { planEquinoxLocalMainNativeArtifacts } from "../../scripts/release/plan-main-native-artifacts.mjs";

const CURRENT = "1".repeat(40);
const TARGET = "2".repeat(40);
const CANONICAL = "3".repeat(40);
const inspectImpactImpl = async () => ({
  currentSha: CURRENT, targetSha: TARGET, canonicalMainSha: CANONICAL,
  changedPaths: ["src/equinox-local-platform.js"], nativeImpact: true,
  requiredTargets: ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"],
  reasons: [{ path: "src/equinox-local-platform.js", scope: "all" }],
});
const matrix = [
  { target: "darwin-arm64", platform: "darwin", arch: "arm64", buildAuthority: "factory-native", nativeRunner: null },
  { target: "darwin-x64", platform: "darwin", arch: "x64", buildAuthority: "github-native", nativeRunner: "macos-intel" },
  { target: "win32-arm64", platform: "win32", arch: "arm64", buildAuthority: "github-native", nativeRunner: "windows-arm" },
  { target: "win32-x64", platform: "win32", arch: "x64", buildAuthority: "github-native", nativeRunner: "windows-x64" },
];

test("Main native planner schedules every required target on GitHub without factory availability", async () => {
  const mainNativeRunners = { "darwin-arm64": "macos-arm", "darwin-x64": "macos-intel", "win32-arm64": "windows-arm", "win32-x64": "windows-x64" };
  const result = await planEquinoxLocalMainNativeArtifacts({ rootDir: "/tmp/canonical", currentSha: CURRENT, targetSha: TARGET, inspectImpactImpl, targetMatrix: matrix, mainNativeRunners });
  assert.deepEqual(result.githubTargets, [
    { target: "darwin-arm64", runner: "macos-arm", platform: "darwin", arch: "arm64" },
    { target: "darwin-x64", runner: "macos-intel", platform: "darwin", arch: "x64" },
    { target: "win32-arm64", runner: "windows-arm", platform: "win32", arch: "arm64", shellRid: "win-arm64", dotnetPlatform: "ARM64" },
    { target: "win32-x64", runner: "windows-x64", platform: "win32", arch: "x64", shellRid: "win-x64", dotnetPlatform: "x64" },
  ]);
});

test("Main native planner avoids builders for runtime-only changes", async () => {
  const runtimeOnly = async () => ({ currentSha: CURRENT, targetSha: TARGET, canonicalMainSha: CANONICAL, changedPaths: ["src/server.js"], nativeImpact: false, requiredTargets: [], reasons: [] });
  const result = await planEquinoxLocalMainNativeArtifacts({ rootDir: "/tmp/canonical", currentSha: CURRENT, targetSha: TARGET, inspectImpactImpl: runtimeOnly, targetMatrix: matrix });
  assert.deepEqual(result.githubTargets, []);
});

test("Main native planner fails closed for invalid target contracts", async () => {
  const oneTarget = async () => ({ currentSha: CURRENT, targetSha: TARGET, canonicalMainSha: CANONICAL, changedPaths: ["app/x"], nativeImpact: true, requiredTargets: ["darwin-x64"], reasons: [] });
  await assert.rejects(planEquinoxLocalMainNativeArtifacts({ rootDir: "/tmp/canonical", currentSha: CURRENT, targetSha: TARGET, inspectImpactImpl: oneTarget, targetMatrix: [{ target: "darwin-x64", platform: "darwin", arch: "x64", buildAuthority: "github-native", nativeRunner: null }], mainNativeRunners: {} }), /no GitHub runner/u);
  await assert.rejects(planEquinoxLocalMainNativeArtifacts({ rootDir: "/tmp/canonical", currentSha: CURRENT, targetSha: TARGET, inspectImpactImpl: oneTarget, targetMatrix: [] }), /contract is missing/u);
  await assert.rejects(planEquinoxLocalMainNativeArtifacts({ rootDir: "/tmp/canonical", currentSha: CURRENT, targetSha: TARGET, inspectImpactImpl: oneTarget, targetMatrix: [matrix[1], matrix[1]] }), /duplicate targets/u);
});
