import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyEquinoxLocalMainNativeImpact,
  classifyEquinoxLocalMainUpdateImpact,
  computeEquinoxLocalMainNativeRuntimeContract,
  planEquinoxLocalMainNativeTransition,
  inspectEquinoxLocalMainNativeImpactRange,
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

const TRANSITION_CURRENT = "a".repeat(40);
const TRANSITION_TARGET = "b".repeat(40);

test("Main update impact excludes tests CI docs and bounded metadata but includes product and release inputs", () => {
  assert.equal(classifyEquinoxLocalMainUpdateImpact([
    "tests/release/main-native-ci.test.js",
    ".github/workflows/ci.yml",
    "docs/architecture.md",
    "README.md",
    "SECURITY.md",
  ]), false);
  assert.equal(classifyEquinoxLocalMainUpdateImpact(["src/server.js"]), true);
  assert.equal(classifyEquinoxLocalMainUpdateImpact(["scripts/release/build-main-native-artifact.mjs"]), true);
  assert.equal(classifyEquinoxLocalMainUpdateImpact(["THIRD_PARTY_NOTICES.md"]), true);
  assert.throws(() => classifyEquinoxLocalMainUpdateImpact(["../tests/bad.js"]), /unsafe/u);
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

test("Windows native inputs and release-local Native Messaging closure require both Windows architectures", () => {
  const result = classifyEquinoxLocalMainNativeImpact([
    "native/windows/EquinoxLocal.WindowsShell/App.xaml.cs",
    "native/windows/equinox-browser-native-host-launcher.cpp",
    "src/equinox-browser-native-host.js",
    "src/equinox-browser-native-host-runtime.js",
    "src/equinox-browser-socket.js",
  ]);
  assert.deepEqual(result.requiredTargets, ["win32-arm64", "win32-x64"]);
  assert.equal(result.reasons.every((entry) => entry.scope === "windows"), true);
});

test("shared native contracts require all four release targets and deduplicate paths", () => {
  const result = classifyEquinoxLocalMainNativeImpact(["src/equinox-local-platform.js", "src/equinox-local-platform.js"]);
  assert.deepEqual(result.requiredTargets, ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]);
  assert.equal(result.reasons.length, 1);
  assert.equal(result.reasons[0].scope, "all");
});

test("Main native admission pipeline changes rebuild all targets without entering runtime contract inputs", () => {
  const result = classifyEquinoxLocalMainNativeImpact([".github/workflows/ci.yml", "scripts/release/materialize-main-native-artifact.mjs"]);
  assert.deepEqual(result.requiredTargets, ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]);
  assert.deepEqual(result.reasons.map((entry) => entry.scope), ["all", "all"]);
});

test("native-impact path admission is fail-closed for unsafe path syntax", () => {
  assert.throws(() => classifyEquinoxLocalMainNativeImpact(["../app/EquinoxLocalApp.swift"]), /unsafe/u);
  assert.throws(() => classifyEquinoxLocalMainNativeImpact(["native\\windows\\shell.cs"]), /invalid/u);
  assert.throws(() => classifyEquinoxLocalMainNativeImpact("app/EquinoxLocalApp.swift"), /array/u);
});

test("exact canonical main range derives NUL-safe changed paths and required native targets", async () => {
  const currentSha = "1".repeat(40);
  const targetSha = "2".repeat(40);
  const canonicalMainSha = "3".repeat(40);
  const calls = [];
  const execFileImpl = async (_command, args) => {
    calls.push(args);
    if (args.includes("rev-parse")) {
      const revision = args.at(-1).replace(/\^\{commit\}$/u, "");
      if (revision === currentSha || revision === targetSha) return { stdout: `${revision}\n`, stderr: "" };
      if (revision === "refs/remotes/origin/main") return { stdout: `${canonicalMainSha}\n`, stderr: "" };
    }
    if (args.includes("merge-base")) return { stdout: "", stderr: "" };
    if (args.includes("diff")) {
      return {
        stdout: `src/server.js\0native/windows/EquinoxLocal.WindowsShell/App.xaml.cs\0app/EquinoxLocalApp.swift\0`,
        stderr: "",
      };
    }
    throw new Error("Unexpected Git call.");
  };
  const result = await inspectEquinoxLocalMainNativeImpactRange({
    rootDir: "/tmp/canonical", currentSha, targetSha, execFileImpl,
  });
  assert.equal(result.canonicalMainSha, canonicalMainSha);
  assert.equal(result.mainUpdateImpact, true);
  assert.deepEqual(result.changedPaths, [
    "src/server.js",
    "native/windows/EquinoxLocal.WindowsShell/App.xaml.cs",
    "app/EquinoxLocalApp.swift",
  ]);
  assert.deepEqual(result.requiredTargets, ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]);
  assert.equal(calls.some((args) => args.includes("diff") && args.includes("--no-renames") && args.includes("-z")), true);
});

test("exact canonical main range marks test and CI-only changes as non-product", async () => {
  const currentSha = "4".repeat(40);
  const targetSha = "5".repeat(40);
  const canonicalMainSha = targetSha;
  const execFileImpl = async (_command, args) => {
    if (args.includes("rev-parse")) {
      const revision = args.at(-1).replace(/\^\{commit\}$/u, "");
      if (revision === currentSha || revision === targetSha) return { stdout: `${revision}\n`, stderr: "" };
      if (revision === "refs/remotes/origin/main") return { stdout: `${canonicalMainSha}\n`, stderr: "" };
    }
    if (args.includes("merge-base")) return { stdout: "", stderr: "" };
    if (args.includes("diff")) return { stdout: "tests/a.test.js\0.github/workflows/ci.yml\0", stderr: "" };
    throw new Error("Unexpected Git call.");
  };
  const result = await inspectEquinoxLocalMainNativeImpactRange({
    rootDir: "/tmp/canonical", currentSha, targetSha, execFileImpl,
  });
  assert.equal(result.mainUpdateImpact, false);
  assert.equal(result.nativeImpact, true);
});

test("exact canonical main range fails closed for divergent or non-canonical history", async () => {
  const currentSha = "1".repeat(40);
  const targetSha = "2".repeat(40);
  const canonicalMainSha = "3".repeat(40);
  const createExec = (rejectPair) => async (_command, args) => {
    if (args.includes("rev-parse")) {
      const revision = args.at(-1).replace(/\^\{commit\}$/u, "");
      if (revision === currentSha || revision === targetSha) return { stdout: `${revision}\n`, stderr: "" };
      return { stdout: `${canonicalMainSha}\n`, stderr: "" };
    }
    if (args.includes("merge-base")) {
      const pair = `${args.at(-2)}:${args.at(-1)}`;
      if (pair === rejectPair) {
        const error = new Error("not ancestor");
        error.code = 1;
        throw error;
      }
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(
    inspectEquinoxLocalMainNativeImpactRange({
      rootDir: "/tmp/canonical", currentSha, targetSha, execFileImpl: createExec(`${currentSha}:${targetSha}`),
    }),
    /not an ancestor/u,
  );
  await assert.rejects(
    inspectEquinoxLocalMainNativeImpactRange({
      rootDir: "/tmp/canonical", currentSha, targetSha, execFileImpl: createExec(`${targetSha}:${canonicalMainSha}`),
    }),
    /not on canonical main history/u,
  );
});

test("exact canonical main range rejects malformed diff paths and exact-SHA drift", async () => {
  const currentSha = "1".repeat(40);
  const targetSha = "2".repeat(40);
  const canonicalMainSha = "3".repeat(40);
  const driftingExec = async (_command, args) => {
    if (args.includes("rev-parse")) {
      const revision = args.at(-1).replace(/\^\{commit\}$/u, "");
      if (revision === currentSha) return { stdout: `${"4".repeat(40)}\n`, stderr: "" };
      if (revision === targetSha) return { stdout: `${targetSha}\n`, stderr: "" };
      return { stdout: `${canonicalMainSha}\n`, stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(
    inspectEquinoxLocalMainNativeImpactRange({ rootDir: "/tmp/canonical", currentSha, targetSha, execFileImpl: driftingExec }),
    /does not resolve exactly/u,
  );

  const unsafeDiffExec = async (_command, args) => {
    if (args.includes("rev-parse")) {
      const revision = args.at(-1).replace(/\^\{commit\}$/u, "");
      if (revision === currentSha || revision === targetSha) return { stdout: `${revision}\n`, stderr: "" };
      return { stdout: `${canonicalMainSha}\n`, stderr: "" };
    }
    if (args.includes("merge-base")) return { stdout: "", stderr: "" };
    if (args.includes("diff")) return { stdout: "app/ok.swift\0native/windows/bad\nname.cpp\0", stderr: "" };
    throw new Error("Unexpected Git call.");
  };
  await assert.rejects(
    inspectEquinoxLocalMainNativeImpactRange({ rootDir: "/tmp/canonical", currentSha, targetSha, execFileImpl: unsafeDiffExec }),
    /path is invalid/u,
  );
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


test("Main native transition reuses the installed shell when exact runtime contracts match", async () => {
  const calls = [];
  const digest = "1".repeat(64);
  const result = await planEquinoxLocalMainNativeTransition({
    currentRoot: "/current", currentSha: TRANSITION_CURRENT, targetRoot: "/target", targetSha: TRANSITION_TARGET, target: "darwin-arm64",
    computeRuntimeContractImpl: async (options) => { calls.push(options); return { target: options.target, sha256: digest }; },
  });
  assert.equal(result.mode, "reuse_native");
  assert.equal(result.currentRuntimeContractSha256, digest);
  assert.equal(result.targetRuntimeContractSha256, digest);
  assert.deepEqual(calls.map(({ rootDir, sourceSha }) => [rootDir, sourceSha]), [["/current", TRANSITION_CURRENT], ["/target", TRANSITION_TARGET]]);
});

test("Main native transition requires an exact-SHA artifact when the runtime contract changes", async () => {
  const result = await planEquinoxLocalMainNativeTransition({
    currentRoot: "/current", currentSha: TRANSITION_CURRENT, targetRoot: "/target", targetSha: TRANSITION_TARGET, target: "win32-x64",
    computeRuntimeContractImpl: async ({ rootDir, target }) => ({ target, sha256: (rootDir === "/current" ? "2" : "3").repeat(64) }),
  });
  assert.deepEqual(result, {
    mode: "artifact_required", target: "win32-x64", currentSha: TRANSITION_CURRENT, targetSha: TRANSITION_TARGET,
    currentRuntimeContractSha256: "2".repeat(64), targetRuntimeContractSha256: "3".repeat(64),
  });
});

test("Main native transition fails closed on target or digest drift", async () => {
  await assert.rejects(planEquinoxLocalMainNativeTransition({
    currentRoot: "/current", currentSha: TRANSITION_CURRENT, targetRoot: "/target", targetSha: TRANSITION_TARGET, target: "darwin-x64",
    computeRuntimeContractImpl: async ({ rootDir }) => ({ target: rootDir === "/current" ? "darwin-x64" : "win32-x64", sha256: "4".repeat(64) }),
  }), /target drifted/u);
  await assert.rejects(planEquinoxLocalMainNativeTransition({
    currentRoot: "/current", currentSha: TRANSITION_CURRENT, targetRoot: "/target", targetSha: TRANSITION_TARGET, target: "darwin-x64",
    computeRuntimeContractImpl: async ({ target }) => ({ target, sha256: "not-a-digest" }),
  }), /digest is invalid/u);
});
