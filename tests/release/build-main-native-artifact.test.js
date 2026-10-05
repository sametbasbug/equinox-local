import assert from "node:assert/strict";
import test from "node:test";
import { buildEquinoxLocalMainNativeArtifact } from "../../scripts/release/build-main-native-artifact.mjs";

const SHA = "a".repeat(40);
function materialized(target) {
  return { artifactPath: `/out/main-${target}`, manifestPath: `/out/main-${target}.json`, manifest: { runtimeContractSha256: "b".repeat(64), artifact: { sha256: "c".repeat(64), bytes: 123 } } };
}

test("Main native builder reuses host-native Darwin packager then exact-SHA materializer", async () => {
  const calls = [];
  const result = await buildEquinoxLocalMainNativeArtifact({
    rootDir: "/workspace/equinox-local", sourceSha: SHA, target: "darwin-x64", outputDir: "/workspace/main-native-output", hostPlatform: "darwin", hostArch: "x64",
    packageDarwinImpl: async (args) => { calls.push(["darwin", args]); return { target: "darwin-x64", artifactPath: "/workspace/candidate.tar.gz" }; },
    packageWindowsImpl: async () => { throw new Error("wrong packager"); },
    materializeImpl: async (args) => { calls.push(["materialize", args]); return materialized(args.target); },
  });
  assert.equal(result.target, "darwin-x64");
  assert.deepEqual(calls.map(([name]) => name), ["darwin", "materialize"]);
  assert.equal(calls[1][1].candidateArtifactPath, "/workspace/candidate.tar.gz");
});

test("Main native builder routes Windows to existing Windows package primitive", async () => {
  let windowsCalled = false;
  await buildEquinoxLocalMainNativeArtifact({
    rootDir: "/workspace/equinox-local", sourceSha: SHA, target: "win32-arm64", outputDir: "/workspace/main-native-output", hostPlatform: "win32", hostArch: "arm64",
    packageDarwinImpl: async () => { throw new Error("wrong packager"); },
    packageWindowsImpl: async () => { windowsCalled = true; return { target: "win32-arm64", artifactPath: "C:/candidate.zip" }; },
    materializeImpl: async (args) => materialized(args.target),
  });
  assert.equal(windowsCalled, true);
});

test("Main native builder rejects cross-target hosts and invalid candidate metadata", async () => {
  await assert.rejects(buildEquinoxLocalMainNativeArtifact({ rootDir: "/workspace/equinox-local", sourceSha: SHA, target: "darwin-arm64", outputDir: "/workspace/main-native-output", hostPlatform: "darwin", hostArch: "x64" }), /native host\/target match/u);
  await assert.rejects(buildEquinoxLocalMainNativeArtifact({
    rootDir: "/workspace/equinox-local", sourceSha: SHA, target: "darwin-x64", outputDir: "/workspace/main-native-output", hostPlatform: "darwin", hostArch: "x64",
    packageDarwinImpl: async () => ({ target: "darwin-arm64", artifactPath: "/workspace/wrong.tar.gz" }),
  }), /invalid target metadata/u);
});
