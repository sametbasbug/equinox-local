import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyEquinoxLocalMainNativeImpact,
  computeEquinoxLocalMainNativeRuntimeContract,
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

test("exact-SHA native runtime contract hashes exact Git inputs without binding unrelated commits", async () => {
  const entries = [
    "100644 blob " + "1".repeat(40) + "\t.github/workflows/release-validation.yml",
    "100644 blob " + "2".repeat(40) + "\tscripts/release/package-managed-release.mjs",
    "100644 blob " + "3".repeat(40) + "\tsrc/equinox-local-platform.js",
    "100644 blob " + "4".repeat(40) + "\tsrc/equinox-local-release-runtime-contract.js",
    "100644 blob " + "5".repeat(40) + "\tsrc/equinox-local-runtime-versions.js",
    "100644 blob " + "6".repeat(40) + "\tapp/EquinoxLocal.png",
    "100644 blob " + "7".repeat(40) + "\tapp/EquinoxLocalApp.swift",
    "100644 blob " + "8".repeat(40) + "\tsrc/equinox-local-native-app.js",
    "100644 blob " + "9".repeat(40) + "\tsrc/equinox-local-native-app-host.js",
    "100644 blob " + "a".repeat(40) + "\tscripts/release/prepare-source-app-host.mjs",
  ];
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push([command, args]);
    if (args.includes("rev-parse")) return { stdout: `${SHA}\n`, stderr: "" };
    return { stdout: `${entries.reverse().join("\0")}\0`, stderr: "" };
  };
  const first = await computeEquinoxLocalMainNativeRuntimeContract({ rootDir: "/tmp/canonical", sourceSha: SHA, target: "darwin-arm64", execFileImpl });
  entries.reverse();
  const second = await computeEquinoxLocalMainNativeRuntimeContract({ rootDir: "/tmp/canonical", sourceSha: SHA, target: "darwin-arm64", execFileImpl });
  assert.match(first.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.inputCount, 10);
  assert.equal(first.inputs[0].path, ".github/workflows/release-validation.yml");
  assert.equal(calls.some(([, args]) => args.includes("ls-tree") && args.includes("app")), true);
});

test("native runtime contract rejects missing unsafe and non-blob exact inputs", async () => {
  const base = async (_command, args) => args.includes("rev-parse")
    ? { stdout: `${SHA}\n`, stderr: "" }
    : { stdout: "", stderr: "" };
  await assert.rejects(
    computeEquinoxLocalMainNativeRuntimeContract({ rootDir: "/tmp/canonical", sourceSha: SHA, target: "darwin-arm64", execFileImpl: base }),
    /input is missing/u,
  );
  const symlink = async (_command, args) => args.includes("rev-parse")
    ? { stdout: `${SHA}\n`, stderr: "" }
    : { stdout: `120000 blob ${"1".repeat(40)}\tapp/linked\0`, stderr: "" };
  await assert.rejects(
    computeEquinoxLocalMainNativeRuntimeContract({ rootDir: "/tmp/canonical", sourceSha: SHA, target: "darwin-arm64", execFileImpl: symlink }),
    /not a normal Git blob/u,
  );
  await assert.rejects(
    computeEquinoxLocalMainNativeRuntimeContract({ rootDir: "/tmp/canonical", sourceSha: SHA, target: "linux-x64", execFileImpl: base }),
    /target is unsupported/u,
  );
});

test("exact-SHA native manifest binds source target runtime contract and artifact digest", () => {
  const value = manifest("win32-arm64");
  assert.deepEqual(validateEquinoxLocalMainNativeArtifactManifest(value, {
    expectedSourceSha: SHA,
    expectedTarget: "win32-arm64",
    expectedRuntimeContractSha256: value.runtimeContractSha256,
  }), value);
  assert.throws(() => validateEquinoxLocalMainNativeArtifactManifest(value, {
    expectedRuntimeContractSha256: "d".repeat(64),
  }), /exact source contract/u);
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
